import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Download, Loader2, Trash2, Upload } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type CsvRow = Record<string, string>;

type ParsedCsv = {
  headers: string[];
  rows: CsvRow[];
  matrix: string[][];
};

type UploadedDataset = {
  fileName: string;
  uploadedAt: Date;
  rowCount: number;
};

type InvoiceSourceRow = {
  systemId: string;
  invoiceNumber: string;
  project: string;
  companyName: string;
  trackingSystemId: string;
  stateCertificationId: string;
  amount: number | null;
  status: string;
  type: string;
  recipientName: string;
  recipientEmail: string;
  updatedAt: Date | null;
};

type QuickBooksLineItem = {
  lineOrder: number | null;
  description: string;
  amount: number | null;
};

type QuickBooksInvoice = {
  invoiceNumber: string;
  amount: number | null;
  openBalance: number | null;
  cashReceived: number | null;
  paymentStatus: string;
  voided: string;
  customer: string;
  customerFullName: string;
  customerCompany: string;
  date: Date | null;
  lineItems: QuickBooksLineItem[];
  lineItemPreview: string;
  tokens: string[];
};

type InvoiceCell = {
  invoiceNumber: string;
  amount: number | null;
  status: string;
  cashReceived: number | null;
  lineItem: string;
  quickBooksLineItemPreview: string;
};

type PotentialMatch = {
  invoiceNumber: string;
  score: number;
  amount: number | null;
  cashReceived: number | null;
  paymentStatus: string;
  customerLabel: string;
  reason: string;
};

const LINE_ITEM_CATEGORY_DEFINITIONS = [
  {
    key: "abpApplicationFee",
    label: "Application Fee",
  },
  {
    key: "utilityHeldCollateral5Percent",
    label: "5% Collateral",
  },
  {
    key: "transferFee",
    label: "Transfer Fee",
  },
  {
    key: "nonConnectionToInternetFee",
    label: "Non-connection to internet fee",
  },
  {
    key: "ccFee",
    label: "CC Fee",
  },
  {
    key: "contractCancellationFee",
    label: "Contract Cancellation Fee",
  },
] as const;

type LineItemCategoryKey = (typeof LINE_ITEM_CATEGORY_DEFINITIONS)[number]["key"];

type LineItemSummary = {
  totals: Record<LineItemCategoryKey, number>;
  invoices: Record<LineItemCategoryKey, string[]>;
  otherNotes: string[];
};

type DashboardRow = {
  systemId: string;
  invoiceCount: number;
  hasMissingInvoiceNumber: boolean;
  invoices: InvoiceCell[];
  statuses: string[];
  statusTokens: string[];
  lineItemSummary: LineItemSummary;
  potentialMatches: PotentialMatch[];
  searchIndex: string;
};

type PotentialCandidate = {
  invoiceNumber: string;
  amount: number | null;
  cashReceived: number | null;
  paymentStatus: string;
  voided: string;
  customerLabel: string;
  reasonText: string;
  tokens: string[];
  tokenSet: Set<string>;
  date: Date | null;
};

type MatchScoreResult = {
  score: number;
  reason: string;
};

type PersistedUploadedDataset = {
  fileName: string;
  uploadedAt: string;
  rowCount: number;
};

type PersistedInvoiceSourceRow = Omit<InvoiceSourceRow, "updatedAt"> & {
  updatedAt: string | null;
};

type PersistedQuickBooksInvoice = Omit<QuickBooksInvoice, "date"> & {
  date: string | null;
};

type PersistedDashboardState = {
  version: number;
  invoiceDataset: PersistedUploadedDataset | null;
  quickBooksDataset: PersistedUploadedDataset | null;
  invoiceRows: PersistedInvoiceSourceRow[];
  quickBooksInvoices: PersistedQuickBooksInvoice[];
};

const COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const POTENTIAL_MATCH_LIMIT = 3;
const AMOUNT_BUCKET_SIZE = 25;
const PERSISTENCE_DB_NAME = "coherence-invoice-match-dashboard";
const PERSISTENCE_STORE_NAME = "state";
const PERSISTENCE_RECORD_KEY = "dashboard";
const PERSISTENCE_VERSION = 1;

const COMMON_TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "llc",
  "inc",
  "corp",
  "company",
  "customer",
  "group",
  "installer",
  "application",
  "collateral",
  "service",
  "invoice",
  "cost",
  "fee",
  "abp",
  "to",
  "from",
  "not",
  "active",
]);

let persistenceDbPromise: Promise<IDBDatabase> | null = null;

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function dateToIso(value: Date | null): string | null {
  if (!value) return null;
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return value.toISOString();
}

function isoToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

function serializeDataset(dataset: UploadedDataset | null): PersistedUploadedDataset | null {
  if (!dataset) return null;
  return {
    fileName: dataset.fileName,
    uploadedAt: dateToIso(dataset.uploadedAt) ?? new Date().toISOString(),
    rowCount: dataset.rowCount,
  };
}

function deserializeDataset(dataset: PersistedUploadedDataset | null | undefined): UploadedDataset | null {
  if (!dataset) return null;
  const uploadedAt = isoToDate(dataset.uploadedAt);
  if (!uploadedAt) return null;
  return {
    fileName: clean(dataset.fileName),
    uploadedAt,
    rowCount: Number.isFinite(dataset.rowCount) ? dataset.rowCount : 0,
  };
}

function serializeInvoiceRows(rows: InvoiceSourceRow[]): PersistedInvoiceSourceRow[] {
  return rows.map((row) => ({
    ...row,
    updatedAt: dateToIso(row.updatedAt),
  }));
}

function deserializeInvoiceRows(rows: PersistedInvoiceSourceRow[] | null | undefined): InvoiceSourceRow[] {
  if (!rows?.length) return [];
  return rows.map((row) => ({
    ...row,
    updatedAt: isoToDate(row.updatedAt),
  }));
}

function serializeQuickBooksInvoices(
  quickBooksByInvoice: Map<string, QuickBooksInvoice>
): PersistedQuickBooksInvoice[] {
  return Array.from(quickBooksByInvoice.values()).map((invoice) => ({
    ...invoice,
    date: dateToIso(invoice.date),
  }));
}

function deserializeQuickBooksInvoices(
  invoices: PersistedQuickBooksInvoice[] | null | undefined
): Map<string, QuickBooksInvoice> {
  const next = new Map<string, QuickBooksInvoice>();
  if (!invoices?.length) return next;

  invoices.forEach((invoice) => {
    const key = clean(invoice.invoiceNumber);
    if (!key) return;
    next.set(key, {
      ...invoice,
      date: isoToDate(invoice.date),
    });
  });

  return next;
}

function openPersistenceDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is not available in this browser."));
  }

  if (persistenceDbPromise) return persistenceDbPromise;

  persistenceDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(PERSISTENCE_DB_NAME, PERSISTENCE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSISTENCE_STORE_NAME)) {
        db.createObjectStore(PERSISTENCE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open dashboard persistence database."));
    request.onblocked = () =>
      reject(new Error("Dashboard persistence database open request is blocked in this browser tab."));
  });

  return persistenceDbPromise;
}

function readPersistedDashboardState(): Promise<PersistedDashboardState | null> {
  return openPersistenceDb().then(
    (db) =>
      new Promise<PersistedDashboardState | null>((resolve, reject) => {
        const transaction = db.transaction(PERSISTENCE_STORE_NAME, "readonly");
        const store = transaction.objectStore(PERSISTENCE_STORE_NAME);
        const request = store.get(PERSISTENCE_RECORD_KEY);

        request.onsuccess = () => {
          const value = request.result as PersistedDashboardState | undefined;
          if (!value || value.version !== PERSISTENCE_VERSION) {
            resolve(null);
            return;
          }
          resolve(value);
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Could not load saved invoice dashboard state."));
      })
  );
}

function writePersistedDashboardState(payload: PersistedDashboardState): Promise<void> {
  return openPersistenceDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(PERSISTENCE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(PERSISTENCE_STORE_NAME);
        const request = store.put(payload, PERSISTENCE_RECORD_KEY);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not save invoice dashboard state."));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not save invoice dashboard state."));
      })
  );
}

function clearPersistedDashboardState(): Promise<void> {
  return openPersistenceDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(PERSISTENCE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(PERSISTENCE_STORE_NAME);
        const request = store.delete(PERSISTENCE_RECORD_KEY);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not clear saved invoice dashboard state."));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not clear saved invoice dashboard state."));
      })
  );
}

function normalizeHeader(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(text: string): ParsedCsv {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"') {
      const next = source[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((entry) => clean(entry).length > 0)) matrix.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((entry) => clean(entry).length > 0)) matrix.push(row);

  if (matrix.length === 0) {
    return { headers: [], rows: [], matrix: [] };
  }

  const headers = matrix[0].map((header, columnIndex) => clean(header) || `column_${columnIndex + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, columnIndex) => {
      record[header] = clean(values[columnIndex]);
    });
    return record;
  });

  return { headers, rows, matrix };
}

function parseNumber(value: string): number | null {
  const normalized = clean(value)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\(([^)]+)\)/, "-$1");

  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string): Date | null {
  const normalized = clean(value);
  if (!normalized) return null;

  const parsed = Date.parse(normalized);
  if (Number.isFinite(parsed)) return new Date(parsed);

  const match = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i
  );
  if (!match) return null;

  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const minute = Number(match[5] ?? "0");
  const period = clean(match[6]).toLowerCase();
  let hour = Number(match[4] ?? "0");

  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  const date = new Date(year, month, day, hour, minute);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tokenize(values: string[]): string[] {
  const tokenSet = new Set<string>();

  values.forEach((value) => {
    const normalized = normalizeText(value);
    if (!normalized) return;

    normalized.split(" ").forEach((token) => {
      if (token.length < 3) return;
      if (COMMON_TOKEN_STOPWORDS.has(token)) return;
      tokenSet.add(token);
    });
  });

  return Array.from(tokenSet);
}

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return CURRENCY_FORMATTER.format(value);
}

function formatUploadedAt(value: Date | null): string {
  if (!value) return "-";
  return value.toLocaleString("en-US");
}

function buildCsvEscapedCell(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function buildCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  const headerRow = headers.map((header) => buildCsvEscapedCell(header)).join(",");
  const bodyRows = rows.map((row) =>
    headers.map((header) => buildCsvEscapedCell(row[header])).join(",")
  );
  return [headerRow, ...bodyRows].join("\n");
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function createEmptyLineItemTotals(): Record<LineItemCategoryKey, number> {
  return LINE_ITEM_CATEGORY_DEFINITIONS.reduce(
    (accumulator, category) => ({
      ...accumulator,
      [category.key]: 0,
    }),
    {} as Record<LineItemCategoryKey, number>
  );
}

function createEmptyLineItemInvoiceSets(): Record<LineItemCategoryKey, Set<string>> {
  return LINE_ITEM_CATEGORY_DEFINITIONS.reduce(
    (accumulator, category) => ({
      ...accumulator,
      [category.key]: new Set<string>(),
    }),
    {} as Record<LineItemCategoryKey, Set<string>>
  );
}

function formatNumberForCsv(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function normalizeInvoiceReference(invoiceNumber: string): string {
  const normalized = clean(invoiceNumber);
  return normalized || "(missing invoice #)";
}

function detectLineItemCategories(value: string): LineItemCategoryKey[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const categories: LineItemCategoryKey[] = [];

  if (
    /\btransfer\b/.test(normalized) ||
    /25\s*\/\s*kw/.test(normalized) ||
    /25\s*kw/.test(normalized)
  ) {
    categories.push("transferFee");
  }

  if (
    /\bcontract\b.*\b(cancellation|termination)\b/.test(normalized) ||
    /\b(cancellation|termination)\s*(cost|fee)\b/.test(normalized)
  ) {
    categories.push("contractCancellationFee");
  }

  if (
    /non connection to internet/.test(normalized) ||
    (/non connection/.test(normalized) && /internet/.test(normalized))
  ) {
    categories.push("nonConnectionToInternetFee");
  }

  if (
    /3\s*%\s*(cc|credit card)/.test(normalized) ||
    /\bcc\s*fee\b/.test(normalized) ||
    /\bcredit card fee\b/.test(normalized)
  ) {
    categories.push("ccFee");
  }

  if (
    /5\s*%\s*(utility held\s*)?(abp\s*)?collateral/.test(normalized) ||
    /\butility held collateral\b/.test(normalized)
  ) {
    categories.push("utilityHeldCollateral5Percent");
  }

  const alreadySpecific =
    categories.includes("transferFee") ||
    categories.includes("contractCancellationFee") ||
    categories.includes("nonConnectionToInternetFee") ||
    categories.includes("ccFee");

  if (
    !alreadySpecific &&
    (/\bapplication fee\b/.test(normalized) ||
      /\bapp fee\b/.test(normalized) ||
      /\babp fee\b/.test(normalized) ||
      /\bnon refundable\b.*\bfee\b/.test(normalized) ||
      /\bnonrefundable\b.*\bfee\b/.test(normalized) ||
      /(10|20)\s*\/\s*kw/.test(normalized))
  ) {
    categories.push("abpApplicationFee");
  }

  return Array.from(new Set(categories));
}

function getQuickBooksInvoiceStatus(invoice: QuickBooksInvoice | undefined): string {
  if (!invoice) return "Missing in QuickBooks";
  if (normalizeText(invoice.voided) === "yes") return "Voided";
  const paymentStatus = clean(invoice.paymentStatus);
  return paymentStatus || "Unknown";
}

function getStatusClassName(status: string): string {
  const normalized = normalizeText(status);
  if (normalized.includes("missing in quickbooks")) {
    return "bg-slate-100 text-slate-700 border-slate-200";
  }
  if (normalized.includes("unpaid")) {
    return "bg-amber-100 text-amber-900 border-amber-200";
  }
  if (normalized.includes("paid")) {
    return "bg-emerald-100 text-emerald-800 border-emerald-200";
  }
  if (normalized.includes("sent")) {
    return "bg-blue-100 text-blue-800 border-blue-200";
  }
  if (normalized.includes("void")) {
    return "bg-rose-100 text-rose-800 border-rose-200";
  }
  return "bg-slate-100 text-slate-800 border-slate-200";
}

function buildHeaderLookup(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  headers.forEach((header) => {
    map.set(normalizeHeader(header), header);
  });
  return map;
}

function hasAnyHeader(headerLookup: Map<string, string>, options: string[]): boolean {
  return options.some((option) => headerLookup.has(normalizeHeader(option)));
}

function readByHeaderOptions(row: CsvRow, headerLookup: Map<string, string>, options: string[]): string {
  for (const option of options) {
    const actual = headerLookup.get(normalizeHeader(option));
    if (!actual) continue;
    return clean(row[actual]);
  }
  return "";
}

function parseInvoicesFile(parsed: ParsedCsv): InvoiceSourceRow[] {
  const headerLookup = buildHeaderLookup(parsed.headers);

  const hasSystemId = hasAnyHeader(headerLookup, ["System Ids", "System ID", "System Id"]);
  const hasInvoiceNumber = hasAnyHeader(headerLookup, ["Invoice Number", "Invoice #", "Num"]);
  if (!hasSystemId || !hasInvoiceNumber) {
    throw new Error(
      "Invoices report is missing required columns. Needed: System Ids and Invoice Number."
    );
  }

  return parsed.rows
    .map((row) => {
      const systemId = readByHeaderOptions(row, headerLookup, ["System Ids", "System ID", "System Id"]);
      const invoiceNumber = readByHeaderOptions(row, headerLookup, [
        "Invoice Number",
        "Invoice #",
        "Num",
      ]);

      return {
        systemId,
        invoiceNumber,
        project: readByHeaderOptions(row, headerLookup, ["Projects", "Project"]),
        companyName: readByHeaderOptions(row, headerLookup, ["Company Names", "Company Name"]),
        trackingSystemId: readByHeaderOptions(row, headerLookup, [
          "Tracking System Ids",
          "Tracking System IDs",
          "Tracking System Id",
        ]),
        stateCertificationId: readByHeaderOptions(row, headerLookup, [
          "State Certification Ids",
          "State Certification IDs",
          "State Certification Id",
        ]),
        amount: parseNumber(readByHeaderOptions(row, headerLookup, ["Amount"])),
        status: readByHeaderOptions(row, headerLookup, ["Status"]),
        type: readByHeaderOptions(row, headerLookup, ["Type", "Invoice Type", "Line Item"]),
        recipientName: readByHeaderOptions(row, headerLookup, ["Recipient Name", "Recipient"]),
        recipientEmail: readByHeaderOptions(row, headerLookup, ["Recipient Email", "Recipient E-mail"]),
        updatedAt: parseDate(readByHeaderOptions(row, headerLookup, ["Updated At", "Updated"])),
      } satisfies InvoiceSourceRow;
    })
    .filter((row) => row.systemId.length > 0);
}

function parseQuickBooksFile(parsed: ParsedCsv): Map<string, QuickBooksInvoice> {
  const headerRowIndex = parsed.matrix.findIndex((row) => {
    const first = normalizeHeader(row[0] ?? "");
    const second = normalizeHeader(row[1] ?? "");
    const third = normalizeHeader(row[2] ?? "");
    return first === "date" && second === "num" && third === "customer";
  });

  if (headerRowIndex < 0) {
    throw new Error(
      "QuickBooks report header row was not found. Expected a row starting with Date, Num, Customer."
    );
  }

  const headers = parsed.matrix[headerRowIndex].map((entry, index) => clean(entry) || `column_${index + 1}`);
  const rows: CsvRow[] = parsed.matrix.slice(headerRowIndex + 1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(values[index]);
    });
    return record;
  });

  const headerLookup = buildHeaderLookup(headers);
  if (!hasAnyHeader(headerLookup, ["Num", "Invoice Number", "Invoice #"])) {
    throw new Error("QuickBooks report is missing the Num (invoice number) column.");
  }

  const grouped = new Map<
    string,
    {
      amount: number | null;
      openBalance: number | null;
      paymentStatus: string;
      voided: string;
      customer: string;
      customerFullName: string;
      customerCompany: string;
      date: Date | null;
      lineItems: QuickBooksLineItem[];
    }
  >();

  rows.forEach((row) => {
    const invoiceNumber = readByHeaderOptions(row, headerLookup, ["Num", "Invoice Number", "Invoice #"]);
    if (!invoiceNumber) return;

    const existing = grouped.get(invoiceNumber);
    const amount = parseNumber(readByHeaderOptions(row, headerLookup, ["Amount", "Total"]));
    const openBalance = parseNumber(readByHeaderOptions(row, headerLookup, ["Open balance", "Open Balance"]));

    const next = existing ?? {
      amount: null,
      openBalance: null,
      paymentStatus: "",
      voided: "",
      customer: "",
      customerFullName: "",
      customerCompany: "",
      date: null,
      lineItems: [],
    };

    if (next.amount === null && amount !== null) next.amount = amount;
    if (next.openBalance === null && openBalance !== null) next.openBalance = openBalance;

    if (!next.paymentStatus) {
      next.paymentStatus = readByHeaderOptions(row, headerLookup, ["Payment status", "Payment Status"]);
    }
    if (!next.voided) {
      next.voided = readByHeaderOptions(row, headerLookup, ["Voided"]);
    }
    if (!next.customer) {
      next.customer = readByHeaderOptions(row, headerLookup, ["Customer"]);
    }
    if (!next.customerFullName) {
      next.customerFullName = readByHeaderOptions(row, headerLookup, ["Customer full name", "Customer Full Name"]);
    }
    if (!next.customerCompany) {
      next.customerCompany = readByHeaderOptions(row, headerLookup, ["Customer company", "Customer Company"]);
    }
    if (!next.date) {
      next.date = parseDate(readByHeaderOptions(row, headerLookup, ["Date"]));
    }

    const description = readByHeaderOptions(row, headerLookup, [
      "Product/service description",
      "Product Service Description",
      "Description",
    ]);
    const lineAmount = parseNumber(
      readByHeaderOptions(row, headerLookup, [
        "Product/service amount line",
        "Product Service Amount Line",
        "Line Amount",
      ])
    );

    const lineOrderRaw = readByHeaderOptions(row, headerLookup, ["Line order", "Line Order"]);
    const lineOrder = lineOrderRaw ? Number(lineOrderRaw) : null;

    if (description || lineAmount !== null) {
      next.lineItems.push({
        lineOrder: Number.isFinite(lineOrder) ? lineOrder : null,
        description,
        amount: lineAmount,
      });
    }

    grouped.set(invoiceNumber, next);
  });

  const result = new Map<string, QuickBooksInvoice>();

  grouped.forEach((raw, invoiceNumber) => {
    const sortedLineItems = [...raw.lineItems].sort((left, right) => {
      if (left.lineOrder === null && right.lineOrder === null) return 0;
      if (left.lineOrder === null) return 1;
      if (right.lineOrder === null) return -1;
      return left.lineOrder - right.lineOrder;
    });

    const lineItemPreview = sortedLineItems
      .slice(0, 3)
      .map((item) => {
        if (item.amount === null) return item.description;
        return `${item.description} (${formatCurrency(item.amount)})`;
      })
      .filter((value) => value.length > 0)
      .join(" | ");

    const cashReceived =
      raw.amount !== null && raw.openBalance !== null
        ? Math.max(0, raw.amount - raw.openBalance)
        : normalizeText(raw.paymentStatus) === "paid" && raw.amount !== null
          ? raw.amount
          : null;

    const tokens = tokenize([
      raw.customer,
      raw.customerFullName,
      raw.customerCompany,
      ...sortedLineItems.map((item) => item.description),
    ]);

    result.set(invoiceNumber, {
      invoiceNumber,
      amount: raw.amount,
      openBalance: raw.openBalance,
      cashReceived,
      paymentStatus: raw.paymentStatus,
      voided: raw.voided,
      customer: raw.customer,
      customerFullName: raw.customerFullName,
      customerCompany: raw.customerCompany,
      date: raw.date,
      lineItems: sortedLineItems,
      lineItemPreview,
      tokens,
    });
  });

  return result;
}

function buildAmountBucket(amount: number): number {
  return Math.round(amount / AMOUNT_BUCKET_SIZE);
}

function buildPotentialCandidates(
  quickBooksByInvoice: Map<string, QuickBooksInvoice>,
  associatedInvoiceNumbers: Set<string>
): PotentialCandidate[] {
  return Array.from(quickBooksByInvoice.values())
    .filter((invoice) => !associatedInvoiceNumbers.has(invoice.invoiceNumber))
    .map((invoice) => {
      const customerLabel =
        clean(invoice.customerFullName) || clean(invoice.customer) || clean(invoice.customerCompany) || "-";
      const reasonText =
        invoice.lineItemPreview ||
        clean(invoice.customer) ||
        clean(invoice.customerFullName) ||
        clean(invoice.customerCompany) ||
        "No detail available";
      return {
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount,
        cashReceived: invoice.cashReceived,
        paymentStatus: invoice.paymentStatus,
        voided: invoice.voided,
        customerLabel,
        reasonText,
        tokens: invoice.tokens,
        tokenSet: new Set(invoice.tokens),
        date: invoice.date,
      } satisfies PotentialCandidate;
    });
}

function computePotentialMatchScore(
  systemTokens: string[],
  hasMissingInvoiceNumber: boolean,
  systemAmounts: number[],
  candidate: PotentialCandidate
): MatchScoreResult {
  let score = hasMissingInvoiceNumber ? 34 : 10;
  const reasonParts: string[] = [];

  const sharedTokens = systemTokens.filter((token) => candidate.tokenSet.has(token));
  if (sharedTokens.length > 0) {
    const cappedSharedCount = Math.min(sharedTokens.length, 5);
    score += cappedSharedCount * 8;
    reasonParts.push(`${sharedTokens.length} shared keyword${sharedTokens.length === 1 ? "" : "s"}`);
  }

  if (hasMissingInvoiceNumber) {
    score += 12;
    reasonParts.push("system has a missing invoice number");
  }

  if (candidate.amount !== null && systemAmounts.length > 0) {
    const amountDiffs = systemAmounts.map((amount) => Math.abs(amount - candidate.amount!));
    const minDiff = Math.min(...amountDiffs);
    const minSystemAmount = Math.max(1, Math.min(...systemAmounts));
    const diffPct = minDiff / minSystemAmount;

    if (diffPct <= 0.01) {
      score += 20;
      reasonParts.push("amount is almost identical");
    } else if (diffPct <= 0.05) {
      score += 14;
      reasonParts.push("amount is very close");
    } else if (diffPct <= 0.15) {
      score += 8;
      reasonParts.push("amount is somewhat close");
    }
  }

  if (normalizeText(candidate.voided) === "yes") {
    score -= 20;
  }

  const normalizedPaymentStatus = normalizeText(candidate.paymentStatus);
  if (normalizedPaymentStatus === "paid") {
    score += 3;
  }

  const boundedScore = Math.max(0, Math.min(99, Math.round(score)));
  const reason = reasonParts.length > 0 ? reasonParts.slice(0, 2).join("; ") : "weak signal";

  return { score: boundedScore, reason };
}

function buildDashboardRows(
  invoiceRows: InvoiceSourceRow[],
  quickBooksByInvoice: Map<string, QuickBooksInvoice>
): DashboardRow[] {
  const bySystemId = new Map<string, InvoiceSourceRow[]>();

  invoiceRows.forEach((row) => {
    const existing = bySystemId.get(row.systemId);
    if (existing) {
      existing.push(row);
    } else {
      bySystemId.set(row.systemId, [row]);
    }
  });

  const associatedInvoiceNumbers = new Set<string>();
  invoiceRows.forEach((row) => {
    if (row.systemId && row.invoiceNumber) {
      associatedInvoiceNumbers.add(row.invoiceNumber);
    }
  });

  const potentialCandidates = buildPotentialCandidates(quickBooksByInvoice, associatedInvoiceNumbers);

  const candidateTokenIndex = new Map<string, number[]>();
  const candidateAmountIndex = new Map<number, number[]>();

  potentialCandidates.forEach((candidate, index) => {
    candidate.tokens.forEach((token) => {
      const bucket = candidateTokenIndex.get(token);
      if (bucket) {
        bucket.push(index);
      } else {
        candidateTokenIndex.set(token, [index]);
      }
    });

    if (candidate.amount !== null) {
      const amountBucket = buildAmountBucket(candidate.amount);
      const existing = candidateAmountIndex.get(amountBucket);
      if (existing) {
        existing.push(index);
      } else {
        candidateAmountIndex.set(amountBucket, [index]);
      }
    }
  });

  const rows: DashboardRow[] = Array.from(bySystemId.entries()).map(([systemId, sourceRows]) => {
    const sortedSourceRows = [...sourceRows].sort((left, right) => {
      const leftTime = left.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return COLLATOR.compare(right.invoiceNumber, left.invoiceNumber);
    });

    const lineItemTotals = createEmptyLineItemTotals();
    const lineItemInvoiceSets = createEmptyLineItemInvoiceSets();
    const otherLineItemNotesSet = new Set<string>();

    const addCategoryObservation = (
      category: LineItemCategoryKey,
      amount: number | null,
      invoiceReference: string
    ) => {
      if (amount !== null && Number.isFinite(amount)) {
        lineItemTotals[category] += amount;
      }
      lineItemInvoiceSets[category].add(invoiceReference);
    };

    const fallbackClassifyUsingInvoiceType = (source: InvoiceSourceRow, invoiceReference: string) => {
      const typeMatches = detectLineItemCategories(source.type);

      if (typeMatches.length === 1) {
        addCategoryObservation(typeMatches[0], source.amount, invoiceReference);
        return;
      }

      if (typeMatches.length > 1) {
        typeMatches.forEach((category) => addCategoryObservation(category, null, invoiceReference));
        if (source.amount !== null) {
          otherLineItemNotesSet.add(
            `${invoiceReference}: Multi-category invoice type "${source.type}" (${formatCurrency(source.amount)})`
          );
        }
        return;
      }

      const cleanedType = clean(source.type);
      if (cleanedType) {
        const detail = source.amount === null ? "" : ` (${formatCurrency(source.amount)})`;
        otherLineItemNotesSet.add(`${invoiceReference}: ${cleanedType}${detail}`);
      }
    };

    const invoices = sortedSourceRows.map((source) => {
      const quickBooksMatch = source.invoiceNumber ? quickBooksByInvoice.get(source.invoiceNumber) : undefined;
      const status = getQuickBooksInvoiceStatus(quickBooksMatch);
      const invoiceReference = normalizeInvoiceReference(source.invoiceNumber);

      let classifiedFromQuickBooksLine = false;

      if (quickBooksMatch?.lineItems.length) {
        quickBooksMatch.lineItems.forEach((lineItem) => {
          const directMatches = detectLineItemCategories(lineItem.description);

          if (directMatches.length === 1) {
            addCategoryObservation(directMatches[0], lineItem.amount, invoiceReference);
            classifiedFromQuickBooksLine = true;
            return;
          }

          if (directMatches.length > 1) {
            directMatches.forEach((category) => addCategoryObservation(category, null, invoiceReference));
            classifiedFromQuickBooksLine = true;
            if (lineItem.amount !== null || clean(lineItem.description)) {
              const detail = lineItem.amount === null ? "" : ` (${formatCurrency(lineItem.amount)})`;
              otherLineItemNotesSet.add(
                `${invoiceReference}: Ambiguous QB line "${clean(lineItem.description) || "Unlabeled line"}"${detail}`
              );
            }
            return;
          }

          const fallbackMatches = detectLineItemCategories(source.type);
          if (fallbackMatches.length === 1) {
            addCategoryObservation(fallbackMatches[0], lineItem.amount, invoiceReference);
            classifiedFromQuickBooksLine = true;
            return;
          }

          if (fallbackMatches.length > 1) {
            fallbackMatches.forEach((category) => addCategoryObservation(category, null, invoiceReference));
            classifiedFromQuickBooksLine = true;
            if (lineItem.amount !== null || clean(lineItem.description)) {
              const detail = lineItem.amount === null ? "" : ` (${formatCurrency(lineItem.amount)})`;
              otherLineItemNotesSet.add(
                `${invoiceReference}: QB line required fallback category "${clean(lineItem.description) || "Unlabeled line"}"${detail}`
              );
            }
            return;
          }

          if (lineItem.amount !== null || clean(lineItem.description)) {
            const detail = lineItem.amount === null ? "" : ` (${formatCurrency(lineItem.amount)})`;
            otherLineItemNotesSet.add(
              `${invoiceReference}: Unmatched QB line "${clean(lineItem.description) || "Unlabeled line"}"${detail}`
            );
          }
        });
      }

      if (!classifiedFromQuickBooksLine) {
        fallbackClassifyUsingInvoiceType(source, invoiceReference);
      }

      return {
        invoiceNumber: source.invoiceNumber,
        amount: source.amount,
        status,
        cashReceived: quickBooksMatch?.cashReceived ?? null,
        lineItem: source.type,
        quickBooksLineItemPreview: quickBooksMatch?.lineItemPreview ?? "",
      } satisfies InvoiceCell;
    });

    const statuses = Array.from(
      new Set(
        invoices
          .map((invoice) => clean(invoice.status))
          .filter((status) => status.length > 0)
      )
    );

    const lineItemSummary: LineItemSummary = {
      totals: LINE_ITEM_CATEGORY_DEFINITIONS.reduce((accumulator, category) => {
        accumulator[category.key] = Math.round(lineItemTotals[category.key] * 100) / 100;
        return accumulator;
      }, {} as Record<LineItemCategoryKey, number>),
      invoices: LINE_ITEM_CATEGORY_DEFINITIONS.reduce((accumulator, category) => {
        accumulator[category.key] = Array.from(lineItemInvoiceSets[category.key]).sort((left, right) =>
          COLLATOR.compare(left, right)
        );
        return accumulator;
      }, {} as Record<LineItemCategoryKey, string[]>),
      otherNotes: Array.from(otherLineItemNotesSet).sort((left, right) => COLLATOR.compare(left, right)),
    };

    const statusTokens = statuses.map((status) => normalizeText(status));
    const hasMissingInvoiceNumber = sortedSourceRows.some((source) => !source.invoiceNumber);

    const systemTokenValues = [
      ...sortedSourceRows.map((row) => row.project),
      ...sortedSourceRows.map((row) => row.companyName),
      ...sortedSourceRows.map((row) => row.recipientName),
      ...sortedSourceRows.map((row) => row.type),
      ...sortedSourceRows.map((row) => row.trackingSystemId),
      ...sortedSourceRows.map((row) => row.stateCertificationId),
    ];

    const systemTokens = tokenize(systemTokenValues);
    const systemAmounts = sortedSourceRows
      .map((row) => row.amount)
      .filter((value): value is number => value !== null && Number.isFinite(value));

    const candidateIndexes = new Set<number>();

    systemTokens.forEach((token) => {
      const indexes = candidateTokenIndex.get(token);
      if (!indexes) return;
      indexes.forEach((index) => candidateIndexes.add(index));
    });

    systemAmounts.forEach((amount) => {
      const bucket = buildAmountBucket(amount);
      [bucket - 1, bucket, bucket + 1].forEach((bucketValue) => {
        const indexes = candidateAmountIndex.get(bucketValue);
        if (!indexes) return;
        indexes.forEach((index) => candidateIndexes.add(index));
      });
    });

    if (hasMissingInvoiceNumber && candidateIndexes.size < 150) {
      for (let index = 0; index < Math.min(150, potentialCandidates.length); index += 1) {
        candidateIndexes.add(index);
      }
    }

    const scoredCandidates: PotentialMatch[] = Array.from(candidateIndexes)
      .map((index) => {
        const candidate = potentialCandidates[index];
        const { score, reason } = computePotentialMatchScore(
          systemTokens,
          hasMissingInvoiceNumber,
          systemAmounts,
          candidate
        );

        return {
          invoiceNumber: candidate.invoiceNumber,
          score,
          amount: candidate.amount,
          cashReceived: candidate.cashReceived,
          paymentStatus: candidate.paymentStatus,
          customerLabel: candidate.customerLabel,
          reason,
          date: candidate.date,
        };
      })
      .filter((candidate) => candidate.score >= (hasMissingInvoiceNumber ? 18 : 26))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const leftTime = left.date?.getTime() ?? Number.NEGATIVE_INFINITY;
        const rightTime = right.date?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (rightTime !== leftTime) return rightTime - leftTime;
        return COLLATOR.compare(left.invoiceNumber, right.invoiceNumber);
      })
      .slice(0, POTENTIAL_MATCH_LIMIT)
      .map((candidate) => ({
        invoiceNumber: candidate.invoiceNumber,
        score: candidate.score,
        amount: candidate.amount,
        cashReceived: candidate.cashReceived,
        paymentStatus: candidate.paymentStatus,
        customerLabel: candidate.customerLabel,
        reason: candidate.reason,
      }));

    const searchValues = [
      systemId,
      ...sortedSourceRows.flatMap((row) => [
        row.invoiceNumber,
        row.project,
        row.companyName,
        row.recipientName,
        row.recipientEmail,
        row.type,
      ]),
      ...invoices.map((invoice) => invoice.status),
      ...LINE_ITEM_CATEGORY_DEFINITIONS.map((category) => category.label),
      ...lineItemSummary.otherNotes,
      ...scoredCandidates.map((candidate) => candidate.invoiceNumber),
      ...scoredCandidates.map((candidate) => candidate.customerLabel),
    ];

    return {
      systemId,
      invoiceCount: sortedSourceRows.length,
      hasMissingInvoiceNumber,
      invoices,
      statuses,
      statusTokens,
      lineItemSummary,
      potentialMatches: scoredCandidates,
      searchIndex: normalizeText(searchValues.join(" ")),
    } satisfies DashboardRow;
  });

  return rows.sort((left, right) => COLLATOR.compare(left.systemId, right.systemId));
}

export default function InvoiceMatchDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const [invoiceRows, setInvoiceRows] = useState<InvoiceSourceRow[]>([]);
  const [quickBooksByInvoice, setQuickBooksByInvoice] = useState<Map<string, QuickBooksInvoice>>(new Map());

  const [invoiceDataset, setInvoiceDataset] = useState<UploadedDataset | null>(null);
  const [quickBooksDataset, setQuickBooksDataset] = useState<UploadedDataset | null>(null);

  const [isParsingInvoices, setIsParsingInvoices] = useState(false);
  const [isParsingQuickBooks, setIsParsingQuickBooks] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | "missing-invoice" | "with-potential">("all");
  const [sortBy, setSortBy] = useState<"system-asc" | "system-desc" | "invoice-qty-desc" | "potential-desc">(
    "system-asc"
  );

  const [pageSize, setPageSize] = useState("50");
  const [page, setPage] = useState(1);
  const [isRestoringPersistedState, setIsRestoringPersistedState] = useState(true);
  const hasRestoredPersistedStateRef = useRef(false);
  const hasShownPersistenceErrorRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadPersistedState = async () => {
      try {
        const persisted = await readPersistedDashboardState();
        if (cancelled || !persisted) return;

        setInvoiceDataset(deserializeDataset(persisted.invoiceDataset));
        setQuickBooksDataset(deserializeDataset(persisted.quickBooksDataset));
        setInvoiceRows(deserializeInvoiceRows(persisted.invoiceRows));
        setQuickBooksByInvoice(deserializeQuickBooksInvoices(persisted.quickBooksInvoices));
      } catch (error) {
        if (!cancelled && !hasShownPersistenceErrorRef.current) {
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be restored: ${message}`);
        }
      } finally {
        if (!cancelled) {
          hasRestoredPersistedStateRef.current = true;
          setIsRestoringPersistedState(false);
        }
      }
    };

    void loadPersistedState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasRestoredPersistedStateRef.current) return;
    if (typeof window === "undefined") return;

    const timer = window.setTimeout(() => {
      const shouldClearPersistedState =
        !invoiceDataset &&
        !quickBooksDataset &&
        invoiceRows.length === 0 &&
        quickBooksByInvoice.size === 0;

      if (shouldClearPersistedState) {
        void clearPersistedDashboardState().catch((error) => {
          if (hasShownPersistenceErrorRef.current) return;
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be cleared: ${message}`);
        });
        return;
      }

      const payload: PersistedDashboardState = {
        version: PERSISTENCE_VERSION,
        invoiceDataset: serializeDataset(invoiceDataset),
        quickBooksDataset: serializeDataset(quickBooksDataset),
        invoiceRows: serializeInvoiceRows(invoiceRows),
        quickBooksInvoices: serializeQuickBooksInvoices(quickBooksByInvoice),
      };

      void writePersistedDashboardState(payload)
        .then(() => {
          hasShownPersistenceErrorRef.current = false;
        })
        .catch((error) => {
          if (hasShownPersistenceErrorRef.current) return;
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be updated: ${message}`);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [invoiceDataset, quickBooksDataset, invoiceRows, quickBooksByInvoice]);

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, setLocation, user]);

  const rows = useMemo(
    () => buildDashboardRows(invoiceRows, quickBooksByInvoice),
    [invoiceRows, quickBooksByInvoice]
  );

  const availableStatuses = useMemo(() => {
    const statusMap = new Map<string, string>();
    rows.forEach((row) => {
      row.statuses.forEach((status) => {
        const token = normalizeText(status);
        if (!token) return;
        if (!statusMap.has(token)) {
          statusMap.set(token, status);
        }
      });
    });

    return Array.from(statusMap.entries())
      .sort((left, right) => COLLATOR.compare(left[1], right[1]))
      .map(([token, label]) => ({ token, label }));
  }, [rows]);

  const sortedRows = useMemo(() => {
    const sorted = [...rows];

    sorted.sort((left, right) => {
      if (sortBy === "system-asc") {
        return COLLATOR.compare(left.systemId, right.systemId);
      }

      if (sortBy === "system-desc") {
        return COLLATOR.compare(right.systemId, left.systemId);
      }

      if (sortBy === "invoice-qty-desc") {
        if (right.invoiceCount !== left.invoiceCount) return right.invoiceCount - left.invoiceCount;
        return COLLATOR.compare(left.systemId, right.systemId);
      }

      const leftScore = left.potentialMatches[0]?.score ?? Number.NEGATIVE_INFINITY;
      const rightScore = right.potentialMatches[0]?.score ?? Number.NEGATIVE_INFINITY;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return COLLATOR.compare(left.systemId, right.systemId);
    });

    return sorted;
  }, [rows, sortBy]);

  const filteredRows = useMemo(() => {
    const searchToken = normalizeText(searchTerm);

    return sortedRows.filter((row) => {
      if (statusFilter !== "all" && !row.statusTokens.includes(statusFilter)) {
        return false;
      }

      if (scopeFilter === "missing-invoice" && !row.hasMissingInvoiceNumber) {
        return false;
      }

      if (scopeFilter === "with-potential" && row.potentialMatches.length === 0) {
        return false;
      }

      if (!searchToken) return true;
      return row.searchIndex.includes(searchToken);
    });
  }, [searchTerm, sortedRows, statusFilter, scopeFilter]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, statusFilter, scopeFilter, sortBy, pageSize]);

  const numericPageSize = Math.max(1, Number(pageSize) || 50);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / numericPageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [page, safePage]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * numericPageSize;
    return filteredRows.slice(start, start + numericPageSize);
  }, [filteredRows, numericPageSize, safePage]);

  const maxInvoiceSlots = useMemo(() => {
    if (!filteredRows.length) return 1;
    return Math.max(1, ...filteredRows.map((row) => row.invoiceCount));
  }, [filteredRows]);

  const systemsWithPotentialMatches = useMemo(
    () => rows.filter((row) => row.potentialMatches.length > 0).length,
    [rows]
  );

  const systemsWithMissingInvoiceNumber = useMemo(
    () => rows.filter((row) => row.hasMissingInvoiceNumber).length,
    [rows]
  );

  const handleExportFilteredRows = () => {
    if (!filteredRows.length) {
      toast.error("No rows available to export.");
      return;
    }

    const baseHeaders = [
      "System ID",
      "Invoice Quantity",
      "Invoice Numbers",
      "Invoice Amounts",
      "Invoice Statuses (QuickBooks)",
      "Cash Received Total",
    ];

    const lineItemAmountHeaders = LINE_ITEM_CATEGORY_DEFINITIONS.map(
      (category) => `${category.label} Amount`
    );
    const lineItemInvoiceHeaders = LINE_ITEM_CATEGORY_DEFINITIONS.map(
      (category) => `${category.label} Invoices`
    );

    const potentialHeaders = Array.from({ length: POTENTIAL_MATCH_LIMIT }).flatMap((_, index) => [
      `Potential Match ${index + 1} Invoice`,
      `Potential Match ${index + 1} Score`,
      `Potential Match ${index + 1} Cash`,
      `Potential Match ${index + 1} Why`,
    ]);

    const headers = [
      ...baseHeaders,
      ...lineItemAmountHeaders,
      ...lineItemInvoiceHeaders,
      "Other Line Item Notes",
      ...potentialHeaders,
    ];

    const rowsForCsv = filteredRows.map((row) => {
      const record: Record<string, string | number | null> = {};
      const invoiceNumbers = row.invoices
        .map((invoice) => normalizeInvoiceReference(invoice.invoiceNumber))
        .join(" | ");
      const invoiceAmounts = row.invoices.map((invoice) => formatNumberForCsv(invoice.amount)).join(" | ");
      const invoiceStatuses = row.invoices.map((invoice) => clean(invoice.status)).join(" | ");
      const cashReceivedTotal = row.invoices.reduce((sum, invoice) => {
        if (invoice.cashReceived === null || !Number.isFinite(invoice.cashReceived)) return sum;
        return sum + invoice.cashReceived;
      }, 0);

      record["System ID"] = row.systemId;
      record["Invoice Quantity"] = row.invoiceCount;
      record["Invoice Numbers"] = invoiceNumbers;
      record["Invoice Amounts"] = invoiceAmounts;
      record["Invoice Statuses (QuickBooks)"] = invoiceStatuses;
      record["Cash Received Total"] = cashReceivedTotal.toFixed(2);

      LINE_ITEM_CATEGORY_DEFINITIONS.forEach((category) => {
        const amount = row.lineItemSummary.totals[category.key];
        const invoices = row.lineItemSummary.invoices[category.key];
        record[`${category.label} Amount`] = amount > 0 ? amount.toFixed(2) : "";
        record[`${category.label} Invoices`] = invoices.join(" | ");
      });

      record["Other Line Item Notes"] = row.lineItemSummary.otherNotes.join(" || ");

      Array.from({ length: POTENTIAL_MATCH_LIMIT }).forEach((_, index) => {
        const potential = row.potentialMatches[index];
        record[`Potential Match ${index + 1} Invoice`] = potential?.invoiceNumber ?? "";
        record[`Potential Match ${index + 1} Score`] = potential?.score ?? "";
        record[`Potential Match ${index + 1} Cash`] = formatNumberForCsv(potential?.cashReceived ?? null);
        record[`Potential Match ${index + 1} Why`] = potential?.reason ?? "";
      });

      return record;
    });

    const csv = buildCsv(headers, rowsForCsv);
    const fileName = `invoice-match-dashboard-export-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csv, "text/csv;charset=utf-8");
    toast.success(`Exported ${filteredRows.length.toLocaleString("en-US")} rows.`);
  };

  const handleInvoicesUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file for the invoices report.");
      return;
    }

    setIsParsingInvoices(true);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const nextInvoiceRows = parseInvoicesFile(parsed);

      setInvoiceRows(nextInvoiceRows);
      setInvoiceDataset({
        fileName: file.name,
        uploadedAt: new Date(),
        rowCount: nextInvoiceRows.length,
      });

      toast.success(`Invoices report loaded: ${nextInvoiceRows.length.toLocaleString("en-US")} rows.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse invoices report.";
      toast.error(message);
    } finally {
      setIsParsingInvoices(false);
    }
  };

  const handleQuickBooksUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file for the QuickBooks report.");
      return;
    }

    setIsParsingQuickBooks(true);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const nextQuickBooksByInvoice = parseQuickBooksFile(parsed);

      setQuickBooksByInvoice(nextQuickBooksByInvoice);
      setQuickBooksDataset({
        fileName: file.name,
        uploadedAt: new Date(),
        rowCount: nextQuickBooksByInvoice.size,
      });

      toast.success(
        `QuickBooks report loaded: ${nextQuickBooksByInvoice.size.toLocaleString("en-US")} invoice numbers.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse QuickBooks report.";
      toast.error(message);
    } finally {
      setIsParsingQuickBooks(false);
    }
  };

  const clearInvoices = () => {
    setInvoiceRows([]);
    setInvoiceDataset(null);
    setSearchTerm("");
    setStatusFilter("all");
    setScopeFilter("all");
    toast.success("Invoices report removed.");
  };

  const clearQuickBooks = () => {
    setQuickBooksByInvoice(new Map());
    setQuickBooksDataset(null);
    toast.success("QuickBooks report removed.");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  if (isRestoringPersistedState) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin" />
          Restoring saved invoice dashboard...
        </div>
      </div>
    );
  }

  const startIndex = filteredRows.length === 0 ? 0 : (safePage - 1) * numericPageSize + 1;
  const endIndex = Math.min(filteredRows.length, safePage * numericPageSize);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Invoice Match Dashboard</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload the invoices export plus the QuickBooks report, then search and filter by System ID.
            Potential matches only use QuickBooks invoices that are not already tied to another System ID.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Upload Reports</CardTitle>
            <CardDescription>
              You can replace either report at any time. The dashboard recalculates automatically after each upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Invoices Report (System ID Source)</p>
                <p className="text-xs text-slate-600">Example: Invoices-YYYY-MM-DD.csv</p>
              </div>

              <Label htmlFor="invoice-report-upload" className="text-xs uppercase tracking-wide text-slate-500">
                Upload CSV
              </Label>
              <Input
                id="invoice-report-upload"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void handleInvoicesUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                disabled={isParsingInvoices}
              />

              {isParsingInvoices && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Parsing invoices report...
                </div>
              )}

              {invoiceDataset ? (
                <div className="space-y-1 text-sm text-slate-700">
                  <p className="font-medium">{invoiceDataset.fileName}</p>
                  <p>{invoiceDataset.rowCount.toLocaleString("en-US")} system-linked invoice rows</p>
                  <p>Uploaded: {formatUploadedAt(invoiceDataset.uploadedAt)}</p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No invoices report uploaded yet.</p>
              )}

              <Button variant="outline" size="sm" onClick={clearInvoices} disabled={!invoiceDataset || isParsingInvoices}>
                <Trash2 className="h-4 w-4 mr-2" />
                Remove Invoices Report
              </Button>
            </div>

            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">QuickBooks Invoice Report (Cash + Potential Matches)</p>
                <p className="text-xs text-slate-600">Example: CARBON SOLUTIONS GROUP... Invoice Report.csv</p>
              </div>

              <Label htmlFor="quickbooks-report-upload" className="text-xs uppercase tracking-wide text-slate-500">
                Upload CSV
              </Label>
              <Input
                id="quickbooks-report-upload"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void handleQuickBooksUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                disabled={isParsingQuickBooks}
              />

              {isParsingQuickBooks && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Parsing QuickBooks report...
                </div>
              )}

              {quickBooksDataset ? (
                <div className="space-y-1 text-sm text-slate-700">
                  <p className="font-medium">{quickBooksDataset.fileName}</p>
                  <p>{quickBooksDataset.rowCount.toLocaleString("en-US")} invoice numbers</p>
                  <p>Uploaded: {formatUploadedAt(quickBooksDataset.uploadedAt)}</p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No QuickBooks report uploaded yet.</p>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={clearQuickBooks}
                disabled={!quickBooksDataset || isParsingQuickBooks}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove QuickBooks Report
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total System IDs</CardDescription>
              <CardTitle>{rows.length.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Filtered Results</CardDescription>
              <CardTitle>{filteredRows.length.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>With Potential Matches</CardDescription>
              <CardTitle>{systemsWithPotentialMatches.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Missing Invoice Number</CardDescription>
              <CardTitle>{systemsWithMissingInvoiceNumber.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>2) Search, Filter, and Export</CardTitle>
              <CardDescription>
                Search by System ID, project, company, recipient, invoice number, or potential match invoice.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              onClick={handleExportFilteredRows}
              disabled={!filteredRows.length}
              className="md:self-center"
            >
              <Download className="h-4 w-4 mr-2" />
              Export Filtered CSV
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="search-invoices">Search</Label>
              <Input
                id="search-invoices"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Type a System ID, invoice number, customer, or line item"
              />
            </div>

            <div className="space-y-2">
              <Label>Status Filter</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {availableStatuses.map((status) => (
                    <SelectItem key={status.token} value={status.token}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={scopeFilter}
                onValueChange={(value: "all" | "missing-invoice" | "with-potential") => setScopeFilter(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All rows</SelectItem>
                  <SelectItem value="missing-invoice">Missing invoice number</SelectItem>
                  <SelectItem value="with-potential">Has potential matches</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Sort</Label>
              <Select
                value={sortBy}
                onValueChange={(value: "system-asc" | "system-desc" | "invoice-qty-desc" | "potential-desc") =>
                  setSortBy(value)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system-asc">System ID (A to Z)</SelectItem>
                  <SelectItem value="system-desc">System ID (Z to A)</SelectItem>
                  <SelectItem value="invoice-qty-desc">Invoice quantity (high to low)</SelectItem>
                  <SelectItem value="potential-desc">Potential score (high to low)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Rows Per Page</Label>
              <Select value={pageSize} onValueChange={setPageSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="250">250</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) System ID Invoice Dashboard</CardTitle>
            <CardDescription>
              Each System ID row includes invoice details from the invoices report and optional QuickBooks potential
              matches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!invoiceDataset ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                Upload the invoices report first to populate System IDs.
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                No rows match the current filters.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="overflow-auto rounded-lg border border-slate-200 max-h-[65vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[140px]">System ID</TableHead>
                        <TableHead className="min-w-[120px]">Invoice Qty</TableHead>
                        {Array.from({ length: maxInvoiceSlots }).map((_, index) => (
                          <Fragment key={`invoice-columns-${index}`}>
                            <TableHead className="min-w-[140px]">Invoice #{index + 1}</TableHead>
                            <TableHead className="min-w-[140px]">Amount #{index + 1}</TableHead>
                            <TableHead className="min-w-[150px]">Status #{index + 1}</TableHead>
                            <TableHead className="min-w-[170px]">Cash Received #{index + 1}</TableHead>
                            <TableHead className="min-w-[260px]">Line Item #{index + 1}</TableHead>
                          </Fragment>
                        ))}
                        {LINE_ITEM_CATEGORY_DEFINITIONS.map((category) => (
                          <TableHead key={category.key} className="min-w-[230px]">
                            {category.label}
                          </TableHead>
                        ))}
                        {Array.from({ length: POTENTIAL_MATCH_LIMIT }).map((_, index) => (
                          <Fragment key={`potential-columns-${index}`}>
                            <TableHead className="min-w-[170px]">Potential #{index + 1} Invoice</TableHead>
                            <TableHead className="min-w-[130px]">Potential #{index + 1} Score</TableHead>
                            <TableHead className="min-w-[170px]">Potential #{index + 1} Cash</TableHead>
                            <TableHead className="min-w-[280px]">Potential #{index + 1} Why</TableHead>
                          </Fragment>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map((row) => (
                        <TableRow key={row.systemId}>
                          <TableCell className="font-semibold text-slate-900">{row.systemId}</TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <span>{row.invoiceCount}</span>
                              {row.hasMissingInvoiceNumber && (
                                <Badge className="w-fit bg-amber-100 text-amber-900 border-amber-200">
                                  Missing invoice #
                                </Badge>
                              )}
                            </div>
                          </TableCell>

                          {Array.from({ length: maxInvoiceSlots }).map((_, index) => {
                            const invoice = row.invoices[index];
                            return (
                              <Fragment key={`${row.systemId}-invoice-${index}`}>
                                <TableCell className="font-medium text-slate-900">
                                  {invoice?.invoiceNumber || "-"}
                                </TableCell>
                                <TableCell>{invoice ? formatCurrency(invoice.amount) : "-"}</TableCell>
                                <TableCell>
                                  {invoice?.status ? (
                                    <Badge className={getStatusClassName(invoice.status)}>{invoice.status}</Badge>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>{invoice ? formatCurrency(invoice.cashReceived) : "-"}</TableCell>
                                <TableCell className="max-w-[260px] align-top">
                                  {invoice ? (
                                    <div className="space-y-1">
                                      <p className="whitespace-pre-wrap break-words text-sm text-slate-900">
                                        {invoice.lineItem || "-"}
                                      </p>
                                      {invoice.quickBooksLineItemPreview &&
                                      invoice.quickBooksLineItemPreview !== invoice.lineItem ? (
                                        <p className="whitespace-pre-wrap break-words text-xs text-slate-500">
                                          QB: {invoice.quickBooksLineItemPreview}
                                        </p>
                                      ) : null}
                                    </div>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                              </Fragment>
                            );
                          })}

                          {LINE_ITEM_CATEGORY_DEFINITIONS.map((category) => {
                            const amount = row.lineItemSummary.totals[category.key];
                            const invoiceReferences = row.lineItemSummary.invoices[category.key];
                            return (
                              <TableCell key={`${row.systemId}-${category.key}`} className="max-w-[230px] align-top">
                                {amount > 0 || invoiceReferences.length > 0 ? (
                                  <div className="space-y-1">
                                    <p className="text-sm font-medium text-slate-900">
                                      {amount > 0 ? formatCurrency(amount) : "-"}
                                    </p>
                                    {invoiceReferences.length > 0 ? (
                                      <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">
                                        {invoiceReferences.join(", ")}
                                      </p>
                                    ) : null}
                                  </div>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                            );
                          })}

                          {Array.from({ length: POTENTIAL_MATCH_LIMIT }).map((_, index) => {
                            const match = row.potentialMatches[index];
                            return (
                              <Fragment key={`${row.systemId}-potential-${index}`}>
                                <TableCell>
                                  {match ? (
                                    <div className="space-y-1">
                                      <p className="font-medium text-slate-900">{match.invoiceNumber}</p>
                                      <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">
                                        {match.customerLabel}
                                      </p>
                                    </div>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>
                                  {match ? (
                                    <Badge
                                      className={
                                        match.score >= 70
                                          ? "bg-emerald-100 text-emerald-900 border-emerald-200"
                                          : match.score >= 45
                                            ? "bg-amber-100 text-amber-900 border-amber-200"
                                            : "bg-slate-100 text-slate-800 border-slate-200"
                                      }
                                    >
                                      {match.score}
                                    </Badge>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>{match ? formatCurrency(match.cashReceived) : "-"}</TableCell>
                                <TableCell className="max-w-[280px] whitespace-pre-wrap break-words text-xs text-slate-600">
                                  {match ? match.reason : "-"}
                                </TableCell>
                              </Fragment>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-slate-600">
                    Showing {startIndex.toLocaleString("en-US")}-{endIndex.toLocaleString("en-US")} of{" "}
                    {filteredRows.length.toLocaleString("en-US")} systems
                  </p>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={safePage <= 1}
                    >
                      Previous
                    </Button>
                    <p className="text-sm text-slate-700">
                      Page {safePage.toLocaleString("en-US")} of {totalPages.toLocaleString("en-US")}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={safePage >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How Matching Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>
              `System ID` rows only come from the invoices CSV. That file is the source of truth for existing
              associations.
            </p>
            <p>
              `Invoice Status` and `Cash Received` come only from the QuickBooks report. Cash received is estimated as
              `Amount - Open Balance` for the same invoice number.
            </p>
            <p>
              `Potential Match` columns only use QuickBooks invoice numbers that are not already tied to a different
              System ID in the invoices CSV.
            </p>
            <p>
              If a System ID has a missing invoice number, the matching score starts higher so those rows surface
              likely candidates first.
            </p>
            <p>
              Line items are normalized under fixed headers: Application Fee, 5% Collateral, Transfer Fee,
              Non-connection to internet fee, CC Fee, and Contract Cancellation Fee.
            </p>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Upload className="h-4 w-4" />
          Re-upload either CSV anytime to refresh this dashboard with newer rows, System IDs, and invoice numbers.
        </div>
      </main>
    </div>
  );
}
