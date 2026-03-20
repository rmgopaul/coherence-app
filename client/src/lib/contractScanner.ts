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

export type ContractExtraction = {
  fileName: string;
  ccAuthorizationCompleted: boolean | null;
  ccCardAsteriskCount: number | null;
  additionalFivePercentSelected: boolean | null;
  additionalCollateralPercent: number | null;
  vendorFeePercent: number | null;
  systemName: string | null;
  paymentMethod: string | null;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  cityStateZip: string | null;
  recQuantity: number | null;
  recPrice: number | null;
  acSizeKw: number | null;
  dcSizeKw: number | null;
};

const BLANK_RE = /^[_\s]*$/;
let pdfWorkerConfigured = false;

const normalizeText = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripLeadingLabelPunctuation = (value: string): string => value.replace(/^[,:\-]+/, "").trim();

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

const findPage = (pages: PdfPageData[], matcher: RegExp): PdfPageData | null =>
  pages.find((page) => matcher.test(page.text)) ?? null;

const findItem = (page: PdfPageData | null, matcher: RegExp): PositionedText | null => {
  if (!page) return null;
  return page.items.find((item) => matcher.test(item.text)) ?? null;
};

const findTextToRight = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: {
    minXOffset?: number;
    yTolerance?: number;
  }
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
  options?: {
    minXOffset?: number;
    yTolerance?: number;
  }
): number | null => parseNumber(findTextToRight(page, labelMatcher, options));

const findCurrencyToRight = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: {
    minXOffset?: number;
    yTolerance?: number;
  }
): number | null => parseCurrency(findTextToRight(page, labelMatcher, options));

const findNumberToLeft = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: {
    maxXDistance?: number;
    yTolerance?: number;
  }
): number | null => {
  const label = findItem(page, labelMatcher);
  if (!page || !label) return null;

  const maxXDistance = options?.maxXDistance ?? 100;
  const yTolerance = options?.yTolerance ?? 12;

  const candidates = page.items
    .filter((item) => {
      if (BLANK_RE.test(item.text)) return false;
      if (Math.abs(item.y - label.y) > yTolerance) return false;
      if (item.x >= label.x) return false;
      if (label.x - item.x > maxXDistance) return false;
      return /^-?\d+(?:\.\d+)?$/.test(item.text.replace(/,/g, "").trim());
    })
    .sort((a, b) => Math.abs(label.x - a.x) - Math.abs(label.x - b.x));

  if (!candidates.length) return null;
  return parseNumber(candidates[0].text);
};

const findLineValueByYOffset = (
  page: PdfPageData | null,
  anchorY: number,
  options?: {
    xMin?: number;
    yTolerance?: number;
  }
): string | null => {
  if (!page) return null;
  const xMin = options?.xMin ?? 160;
  const yTolerance = options?.yTolerance ?? 12;

  const lineItems = page.items.filter((item) => {
    if (BLANK_RE.test(item.text)) return false;
    if (item.x < xMin) return false;
    return Math.abs(item.y - anchorY) <= yTolerance;
  });

  const text = stripLeadingLabelPunctuation(joinTokens(lineItems));
  return text || null;
};

const collectNearbyLineTexts = (
  page: PdfPageData | null,
  labelMatcher: RegExp,
  options?: {
    xMin?: number;
    lineTolerance?: number;
    maxYDistance?: number;
    preferAbove?: boolean;
    excludeMatchers?: RegExp[];
  }
): string[] => {
  const label = findItem(page, labelMatcher);
  if (!page || !label) return [];

  const xMin = options?.xMin ?? 120;
  const lineTolerance = options?.lineTolerance ?? 10;
  const maxYDistance = options?.maxYDistance ?? 120;
  const preferAbove = options?.preferAbove ?? true;
  const excludeMatchers = options?.excludeMatchers ?? [];

  const lines: Array<{ y: number; items: PositionedText[] }> = [];

  for (const item of page.items) {
    if (BLANK_RE.test(item.text)) continue;
    if (item.x < xMin) continue;
    const existing = lines.find((line) => Math.abs(line.y - item.y) <= lineTolerance);
    if (existing) {
      existing.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  const candidates = lines
    .map((line) => {
      const text = stripLeadingLabelPunctuation(joinTokens(line.items));
      return {
        y: line.y,
        text,
      };
    })
    .filter((line) => {
      if (!line.text) return false;
      if (BLANK_RE.test(line.text)) return false;
      if (Math.abs(line.y - label.y) <= lineTolerance) return false;
      if (Math.abs(line.y - label.y) > maxYDistance) return false;
      if (labelMatcher.test(line.text)) return false;
      if (excludeMatchers.some((matcher) => matcher.test(line.text))) return false;
      return true;
    })
    .sort((a, b) => {
      const aPreferred = preferAbove ? (a.y > label.y ? 0 : 1) : (a.y < label.y ? 0 : 1);
      const bPreferred = preferAbove ? (b.y > label.y ? 0 : 1) : (b.y < label.y ? 0 : 1);
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return Math.abs(a.y - label.y) - Math.abs(b.y - label.y);
    });

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of candidates) {
    const key = line.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line.text);
  }

  return deduped;
};

const detectPaymentMethod = (coverSheetD: PdfPageData | null): string | null => {
  if (!coverSheetD) return null;

  const options: Array<{ label: RegExp; value: string }> = [
    { label: /Check \(Free\)/i, value: "Check" },
    { label: /PayPal \(3% service fee\)/i, value: "PayPal" },
    { label: /^Wire$/i, value: "Wire" },
  ];

  for (const option of options) {
    const label = findItem(coverSheetD, option.label);
    if (!label) continue;

    const marked = coverSheetD.items.some((item) => {
      const token = item.text.trim();
      if (!/^x$/i.test(token)) return false;
      if (Math.abs(item.y - label.y) > 12) return false;
      return item.x >= label.x - 50 && item.x <= label.x + 24;
    });

    if (marked) {
      return option.value;
    }
  }

  return null;
};

const detectAdditionalFivePercentSelected = (creditCardPage: PdfPageData | null): boolean | null => {
  if (!creditCardPage) return null;

  const byCheckingTextStart = findItem(creditCardPage, /^By$/i);
  if (!byCheckingTextStart) return false;

  return creditCardPage.items.some((item) => {
    const token = item.text.trim();
    if (!/^x$/i.test(token)) return false;

    const isOnCheckboxRow = Math.abs(item.y - byCheckingTextStart.y) <= 10;
    const isInCheckboxArea = item.x >= byCheckingTextStart.x - 45 && item.x <= byCheckingTextStart.x + 10;
    return isOnCheckboxRow && isInCheckboxArea;
  });
};

const sanitizeAddressLine = (value: string | null | undefined): string | null => {
  const normalized = normalizeText(value ?? "");
  if (!normalized) return null;
  const cleaned = normalizeText(
    normalized
      .replace(/Payee Name or Company Name/gi, "")
      .replace(/Payee Mailing Address/gi, "")
      .replace(/_{2,}/g, " ")
  );
  return cleaned || null;
};

const extractAddressParts = (
  addressLineOneRaw: string | null,
  addressLineTwoRaw: string | null,
  addressLineThreeRaw: string | null
): { mailingAddress1: string | null; mailingAddress2: string | null; cityStateZip: string | null } => {
  let mailingAddress1 = sanitizeAddressLine(addressLineOneRaw);
  let mailingAddress2 = sanitizeAddressLine(addressLineTwoRaw);
  let cityStateZip = sanitizeAddressLine(addressLineThreeRaw);

  const cityStateZipRegex = /\b[A-Za-z][A-Za-z .'-]*,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

  if (!cityStateZip && mailingAddress2) {
    const match = mailingAddress2.match(cityStateZipRegex);
    if (match) {
      cityStateZip = match[0];
      mailingAddress2 = normalizeText(mailingAddress2.replace(match[0], "")) || null;
    }
  }

  if (!cityStateZip && mailingAddress1) {
    const match = mailingAddress1.match(cityStateZipRegex);
    if (match) {
      cityStateZip = match[0];
      mailingAddress1 = normalizeText(mailingAddress1.replace(match[0], "").replace(/,\s*$/, "")) || null;
    }
  }

  if (!cityStateZip && mailingAddress1?.includes(",")) {
    const commaIndex = mailingAddress1.indexOf(",");
    const firstPart = mailingAddress1.slice(0, commaIndex).trim();
    const remainder = mailingAddress1.slice(commaIndex + 1).trim();
    mailingAddress1 = firstPart || null;
    cityStateZip = remainder || null;
  }

  return {
    mailingAddress1,
    mailingAddress2,
    cityStateZip,
  };
};

const countAsterisks = (value: string): number => (value.match(/\*/g) ?? []).length;

const ensurePdfWorkerConfigured = () => {
  if (pdfWorkerConfigured) return;
  if (typeof pdfWorkerUrl === "string" && pdfWorkerUrl.length > 0) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  pdfWorkerConfigured = true;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "Unknown error");
};

const loadPdfDocumentWithFallback = async (data: Uint8Array) => {
  ensurePdfWorkerConfigured();

  try {
    return await getDocument({ data }).promise;
  } catch (primaryError) {
    try {
      // Some environments fail to initialize the PDF worker; retry without worker.
      return await getDocument({ data, disableWorker: true } as any).promise;
    } catch (fallbackError) {
      throw new Error(
        `PDF parsing failed. Primary: ${toErrorMessage(primaryError)} | Fallback: ${toErrorMessage(fallbackError)}`
      );
    }
  }
};

const readPdfPages = async (file: File): Promise<PdfPageData[]> => {
  const buffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(buffer);
  const pdf = await loadPdfDocumentWithFallback(uint8);

  const pages: PdfPageData[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();

    const items: PositionedText[] = textContent.items
      .map((item) => {
        if (!("str" in item)) return null;
        const text = normalizeText(String(item.str ?? ""));
        if (!text) return null;
        const transform = Array.isArray(item.transform) ? item.transform : [0, 0, 0, 0, 0, 0];
        return {
          text,
          x: Number(transform[4] ?? 0),
          y: Number(transform[5] ?? 0),
        };
      })
      .filter((item): item is PositionedText => Boolean(item));

    const text = normalizeText(items.map((item) => item.text).join(" "));

    pages.push({
      pageNumber,
      text,
      items,
    });
  }

  return pages;
};

export async function extractContractDataFromPdf(file: File): Promise<ContractExtraction> {
  const pages = await readPdfPages(file);

  const coverSheetA = findPage(pages, /System Identification Form:\s*Cover Sheet A/i);
  const coverSheetB = findPage(pages, /System Fee And Bonding:\s*Cover Sheet B/i);
  const coverSheetD = findPage(pages, /Payment Form:\s*Cover Sheet D/i);
  const creditCardPage = findPage(pages, /Credit Card Authorization Form for Collateral Drawdowns/i);

  const ccAsteriskCount = creditCardPage
    ? Math.max(
        0,
        ...creditCardPage.items.map((item) => countAsterisks(item.text)).filter((count) => Number.isFinite(count))
      )
    : null;

  const ccHasDate = creditCardPage ? /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(creditCardPage.text) : false;
  const ccAuthorizationCompleted = creditCardPage ? Boolean((ccAsteriskCount ?? 0) > 0 && ccHasDate) : null;

  const additionalFivePercentSelected = detectAdditionalFivePercentSelected(creditCardPage);

  const systemName = findTextToRight(coverSheetA, /System Name/i, { minXOffset: 80, yTolerance: 10 });
  const vendorFeePercent = findNumberToRight(coverSheetA, /Buyer Approved Vendor Fee %/i, {
    minXOffset: 80,
    yTolerance: 12,
  });
  const recQuantity = findNumberToRight(coverSheetA, /# of RECs on ABP Application/i, {
    minXOffset: 80,
    yTolerance: 12,
  });
  const recPrice = findCurrencyToRight(coverSheetA, /^ABP Block Price$/i, { minXOffset: 80, yTolerance: 12 });
  const acSizeKw = findNumberToLeft(coverSheetA, /kW \(AC\)/i, { maxXDistance: 80, yTolerance: 12 });
  const dcSizeKw = findNumberToLeft(coverSheetA, /kW \(DC\)/i, { maxXDistance: 80, yTolerance: 12 });

  const additionalCollateralPercent = findNumberToRight(coverSheetB, /Total Contract Value \* _____% Additional/i, {
    minXOffset: 120,
    yTolerance: 14,
  });

  const paymentMethod = detectPaymentMethod(coverSheetD);
  const payeeNameRight = findTextToRight(coverSheetD, /Payee Name or Company Name/i, {
    minXOffset: 120,
    yTolerance: 14,
  });
  const payeeNameFallback = collectNearbyLineTexts(coverSheetD, /Payee Name or Company Name/i, {
    xMin: 120,
    lineTolerance: 10,
    maxYDistance: 90,
    preferAbove: true,
    excludeMatchers: [
      /Payee Mailing Address/i,
      /Payee Contact Phone Number/i,
      /Payee Contact Email Address/i,
      /PayPal Email Address/i,
      /^Wire$/i,
      /Check \(Free\)/i,
      /PayPal \(3% service fee\)/i,
    ],
  })[0];
  const payeeName = payeeNameRight ?? payeeNameFallback ?? null;

  const payeeAddressLabel = findItem(coverSheetD, /Payee Mailing Address/i);
  let addressLineOneRaw = payeeAddressLabel
    ? findLineValueByYOffset(coverSheetD, payeeAddressLabel.y + 10, { xMin: 70, yTolerance: 12 })
    : null;
  let addressLineTwoRaw = payeeAddressLabel
    ? findLineValueByYOffset(coverSheetD, payeeAddressLabel.y - 14, { xMin: 70, yTolerance: 10 })
    : null;
  let addressLineThreeRaw = payeeAddressLabel
    ? findLineValueByYOffset(coverSheetD, payeeAddressLabel.y - 38, { xMin: 70, yTolerance: 10 })
    : null;

  if ((!addressLineOneRaw || !addressLineTwoRaw || !addressLineThreeRaw) && payeeAddressLabel) {
    const fallbackAddressLines = collectNearbyLineTexts(coverSheetD, /Payee Mailing Address/i, {
      xMin: 70,
      lineTolerance: 10,
      maxYDistance: 120,
      preferAbove: true,
      excludeMatchers: [
        /Payee Name or Company Name/i,
        /Payee Contact Phone Number/i,
        /Payee Contact Email Address/i,
        /PayPal Email Address/i,
        /^Wire$/i,
        /Check \(Free\)/i,
        /PayPal \(3% service fee\)/i,
      ],
    });

    if (!addressLineOneRaw) addressLineOneRaw = fallbackAddressLines[0] ?? null;
    if (!addressLineTwoRaw) addressLineTwoRaw = fallbackAddressLines[1] ?? null;
    if (!addressLineThreeRaw) addressLineThreeRaw = fallbackAddressLines[2] ?? null;
  }

  const { mailingAddress1, mailingAddress2, cityStateZip } = extractAddressParts(
    addressLineOneRaw,
    addressLineTwoRaw,
    addressLineThreeRaw
  );

  return {
    fileName: file.name,
    ccAuthorizationCompleted,
    ccCardAsteriskCount: ccAsteriskCount,
    additionalFivePercentSelected,
    additionalCollateralPercent,
    vendorFeePercent,
    systemName,
    paymentMethod,
    payeeName,
    mailingAddress1,
    mailingAddress2,
    cityStateZip,
    recQuantity,
    recPrice,
    acSizeKw,
    dcSizeKw,
  };
}
