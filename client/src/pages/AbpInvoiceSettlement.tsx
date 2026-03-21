import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  applyPayeeMailingUpdatesToContractTerms,
  buildLatestPayeeMailingUpdates,
  buildInvoiceNumberToSystemIdMap,
  buildQuickBooksPaidUpfrontLedger,
  buildSettlementCsv,
  computeSettlementRows,
  detectInvoiceNumberMapHeaders,
  parseCsgSystemMapping,
  parseCsgPortalDatabase,
  parseInvoiceNumberMap,
  parsePaymentsReport,
  parsePayeeMailingUpdateRequests,
  parseProjectApplications,
  parseQuickBooksDetailedReport,
  parseTabularFile,
  parseUtilityInvoiceFile,
  type ContractTerms,
  type CsgPortalDatabaseRow,
  type InstallerSettlementRule,
  type ManualOverride,
  type PaymentClassification,
  type PaymentComputationRow,
  type PayeeMailingUpdateRow,
  type PaymentsReportRow,
  type ProjectApplicationLiteRow,
  type QuickBooksInvoice,
  type UtilityInvoiceRow,
  type CsgSystemIdMappingRow,
  type InvoiceNumberMapRow,
  type ParsedTabularData,
} from "@/lib/abpSettlement";
import {
  ArrowLeft,
  Download,
  Loader2,
  Plus,
  Play,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type RunInputs = {
  utilityInvoiceFiles: string[];
  csgSystemMappingFile: string | null;
  quickBooksFile: string | null;
  paymentsReportFile: string | null;
  projectApplicationFile: string | null;
  portalInvoiceMapFile: string | null;
  csgPortalDatabaseFile: string | null;
  payeeUpdateFile: string | null;
};

type InvoiceMapHeaderSelectionState = {
  csgIdHeader: string | null;
  invoiceNumberHeader: string | null;
};

type ContractFetchResult = {
  csgId: string;
  systemPageUrl: string;
  pdfUrl: string | null;
  pdfFileName: string | null;
  error: string | null;
};

type ContractScanResult = {
  csgId: string;
  fileName: string;
  ccAuthorizationCompleted: boolean | null;
  ccCardAsteriskCount: number | null;
  additionalFivePercentSelected: boolean | null;
  additionalCollateralPercent: number | null;
  vendorFeePercent: number | null;
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
  error: string | null;
};

type PersistedProjectApplicationRow = {
  applicationId: string;
  part1SubmissionDate: string | null;
  part1OriginalSubmissionDate: string | null;
  inverterSizeKwAcPart1: number | null;
};

type PersistedQuickBooksInvoice = Omit<QuickBooksInvoice, "date"> & {
  date: string | null;
};

type PersistedPaymentsReportRow = Omit<PaymentsReportRow, "paymentDate"> & {
  paymentDate: string | null;
};

type PersistedPayeeUpdateRow = Omit<PayeeMailingUpdateRow, "requestDate"> & {
  requestDate: string | null;
};

type SavedRunPayload = {
  version: 1;
  monthKey: string;
  label: string | null;
  savedAt: string;
  runInputs: RunInputs;
  utilityRows: UtilityInvoiceRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
  projectApplications: PersistedProjectApplicationRow[];
  quickBooksInvoices: PersistedQuickBooksInvoice[];
  paymentsReportRows: PersistedPaymentsReportRow[];
  payeeUpdateRows: PersistedPayeeUpdateRow[];
  invoiceNumberMapRows: InvoiceNumberMapRow[];
  invoiceMapHeaderSelection?: InvoiceMapHeaderSelectionState;
  csgPortalDatabaseRows: CsgPortalDatabaseRow[];
  installerRules: InstallerSettlementRule[];
  contractTerms: ContractTerms[];
  manualOverridesByRowId: Record<string, ManualOverride>;
  previousCarryforwardBySystemId: Record<string, number>;
  computedRows: PaymentComputationRow[];
  warnings: string[];
  carryforwardBySystemId: Record<string, number>;
};

type RunSummary = {
  runId: string;
  monthKey: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount: number | null;
};

type PersistedUploadStatePayload = {
  version: number;
  savedAt: string;
  runInputs: RunInputs;
  activeScanJobId: string | null;
  utilityRows: UtilityInvoiceRow[];
  csgSystemMappings: CsgSystemIdMappingRow[];
  projectApplications: PersistedProjectApplicationRow[];
  quickBooksInvoices: PersistedQuickBooksInvoice[];
  paymentsReportRows: PersistedPaymentsReportRow[];
  payeeUpdateRows: PersistedPayeeUpdateRow[];
  invoiceNumberMapRows: InvoiceNumberMapRow[];
  csgPortalDatabaseRows: CsgPortalDatabaseRow[];
  installerRules: InstallerSettlementRule[];
  invoiceMapHeaderSelection?: InvoiceMapHeaderSelectionState;
};

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const ABP_UPLOAD_STATE_DATASET_KEY = "abp_settlement_upload_state_v1";
const ABP_SHARED_SOLAR_REC_DATASET_KEYS = {
  utilityRows: "abpUtilityInvoiceRows",
  csgSystemMapping: "abpCsgSystemMapping",
  quickBooksRows: "abpQuickBooksRows",
  projectApplications: "abpProjectApplicationRows",
  portalInvoiceMap: "abpPortalInvoiceMapRows",
  csgPortalDatabase: "abpCsgPortalDatabaseRows",
} as const;

const YAMM_PAYMENT_EMAIL_HEADERS = [
  "Recipient",
  "Recipient Alt",
  "system_owner_payment_address_name",
  "This Payment",
  "Payment Method",
  "system_owner_payment_address",
  "system_owner_payment_address2",
  "system_owner_payment_city",
  "system_owner_payment_state",
  "system_owner_payment_zip",
  "ID",
  "Inverter_Size_kW_AC_Part_2",
  "System_Name",
  "system_address",
  "system_city",
  "system_zip",
  "SRECs",
  "REC Price",
  "Total Payment",
  "CSG Fee %",
  "Fee Amount",
  "Additional Fee",
  "ADfee",
  "Additional Percent",
  "Additional",
  "CC Auth AdCo",
  "CC Auth AdCo Amount",
  "Five",
  "Five if Paid",
  "Payment Notes",
  "Payment Number",
  "Contract ID",
  "Payment Send By Date",
  "Update Request Deadline",
] as const;

const DEFAULT_INSTALLER_RULES: InstallerSettlementRule[] = [
  {
    id: "rule-adt-solar-collateral",
    name: "ADT Solar Collateral Reimbursement",
    active: true,
    matchField: "installerName",
    matchValue: "ADT Solar",
    forceUtilityCollateralReimbursement: true,
    referralFeePercent: 0,
    notes: "Treat utility collateral paid upfront as reimbursed to partner for ADT Solar systems.",
  },
  {
    id: "rule-ion-solar-referral",
    name: "ION Solar Referral Fee",
    active: true,
    matchField: "installerName",
    matchValue: "ION Solar",
    forceUtilityCollateralReimbursement: false,
    referralFeePercent: 5,
    notes: "Apply a 5% referral fee on gross contract value.",
  },
];

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$0.00";
  return CURRENCY_FORMATTER.format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return `${value.toFixed(2)}%`;
}

function formatDateTime(iso: string | null | undefined): string {
  const parsed = clean(iso);
  if (!parsed) return "";
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return parsed;
  return date.toLocaleString("en-US");
}

function formatDuration(valueMs: number | null | undefined): string {
  if (valueMs === null || valueMs === undefined || !Number.isFinite(valueMs) || valueMs < 0) {
    return "-";
  }

  const totalSeconds = Math.floor(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function toYammCsv(rows: Array<Record<string, string>>): string {
  const escape = (value: string): string => {
    if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
    return value;
  };
  const lines = [
    YAMM_PAYMENT_EMAIL_HEADERS.map((header) => escape(header)).join(","),
    ...rows.map((row) =>
      YAMM_PAYMENT_EMAIL_HEADERS.map((header) => escape(clean(row[header]))).join(",")
    ),
  ];
  return lines.join("\n");
}

function buildUpcomingTuesdayLabel(date = new Date()): string {
  const local = new Date(date);
  const day = local.getDay();
  const daysUntilTuesday = (2 - day + 7) % 7 || 7;
  local.setDate(local.getDate() + daysUntilTuesday);
  return local.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function splitSystemAddressLocation(systemAddress: string): { city: string; zip: string } {
  const raw = clean(systemAddress);
  if (!raw) return { city: "", zip: "" };
  const match = raw.match(/,\s*([^,]+),\s*[A-Za-z]{2}\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (!match) return { city: "", zip: "" };
  return {
    city: clean(match[1]),
    zip: clean(match[2]),
  };
}

function buildMonthKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseCsgIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;\n\t]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function parseNumberInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  if (!match) return { city: normalized || null, state: null, zip: null };

  return {
    city: clean(match[1]) || null,
    state: clean(match[2]).toUpperCase() || null,
    zip: clean(match[3]) || null,
  };
}

type LinkedCsvDatasetPayload = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  csvText: string;
  rows?: Array<Record<string, string>>;
  metadata?: Record<string, string>;
};

function buildLinkedCsvDatasetPayload(input: {
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

function parseLinkedCsvDatasetPayload(value: string): LinkedCsvDatasetPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<LinkedCsvDatasetPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.headers)) return null;

    const parseCsvMatrix = (csvInput: string): string[][] => {
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
    };

    const parseRowsFromCsv = (csvText: string, headers: string[]): Array<Record<string, string>> => {
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
    };

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

function toNumericCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const normalized = clean(value);
  return normalized;
}

function parseNumericCell(value: unknown): number | null {
  const normalized = clean(value).replace(/,/g, "").replace(/[$%]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanText(value: unknown): boolean | null {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "1" ||
    normalized.includes("reimburs") ||
    normalized.includes("returned")
  ) {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "n" || normalized === "0") {
    return false;
  }
  return null;
}

function normalizeAlias(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getRowValueByAliases(row: Record<string, string>, aliases: string[]): string {
  if (!row || typeof row !== "object") return "";
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const target = normalizeAlias(alias);
    const found = entries.find(([key]) => normalizeAlias(key) === target);
    if (!found) continue;
    const value = clean(found[1]);
    if (value) return value;
  }
  return "";
}

function utilityRowsToLinkedRows(rows: UtilityInvoiceRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    rowId: row.rowId,
    sourceFile: row.sourceFile,
    sourceSheet: row.sourceSheet,
    contractId: row.contractId ?? "",
    utilityName: row.utilityName ?? "",
    systemId: row.systemId,
    paymentNumber: toNumericCell(row.paymentNumber),
    recQuantity: toNumericCell(row.recQuantity),
    recPrice: toNumericCell(row.recPrice),
    invoiceAmount: toNumericCell(row.invoiceAmount),
    systemAddress: row.systemAddress,
  }));
}

function linkedRowsToUtilityRows(rows: Array<Record<string, string>>, fallbackFileName: string): UtilityInvoiceRow[] {
  return rows
    .map((row, index) => {
      const systemId = getRowValueByAliases(row, ["systemId", "System ID", "state_certification_number"]);
      if (!systemId) return null;
      const sourceFile = getRowValueByAliases(row, ["sourceFile", "Source File"]) || fallbackFileName;
      const rowId = getRowValueByAliases(row, ["rowId", "Row ID"]) || `${sourceFile}:${index + 2}:${systemId}`;
      return {
        rowId,
        sourceFile,
        sourceSheet: getRowValueByAliases(row, ["sourceSheet", "Source Sheet"]) || "linked",
        contractId: getRowValueByAliases(row, ["contractId", "Contract ID"]) || null,
        utilityName: getRowValueByAliases(row, ["utilityName", "Utility"]) || null,
        systemId,
        paymentNumber: parseNumericCell(getRowValueByAliases(row, ["paymentNumber", "Payment Number"])),
        recQuantity: parseNumericCell(getRowValueByAliases(row, ["recQuantity", "Total RECS", "REC Quantity"])),
        recPrice: parseNumericCell(getRowValueByAliases(row, ["recPrice", "REC Price"])),
        invoiceAmount: parseNumericCell(
          getRowValueByAliases(row, ["invoiceAmount", "Invoice Amount", "Invoice Amount ($)"])
        ),
        systemAddress: getRowValueByAliases(row, ["systemAddress", "System Address"]),
      } satisfies UtilityInvoiceRow;
    })
    .filter((row): row is UtilityInvoiceRow => Boolean(row));
}

function quickBooksInvoicesToLinkedRows(
  invoices: Map<string, QuickBooksInvoice>
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  Array.from(invoices.values()).forEach((invoice) => {
    const invoiceDate = invoice.date ? invoice.date.toISOString().slice(0, 10) : "";
    const lineItems = invoice.lineItems.length > 0 ? invoice.lineItems : [{ lineOrder: null, description: "", productService: "", amount: null }];
    lineItems.forEach((lineItem, index) => {
      rows.push({
        invoiceNumber: invoice.invoiceNumber,
        date: invoiceDate,
        customer: invoice.customer,
        amount: toNumericCell(invoice.amount),
        openBalance: toNumericCell(invoice.openBalance),
        cashReceived: toNumericCell(invoice.cashReceived),
        paymentStatus: invoice.paymentStatus,
        voided: invoice.voided,
        lineOrder: toNumericCell(lineItem.lineOrder ?? index + 1),
        description: lineItem.description,
        productService: lineItem.productService,
        lineAmount: toNumericCell(lineItem.amount),
      });
    });
  });

  return rows;
}

function linkedRowsToQuickBooksInvoices(rows: Array<Record<string, string>>): Map<string, QuickBooksInvoice> {
  const grouped = new Map<string, QuickBooksInvoice>();

  rows.forEach((row) => {
    const invoiceNumber = getRowValueByAliases(row, ["invoiceNumber", "Num", "Invoice Number", "Invoice #"]);
    if (!invoiceNumber) return;

    const existing =
      grouped.get(invoiceNumber) ??
      ({
        invoiceNumber,
        amount: parseNumericCell(getRowValueByAliases(row, ["amount", "Amount", "Total"])),
        openBalance: parseNumericCell(getRowValueByAliases(row, ["openBalance", "Open balance", "Open Balance"])),
        cashReceived: parseNumericCell(getRowValueByAliases(row, ["cashReceived", "Cash Received"])),
        paymentStatus: getRowValueByAliases(row, ["paymentStatus", "Payment status", "Payment Status"]),
        voided: getRowValueByAliases(row, ["voided", "Voided"]),
        customer: getRowValueByAliases(row, ["customer", "Customer", "Customer full name", "Customer Full Name"]) || "Unknown",
        date: getRowValueByAliases(row, ["date", "Date"])
          ? new Date(getRowValueByAliases(row, ["date", "Date"]))
          : null,
        lineItems: [],
      } satisfies QuickBooksInvoice);

    if (existing.amount === null) {
      existing.amount = parseNumericCell(getRowValueByAliases(row, ["amount", "Amount", "Total"]));
    }
    if (existing.openBalance === null) {
      existing.openBalance = parseNumericCell(getRowValueByAliases(row, ["openBalance", "Open balance", "Open Balance"]));
    }
    if (existing.cashReceived === null) {
      existing.cashReceived = parseNumericCell(getRowValueByAliases(row, ["cashReceived", "Cash Received"]));
    }
    if (!existing.paymentStatus) {
      existing.paymentStatus = getRowValueByAliases(row, ["paymentStatus", "Payment status", "Payment Status"]);
    }
    if (!existing.voided) {
      existing.voided = getRowValueByAliases(row, ["voided", "Voided"]);
    }
    if (!existing.customer) {
      existing.customer =
        getRowValueByAliases(row, ["customer", "Customer", "Customer full name", "Customer Full Name"]) ||
        "Unknown";
    }
    const rowDate = getRowValueByAliases(row, ["date", "Date"]);
    if (!existing.date && rowDate) {
      const parsedDate = new Date(rowDate);
      existing.date = Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
    }

    const description = getRowValueByAliases(row, ["description", "Product/service description", "Description"]);
    const productService = getRowValueByAliases(row, ["productService", "Product/Service", "Product Service"]);
    const lineAmount = parseNumericCell(
      getRowValueByAliases(row, ["lineAmount", "Product/service amount line", "Line Amount"])
    );
    if (description || productService || lineAmount !== null) {
      existing.lineItems.push({
        lineOrder: parseNumericCell(getRowValueByAliases(row, ["lineOrder", "Line order", "Line Order"])),
        description,
        productService,
        amount: lineAmount,
      });
    }

    grouped.set(invoiceNumber, existing);
  });

  grouped.forEach((invoice) => {
    invoice.lineItems.sort((left, right) => {
      const leftOrder = left.lineOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.lineOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.description.localeCompare(right.description);
    });
  });

  return grouped;
}

function normalizeInstallerRules(rules: InstallerSettlementRule[] | null | undefined): InstallerSettlementRule[] {
  const source = Array.isArray(rules) ? rules : DEFAULT_INSTALLER_RULES;
  return source.map((rule, index) => ({
    id: clean(rule.id) || `installer-rule-${index + 1}`,
    name: clean(rule.name) || `Installer Rule ${index + 1}`,
    active: rule.active !== false,
    matchField: rule.matchField === "partnerCompanyName" ? "partnerCompanyName" : "installerName",
    matchValue: clean(rule.matchValue),
    forceUtilityCollateralReimbursement: Boolean(rule.forceUtilityCollateralReimbursement),
    referralFeePercent: parseNumericCell(rule.referralFeePercent) ?? 0,
    notes: clean(rule.notes),
  }));
}

function normalizeCsgPortalDatabaseRows(rows: unknown[]): CsgPortalDatabaseRow[] {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const csgId = clean(source.csgId);
      if (!csgId) return null;

      return {
        systemId: clean(source.systemId),
        csgId,
        installerName: clean(source.installerName) || null,
        partnerCompanyName: clean(source.partnerCompanyName) || null,
        customerEmail: clean(source.customerEmail) || null,
        customerAltEmail: clean(source.customerAltEmail) || null,
        systemAddress: clean(source.systemAddress) || null,
        paymentNotes: clean(source.paymentNotes) || null,
        collateralReimbursedToPartner: parseBooleanText(source.collateralReimbursedToPartner),
      } satisfies CsgPortalDatabaseRow;
    })
    .filter((row): row is CsgPortalDatabaseRow => Boolean(row));
}

function normalizeProjectApplicationRows(rows: PersistedProjectApplicationRow[]): PersistedProjectApplicationRow[] {
  return rows
    .map((row) => ({
      applicationId: clean(row.applicationId),
      part1SubmissionDate: clean(row.part1SubmissionDate) || null,
      part1OriginalSubmissionDate: clean(row.part1OriginalSubmissionDate) || null,
      inverterSizeKwAcPart1:
        typeof row.inverterSizeKwAcPart1 === "number" && Number.isFinite(row.inverterSizeKwAcPart1)
          ? row.inverterSizeKwAcPart1
          : null,
    }))
    .filter((row) => row.applicationId.length > 0);
}

function normalizeInvoiceNumberMapRows(rows: unknown[]): InvoiceNumberMapRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const csgId = clean(source.csgId);
      const invoiceNumber = clean(source.invoiceNumber);
      if (!csgId || !invoiceNumber) return null;
      return {
        csgId,
        invoiceNumber,
      } satisfies InvoiceNumberMapRow;
    })
    .filter((row): row is InvoiceNumberMapRow => Boolean(row));
}

function serializeProjectApplications(rows: ProjectApplicationLiteRow[]): PersistedProjectApplicationRow[] {
  return rows.map((row) => ({
    applicationId: row.applicationId,
    part1SubmissionDate: row.part1SubmissionDate ? row.part1SubmissionDate.toISOString() : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? row.part1OriginalSubmissionDate.toISOString()
      : null,
    inverterSizeKwAcPart1: row.inverterSizeKwAcPart1,
  }));
}

function deserializeProjectApplications(rows: PersistedProjectApplicationRow[]): ProjectApplicationLiteRow[] {
  return rows.map((row) => ({
    applicationId: clean(row.applicationId),
    part1SubmissionDate: row.part1SubmissionDate ? new Date(row.part1SubmissionDate) : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? new Date(row.part1OriginalSubmissionDate)
      : null,
    inverterSizeKwAcPart1:
      typeof row.inverterSizeKwAcPart1 === "number" && Number.isFinite(row.inverterSizeKwAcPart1)
        ? row.inverterSizeKwAcPart1
        : null,
  }));
}

function serializeQuickBooksInvoices(invoices: Map<string, QuickBooksInvoice>): PersistedQuickBooksInvoice[] {
  return Array.from(invoices.values()).map((invoice) => ({
    ...invoice,
    date: invoice.date ? invoice.date.toISOString() : null,
  }));
}

function deserializeQuickBooksInvoices(invoices: PersistedQuickBooksInvoice[]): Map<string, QuickBooksInvoice> {
  const map = new Map<string, QuickBooksInvoice>();
  invoices.forEach((invoice) => {
    const key = clean(invoice.invoiceNumber);
    if (!key) return;
    map.set(key, {
      ...invoice,
      date: invoice.date ? new Date(invoice.date) : null,
    });
  });
  return map;
}

function normalizePaymentsReportRows(rows: unknown[]): PersistedPaymentsReportRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const rowId = clean(source.rowId);
      if (!rowId) return null;
      const sourceRowNumber = parseNumericCell(source.sourceRowNumber);
      return {
        rowId,
        sourceRowNumber:
          sourceRowNumber !== null && Number.isFinite(sourceRowNumber)
            ? Math.max(1, Math.floor(sourceRowNumber))
            : 1,
        systemId: clean(source.systemId),
        csgId: clean(source.csgId),
        paymentNumber: parseNumericCell(source.paymentNumber),
        paymentType: clean(source.paymentType),
        paymentDate: clean(source.paymentDate) || null,
        amount: parseNumericCell(source.amount),
        appliesToContract:
          source.appliesToContract === true || source.appliesToContract === "true"
            ? true
            : source.appliesToContract === false || source.appliesToContract === "false"
              ? false
              : null,
      } satisfies PersistedPaymentsReportRow;
    })
    .filter((row): row is PersistedPaymentsReportRow => Boolean(row));
}

function serializePaymentsReportRows(rows: PaymentsReportRow[]): PersistedPaymentsReportRow[] {
  return rows.map((row) => ({
    ...row,
    paymentDate: row.paymentDate ? row.paymentDate.toISOString() : null,
  }));
}

function deserializePaymentsReportRows(rows: PersistedPaymentsReportRow[]): PaymentsReportRow[] {
  return rows.map((row) => ({
    ...row,
    paymentDate: row.paymentDate ? new Date(row.paymentDate) : null,
  }));
}

function normalizePayeeUpdateRows(rows: unknown[]): PersistedPayeeUpdateRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const rowId = clean(source.rowId);
      if (!rowId) return null;
      const sourceRowNumber = parseNumericCell(source.sourceRowNumber);
      return {
        rowId,
        sourceRowNumber:
          sourceRowNumber !== null && Number.isFinite(sourceRowNumber)
            ? Math.max(1, Math.floor(sourceRowNumber))
            : 1,
        requestDate: clean(source.requestDate) || null,
        requestDateRaw: clean(source.requestDateRaw) || null,
        responderEmail: clean(source.responderEmail).toLowerCase() || null,
        enteredCsgId: clean(source.enteredCsgId) || null,
        paymentMethod: clean(source.paymentMethod) || null,
        payeeName: clean(source.payeeName) || null,
        mailingAddress1: clean(source.mailingAddress1) || null,
        mailingAddress2: clean(source.mailingAddress2) || null,
        city: clean(source.city) || null,
        state: clean(source.state).toUpperCase() || null,
        zip: clean(source.zip) || null,
        cityStateZip: clean(source.cityStateZip) || null,
      } satisfies PersistedPayeeUpdateRow;
    })
    .filter((row): row is PersistedPayeeUpdateRow => Boolean(row));
}

function serializePayeeUpdateRows(rows: PayeeMailingUpdateRow[]): PersistedPayeeUpdateRow[] {
  return rows.map((row) => ({
    ...row,
    requestDate: row.requestDate ? row.requestDate.toISOString() : null,
  }));
}

function deserializePayeeUpdateRows(rows: PersistedPayeeUpdateRow[]): PayeeMailingUpdateRow[] {
  return rows.map((row) => ({
    ...row,
    requestDate: row.requestDate ? new Date(row.requestDate) : null,
  }));
}

function buildPersistedUploadStatePayload(input: {
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
}): PersistedUploadStatePayload {
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
    installerRules: normalizeInstallerRules(input.installerRules),
    invoiceMapHeaderSelection: {
      csgIdHeader: clean(input.invoiceMapHeaderSelection.csgIdHeader) || null,
      invoiceNumberHeader: clean(input.invoiceMapHeaderSelection.invoiceNumberHeader) || null,
    },
  };
}

function parsePersistedUploadStatePayload(value: string): PersistedUploadStatePayload | null {
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
        Array.isArray(parsed.installerRules) ? parsed.installerRules : DEFAULT_INSTALLER_RULES
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

function toContractTermsFromScan(rows: ContractScanResult[]): Map<string, ContractTerms> {
  const map = new Map<string, ContractTerms>();
  rows.forEach((row) => {
    if (!row.csgId || row.error) return;
    const cityStateZipParts = splitCityStateZip(row.cityStateZip);
    map.set(row.csgId, {
      csgId: row.csgId,
      fileName: row.fileName,
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

function isClassification(value: string): value is PaymentClassification {
  return (
    value === "first_full_upfront" ||
    value === "first_partial" ||
    value === "quarterly" ||
    value === "unknown"
  );
}

export default function AbpInvoiceSettlement() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [monthKey, setMonthKey] = useState(buildMonthKey());
  const [runLabel, setRunLabel] = useState("");
  const [emailSendByDateText, setEmailSendByDateText] = useState(() => buildUpcomingTuesdayLabel());
  const [emailUpdateDeadlineText, setEmailUpdateDeadlineText] = useState(
    () => `1pm ${buildUpcomingTuesdayLabel()}`
  );
  const [runInputs, setRunInputs] = useState<RunInputs>({
    utilityInvoiceFiles: [],
    csgSystemMappingFile: null,
    quickBooksFile: null,
    paymentsReportFile: null,
    projectApplicationFile: null,
    portalInvoiceMapFile: null,
    csgPortalDatabaseFile: null,
    payeeUpdateFile: null,
  });

  const [utilityRows, setUtilityRows] = useState<UtilityInvoiceRow[]>([]);
  const [csgSystemMappings, setCsgSystemMappings] = useState<CsgSystemIdMappingRow[]>([]);
  const [projectApplications, setProjectApplications] = useState<ProjectApplicationLiteRow[]>([]);
  const [quickBooksByInvoice, setQuickBooksByInvoice] = useState<Map<string, QuickBooksInvoice>>(new Map());
  const [paymentsReportRows, setPaymentsReportRows] = useState<PaymentsReportRow[]>([]);
  const [csgPortalDatabaseRows, setCsgPortalDatabaseRows] = useState<CsgPortalDatabaseRow[]>([]);
  const [payeeUpdateRows, setPayeeUpdateRows] = useState<PayeeMailingUpdateRow[]>([]);
  const [installerRules, setInstallerRules] = useState<InstallerSettlementRule[]>(DEFAULT_INSTALLER_RULES);

  const [invoiceMapParsed, setInvoiceMapParsed] = useState<ParsedTabularData | null>(null);
  const [savedInvoiceNumberMapRows, setSavedInvoiceNumberMapRows] = useState<InvoiceNumberMapRow[]>([]);
  const [invoiceMapHeaderSelection, setInvoiceMapHeaderSelection] = useState<{
    csgIdHeader: string | null;
    invoiceNumberHeader: string | null;
  }>({ csgIdHeader: null, invoiceNumberHeader: null });

  const [manualOverridesByRowId, setManualOverridesByRowId] = useState<Record<string, ManualOverride>>({});
  const [previousCarryforwardBySystemId, setPreviousCarryforwardBySystemId] =
    useState<Record<string, number>>({});

  const [contractFetchRows, setContractFetchRows] = useState<ContractFetchResult[]>([]);
  const [contractScanRows, setContractScanRows] = useState<ContractScanResult[]>([]);
  const [contractTermsByCsgId, setContractTermsByCsgId] = useState<Map<string, ContractTerms>>(new Map());

  const [manualScanIdInput, setManualScanIdInput] = useState("");
  const [activeScanJobId, setActiveScanJobId] = useState<string | null>(null);
  const [scanClockNow, setScanClockNow] = useState<number>(() => Date.now());

  const [portalEmail, setPortalEmail] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [portalBaseUrl, setPortalBaseUrl] = useState("https://portal2.carbonsolutionsgroup.com");

  const [isUploadingUtility, setIsUploadingUtility] = useState(false);
  const [isUploadingMapping, setIsUploadingMapping] = useState(false);
  const [isUploadingQuickBooks, setIsUploadingQuickBooks] = useState(false);
  const [isUploadingPaymentsReport, setIsUploadingPaymentsReport] = useState(false);
  const [isUploadingProjectApps, setIsUploadingProjectApps] = useState(false);
  const [isUploadingInvoiceMap, setIsUploadingInvoiceMap] = useState(false);
  const [isUploadingCsgPortalDatabase, setIsUploadingCsgPortalDatabase] = useState(false);
  const [isUploadingPayeeUpdates, setIsUploadingPayeeUpdates] = useState(false);
  const [isSavingUploadsNow, setIsSavingUploadsNow] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);
  const [uploadsHydrated, setUploadsHydrated] = useState(false);
  const [uploadPersistenceNotice, setUploadPersistenceNotice] = useState<string | null>(null);

  const csgPortalStatusQuery = trpc.csgPortal.status.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const savedRunsQuery = trpc.abpSettlement.listRuns.useQuery(
    { limit: 100 },
    {
      enabled: !!user,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  const startScanJobMutation = trpc.abpSettlement.startContractScanJob.useMutation();
  const savePortalCredentialsMutation = trpc.csgPortal.saveCredentials.useMutation();
  const testPortalConnectionMutation = trpc.csgPortal.testConnection.useMutation();
  const cleanMailingDataMutation = trpc.abpSettlement.cleanMailingData.useMutation();
  const saveRunMutation = trpc.abpSettlement.saveRun.useMutation();
  const getUploadStateMutation = trpc.solarRecDashboard.getDataset.useMutation();
  const saveUploadStateMutation = trpc.solarRecDashboard.saveDataset.useMutation();
  const getUploadStateMutationRef = useRef(getUploadStateMutation);
  getUploadStateMutationRef.current = getUploadStateMutation;
  const saveUploadStateMutationRef = useRef(saveUploadStateMutation);
  saveUploadStateMutationRef.current = saveUploadStateMutation;
  const lastPersistedUploadPayloadRef = useRef<string>("");
  const lastPersistedSharedPayloadsRef = useRef<Record<string, string>>({});

  const scanJobQuery = trpc.abpSettlement.getJobStatus.useQuery(
    { jobId: activeScanJobId ?? "__none__" },
    {
      enabled: Boolean(activeScanJobId),
      refetchInterval: activeScanJobId ? 1200 : false,
      retry: 1,
      refetchOnWindowFocus: false,
    }
  );

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, setLocation, user]);

  useEffect(() => {
    if (!activeScanJobId) return;
    setScanClockNow(Date.now());
    const timerId = window.setInterval(() => {
      setScanClockNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [activeScanJobId]);

  useEffect(() => {
    if (!csgPortalStatusQuery.data) return;
    if (csgPortalStatusQuery.data.email) setPortalEmail(csgPortalStatusQuery.data.email);
    if (csgPortalStatusQuery.data.baseUrl) setPortalBaseUrl(csgPortalStatusQuery.data.baseUrl);
  }, [csgPortalStatusQuery.data]);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;

    void (async () => {
      let hydratedRunInputs: RunInputs = {
        utilityInvoiceFiles: [],
        csgSystemMappingFile: null,
        quickBooksFile: null,
        paymentsReportFile: null,
        projectApplicationFile: null,
        portalInvoiceMapFile: null,
        csgPortalDatabaseFile: null,
        payeeUpdateFile: null,
      };
      let hydratedUtilityRows: UtilityInvoiceRow[] = [];
      let hydratedCsgSystemMappings: CsgSystemIdMappingRow[] = [];
      let hydratedProjectApplications: ProjectApplicationLiteRow[] = [];
      let hydratedQuickBooksByInvoice = new Map<string, QuickBooksInvoice>();
      let hydratedPaymentsReportRows: PaymentsReportRow[] = [];
      let hydratedPayeeUpdateRows: PayeeMailingUpdateRow[] = [];
      let hydratedInvoiceNumberMapRows: InvoiceNumberMapRow[] = [];
      let hydratedInvoiceMapParsed: ParsedTabularData | null = null;
      let hydratedInvoiceMapHeaderSelection: InvoiceMapHeaderSelectionState = {
        csgIdHeader: null,
        invoiceNumberHeader: null,
      };
      let hydratedActiveScanJobId: string | null = null;
      let hydratedCsgPortalDatabaseRows: CsgPortalDatabaseRow[] = [];
      let hydratedInstallerRules = normalizeInstallerRules(DEFAULT_INSTALLER_RULES);

      try {
        const stored = await getUploadStateMutationRef.current.mutateAsync({
          key: ABP_UPLOAD_STATE_DATASET_KEY,
        });

        if (cancelled) return;

        if (stored?.payload) {
          const parsed = parsePersistedUploadStatePayload(stored.payload);
          if (parsed) {
            hydratedRunInputs = parsed.runInputs;
            hydratedUtilityRows = parsed.utilityRows ?? [];
            hydratedCsgSystemMappings = parsed.csgSystemMappings ?? [];
            hydratedProjectApplications = deserializeProjectApplications(parsed.projectApplications ?? []);
            hydratedQuickBooksByInvoice = deserializeQuickBooksInvoices(parsed.quickBooksInvoices ?? []);
            hydratedPaymentsReportRows = deserializePaymentsReportRows(parsed.paymentsReportRows ?? []);
            hydratedPayeeUpdateRows = deserializePayeeUpdateRows(parsed.payeeUpdateRows ?? []);
            hydratedInvoiceNumberMapRows = normalizeInvoiceNumberMapRows(parsed.invoiceNumberMapRows ?? []);
            hydratedInvoiceMapHeaderSelection = parsed.invoiceMapHeaderSelection ?? hydratedInvoiceMapHeaderSelection;
            hydratedActiveScanJobId = parsed.activeScanJobId ?? null;
            hydratedCsgPortalDatabaseRows = normalizeCsgPortalDatabaseRows(parsed.csgPortalDatabaseRows ?? []);
            hydratedInstallerRules = normalizeInstallerRules(parsed.installerRules);
            lastPersistedUploadPayloadRef.current = stored.payload;
          }
        }

        const sharedEntries = Object.entries(ABP_SHARED_SOLAR_REC_DATASET_KEYS) as Array<
          [keyof typeof ABP_SHARED_SOLAR_REC_DATASET_KEYS, string]
        >;

        const sharedResults = await Promise.all(
          sharedEntries.map(async ([slot, datasetKey]) => {
            try {
              const result = await getUploadStateMutationRef.current.mutateAsync({ key: datasetKey });
              return [slot, result?.payload ?? null] as const;
            } catch {
              return [slot, null] as const;
            }
          })
        );

        for (const [slot, payload] of sharedResults) {
          if (!payload) continue;
          lastPersistedSharedPayloadsRef.current[ABP_SHARED_SOLAR_REC_DATASET_KEYS[slot]] = payload;
          const parsed = parseLinkedCsvDatasetPayload(payload);
          const linkedRows = parsed?.rows ?? [];
          if (!parsed || linkedRows.length === 0) continue;

          if (slot === "utilityRows" && hydratedUtilityRows.length === 0) {
            hydratedUtilityRows = linkedRowsToUtilityRows(linkedRows, parsed.fileName);
            hydratedRunInputs.utilityInvoiceFiles =
              hydratedUtilityRows.length > 0 ? [parsed.fileName] : hydratedRunInputs.utilityInvoiceFiles;
          }

          if (slot === "csgSystemMapping" && hydratedCsgSystemMappings.length === 0) {
            hydratedCsgSystemMappings = linkedRows
              .map((row) => ({
                csgId: getRowValueByAliases(row, ["csgId", "CSG ID", "ID", "id"]),
                systemId: getRowValueByAliases(row, ["systemId", "System ID", "state_certification_number"]),
              }))
              .filter((row) => row.csgId && row.systemId);
            if (hydratedCsgSystemMappings.length > 0) {
              hydratedRunInputs.csgSystemMappingFile = parsed.fileName;
            }
          }

          if (slot === "quickBooksRows" && hydratedQuickBooksByInvoice.size === 0) {
            hydratedQuickBooksByInvoice = linkedRowsToQuickBooksInvoices(linkedRows);
            if (hydratedQuickBooksByInvoice.size > 0) {
              hydratedRunInputs.quickBooksFile = parsed.fileName;
            }
          }

          if (slot === "projectApplications" && hydratedProjectApplications.length === 0) {
            hydratedProjectApplications = linkedRows
              .map((row) => ({
                applicationId: getRowValueByAliases(row, ["applicationId", "Application_ID"]),
                part1SubmissionDate: getRowValueByAliases(row, ["part1SubmissionDate", "Part_1_Submission_Date"])
                  ? new Date(getRowValueByAliases(row, ["part1SubmissionDate", "Part_1_Submission_Date"]))
                  : null,
                part1OriginalSubmissionDate: getRowValueByAliases(
                  row,
                  ["part1OriginalSubmissionDate", "Part_1_Original_Submission_Date"]
                )
                  ? new Date(
                      getRowValueByAliases(
                        row,
                        ["part1OriginalSubmissionDate", "Part_1_Original_Submission_Date"]
                      )
                    )
                  : null,
                inverterSizeKwAcPart1: parseNumericCell(
                  getRowValueByAliases(row, ["inverterSizeKwAcPart1", "Inverter_Size_kW_AC_Part_1"])
                ),
              }))
              .filter((row) => row.applicationId);
            if (hydratedProjectApplications.length > 0) {
              hydratedRunInputs.projectApplicationFile = parsed.fileName;
            }
          }

          if (slot === "portalInvoiceMap") {
            if (!hydratedInvoiceMapParsed) {
              hydratedInvoiceMapParsed = {
                headers: parsed.headers,
                rows: linkedRows,
                matrix: [],
              };
            }

            const metadataCsgHeader = clean(parsed.metadata?.csgIdHeader) || null;
            const metadataInvoiceHeader = clean(parsed.metadata?.invoiceNumberHeader) || null;
            if (!hydratedInvoiceMapHeaderSelection.csgIdHeader && metadataCsgHeader) {
              hydratedInvoiceMapHeaderSelection = {
                ...hydratedInvoiceMapHeaderSelection,
                csgIdHeader: metadataCsgHeader,
              };
            }
            if (!hydratedInvoiceMapHeaderSelection.invoiceNumberHeader && metadataInvoiceHeader) {
              hydratedInvoiceMapHeaderSelection = {
                ...hydratedInvoiceMapHeaderSelection,
                invoiceNumberHeader: metadataInvoiceHeader,
              };
            }

            if (hydratedInvoiceNumberMapRows.length === 0) {
              const parsedInvoiceMap = hydratedInvoiceMapParsed;
              if (!parsedInvoiceMap) continue;
              try {
                hydratedInvoiceNumberMapRows = parseInvoiceNumberMap(
                  parsedInvoiceMap,
                  hydratedInvoiceMapHeaderSelection
                );
              } catch {
                hydratedInvoiceNumberMapRows = normalizeInvoiceNumberMapRows(
                  linkedRows.map((row) => ({
                    csgId: getRowValueByAliases(row, ["csgId", "CSG ID", "ID", "id"]),
                    invoiceNumber: getRowValueByAliases(row, ["invoiceNumber", "Invoice Number", "Num"]),
                  }))
                );
              }
            }
            if (hydratedInvoiceNumberMapRows.length > 0) {
              hydratedRunInputs.portalInvoiceMapFile = parsed.fileName;
            }
          }

          if (slot === "csgPortalDatabase" && hydratedCsgPortalDatabaseRows.length === 0) {
            hydratedCsgPortalDatabaseRows = normalizeCsgPortalDatabaseRows(
              linkedRows.map((row) => ({
                systemId: getRowValueByAliases(
                  row,
                  ["systemId", "System ID", "state_certification_number", "Application_ID"]
                ),
                csgId: getRowValueByAliases(row, ["csgId", "CSG ID", "ID", "id", "system_id", "System_ID"]),
                installerName: getRowValueByAliases(row, ["installerName", "Installer", "Installer Company"]),
                partnerCompanyName: getRowValueByAliases(row, [
                  "partnerCompanyName",
                  "Partner Company",
                  "Developer",
                ]),
                customerEmail: getRowValueByAliases(row, ["customerEmail", "Customer Email", "Email"]),
                customerAltEmail: getRowValueByAliases(row, [
                  "customerAltEmail",
                  "Customer Alt Email",
                  "Alternate Email",
                  "Alt Email",
                  "Secondary Email",
                ]),
                systemAddress: getRowValueByAliases(row, [
                  "systemAddress",
                  "System Address",
                  "Site Address",
                  "Address",
                ]),
                paymentNotes: getRowValueByAliases(row, [
                  "paymentNotes",
                  "Payment Notes",
                  "Payment Note",
                  "Notes",
                ]),
                collateralReimbursedToPartner: parseBooleanText(
                  getRowValueByAliases(row, ["collateralReimbursedToPartner", "Collateral Reimbursed"])
                ),
              }))
            );
            if (hydratedCsgPortalDatabaseRows.length > 0) {
              hydratedRunInputs.csgPortalDatabaseFile = parsed.fileName;
            }
          }
        }

        if (cancelled) return;
        setRunInputs(hydratedRunInputs);
        setUtilityRows(hydratedUtilityRows);
        setCsgSystemMappings(hydratedCsgSystemMappings);
        setProjectApplications(hydratedProjectApplications);
        setQuickBooksByInvoice(hydratedQuickBooksByInvoice);
        setPaymentsReportRows(hydratedPaymentsReportRows);
        setPayeeUpdateRows(hydratedPayeeUpdateRows);
        setCsgPortalDatabaseRows(hydratedCsgPortalDatabaseRows);
        setInstallerRules(hydratedInstallerRules);
        setInvoiceMapParsed(hydratedInvoiceMapParsed);
        setInvoiceMapHeaderSelection(hydratedInvoiceMapHeaderSelection);
        setSavedInvoiceNumberMapRows(hydratedInvoiceNumberMapRows);
        setActiveScanJobId(hydratedActiveScanJobId);
      } catch {
        if (!cancelled) {
          setUploadPersistenceNotice("Could not restore previously uploaded files.");
        }
      } finally {
        if (!cancelled) {
          setUploadsHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  useEffect(() => {
    const snapshot = scanJobQuery.data;
    if (!snapshot || !activeScanJobId) return;

    const rows = snapshot.result?.rows ?? [];
    const fetchedRows: ContractFetchResult[] = rows.map((row) => ({
      csgId: row.csgId,
      systemPageUrl: row.systemPageUrl,
      pdfUrl: row.pdfUrl,
      pdfFileName: row.pdfFileName,
      error: row.error,
    }));
    const scannedRows: ContractScanResult[] = rows.map((row) => {
      const cityStateZipParts = splitCityStateZip(row.scan?.cityStateZip ?? null);
      return {
        csgId: row.csgId,
        fileName: row.scan?.fileName ?? row.pdfFileName ?? `contract-${row.csgId}.pdf`,
        ccAuthorizationCompleted: row.scan?.ccAuthorizationCompleted ?? null,
        ccCardAsteriskCount: row.scan?.ccCardAsteriskCount ?? null,
        additionalFivePercentSelected: row.scan?.additionalFivePercentSelected ?? null,
        additionalCollateralPercent: row.scan?.additionalCollateralPercent ?? null,
        vendorFeePercent: row.scan?.vendorFeePercent ?? null,
        recQuantity: row.scan?.recQuantity ?? null,
        recPrice: row.scan?.recPrice ?? null,
        paymentMethod: row.scan?.paymentMethod ?? null,
        payeeName: row.scan?.payeeName ?? null,
        mailingAddress1: row.scan?.mailingAddress1 ?? null,
        mailingAddress2: row.scan?.mailingAddress2 ?? null,
        cityStateZip: row.scan?.cityStateZip ?? null,
        city: cityStateZipParts.city,
        state: cityStateZipParts.state,
        zip: cityStateZipParts.zip,
        error: row.error,
      };
    });

    // Stream rows as each CSG ID finishes.
    setContractFetchRows(fetchedRows);
    setContractScanRows(scannedRows);
    setContractTermsByCsgId(toContractTermsFromScan(scannedRows));

    if (snapshot.status === "completed") {
      setActiveScanJobId(null);
      toast.success(
        `Contract scan completed. ${snapshot.result?.successCount ?? 0} success, ${snapshot.result?.failureCount ?? 0} failed.`
      );
      return;
    }

    if (snapshot.status === "failed") {
      setActiveScanJobId(null);
      toast.error(`Contract scan failed: ${snapshot.error ?? "Unknown job error."}`);
    }
  }, [scanJobQuery.data, activeScanJobId]);

  const invoiceMapHeaderDetection = useMemo(() => {
    if (!invoiceMapParsed) return { csgIdHeader: null, invoiceNumberHeader: null };
    return detectInvoiceNumberMapHeaders(invoiceMapParsed.headers);
  }, [invoiceMapParsed]);

  useEffect(() => {
    if (!invoiceMapParsed) return;
    setInvoiceMapHeaderSelection((current) => ({
      csgIdHeader: current.csgIdHeader ?? invoiceMapHeaderDetection.csgIdHeader,
      invoiceNumberHeader: current.invoiceNumberHeader ?? invoiceMapHeaderDetection.invoiceNumberHeader,
    }));
  }, [invoiceMapHeaderDetection, invoiceMapParsed]);

  const invoiceNumberMapRowsFromParsed = useMemo(() => {
    if (!invoiceMapParsed) return [] as InvoiceNumberMapRow[];
    try {
      return parseInvoiceNumberMap(invoiceMapParsed, {
        csgIdHeader: invoiceMapHeaderSelection.csgIdHeader,
        invoiceNumberHeader: invoiceMapHeaderSelection.invoiceNumberHeader,
      });
    } catch {
      return [];
    }
  }, [invoiceMapHeaderSelection.csgIdHeader, invoiceMapHeaderSelection.invoiceNumberHeader, invoiceMapParsed]);

  const invoiceNumberMapRows = useMemo(() => {
    if (invoiceMapParsed) return invoiceNumberMapRowsFromParsed;
    return savedInvoiceNumberMapRows;
  }, [invoiceMapParsed, invoiceNumberMapRowsFromParsed, savedInvoiceNumberMapRows]);

  const buildSharedUploadPayloadByKey = useCallback((): Record<string, string> => {
    const resolveUploadedAtForKey = (datasetKey: string): string => {
      const previousPayload = lastPersistedSharedPayloadsRef.current[datasetKey];
      if (!previousPayload) return new Date().toISOString();
      const previousParsed = parseLinkedCsvDatasetPayload(previousPayload);
      return previousParsed?.uploadedAt ?? new Date().toISOString();
    };

    return {
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.utilityRows]:
        utilityRows.length > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.utilityRows),
              fileName:
                runInputs.utilityInvoiceFiles[0] ??
                (runInputs.utilityInvoiceFiles.length > 1
                  ? `${runInputs.utilityInvoiceFiles.length} utility files`
                  : "ABP Utility Invoices"),
              headers: [
                "rowId",
                "sourceFile",
                "sourceSheet",
                "contractId",
                "utilityName",
                "systemId",
                "paymentNumber",
                "recQuantity",
                "recPrice",
                "invoiceAmount",
                "systemAddress",
              ],
              rows: utilityRowsToLinkedRows(utilityRows),
            })
          : "",
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.csgSystemMapping]:
        csgSystemMappings.length > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.csgSystemMapping),
              fileName: runInputs.csgSystemMappingFile ?? "ABP CSG-System Mapping",
              headers: ["csgId", "systemId"],
              rows: csgSystemMappings.map((row) => ({ csgId: row.csgId, systemId: row.systemId })),
            })
          : "",
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.quickBooksRows]:
        quickBooksByInvoice.size > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.quickBooksRows),
              fileName: runInputs.quickBooksFile ?? "ABP QuickBooks Detail",
              headers: [
                "invoiceNumber",
                "date",
                "customer",
                "amount",
                "openBalance",
                "cashReceived",
                "paymentStatus",
                "voided",
                "lineOrder",
                "description",
                "productService",
                "lineAmount",
              ],
              rows: quickBooksInvoicesToLinkedRows(quickBooksByInvoice),
            })
          : "",
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.projectApplications]:
        projectApplications.length > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.projectApplications),
              fileName: runInputs.projectApplicationFile ?? "ABP ProjectApplication",
              headers: [
                "applicationId",
                "part1SubmissionDate",
                "part1OriginalSubmissionDate",
                "inverterSizeKwAcPart1",
              ],
              rows: projectApplications.map((row) => ({
                applicationId: row.applicationId,
                part1SubmissionDate: row.part1SubmissionDate?.toISOString() ?? "",
                part1OriginalSubmissionDate: row.part1OriginalSubmissionDate?.toISOString() ?? "",
                inverterSizeKwAcPart1: toNumericCell(row.inverterSizeKwAcPart1),
              })),
            })
          : "",
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.portalInvoiceMap]:
        (invoiceMapParsed?.rows?.length ?? 0) > 0 || invoiceNumberMapRows.length > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.portalInvoiceMap),
              fileName: runInputs.portalInvoiceMapFile ?? "ABP Portal Invoice Map",
              headers: invoiceMapParsed?.headers?.length ? invoiceMapParsed.headers : ["csgId", "invoiceNumber"],
              rows:
                invoiceMapParsed?.rows?.length
                  ? invoiceMapParsed.rows
                  : invoiceNumberMapRows.map((row) => ({ csgId: row.csgId, invoiceNumber: row.invoiceNumber })),
              metadata: {
                csgIdHeader: invoiceMapHeaderSelection.csgIdHeader ?? "",
                invoiceNumberHeader: invoiceMapHeaderSelection.invoiceNumberHeader ?? "",
              },
            })
          : "",
      [ABP_SHARED_SOLAR_REC_DATASET_KEYS.csgPortalDatabase]:
        csgPortalDatabaseRows.length > 0
          ? buildLinkedCsvDatasetPayload({
              uploadedAt: resolveUploadedAtForKey(ABP_SHARED_SOLAR_REC_DATASET_KEYS.csgPortalDatabase),
              fileName: runInputs.csgPortalDatabaseFile ?? "ABP CSG Portal Database",
              headers: [
                "systemId",
                "csgId",
                "installerName",
                "partnerCompanyName",
                "customerEmail",
                "customerAltEmail",
                "systemAddress",
                "paymentNotes",
                "collateralReimbursedToPartner",
              ],
              rows: csgPortalDatabaseRows.map((row) => ({
                systemId: row.systemId,
                csgId: row.csgId,
                installerName: row.installerName ?? "",
                partnerCompanyName: row.partnerCompanyName ?? "",
                customerEmail: row.customerEmail ?? "",
                customerAltEmail: row.customerAltEmail ?? "",
                systemAddress: row.systemAddress ?? "",
                paymentNotes: row.paymentNotes ?? "",
                collateralReimbursedToPartner:
                  row.collateralReimbursedToPartner === null ? "" : String(row.collateralReimbursedToPartner),
              })),
            })
          : "",
    };
  }, [
    csgPortalDatabaseRows,
    csgSystemMappings,
    invoiceMapHeaderSelection.csgIdHeader,
    invoiceMapHeaderSelection.invoiceNumberHeader,
    invoiceMapParsed,
    invoiceNumberMapRows,
    projectApplications,
    quickBooksByInvoice,
    runInputs.csgPortalDatabaseFile,
    runInputs.csgSystemMappingFile,
    runInputs.portalInvoiceMapFile,
    runInputs.projectApplicationFile,
    runInputs.quickBooksFile,
    runInputs.utilityInvoiceFiles,
    utilityRows,
  ]);

  const handleSaveUploadsNow = useCallback(async () => {
    if (authLoading || !user || !uploadsHydrated) {
      toast.error("Please wait for uploads to finish restoring before saving.");
      return;
    }

    setIsSavingUploadsNow(true);
    try {
      const uploadStatePayload = JSON.stringify(
        buildPersistedUploadStatePayload({
          runInputs,
          activeScanJobId,
          utilityRows,
          csgSystemMappings,
          projectApplications,
          quickBooksByInvoice,
          paymentsReportRows,
          payeeUpdateRows,
          invoiceNumberMapRows,
          csgPortalDatabaseRows,
          installerRules,
          invoiceMapHeaderSelection,
        })
      );

      await saveUploadStateMutationRef.current.mutateAsync({
        key: ABP_UPLOAD_STATE_DATASET_KEY,
        payload: uploadStatePayload,
      });
      lastPersistedUploadPayloadRef.current = uploadStatePayload;

      const sharedPayloadByKey = buildSharedUploadPayloadByKey();
      for (const [datasetKey, payload] of Object.entries(sharedPayloadByKey)) {
        await saveUploadStateMutationRef.current.mutateAsync({
          key: datasetKey,
          payload,
        });
        lastPersistedSharedPayloadsRef.current[datasetKey] = payload;
      }

      setUploadPersistenceNotice(null);
      toast.success("Uploads saved.");
    } catch (error) {
      const message = toErrorMessage(error);
      setUploadPersistenceNotice(`Could not persist uploaded files right now: ${message}`);
      toast.error(`Could not save uploads right now: ${message}`);
    } finally {
      setIsSavingUploadsNow(false);
    }
  }, [
    activeScanJobId,
    authLoading,
    buildSharedUploadPayloadByKey,
    csgPortalDatabaseRows,
    csgSystemMappings,
    installerRules,
    invoiceMapHeaderSelection,
    invoiceNumberMapRows,
    paymentsReportRows,
    payeeUpdateRows,
    projectApplications,
    quickBooksByInvoice,
    runInputs,
    uploadsHydrated,
    user,
    utilityRows,
  ]);

  useEffect(() => {
    if (!invoiceMapParsed) return;
    setSavedInvoiceNumberMapRows(invoiceNumberMapRowsFromParsed);
  }, [invoiceMapParsed, invoiceNumberMapRowsFromParsed]);

  useEffect(() => {
    if (authLoading || !user || !uploadsHydrated) return;

    const payload = JSON.stringify(
      buildPersistedUploadStatePayload({
        runInputs,
        activeScanJobId,
        utilityRows,
        csgSystemMappings,
        projectApplications,
        quickBooksByInvoice,
        paymentsReportRows,
        payeeUpdateRows,
        invoiceNumberMapRows,
        csgPortalDatabaseRows,
        installerRules,
        invoiceMapHeaderSelection,
      })
    );

    if (payload === lastPersistedUploadPayloadRef.current) return;

    let shouldUpdateUi = true;
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          await saveUploadStateMutationRef.current.mutateAsync({
            key: ABP_UPLOAD_STATE_DATASET_KEY,
            payload,
          });
          lastPersistedUploadPayloadRef.current = payload;
          if (shouldUpdateUi) {
            setUploadPersistenceNotice(null);
          }
        } catch {
          if (shouldUpdateUi) {
            setUploadPersistenceNotice("Could not persist uploaded files right now.");
          }
        }
      })();
    }, 450);

    return () => {
      shouldUpdateUi = false;
      window.clearTimeout(timeout);
    };
  }, [
    activeScanJobId,
    authLoading,
    user,
    uploadsHydrated,
    runInputs,
    utilityRows,
    csgSystemMappings,
    projectApplications,
    quickBooksByInvoice,
    paymentsReportRows,
    payeeUpdateRows,
    invoiceNumberMapRows,
    csgPortalDatabaseRows,
    installerRules,
    invoiceMapHeaderSelection.csgIdHeader,
    invoiceMapHeaderSelection.invoiceNumberHeader,
  ]);

  useEffect(() => {
    if (authLoading || !user || !uploadsHydrated) return;

    const nextPayloadByKey = buildSharedUploadPayloadByKey();

    const changedEntries = Object.entries(nextPayloadByKey).filter(
      ([key, payload]) => lastPersistedSharedPayloadsRef.current[key] !== payload
    );
    if (changedEntries.length === 0) return;

    let shouldUpdateUi = true;
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          for (const [datasetKey, payload] of changedEntries) {
            await saveUploadStateMutationRef.current.mutateAsync({
              key: datasetKey,
              payload,
            });
            lastPersistedSharedPayloadsRef.current[datasetKey] = payload;
          }
          if (shouldUpdateUi) {
            setUploadPersistenceNotice(null);
          }
        } catch {
          if (shouldUpdateUi) {
            setUploadPersistenceNotice("Could not sync linked uploads to Solar REC dashboard.");
          }
        }
      })();
    }, 600);

    return () => {
      shouldUpdateUi = false;
      window.clearTimeout(timeout);
    };
  }, [
    authLoading,
    buildSharedUploadPayloadByKey,
    user,
    uploadsHydrated,
  ]);

  const knownSystemIds = useMemo(() => {
    const set = new Set<string>();
    utilityRows.forEach((row) => set.add(row.systemId));
    csgSystemMappings.forEach((row) => {
      if (row.systemId) set.add(row.systemId);
    });
    return set;
  }, [utilityRows, csgSystemMappings]);

  const invoiceNumberToSystemId = useMemo(() => {
    if (!invoiceNumberMapRows.length) return undefined;
    return buildInvoiceNumberToSystemIdMap({
      invoiceNumberMapRows,
      csgSystemMappings,
    });
  }, [invoiceNumberMapRows, csgSystemMappings]);

  const quickBooksLedger = useMemo(() => {
    if (quickBooksByInvoice.size === 0) {
      return {
        bySystemId: new Map(),
        unmatchedLines: [],
      };
    }

    return buildQuickBooksPaidUpfrontLedger({
      quickBooksByInvoice,
      knownSystemIds,
      invoiceNumberToSystemId,
    });
  }, [quickBooksByInvoice, knownSystemIds, invoiceNumberToSystemId]);

  const csgBySystemId = useMemo(() => {
    const map = new Map<string, string>();
    csgSystemMappings.forEach((row) => {
      if (!row.systemId || !row.csgId) return;
      if (!map.has(row.systemId)) map.set(row.systemId, row.csgId);
    });
    return map;
  }, [csgSystemMappings]);

  const derivedScanIds = useMemo(() => {
    return Array.from(
      new Set(
        utilityRows
          .map((row) => csgBySystemId.get(row.systemId) ?? "")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  }, [utilityRows, csgBySystemId]);

  const selectedScanIds = useMemo(() => {
    const manual = parseCsgIds(manualScanIdInput);
    return manual.length > 0 ? manual : derivedScanIds;
  }, [manualScanIdInput, derivedScanIds]);

  const latestPayeeUpdateResult = useMemo(() => {
    return buildLatestPayeeMailingUpdates({
      updates: payeeUpdateRows,
      csgPortalDatabaseRows,
    });
  }, [payeeUpdateRows, csgPortalDatabaseRows]);

  const contractTermsWithPayeeUpdates = useMemo(() => {
    return applyPayeeMailingUpdatesToContractTerms({
      contractTermsByCsgId,
      latestUpdatesByCsgId: latestPayeeUpdateResult.byCsgId,
    });
  }, [contractTermsByCsgId, latestPayeeUpdateResult.byCsgId]);

  const computationResult = useMemo(() => {
    if (utilityRows.length === 0 || csgSystemMappings.length === 0 || projectApplications.length === 0) {
      return null;
    }

    const baseResult = computeSettlementRows({
      utilityRows,
      csgSystemMappings,
      projectApplications,
      quickBooksPaidUpfrontLedger: quickBooksLedger,
      contractTermsByCsgId: contractTermsWithPayeeUpdates,
      csgPortalDatabaseRows,
      installerRules,
      paymentsReportRows,
      previousCarryforwardBySystemId,
      manualOverridesByRowId,
    });

    return {
      ...baseResult,
      warnings: [...baseResult.warnings, ...latestPayeeUpdateResult.warnings],
    };
  }, [
    utilityRows,
    csgSystemMappings,
    projectApplications,
    quickBooksLedger,
    contractTermsWithPayeeUpdates,
    csgPortalDatabaseRows,
    installerRules,
    paymentsReportRows,
    previousCarryforwardBySystemId,
    manualOverridesByRowId,
    latestPayeeUpdateResult.warnings,
  ]);

  const yammEmailRows = useMemo(() => {
    if (!computationResult) return [] as Array<Record<string, string>>;
    return computationResult.rows.map((row) => {
      const systemLocation = splitSystemAddressLocation(row.systemAddress);
      const recipient = clean(row.customerEmail) || clean(row.customerAltEmail);
      return {
        Recipient: recipient,
        "Recipient Alt": clean(row.customerAltEmail),
        system_owner_payment_address_name: clean(row.payeeName),
        "This Payment": formatCurrency(row.netPayoutThisRow),
        "Payment Method": clean(row.paymentMethod),
        system_owner_payment_address: clean(row.mailingAddress1),
        system_owner_payment_address2: clean(row.mailingAddress2),
        system_owner_payment_city: clean(row.city),
        system_owner_payment_state: clean(row.state) || "IL",
        system_owner_payment_zip: clean(row.zip),
        ID: clean(row.csgId),
        Inverter_Size_kW_AC_Part_2: "",
        System_Name: "",
        system_address: clean(row.systemAddress),
        system_city: systemLocation.city,
        system_zip: systemLocation.zip,
        SRECs: String(row.recQuantity),
        "REC Price": formatCurrency(row.recPrice),
        "Total Payment": formatCurrency(row.grossContractValue),
        "CSG Fee %": formatPercent(row.vendorFeePercent),
        "Fee Amount": formatCurrency(row.vendorFeeAmount),
        "Additional Fee": row.additionalCollateralAmount > 0 ? "Additional collateral" : "",
        ADfee: formatCurrency(row.additionalCollateralAmount),
        "Additional Percent": formatPercent(row.additionalCollateralPercent),
        Additional: formatCurrency(row.additionalCollateralAmount),
        "CC Auth AdCo": row.ccAuthIncomplete5PercentAmount > 0 ? "5.00%" : "",
        "CC Auth AdCo Amount": formatCurrency(row.ccAuthIncomplete5PercentAmount),
        Five: formatCurrency(row.utilityHeldCollateral5PercentAmount),
        "Five if Paid": formatCurrency(row.utilityHeldCollateralPaidUpfront),
        "Payment Notes": clean(row.paymentNotes),
        "Payment Number": row.paymentNumber === null ? "" : String(row.paymentNumber),
        "Contract ID": clean(row.contractId),
        "Payment Send By Date": clean(emailSendByDateText),
        "Update Request Deadline": clean(emailUpdateDeadlineText),
      };
    });
  }, [computationResult, emailSendByDateText, emailUpdateDeadlineText]);

  const yammMissingRecipientCount = useMemo(
    () => yammEmailRows.filter((row) => !clean(row.Recipient)).length,
    [yammEmailRows]
  );

  const yammDuplicateRecipientCount = useMemo(() => {
    const counts = new Map<string, number>();
    yammEmailRows.forEach((row) => {
      const recipient = clean(row.Recipient).toLowerCase();
      if (!recipient) return;
      counts.set(recipient, (counts.get(recipient) ?? 0) + 1);
    });
    return Array.from(counts.values()).filter((count) => count > 1).length;
  }, [yammEmailRows]);

  const savedRuns = (savedRunsQuery.data ?? []) as RunSummary[];

  const missingRequiredInputs = useMemo(() => {
    const missing: string[] = [];
    if (utilityRows.length === 0) missing.push("Utility invoice file(s)");
    if (csgSystemMappings.length === 0) missing.push("CSG ↔ System mapping file");
    if (quickBooksByInvoice.size === 0) missing.push("QuickBooks detailed invoice report");
    if (projectApplications.length === 0) missing.push("ProjectApplication report");
    return missing;
  }, [utilityRows.length, csgSystemMappings.length, quickBooksByInvoice.size, projectApplications.length]);

  const handleUtilityUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setIsUploadingUtility(true);

    try {
      const files = Array.from(fileList);
      const mergedRows: UtilityInvoiceRow[] = [];

      for (const file of files) {
        const rows = await parseUtilityInvoiceFile(file);
        mergedRows.push(...rows);
      }

      setUtilityRows(mergedRows);
      setRunInputs((current) => ({
        ...current,
        utilityInvoiceFiles: files.map((file) => file.name),
      }));
      toast.success(`Loaded ${mergedRows.length.toLocaleString("en-US")} utility rows from ${files.length} file(s).`);
    } catch (error) {
      toast.error(`Failed to parse utility invoice file(s): ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingUtility(false);
    }
  };

  const handleMappingUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingMapping(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseCsgSystemMapping(parsed);
      setCsgSystemMappings(rows);
      setRunInputs((current) => ({ ...current, csgSystemMappingFile: file.name }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} CSG/System ID mappings.`);
    } catch (error) {
      toast.error(`Failed to parse CSG/System mapping: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingMapping(false);
    }
  };

  const handleQuickBooksUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingQuickBooks(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseQuickBooksDetailedReport(parsed);
      setQuickBooksByInvoice(rows);
      setRunInputs((current) => ({ ...current, quickBooksFile: file.name }));
      toast.success(`Loaded ${rows.size.toLocaleString("en-US")} QuickBooks invoices.`);
    } catch (error) {
      toast.error(`Failed to parse QuickBooks report: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingQuickBooks(false);
    }
  };

  const handlePaymentsReportUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingPaymentsReport(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parsePaymentsReport(parsed);
      setPaymentsReportRows(rows);
      setRunInputs((current) => ({ ...current, paymentsReportFile: file.name }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} payment report row(s).`);
    } catch (error) {
      toast.error(`Failed to parse payment report file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingPaymentsReport(false);
    }
  };

  const handleProjectApplicationUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingProjectApps(true);
    try {
      const parsed = await parseTabularFile(file);
      const rows = parseProjectApplications(parsed);
      setProjectApplications(rows);
      setRunInputs((current) => ({ ...current, projectApplicationFile: file.name }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} ProjectApplication rows.`);
    } catch (error) {
      toast.error(`Failed to parse ProjectApplication file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingProjectApps(false);
    }
  };

  const handleInvoiceMapUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingInvoiceMap(true);
    try {
      const parsed = await parseTabularFile(file);
      const detection = detectInvoiceNumberMapHeaders(parsed.headers);
      setInvoiceMapParsed(parsed);
      setInvoiceMapHeaderSelection({
        csgIdHeader: detection.csgIdHeader,
        invoiceNumberHeader: detection.invoiceNumberHeader,
      });
      try {
        setSavedInvoiceNumberMapRows(
          parseInvoiceNumberMap(parsed, {
            csgIdHeader: detection.csgIdHeader,
            invoiceNumberHeader: detection.invoiceNumberHeader,
          })
        );
      } catch {
        setSavedInvoiceNumberMapRows([]);
      }
      setRunInputs((current) => ({ ...current, portalInvoiceMapFile: file.name }));
      toast.success(`Loaded portal invoice map file (${parsed.rows.length.toLocaleString("en-US")} rows).`);
    } catch (error) {
      toast.error(`Failed to parse optional invoice map file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingInvoiceMap(false);
    }
  };

  const handleCsgPortalDatabaseUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingCsgPortalDatabase(true);

    try {
      const parsed = await parseTabularFile(file);
      const rows = parseCsgPortalDatabase(parsed);
      setCsgPortalDatabaseRows(rows);
      setRunInputs((current) => ({
        ...current,
        csgPortalDatabaseFile: file.name,
      }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} CSG portal system rows.`);
    } catch (error) {
      toast.error(`Failed to parse CSG portal database file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingCsgPortalDatabase(false);
    }
  };

  const handlePayeeUpdateUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setIsUploadingPayeeUpdates(true);

    try {
      const parsed = await parseTabularFile(file);
      const rows = parsePayeeMailingUpdateRequests(parsed);
      setPayeeUpdateRows(rows);
      setRunInputs((current) => ({
        ...current,
        payeeUpdateFile: file.name,
      }));
      toast.success(`Loaded ${rows.length.toLocaleString("en-US")} customer payee/mailing update row(s).`);
    } catch (error) {
      toast.error(`Failed to parse payee update file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploadingPayeeUpdates(false);
    }
  };

  const handleAddInstallerRule = () => {
    const nextIndex = installerRules.length + 1;
    setInstallerRules((current) => [
      ...current,
      {
        id: `installer-rule-${Date.now()}-${nextIndex}`,
        name: `Installer Rule ${nextIndex}`,
        active: true,
        matchField: "installerName",
        matchValue: "",
        forceUtilityCollateralReimbursement: false,
        referralFeePercent: 0,
        notes: "",
      },
    ]);
  };

  const handleUpdateInstallerRule = (
    ruleId: string,
    patch: Partial<InstallerSettlementRule>
  ) => {
    setInstallerRules((current) =>
      current.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule))
    );
  };

  const handleDeleteInstallerRule = (ruleId: string) => {
    setInstallerRules((current) => {
      const next = current.filter((rule) => rule.id !== ruleId);
      return next.length > 0 ? next : normalizeInstallerRules(DEFAULT_INSTALLER_RULES);
    });
  };

  const handleDeleteUtilityFiles = () => {
    setUtilityRows([]);
    setRunInputs((current) => ({
      ...current,
      utilityInvoiceFiles: [],
    }));
    toast.success("Utility invoice files deleted.");
  };

  const handleDeleteMappingFile = () => {
    setCsgSystemMappings([]);
    setRunInputs((current) => ({
      ...current,
      csgSystemMappingFile: null,
    }));
    toast.success("CSG/System mapping file deleted.");
  };

  const handleDeleteQuickBooksFile = () => {
    setQuickBooksByInvoice(new Map());
    setRunInputs((current) => ({
      ...current,
      quickBooksFile: null,
    }));
    toast.success("QuickBooks file deleted.");
  };

  const handleDeletePaymentsReportFile = () => {
    setPaymentsReportRows([]);
    setRunInputs((current) => ({
      ...current,
      paymentsReportFile: null,
    }));
    toast.success("Payment report file deleted.");
  };

  const handleDeleteProjectApplicationFile = () => {
    setProjectApplications([]);
    setRunInputs((current) => ({
      ...current,
      projectApplicationFile: null,
    }));
    toast.success("ProjectApplication file deleted.");
  };

  const handleDeleteInvoiceMapFile = () => {
    setInvoiceMapParsed(null);
    setSavedInvoiceNumberMapRows([]);
    setInvoiceMapHeaderSelection({
      csgIdHeader: null,
      invoiceNumberHeader: null,
    });
    setRunInputs((current) => ({
      ...current,
      portalInvoiceMapFile: null,
    }));
    toast.success("Optional portal invoice map deleted.");
  };

  const handleDeleteCsgPortalDatabaseFile = () => {
    setCsgPortalDatabaseRows([]);
    setRunInputs((current) => ({
      ...current,
      csgPortalDatabaseFile: null,
    }));
    toast.success("CSG portal database file deleted.");
  };

  const handleDeletePayeeUpdateFile = () => {
    setPayeeUpdateRows([]);
    setRunInputs((current) => ({
      ...current,
      payeeUpdateFile: null,
    }));
    toast.success("Payee update file deleted.");
  };

  const handleSavePortalCredentials = async () => {
    try {
      await savePortalCredentialsMutation.mutateAsync({
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setPortalPassword("");
      await trpcUtils.csgPortal.status.invalidate();
      toast.success("CSG portal credentials saved.");
    } catch (error) {
      toast.error(`Failed to save credentials: ${toErrorMessage(error)}`);
    }
  };

  const handleTestPortalConnection = async () => {
    try {
      await testPortalConnectionMutation.mutateAsync({
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setPortalPassword("");
      await trpcUtils.csgPortal.status.invalidate();
      toast.success("CSG portal connection succeeded.");
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  const handleStartContractScan = async () => {
    if (selectedScanIds.length === 0) {
      toast.error("No CSG IDs available to scan.");
      return;
    }

    try {
      const started = await startScanJobMutation.mutateAsync({
        csgIds: selectedScanIds,
        email: clean(portalEmail) || undefined,
        password: clean(portalPassword) || undefined,
        baseUrl: clean(portalBaseUrl) || undefined,
      });
      setContractFetchRows([]);
      setContractScanRows([]);
      setContractTermsByCsgId(new Map());
      setActiveScanJobId(started.jobId);
      toast.success(`Started contract scan for ${selectedScanIds.length.toLocaleString("en-US")} CSG IDs.`);
    } catch (error) {
      toast.error(`Could not start contract scan: ${toErrorMessage(error)}`);
    }
  };

  const handleExportCsv = () => {
    if (!computationResult || computationResult.rows.length === 0) {
      toast.error("No computed rows are available to export.");
      return;
    }

    const csv = buildSettlementCsv(computationResult.rows);
    const safeMonth = clean(monthKey) || buildMonthKey();
    downloadTextFile(`abp-invoice-settlement-${safeMonth}.csv`, csv, "text/csv;charset=utf-8");
    toast.success("CSV exported.");
  };

  const handleExportYammCsv = () => {
    if (!computationResult || yammEmailRows.length === 0) {
      toast.error("No computed rows are available for email merge export.");
      return;
    }
    const safeMonth = clean(monthKey) || buildMonthKey();
    downloadTextFile(
      `abp-yamm-payment-emails-${safeMonth}.csv`,
      toYammCsv(yammEmailRows),
      "text/csv;charset=utf-8"
    );
    toast.success("YAMM email CSV exported.");
  };

  const handleAiCleanMailingData = async () => {
    if (!computationResult || computationResult.rows.length === 0) {
      toast.error("No settlement rows available to clean.");
      return;
    }

    const uniqueByCsg = new Map<
      string,
      {
        key: string;
        payeeName?: string;
        mailingAddress1?: string;
        mailingAddress2?: string;
        cityStateZip?: string;
        city?: string;
        state?: string;
        zip?: string;
      }
    >();

    computationResult.rows.forEach((row) => {
      if (!row.csgId || uniqueByCsg.has(row.csgId)) return;
      const existingTerms = contractTermsByCsgId.get(row.csgId) ?? null;
      uniqueByCsg.set(row.csgId, {
        key: row.csgId,
        payeeName: clean(row.payeeName) || undefined,
        mailingAddress1: clean(row.mailingAddress1) || undefined,
        mailingAddress2: clean(row.mailingAddress2) || undefined,
        cityStateZip: clean(existingTerms?.cityStateZip) || undefined,
        city: clean(row.city) || undefined,
        state: clean(row.state) || undefined,
        zip: clean(row.zip) || undefined,
      });
    });

    const candidates = Array.from(uniqueByCsg.values());
    if (candidates.length === 0) {
      toast.error("No CSG-linked rows available for address cleanup.");
      return;
    }

    const batchSize = 120;
    const cleanedByCsg = new Map<
      string,
      {
        payeeName: string | null;
        mailingAddress1: string | null;
        mailingAddress2: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
      }
    >();

    try {
      for (let startIndex = 0; startIndex < candidates.length; startIndex += batchSize) {
        const chunk = candidates.slice(startIndex, startIndex + batchSize);
        const response = await cleanMailingDataMutation.mutateAsync({
          rows: chunk,
        });

        (response.rows ?? []).forEach((row) => {
          cleanedByCsg.set(row.key, {
            payeeName: clean(row.payeeName) || null,
            mailingAddress1: clean(row.mailingAddress1) || null,
            mailingAddress2: clean(row.mailingAddress2) || null,
            city: clean(row.city) || null,
            state: clean(row.state) || null,
            zip: clean(row.zip) || null,
          });
        });
      }

      if (cleanedByCsg.size === 0) {
        toast.error("AI cleanup returned no rows.");
        return;
      }

      const composeCityStateZip = (
        city: string | null,
        state: string | null,
        zip: string | null,
        fallback: string | null
      ): string | null => {
        const cityValue = clean(city) || null;
        const stateValue = clean(state) || null;
        const zipValue = clean(zip) || null;
        if (!cityValue && !stateValue && !zipValue) return fallback;
        const stateZip = [stateValue, zipValue].filter(Boolean).join(" ");
        return [cityValue, stateZip].filter(Boolean).join(", ");
      };

      setContractTermsByCsgId((current) => {
        const next = new Map(current);
        cleanedByCsg.forEach((cleaned, csgId) => {
          const existing = next.get(csgId);
          if (!existing) return;

          const city = cleaned.city ?? existing.city;
          const state = cleaned.state ?? existing.state;
          const zip = cleaned.zip ?? existing.zip;

          next.set(csgId, {
            ...existing,
            payeeName: cleaned.payeeName ?? existing.payeeName,
            mailingAddress1: cleaned.mailingAddress1 ?? existing.mailingAddress1,
            mailingAddress2: cleaned.mailingAddress2 ?? existing.mailingAddress2,
            city,
            state,
            zip,
            cityStateZip: composeCityStateZip(city, state, zip, existing.cityStateZip),
          });
        });
        return next;
      });

      setContractScanRows((current) =>
        current.map((row) => {
          const cleaned = cleanedByCsg.get(row.csgId);
          if (!cleaned) return row;
          const city = cleaned.city ?? row.city;
          const state = cleaned.state ?? row.state;
          const zip = cleaned.zip ?? row.zip;
          return {
            ...row,
            payeeName: cleaned.payeeName ?? row.payeeName,
            mailingAddress1: cleaned.mailingAddress1 ?? row.mailingAddress1,
            mailingAddress2: cleaned.mailingAddress2 ?? row.mailingAddress2,
            city,
            state,
            zip,
            cityStateZip: composeCityStateZip(city, state, zip, row.cityStateZip),
          };
        })
      );

      toast.success(`AI cleaned mailing fields for ${cleanedByCsg.size.toLocaleString("en-US")} CSG records.`);
    } catch (error) {
      toast.error(`AI mailing cleanup failed: ${toErrorMessage(error)}`);
    }
  };

  const handleSaveRun = async () => {
    if (!computationResult) {
      toast.error("Load required files first so the run can be saved.");
      return;
    }

    const payload: SavedRunPayload = {
      version: 1,
      monthKey: clean(monthKey) || buildMonthKey(),
      label: clean(runLabel) || null,
      savedAt: new Date().toISOString(),
      runInputs,
      utilityRows,
      csgSystemMappings,
      projectApplications: serializeProjectApplications(projectApplications),
      quickBooksInvoices: serializeQuickBooksInvoices(quickBooksByInvoice),
      paymentsReportRows: serializePaymentsReportRows(paymentsReportRows),
      payeeUpdateRows: serializePayeeUpdateRows(payeeUpdateRows),
      invoiceNumberMapRows,
      invoiceMapHeaderSelection,
      csgPortalDatabaseRows,
      installerRules: normalizeInstallerRules(installerRules),
      contractTerms: Array.from(contractTermsByCsgId.values()),
      manualOverridesByRowId,
      previousCarryforwardBySystemId,
      computedRows: computationResult.rows,
      warnings: computationResult.warnings,
      carryforwardBySystemId: computationResult.carryforwardBySystemId,
    };

    try {
      const response = await saveRunMutation.mutateAsync({
        monthKey: payload.monthKey,
        label: payload.label ?? undefined,
        payload: JSON.stringify(payload),
        rowCount: computationResult.rows.length,
      });
      await trpcUtils.abpSettlement.listRuns.invalidate();
      toast.success(`Run saved (${response.runId}).`);
    } catch (error) {
      toast.error(`Could not save run: ${toErrorMessage(error)}`);
    }
  };

  const applyLoadedRun = (payload: SavedRunPayload) => {
    setActiveScanJobId(null);
    setMonthKey(payload.monthKey || buildMonthKey());
    setRunLabel(payload.label ?? "");
    setRunInputs({
      utilityInvoiceFiles: Array.isArray(payload.runInputs?.utilityInvoiceFiles)
        ? payload.runInputs.utilityInvoiceFiles
        : [],
      csgSystemMappingFile: payload.runInputs?.csgSystemMappingFile ?? null,
      quickBooksFile: payload.runInputs?.quickBooksFile ?? null,
      paymentsReportFile: payload.runInputs?.paymentsReportFile ?? null,
      projectApplicationFile: payload.runInputs?.projectApplicationFile ?? null,
      portalInvoiceMapFile: payload.runInputs?.portalInvoiceMapFile ?? null,
      csgPortalDatabaseFile: payload.runInputs?.csgPortalDatabaseFile ?? null,
      payeeUpdateFile: payload.runInputs?.payeeUpdateFile ?? null,
    });
    setUtilityRows(payload.utilityRows ?? []);
    setCsgSystemMappings(payload.csgSystemMappings ?? []);
    setProjectApplications(
      deserializeProjectApplications(normalizeProjectApplicationRows(payload.projectApplications ?? []))
    );
    setQuickBooksByInvoice(deserializeQuickBooksInvoices(payload.quickBooksInvoices ?? []));
    setPaymentsReportRows(
      deserializePaymentsReportRows(normalizePaymentsReportRows(payload.paymentsReportRows ?? []))
    );
    setPayeeUpdateRows(deserializePayeeUpdateRows(normalizePayeeUpdateRows(payload.payeeUpdateRows ?? [])));
    setInvoiceMapParsed(null);
    setInvoiceMapHeaderSelection({
      csgIdHeader: clean(payload.invoiceMapHeaderSelection?.csgIdHeader) || null,
      invoiceNumberHeader: clean(payload.invoiceMapHeaderSelection?.invoiceNumberHeader) || null,
    });
    setSavedInvoiceNumberMapRows(normalizeInvoiceNumberMapRows(payload.invoiceNumberMapRows ?? []));
    setCsgPortalDatabaseRows(normalizeCsgPortalDatabaseRows(payload.csgPortalDatabaseRows ?? []));
    setInstallerRules(normalizeInstallerRules(payload.installerRules));
    setContractTermsByCsgId(new Map((payload.contractTerms ?? []).map((term) => [term.csgId, term])));
    setContractScanRows(
      (payload.contractTerms ?? []).map((term) => ({
        csgId: term.csgId,
        fileName: term.fileName,
        ccAuthorizationCompleted: term.ccAuthorizationCompleted,
        ccCardAsteriskCount: term.ccCardAsteriskCount,
        additionalFivePercentSelected: null,
        additionalCollateralPercent: term.additionalCollateralPercent,
        vendorFeePercent: term.vendorFeePercent,
        recQuantity: term.recQuantity,
        recPrice: term.recPrice,
        paymentMethod: term.paymentMethod ?? null,
        payeeName: term.payeeName ?? null,
        mailingAddress1: term.mailingAddress1 ?? null,
        mailingAddress2: term.mailingAddress2 ?? null,
        cityStateZip: term.cityStateZip ?? null,
        city: term.city ?? null,
        state: term.state ?? null,
        zip: term.zip ?? null,
        error: null,
      }))
    );
    setManualOverridesByRowId(payload.manualOverridesByRowId ?? {});
    setPreviousCarryforwardBySystemId(payload.carryforwardBySystemId ?? payload.previousCarryforwardBySystemId ?? {});
  };

  const handleLoadRun = async (runId: string) => {
    setLoadingRunId(runId);
    try {
      const response = await trpcUtils.abpSettlement.getRun.fetch({ runId });
      const parsed = JSON.parse(response.payload) as SavedRunPayload;
      if (!parsed || parsed.version !== 1) {
        throw new Error("Saved run payload has an unsupported format.");
      }
      applyLoadedRun(parsed);
      toast.success(`Loaded saved run ${runId}.`);
    } catch (error) {
      toast.error(`Could not load run ${runId}: ${toErrorMessage(error)}`);
    } finally {
      setLoadingRunId(null);
    }
  };

  const handleSeedCarryforwardFromRun = async (runId: string) => {
    setLoadingRunId(runId);
    try {
      const response = await trpcUtils.abpSettlement.getRun.fetch({ runId });
      const parsed = JSON.parse(response.payload) as SavedRunPayload;
      const carryforward = parsed.carryforwardBySystemId ?? {};
      setPreviousCarryforwardBySystemId(carryforward);
      toast.success(
        `Loaded carryforward seed from ${runId} (${Object.keys(carryforward).length.toLocaleString("en-US")} systems).`
      );
    } catch (error) {
      toast.error(`Could not load carryforward seed from ${runId}: ${toErrorMessage(error)}`);
    } finally {
      setLoadingRunId(null);
    }
  };

  const updateOverride = (rowId: string, patch: Partial<ManualOverride>) => {
    setManualOverridesByRowId((current) => {
      const existing = current[rowId] ?? {};
      const next = { ...existing, ...patch };
      const hasValue =
        next.classification !== undefined ||
        next.carryforwardIn !== undefined ||
        next.vendorFeePercent !== undefined ||
        next.additionalCollateralPercent !== undefined ||
        next.applicationFeeAmount !== undefined ||
        clean(next.notes).length > 0;

      if (!hasValue) {
        const copy = { ...current };
        delete copy[rowId];
        return copy;
      }

      return {
        ...current,
        [rowId]: next,
      };
    });
  };

  const clearAllState = () => {
    setRunInputs({
      utilityInvoiceFiles: [],
      csgSystemMappingFile: null,
      quickBooksFile: null,
      paymentsReportFile: null,
      projectApplicationFile: null,
      portalInvoiceMapFile: null,
      csgPortalDatabaseFile: null,
      payeeUpdateFile: null,
    });
    setUtilityRows([]);
    setCsgSystemMappings([]);
    setProjectApplications([]);
    setQuickBooksByInvoice(new Map());
    setPaymentsReportRows([]);
    setPayeeUpdateRows([]);
    setCsgPortalDatabaseRows([]);
    setInstallerRules(normalizeInstallerRules(DEFAULT_INSTALLER_RULES));
    setInvoiceMapParsed(null);
    setInvoiceMapHeaderSelection({ csgIdHeader: null, invoiceNumberHeader: null });
    setSavedInvoiceNumberMapRows([]);
    setManualOverridesByRowId({});
    setPreviousCarryforwardBySystemId({});
    setContractFetchRows([]);
    setContractScanRows([]);
    setContractTermsByCsgId(new Map());
    setManualScanIdInput("");
    setActiveScanJobId(null);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  const scanProgress = scanJobQuery.data?.progress;
  const scanInFlight = Boolean(activeScanJobId);
  const scanStartedAtMs = scanJobQuery.data?.startedAt
    ? Date.parse(scanJobQuery.data.startedAt)
    : Number.NaN;
  const scanElapsedMs =
    scanInFlight && Number.isFinite(scanStartedAtMs)
      ? Math.max(0, scanClockNow - scanStartedAtMs)
      : null;
  const scanRemainingMs = (() => {
    if (!scanInFlight || !scanProgress || scanElapsedMs === null) return null;
    const current = scanProgress.current;
    const total = scanProgress.total;
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
    if (current >= total) return 0;
    if (current <= 0) return null;
    const averageMsPerRecord = scanElapsedMs / current;
    if (!Number.isFinite(averageMsPerRecord) || averageMsPerRecord <= 0) return null;
    return Math.max(0, Math.round(averageMsPerRecord * (total - current)));
  })();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">ABP Monthly Invoice Settlement</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload monthly files, scan CSG portal contracts, calculate withholdings/carryforward, then export payout-ready rows.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Run Setup</CardTitle>
            <CardDescription>
              Set the run month and optional label. Save and load runs for month-to-month continuity.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="month-key">Run Month (YYYY-MM)</Label>
                <Input
                  id="month-key"
                  value={monthKey}
                  onChange={(event) => setMonthKey(event.target.value)}
                  placeholder="2026-03"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="run-label">Run Label (optional)</Label>
                <Input
                  id="run-label"
                  value={runLabel}
                  onChange={(event) => setRunLabel(event.target.value)}
                  placeholder="March utility settlement"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSaveRun}
                disabled={saveRunMutation.isPending || !computationResult}
              >
                {saveRunMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Run
              </Button>
              <Button variant="outline" onClick={clearAllState}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Clear Current State
              </Button>
              <Badge variant="secondary">
                {computationResult?.rows.length.toLocaleString("en-US") ?? "0"} computed row(s)
              </Badge>
              <Badge variant="secondary">
                {Object.keys(previousCarryforwardBySystemId).length.toLocaleString("en-US")} carryforward seed(s)
              </Badge>
            </div>

            <div className="rounded-md border">
              <div className="max-h-56 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run ID</TableHead>
                      <TableHead>Month</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Rows</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!savedRuns.length ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-slate-500 text-center py-6">
                          No saved runs yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      savedRuns.map((run) => (
                        <TableRow key={run.runId}>
                          <TableCell className="font-mono text-xs">{run.runId}</TableCell>
                          <TableCell>{run.monthKey}</TableCell>
                          <TableCell>{run.label ?? ""}</TableCell>
                          <TableCell>{run.rowCount ?? ""}</TableCell>
                          <TableCell>{formatDateTime(run.updatedAt)}</TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleLoadRun(run.runId)}
                              disabled={loadingRunId === run.runId}
                            >
                              {loadingRunId === run.runId ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : null}
                              Load
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleSeedCarryforwardFromRun(run.runId)}
                              disabled={loadingRunId === run.runId}
                            >
                              Seed Carryforward
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Upload Inputs</CardTitle>
            <CardDescription>
              Required: utility invoices, CSG/System mapping, QuickBooks report, and ProjectApplication file. Optional: payment report checker file, portal invoice map, CSG portal database, and customer payee/mailing update file. Linked uploads sync with Solar REC dashboard slots.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              {uploadsHydrated
                ? "Uploads persist automatically and stay loaded until you replace or delete them."
                : "Restoring previously uploaded files..."}
            </div>
            {uploadPersistenceNotice ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {uploadPersistenceNotice}
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleSaveUploadsNow()}
                disabled={authLoading || !user || !uploadsHydrated || isSavingUploadsNow}
              >
                {isSavingUploadsNow ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                Save Uploads Now
              </Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="utility-upload">Utility Invoice Workbooks (.xlsx/.csv, multi-file)</Label>
                <Input
                  id="utility-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  multiple
                  onChange={(event) => {
                    void handleUtilityUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingUtility}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.utilityInvoiceFiles.length > 0
                      ? `${runInputs.utilityInvoiceFiles.length} file(s) loaded.`
                      : "No utility files loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteUtilityFiles}
                    disabled={isUploadingUtility || (runInputs.utilityInvoiceFiles.length === 0 && utilityRows.length === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mapping-upload">CSG ↔ System ID Mapping (.csv/.xlsx)</Label>
                <Input
                  id="mapping-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleMappingUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingMapping}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.csgSystemMappingFile ?? "No mapping file loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteMappingFile}
                    disabled={isUploadingMapping || (!runInputs.csgSystemMappingFile && csgSystemMappings.length === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="quickbooks-upload">QuickBooks Detailed Invoice Report</Label>
                <Input
                  id="quickbooks-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleQuickBooksUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingQuickBooks}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.quickBooksFile ?? "No QuickBooks file loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteQuickBooksFile}
                    disabled={isUploadingQuickBooks || (!runInputs.quickBooksFile && quickBooksByInvoice.size === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="payments-report-upload">Optional Payments Report Checker (payments-report.csv)</Label>
                <Input
                  id="payments-report-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handlePaymentsReportUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingPaymentsReport}
                />
                <div className="text-xs text-slate-500">
                  Uses `State Certification Number` (ABP ID), `System Id` (CSG ID), `Payment Number`, and `Type`.
                  Only `ABP SREC Payment` counts toward contract payments. `Reissue` is excluded.
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.paymentsReportFile ?? "No payment report file loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeletePaymentsReportFile}
                    disabled={isUploadingPaymentsReport || (!runInputs.paymentsReportFile && paymentsReportRows.length === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-app-upload">ProjectApplication CSV</Label>
                <Input
                  id="project-app-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleProjectApplicationUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingProjectApps}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.projectApplicationFile ?? "No ProjectApplication file loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteProjectApplicationFile}
                    disabled={isUploadingProjectApps || (!runInputs.projectApplicationFile && projectApplications.length === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="invoice-map-upload">Optional Portal Invoice Map (CSG ID ↔ Invoice Number)</Label>
                <Input
                  id="invoice-map-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleInvoiceMapUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingInvoiceMap}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.portalInvoiceMapFile ?? "No optional invoice map loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteInvoiceMapFile}
                    disabled={
                      isUploadingInvoiceMap ||
                      (!runInputs.portalInvoiceMapFile && !invoiceMapParsed && invoiceNumberMapRows.length === 0)
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="csg-portal-db-upload">
                  Optional CSG Portal Database (.csv/.xlsx)
                </Label>
                <Input
                  id="csg-portal-db-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handleCsgPortalDatabaseUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingCsgPortalDatabase}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.csgPortalDatabaseFile ?? "No CSG portal database loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteCsgPortalDatabaseFile}
                    disabled={
                      isUploadingCsgPortalDatabase ||
                      (!runInputs.csgPortalDatabaseFile && csgPortalDatabaseRows.length === 0)
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="payee-update-upload">
                  Optional Customer Payee/Mailing Update File (.csv/.xlsx)
                </Label>
                <Input
                  id="payee-update-upload"
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,text/csv"
                  onChange={(event) => {
                    void handlePayeeUpdateUpload(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isUploadingPayeeUpdates}
                />
                <div className="text-xs text-slate-500">
                  Uses the most recent request date per CSG ID. If CSG ID is wrong, responder email is used to match CSG portal email/alt email when possible.
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    {runInputs.payeeUpdateFile ?? "No payee update file loaded."}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeletePayeeUpdateFile}
                    disabled={isUploadingPayeeUpdates || (!runInputs.payeeUpdateFile && payeeUpdateRows.length === 0)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>

            {invoiceMapParsed ? (
              <div className="rounded-md border p-4 space-y-3">
                <div className="text-sm font-medium">Invoice Map Header Selection</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>CSG ID Header</Label>
                    <Select
                      value={invoiceMapHeaderSelection.csgIdHeader ?? ""}
                      onValueChange={(value) =>
                        setInvoiceMapHeaderSelection((current) => ({
                          ...current,
                          csgIdHeader: value || null,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select CSG ID header" />
                      </SelectTrigger>
                      <SelectContent>
                        {invoiceMapParsed.headers.map((header) => (
                          <SelectItem key={header} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Invoice Number Header</Label>
                    <Select
                      value={invoiceMapHeaderSelection.invoiceNumberHeader ?? ""}
                      onValueChange={(value) =>
                        setInvoiceMapHeaderSelection((current) => ({
                          ...current,
                          invoiceNumberHeader: value || null,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select invoice number header" />
                      </SelectTrigger>
                      <SelectContent>
                        {invoiceMapParsed.headers.map((header) => (
                          <SelectItem key={header} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="text-xs text-slate-600">
                  Parsed {invoiceNumberMapRows.length.toLocaleString("en-US")} invoice-map rows.
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium mb-1">Input Counts</div>
                <div>Utility rows: {utilityRows.length.toLocaleString("en-US")}</div>
                <div>CSG/System mappings: {csgSystemMappings.length.toLocaleString("en-US")}</div>
                <div>QuickBooks invoices: {quickBooksByInvoice.size.toLocaleString("en-US")}</div>
                <div>Payment report rows: {paymentsReportRows.length.toLocaleString("en-US")}</div>
                <div>ProjectApplication rows: {projectApplications.length.toLocaleString("en-US")}</div>
                <div>Invoice map rows: {invoiceNumberMapRows.length.toLocaleString("en-US")}</div>
                <div>CSG portal database rows: {csgPortalDatabaseRows.length.toLocaleString("en-US")}</div>
                <div>Payee update request rows: {payeeUpdateRows.length.toLocaleString("en-US")}</div>
                <div>Latest payee updates applied: {latestPayeeUpdateResult.byCsgId.size.toLocaleString("en-US")}</div>
                <div>
                  Unmatched payee updates: {latestPayeeUpdateResult.unresolvedRows.length.toLocaleString("en-US")}
                </div>
                <div>Installer-specific rules: {installerRules.length.toLocaleString("en-US")}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium mb-1">QuickBooks Allocation</div>
                <div>
                  Matched system lines: {Array.from(quickBooksLedger.bySystemId.values())
                    .reduce((acc, row) => acc + row.matchedLines.length, 0)
                    .toLocaleString("en-US")}
                </div>
                <div>
                  Collateral reimbursement to partner company: {formatCurrency(
                    Array.from(quickBooksLedger.bySystemId.values()).reduce(
                      (acc, row) =>
                        acc + (row.utilityCollateralReimbursementToPartnerCompanyAmount ?? 0),
                      0
                    )
                  )}
                </div>
                <div>
                  Unmatched category lines: {quickBooksLedger.unmatchedLines.length.toLocaleString("en-US")}
                </div>
              </div>
            </div>

            {missingRequiredInputs.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Missing required inputs: {missingRequiredInputs.join(", ")}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) Installer-Specific Rules</CardTitle>
            <CardDescription>
              Rules are editable on this page and persisted with uploads. Use these to force collateral reimbursement behavior and apply referral fees by installer/partner match.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={handleAddInstallerRule}>
                <Plus className="h-4 w-4 mr-2" />
                Add Rule
              </Button>
              <Badge variant="secondary">{installerRules.length.toLocaleString("en-US")} rule(s)</Badge>
            </div>
            <div className="rounded-md border">
              <div className="max-h-[40vh] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Active</TableHead>
                      <TableHead>Rule Name</TableHead>
                      <TableHead>Match Field</TableHead>
                      <TableHead>Match Text</TableHead>
                      <TableHead>Force Collateral Reimbursed</TableHead>
                      <TableHead>Referral Fee %</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {installerRules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={rule.active}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, { active: event.target.checked })
                            }
                          />
                        </TableCell>
                        <TableCell className="min-w-[180px]">
                          <Input
                            value={rule.name}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, { name: event.target.value })
                            }
                          />
                        </TableCell>
                        <TableCell className="min-w-[170px]">
                          <Select
                            value={rule.matchField}
                            onValueChange={(value) =>
                              handleUpdateInstallerRule(rule.id, {
                                matchField:
                                  value === "partnerCompanyName" ? "partnerCompanyName" : "installerName",
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="installerName">Installer Name</SelectItem>
                              <SelectItem value="partnerCompanyName">Partner Company Name</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="min-w-[180px]">
                          <Input
                            value={rule.matchValue}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, { matchValue: event.target.value })
                            }
                            placeholder="e.g., ADT Solar"
                          />
                        </TableCell>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={rule.forceUtilityCollateralReimbursement}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, {
                                forceUtilityCollateralReimbursement: event.target.checked,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell className="min-w-[120px]">
                          <Input
                            type="number"
                            step="0.01"
                            value={rule.referralFeePercent}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, {
                                referralFeePercent: parseNumberInput(event.target.value) ?? 0,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell className="min-w-[220px]">
                          <Textarea
                            value={rule.notes}
                            onChange={(event) =>
                              handleUpdateInstallerRule(rule.id, { notes: event.target.value })
                            }
                            rows={2}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteInstallerRule(rule.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4) CSG Portal Contract Scan</CardTitle>
            <CardDescription>
              Save/test portal credentials, then scan the top Rec Contract PDF for each CSG ID. Scan progress now persists and resumes from where it left off after page reloads.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="portal-email">Portal Email</Label>
                <Input
                  id="portal-email"
                  type="email"
                  value={portalEmail}
                  onChange={(event) => setPortalEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="portal-password">Portal Password</Label>
                <Input
                  id="portal-password"
                  type="password"
                  value={portalPassword}
                  onChange={(event) => setPortalPassword(event.target.value)}
                  placeholder={csgPortalStatusQuery.data?.hasPassword ? "Saved password on file" : "Enter password"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="portal-base-url">Portal Base URL</Label>
                <Input
                  id="portal-base-url"
                  value={portalBaseUrl}
                  onChange={(event) => setPortalBaseUrl(event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSavePortalCredentials}
                disabled={savePortalCredentialsMutation.isPending}
              >
                {savePortalCredentialsMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Save Credentials
              </Button>
              <Button
                variant="outline"
                onClick={handleTestPortalConnection}
                disabled={testPortalConnectionMutation.isPending}
              >
                {testPortalConnectionMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Test Connection
              </Button>
              <Badge variant={csgPortalStatusQuery.data?.connected ? "default" : "secondary"}>
                {csgPortalStatusQuery.data?.connected ? "Connected" : "Not connected"}
              </Badge>
              {csgPortalStatusQuery.data?.lastTestStatus ? (
                <Badge variant="secondary">
                  Last test: {csgPortalStatusQuery.data.lastTestStatus} {formatDateTime(csgPortalStatusQuery.data.lastTestedAt)}
                </Badge>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-scan-ids">
                CSG IDs to Scan (optional override; comma/newline separated)
              </Label>
              <Textarea
                id="manual-scan-ids"
                value={manualScanIdInput}
                onChange={(event) => setManualScanIdInput(event.target.value)}
                placeholder="Leave blank to scan all IDs from uploaded utility rows + mapping"
                rows={3}
              />
              <div className="text-xs text-slate-600">
                Selected scan IDs: {selectedScanIds.length.toLocaleString("en-US")}
                {manualScanIdInput.trim().length === 0 && derivedScanIds.length > 0 ? " (derived automatically)" : ""}
              </div>
            </div>

            <div>
              <Button
                onClick={handleStartContractScan}
                disabled={scanInFlight || startScanJobMutation.isPending || selectedScanIds.length === 0}
              >
                {scanInFlight || startScanJobMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Contract Scan
              </Button>
            </div>

            {scanInFlight && scanProgress ? (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{scanProgress.message}</span>
                  <span>
                    {scanProgress.current}/{scanProgress.total}
                  </span>
                </div>
                <Progress value={scanProgress.percent} />
                <div className="grid gap-1 text-xs text-slate-500 sm:grid-cols-3">
                  <div>Current CSG ID: {scanProgress.currentCsgId ?? "-"}</div>
                  <div>Time elapsed: {formatDuration(scanElapsedMs)}</div>
                  <div>
                    Time remaining estimate:{" "}
                    {scanRemainingMs === null ? "Calculating..." : formatDuration(scanRemainingMs)}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="rounded-md border">
              <div className="max-h-64 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>CSG ID</TableHead>
                      <TableHead>PDF</TableHead>
                      <TableHead>Vendor Fee %</TableHead>
                      <TableHead>Additional Collateral %</TableHead>
                      <TableHead>Additional 5% Selected</TableHead>
                      <TableHead>CC Auth Completed</TableHead>
                      <TableHead>CC Auth Digits</TableHead>
                      <TableHead>Payment Method</TableHead>
                      <TableHead>Payee Name</TableHead>
                      <TableHead>Mailing Address 1</TableHead>
                      <TableHead>Mailing Address 2</TableHead>
                      <TableHead>City/State/Zip (Raw)</TableHead>
                      <TableHead>City</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Zip</TableHead>
                      <TableHead>REC Quantity</TableHead>
                      <TableHead>REC Price</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractScanRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={18} className="text-sm text-slate-500 text-center py-6">
                          No scan rows yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      contractScanRows.map((row) => (
                        <TableRow key={`${row.csgId}:${row.fileName}`}>
                          <TableCell>{row.csgId}</TableCell>
                          <TableCell className="max-w-[240px] truncate" title={row.fileName}>
                            {row.fileName}
                          </TableCell>
                          <TableCell>{formatPercent(row.vendorFeePercent)}</TableCell>
                          <TableCell>{formatPercent(row.additionalCollateralPercent)}</TableCell>
                          <TableCell>
                            {row.additionalFivePercentSelected === null
                              ? "Unknown"
                              : row.additionalFivePercentSelected
                                ? "Yes"
                                : "No"}
                          </TableCell>
                          <TableCell>
                            {row.ccAuthorizationCompleted === null
                              ? "Unknown"
                              : row.ccAuthorizationCompleted
                                ? "Completed"
                                : "Incomplete"}
                          </TableCell>
                          <TableCell>{row.ccCardAsteriskCount ?? ""}</TableCell>
                          <TableCell>{row.paymentMethod ?? ""}</TableCell>
                          <TableCell>{row.payeeName ?? ""}</TableCell>
                          <TableCell>{row.mailingAddress1 ?? ""}</TableCell>
                          <TableCell>{row.mailingAddress2 ?? ""}</TableCell>
                          <TableCell>{row.cityStateZip ?? ""}</TableCell>
                          <TableCell>{row.city ?? ""}</TableCell>
                          <TableCell>{row.state ?? ""}</TableCell>
                          <TableCell>{row.zip ?? ""}</TableCell>
                          <TableCell>{row.recQuantity ?? ""}</TableCell>
                          <TableCell>{row.recPrice === null ? "" : formatCurrency(row.recPrice)}</TableCell>
                          <TableCell className="text-red-600">{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>5) Settlement Output</CardTitle>
              <CardDescription>
                Includes first/only-payment formula columns plus classification, carryforward, confidence flags, and override notes.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={handleAiCleanMailingData}
                disabled={
                  !computationResult ||
                  computationResult.rows.length === 0 ||
                  cleanMailingDataMutation.isPending
                }
              >
                {cleanMailingDataMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                AI Clean Mailing Data
              </Button>
              <Button variant="outline" onClick={handleExportCsv} disabled={!computationResult || computationResult.rows.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {computationResult?.warnings.length ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1 text-sm text-amber-900">
                {computationResult.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Rows</div>
                <div className="text-lg font-semibold">{computationResult?.rows.length ?? 0}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Unknown Classification</div>
                <div className="text-lg font-semibold">
                  {computationResult?.rows.filter((row) => row.classification === "unknown").length ?? 0}
                </div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Contract Terms Loaded</div>
                <div className="text-lg font-semibold">{contractTermsWithPayeeUpdates.size}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Carryforward Systems</div>
                <div className="text-lg font-semibold">
                  {Object.keys(computationResult?.carryforwardBySystemId ?? {}).length}
                </div>
              </div>
            </div>

            {!computationResult ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                <Upload className="mx-auto mb-3 h-5 w-5 text-slate-500" />
                Upload required files to compute settlement rows.
              </div>
            ) : (
              <div className="rounded-md border">
                <div className="max-h-[72vh] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white z-10">
                      <TableRow>
                        <TableHead>CSG ID</TableHead>
                        <TableHead>System ID</TableHead>
                        <TableHead>Invoice Amount</TableHead>
                        <TableHead>REC Quantity</TableHead>
                        <TableHead>REC Price</TableHead>
                        <TableHead>Gross Contract Value</TableHead>
                        <TableHead>Payment #</TableHead>
                        <TableHead>Vendor Fee %</TableHead>
                        <TableHead>Vendor Fee Amount</TableHead>
                        <TableHead>Utility Held Collateral 5% Amount</TableHead>
                        <TableHead>Utility Held Collateral Paid Upfront</TableHead>
                        <TableHead>Collateral Reimbursement to the Partner Company</TableHead>
                        <TableHead>Referral Fee %</TableHead>
                        <TableHead>Referral Fee Amount</TableHead>
                        <TableHead>Application Fee Amount</TableHead>
                        <TableHead>Application Fee Paid Upfront</TableHead>
                        <TableHead>Additional Collateral %</TableHead>
                        <TableHead>Additional Collateral Amount</TableHead>
                        <TableHead>CC Authorization Form Status</TableHead>
                        <TableHead>CC Incomplete 5% Required</TableHead>
                        <TableHead>First Payment Formula Net</TableHead>
                        <TableHead>Payment Method</TableHead>
                        <TableHead>Payee Name</TableHead>
                        <TableHead>Mailing Address 1</TableHead>
                        <TableHead>Mailing Address 2</TableHead>
                        <TableHead>City</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Zip</TableHead>
                        <TableHead>Installer Name</TableHead>
                        <TableHead>Partner Company Name</TableHead>
                        <TableHead>Customer Email</TableHead>
                        <TableHead>Customer Alt Email</TableHead>
                        <TableHead>System Address</TableHead>
                        <TableHead>Payment Notes</TableHead>
                        <TableHead>Applied Installer Rule</TableHead>
                        <TableHead>Payment Report Status</TableHead>
                        <TableHead>Payment Report #</TableHead>
                        <TableHead>Payment Report Applied Count</TableHead>
                        <TableHead>Payment Report Applied Amount</TableHead>
                        <TableHead>Payment Report Reissue Count</TableHead>
                        <TableHead>Payment Report Reissue Amount</TableHead>
                        <TableHead>Payment Report Last Type</TableHead>
                        <TableHead>Payment Report Last Date</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Carryforward In</TableHead>
                        <TableHead>Carryforward Out</TableHead>
                        <TableHead>Confidence Flags</TableHead>
                        <TableHead>Override Classification</TableHead>
                        <TableHead>Override Carryforward In</TableHead>
                        <TableHead>Override Vendor Fee %</TableHead>
                        <TableHead>Override Addl Collateral %</TableHead>
                        <TableHead>Override App Fee</TableHead>
                        <TableHead>Override Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {computationResult.rows.map((row) => {
                        const override = manualOverridesByRowId[row.rowId] ?? {};
                        return (
                          <TableRow key={row.rowId}>
                            <TableCell>{row.csgId ?? ""}</TableCell>
                            <TableCell>{row.systemId}</TableCell>
                            <TableCell>{formatCurrency(row.invoiceAmount)}</TableCell>
                            <TableCell>{row.recQuantity}</TableCell>
                            <TableCell>{formatCurrency(row.recPrice)}</TableCell>
                            <TableCell>{formatCurrency(row.grossContractValue)}</TableCell>
                            <TableCell>{row.paymentNumber ?? ""}</TableCell>
                            <TableCell>{formatPercent(row.vendorFeePercent)}</TableCell>
                            <TableCell>{formatCurrency(row.vendorFeeAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.utilityHeldCollateral5PercentAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.utilityHeldCollateralPaidUpfront)}</TableCell>
                            <TableCell>{formatCurrency(row.collateralReimbursementToPartnerCompanyAmount)}</TableCell>
                            <TableCell>{formatPercent(row.referralFeePercent)}</TableCell>
                            <TableCell>{formatCurrency(row.referralFeeAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.applicationFeeAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.applicationFeePaidUpfront)}</TableCell>
                            <TableCell>{formatPercent(row.additionalCollateralPercent)}</TableCell>
                            <TableCell>{formatCurrency(row.additionalCollateralAmount)}</TableCell>
                            <TableCell>{row.ccAuthorizationFormStatus}</TableCell>
                            <TableCell>{formatCurrency(row.ccAuthIncomplete5PercentAmount)}</TableCell>
                            <TableCell>{formatCurrency(row.firstPaymentFormulaNetAmount)}</TableCell>
                            <TableCell>{row.paymentMethod}</TableCell>
                            <TableCell>{row.payeeName}</TableCell>
                            <TableCell>{row.mailingAddress1}</TableCell>
                            <TableCell>{row.mailingAddress2}</TableCell>
                            <TableCell>{row.city}</TableCell>
                            <TableCell>{row.state}</TableCell>
                            <TableCell>{row.zip}</TableCell>
                            <TableCell>{row.installerName}</TableCell>
                            <TableCell>{row.partnerCompanyName}</TableCell>
                            <TableCell>{row.customerEmail}</TableCell>
                            <TableCell>{row.customerAltEmail}</TableCell>
                            <TableCell>{row.systemAddress}</TableCell>
                            <TableCell>{row.paymentNotes}</TableCell>
                            <TableCell>{row.appliedInstallerRuleName}</TableCell>
                            <TableCell>{row.paymentReportCheckStatus}</TableCell>
                            <TableCell>{row.paymentReportMatchedPaymentNumber ?? ""}</TableCell>
                            <TableCell>{row.paymentReportAppliedCount}</TableCell>
                            <TableCell>{formatCurrency(row.paymentReportAppliedAmount)}</TableCell>
                            <TableCell>{row.paymentReportReissueCount}</TableCell>
                            <TableCell>{formatCurrency(row.paymentReportReissueAmount)}</TableCell>
                            <TableCell>{row.paymentReportLastType}</TableCell>
                            <TableCell>{row.paymentReportLastPaymentDate}</TableCell>
                            <TableCell>{row.classification}</TableCell>
                            <TableCell>{formatCurrency(row.carryforwardIn)}</TableCell>
                            <TableCell>{formatCurrency(row.carryforwardOut)}</TableCell>
                            <TableCell className="max-w-[240px]">
                              <div className="text-xs whitespace-pre-wrap">
                                {row.confidenceFlags.join(" | ")}
                              </div>
                            </TableCell>
                            <TableCell className="min-w-[180px]">
                              <Select
                                value={override.classification ?? "__auto__"}
                                onValueChange={(value) => {
                                  const classification =
                                    value === "__auto__"
                                      ? undefined
                                      : isClassification(value)
                                        ? value
                                        : undefined;
                                  updateOverride(row.rowId, { classification });
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Auto" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__auto__">Auto</SelectItem>
                                  <SelectItem value="first_full_upfront">first_full_upfront</SelectItem>
                                  <SelectItem value="first_partial">first_partial</SelectItem>
                                  <SelectItem value="quarterly">quarterly</SelectItem>
                                  <SelectItem value="unknown">unknown</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.carryforwardIn ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    carryforwardIn: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.vendorFeePercent ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    vendorFeePercent: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[160px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.additionalCollateralPercent ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    additionalCollateralPercent: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Input
                                type="number"
                                step="0.01"
                                value={override.applicationFeeAmount ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    applicationFeeAmount: parseNumberInput(event.target.value),
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell className="min-w-[220px]">
                              <Textarea
                                value={override.notes ?? ""}
                                onChange={(event) =>
                                  updateOverride(row.rowId, {
                                    notes: event.target.value,
                                  })
                                }
                                rows={2}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>6) YAMM Email Merge</CardTitle>
              <CardDescription>
                Build a Yet Another Mail Merge CSV for monthly payment emails and run basic send-readiness checks before blast day.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              onClick={handleExportYammCsv}
              disabled={!computationResult || yammEmailRows.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Export YAMM CSV
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email-send-by-date">Payment Send By Date Text</Label>
                <Input
                  id="email-send-by-date"
                  value={emailSendByDateText}
                  onChange={(event) => setEmailSendByDateText(event.target.value)}
                  placeholder="Tuesday, March 24"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-update-deadline">Update Request Deadline Text</Label>
                <Input
                  id="email-update-deadline"
                  value={emailUpdateDeadlineText}
                  onChange={(event) => setEmailUpdateDeadlineText(event.target.value)}
                  placeholder="1pm Tuesday, March 24"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Merge Rows</div>
                <div className="text-lg font-semibold">{yammEmailRows.length.toLocaleString("en-US")}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Missing Recipient Email</div>
                <div className="text-lg font-semibold">{yammMissingRecipientCount.toLocaleString("en-US")}</div>
              </div>
              <div className="rounded-md border p-3 text-sm">
                <div className="text-slate-500">Duplicate Recipients</div>
                <div className="text-lg font-semibold">{yammDuplicateRecipientCount.toLocaleString("en-US")}</div>
              </div>
            </div>

            <div className="rounded-md border">
              <div className="max-h-56 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recipient</TableHead>
                      <TableHead>CSG ID</TableHead>
                      <TableHead>Payment #</TableHead>
                      <TableHead>This Payment</TableHead>
                      <TableHead>Payee</TableHead>
                      <TableHead>Method</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {yammEmailRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-slate-500 text-center py-6">
                          Compute settlement rows first to build email merge data.
                        </TableCell>
                      </TableRow>
                    ) : (
                      yammEmailRows.slice(0, 100).map((row, index) => (
                        <TableRow key={`${clean(row.ID)}:${clean(row["Payment Number"])}:${index}`}>
                          <TableCell>{row.Recipient}</TableCell>
                          <TableCell>{row.ID}</TableCell>
                          <TableCell>{row["Payment Number"]}</TableCell>
                          <TableCell>{row["This Payment"]}</TableCell>
                          <TableCell>{row.system_owner_payment_address_name}</TableCell>
                          <TableCell>{row["Payment Method"]}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Export includes all placeholders used in your template (for example: {"<<"}This Payment{">>"}, {"<<"}ID{">>"}, {"<<"}Payment Method{">>"}) plus
              {" "}Recipient for YAMM.
            </div>
          </CardContent>
        </Card>

        {contractFetchRows.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Contract Fetch Audit</CardTitle>
              <CardDescription>Per-CSG fetch outcomes from portal download.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <div className="max-h-56 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>CSG ID</TableHead>
                        <TableHead>System Page</TableHead>
                        <TableHead>PDF URL</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contractFetchRows.map((row) => (
                        <TableRow key={`${row.csgId}:${row.systemPageUrl}`}>
                          <TableCell>{row.csgId}</TableCell>
                          <TableCell className="max-w-[260px] truncate" title={row.systemPageUrl}>
                            {row.systemPageUrl}
                          </TableCell>
                          <TableCell className="max-w-[260px] truncate" title={row.pdfUrl ?? ""}>
                            {row.pdfUrl ?? ""}
                          </TableCell>
                          <TableCell className="text-red-600">{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
