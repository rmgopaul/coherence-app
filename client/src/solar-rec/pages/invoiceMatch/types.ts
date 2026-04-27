/**
 * Shared types for the Invoice Match Dashboard feature.
 *
 * Extracted from InvoiceMatchDashboard.tsx during refactoring. Consumed
 * by both the main component and the helpers module.
 */

export type UploadedDataset = {
  fileName: string;
  uploadedAt: Date;
  rowCount: number;
};

export type InvoiceSourceRow = {
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

export type QuickBooksLineItem = {
  lineOrder: number | null;
  description: string;
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
  customerFullName: string;
  customerCompany: string;
  date: Date | null;
  lineItems: QuickBooksLineItem[];
  lineItemPreview: string;
  tokens: string[];
};

export type InvoiceCell = {
  invoiceNumber: string;
  amount: number | null;
  status: string;
  cashReceived: number | null;
  lineItem: string;
  quickBooksLineItems: Array<{
    description: string;
    amount: number | null;
  }>;
};

export type PotentialMatch = {
  invoiceNumber: string;
  score: number;
  amount: number | null;
  cashReceived: number | null;
  paymentStatus: string;
  customerLabel: string;
  reason: string;
};

export const LINE_ITEM_CATEGORY_DEFINITIONS = [
  {
    key: "abpApplicationFee",
    label: "Application Fee",
  },
  {
    key: "utilityHeldCollateral5Percent",
    label: "5% Collateral",
  },
  {
    key: "ccFee",
    label: "CC Fee",
  },
] as const;

export type LineItemCategoryKey = (typeof LINE_ITEM_CATEGORY_DEFINITIONS)[number]["key"];

export type LineItemSummary = {
  totals: Record<LineItemCategoryKey, number>;
  invoices: Record<LineItemCategoryKey, string[]>;
  otherNotes: string[];
};

export type DashboardRow = {
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

export type PotentialCandidate = {
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

export type MatchScoreResult = {
  score: number;
  reason: string;
};

export type PersistedUploadedDataset = {
  fileName: string;
  uploadedAt: string;
  rowCount: number;
};

export type PersistedInvoiceSourceRow = Omit<InvoiceSourceRow, "updatedAt"> & {
  updatedAt: string | null;
};

export type PersistedQuickBooksInvoice = Omit<QuickBooksInvoice, "date"> & {
  date: string | null;
};

export type PersistedDashboardState = {
  version: number;
  invoiceDataset: PersistedUploadedDataset | null;
  quickBooksDataset: PersistedUploadedDataset | null;
  invoiceRows: PersistedInvoiceSourceRow[];
  quickBooksInvoices: PersistedQuickBooksInvoice[];
  csgLookupInput?: string;
  uploadedLookupCsgIds?: string[];
  lookupCsgDataset?: PersistedUploadedDataset | null;
};

export type CsgLookupRow = {
  csgId: string;
  invoiceNumber: string;
  applicationFeePaid: number | null;
  collateral5PercentPaid: number | null;
  ccFeePaid: number | null;
  totalAmountPaid: number | null;
  generalStatus: string;
};

// ---------------------------------------------------------------------------
// Shared constants used by helpers and component
// ---------------------------------------------------------------------------

export const COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

export const POTENTIAL_MATCH_LIMIT = 3;
export const AMOUNT_BUCKET_SIZE = 25;
export const PERSISTENCE_DB_NAME = "coherence-invoice-match-dashboard";
export const PERSISTENCE_STORE_NAME = "state";
export const PERSISTENCE_RECORD_KEY = "dashboard";
export const PERSISTENCE_VERSION = 1;

export const COMMON_TOKEN_STOPWORDS = new Set([
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
