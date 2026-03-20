import * as XLSX from "xlsx";

export type CsvRow = Record<string, string>;

export type ParsedTabularData = {
  headers: string[];
  rows: CsvRow[];
  matrix: string[][];
};

export type UtilityInvoiceRow = {
  rowId: string;
  sourceFile: string;
  sourceSheet: string;
  contractId: string | null;
  utilityName: string | null;
  systemId: string;
  paymentNumber: number | null;
  recQuantity: number | null;
  recPrice: number | null;
  invoiceAmount: number | null;
  systemAddress: string;
};

export type CsgSystemIdMappingRow = {
  csgId: string;
  systemId: string;
};

export type ProjectApplicationLiteRow = {
  applicationId: string;
  part1SubmissionDate: Date | null;
  part1OriginalSubmissionDate: Date | null;
  inverterSizeKwAcPart1: number | null;
};

export type QuickBooksLineCategory =
  | "applicationFee"
  | "utilityCollateral"
  | "additionalCollateral"
  | "ccFee"
  | "vendorFee"
  | "other";

export type QuickBooksLineItem = {
  lineOrder: number | null;
  description: string;
  productService: string;
  amount: number | null;
};

export type QuickBooksInvoice = {
  invoiceNumber: string;
  amount: number | null;
  openBalance: number | null;
  cashReceived: number | null;
  paymentStatus: string;
  voided: string;
  customer: string;
  date: Date | null;
  lineItems: QuickBooksLineItem[];
};

export type QuickBooksSystemTaggedLine = {
  invoiceNumber: string;
  systemId: string;
  matchSource: "description" | "invoiceMap";
  category: QuickBooksLineCategory;
  lineAmount: number;
  allocatedPaidAmount: number;
  description: string;
  productService: string;
  confidence: "high" | "medium";
};

export type QuickBooksPaidUpfrontLedger = {
  bySystemId: Map<
    string,
    {
      applicationFeePaidUpfront: number;
      utilityCollateralPaidUpfront: number;
      additionalCollateralPaidUpfront: number;
      ccFeePaidUpfront: number;
      vendorFeePaidUpfront: number;
      matchedLines: QuickBooksSystemTaggedLine[];
    }
  >;
  unmatchedLines: Array<{
    invoiceNumber: string;
    description: string;
    productService: string;
    amount: number | null;
    allocatedPaidAmount: number;
    category: QuickBooksLineCategory;
    reason: string;
  }>;
};

export type ContractTerms = {
  csgId: string;
  fileName: string;
  vendorFeePercent: number | null;
  additionalCollateralPercent: number | null;
  ccAuthorizationCompleted: boolean | null;
  ccCardAsteriskCount: number | null;
  recQuantity: number | null;
  recPrice: number | null;
};

export type InvoiceNumberMapRow = {
  csgId: string;
  invoiceNumber: string;
};

export type InvoiceNumberMapHeaderDetection = {
  csgIdHeader: string | null;
  invoiceNumberHeader: string | null;
};

export type PaymentClassification =
  | "first_full_upfront"
  | "first_partial"
  | "quarterly"
  | "unknown";

export type ManualOverride = {
  classification?: PaymentClassification;
  carryforwardIn?: number;
  vendorFeePercent?: number;
  additionalCollateralPercent?: number;
  applicationFeeAmount?: number;
  notes?: string;
};

export type PaymentComputationRow = {
  rowId: string;
  sourceFile: string;
  contractId: string | null;
  utilityName: string | null;
  csgId: string | null;
  systemId: string;
  invoiceAmount: number;
  recQuantity: number;
  recPrice: number;
  grossContractValue: number;
  paymentNumber: number | null;
  paymentPercentOfGross: number | null;
  classification: PaymentClassification;
  classificationAuto: PaymentClassification;
  classificationOverridden: boolean;
  vendorFeePercent: number;
  vendorFeeAmount: number;
  utilityHeldCollateral5PercentAmount: number;
  utilityHeldCollateralPaidUpfront: number;
  applicationFeeAmount: number;
  applicationFeePaidUpfront: number;
  additionalCollateralPercent: number;
  additionalCollateralAmount: number;
  additionalCollateralPaidUpfront: number;
  ccAuthorizationFormStatus: string;
  ccAuthIncomplete5PercentAmount: number;
  firstPaymentFormulaNetAmount: number;
  withholdingBalanceSeededForSystem: number;
  carryforwardIn: number;
  carryforwardRecoveredThisRow: number;
  carryforwardOut: number;
  netPayoutThisRow: number;
  confidenceFlags: string[];
  overrideNotes: string;
};

export type SettlementComputationResult = {
  rows: PaymentComputationRow[];
  warnings: string[];
  carryforwardBySystemId: Record<string, number>;
  unresolvedQuickBooksLineCount: number;
};

export type SettlementComputationInput = {
  utilityRows: UtilityInvoiceRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
  projectApplications: ProjectApplicationLiteRow[];
  quickBooksPaidUpfrontLedger: QuickBooksPaidUpfrontLedger;
  contractTermsByCsgId: Map<string, ContractTerms>;
  previousCarryforwardBySystemId?: Record<string, number>;
  manualOverridesByRowId?: Record<string, ManualOverride>;
};

const APPLICATION_FEE_CUTOFF = new Date("2024-06-01T00:00:00.000Z");
const PERCENT_CLASSIFICATION_TOLERANCE = 0.25;

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function parseNumber(value: unknown): number | null {
  const normalized = clean(value).replace(/,/g, "").replace(/[$%]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: unknown): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const result = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const year = Number(us[3]) < 100 ? Number(us[3]) + 2000 : Number(us[3]);
    const result = new Date(Date.UTC(year, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseCsvMatrix(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '"') {
      const next = source[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((entry) => clean(entry).length > 0)) {
        matrix.push(row);
      }
      row = [];
      continue;
    }

    cell += character;
  }

  row.push(cell);
  if (row.some((entry) => clean(entry).length > 0)) {
    matrix.push(row);
  }

  return matrix;
}

function matrixToParsedTabularData(matrix: string[][]): ParsedTabularData {
  if (!matrix.length) {
    return { headers: [], rows: [], matrix: [] };
  }

  const headers = matrix[0].map((header, index) => clean(header) || `column_${index + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(values[index]);
    });
    return record;
  });

  return {
    headers,
    rows,
    matrix,
  };
}

function sheetToMatrix(sheet: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  }).map((row) => row.map((entry) => clean(entry)));
}

export async function parseTabularFile(file: File): Promise<ParsedTabularData> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    const matrix = parseCsvMatrix(text);
    return matrixToParsedTabularData(matrix);
  }

  if (/(\.xlsx|\.xlsm|\.xlsb|\.xls)$/i.test(lowerName)) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      throw new Error(`Could not read worksheet from ${file.name}.`);
    }
    const matrix = sheetToMatrix(sheet);
    if (!matrix.length) return { headers: [], rows: [], matrix: [] };

    return matrixToParsedTabularData(matrix);
  }

  throw new Error(`Unsupported file type for ${file.name}. Please upload CSV or Excel.`);
}

function findHeaderRowIndex(matrix: string[][], requiredHeaders: string[]): number {
  const normalizedRequired = requiredHeaders.map((header) => normalizeHeader(header));
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const normalizedRow = new Set(matrix[rowIndex].map((entry) => normalizeHeader(entry)));
    const foundAll = normalizedRequired.every((required) => normalizedRow.has(required));
    if (foundAll) return rowIndex;
  }
  return -1;
}

function readByNormalizedHeader(
  row: string[],
  headerRow: string[],
  candidates: string[]
): string {
  const headerLookup = new Map<string, number>();
  headerRow.forEach((header, index) => {
    headerLookup.set(normalizeHeader(header), index);
  });

  for (const candidate of candidates) {
    const index = headerLookup.get(normalizeHeader(candidate));
    if (index === undefined) continue;
    const value = clean(row[index]);
    if (value) return value;
  }

  return "";
}

function extractContractIdFromTitle(titleCell: string): string | null {
  const match = clean(titleCell).match(/Contract\s+(\d+)/i);
  return match ? match[1] : null;
}

function extractUtilityFromTitle(titleCell: string): string | null {
  const normalized = clean(titleCell);
  if (!normalized) return null;
  if (normalized.toLowerCase().includes("comed")) return "ComEd";
  if (normalized.toLowerCase().includes("ameren")) return "AmerenIllinois";
  if (normalized.toLowerCase().includes("midamerican")) return "MidAmerican";
  return null;
}

export async function parseUtilityInvoiceFile(file: File): Promise<UtilityInvoiceRow[]> {
  const lowerName = file.name.toLowerCase();
  if (/(\.xlsx|\.xlsm|\.xlsb|\.xls)$/i.test(lowerName)) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Could not read sheet in ${file.name}.`);

    const matrix = sheetToMatrix(sheet);
    return parseUtilityInvoiceMatrix(matrix, file.name, sheetName);
  }

  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    const matrix = parseCsvMatrix(text);
    return parseUtilityInvoiceMatrix(matrix, file.name, "csv");
  }

  throw new Error(`Unsupported utility invoice file: ${file.name}`);
}

export function parseUtilityInvoiceMatrix(
  matrix: string[][],
  sourceFile: string,
  sourceSheet: string
): UtilityInvoiceRow[] {
  const headerRowIndex = findHeaderRowIndex(matrix, ["System ID", "Payment Number", "Total RECS", "REC Price", "Invoice Amount ($)"]);
  if (headerRowIndex < 0) {
    throw new Error(`${sourceFile} is missing required utility invoice columns (System ID, Payment Number, Total RECS, REC Price, Invoice Amount).`);
  }

  const titleCell = clean(matrix[0]?.[0]);
  const contractId = extractContractIdFromTitle(titleCell);
  const utilityName = extractUtilityFromTitle(titleCell);
  const headerRow = matrix[headerRowIndex];
  const output: UtilityInvoiceRow[] = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];

    const systemId = readByNormalizedHeader(row, headerRow, ["System ID"]);
    const paymentRaw = readByNormalizedHeader(row, headerRow, ["Payment Number"]);
    const recRaw = readByNormalizedHeader(row, headerRow, ["Total RECS"]);
    const recPriceRaw = readByNormalizedHeader(row, headerRow, ["REC Price"]);
    const invoiceAmountRaw = readByNormalizedHeader(row, headerRow, ["Invoice Amount ($)", "Invoice Amount"]);
    const address = readByNormalizedHeader(row, headerRow, ["System Address"]);

    if (!systemId || /^total:?$/i.test(systemId)) continue;
    if (!/^\d+$/.test(systemId)) continue;

    output.push({
      rowId: `${sourceFile}:${rowIndex + 1}:${systemId}`,
      sourceFile,
      sourceSheet,
      contractId,
      utilityName,
      systemId,
      paymentNumber: parseNumber(paymentRaw),
      recQuantity: parseNumber(recRaw),
      recPrice: parseNumber(recPriceRaw),
      invoiceAmount: parseNumber(invoiceAmountRaw),
      systemAddress: address,
    });
  }

  return output;
}

export function parseCsgSystemMapping(parsed: ParsedTabularData): CsgSystemIdMappingRow[] {
  const csgHeader = parsed.headers.find((header) => normalizeHeader(header).includes("csgid"));
  const systemHeader = parsed.headers.find((header) => {
    const normalized = normalizeHeader(header);
    return normalized.includes("systemid") || normalized.includes("statecertificationnumber");
  });

  if (!csgHeader || !systemHeader) {
    throw new Error("CSG mapping file must include CSG ID and System ID (state_certification_number) columns.");
  }

  return parsed.rows
    .map((row) => ({
      csgId: clean(row[csgHeader]),
      systemId: clean(row[systemHeader]),
    }))
    .filter((row) => row.csgId.length > 0 && row.systemId.length > 0);
}

export function parseProjectApplications(parsed: ParsedTabularData): ProjectApplicationLiteRow[] {
  const appIdHeader = parsed.headers.find((header) => normalizeHeader(header) === normalizeHeader("Application_ID"));
  const part1SubmissionHeader = parsed.headers.find(
    (header) => normalizeHeader(header) === normalizeHeader("Part_1_Submission_Date")
  );
  const part1OriginalHeader = parsed.headers.find(
    (header) => normalizeHeader(header) === normalizeHeader("Part_1_Original_Submission_Date")
  );
  const acSizeHeader = parsed.headers.find(
    (header) => normalizeHeader(header) === normalizeHeader("Inverter_Size_kW_AC_Part_1")
  );

  if (!appIdHeader || !acSizeHeader) {
    throw new Error("ProjectApplication file must include Application_ID and Inverter_Size_kW_AC_Part_1.");
  }

  return parsed.rows
    .map((row) => ({
      applicationId: clean(row[appIdHeader]),
      part1SubmissionDate: part1SubmissionHeader ? parseDate(row[part1SubmissionHeader]) : null,
      part1OriginalSubmissionDate: part1OriginalHeader ? parseDate(row[part1OriginalHeader]) : null,
      inverterSizeKwAcPart1: parseNumber(row[acSizeHeader]),
    }))
    .filter((row) => row.applicationId.length > 0);
}

export function parseQuickBooksDetailedReport(parsed: ParsedTabularData): Map<string, QuickBooksInvoice> {
  const headerRowIndex = parsed.matrix.findIndex((row) => {
    const first = normalizeHeader(row[0] ?? "");
    const second = normalizeHeader(row[1] ?? "");
    const third = normalizeHeader(row[2] ?? "");
    return first === "date" && second === "num" && third === "customer";
  });

  if (headerRowIndex < 0) {
    throw new Error("Could not find QuickBooks detail header row (Date, Num, Customer).");
  }

  const headers = parsed.matrix[headerRowIndex].map((entry, index) => clean(entry) || `column_${index + 1}`);
  const headerLookup = new Map<string, number>();
  headers.forEach((header, index) => headerLookup.set(normalizeHeader(header), index));

  const read = (row: string[], options: string[]): string => {
    for (const option of options) {
      const index = headerLookup.get(normalizeHeader(option));
      if (index === undefined) continue;
      const value = clean(row[index]);
      if (value) return value;
    }
    return "";
  };

  const grouped = new Map<
    string,
    {
      amount: number | null;
      openBalance: number | null;
      paymentStatus: string;
      voided: string;
      customer: string;
      date: Date | null;
      lineItems: QuickBooksLineItem[];
    }
  >();

  for (let rowIndex = headerRowIndex + 1; rowIndex < parsed.matrix.length; rowIndex += 1) {
    const row = parsed.matrix[rowIndex] ?? [];
    const invoiceNumber = read(row, ["Num", "Invoice Number", "Invoice #"]);
    if (!invoiceNumber) continue;

    const existing = grouped.get(invoiceNumber) ?? {
      amount: null,
      openBalance: null,
      paymentStatus: "",
      voided: "",
      customer: "",
      date: null,
      lineItems: [],
    };

    const amount = parseNumber(read(row, ["Amount", "Total"]));
    const openBalance = parseNumber(read(row, ["Open balance", "Open Balance"]));

    if (existing.amount === null && amount !== null) existing.amount = amount;
    if (existing.openBalance === null && openBalance !== null) existing.openBalance = openBalance;
    if (!existing.paymentStatus) existing.paymentStatus = read(row, ["Payment status", "Payment Status"]);
    if (!existing.voided) existing.voided = read(row, ["Voided"]);
    if (!existing.customer) {
      existing.customer =
        read(row, ["Customer", "Customer full name", "Customer Full Name", "Customer company", "Customer Company"]) ||
        "Unknown";
    }
    if (!existing.date) existing.date = parseDate(read(row, ["Date"]));

    const description =
      read(row, ["Product/service description", "Product Service Description", "Description"]) ||
      read(row, ["Product/Service", "Product Service", "Service Item"]);
    const productService = read(row, ["Product/Service", "Product Service"]);
    const lineAmount = parseNumber(read(row, ["Product/service amount line", "Product Service Amount Line", "Line Amount"]));
    const lineOrder = parseNumber(read(row, ["Line order", "Line Order"]));

    if (description || productService || lineAmount !== null) {
      existing.lineItems.push({
        lineOrder: lineOrder !== null ? Math.round(lineOrder) : null,
        description,
        productService,
        amount: lineAmount,
      });
    }

    grouped.set(invoiceNumber, existing);
  }

  const result = new Map<string, QuickBooksInvoice>();
  grouped.forEach((invoice, invoiceNumber) => {
    const sortedLineItems = [...invoice.lineItems].sort((left, right) => {
      if (left.lineOrder === null && right.lineOrder === null) return 0;
      if (left.lineOrder === null) return 1;
      if (right.lineOrder === null) return -1;
      return left.lineOrder - right.lineOrder;
    });

    const cashReceived =
      invoice.amount !== null && invoice.openBalance !== null
        ? Math.max(0, invoice.amount - invoice.openBalance)
        : normalizeHeader(invoice.paymentStatus) === "paid" && invoice.amount !== null
          ? invoice.amount
          : null;

    result.set(invoiceNumber, {
      invoiceNumber,
      amount: invoice.amount,
      openBalance: invoice.openBalance,
      cashReceived,
      paymentStatus: invoice.paymentStatus,
      voided: invoice.voided,
      customer: invoice.customer,
      date: invoice.date,
      lineItems: sortedLineItems,
    });
  });

  return result;
}

export function detectInvoiceNumberMapHeaders(headers: string[]): InvoiceNumberMapHeaderDetection {
  const csgIdHeader =
    headers.find((header) => {
      const normalized = normalizeHeader(header);
      return normalized.includes("csg") && normalized.includes("id");
    }) ?? null;

  const invoiceNumberHeader =
    headers.find((header) => {
      const normalized = normalizeHeader(header);
      return normalized.includes("invoice") && (normalized.includes("number") || normalized.includes("num") || normalized.includes("id"));
    }) ?? null;

  return {
    csgIdHeader,
    invoiceNumberHeader,
  };
}

export function parseInvoiceNumberMap(
  parsed: ParsedTabularData,
  selectedHeaders?: { csgIdHeader?: string | null; invoiceNumberHeader?: string | null }
): InvoiceNumberMapRow[] {
  const detected = detectInvoiceNumberMapHeaders(parsed.headers);
  const csgIdHeader = selectedHeaders?.csgIdHeader || detected.csgIdHeader;
  const invoiceNumberHeader = selectedHeaders?.invoiceNumberHeader || detected.invoiceNumberHeader;

  if (!csgIdHeader || !invoiceNumberHeader) {
    throw new Error("Invoice mapping file requires CSG ID and Invoice Number columns.");
  }

  return parsed.rows
    .map((row) => ({
      csgId: clean(row[csgIdHeader]),
      invoiceNumber: clean(row[invoiceNumberHeader]),
    }))
    .filter((row) => row.csgId.length > 0 && row.invoiceNumber.length > 0);
}

function classifyQuickBooksLineItem(description: string, productService: string): QuickBooksLineCategory {
  const normalized = `${description} ${productService}`.toLowerCase();

  if (
    /application fee/.test(normalized) ||
    /non[-\s]?refundable.*\$?\s*\d+\s*\/\s*kw/.test(normalized) ||
    /\$\s*10\s*\/\s*kw/.test(normalized) ||
    /\$\s*20\s*\/\s*kw/.test(normalized)
  ) {
    return "applicationFee";
  }

  if (
    /utility[-\s]?held collateral/.test(normalized) ||
    /utility bond/.test(normalized) ||
    /5\s*%\s*(utility|abp)?\s*(collateral|bond)/.test(normalized) ||
    /5\s*%\s*abp\s*collateral/.test(normalized)
  ) {
    return "utilityCollateral";
  }

  if (/additional\s+(deposit|collateral)/.test(normalized) || /\$\s*25\s*\/\s*kw/.test(normalized) || /extension deposit/.test(normalized)) {
    return "additionalCollateral";
  }

  if (/credit card fee/.test(normalized) || /cc fee/.test(normalized) || /paypal.*service fee/.test(normalized)) {
    return "ccFee";
  }

  if (/vendor fee/.test(normalized) || /approved vendor fee/.test(normalized)) {
    return "vendorFee";
  }

  return "other";
}

function extractKnownSystemIdFromText(text: string, knownSystemIds: Set<string>): string | null {
  const matches = text.match(/\b\d{3,7}\b/g) ?? [];
  return matches.find((candidate) => knownSystemIds.has(candidate)) ?? null;
}

function safeRatio(numerator: number | null, denominator: number | null): number {
  if (numerator === null || denominator === null || denominator <= 0) return 0;
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(1, ratio));
}

export function buildQuickBooksPaidUpfrontLedger(input: {
  quickBooksByInvoice: Map<string, QuickBooksInvoice>;
  knownSystemIds: Set<string>;
  invoiceNumberToSystemId?: Map<string, string>;
}): QuickBooksPaidUpfrontLedger {
  const bySystemId = new Map<
    string,
    {
      applicationFeePaidUpfront: number;
      utilityCollateralPaidUpfront: number;
      additionalCollateralPaidUpfront: number;
      ccFeePaidUpfront: number;
      vendorFeePaidUpfront: number;
      matchedLines: QuickBooksSystemTaggedLine[];
    }
  >();

  const unmatchedLines: QuickBooksPaidUpfrontLedger["unmatchedLines"] = [];

  input.quickBooksByInvoice.forEach((invoice) => {
    const ratio =
      invoice.cashReceived !== null && invoice.amount !== null
        ? safeRatio(invoice.cashReceived, invoice.amount)
        : normalizeHeader(invoice.paymentStatus) === "paid"
          ? 1
          : 0;

    invoice.lineItems.forEach((lineItem) => {
      const category = classifyQuickBooksLineItem(lineItem.description, lineItem.productService);
      if (category === "other") return;
      const lineAmount = lineItem.amount ?? 0;
      const allocatedPaid = lineAmount * ratio;

      if (allocatedPaid <= 0) {
        unmatchedLines.push({
          invoiceNumber: invoice.invoiceNumber,
          description: lineItem.description,
          productService: lineItem.productService,
          amount: lineItem.amount,
          allocatedPaidAmount: roundMoney(allocatedPaid),
          category,
          reason: "Line paid amount is non-positive; ignored for upfront-paid ledger.",
        });
        return;
      }

      const textBlob = `${lineItem.description} ${lineItem.productService}`;
      const directSystemId = extractKnownSystemIdFromText(textBlob, input.knownSystemIds);
      const mapSystemId = input.invoiceNumberToSystemId?.get(invoice.invoiceNumber) ?? null;
      const systemId = directSystemId ?? mapSystemId;
      const matchSource: "description" | "invoiceMap" = directSystemId ? "description" : "invoiceMap";

      if (!systemId) {
        unmatchedLines.push({
          invoiceNumber: invoice.invoiceNumber,
          description: lineItem.description,
          productService: lineItem.productService,
          amount: lineItem.amount,
          allocatedPaidAmount: roundMoney(allocatedPaid),
          category,
          reason: "Could not map line item to a known System ID.",
        });
        return;
      }

      const existing =
        bySystemId.get(systemId) ?? {
          applicationFeePaidUpfront: 0,
          utilityCollateralPaidUpfront: 0,
          additionalCollateralPaidUpfront: 0,
          ccFeePaidUpfront: 0,
          vendorFeePaidUpfront: 0,
          matchedLines: [],
        };

      const roundedPaid = roundMoney(allocatedPaid);
      if (category === "applicationFee") existing.applicationFeePaidUpfront += roundedPaid;
      if (category === "utilityCollateral") existing.utilityCollateralPaidUpfront += roundedPaid;
      if (category === "additionalCollateral") existing.additionalCollateralPaidUpfront += roundedPaid;
      if (category === "ccFee") existing.ccFeePaidUpfront += roundedPaid;
      if (category === "vendorFee") existing.vendorFeePaidUpfront += roundedPaid;

      existing.matchedLines.push({
        invoiceNumber: invoice.invoiceNumber,
        systemId,
        matchSource,
        category,
        lineAmount: roundMoney(lineAmount),
        allocatedPaidAmount: roundedPaid,
        description: lineItem.description,
        productService: lineItem.productService,
        confidence: matchSource === "description" ? "high" : "medium",
      });

      bySystemId.set(systemId, existing);
    });
  });

  return {
    bySystemId,
    unmatchedLines,
  };
}

function classifyPaymentTypeByPercent(percentOfGross: number | null): PaymentClassification {
  if (percentOfGross === null || !Number.isFinite(percentOfGross)) return "unknown";

  const isNear = (target: number) => Math.abs(percentOfGross - target) <= PERCENT_CLASSIFICATION_TOLERANCE;

  if (isNear(100)) return "first_full_upfront";
  if (isNear(20) || isNear(15)) return "first_partial";
  if (isNear(5) || isNear(3.54)) return "quarterly";
  return "unknown";
}

function computeApplicationFee(input: {
  part1SubmissionDate: Date | null;
  part1OriginalSubmissionDate: Date | null;
  inverterSizeKwAcPart1: number | null;
}): number {
  const effectiveDate = input.part1SubmissionDate ?? input.part1OriginalSubmissionDate;
  const sizeKw = input.inverterSizeKwAcPart1 ?? 0;
  if (!effectiveDate || !Number.isFinite(sizeKw) || sizeKw <= 0) return 0;

  const preCutoff = effectiveDate.getTime() < APPLICATION_FEE_CUTOFF.getTime();
  const rate = preCutoff ? 10 : 20;
  const cap = preCutoff ? 5_000 : 15_000;
  return roundMoney(Math.min(sizeKw * rate, cap));
}

function isFirstClassification(classification: PaymentClassification): boolean {
  return classification === "first_full_upfront" || classification === "first_partial";
}

function toCcAuthStatus(completed: boolean | null, asterisks: number | null): string {
  if (completed === null) return "Unknown";
  if (!completed) return "Incomplete";
  const digits = asterisks ?? 0;
  return digits > 0 ? `Completed (${digits} digits)` : "Completed";
}

function buildSystemToCsgMap(mappings: CsgSystemIdMappingRow[]): Map<string, string> {
  const map = new Map<string, string>();
  mappings.forEach((mapping) => {
    if (!mapping.systemId || !mapping.csgId) return;
    if (!map.has(mapping.systemId)) {
      map.set(mapping.systemId, mapping.csgId);
    }
  });
  return map;
}

function buildProjectAppMap(rows: ProjectApplicationLiteRow[]): Map<string, ProjectApplicationLiteRow> {
  const map = new Map<string, ProjectApplicationLiteRow>();
  rows.forEach((row) => {
    if (!row.applicationId) return;
    if (!map.has(row.applicationId)) {
      map.set(row.applicationId, row);
    }
  });
  return map;
}

function safeMoney(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? roundMoney(value) : 0;
}

export function computeSettlementRows(input: SettlementComputationInput): SettlementComputationResult {
  const warnings: string[] = [];
  const systemToCsg = buildSystemToCsgMap(input.csgSystemMappings);
  const projectAppById = buildProjectAppMap(input.projectApplications);
  const previousCarryforward = input.previousCarryforwardBySystemId ?? {};
  const overridesByRowId = input.manualOverridesByRowId ?? {};

  const rowsBySystem = new Map<string, UtilityInvoiceRow[]>();
  input.utilityRows.forEach((row) => {
    const existing = rowsBySystem.get(row.systemId);
    if (existing) {
      existing.push(row);
    } else {
      rowsBySystem.set(row.systemId, [row]);
    }
  });

  const outputRows: PaymentComputationRow[] = [];
  const carryforwardBySystemId: Record<string, number> = {};

  Array.from(rowsBySystem.entries())
    .sort((left, right) => left[0].localeCompare(right[0], undefined, { numeric: true, sensitivity: "base" }))
    .forEach(([systemId, rawRows]) => {
      const rows = [...rawRows].sort((left, right) => {
        const leftPayment = left.paymentNumber ?? Number.MAX_SAFE_INTEGER;
        const rightPayment = right.paymentNumber ?? Number.MAX_SAFE_INTEGER;
        if (leftPayment !== rightPayment) return leftPayment - rightPayment;
        return left.rowId.localeCompare(right.rowId);
      });

      const csgId = systemToCsg.get(systemId) ?? null;
      const terms = csgId ? input.contractTermsByCsgId.get(csgId) ?? null : null;
      const ledger = input.quickBooksPaidUpfrontLedger.bySystemId.get(systemId);
      const projectApp = projectAppById.get(systemId) ?? null;

      const paidApplicationFee = safeMoney(ledger?.applicationFeePaidUpfront);
      const paidUtilityCollateral = safeMoney(ledger?.utilityCollateralPaidUpfront);
      const paidAdditionalCollateral = safeMoney(ledger?.additionalCollateralPaidUpfront);
      const paidCcFee = safeMoney(ledger?.ccFeePaidUpfront);

      const previousCarryKnown = Object.prototype.hasOwnProperty.call(previousCarryforward, systemId);
      let runningCarry = previousCarryKnown ? safeMoney(previousCarryforward[systemId]) : null;
      let seededFromFirst = false;

      rows.forEach((row) => {
        const override = overridesByRowId[row.rowId] ?? {};
        const invoiceAmount = safeMoney(row.invoiceAmount);
        const recQuantity = safeMoney(row.recQuantity);
        const recPrice = safeMoney(row.recPrice);
        const grossContractValue = roundMoney(recQuantity * recPrice);

        const paymentPercent =
          grossContractValue > 0 ? roundMoney((invoiceAmount / grossContractValue) * 100) : null;
        const classificationAuto = classifyPaymentTypeByPercent(paymentPercent);
        const classification = override.classification ?? classificationAuto;

        const vendorFeePercent = safeMoney(override.vendorFeePercent ?? terms?.vendorFeePercent ?? 0);
        const additionalCollateralPercent = safeMoney(
          override.additionalCollateralPercent ?? terms?.additionalCollateralPercent ?? 0
        );
        const applicationFeeAmount = safeMoney(
          override.applicationFeeAmount ??
            computeApplicationFee({
              part1SubmissionDate: projectApp?.part1SubmissionDate ?? null,
              part1OriginalSubmissionDate: projectApp?.part1OriginalSubmissionDate ?? null,
              inverterSizeKwAcPart1: projectApp?.inverterSizeKwAcPart1 ?? null,
            })
        );

        const vendorFeeAmount = roundMoney((grossContractValue * vendorFeePercent) / 100);
        const utilityHeldCollateral5PercentAmount = roundMoney(grossContractValue * 0.05);
        const additionalCollateralAmount = roundMoney((grossContractValue * additionalCollateralPercent) / 100);

        const ccAuthorizationCompleted = terms?.ccAuthorizationCompleted ?? null;
        const ccIncompleteAmount = ccAuthorizationCompleted === false ? roundMoney(grossContractValue * 0.05) : 0;
        const ccIncompleteOutstanding = Math.max(0, roundMoney(ccIncompleteAmount - paidCcFee));

        const utilityOutstanding = Math.max(
          0,
          roundMoney(utilityHeldCollateral5PercentAmount - paidUtilityCollateral)
        );
        const applicationOutstanding = Math.max(0, roundMoney(applicationFeeAmount - paidApplicationFee));
        const additionalOutstanding = Math.max(
          0,
          roundMoney(additionalCollateralAmount - paidAdditionalCollateral)
        );

        const firstFormulaNetAmount = roundMoney(
          grossContractValue -
            utilityOutstanding -
            vendorFeeAmount -
            additionalOutstanding -
            applicationOutstanding -
            ccIncompleteOutstanding
        );

        const withholdingSeed = roundMoney(
          vendorFeeAmount +
            utilityOutstanding +
            additionalOutstanding +
            applicationOutstanding +
            ccIncompleteOutstanding
        );

        let seededWithholdingThisRow = 0;
        if (isFirstClassification(classification) && !seededFromFirst) {
          const current = runningCarry ?? 0;
          runningCarry = roundMoney(current + withholdingSeed);
          seededFromFirst = true;
          seededWithholdingThisRow = withholdingSeed;
        }

        const confidenceFlags: string[] = [];
        if (!csgId) confidenceFlags.push("Missing CSG mapping for System ID.");
        if (!terms) confidenceFlags.push("Missing scanned contract terms for CSG ID.");
        if (!projectApp) confidenceFlags.push("Missing ProjectApplication row for System/Application ID.");
        if (classification === "unknown") confidenceFlags.push("Payment classification is outside tolerance; review override.");

        if (!seededFromFirst && !previousCarryKnown && (row.paymentNumber ?? 0) > 1) {
          confidenceFlags.push("No prior carryforward history found for payment number > 1.");
        }

        if (runningCarry === null) {
          runningCarry = 0;
        }

        const carryforwardIn = safeMoney(override.carryforwardIn ?? runningCarry);
        const recovered = roundMoney(Math.min(Math.max(invoiceAmount, 0), Math.max(carryforwardIn, 0)));
        const carryforwardOut = roundMoney(Math.max(0, carryforwardIn - recovered));
        const netPayoutThisRow = roundMoney(invoiceAmount - recovered);

        runningCarry = carryforwardOut;

        outputRows.push({
          rowId: row.rowId,
          sourceFile: row.sourceFile,
          contractId: row.contractId,
          utilityName: row.utilityName,
          csgId,
          systemId,
          invoiceAmount,
          recQuantity,
          recPrice,
          grossContractValue,
          paymentNumber: row.paymentNumber,
          paymentPercentOfGross: paymentPercent,
          classification,
          classificationAuto,
          classificationOverridden: Boolean(override.classification),
          vendorFeePercent,
          vendorFeeAmount,
          utilityHeldCollateral5PercentAmount,
          utilityHeldCollateralPaidUpfront: paidUtilityCollateral,
          applicationFeeAmount,
          applicationFeePaidUpfront: paidApplicationFee,
          additionalCollateralPercent,
          additionalCollateralAmount,
          additionalCollateralPaidUpfront: paidAdditionalCollateral,
          ccAuthorizationFormStatus: toCcAuthStatus(terms?.ccAuthorizationCompleted ?? null, terms?.ccCardAsteriskCount ?? null),
          ccAuthIncomplete5PercentAmount: ccIncompleteAmount,
          firstPaymentFormulaNetAmount: firstFormulaNetAmount,
          withholdingBalanceSeededForSystem: seededWithholdingThisRow,
          carryforwardIn,
          carryforwardRecoveredThisRow: recovered,
          carryforwardOut,
          netPayoutThisRow,
          confidenceFlags,
          overrideNotes: clean(override.notes),
        });
      });

      carryforwardBySystemId[systemId] = runningCarry ?? 0;
    });

  if (input.quickBooksPaidUpfrontLedger.unmatchedLines.length > 0) {
    warnings.push(
      `${input.quickBooksPaidUpfrontLedger.unmatchedLines.length.toLocaleString("en-US")} QuickBooks line items could not be mapped to a System ID and were excluded from upfront-paid calculations.`
    );
  }

  return {
    rows: outputRows,
    warnings,
    carryforwardBySystemId,
    unresolvedQuickBooksLineCount: input.quickBooksPaidUpfrontLedger.unmatchedLines.length,
  };
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

export function buildSettlementCsv(rows: PaymentComputationRow[]): string {
  const headers = [
    "CSG ID",
    "System ID",
    "Invoice Amount",
    "REC Quantity",
    "REC Price",
    "Gross Contract Value",
    "Payment Number",
    "Payment Percent Of Gross",
    "Classification",
    "Vendor Fee %",
    "Vendor Fee Amount",
    "Utility Held Collateral 5% Amount",
    "Utility Held Collateral Paid Upfront",
    "Application Fee Amount",
    "Application Fee Paid Upfront",
    "Additional Collateral %",
    "Additional Collateral Amount",
    "Additional Collateral Paid Upfront",
    "CC Authorization Form Status",
    "CC Auth Incomplete 5% Amount",
    "First Payment Formula Net Amount",
    "Carryforward In",
    "Carryforward Recovered This Row",
    "Carryforward Out",
    "Net Payout This Row",
    "Contract ID",
    "Utility",
    "Source File",
    "Confidence Flags",
    "Override Notes",
  ];

  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((row) => {
    const record = [
      row.csgId ?? "",
      row.systemId,
      row.invoiceAmount.toFixed(2),
      row.recQuantity,
      row.recPrice.toFixed(2),
      row.grossContractValue.toFixed(2),
      row.paymentNumber ?? "",
      row.paymentPercentOfGross ?? "",
      row.classification,
      row.vendorFeePercent,
      row.vendorFeeAmount.toFixed(2),
      row.utilityHeldCollateral5PercentAmount.toFixed(2),
      row.utilityHeldCollateralPaidUpfront.toFixed(2),
      row.applicationFeeAmount.toFixed(2),
      row.applicationFeePaidUpfront.toFixed(2),
      row.additionalCollateralPercent,
      row.additionalCollateralAmount.toFixed(2),
      row.additionalCollateralPaidUpfront.toFixed(2),
      row.ccAuthorizationFormStatus,
      row.ccAuthIncomplete5PercentAmount.toFixed(2),
      row.firstPaymentFormulaNetAmount.toFixed(2),
      row.carryforwardIn.toFixed(2),
      row.carryforwardRecoveredThisRow.toFixed(2),
      row.carryforwardOut.toFixed(2),
      row.netPayoutThisRow.toFixed(2),
      row.contractId ?? "",
      row.utilityName ?? "",
      row.sourceFile,
      row.confidenceFlags.join(" | "),
      row.overrideNotes,
    ];

    lines.push(record.map(csvEscape).join(","));
  });

  return lines.join("\n");
}

export function buildInvoiceNumberToSystemIdMap(input: {
  invoiceNumberMapRows: InvoiceNumberMapRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
}): Map<string, string> {
  const systemIdByCsg = new Map<string, string>();
  input.csgSystemMappings.forEach((mapping) => {
    if (!mapping.csgId || !mapping.systemId) return;
    if (!systemIdByCsg.has(mapping.csgId)) {
      systemIdByCsg.set(mapping.csgId, mapping.systemId);
    }
  });

  const invoiceToSystem = new Map<string, string>();
  input.invoiceNumberMapRows.forEach((row) => {
    const systemId = systemIdByCsg.get(row.csgId);
    if (!systemId) return;
    if (!invoiceToSystem.has(row.invoiceNumber)) {
      invoiceToSystem.set(row.invoiceNumber, systemId);
    }
  });

  return invoiceToSystem;
}
