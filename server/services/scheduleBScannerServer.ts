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

function parseDeliveryTable(pages: PdfPageData[]): ScheduleBDeliveryYear[] {
  const schedulePage = pages.find((page) =>
    /Delivery\s+Year\s+Expected\s+REC\s+Quantity/i.test(page.text)
  );
  if (!schedulePage) return [];

  const years: ScheduleBDeliveryYear[] = [];
  const yearPattern = /^(\d{4})\s*-\s*(\d{4})$/;

  for (const item of schedulePage.items) {
    const match = item.text.match(yearPattern);
    if (!match) continue;

    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    if (endYear !== startYear + 1) continue;
    if (startYear < 2010 || startYear > 2060) continue;

    const yTolerance = 8;
    const numberItems = schedulePage.items.filter((other) => {
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

export async function extractScheduleBDataFromPdfBuffer(
  data: Uint8Array,
  fileName: string
): Promise<ScheduleBExtraction> {
  try {
    const pages = await readPdfPages(data);
    const fullText = pages.map((p) => p.text).join(" ");

    const designatedSystemId = extractRegex(
      fullText,
      /Designated\s+System\s+ID[:\s]+(\d+)/i
    );

    const gatsId = extractRegex(fullText, /GATS\s+ID[:\s]+([A-Z0-9]+)/i);

    // Match both slash format (9/18/2020) and spelled-out month
    // (September 18, 2020). Try slash format first (more specific),
    // fall back to spelled-out month.
    const energizationDateRaw =
      extractRegex(
        fullText,
        /Date\s+of\s+Energization[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i
      ) ??
      extractRegex(
        fullText,
        /Date\s+of\s+Energization[:\s]+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i
      );

    const contractPriceRaw = extractRegex(
      fullText,
      /Contract\s+Price\s*=?\s*\$?([\d,]+\.?\d*)/i
    );
    const contractPrice = contractPriceRaw
      ? parseFloat(contractPriceRaw.replace(/,/g, ""))
      : null;

    // Match "Year-1 Contract Capacity Factor: X%" (standard) or
    // standalone "Capacity Factor: X%" (older Schedule B format).
    const capacityFactorRaw =
      extractRegex(
        fullText,
        /Year\s*-?\s*1\s+Contract\s+Capacity\s+Factor[:\s]+([\d.]+)\s*%/i
      ) ??
      extractRegex(
        fullText,
        /Capacity\s+Factor[:\s]+([\d.]+)\s*%/i
      );
    const capacityFactor = capacityFactorRaw
      ? parseFloat(capacityFactorRaw) / 100
      : null;

    const acSizeKwRaw = extractRegex(
      fullText,
      /Contract\s+Nameplate\s+Capacity[:\s]+([\d.]+)\s*kW/i
    );
    const acSizeKw = acSizeKwRaw ? parseFloat(acSizeKwRaw) : null;

    const maxRecQuantityRaw = extractRegex(
      fullText,
      /Contract\s+Maximum\s+REC\s+Quantity\s*=?\s*([\d,]+)/i
    );
    const maxRecQuantity = maxRecQuantityRaw
      ? parseInt(maxRecQuantityRaw.replace(/,/g, ""), 10)
      : null;

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
      energizationDate: null,
      maxRecQuantity: null,
      deliveryYears: [],
      error:
        err instanceof Error ? err.message : "Unknown extraction error",
    };
  }
}
