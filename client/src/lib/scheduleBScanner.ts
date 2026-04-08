import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

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

export type ScheduleBDeliveryYear = {
  label: string; // e.g. "2023-2024"
  startYear: number; // e.g. 2023
  recQuantity: number; // e.g. 7
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

export type AdjustedScheduleYear = {
  yearNumber: number; // 1-15
  startYear: number; // e.g. 2026
  recQuantity: number;
  source: "pdf" | "calculated";
};

// ── Helpers ─────────────────────────────────────────────────────────

const BLANK_RE = /^[_\s]*$/;
let pdfWorkerConfigured = false;

const normalizeText = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripLeadingLabelPunctuation = (value: string): string =>
  value.replace(/^[,:\-]+/, "").trim();

const joinTokens = (items: PositionedText[]): string => {
  if (!items.length) return "";
  const sorted = [...items].sort((a, b) => a.x - b.x);
  return normalizeText(
    sorted
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+,/g, ",")
      .replace(/\s+\)/g, ")")
      .replace(/\(\s+/g, "(")
  );
};

const parseNumber = (value: string | null): number | null => {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCurrency = (value: string | null): number | null => {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/\$?\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const findPage = (
  pages: PdfPageData[],
  matcher: RegExp
): PdfPageData | null =>
  pages.find((page) => matcher.test(page.text)) ?? null;

const findItem = (
  page: PdfPageData | null,
  matcher: RegExp
): PositionedText | null => {
  if (!page) return null;
  return page.items.find((item) => matcher.test(item.text)) ?? null;
};

const findTextToRight = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: { minXOffset?: number; yTolerance?: number }
): string | null => {
  const label = findItem(page, labelMatcher);
  if (!page || !label) return null;

  const minXOffset = options?.minXOffset ?? 80;
  const yTolerance = options?.yTolerance ?? 12;

  const valueItems = page.items.filter((item) => {
    if (BLANK_RE.test(item.text)) return false;
    if (Math.abs(item.y - label.y) > yTolerance) return false;
    return item.x >= label.x + minXOffset;
  });

  const text = stripLeadingLabelPunctuation(joinTokens(valueItems));
  return text || null;
};

const findNumberToRight = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: { minXOffset?: number; yTolerance?: number }
): number | null =>
  parseNumber(findTextToRight(page, labelMatcher, options));

const findCurrencyToRight = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: { minXOffset?: number; yTolerance?: number }
): number | null =>
  parseCurrency(findTextToRight(page, labelMatcher, options));

// ── PDF Reading ─────────────────────────────────────────────────────

const readPdfPages = async (file: File): Promise<PdfPageData[]> => {
  if (!pdfWorkerConfigured) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    pdfWorkerConfigured = true;
  }

  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;
  const pages: PdfPageData[] = [];

  for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber += 1
  ) {
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

    const text = normalizeText(
      items.map((item) => item.text).join(" ")
    );

    pages.push({ pageNumber, text, items });
  }

  return pages;
};

// ── Delivery Schedule Table Parsing ─────────────────────────────────

function parseDeliveryTable(
  pages: PdfPageData[]
): ScheduleBDeliveryYear[] {
  // Find the page with the delivery schedule table
  const schedulePage = findPage(
    pages,
    /Delivery\s+Year\s+Expected\s+REC\s+Quantity/i
  );
  if (!schedulePage) return [];

  const years: ScheduleBDeliveryYear[] = [];

  // The table has delivery year labels like "2023-2024" followed by REC quantities.
  // Strategy: find all items matching YYYY-YYYY pattern, then find the number on the same line.
  const yearPattern = /^(\d{4})\s*-\s*(\d{4})$/;

  for (const item of schedulePage.items) {
    const match = item.text.match(yearPattern);
    if (!match) continue;

    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    if (endYear !== startYear + 1) continue;
    if (startYear < 2010 || startYear > 2060) continue;

    // Find the REC quantity to the right on the same line
    const yTolerance = 8;
    const numberItems = schedulePage.items.filter((other) => {
      if (Math.abs(other.y - item.y) > yTolerance) return false;
      if (other.x <= item.x) return false;
      return /^\d+$/.test(other.text.trim());
    });

    if (numberItems.length > 0) {
      // Take the closest number to the right
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

  // Sort by start year
  years.sort((a, b) => a.startYear - b.startYear);
  return years;
}

// ── Main Extraction ─────────────────────────────────────────────────

export async function extractScheduleBData(
  file: File
): Promise<ScheduleBExtraction> {
  try {
    const pages = await readPdfPages(file);

    // Page 1: fields (a), (b)
    const page1 = findPage(pages, /Designated\s+System\s+ID/i);

    const designatedSystemId = findTextToRight(
      page1,
      /Designated\s+System\s+ID/i,
      { minXOffset: 40, yTolerance: 12 }
    );

    // GATS ID: look for "PJM-EIS GATS ID:" then text to the right
    const gatsId = findTextToRight(page1, /GATS\s+ID/i, {
      minXOffset: 20,
      yTolerance: 12,
    });

    // Page 2: fields (j), (l), (o), (q)
    const page2 = findPage(pages, /Date of Energization/i);

    const energizationDateRaw = findTextToRight(
      page2,
      /Date of Energization/i,
      { minXOffset: 40, yTolerance: 12 }
    );

    const contractPrice = findCurrencyToRight(
      page2,
      /Contract\s+Price/i,
      { minXOffset: 20, yTolerance: 12 }
    );

    // Year-1 Contract Capacity Factor — percentage value
    const capacityFactorRaw = findNumberToRight(
      page2,
      /Year\s*-?\s*1\s+Contract\s+Capacity\s+Factor/i,
      { minXOffset: 20, yTolerance: 12 }
    );
    // Convert from percentage to decimal (e.g., 16.692555 → 0.16692555)
    const capacityFactor =
      capacityFactorRaw !== null ? capacityFactorRaw / 100 : null;

    // Contract Nameplate Capacity kW AC
    const acSizeKw = findNumberToRight(
      page2,
      /Contract\s+Nameplate\s+Capacity/i,
      { minXOffset: 20, yTolerance: 12 }
    );

    // Max REC Quantity
    const maxRecQuantity = findNumberToRight(
      page2,
      /Contract\s+Maximum\s+REC\s+Quantity/i,
      { minXOffset: 20, yTolerance: 12 }
    );

    // Delivery schedule table (pages 4-5 typically)
    const deliveryYears = parseDeliveryTable(pages);

    return {
      fileName: file.name,
      designatedSystemId:
        designatedSystemId?.replace(/\D/g, "") || null,
      gatsId: gatsId?.trim() || null,
      acSizeKw,
      capacityFactor,
      contractPrice,
      energizationDate: energizationDateRaw?.trim() || null,
      maxRecQuantity,
      deliveryYears,
      error:
        deliveryYears.length === 0
          ? "Could not parse delivery schedule table"
          : null,
    };
  } catch (err) {
    return {
      fileName: file.name,
      designatedSystemId: null,
      gatsId: null,
      acSizeKw: null,
      capacityFactor: null,
      contractPrice: null,
      energizationDate: null,
      maxRecQuantity: null,
      deliveryYears: [],
      error:
        err instanceof Error
          ? err.message
          : "Unknown extraction error",
    };
  }
}

// ── Schedule Adjustment ─────────────────────────────────────────────

/**
 * Calculate the unrounded REC value for a given year using the
 * degradation formula from the Schedule B spec:
 *
 * Year 1: acSizeKw (MW) × capacityFactor × 8760
 * Year N: previous_unrounded × 0.995
 *
 * Note: acSizeKw is in kW, so we divide by 1000 to get MW.
 */
function calculateRecForYear(
  acSizeKw: number,
  capacityFactor: number,
  yearNumber: number
): number {
  // Year 1 unrounded value
  let unrounded =
    (acSizeKw / 1000) * capacityFactor * 8760;

  // Apply 0.5% degradation for each subsequent year
  for (let y = 2; y <= yearNumber; y++) {
    unrounded *= 0.995;
  }

  return Math.floor(unrounded);
}

/**
 * Build an adjusted 15-year delivery schedule.
 *
 * @param extraction - Raw Schedule B extraction
 * @param firstTransferEnergyYear - The energy year (start year) of the
 *   first REC transfer to the utility. The delivery schedule starts at
 *   the NEXT energy year. Pass null if no transfer history exists.
 */
export function buildAdjustedSchedule(
  extraction: ScheduleBExtraction,
  firstTransferEnergyYear: number | null
): AdjustedScheduleYear[] {
  const { deliveryYears, acSizeKw, capacityFactor } = extraction;
  if (deliveryYears.length === 0) return [];

  const pdfFirstStartYear = deliveryYears[0].startYear;

  // Determine the first delivery year start
  let firstDeliveryStartYear: number;
  if (firstTransferEnergyYear !== null) {
    // Delivery starts the energy year AFTER the first transfer
    firstDeliveryStartYear = firstTransferEnergyYear + 1;
  } else {
    // No transfer data — use PDF's first year as-is
    firstDeliveryStartYear = pdfFirstStartYear;
  }

  // Calculate offset: how many PDF years to skip
  const offset = Math.max(
    0,
    firstDeliveryStartYear - pdfFirstStartYear
  );

  const result: AdjustedScheduleYear[] = [];

  for (let i = 0; i < 15; i++) {
    const pdfIndex = offset + i;
    const startYear = firstDeliveryStartYear + i;

    if (pdfIndex < deliveryYears.length) {
      // Use value from PDF
      result.push({
        yearNumber: i + 1,
        startYear,
        recQuantity: deliveryYears[pdfIndex].recQuantity,
        source: "pdf",
      });
    } else if (acSizeKw !== null && capacityFactor !== null) {
      // Calculate extended year using degradation formula
      // The PDF year number for this position (1-indexed from PDF year 1)
      const absoluteYearNumber = pdfIndex + 1;
      const recQuantity = calculateRecForYear(
        acSizeKw,
        capacityFactor,
        absoluteYearNumber
      );
      result.push({
        yearNumber: i + 1,
        startYear,
        recQuantity,
        source: "calculated",
      });
    }
  }

  return result;
}

/**
 * Find the earliest energy year with a positive transfer for a given
 * GATS unit ID from a transfer delivery lookup map.
 */
export function findFirstTransferEnergyYear(
  gatsId: string,
  transferDeliveryLookup: Map<string, Map<number, number>>
): number | null {
  const yearMap = transferDeliveryLookup.get(
    gatsId.toLowerCase()
  );
  if (!yearMap || yearMap.size === 0) return null;

  let earliest: number | null = null;
  yearMap.forEach((qty, year) => {
    if (qty > 0 && (earliest === null || year < earliest)) {
      earliest = year;
    }
  });
  return earliest;
}

/**
 * Convert adjusted schedule results to deliveryScheduleBase CSV rows.
 */
export function toDeliveryScheduleBaseRows(
  extractions: Array<{
    extraction: ScheduleBExtraction;
    adjustedYears: AdjustedScheduleYear[];
  }>
): Array<Record<string, string>> {
  return extractions
    .filter((e) => e.adjustedYears.length > 0 && e.extraction.gatsId)
    .map(({ extraction, adjustedYears }) => {
      const row: Record<string, string> = {
        tracking_system_ref_id: extraction.gatsId ?? "",
        system_name:
          extraction.designatedSystemId
            ? `App ${extraction.designatedSystemId}`
            : extraction.fileName,
        designated_system_id:
          extraction.designatedSystemId ?? "",
      };

      for (let i = 0; i < 15; i++) {
        const year = adjustedYears[i];
        row[`year${i + 1}_quantity_required`] = year
          ? String(year.recQuantity)
          : "0";
      }

      return row;
    });
}
