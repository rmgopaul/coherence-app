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

export type CsgPortalDatabaseRow = {
  systemId: string;
  csgId: string;
  installerName: string | null;
  partnerCompanyName: string | null;
  customerEmail: string | null;
  customerAltEmail: string | null;
  systemAddress: string | null;
  systemCity: string | null;
  systemState: string | null;
  systemZip: string | null;
  paymentNotes: string | null;
  collateralReimbursedToPartner: boolean | null;
};

export type PayeeMailingUpdateRow = {
  rowId: string;
  sourceRowNumber: number;
  requestDate: Date | null;
  requestDateRaw: string | null;
  responderEmail: string | null;
  enteredCsgId: string | null;
  paymentMethod: string | null;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  cityStateZip: string | null;
};

export type PaymentsReportRow = {
  rowId: string;
  sourceRowNumber: number;
  systemId: string;
  csgId: string;
  paymentNumber: number | null;
  paymentType: string;
  paymentDate: Date | null;
  amount: number | null;
  appliesToContract: boolean | null;
};

export type PayeeMailingUpdateResolutionReason =
  | "entered_csg_id"
  | "entered_csg_id_verified_by_email"
  | "resolved_by_email"
  | "entered_csg_id_conflicts_with_email"
  | "ambiguous_email"
  | "missing_csg_and_email";

export type ResolvedPayeeMailingUpdateRow = PayeeMailingUpdateRow & {
  resolvedCsgId: string | null;
  emailMatchedCsgIds: string[];
  resolutionReason: PayeeMailingUpdateResolutionReason;
};

export type LatestPayeeMailingUpdateResult = {
  byCsgId: Map<string, ResolvedPayeeMailingUpdateRow>;
  unresolvedRows: ResolvedPayeeMailingUpdateRow[];
  warnings: string[];
};

export type InstallerRuleMatchField = "installerName" | "partnerCompanyName";

export type InstallerSettlementRule = {
  id: string;
  name: string;
  active: boolean;
  matchField: InstallerRuleMatchField;
  matchValue: string;
  forceUtilityCollateralReimbursement: boolean;
  referralFeePercent: number;
  notes: string;
};

export type QuickBooksLineCategory =
  | "applicationFee"
  | "utilityCollateral"
  | "utilityCollateralReimbursement"
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
      utilityCollateralReimbursementToPartnerCompanyAmount: number;
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
  paymentMethod: string | null;
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  cityStateZip: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
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
  collateralReimbursementToPartnerCompanyAmount: number;
  referralFeePercent: number;
  referralFeeAmount: number;
  applicationFeeAmount: number;
  applicationFeePaidUpfront: number;
  additionalCollateralPercent: number;
  additionalCollateralAmount: number;
  additionalCollateralPaidUpfront: number;
  ccAuthorizationFormStatus: string;
  ccAuthIncomplete5PercentAmount: number;
  firstPaymentFormulaNetAmount: number;
  paymentMethod: string;
  payeeName: string;
  mailingAddress1: string;
  mailingAddress2: string;
  city: string;
  state: string;
  zip: string;
  aiMailingModified: boolean;
  aiMailingModifiedFields: string;
  installerName: string;
  partnerCompanyName: string;
  customerEmail: string;
  customerAltEmail: string;
  systemAddress: string;
  systemCity: string;
  systemState: string;
  systemZip: string;
  paymentNotes: string;
  appliedInstallerRuleName: string;
  paymentReportCheckStatus: string;
  paymentReportMatchedPaymentNumber: number | null;
  paymentReportAppliedCount: number;
  paymentReportAppliedAmount: number;
  paymentReportReissueCount: number;
  paymentReportReissueAmount: number;
  paymentReportOtherTypeCount: number;
  paymentReportLastType: string;
  paymentReportLastPaymentDate: string;
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
  csgPortalDatabaseRows?: CsgPortalDatabaseRow[];
  installerRules?: InstallerSettlementRule[];
  paymentsReportRows?: PaymentsReportRow[];
  previousCarryforwardBySystemId?: Record<string, number>;
  manualOverridesByRowId?: Record<string, ManualOverride>;
  aiMailingModifiedFieldsByCsgId?: Record<string, string[]>;
};

const APPLICATION_FEE_CUTOFF = new Date("2024-06-01T00:00:00.000Z");
const PERCENT_CLASSIFICATION_TOLERANCE = 0.25;

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeEmail(value: unknown): string {
  return clean(value).toLowerCase();
}

function normalizeCsgId(value: unknown): string {
  const raw = clean(value);
  if (!raw) return "";
  const numericWithTrailingDecimals = raw.match(/^(\d+)\.0+$/);
  if (numericWithTrailingDecimals) return numericWithTrailingDecimals[1];
  return raw;
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

function findHeaderByKeywords(headers: string[], requiredKeywords: string[]): string | null {
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const matchesAll = requiredKeywords.every((keyword) => normalized.includes(normalizeHeader(keyword)));
    if (matchesAll) return header;
  }
  return null;
}

function findHeaderByKeywordsExcluding(
  headers: string[],
  requiredKeywords: string[],
  excludedKeywords: string[]
): string | null {
  const normalizedExcluded = excludedKeywords.map((keyword) => normalizeHeader(keyword));
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const matchesAll = requiredKeywords.every((keyword) => normalized.includes(normalizeHeader(keyword)));
    if (!matchesAll) continue;
    const hasExcluded = normalizedExcluded.some((keyword) => normalized.includes(keyword));
    if (hasExcluded) continue;
    return header;
  }
  return null;
}

function findHeaderByAliases(headers: string[], aliases: string[]): string | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const exact = headers.find((header) => normalizeHeader(header) === normalizedAlias);
    if (exact) return exact;
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const fuzzy = headers.find((header) => normalizeHeader(header).includes(normalizedAlias));
    if (fuzzy) return fuzzy;
  }

  return null;
}

export function parsePayeeMailingUpdateRequests(parsed: ParsedTabularData): PayeeMailingUpdateRow[] {
  if (!Array.isArray(parsed.headers) || parsed.headers.length === 0) {
    throw new Error("Payee update file must include a header row.");
  }

  const dateHeader =
    findHeaderByAliases(parsed.headers, ["Date", "Timestamp", "Submitted At", "Submission Date", "Created At"]) ??
    parsed.headers[0] ??
    null;
  const emailHeader =
    findHeaderByAliases(parsed.headers, [
      "Responder Email",
      "Customer Email",
      "Email",
      "Email Address",
      "Responders Email",
    ]) ??
    parsed.headers[1] ??
    null;
  const csgHeader =
    findHeaderByAliases(parsed.headers, ["CSG ID", "CSGID", "CSG Portal ID", "Portal ID"]) ??
    parsed.headers.find((header) => normalizeHeader(header) === "systemid") ??
    parsed.headers[2] ??
    null;

  const paymentMethodHeader =
    findHeaderByKeywords(parsed.headers, ["payment", "method"]) ??
    findHeaderByAliases(parsed.headers, ["Method of Payment", "Preferred Payment Method"]) ??
    null;

  const payeeNameHeader =
    findHeaderByKeywords(parsed.headers, ["payee"]) ??
    findHeaderByAliases(parsed.headers, ["Payee Name", "Name on Check", "Check Payee"]) ??
    null;

  const mailingAddress1Header =
    findHeaderByAliases(parsed.headers, [
      "Mailing Address 1",
      "Mailing Address",
      "Address Line 1",
      "Street Address",
      "Mailing Street Address",
    ]) ??
    findHeaderByKeywords(parsed.headers, ["mailing", "address"]) ??
    null;

  let mailingAddress2Header =
    findHeaderByAliases(parsed.headers, [
      "Mailing Address 2",
      "Address Line 2",
      "Apt/Suite",
      "Apt Suite",
      "Unit",
    ]) ?? null;

  if (mailingAddress2Header && mailingAddress2Header === mailingAddress1Header) {
    mailingAddress2Header = null;
  }

  const cityHeader =
    findHeaderByAliases(parsed.headers, ["Mailing City", "City"]) ??
    findHeaderByKeywords(parsed.headers, ["city"]) ??
    null;
  const stateHeader =
    findHeaderByAliases(parsed.headers, ["Mailing State", "State"]) ??
    findHeaderByKeywords(parsed.headers, ["state"]) ??
    null;
  const zipHeader =
    findHeaderByAliases(parsed.headers, ["Mailing Zip", "Zip", "Zip Code", "Postal Code"]) ??
    findHeaderByKeywords(parsed.headers, ["zip"]) ??
    null;
  const cityStateZipHeader =
    findHeaderByAliases(parsed.headers, [
      "City State Zip",
      "City/State/Zip",
      "City, State, Zip",
      "Mailing City State Zip",
      "City State ZIP",
    ]) ?? null;

  const rows: PayeeMailingUpdateRow[] = [];
  parsed.rows.forEach((row, index) => {
    const sourceRowNumber = index + 2;
    const hasAnyValue = parsed.headers.some((header) => clean(row[header]).length > 0);
    if (!hasAnyValue) return;

    const responderEmail = emailHeader ? normalizeEmail(row[emailHeader]) || null : null;
    const enteredCsgId = csgHeader ? normalizeCsgId(row[csgHeader]) || null : null;
    const paymentMethod = paymentMethodHeader ? clean(row[paymentMethodHeader]) || null : null;
    const payeeName = payeeNameHeader ? clean(row[payeeNameHeader]) || null : null;
    const mailingAddress1 = mailingAddress1Header ? clean(row[mailingAddress1Header]) || null : null;
    const mailingAddress2 = mailingAddress2Header ? clean(row[mailingAddress2Header]) || null : null;
    const city = cityHeader ? clean(row[cityHeader]) || null : null;
    const state = stateHeader ? clean(row[stateHeader]).toUpperCase() || null : null;
    const zip = zipHeader ? clean(row[zipHeader]) || null : null;
    const cityStateZip = cityStateZipHeader ? clean(row[cityStateZipHeader]) || null : null;

    const hasUpdatePayload = Boolean(
      paymentMethod ||
        payeeName ||
        mailingAddress1 ||
        mailingAddress2 ||
        city ||
        state ||
        zip ||
        cityStateZip
    );
    if (!hasUpdatePayload) return;
    if (!responderEmail && !enteredCsgId) return;

    const requestDateRaw = dateHeader ? clean(row[dateHeader]) : "";
    rows.push({
      rowId: `payee-update:${sourceRowNumber}`,
      sourceRowNumber,
      requestDate: parseDate(requestDateRaw),
      requestDateRaw: requestDateRaw || null,
      responderEmail,
      enteredCsgId,
      paymentMethod,
      payeeName,
      mailingAddress1,
      mailingAddress2,
      city,
      state,
      zip,
      cityStateZip,
    });
  });

  return rows;
}

export function parsePaymentsReport(parsed: ParsedTabularData): PaymentsReportRow[] {
  if (!Array.isArray(parsed.headers) || parsed.headers.length === 0) {
    throw new Error("Payments report must include a header row.");
  }

  const systemHeader =
    findHeaderByAliases(parsed.headers, [
      "State Certification Number",
      "State_Certification_Number",
      "ABP ID",
      "System ID (ABP)",
    ]) ??
    findHeaderByAliases(parsed.headers, ["Application_ID"]) ??
    null;

  const csgHeader =
    findHeaderByAliases(parsed.headers, ["System Id", "System ID", "CSG ID", "CSGID", "Portal ID"]) ?? null;

  const paymentTypeHeader = findHeaderByAliases(parsed.headers, ["Type", "Payment Type"]) ?? null;
  const paymentNumberHeader = findHeaderByAliases(parsed.headers, ["Payment Number", "Payment #"]) ?? null;
  const paymentDateHeader = findHeaderByAliases(parsed.headers, ["Payment Date", "Date"]) ?? null;
  const amountHeader = findHeaderByAliases(parsed.headers, ["Amount", "Payment Amount"]) ?? null;

  if (!systemHeader || !csgHeader || !paymentTypeHeader) {
    throw new Error(
      "Payments report must include State Certification Number, System Id, and Type columns."
    );
  }

  const rows: PaymentsReportRow[] = [];
  parsed.rows.forEach((row, index) => {
    const sourceRowNumber = index + 2;
    const systemId = normalizeCsgId(row[systemHeader]);
    const csgId = normalizeCsgId(row[csgHeader]);
    const paymentType = clean(row[paymentTypeHeader]);
    if (!systemId && !csgId) return;
    if (!paymentType) return;

    const normalizedType = normalizeHeader(paymentType);
    let appliesToContract: boolean | null = null;
    if (normalizedType.includes("reissue")) {
      appliesToContract = false;
    } else if (normalizedType.includes("abpsrecpayment")) {
      appliesToContract = true;
    }

    rows.push({
      rowId: `payments-report:${sourceRowNumber}`,
      sourceRowNumber,
      systemId,
      csgId,
      paymentNumber: paymentNumberHeader ? parseNumber(row[paymentNumberHeader]) : null,
      paymentType,
      paymentDate: paymentDateHeader ? parseDate(row[paymentDateHeader]) : null,
      amount: amountHeader ? parseNumber(row[amountHeader]) : null,
      appliesToContract,
    });
  });

  return rows;
}

function chooseNewerPayeeUpdate(
  existing: ResolvedPayeeMailingUpdateRow | undefined,
  candidate: ResolvedPayeeMailingUpdateRow
): ResolvedPayeeMailingUpdateRow {
  if (!existing) return candidate;

  const existingTime = existing.requestDate?.getTime();
  const candidateTime = candidate.requestDate?.getTime();
  const existingHasTime = Number.isFinite(existingTime);
  const candidateHasTime = Number.isFinite(candidateTime);

  if (candidateHasTime && !existingHasTime) return candidate;
  if (candidateHasTime && existingHasTime && (candidateTime as number) > (existingTime as number)) {
    return candidate;
  }
  if (candidateHasTime && existingHasTime && (candidateTime as number) === (existingTime as number)) {
    return candidate.sourceRowNumber > existing.sourceRowNumber ? candidate : existing;
  }
  if (!candidateHasTime && !existingHasTime && candidate.sourceRowNumber > existing.sourceRowNumber) {
    return candidate;
  }
  return existing;
}

export function buildLatestPayeeMailingUpdates(input: {
  updates: PayeeMailingUpdateRow[];
  csgPortalDatabaseRows?: CsgPortalDatabaseRow[];
}): LatestPayeeMailingUpdateResult {
  const byCsgId = new Map<string, ResolvedPayeeMailingUpdateRow>();
  const unresolvedRows: ResolvedPayeeMailingUpdateRow[] = [];
  const warnings: string[] = [];

  const emailToCsgIds = new Map<string, Set<string>>();
  (input.csgPortalDatabaseRows ?? []).forEach((row) => {
    const csgId = normalizeCsgId(row.csgId);
    if (!csgId) return;

    [row.customerEmail, row.customerAltEmail].forEach((rawEmail) => {
      const email = normalizeEmail(rawEmail);
      if (!email) return;
      const existing = emailToCsgIds.get(email) ?? new Set<string>();
      existing.add(csgId);
      emailToCsgIds.set(email, existing);
    });
  });

  let correctedByEmailCount = 0;
  let ambiguousEmailCount = 0;

  input.updates.forEach((update) => {
    const enteredCsgId = normalizeCsgId(update.enteredCsgId);
    const responderEmail = normalizeEmail(update.responderEmail);
    const emailMatchedCsgIds = responderEmail
      ? Array.from(emailToCsgIds.get(responderEmail) ?? []).sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
        )
      : [];

    let resolvedCsgId: string | null = null;
    let resolutionReason: PayeeMailingUpdateResolutionReason;

    if (enteredCsgId && emailMatchedCsgIds.length > 0) {
      if (emailMatchedCsgIds.includes(enteredCsgId)) {
        resolvedCsgId = enteredCsgId;
        resolutionReason = "entered_csg_id_verified_by_email";
      } else if (emailMatchedCsgIds.length === 1) {
        resolvedCsgId = emailMatchedCsgIds[0];
        resolutionReason = "resolved_by_email";
        correctedByEmailCount += 1;
      } else {
        resolvedCsgId = enteredCsgId;
        resolutionReason = "entered_csg_id_conflicts_with_email";
        ambiguousEmailCount += 1;
      }
    } else if (enteredCsgId) {
      resolvedCsgId = enteredCsgId;
      resolutionReason = "entered_csg_id";
    } else if (emailMatchedCsgIds.length === 1) {
      resolvedCsgId = emailMatchedCsgIds[0];
      resolutionReason = "resolved_by_email";
      correctedByEmailCount += 1;
    } else if (emailMatchedCsgIds.length > 1) {
      resolutionReason = "ambiguous_email";
      ambiguousEmailCount += 1;
    } else {
      resolutionReason = "missing_csg_and_email";
    }

    const resolvedRow: ResolvedPayeeMailingUpdateRow = {
      ...update,
      enteredCsgId: enteredCsgId || null,
      responderEmail: responderEmail || null,
      resolvedCsgId,
      emailMatchedCsgIds,
      resolutionReason,
    };

    if (resolvedCsgId) {
      const existing = byCsgId.get(resolvedCsgId);
      byCsgId.set(resolvedCsgId, chooseNewerPayeeUpdate(existing, resolvedRow));
    } else {
      unresolvedRows.push(resolvedRow);
    }
  });

  if (correctedByEmailCount > 0) {
    warnings.push(
      `${correctedByEmailCount.toLocaleString("en-US")} payee update row(s) used responder email to resolve the CSG ID.`
    );
  }
  if (ambiguousEmailCount > 0) {
    warnings.push(
      `${ambiguousEmailCount.toLocaleString("en-US")} payee update row(s) had CSG/email conflicts or ambiguous email matches; review those records.`
    );
  }
  if (unresolvedRows.length > 0) {
    warnings.push(
      `${unresolvedRows.length.toLocaleString("en-US")} payee update row(s) could not be matched to a CSG ID and were not applied.`
    );
  }

  return {
    byCsgId,
    unresolvedRows,
    warnings,
  };
}

function parseBooleanLike(value: unknown): boolean | null {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return null;

  if (
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized.includes("reimbursed") ||
    normalized.includes("reimbursement") ||
    normalized.includes("returned")
  ) {
    return true;
  }

  if (
    normalized === "no" ||
    normalized === "n" ||
    normalized === "false" ||
    normalized === "0" ||
    normalized.includes("not reimbursed") ||
    normalized.includes("no reimbursement")
  ) {
    return false;
  }

  return null;
}

export function parseCsgPortalDatabase(parsed: ParsedTabularData): CsgPortalDatabaseRow[] {
  const systemHeader =
    parsed.headers.find((header) => {
      const normalized = normalizeHeader(header);
      return (
        normalized.includes("systemid") ||
        normalized.includes("statecertificationnumber") ||
        normalized === "applicationid"
      );
    }) ?? null;

  const csgHeader =
    parsed.headers.find((header) => {
      const normalized = normalizeHeader(header);
      return normalized.includes("csgid");
    }) ??
    parsed.headers.find((header) => {
      const normalized = normalizeHeader(header);
      const rawLower = clean(header).toLowerCase();
      return (
        normalized === "id" ||
        normalized === "portalid" ||
        normalized === "csgportalid" ||
        rawLower === "system_id"
      );
    }) ??
    null;

  const installerHeader =
    findHeaderByKeywords(parsed.headers, ["installer"]) ??
    parsed.headers.find((header) => {
      const normalized = normalizeHeader(header);
      return normalized.includes("installercompany") || normalized.includes("installingcompany");
    }) ??
    null;

  const partnerHeader =
    findHeaderByKeywords(parsed.headers, ["partner", "company"]) ??
    findHeaderByKeywords(parsed.headers, ["developer"]) ??
    null;

  const customerEmailHeader =
    findHeaderByKeywords(parsed.headers, ["customer", "email"]) ??
    findHeaderByKeywords(parsed.headers, ["email"]) ??
    null;

  const customerAltEmailHeader =
    findHeaderByKeywords(parsed.headers, ["alternate", "email"]) ??
    findHeaderByKeywords(parsed.headers, ["alt", "email"]) ??
    findHeaderByKeywords(parsed.headers, ["secondary", "email"]) ??
    null;

  // IMPORTANT: system_owner_address must NOT fuzzy-match system_owner_payment_address.
  // Use exact-only alias matching first, then fall back to keyword exclusion.
  // Also try raw case-insensitive .trim() match for portal exports that may have odd encoding.
  const systemAddressHeader = (() => {
    const exactAliases = [
      // Prefer the actual system/site location columns over owner address
      "system_address",
      "site_address",
      "system_owner_system_address",
      "system owner system address",
      "system_owner_site_address",
      "system owner site address",
      // Fallback to owner address if no dedicated system address column exists
      "system_owner_address",
      "system owner address",
    ];
    // Exact normalized match only — no fuzzy .includes()
    for (const alias of exactAliases) {
      const normalizedAlias = normalizeHeader(alias);
      const exact = parsed.headers.find((h) => normalizeHeader(h) === normalizedAlias);
      if (exact) return exact;
    }
    // Raw case-insensitive match as fallback (handles BOM, non-breaking spaces, etc.)
    for (const alias of exactAliases) {
      const lowerAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
      const raw = parsed.headers.find((h) => {
        const lowerH = clean(h).toLowerCase().replace(/[^a-z0-9]/g, "");
        return lowerH === lowerAlias;
      });
      if (raw) return raw;
    }
    return (
      findHeaderByKeywordsExcluding(parsed.headers, ["system", "address"], [
        "payment",
        "mailing",
        "payee",
        "check",
        "remit",
      ]) ??
      findHeaderByKeywords(parsed.headers, ["site", "address"]) ??
      findHeaderByAliases(parsed.headers, ["PV System Address", "Project Address", "Installation Address"]) ??
      null
    );
  })();

  // Same exact-only strategy to avoid matching payment_ columns
  const systemCityHeader = (() => {
    const exactAliases = [
      "system_city",
      "site_city",
      "system_owner_system_city",
      "system owner system city",
      "system_owner_site_city",
      "system owner site city",
      "system_owner_city",
      "system owner city",
    ];
    for (const alias of exactAliases) {
      const normalizedAlias = normalizeHeader(alias);
      const exact = parsed.headers.find((h) => normalizeHeader(h) === normalizedAlias);
      if (exact) return exact;
    }
    return (
      findHeaderByKeywordsExcluding(parsed.headers, ["system", "city"], [
        "payment",
        "mailing",
        "payee",
        "check",
        "remit",
      ]) ??
      findHeaderByKeywords(parsed.headers, ["site", "city"]) ??
      null
    );
  })();

  const systemStateHeader = (() => {
    const exactAliases = [
      "system_state",
      "site_state",
      "system_owner_system_state",
      "system owner system state",
      "system_owner_site_state",
      "system owner site state",
      "system_owner_state",
      "system owner state",
    ];
    for (const alias of exactAliases) {
      const normalizedAlias = normalizeHeader(alias);
      const exact = parsed.headers.find((h) => normalizeHeader(h) === normalizedAlias);
      if (exact) return exact;
    }
    return (
      findHeaderByKeywordsExcluding(parsed.headers, ["system", "state"], [
        "payment",
        "mailing",
        "payee",
        "check",
        "remit",
      ]) ??
      findHeaderByKeywords(parsed.headers, ["site", "state"]) ??
      null
    );
  })();

  const systemZipHeader = (() => {
    const exactAliases = [
      "system_zip",
      "site_zip",
      "system_owner_system_zip",
      "system owner system zip",
      "system_owner_site_zip",
      "system owner site zip",
      "system_owner_zip",
      "system owner zip",
      "system_owner_system_postal_code",
      "system owner system postal code",
    ];
    for (const alias of exactAliases) {
      const normalizedAlias = normalizeHeader(alias);
      const exact = parsed.headers.find((h) => normalizeHeader(h) === normalizedAlias);
      if (exact) return exact;
    }
    return (
      findHeaderByKeywordsExcluding(parsed.headers, ["system", "zip"], [
        "payment",
        "mailing",
        "payee",
        "check",
        "remit",
      ]) ??
      findHeaderByKeywords(parsed.headers, ["site", "zip"]) ??
      findHeaderByKeywords(parsed.headers, ["system", "postal"]) ??
      findHeaderByKeywords(parsed.headers, ["site", "postal"]) ??
      null
    );
  })();

  const paymentNotesHeader =
    findHeaderByKeywords(parsed.headers, ["payment", "notes"]) ??
    findHeaderByKeywords(parsed.headers, ["payment", "note"]) ??
    findHeaderByKeywords(parsed.headers, ["pay", "notes"]) ??
    null;

  const collateralReimbursedHeader =
    findHeaderByKeywords(parsed.headers, ["collateral", "reimburs"]) ??
    findHeaderByKeywords(parsed.headers, ["reimburs"]) ??
    null;

  // Diagnostic: log which headers were resolved for debugging column mapping issues.
  console.info(
    "[parseCsgPortalDatabase] Header mapping:",
    JSON.stringify({
      allHeaders: parsed.headers,
      systemId: systemHeader,
      csgId: csgHeader,
      installer: installerHeader,
      partner: partnerHeader,
      customerEmail: customerEmailHeader,
      customerAltEmail: customerAltEmailHeader,
      systemAddress: systemAddressHeader,
      systemCity: systemCityHeader,
      systemState: systemStateHeader,
      systemZip: systemZipHeader,
      paymentNotes: paymentNotesHeader,
      collateralReimbursed: collateralReimbursedHeader,
    })
  );

  if (!systemAddressHeader && (systemCityHeader || systemStateHeader || systemZipHeader)) {
    console.warn(
      "[parseCsgPortalDatabase] WARNING: system city/state/zip headers were found but system ADDRESS header was NOT matched.",
      "Available headers:",
      parsed.headers.map((h) => `"${h}"`).join(", ")
    );
  }

  if (!csgHeader) {
    throw new Error(
      "CSG portal database file must include a CSG ID column (for example: CSG ID, ID, or system_id)."
    );
  }

  const missingCsgIdRows: number[] = [];
  const outputRows: CsgPortalDatabaseRow[] = [];

  parsed.rows.forEach((row, index) => {
    const hasAnyValue = parsed.headers.some((header) => clean(row[header]).length > 0);
    if (!hasAnyValue) return;

    const csgId = clean(row[csgHeader]);
    if (!csgId) {
      // Report spreadsheet-style row numbers so user can quickly locate invalid rows.
      missingCsgIdRows.push(index + 2);
      return;
    }

    const systemId = systemHeader ? clean(row[systemHeader]) : "";
    outputRows.push({
      systemId,
      csgId,
      installerName: installerHeader ? clean(row[installerHeader]) || null : null,
      partnerCompanyName: partnerHeader ? clean(row[partnerHeader]) || null : null,
      customerEmail: customerEmailHeader ? clean(row[customerEmailHeader]) || null : null,
      customerAltEmail: customerAltEmailHeader ? clean(row[customerAltEmailHeader]) || null : null,
      systemAddress: systemAddressHeader ? clean(row[systemAddressHeader]) || null : null,
      systemCity: systemCityHeader ? clean(row[systemCityHeader]) || null : null,
      systemState: systemStateHeader ? clean(row[systemStateHeader]).toUpperCase() || null : null,
      systemZip: systemZipHeader ? clean(row[systemZipHeader]) || null : null,
      paymentNotes: paymentNotesHeader ? clean(row[paymentNotesHeader]) || null : null,
      collateralReimbursedToPartner: collateralReimbursedHeader
        ? parseBooleanLike(row[collateralReimbursedHeader])
        : null,
    });
  });

  if (missingCsgIdRows.length > 0) {
    const preview = missingCsgIdRows.slice(0, 10).join(", ");
    const moreCount = missingCsgIdRows.length - 10;
    throw new Error(
      `CSG portal database rows are missing CSG ID values. Row(s): ${preview}${moreCount > 0 ? ` (+${moreCount} more)` : ""}.`
    );
  }

  return outputRows;
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
  const hasReimbursementMarker =
    /reimburs(?:e|ed|ement|ing)?/.test(normalized) || /reimbursed/.test(normalized);
  const hasPartnerMarker = /(installer|partner|developer|partner company|installer company)/.test(normalized);

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
    if (hasReimbursementMarker && (hasPartnerMarker || /company/.test(normalized))) {
      return "utilityCollateralReimbursement";
    }
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
      utilityCollateralReimbursementToPartnerCompanyAmount: number;
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
          utilityCollateralReimbursementToPartnerCompanyAmount: 0,
          additionalCollateralPaidUpfront: 0,
          ccFeePaidUpfront: 0,
          vendorFeePaidUpfront: 0,
          matchedLines: [],
        };

      const roundedPaid = roundMoney(allocatedPaid);
      if (category === "applicationFee") existing.applicationFeePaidUpfront += roundedPaid;
      if (category === "utilityCollateral") existing.utilityCollateralPaidUpfront += roundedPaid;
      if (category === "utilityCollateralReimbursement") {
        existing.utilityCollateralReimbursementToPartnerCompanyAmount += roundedPaid;
      }
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

function inferFirstPaymentPercent(percentOfGross: number | null): number | null {
  if (percentOfGross === null || !Number.isFinite(percentOfGross)) return null;

  const isNear = (target: number) => Math.abs(percentOfGross - target) <= PERCENT_CLASSIFICATION_TOLERANCE;

  if (isNear(100)) return 100;
  if (isNear(20) || isNear(5)) return 20;
  if (isNear(15) || isNear(3.54)) return 15;
  return null;
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

function splitCityStateZip(rawValue: string | null | undefined): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const raw = clean(rawValue);
  if (!raw) return { city: null, state: null, zip: null };

  const normalized = raw.replace(/\s+/g, " ");
  const match = normalized.match(/^(.+?)[,\s]+([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) {
    return { city: normalized || null, state: null, zip: null };
  }

  return {
    city: clean(match[1]) || null,
    state: clean(match[2]).toUpperCase() || null,
    zip: clean(match[3]) || null,
  };
}

function composeCityStateZip(city: string | null, state: string | null, zip: string | null): string | null {
  const cityValue = clean(city) || null;
  const stateValue = clean(state) || null;
  const zipValue = clean(zip) || null;
  if (!cityValue && !stateValue && !zipValue) return null;
  const stateZip = [stateValue, zipValue].filter(Boolean).join(" ");
  return [cityValue, stateZip].filter(Boolean).join(", ");
}

export function applyPayeeMailingUpdatesToContractTerms(input: {
  contractTermsByCsgId: Map<string, ContractTerms>;
  latestUpdatesByCsgId: Map<string, ResolvedPayeeMailingUpdateRow>;
}): Map<string, ContractTerms> {
  const merged = new Map<string, ContractTerms>(input.contractTermsByCsgId);

  input.latestUpdatesByCsgId.forEach((update, csgId) => {
    const existing = merged.get(csgId);
    const defaultTerms: ContractTerms = {
      csgId,
      fileName: `payee-update-${csgId}.csv`,
      vendorFeePercent: null,
      additionalCollateralPercent: null,
      ccAuthorizationCompleted: null,
      ccCardAsteriskCount: null,
      recQuantity: null,
      recPrice: null,
      paymentMethod: null,
      payeeName: null,
      mailingAddress1: null,
      mailingAddress2: null,
      cityStateZip: null,
      city: null,
      state: null,
      zip: null,
    };

    const base = existing ?? defaultTerms;
    const updateCityStateZipParts = splitCityStateZip(update.cityStateZip);
    const city = clean(update.city) || updateCityStateZipParts.city || clean(base.city) || null;
    const state =
      clean(update.state).toUpperCase() ||
      (updateCityStateZipParts.state ? updateCityStateZipParts.state.toUpperCase() : "") ||
      clean(base.state).toUpperCase() ||
      null;
    const zip = clean(update.zip) || updateCityStateZipParts.zip || clean(base.zip) || null;

    merged.set(csgId, {
      ...base,
      csgId,
      paymentMethod: clean(update.paymentMethod) || base.paymentMethod || null,
      payeeName: clean(update.payeeName) || base.payeeName || null,
      mailingAddress1: clean(update.mailingAddress1) || base.mailingAddress1 || null,
      mailingAddress2: clean(update.mailingAddress2) || base.mailingAddress2 || null,
      city,
      state,
      zip,
      cityStateZip:
        clean(update.cityStateZip) ||
        composeCityStateZip(city, state, zip) ||
        clean(base.cityStateZip) ||
        null,
    });
  });

  return merged;
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

function buildCsgPortalLookup(rows: CsgPortalDatabaseRow[]): Map<string, CsgPortalDatabaseRow> {
  const byCsgId = new Map<string, CsgPortalDatabaseRow>();

  rows.forEach((row) => {
    const csgId = clean(row.csgId);
    if (csgId && !byCsgId.has(csgId)) {
      byCsgId.set(csgId, row);
    }
  });

  return byCsgId;
}

function findInstallerRuleForSystem(
  systemRow: CsgPortalDatabaseRow | null,
  rules: InstallerSettlementRule[]
): InstallerSettlementRule | null {
  if (!systemRow) return null;

  const installerNameNormalized = clean(systemRow.installerName).toLowerCase();
  const partnerCompanyNormalized = clean(systemRow.partnerCompanyName).toLowerCase();

  for (const rule of rules) {
    if (!rule.active) continue;
    const matchValue = clean(rule.matchValue).toLowerCase();
    if (!matchValue) continue;

    const haystack =
      rule.matchField === "partnerCompanyName" ? partnerCompanyNormalized : installerNameNormalized;

    if (!haystack) continue;
    if (haystack.includes(matchValue)) return rule;
  }

  return null;
}

function safeMoney(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? roundMoney(value) : 0;
}

function buildPaymentsReportLookup(
  rows: PaymentsReportRow[]
): Map<string, PaymentsReportRow[]> {
  const bySystemId = new Map<string, PaymentsReportRow[]>();
  rows.forEach((row) => {
    const systemId = clean(row.systemId);
    if (!systemId) return;
    const existing = bySystemId.get(systemId);
    if (existing) {
      existing.push(row);
    } else {
      bySystemId.set(systemId, [row]);
    }
  });
  return bySystemId;
}

function toPaymentReportDateText(value: Date | null): string {
  if (!value) return "";
  if (Number.isNaN(value.getTime())) return "";
  return value.toISOString().slice(0, 10);
}

export function computeSettlementRows(input: SettlementComputationInput): SettlementComputationResult {
  const warnings: string[] = [];
  const systemToCsg = buildSystemToCsgMap(input.csgSystemMappings);
  const projectAppById = buildProjectAppMap(input.projectApplications);
  const csgPortalLookup = buildCsgPortalLookup(input.csgPortalDatabaseRows ?? []);
  const installerRules = input.installerRules ?? [];
  const previousCarryforward = input.previousCarryforwardBySystemId ?? {};
  const overridesByRowId = input.manualOverridesByRowId ?? {};
  const paymentsReportBySystemId = buildPaymentsReportLookup(input.paymentsReportRows ?? []);
  const aiMailingModifiedFieldsByCsgId = input.aiMailingModifiedFieldsByCsgId ?? {};

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
      const csgPortalByCsgId = csgId ? csgPortalLookup.get(csgId) ?? null : null;
      const csgPortalSystemRow = csgPortalByCsgId;
      const appliedInstallerRule = findInstallerRuleForSystem(csgPortalSystemRow, installerRules);
      const paymentsForSystem = paymentsReportBySystemId.get(systemId) ?? [];
      const installerName = clean(csgPortalSystemRow?.installerName);
      const partnerCompanyName = clean(csgPortalSystemRow?.partnerCompanyName);
      const customerEmail = clean(csgPortalSystemRow?.customerEmail);
      const customerAltEmail = clean(csgPortalSystemRow?.customerAltEmail);
      const systemAddressFromPortal = clean(csgPortalSystemRow?.systemAddress);
      const systemCityFromPortal = clean(csgPortalSystemRow?.systemCity);
      const systemStateFromPortal = clean(csgPortalSystemRow?.systemState);
      const systemZipFromPortal = clean(csgPortalSystemRow?.systemZip);
      const paymentNotesFromPortal = clean(csgPortalSystemRow?.paymentNotes);

      const paidApplicationFee = safeMoney(ledger?.applicationFeePaidUpfront);
      const paidUtilityCollateral = safeMoney(ledger?.utilityCollateralPaidUpfront);
      const paidUtilityCollateralReimbursement = safeMoney(
        ledger?.utilityCollateralReimbursementToPartnerCompanyAmount
      );
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

        // Fallback: parse city/state/zip from the utility invoice system address when CSG portal doesn't provide them.
        // Typical format: "123 Main St, Chicago, IL 60601" or "123 Main St, Chicago, Illinois 60601-1234"
        let parsedUtilitySystemCity = "";
        let parsedUtilitySystemState = "";
        let parsedUtilitySystemZip = "";
        if (!systemCityFromPortal || !systemStateFromPortal || !systemZipFromPortal) {
          const utilAddr = clean(row.systemAddress);
          const addrMatch = utilAddr.match(/,\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
          if (addrMatch) {
            parsedUtilitySystemCity = clean(addrMatch[1]);
            parsedUtilitySystemState = clean(addrMatch[2]).toUpperCase();
            parsedUtilitySystemZip = clean(addrMatch[3]);
          }
        }

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

        const cityStateZipParts = splitCityStateZip(terms?.cityStateZip);
        const paymentMethod = clean(terms?.paymentMethod);
        const payeeName = clean(terms?.payeeName);
        const mailingAddress1 = clean(terms?.mailingAddress1);
        const mailingAddress2 = clean(terms?.mailingAddress2);
        const city = clean(terms?.city) || clean(cityStateZipParts.city);
        const state = clean(terms?.state) || clean(cityStateZipParts.state);
        const zip = clean(terms?.zip) || clean(cityStateZipParts.zip);
        const aiModifiedFields = csgId
          ? Array.from(
              new Set(
                (aiMailingModifiedFieldsByCsgId[csgId] ?? [])
                  .map((value) => clean(value))
                  .filter((value) => value.length > 0)
              )
            )
          : [];
        const aiMailingModified = aiModifiedFields.length > 0;

        const forceCollateralReimbursement =
          csgPortalSystemRow?.collateralReimbursedToPartner === true ||
          Boolean(appliedInstallerRule?.forceUtilityCollateralReimbursement);
        const effectiveUtilityCollateralPaidUpfront = forceCollateralReimbursement
          ? 0
          : paidUtilityCollateral;
        const forcedReimbursementAmount = forceCollateralReimbursement ? paidUtilityCollateral : 0;
        const reimbursementToPartnerCompanyAmount = roundMoney(
          paidUtilityCollateralReimbursement + forcedReimbursementAmount
        );

        const referralFeePercent = safeMoney(appliedInstallerRule?.referralFeePercent ?? 0);
        const referralFeeAmount = roundMoney((grossContractValue * referralFeePercent) / 100);

        const paymentNumberForMatch = row.paymentNumber ?? null;
        const paymentMatches =
          paymentNumberForMatch === null
            ? paymentsForSystem
            : paymentsForSystem.filter(
                (payment) =>
                  payment.paymentNumber !== null &&
                  Math.floor(payment.paymentNumber) === Math.floor(paymentNumberForMatch)
              );
        const appliedMatches = paymentMatches.filter((payment) => payment.appliesToContract === true);
        const reissueMatches = paymentMatches.filter((payment) => payment.appliesToContract === false);
        const otherTypeMatches = paymentMatches.filter((payment) => payment.appliesToContract === null);
        const mismatchedCsgCount =
          csgId && csgId.length > 0
            ? paymentMatches.filter((payment) => clean(payment.csgId) && clean(payment.csgId) !== csgId).length
            : 0;
        const appliedAmount = roundMoney(
          appliedMatches.reduce((sum, payment) => sum + safeMoney(payment.amount), 0)
        );
        const reissueAmount = roundMoney(
          reissueMatches.reduce((sum, payment) => sum + safeMoney(payment.amount), 0)
        );

        const sortedForLatest = [...paymentMatches].sort((left, right) => {
          const leftTime = left.paymentDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          const rightTime = right.paymentDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          if (leftTime !== rightTime) return rightTime - leftTime;
          return right.sourceRowNumber - left.sourceRowNumber;
        });
        const latestPayment = sortedForLatest[0] ?? null;
        const paymentReportLastType = clean(latestPayment?.paymentType);
        const paymentReportLastPaymentDate = toPaymentReportDateText(latestPayment?.paymentDate ?? null);

        let paymentReportCheckStatus = "No payment report record for this site.";
        if (paymentsForSystem.length > 0 && paymentMatches.length === 0 && paymentNumberForMatch !== null) {
          paymentReportCheckStatus = `Site has payments, but none for payment #${paymentNumberForMatch}.`;
        } else if (appliedMatches.length > 0) {
          paymentReportCheckStatus = "ABP SREC payment recorded for this contract payment.";
        } else if (reissueMatches.length > 0 && otherTypeMatches.length === 0) {
          paymentReportCheckStatus = "Only reissue record(s) found; excluded from contract payment count.";
        } else if (otherTypeMatches.length > 0) {
          paymentReportCheckStatus = "Unknown payment type(s) found; review payment report type field.";
        }

        const utilityOutstanding = Math.max(
          0,
          roundMoney(utilityHeldCollateral5PercentAmount - effectiveUtilityCollateralPaidUpfront)
        );
        const applicationOutstanding = Math.max(0, roundMoney(applicationFeeAmount - paidApplicationFee));
        const additionalOutstanding = Math.max(
          0,
          roundMoney(additionalCollateralAmount - paidAdditionalCollateral)
        );

        const inferredFirstPaymentPercent = inferFirstPaymentPercent(paymentPercent);
        const firstPaymentGrossBasis = roundMoney(
          grossContractValue * ((inferredFirstPaymentPercent ?? 100) / 100)
        );

        const firstFormulaNetAmount = roundMoney(
          firstPaymentGrossBasis -
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
        if (csgId && !csgPortalSystemRow) {
          confidenceFlags.push("No CSG portal row found for CSG ID.");
        }
        if (csgId && !systemAddressFromPortal) {
          confidenceFlags.push("System address missing in CSG portal data.");
        }
        if (paidUtilityCollateralReimbursement > 0 || forceCollateralReimbursement) {
          confidenceFlags.push(
            "Utility collateral reimbursement to partner detected; reimbursed amount is excluded from customer upfront credit."
          );
        }
        if (forceCollateralReimbursement && paidUtilityCollateral > 0) {
          confidenceFlags.push(
            "Installer rule (or CSG portal reimbursement flag) forced utility collateral upfront credit to $0."
          );
        }
        if (referralFeePercent > 0) {
          confidenceFlags.push(
            `Referral fee applied (${referralFeePercent.toFixed(2)}% of gross contract value).`
          );
        }
        if (otherTypeMatches.length > 0) {
          confidenceFlags.push(
            "Payment report has unknown type rows for this site/payment number. Only ABP SREC Payment counts; Reissue is excluded."
          );
        }
        if (reissueMatches.length > 0 && appliedMatches.length === 0) {
          confidenceFlags.push(
            "Payment report has reissue rows but no ABP SREC payment row for this site/payment number."
          );
        }
        if (mismatchedCsgCount > 0) {
          confidenceFlags.push(
            "Payment report contains CSG ID mismatch against mapping for this ABP ID; review System Id vs State Certification Number."
          );
        }

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
          utilityHeldCollateralPaidUpfront: effectiveUtilityCollateralPaidUpfront,
          collateralReimbursementToPartnerCompanyAmount: reimbursementToPartnerCompanyAmount,
          referralFeePercent,
          referralFeeAmount,
          applicationFeeAmount,
          applicationFeePaidUpfront: paidApplicationFee,
          additionalCollateralPercent,
          additionalCollateralAmount,
          additionalCollateralPaidUpfront: paidAdditionalCollateral,
          ccAuthorizationFormStatus: toCcAuthStatus(terms?.ccAuthorizationCompleted ?? null, terms?.ccCardAsteriskCount ?? null),
          ccAuthIncomplete5PercentAmount: ccIncompleteAmount,
          firstPaymentFormulaNetAmount: firstFormulaNetAmount,
          paymentMethod,
          payeeName,
          mailingAddress1,
          mailingAddress2,
          city,
          state,
          zip,
          aiMailingModified,
          aiMailingModifiedFields: aiModifiedFields.join(" | "),
          installerName,
          partnerCompanyName,
          customerEmail,
          customerAltEmail,
          systemAddress: systemAddressFromPortal || clean(row.systemAddress),
          systemCity: systemCityFromPortal || parsedUtilitySystemCity,
          systemState: systemStateFromPortal || parsedUtilitySystemState,
          systemZip: systemZipFromPortal || parsedUtilitySystemZip,
          paymentNotes: paymentNotesFromPortal,
          appliedInstallerRuleName: clean(appliedInstallerRule?.name),
          paymentReportCheckStatus,
          paymentReportMatchedPaymentNumber: paymentNumberForMatch,
          paymentReportAppliedCount: appliedMatches.length,
          paymentReportAppliedAmount: appliedAmount,
          paymentReportReissueCount: reissueMatches.length,
          paymentReportReissueAmount: reissueAmount,
          paymentReportOtherTypeCount: otherTypeMatches.length,
          paymentReportLastType,
          paymentReportLastPaymentDate,
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
    "Collateral Reimbursement to the Partner Company",
    "Referral Fee %",
    "Referral Fee Amount",
    "Application Fee Amount",
    "Application Fee Paid Upfront",
    "Additional Collateral %",
    "Additional Collateral Amount",
    "Additional Collateral Paid Upfront",
    "CC Authorization Form Status",
    "CC Auth Incomplete 5% Amount",
    "First Payment Formula Net Amount",
    "Payment Method",
    "Payee Name",
    "Mailing Address 1",
    "Mailing Address 2",
    "City",
    "State",
    "Zip",
    "AI Mailing Modified",
    "AI Mailing Fields Modified",
    "Installer Name",
    "Partner Company Name",
    "Customer Email",
    "Customer Alt Email",
    "System Address",
    "System City",
    "System State",
    "System Zip",
    "Payment Notes",
    "Applied Installer Rule",
    "Payment Report Check Status",
    "Payment Report Payment Number",
    "Payment Report Applied Count",
    "Payment Report Applied Amount",
    "Payment Report Reissue Count",
    "Payment Report Reissue Amount",
    "Payment Report Other Type Count",
    "Payment Report Last Type",
    "Payment Report Last Payment Date",
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
      row.collateralReimbursementToPartnerCompanyAmount.toFixed(2),
      row.referralFeePercent,
      row.referralFeeAmount.toFixed(2),
      row.applicationFeeAmount.toFixed(2),
      row.applicationFeePaidUpfront.toFixed(2),
      row.additionalCollateralPercent,
      row.additionalCollateralAmount.toFixed(2),
      row.additionalCollateralPaidUpfront.toFixed(2),
      row.ccAuthorizationFormStatus,
      row.ccAuthIncomplete5PercentAmount.toFixed(2),
      row.firstPaymentFormulaNetAmount.toFixed(2),
      row.paymentMethod,
      row.payeeName,
      row.mailingAddress1,
      row.mailingAddress2,
      row.city,
      row.state,
      row.zip,
      row.aiMailingModified ? "Yes" : "No",
      row.aiMailingModifiedFields,
      row.installerName,
      row.partnerCompanyName,
      row.customerEmail,
      row.customerAltEmail,
      row.systemAddress,
      row.systemCity,
      row.systemState,
      row.systemZip,
      row.paymentNotes,
      row.appliedInstallerRuleName,
      row.paymentReportCheckStatus,
      row.paymentReportMatchedPaymentNumber ?? "",
      row.paymentReportAppliedCount,
      row.paymentReportAppliedAmount.toFixed(2),
      row.paymentReportReissueCount,
      row.paymentReportReissueAmount.toFixed(2),
      row.paymentReportOtherTypeCount,
      row.paymentReportLastType,
      row.paymentReportLastPaymentDate,
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
