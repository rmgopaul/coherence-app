/**
 * Shared runtime types for the Solar REC dashboard.
 *
 * Phase 1 seeds this module with the two types that ScheduleBImport,
 * csvIo, and the mergeScheduleRows / buildDeliveryTrackerData pipeline
 * all need in common. Additional dataset + remote-sync types will move
 * here in Phase 1 session 2 when useDashboardPersistence is extracted.
 */

/**
 * A single row from any uploaded CSV. Keys are header names, values
 * are raw cell strings (not parsed / not typed).
 */
export type CsvRow = Record<string, string>;

// ---------------------------------------------------------------------------
// Dataset infrastructure
// ---------------------------------------------------------------------------

export type DatasetKey =
  | "solarApplications"
  | "abpReport"
  | "generationEntry"
  | "accountSolarGeneration"
  | "contractedDate"
  | "convertedReads"
  | "annualProductionEstimates"
  | "generatorDetails"
  | "abpUtilityInvoiceRows"
  | "abpCsgSystemMapping"
  | "abpQuickBooksRows"
  | "abpProjectApplicationRows"
  | "abpPortalInvoiceMapRows"
  | "abpCsgPortalDatabaseRows"
  | "abpIccReport2Rows"
  | "abpIccReport3Rows"
  | "deliveryScheduleBase"
  | "transferHistory";

export type CsvDataset = {
  fileName: string;
  uploadedAt: Date;
  headers: string[];
  rows: CsvRow[];
  sources?: Array<{
    fileName: string;
    uploadedAt: Date;
    rowCount: number;
  }>;
};

// ---------------------------------------------------------------------------
// Enums / small union types
// ---------------------------------------------------------------------------

export type SizeBucket = "<=10 kW AC" | ">10 kW AC" | "Unknown";

export type OwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Not Transferred and Reporting"
  | "Not Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting";

export type ChangeOwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting"
  | "Change of Ownership - Not Transferred and Reporting"
  | "Change of Ownership - Not Transferred and Not Reporting";

// ---------------------------------------------------------------------------
// Core domain records
// ---------------------------------------------------------------------------

export type SystemRecord = {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: number | null;
  installedKwDc: number | null;
  sizeBucket: SizeBucket;
  recPrice: number | null;
  totalContractAmount: number | null;
  contractedRecs: number | null;
  deliveredRecs: number | null;
  contractedValue: number | null;
  deliveredValue: number | null;
  valueGap: number | null;
  latestReportingDate: Date | null;
  latestReportingKwh: number | null;
  isReporting: boolean;
  isTerminated: boolean;
  isTransferred: boolean;
  ownershipStatus: OwnershipStatus;
  hasChangedOwnership: boolean;
  changeOwnershipStatus: ChangeOwnershipStatus | null;
  contractStatusText: string;
  contractType: string | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  contractedDate: Date | null;
  monitoringType: string;
  monitoringPlatform: string;
  installerName: string;
  part2VerificationDate: Date | null;
};

export type MonitoringDetailsRecord = {
  online_monitoring_access_type: string;
  online_monitoring: string;
  online_monitoring_granted_username: string;
  online_monitoring_username: string;
  online_monitoring_system_name: string;
  online_monitoring_system_id: string;
  online_monitoring_password: string;
  online_monitoring_website_api_link: string;
  online_monitoring_entry_method: string;
  online_monitoring_notes: string;
  online_monitoring_self_report: string;
  online_monitoring_rgm_info: string;
  online_monitoring_no_submit_generation: string;
  system_online: string;
  last_reported_online_date: string;
};

// ---------------------------------------------------------------------------
// Offline Monitoring types
// ---------------------------------------------------------------------------

export type OfflineBreakdownRow = {
  key: string;
  label: string;
  totalSystems: number;
  offlineSystems: number;
  offlinePercent: number | null;
  offlineContractValue: number;
  totalContractValue: number;
  offlineContractValuePercent: number | null;
};

export type OfflineMonitoringAccessFields = {
  accessType: string;
  monitoringSiteId: string;
  monitoringSiteName: string;
  monitoringLink: string;
  monitoringUsername: string;
  monitoringPassword: string;
};

// ---------------------------------------------------------------------------
// Change Ownership summary (computed by the parent `changeOwnershipSummary`
// memo; consumed by the extracted ChangeOwnershipTab component and by the
// Overview tab tiles).
// ---------------------------------------------------------------------------

export type ChangeOwnershipSummaryCount = {
  status: ChangeOwnershipStatus;
  count: number;
  percent: number | null;
};

export type ChangeOwnershipSummary = {
  total: number;
  reporting: number;
  notReporting: number;
  reportingPercent: number | null;
  contractedValueTotal: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  counts: ChangeOwnershipSummaryCount[];
};

// ---------------------------------------------------------------------------
// Application Pipeline types
// ---------------------------------------------------------------------------

export type PipelineMonthRow = {
  month: string; // "YYYY-MM"
  part1Count: number;
  part2Count: number;
  part1KwAc: number;
  part2KwAc: number;
  interconnectedCount: number;
  interconnectedKwAc: number;
  prevPart1Count: number;
  prevPart2Count: number;
  prevPart1KwAc: number;
  prevPart2KwAc: number;
  prevInterconnectedCount: number;
  prevInterconnectedKwAc: number;
};

export type PipelineCashFlowRow = {
  month: string; // "YYYY-MM" — cash flow month (Part II month + 1)
  vendorFee: number;
  ccAuthCollateral: number;
  additionalCollateral: number;
  totalCashFlow: number;
  projectCount: number;
  prevVendorFee: number;
  prevCcAuthCollateral: number;
  prevAdditionalCollateral: number;
  prevTotalCashFlow: number;
  prevProjectCount: number;
};

/**
 * Minimal structural type for a contract scan result row as consumed by
 * the Pipeline cash flow aggregator and the Financials tab's profit /
 * collateralization calculator. The full tRPC return type is wider but
 * we only list the fields these callers actually read. All value fields
 * allow null because that's what the server returns for un-scanned /
 * un-overridden contracts.
 */
export type ContractScanResultRow = {
  csgId: string;
  vendorFeePercent?: number | null;
  overrideVendorFeePercent?: number | null;
  additionalCollateralPercent?: number | null;
  overrideAdditionalCollateralPercent?: number | null;
  ccAuthorizationCompleted?: boolean | null;
  // Financials-tab extras
  systemName?: string | null;
  overriddenAt?: Date | string | null;
  acSizeKw?: number | null;
};

// ---------------------------------------------------------------------------
// Financials tab types
// ---------------------------------------------------------------------------

/**
 * One row in the Financials profit/collateralization table. Computed
 * by the parent's `financialProfitData` useMemo (which is shared with
 * the Overview tab) and rendered by the extracted FinancialsTab.
 */
export type ProfitRow = {
  systemName: string;
  applicationId: string;
  csgId: string;
  grossContractValue: number;
  vendorFeePercent: number;
  vendorFeeAmount: number;
  utilityCollateral: number;
  additionalCollateralPercent: number;
  additionalCollateralAmount: number;
  ccAuth5Percent: number;
  applicationFee: number;
  totalDeductions: number;
  profit: number;
  totalCollateralization: number;
  // Validation: flag rows where collateral > 30% of GCV
  needsReview: boolean;
  reviewReason: string;
  hasOverride: boolean;
};

/**
 * The full output of the `financialProfitData` useMemo. The parent
 * computes it (gated on Financials + Overview tabs) and passes it to
 * the extracted FinancialsTab as a prop.
 */
export type FinancialProfitData = {
  rows: ProfitRow[];
  totalProfit: number;
  avgProfit: number;
  totalCollateralization: number;
  totalUtilityCollateral: number;
  totalAdditionalCollateral: number;
  totalCcAuth: number;
  systemsWithData: number;
};

// ---------------------------------------------------------------------------
// Performance-ratio types
// ---------------------------------------------------------------------------

export type PerformanceRatioMatchType =
  | "Monitoring + System ID + System Name"
  | "Monitoring + System ID"
  | "Monitoring + System Name";

export type PortalMonitoringCandidate = {
  key: string;
  system: SystemRecord;
  monitoringTokens: string[];
  idTokens: string[];
  nameTokens: string[];
};

export type ConvertedReadInputRow = {
  key: string;
  monitoring: string;
  monitoringNormalized: string;
  monitoringSystemId: string;
  monitoringSystemIdNormalized: string;
  monitoringSystemName: string;
  monitoringSystemNameNormalized: string;
  lifetimeReadWh: number | null;
  readDate: Date | null;
  readDateRaw: string;
};

export type GenerationBaseline = {
  valueWh: number | null;
  date: Date | null;
  source: "Generation Entry" | "Account Solar Generation";
};

export type AnnualProductionProfile = {
  trackingSystemRefId: string;
  facilityName: string;
  monthlyKwh: number[];
};

export type PerformanceRatioRow = {
  key: string;
  convertedReadKey: string;
  matchType: PerformanceRatioMatchType;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  readDate: Date | null;
  readDateRaw: string;
  lifetimeReadWh: number | null;
  trackingSystemRefId: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  portalAcSizeKw: number | null;
  abpAcSizeKw: number | null;
  part2VerificationDate: Date | null;
  baselineReadWh: number | null;
  baselineDate: Date | null;
  baselineSource: string | null;
  productionDeltaWh: number | null;
  expectedProductionWh: number | null;
  performanceRatioPercent: number | null;
  contractValue: number;
};

export type CompliantSourceEvidence = {
  id: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  objectUrl: string;
  uploadedAt: Date;
};

export type CompliantSourceEntry = {
  portalId: string;
  compliantSource: string;
  updatedAt: Date;
  evidence: CompliantSourceEvidence[];
};

export type CompliantSourceTableRow = {
  portalId: string;
  compliantSource: string;
  updatedAt: Date | null;
  evidence: CompliantSourceEvidence[];
  sourceType: "Manual" | "Auto";
};

export type CompliantPerformanceRatioRow = PerformanceRatioRow & {
  compliantSource: string | null;
  evidenceCount: number;
  meterReadMonthYear: string;
  readWindowMonthYear: string;
};
