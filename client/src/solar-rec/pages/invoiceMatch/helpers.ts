/**
 * Pure helper functions for the Invoice Match Dashboard.
 *
 * Extracted from InvoiceMatchDashboard.tsx — all byte-identical to the
 * original. No component state, hooks, or JSX lives here.
 */

import { clean, formatCurrency } from "@/lib/helpers";
import {
  type ParsedTabularData,
  type CsvRow,
  normalizeHeader,
  parseNumber,
  parseDate,
  parseCsvMatrix,
  matrixToParsedTabularData,
} from "@/lib/csvParsing";
import {
  AMOUNT_BUCKET_SIZE,
  COLLATOR,
  COMMON_TOKEN_STOPWORDS,
  LINE_ITEM_CATEGORY_DEFINITIONS,
  PERSISTENCE_DB_NAME,
  PERSISTENCE_RECORD_KEY,
  PERSISTENCE_STORE_NAME,
  PERSISTENCE_VERSION,
  POTENTIAL_MATCH_LIMIT,
  type DashboardRow,
  type InvoiceCell,
  type InvoiceSourceRow,
  type LineItemCategoryKey,
  type LineItemSummary,
  type MatchScoreResult,
  type PersistedDashboardState,
  type PersistedInvoiceSourceRow,
  type PersistedQuickBooksInvoice,
  type PersistedUploadedDataset,
  type PotentialCandidate,
  type PotentialMatch,
  type QuickBooksInvoice,
  type QuickBooksLineItem,
  type UploadedDataset,
} from "./types";

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

let persistenceDbPromise: Promise<IDBDatabase> | null = null;

export function dateToIso(value: Date | null): string | null {
  if (!value) return null;
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return value.toISOString();
}

export function isoToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

export function serializeDataset(dataset: UploadedDataset | null): PersistedUploadedDataset | null {
  if (!dataset) return null;
  return {
    fileName: dataset.fileName,
    uploadedAt: dateToIso(dataset.uploadedAt) ?? new Date().toISOString(),
    rowCount: dataset.rowCount,
  };
}

export function deserializeDataset(dataset: PersistedUploadedDataset | null | undefined): UploadedDataset | null {
  if (!dataset) return null;
  const uploadedAt = isoToDate(dataset.uploadedAt);
  if (!uploadedAt) return null;
  return {
    fileName: clean(dataset.fileName),
    uploadedAt,
    rowCount: Number.isFinite(dataset.rowCount) ? dataset.rowCount : 0,
  };
}

export function serializeInvoiceRows(rows: InvoiceSourceRow[]): PersistedInvoiceSourceRow[] {
  return rows.map((row) => ({
    ...row,
    updatedAt: dateToIso(row.updatedAt),
  }));
}

export function deserializeInvoiceRows(rows: PersistedInvoiceSourceRow[] | null | undefined): InvoiceSourceRow[] {
  if (!rows?.length) return [];
  return rows.map((row) => ({
    ...row,
    updatedAt: isoToDate(row.updatedAt),
  }));
}

export function serializeQuickBooksInvoices(
  quickBooksByInvoice: Map<string, QuickBooksInvoice>
): PersistedQuickBooksInvoice[] {
  return Array.from(quickBooksByInvoice.values()).map((invoice) => ({
    ...invoice,
    date: dateToIso(invoice.date),
  }));
}

export function deserializeQuickBooksInvoices(
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

export function readPersistedDashboardState(): Promise<PersistedDashboardState | null> {
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

export function writePersistedDashboardState(payload: PersistedDashboardState): Promise<void> {
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

export function clearPersistedDashboardState(): Promise<void> {
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

// ---------------------------------------------------------------------------
// Text normalization & tokenization
// ---------------------------------------------------------------------------

export function normalizeText(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCsv(text: string): ParsedTabularData {
  return matrixToParsedTabularData(parseCsvMatrix(text));
}

export function tokenize(values: string[]): string[] {
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

export function formatQuickBooksLineItemText(lineItem: QuickBooksLineItem): string {
  const description = clean(lineItem.description) || "Unlabeled line item";
  if (lineItem.amount === null || !Number.isFinite(lineItem.amount)) return description;
  return `${description} (${formatCurrency(lineItem.amount)})`;
}

export function formatUploadedAt(value: Date | null): string {
  if (!value) return "-";
  return value.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// CSV building
// ---------------------------------------------------------------------------

function buildCsvEscapedCell(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function buildCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  const headerRow = headers.map((header) => buildCsvEscapedCell(header)).join(",");
  const bodyRows = rows.map((row) =>
    headers.map((header) => buildCsvEscapedCell(row[header])).join(",")
  );
  return [headerRow, ...bodyRows].join("\n");
}

// ---------------------------------------------------------------------------
// Line item category helpers
// ---------------------------------------------------------------------------

export function createEmptyLineItemTotals(): Record<LineItemCategoryKey, number> {
  return LINE_ITEM_CATEGORY_DEFINITIONS.reduce(
    (accumulator, category) => ({
      ...accumulator,
      [category.key]: 0,
    }),
    {} as Record<LineItemCategoryKey, number>
  );
}

export function createEmptyLineItemInvoiceSets(): Record<LineItemCategoryKey, Set<string>> {
  return LINE_ITEM_CATEGORY_DEFINITIONS.reduce(
    (accumulator, category) => ({
      ...accumulator,
      [category.key]: new Set<string>(),
    }),
    {} as Record<LineItemCategoryKey, Set<string>>
  );
}

export function formatNumberForCsv(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

export function formatCurrencyOrDash(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return formatCurrency(value);
}

export function normalizeInvoiceReference(invoiceNumber: string): string {
  const normalized = clean(invoiceNumber);
  return normalized || "(missing invoice #)";
}

export function parseCsgIdsFromText(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;\n\t]+/g)
        .map((entry) => clean(entry))
        .filter(Boolean)
    )
  );
}

export function parseCsgIdsFile(parsed: ParsedTabularData): string[] {
  if (!parsed.matrix.length) return [];

  const headerLookup = buildHeaderLookup(parsed.headers);
  const candidates = [
    "CSG ID",
    "CSG IDs",
    "CSGID",
    "ID",
    "System ID",
    "System IDs",
    "System_Id",
    "system_id",
  ];

  const ids: string[] = [];
  const seen = new Set<string>();

  const pushId = (value: string) => {
    const next = clean(value);
    if (!next || seen.has(next)) return;
    seen.add(next);
    ids.push(next);
  };

  const readUsingHeaders = () => {
    parsed.rows.forEach((row) => {
      const value = readByHeaderOptions(row, headerLookup, candidates);
      if (value) pushId(value);
    });
  };

  const hasKnownHeader = hasAnyHeader(headerLookup, candidates);
  if (hasKnownHeader) {
    readUsingHeaders();
    return ids;
  }

  // Fallback: single-column or headerless CSV where first column is the CSG ID list.
  parsed.matrix.forEach((row) => {
    const firstCell = clean(row[0]);
    if (!firstCell) return;
    const normalized = normalizeHeader(firstCell);
    if (normalized === "csgid" || normalized === "systemid" || normalized === "id") return;
    pushId(firstCell);
  });

  return ids;
}

function addCategoryAmount(
  totals: Record<LineItemCategoryKey, number>,
  category: LineItemCategoryKey,
  amount: number | null
): void {
  if (amount === null || !Number.isFinite(amount)) return;
  const normalizedAmount = category === "ccFee" ? Math.abs(amount) : amount;
  totals[category] += normalizedAmount;
}

export function summarizeInvoiceCategoryTotals(
  invoice: InvoiceCell | undefined
): Record<LineItemCategoryKey, number> {
  const totals = createEmptyLineItemTotals();
  if (!invoice) return totals;

  if (invoice.quickBooksLineItems.length > 0) {
    invoice.quickBooksLineItems.forEach((lineItem) => {
      const categories = detectLineItemCategories(lineItem.description);
      if (categories.length === 1) {
        addCategoryAmount(totals, categories[0], lineItem.amount);
      }
    });

    return totals;
  }

  const fallbackCategories = detectLineItemCategories(invoice.lineItem);
  if (fallbackCategories.length === 1) {
    addCategoryAmount(totals, fallbackCategories[0], invoice.amount);
  }

  return totals;
}

export function detectLineItemCategories(value: string): LineItemCategoryKey[] {
  const raw = clean(value).toLowerCase();
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const categories: LineItemCategoryKey[] = [];

  if (
    /\bapplication fee\b/.test(normalized) ||
    /\bapp fee\b/.test(normalized) ||
    /\babp application fee\b/.test(normalized) ||
    /\bnon refundable\b.*\b(app|application)\b.*\bfee\b/.test(normalized) ||
    /\bnonrefundable\b.*\b(app|application)\b.*\bfee\b/.test(normalized) ||
    /\bnon refundable\b.*\bfee\b/.test(normalized) ||
    /\bnonrefundable\b.*\bfee\b/.test(normalized) ||
    /(10|20)\s*\/\s*kw\s*(ac\s*)?(app|application)/.test(raw) ||
    /\b(10|20)\s*kw\b.*\b(app|application)\b/.test(normalized) ||
    /(10|20)\s*\/\s*kw\s*(non refundable|non-refundable)/.test(raw)
  ) {
    categories.push("abpApplicationFee");
  }

  if (
    /5\s*%\s*(utility held\s*)?(abp\s*)?(collateral|bond)/.test(raw) ||
    /\b5\b\s*(utility held\s*)?(abp\s*)?(collateral|bond)\b/.test(normalized) ||
    /\butility held collateral\b/.test(normalized) ||
    /\b5%?\s*bond\b/.test(normalized)
  ) {
    categories.push("utilityHeldCollateral5Percent");
  }

  if (
    /3\s*%\s*(cc|credit card)/.test(raw) ||
    /\b3\b\s*(cc|credit card)\b/.test(normalized) ||
    /\bcc\s*fee\b/.test(normalized) ||
    /\bcredit card fee\b/.test(normalized)
  ) {
    categories.push("ccFee");
  }

  return Array.from(new Set(categories));
}

export function getQuickBooksInvoiceStatus(invoice: QuickBooksInvoice | undefined): string {
  if (!invoice) return "Missing in QuickBooks";
  if (normalizeText(invoice.voided) === "yes") return "Voided";
  const paymentStatus = clean(invoice.paymentStatus);
  return paymentStatus || "Unknown";
}

export function getStatusClassName(status: string): string {
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

// ---------------------------------------------------------------------------
// Header lookup helpers
// ---------------------------------------------------------------------------

export function buildHeaderLookup(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  headers.forEach((header) => {
    map.set(normalizeHeader(header), header);
  });
  return map;
}

export function hasAnyHeader(headerLookup: Map<string, string>, options: string[]): boolean {
  return options.some((option) => headerLookup.has(normalizeHeader(option)));
}

export function readByHeaderOptions(
  row: CsvRow,
  headerLookup: Map<string, string>,
  options: string[]
): string {
  for (const option of options) {
    const actual = headerLookup.get(normalizeHeader(option));
    if (!actual) continue;
    return clean(row[actual]);
  }
  return "";
}

// ---------------------------------------------------------------------------
// File parsers
// ---------------------------------------------------------------------------

export function parseInvoicesFile(parsed: ParsedTabularData): InvoiceSourceRow[] {
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

export function parseQuickBooksFile(parsed: ParsedTabularData): Map<string, QuickBooksInvoice> {
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

  const headers = parsed.matrix[headerRowIndex].map(
    (entry, index) => clean(entry) || `column_${index + 1}`
  );
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

    const descriptionPrimary = readByHeaderOptions(row, headerLookup, [
      "Product/service description",
      "Product Service Description",
      "Description",
    ]);
    const descriptionSecondary = readByHeaderOptions(row, headerLookup, [
      "Product/Service",
      "Product Service",
      "Service Item",
    ]);
    const description = descriptionPrimary || descriptionSecondary;
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

// ---------------------------------------------------------------------------
// Matching & scoring
// ---------------------------------------------------------------------------

export function buildAmountBucket(amount: number): number {
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

// ---------------------------------------------------------------------------
// Dashboard row builder
// ---------------------------------------------------------------------------

export function buildDashboardRows(
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
        const normalizedAmount = category === "ccFee" ? Math.abs(amount) : amount;
        lineItemTotals[category] += normalizedAmount;
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

      const quickBooksLineItems =
        quickBooksMatch?.lineItems.length
          ? quickBooksMatch.lineItems.map((lineItem) => {
              const detectedCategories = detectLineItemCategories(lineItem.description);
              const normalizedAmount =
                detectedCategories.includes("ccFee") && lineItem.amount !== null
                  ? Math.abs(lineItem.amount)
                  : lineItem.amount;
              return {
                description: clean(lineItem.description) || "Unlabeled line item",
                amount: normalizedAmount,
              };
            })
          : clean(source.type)
            ? [{ description: clean(source.type), amount: source.amount }]
            : [];

      return {
        invoiceNumber: source.invoiceNumber,
        amount: source.amount,
        status,
        cashReceived: quickBooksMatch?.cashReceived ?? null,
        lineItem: source.type,
        quickBooksLineItems,
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
