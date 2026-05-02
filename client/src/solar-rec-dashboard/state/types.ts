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
  /**
   * Scalar row count. Reads `dataset.rowCount` for the Step 1 upload
   * UI badge + dashboard staleness/loaded checks instead of
   * `dataset.rows.length`, which forces full row materialization on
   * lazy datasets (see `buildLazyCsvDataset`). Task 5.14 PR-1.
   * Always equal to `rows.length` at construction time; the lazy
   * implementation guarantees the columnar source's `rowCount`
   * matches the eager-row materialization length, so a future PR
   * can drop the `rows` field without changing the value.
   */
  rowCount: number;
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
  | "Terminated"
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
 * computes it (gated on Financials/Pipeline tabs for the heavy
 * row-materializing path) and passes it to FinancialsTab + Overview
 * tab as a prop.
 *
 * `kpiDataAvailable` is the slim/heavy discriminator for the 4
 * Overview KPI tiles. PR #332 follow-up item 8 (2026-05-02): the
 * Overview mount no longer invokes the row-materializing
 * `getDashboardFinancials` aggregator. It reads only the
 * cache-only `getDashboardFinancialKpiSummary` proc, which returns
 * `available: false` when the side cache is cold. UI consumers MUST
 * render an explicit "—" / "N/A" placeholder when
 * `kpiDataAvailable === false` rather than treating the zeroed
 * fields as real values.
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
  kpiDataAvailable: boolean;
};

// ---------------------------------------------------------------------------
// REC performance spine — Tier 1 (Contracts + Annual Review)
// ---------------------------------------------------------------------------

/**
 * One row of the Contracts tab "Contract + Delivery Start Date Detail"
 * table. Computed by the extracted `ContractsTab` from the parent's
 * delivery schedule base + transfer history + price lookups.
 */
export type ContractDeliveryAggregate = {
  contractId: string;
  deliveryStartDate: Date | null;
  deliveryStartRaw: string;
  required: number;
  delivered: number;
  gap: number;
  deliveredPercent: number | null;
  requiredValue: number;
  deliveredValue: number;
  valueGap: number;
  valueDeliveredPercent: number | null;
  projectCount: number;
  pricedProjectCount: number;
};

/**
 * One row of the Annual Review tab vintage trend / summary table.
 * Computed by aggregating `AnnualContractVintageAggregate` rows
 * across all contracts.
 */
export type AnnualVintageAggregate = {
  deliveryStartDate: Date | null;
  deliveryStartRaw: string;
  label: string;
  projectCount: number;
  reportingProjectCount: number;
  reportingProjectPercent: number | null;
  required: number;
  delivered: number;
  gap: number;
  deliveredPercent: number | null;
  requiredValue: number;
  deliveredValue: number;
  valueGap: number;
  valueDeliveredPercent: number | null;
};

/**
 * One row of the Annual Review tab "Contract + Vintage Annual Detail"
 * table — the annual-review equivalent of `ContractDeliveryAggregate`
 * with extra reporting-project columns.
 */
export type AnnualContractVintageAggregate = {
  contractId: string;
  deliveryStartDate: Date | null;
  deliveryStartRaw: string;
  required: number;
  delivered: number;
  gap: number;
  deliveredPercent: number | null;
  requiredValue: number;
  deliveredValue: number;
  valueGap: number;
  valueDeliveredPercent: number | null;
  projectCount: number;
  reportingProjectCount: number;
  reportingProjectPercent: number | null;
};

// ---------------------------------------------------------------------------
// Alerts tab
// ---------------------------------------------------------------------------

export type AlertItem = {
  id: string;
  severity: "critical" | "warning" | "info";
  type: string;
  system: string;
  message: string;
  action: string;
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

// ---------------------------------------------------------------------------
// REC performance spine (Phase 9)
// ---------------------------------------------------------------------------

/**
 * One entry in a Schedule B row's 15-year delivery schedule. Each entry
 * carries the required + actually-delivered REC counts for the year,
 * plus the start/end date boundaries in both parsed and raw form.
 */
export type ScheduleYearEntry = {
  yearIndex: number;
  required: number;
  delivered: number;
  startDate: Date | null;
  endDate: Date | null;
  startRaw: string;
  endRaw: string;
  key: string;
};

/**
 * One row of the REC performance spine. This is the join of a Schedule B
 * row with a system's tracking info + its 15-year delivery entries,
 * plus the energy year of the system's first REC transfer (used to
 * determine which delivery year the system is actually in). Consumed
 * by the Forecast, Performance Evaluation, and Snapshot Log tabs.
 */
export type PerformanceSourceRow = {
  key: string;
  contractId: string;
  systemId: string | null;
  trackingSystemRefId: string;
  systemName: string;
  batchId: string | null;
  recPrice: number | null;
  years: ScheduleYearEntry[];
  /**
   * The energy year of the system's first positive REC transfer to a
   * utility, derived from `transferDeliveryLookup`. `null` = no
   * transfers found. Used to determine which delivery year the system
   * is actually in (independent of the Schedule B's `yearIndex`, which
   * may not be adjusted).
   */
  firstTransferEnergyYear: number | null;
};

/**
 * The result of `deriveRecPerformanceThreeYearValues()` — a system's
 * rolling 3-year actual/expected REC delivery window used by both the
 * Performance Evaluation and Forecast tabs.
 */
export type RecPerformanceThreeYearValues = {
  scheduleYearNumber: number;
  deliveryYearOne: number;
  deliveryYearTwo: number;
  deliveryYearThree: number;
  deliveryYearOneSource: "Actual" | "Expected";
  deliveryYearTwoSource: "Actual" | "Expected";
  deliveryYearThreeSource: "Actual" | "Expected";
  rollingAverage: number;
  expectedRecs: number;
};

/**
 * One row in the REC Performance Evaluation results table. Produced
 * by the parent's `recPerformanceEvaluation` memo from a
 * `PerformanceSourceRow` via `deriveRecPerformanceThreeYearValues()`
 * plus surplus-allocation accounting.
 */
export type RecPerformanceResultRow = {
  key: string;
  applicationId: string;
  unitId: string;
  batchId: string;
  systemName: string;
  contractId: string;
  /** Which year in this system's schedule DY3 corresponds to (1–15). */
  scheduleYearNumber: number;
  deliveryYearOne: number;
  deliveryYearTwo: number;
  deliveryYearThree: number;
  deliveryYearOneSource: "Actual" | "Expected";
  deliveryYearTwoSource: "Actual" | "Expected";
  deliveryYearThreeSource: "Actual" | "Expected";
  rollingAverage: number;
  contractPrice: number | null;
  expectedRecs: number;
  surplusShortfall: number;
  allocatedRecs: number;
  drawdownPayment: number;
};

/**
 * Per-contract summary row on the REC Performance Evaluation tab's
 * "Current Year 3-Year Rolling Summary by Contract" card. Aggregates
 * the per-system results across all systems under the same contract.
 */
export type RecPerformanceContractYearSummaryRow = {
  contractId: string;
  systemsInThreeYearReview: number;
  totalRecDeliveryObligation: number;
  totalDeliveriesFromThreeYearReview: number;
  recDelta: number;
  totalDrawdownAmount: number;
};

/**
 * One entry in the dashboard snapshot log — a point-in-time capture
 * of portfolio metrics, dataset manifest, COO statuses, and REC
 * performance shortfall data. Created by `createLogEntry()` and
 * rendered by the Snapshot Log tab. Persisted via
 * `serializeDashboardLogs` + `deserializeDashboardLogs`.
 */
export type DashboardLogEntry = {
  id: string;
  createdAt: Date;
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  changeOwnershipSystems: number;
  changeOwnershipPercent: number | null;
  transferredReporting: number;
  transferredNotReporting: number;
  terminatedReporting: number;
  terminatedNotReporting: number;
  changedNotTransferredReporting: number;
  changedNotTransferredNotReporting: number;
  totalContractedValue: number;
  totalDeliveredValue: number;
  totalGap: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;
  datasets: Array<{
    key: DatasetKey;
    label: string;
    fileName: string;
    rows: number;
    updatedAt: Date;
  }>;
  cooStatuses: Array<{
    key: string;
    systemName?: string;
    status: ChangeOwnershipStatus;
  }>;
  recPerformanceContracts2025: Array<{
    contractId: string;
    deliveryYearLabel: string;
    requiredToAvoidShortfallRecs: number;
    deliveredTowardShortfallRecs: number;
    deliveredPercentOfRequired: number | null;
    unallocatedShortfallRecs: number;
  }>;
};
