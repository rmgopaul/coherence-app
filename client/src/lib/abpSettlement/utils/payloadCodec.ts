import { clean } from "@/lib/helpers";
import {
  type ContractTerms,
  type CsgPortalDatabaseRow,
  type CsgSystemIdMappingRow,
  type InstallerSettlementRule,
  type InvoiceNumberMapRow,
  type PayeeMailingUpdateRow,
  type PaymentsReportRow,
  type ProjectApplicationLiteRow,
  type QuickBooksInvoice,
  type UtilityInvoiceRow,
} from "@/lib/abpSettlement";
import {
  normalizeCsgPortalDatabaseRows,
  normalizeInstallerRules,
  normalizeInvoiceNumberMapRows,
  normalizePayeeUpdateRows,
  normalizePaymentsReportRows,
  normalizeProjectApplicationRows,
} from "./normalization";
import {
  serializePayeeUpdateRows,
  serializePaymentsReportRows,
  serializeProjectApplications,
  serializeQuickBooksInvoices,
} from "./rowConversion";
import { splitCityStateZip } from "./parseUtils";
import {
  type ContractScanResult,
  type InvoiceMapHeaderSelectionState,
  type RunInputs,
} from "./types";

export type LinkedCsvDatasetPayload = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  csvText: string;
  rows?: Array<Record<string, string>>;
  metadata?: Record<string, string>;
};

export type PersistedUploadStatePayload = {
  version: number;
  savedAt: string;
  runInputs: RunInputs;
  activeScanJobId: string | null;
  utilityRows: UtilityInvoiceRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
  projectApplications: Array<{
    applicationId: string;
    part1SubmissionDate: string | null;
    part1OriginalSubmissionDate: string | null;
    inverterSizeKwAcPart1: number | null;
  }>;
  quickBooksInvoices: Array<Omit<QuickBooksInvoice, "date"> & { date: string | null }>;
  paymentsReportRows: Array<Omit<PaymentsReportRow, "paymentDate"> & { paymentDate: string | null }>;
  payeeUpdateRows: Array<Omit<PayeeMailingUpdateRow, "requestDate"> & { requestDate: string | null }>;
  invoiceNumberMapRows: InvoiceNumberMapRow[];
  csgPortalDatabaseRows: CsgPortalDatabaseRow[];
  installerRules: InstallerSettlementRule[];
  invoiceMapHeaderSelection?: InvoiceMapHeaderSelectionState;
};

export function buildLinkedCsvDatasetPayload(input: {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  metadata?: Record<string, string>;
}): string {
  const normalizedHeaders = input.headers.map((header) => clean(header)).filter(Boolean);
  const normalizedRows = input.rows.map((row) => {
    const normalized: Record<string, string> = {};
    Object.entries(row).forEach(([key, value]) => {
      normalized[key] = value === null || value === undefined ? "" : String(value);
    });
    return normalized;
  });

  const csvEscape = (value: string): string => {
    if (/[",\n]/.test(value)) {
      return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
  };

  const csvText = [
    normalizedHeaders.map(csvEscape).join(","),
    ...normalizedRows.map((row) => normalizedHeaders.map((header) => csvEscape(clean(row[header]))).join(",")),
  ].join("\n");

  const payload: LinkedCsvDatasetPayload = {
    fileName: clean(input.fileName) || "linked-upload.csv",
    uploadedAt: clean(input.uploadedAt) || new Date().toISOString(),
    headers: normalizedHeaders,
    csvText,
    rows: normalizedRows.length <= 2000 ? normalizedRows : undefined,
    metadata: input.metadata,
  };
  return JSON.stringify(payload);
}

function parseCsvMatrix(csvInput: string): string[][] {
  const source = csvInput.replace(/^\uFEFF/, "");
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
      if (character === "\r" && source[index + 1] === "\n") index += 1;
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

function parseRowsFromCsv(csvText: string, headers: string[]): Array<Record<string, string>> {
  const matrix = parseCsvMatrix(csvText);
  const firstRow = matrix[0] ?? [];
  const headerRow =
    firstRow.length === headers.length &&
    firstRow.every((entry, index) => clean(entry) === headers[index])
      ? firstRow
      : headers;

  const bodyRows = matrix.length > 0 && headerRow === firstRow ? matrix.slice(1) : matrix;
  return bodyRows.map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = clean(cells[index]);
    });
    return record;
  });
}

export function parseLinkedCsvDatasetPayload(value: string): LinkedCsvDatasetPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<LinkedCsvDatasetPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.headers)) return null;

    const normalizedRows = Array.isArray(parsed.rows) && parsed.rows.length > 0
      ? parsed.rows.map((row) => {
          const normalized: Record<string, string> = {};
          if (row && typeof row === "object") {
            Object.entries(row).forEach(([key, cell]) => {
              normalized[key] = cell === null || cell === undefined ? "" : String(cell);
            });
          }
          return normalized;
        })
      : parseRowsFromCsv(clean(parsed.csvText), parsed.headers.map((header) => clean(header)).filter(Boolean));

    const metadata =
      parsed.metadata && typeof parsed.metadata === "object"
        ? Object.fromEntries(
            Object.entries(parsed.metadata).map(([key, value]) => [clean(key), clean(value)])
          )
        : undefined;

    return {
      fileName: clean(parsed.fileName) || "linked-upload.csv",
      uploadedAt: clean(parsed.uploadedAt) || new Date().toISOString(),
      headers: parsed.headers.map((header) => clean(header)).filter(Boolean),
      csvText: clean(parsed.csvText),
      rows: normalizedRows,
      metadata,
    };
  } catch {
    return null;
  }
}

export function buildPersistedUploadStatePayload(
  input: {
    runInputs: RunInputs;
    activeScanJobId: string | null;
    utilityRows: UtilityInvoiceRow[];
    csgSystemMappings: CsgSystemIdMappingRow[];
    projectApplications: ProjectApplicationLiteRow[];
    quickBooksByInvoice: Map<string, QuickBooksInvoice>;
    paymentsReportRows: PaymentsReportRow[];
    payeeUpdateRows: PayeeMailingUpdateRow[];
    invoiceNumberMapRows: InvoiceNumberMapRow[];
    csgPortalDatabaseRows: CsgPortalDatabaseRow[];
    installerRules: InstallerSettlementRule[];
    invoiceMapHeaderSelection: InvoiceMapHeaderSelectionState;
  },
  defaultInstallerRules: InstallerSettlementRule[]
): PersistedUploadStatePayload {
  return {
    version: 3,
    savedAt: new Date().toISOString(),
    runInputs: input.runInputs,
    activeScanJobId: clean(input.activeScanJobId) || null,
    utilityRows: input.utilityRows,
    csgSystemMappings: input.csgSystemMappings,
    projectApplications: serializeProjectApplications(input.projectApplications),
    quickBooksInvoices: serializeQuickBooksInvoices(input.quickBooksByInvoice),
    paymentsReportRows: serializePaymentsReportRows(input.paymentsReportRows),
    payeeUpdateRows: serializePayeeUpdateRows(input.payeeUpdateRows),
    invoiceNumberMapRows: normalizeInvoiceNumberMapRows(input.invoiceNumberMapRows),
    csgPortalDatabaseRows: normalizeCsgPortalDatabaseRows(input.csgPortalDatabaseRows),
    installerRules: normalizeInstallerRules(input.installerRules, defaultInstallerRules),
    invoiceMapHeaderSelection: {
      csgIdHeader: clean(input.invoiceMapHeaderSelection.csgIdHeader) || null,
      invoiceNumberHeader: clean(input.invoiceMapHeaderSelection.invoiceNumberHeader) || null,
    },
  };
}

export function parsePersistedUploadStatePayload(
  value: string,
  defaultInstallerRules: InstallerSettlementRule[]
): PersistedUploadStatePayload | null {
  try {
    const parsed = JSON.parse(value) as PersistedUploadStatePayload;
    if (!parsed || typeof parsed.version !== "number" || parsed.version < 1 || parsed.version > 3) return null;
    const runInputsRaw = parsed.runInputs && typeof parsed.runInputs === "object" ? parsed.runInputs : null;
    if (!runInputsRaw) return null;

    const runInputs: RunInputs = {
      utilityInvoiceFiles: Array.isArray(runInputsRaw.utilityInvoiceFiles)
        ? runInputsRaw.utilityInvoiceFiles.map((value) => clean(value)).filter(Boolean)
        : [],
      csgSystemMappingFile: clean(runInputsRaw.csgSystemMappingFile) || null,
      quickBooksFile: clean(runInputsRaw.quickBooksFile) || null,
      paymentsReportFile: clean(runInputsRaw.paymentsReportFile) || null,
      projectApplicationFile: clean(runInputsRaw.projectApplicationFile) || null,
      portalInvoiceMapFile: clean(runInputsRaw.portalInvoiceMapFile) || null,
      csgPortalDatabaseFile: clean(runInputsRaw.csgPortalDatabaseFile) || null,
      payeeUpdateFile: clean(runInputsRaw.payeeUpdateFile) || null,
    };

    return {
      version: parsed.version,
      savedAt: clean(parsed.savedAt) || new Date().toISOString(),
      runInputs,
      activeScanJobId: clean(parsed.activeScanJobId) || null,
      utilityRows: Array.isArray(parsed.utilityRows) ? parsed.utilityRows : [],
      csgSystemMappings: Array.isArray(parsed.csgSystemMappings) ? parsed.csgSystemMappings : [],
      projectApplications: normalizeProjectApplicationRows(
        Array.isArray(parsed.projectApplications) ? parsed.projectApplications : []
      ),
      quickBooksInvoices: Array.isArray(parsed.quickBooksInvoices) ? parsed.quickBooksInvoices : [],
      paymentsReportRows: normalizePaymentsReportRows(
        Array.isArray(parsed.paymentsReportRows) ? parsed.paymentsReportRows : []
      ),
      payeeUpdateRows: normalizePayeeUpdateRows(Array.isArray(parsed.payeeUpdateRows) ? parsed.payeeUpdateRows : []),
      invoiceNumberMapRows: normalizeInvoiceNumberMapRows(
        Array.isArray(parsed.invoiceNumberMapRows) ? parsed.invoiceNumberMapRows : []
      ),
      csgPortalDatabaseRows: normalizeCsgPortalDatabaseRows(
        Array.isArray(parsed.csgPortalDatabaseRows) ? parsed.csgPortalDatabaseRows : []
      ),
      installerRules: normalizeInstallerRules(
        Array.isArray(parsed.installerRules) ? parsed.installerRules : defaultInstallerRules,
        defaultInstallerRules
      ),
      invoiceMapHeaderSelection: {
        csgIdHeader: clean(parsed.invoiceMapHeaderSelection?.csgIdHeader) || null,
        invoiceNumberHeader: clean(parsed.invoiceMapHeaderSelection?.invoiceNumberHeader) || null,
      },
    };
  } catch {
    return null;
  }
}

export function toContractTermsFromScan(rows: ContractScanResult[]): Map<string, ContractTerms> {
  const map = new Map<string, ContractTerms>();
  rows.forEach((row) => {
    if (!row.csgId) return;
    // Include rows even if they had scan errors — they may still have partial
    // data (payee name, mailing address from portal) that is useful for AI
    // cleaning and settlement. Previously errored rows were silently dropped,
    // causing "Contract Terms Loaded" to show far fewer than expected.
    if (map.has(row.csgId)) return; // keep first occurrence per CSG ID
    const cityStateZipParts = splitCityStateZip(row.cityStateZip);
    map.set(row.csgId, {
      csgId: row.csgId,
      fileName: row.fileName ?? "",
      vendorFeePercent: row.vendorFeePercent,
      additionalCollateralPercent: row.additionalCollateralPercent,
      ccAuthorizationCompleted: row.ccAuthorizationCompleted,
      ccCardAsteriskCount: row.ccCardAsteriskCount,
      recQuantity: row.recQuantity,
      recPrice: row.recPrice,
      paymentMethod: row.paymentMethod,
      payeeName: row.payeeName,
      mailingAddress1: row.mailingAddress1,
      mailingAddress2: row.mailingAddress2,
      cityStateZip: row.cityStateZip,
      city: row.city ?? cityStateZipParts.city,
      state: row.state ?? cityStateZipParts.state,
      zip: row.zip ?? cityStateZipParts.zip,
    });
  });
  return map;
}
