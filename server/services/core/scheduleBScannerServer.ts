import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ScheduleBDeliveryYear = {
  label: string;
  startYear: number;
  recQuantity: number;
};

export type ScheduleBExtraction = {
  fileName: string;
  designatedSystemId: string | null;
  gatsId: string | null;
  acSizeKw: number | null;
  capacityFactor: number | null;
  contractPrice: number | null;
  contractNumber: string | null;
  energizationDate: string | null;
  maxRecQuantity: number | null;
  deliveryYears: ScheduleBDeliveryYear[];
  error: string | null;
};

type PositionedText = {
  text: string;
  x: number;
  y: number;
};

type PdfPageData = {
  pageNumber: number;
  text: string;
  items: PositionedText[];
};

const require = createRequire(import.meta.url);

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolvePdfjsResourceUrls():
  | { standardFontDataUrl: string; cMapUrl: string }
  | null {
  try {
    const packageJsonPath = require.resolve("pdfjs-dist/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    return {
      standardFontDataUrl: ensureTrailingSlash(
        pathToFileURL(path.join(packageRoot, "standard_fonts")).href
      ),
      cMapUrl: ensureTrailingSlash(pathToFileURL(path.join(packageRoot, "cmaps")).href),
    };
  } catch {
    return null;
  }
}

const PDFJS_RESOURCE_URLS = resolvePdfjsResourceUrls();

const normalizeText = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractRegex = (text: string, pattern: RegExp): string | null => {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
};

async function readPdfPagesWithOptions(
  data: Uint8Array,
  options: Record<string, unknown>
): Promise<PdfPageData[]> {
  const pdf = await getDocument({
    data,
    disableWorker: true,
    ...options,
  } as any).promise;
  const pages: PdfPageData[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();

      const items: PositionedText[] = textContent.items
        .map((item) => {
          if (!("str" in item)) return null;
          const text = normalizeText(String(item.str ?? ""));
          if (!text) return null;
          const transform = Array.isArray(item.transform)
            ? item.transform
            : [0, 0, 0, 0, 0, 0];
          return {
            text,
            x: Number(transform[4] ?? 0),
            y: Number(transform[5] ?? 0),
          };
        })
        .filter((item): item is PositionedText => Boolean(item));

      const text = normalizeText(items.map((item) => item.text).join(" "));
      pages.push({ pageNumber, text, items });
      page.cleanup();
    }
  } finally {
    await pdf.destroy().catch(() => undefined);
  }

  return pages;
}

function isFontResourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /font data|standardfontdataurl|foxitserif|liberationsans|cmap|invalid url/i.test(
    message
  );
}

async function readPdfPages(data: Uint8Array): Promise<PdfPageData[]> {
  const primaryOptions: Record<string, unknown> = {
    useSystemFonts: true,
  };

  if (PDFJS_RESOURCE_URLS) {
    primaryOptions.standardFontDataUrl = PDFJS_RESOURCE_URLS.standardFontDataUrl;
    primaryOptions.cMapUrl = PDFJS_RESOURCE_URLS.cMapUrl;
    primaryOptions.cMapPacked = true;
  }

  try {
    return await readPdfPagesWithOptions(data, primaryOptions);
  } catch (primaryError) {
    if (!isFontResourceError(primaryError)) {
      throw primaryError;
    }

    console.warn(
      "[scheduleBScanner] primary parse failed; retrying with fallback options:",
      primaryError instanceof Error ? primaryError.message : primaryError
    );

    return await readPdfPagesWithOptions(data, {
      useSystemFonts: true,
      stopAtErrors: false,
    });
  }
}

function extractYearsFromPage(page: PdfPageData): ScheduleBDeliveryYear[] {
  const years: ScheduleBDeliveryYear[] = [];
  const yearPattern = /^(\d{4})\s*-\s*(\d{4})$/;

  for (const item of page.items) {
    const match = item.text.match(yearPattern);
    if (!match) continue;

    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    if (endYear !== startYear + 1) continue;
    if (startYear < 2010 || startYear > 2060) continue;

    const yTolerance = 8;
    const numberItems = page.items.filter((other) => {
      if (Math.abs(other.y - item.y) > yTolerance) return false;
      if (other.x <= item.x) return false;
      return /^\d+$/.test(other.text.trim());
    });

    if (numberItems.length > 0) {
      numberItems.sort((a, b) => a.x - b.x);
      const qty = parseInt(numberItems[0].text.trim(), 10);
      if (Number.isFinite(qty) && qty >= 0) {
        years.push({
          label: `${startYear}-${endYear}`,
          startYear,
          recQuantity: qty,
        });
      }
    }
  }

  years.sort((a, b) => a.startYear - b.startYear);
  return years;
}

export function extractScheduleBDeliveryYearsFromText(text: string): ScheduleBDeliveryYear[] {
  const years: ScheduleBDeliveryYear[] = [];
  const seen = new Set<string>();
  const normalized = normalizeText(text);
  const regex = /\b(20\d{2})\s*-\s*(20\d{2})\s+([\d,]+)\b/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized)) !== null) {
    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    if (!Number.isFinite(startYear) || endYear !== startYear + 1) continue;

    const recQuantity = parseInt(match[3].replace(/,/g, ""), 10);
    if (!Number.isFinite(recQuantity) || recQuantity < 0) continue;

    const label = `${startYear}-${endYear}`;
    if (seen.has(label)) continue;
    seen.add(label);
    years.push({ label, startYear, recQuantity });
  }

  years.sort((a, b) => a.startYear - b.startYear);
  return years;
}

function parseDeliveryTable(pages: PdfPageData[]): ScheduleBDeliveryYear[] {
  // Prefer the page with the canonical header text.
  const schedulePage = pages.find((page) =>
    /Delivery\s+Year\s+Expected\s+REC\s+Quantity/i.test(page.text)
  );
  if (schedulePage) {
    const positionedYears = extractYearsFromPage(schedulePage);
    if (positionedYears.length > 0) return positionedYears;

    const textYears = extractScheduleBDeliveryYearsFromText(schedulePage.text);
    if (textYears.length > 0) return textYears;
  }

  // Fallback: some PDFs have form-fill text only (labels are in the
  // background layer and invisible to pdfjs). Scan ALL pages for
  // year-quantity patterns and return the best match.
  for (const page of pages) {
    const years = extractYearsFromPage(page);
    if (years.length >= 5) return years; // credible delivery table

    const textYears = extractScheduleBDeliveryYearsFromText(page.text);
    if (textYears.length >= 5) return textYears;
  }
  return [];
}

export async function extractScheduleBDataFromPdfBuffer(
  data: Uint8Array,
  fileName: string
): Promise<ScheduleBExtraction> {
  try {
    const pages = await readPdfPages(data);
    const fullText = pages.map((p) => p.text).join(" ");

    const designatedSystemId =
      extractRegex(fullText, /Designated\s+System\s+ID[:\s]+(\d+)/i) ??
      // Fallback 1: numeric-only filenames ARE the system ID (e.g. "48199.pdf")
      ((/^\d+\.pdf$/i.test(fileName))
        ? fileName.replace(/\.pdf$/i, "")
        : null) ??
      // Fallback 2: "ScheduleB_NNNN_timestamp.pdf" — system ID is FIRST number
      extractRegex(fileName, /^ScheduleB[_-](\d{2,6})[_-]/i) ??
      // Fallback 3: "System_NNNN_" or "System NNNN_" in filename
      extractRegex(fileName, /System[_\s](\d{2,6})[_\s]/i) ??
      // Fallback 4: "CS Part II Schedule B - ... - NNNN.pdf" — last number before .pdf
      extractRegex(fileName, /[-_\s](\d{2,6})\.pdf$/i);

    const gatsId =
      extractRegex(fullText, /GATS\s+ID[:\s]+([A-Z0-9]+)/i) ??
      // Fallback: match NON + digits anywhere (GATS tracking IDs)
      extractRegex(fullText, /\b(NON\d{5,})\b/);

    // Match both slash format (9/18/2020) and spelled-out month
    // (September 18, 2020). Try slash format first (more specific),
    // fall back to spelled-out month. Final fallback: bare
    // "Month DD, YYYY" without label (form-fill-only PDFs).
    const MONTH_NAMES = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
    const energizationDateRaw =
      extractRegex(
        fullText,
        /Date\s+of\s+Energization[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i
      ) ??
      extractRegex(
        fullText,
        new RegExp(`Date\\s+of\\s+Energization[:\\s]+(${MONTH_NAMES}\\s+\\d{1,2},?\\s+\\d{4})`, "i")
      ) ??
      // Fallback for label-free PDFs: page 2 starts with the
      // energization date as first text. Use page 2's first line
      // if it looks like a date.
      (pages[1]
        ? extractRegex(
            pages[1].text,
            new RegExp(`^(${MONTH_NAMES}\\s+\\d{1,2},?\\s+\\d{4})`, "i")
          )
        : null);

    const contractPriceRaw = extractRegex(
      fullText,
      /Contract\s+Price\s*=?\s*\$?([\d,]+\.?\d*)/i
    );
    const contractPrice = contractPriceRaw
      ? parseFloat(contractPriceRaw.replace(/,/g, ""))
      : null;

    // Match "Year-1 Contract Capacity Factor: X%" (standard) or
    // standalone "Capacity Factor: X%" (older Schedule B format).
    // Final fallback: bare high-precision percentage on page 2
    // (form-fill-only PDFs have "12.430000%" without a label).
    const capacityFactorRaw =
      extractRegex(
        fullText,
        /Year\s*-?\s*1\s+Contract\s+Capacity\s+Factor[:\s]+([\d.]+)\s*%/i
      ) ??
      extractRegex(
        fullText,
        /Capacity\s+Factor[:\s]+([\d.]+)\s*%/i
      ) ??
      // Fallback: 6+ decimal-digit percentage (e.g. "12.430000%")
      // is distinctive enough to be a capacity factor, not a
      // degradation factor (which is typically "0.5%").
      (pages[1]
        ? extractRegex(pages[1].text, /\b(\d{1,3}\.\d{4,})\s*%/)
        : null);
    const capacityFactor = capacityFactorRaw
      ? parseFloat(capacityFactorRaw) / 100
      : null;

    const acSizeKwRaw =
      extractRegex(
        fullText,
        /Contract\s+Nameplate\s+Capacity[:\s]+([\d.]+)\s*kW/i
      ) ??
      // Fallback: bare "X.XXXX kW (AC Rating)" without label
      extractRegex(fullText, /([\d.]+)\s*kW\s*\(AC\s*Rating\)/i);
    const acSizeKw = acSizeKwRaw ? parseFloat(acSizeKwRaw) : null;

    const maxRecQuantityRaw = extractRegex(
      fullText,
      /Contract\s+Maximum\s+REC\s+Quantity\s*=?\s*([\d,]+)/i
    );
    const maxRecQuantity = maxRecQuantityRaw
      ? parseInt(maxRecQuantityRaw.replace(/,/g, ""), 10)
      : null;

    // Contract number from footer text ("Contract 153") or
    // "REC Contract No." labels. Try most specific patterns first.
    const contractNumber =
      extractRegex(fullText, /\bContract\s+(?:No\.?\s+)?(\d{1,5})\s*$/im) ??
      extractRegex(fullText, /\bContract\s+(\d{1,5})\b/i);

    const deliveryYears = parseDeliveryTable(pages);

    // Build a diagnostic summary for failed extractions so the user
    // can understand what the parser saw without downloading the PDF.
    let error: string | null = null;
    if (deliveryYears.length === 0) {
      const foundFields: string[] = [];
      if (designatedSystemId) foundFields.push("designatedSystemId");
      if (gatsId) foundFields.push("gatsId");
      if (acSizeKwRaw) foundFields.push("acSizeKw");
      if (capacityFactorRaw) foundFields.push("capacityFactor");
      if (contractPriceRaw) foundFields.push("contractPrice");
      if (contractNumber) foundFields.push("contractNumber");
      if (energizationDateRaw) foundFields.push("energizationDate");
      if (maxRecQuantityRaw) foundFields.push("maxRecQuantity");

      const pageSnippet = pages[0]?.text?.slice(0, 200) ?? "(empty)";
      error =
        `Could not parse delivery schedule table. ` +
        `Pages: ${pages.length}. ` +
        `Fields found: ${foundFields.join(", ") || "none"}. ` +
        `Page 1 preview: "${pageSnippet}"`;
    }

    return {
      fileName,
      designatedSystemId: designatedSystemId?.replace(/\D/g, "") || null,
      gatsId: gatsId?.trim() || null,
      acSizeKw,
      capacityFactor,
      contractPrice,
      contractNumber: contractNumber?.trim() || null,
      energizationDate: energizationDateRaw?.trim() || null,
      maxRecQuantity,
      deliveryYears,
      error,
    };
  } catch (err) {
    return {
      fileName,
      designatedSystemId: null,
      gatsId: null,
      acSizeKw: null,
      capacityFactor: null,
      contractPrice: null,
      contractNumber: null,
      energizationDate: null,
      maxRecQuantity: null,
      deliveryYears: [],
      error:
        err instanceof Error ? err.message : "Unknown extraction error",
    };
  }
}
