/**
 * Shared local types for AbpInvoiceSettlement extracted helpers.
 * These mirror the types defined in AbpInvoiceSettlement.tsx so that the
 * utils modules can be self-contained.
 */

export type RunInputs = {
  utilityInvoiceFiles: string[];
  csgSystemMappingFile: string | null;
  quickBooksFile: string | null;
  paymentsReportFile: string | null;
  projectApplicationFile: string | null;
  portalInvoiceMapFile: string | null;
  csgPortalDatabaseFile: string | null;
  payeeUpdateFile: string | null;
};

export type InvoiceMapHeaderSelectionState = {
  csgIdHeader: string | null;
  invoiceNumberHeader: string | null;
};

export type ContractScanResult = {
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
