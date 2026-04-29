import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, Database, Upload } from "lucide-react";
import jsPDF from "jspdf";
import autoTable, { type CellHookData } from "jspdf-autotable";
// recharts — all chart components were moved into their individual
// tab components during Phase 1-9.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
// Table primitives + Sheet — removed in Phases 11–12; the only
// remaining parent-level table consumers were the SystemDetailSheet
// (now its own component) and chart memos that moved into tabs.
import { trpc } from "@/lib/trpc";
// Task 5.5 (2026-04-26): solarRecDashboard.* moved to the standalone
// Solar REC router. The abpSettlement call sites stay on `trpc`
// (their migration is Task 5.9); dashboard procedures use the
// standalone client.
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";

const TabAIChatLazy = lazy(() =>
  import("@/components/dashboard/TabAIChat").then((m) => ({
    default: m.TabAIChat,
  }))
);
const PerformanceRatioTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/PerformanceRatioTab")
);
const OfflineMonitoringTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/OfflineMonitoringTab")
);
const ChangeOwnershipTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/ChangeOwnershipTab")
);
const OwnershipTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/OwnershipTab")
);
const AppPipelineTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/AppPipelineTab")
);
const FinancialsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/FinancialsTab")
);
const ContractsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/ContractsTab")
);
const AnnualReviewTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/AnnualReviewTab")
);
const TrendsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/TrendsTab")
);
const AlertsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/AlertsTab")
);
const ComparisonsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/ComparisonsTab")
);
const DataQualityTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/DataQualityTab")
);
const OverviewTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/OverviewTab")
);
const SizeReportingTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/SizeReportingTab")
);
const RecValueTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/RecValueTab")
);
const MeterReadsTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/MeterReadsTab")
);
const DeliveryTrackerTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/DeliveryTrackerTab")
);
const ForecastTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/ForecastTab")
);
const RecPerformanceEvaluationTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/RecPerformanceEvaluationTab")
);
const SnapshotLogTabLazy = lazy(
  () => import("@/solar-rec-dashboard/components/SnapshotLogTab")
);
const SystemDetailSheetLazy = lazy(
  () => import("@/solar-rec-dashboard/components/SystemDetailSheet")
);
import { clean, formatPercent } from "@/lib/helpers";
import { parseTabularFile } from "@/lib/csvParsing";
import {
  EMPTY_DELIVERY_TRACKER_DATA,
} from "@/solar-rec-dashboard/lib/buildDeliveryTrackerData";
import { useSystemSnapshot } from "@/solar-rec-dashboard/hooks/useSystemSnapshot";
import { useTransferDeliveryLookup } from "@/solar-rec-dashboard/hooks/useTransferDeliveryLookup";
// Phase 3 of the IndexedDB-removal refactor (docs/server-side-
// dashboard-refactor.md): the v2 server-side upload button. ONE
// dataset (`contractedDate`) is wired through it in this PR;
// Phase 4 expands to the other 17.
import { DatasetUploadV2Button } from "@/solar-rec-dashboard/components/DatasetUploadV2Button";
// transferHistoryDeliveries helpers are now used only by
// @/solar-rec-dashboard/lib/buildSystems (worker-side).
import type {
  AnnualContractVintageAggregate,
  AnnualProductionProfile,
  AnnualVintageAggregate,
  ChangeOwnershipStatus,
  ChangeOwnershipSummary,
  ContractDeliveryAggregate,
  CsvDataset,
  CsvRow,
  DashboardLogEntry,
  DatasetKey,
  FinancialProfitData,
  GenerationBaseline,
  MonitoringDetailsRecord,
  OfflineBreakdownRow,
  OwnershipStatus,
  PerformanceSourceRow,
  PipelineCashFlowRow,
  PipelineMonthRow,
  ProfitRow,
  ScheduleYearEntry,
  SizeBucket,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";
import {
  buildCsv,
  matchesExpectedHeaders,
  parseCsv,
  timestampForCsvFileName,
  toCsvFileSlug,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import { base64ToBytes, bytesToBase64 } from "@/solar-rec-dashboard/lib/binaryEncoding";
import {
  buildColumnarFromRows,
  buildLazyCsvDataset,
  getDatasetColumnarSource,
} from "@/solar-rec-dashboard/lib/lazyDataset";
import { resolveHydrationKeys } from "@/solar-rec-dashboard/lib/hydrationKeys";
import { isSolarRecDebugEnabled } from "@/solar-rec-dashboard/lib/debugFlag";
import {
  HYDRATE_LOG_PREFIX_CLOUD,
  HYDRATE_LOG_PREFIX_IDB,
  toUserFacingHydrationMessage,
  type PerDatasetErrorMap,
} from "@/solar-rec-dashboard/lib/hydrationErrors";
import { ScheduleBImport } from "@/solar-rec-dashboard/components/ScheduleBImport";
// Phase 5a (2026-04-28): ParityReportPanel deleted — it was a
// dev-only IDB-vs-server diff probe. With IDB no longer used at
// runtime, the parity report has no two sources to compare.
import {
  COO_TARGET_STATUS,
  LEGACY_DATASETS_STORAGE_KEY,
  LOGS_STORAGE_KEY,
  DASHBOARD_DB_NAME,
  DASHBOARD_DB_VERSION,
  DASHBOARD_DATASETS_STORE,
  DASHBOARD_DATASETS_RECORD_KEY,
  DASHBOARD_DATASETS_MANIFEST_KEY,
  DASHBOARD_LOGS_RECORD_KEY,
  OWNERSHIP_ORDER,
  CHANGE_OWNERSHIP_ORDER,
  SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL,
  MAX_REMOTE_STATE_LOG_BYTES,
  REMOTE_LOG_ENTRY_LIMIT,
  REMOTE_DATASET_CHUNK_CHAR_LIMIT,
  REMOTE_LOG_SYNC_MAX_CHUNKS,
  MAX_LOCAL_LOG_STORAGE_CHARS,
  REMOTE_DATASET_KEY_MANIFEST,
  REMOTE_SNAPSHOT_LOGS_KEY,
  MAX_SINGLE_CSV_UPLOAD_BYTES,
  DASHBOARD_TAB_VALUES,
  DEFAULT_DASHBOARD_TAB,
  DASHBOARD_TAB_VALUE_SET,
} from "@/solar-rec-dashboard/lib/constants";
import {
  resolvePart2ProjectIdentity,
  getCsvValueByHeader,
  resolveLastMeterReadRawValue,
  parseNumber,
  parseDate,
  parsePart2VerificationDate,
  isPart2VerifiedAbpRow,
  parseAbpAcSizeKw,
  formatNumber,
  roundMoney,
  toPercentValue,
  isStaleUpload,
  maxDate,
  resolveContractValueAmount,
  resolveValueGapAmount,
  buildAnnualProductionByTrackingId,
  buildGenerationBaselineByTrackingId,
  getMonitoringDetailsForSystem,
  createLogId,
  classifyMonitoringAccessType,
  resolveOfflineMonitoringAccessFields,
  ownershipBadgeClass,
  changeOwnershipBadgeClass,
  buildDeliveryYearLabel,
} from "@/solar-rec-dashboard/lib/helpers";


// DatasetKey, OwnershipStatus, ChangeOwnershipStatus, SizeBucket, CsvDataset
// — moved to @/solar-rec-dashboard/state/types

// ContractDeliveryAggregate — moved to @/solar-rec-dashboard/state/types

// TransitionStatus, SnapshotMetricRow — moved to
// @/solar-rec-dashboard/components/SnapshotLogTab (local to that file)

// PipelineMonthRow, PipelineCashFlowRow — moved to @/solar-rec-dashboard/state/types

// AnnualVintageAggregate, AnnualContractVintageAggregate — moved to @/solar-rec-dashboard/state/types

// DashboardLogEntry — moved to @/solar-rec-dashboard/state/types
// (shared with the Snapshot Log tab)

// ScheduleYearEntry, PerformanceSourceRow, RecPerformanceThreeYearValues
// — moved to @/solar-rec-dashboard/state/types (shared with
// ForecastTab, RecPerformanceEvaluationTab, and SnapshotLogTab).

// RecPerformanceResultRow, RecPerformanceContractYearSummaryRow
// — moved to @/solar-rec-dashboard/state/types

// OfflineBreakdownRow — moved to @/solar-rec-dashboard/state/types

type SystemBuilder = {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  primaryName: string | null;
  names: Set<string>;
  installedKwAc: number | null;
  installedKwDc: number | null;
  recPrice: number | null;
  totalContractAmount: number | null;
  annualRecs: number | null;
  recsOnContract: number | null;
  recsDeliveredQty: number | null;
  scheduleRequired: number | null;
  scheduleDelivered: number | null;
  latestGenerationDate: Date | null;
  latestGenerationReadDate: Date | null;
  latestGenerationReadWh: number | null;
  lastRecDeliveredGenerationDate: Date | null;
  contractedDate: Date | null;
  contractType: string | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  transferSeen: boolean;
  statusText: string;
  monitoringType: string | null;
  monitoringPlatform: string | null;
  installerName: string | null;
  part2VerificationDate: Date | null;
};

// SystemRecord — moved to @/solar-rec-dashboard/state/types

type OwnershipOverviewExportRow = {
  key: string;
  part2ProjectName: string;
  part2ApplicationId: string | null;
  part2SystemId: string | null;
  part2TrackingId: string | null;
  source: "Matched System" | "Part II Unmatched";
  systemName: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  ownershipStatus: OwnershipStatus;
  isReporting: boolean;
  isTransferred: boolean;
  isTerminated: boolean;
  contractType: string | null;
  contractStatusText: string;
  latestReportingDate: Date | null;
  contractedDate: Date | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
};

// MonitoringDetailsRecord — moved to @/solar-rec-dashboard/state/types

// OfflineMonitoringAccessFields — moved to @/solar-rec-dashboard/state/types

// PerformanceRatioMatchType, PortalMonitoringCandidate, ConvertedReadInputRow,
// GenerationBaseline, AnnualProductionProfile, PerformanceRatioRow,
// CompliantSourceEvidence, CompliantSourceEntry
// — moved to @/solar-rec-dashboard/state/types

// CompliantSourceTableRow, CompliantPerformanceRatioRow — moved to @/solar-rec-dashboard/state/types

const DATASET_DEFINITIONS: Record<
  DatasetKey,
  {
    label: string;
    description: string;
    requiredHeaderSets: string[][];
  }
> = {
  solarApplications: {
    label: "Solar Applications",
    description: "Main system list with system size, price, and contract status.",
    requiredHeaderSets: [
      ["system_id", "system_name", "tracking_system_ref_id"],
      ["Application_ID", "Project_Name", "PJM_GATS_or_MRETS_Unit_ID_Part_2"],
    ],
  },
  abpReport: {
    label: "ABP Report",
    description: "Filter source: only rows with Part_2_App_Verification_Date are included in analysis.",
    requiredHeaderSets: [
      ["Part_2_App_Verification_Date", "Application_ID"],
      ["Part_2_App_Verification_Date", "system_id"],
    ],
  },
  generationEntry: {
    label: "Generation Entry",
    description: "Generation status and latest month of generation by GATS unit.",
    requiredHeaderSets: [["Unit ID", "Facility Name", "Last Month of Gen"]],
  },
  accountSolarGeneration: {
    label: "Account Solar Generation",
    description: "Monthly generation ledger used for reporting recency and meter-read baseline. Supports multi-file append.",
    requiredHeaderSets: [["Month of Generation", "GATS Gen ID", "Facility Name"]],
  },
  contractedDate: {
    label: "Contracted Date",
    description: "Optional mapping from `system_id` to contracted date.",
    requiredHeaderSets: [["id", "contracted"]],
  },
  convertedReads: {
    label: "Converted Reads",
    description: "Portal-ready meter read CSV output used to calculate performance ratio. Supports multi-file append.",
    requiredHeaderSets: [["monitoring", "monitoring_system_id", "monitoring_system_name", "lifetime_meter_read_wh", "read_date"]],
  },
  annualProductionEstimates: {
    label: "Annual Production Estimates",
    description: "Monthly expected production profile (Jan-Dec) used for performance ratio expected values.",
    requiredHeaderSets: [["Unit ID", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]],
  },
  generatorDetails: {
    label: "Generator Details",
    description:
      "Optional fallback for performance ratio baseline when no GATS baseline exists (uses Date Online at day 15, meter starts at 0).",
    requiredHeaderSets: [["GATS Unit ID", "Date Online"], ["gats_unit_id", "date_online"]],
  },
  abpUtilityInvoiceRows: {
    label: "ABP Utility Invoice Rows",
    description:
      "Linked ABP settlement upload. Shared with ABP Monthly Invoice Settlement so both pages show the same utility invoice rows.",
    requiredHeaderSets: [
      ["systemId", "paymentNumber", "recQuantity", "recPrice", "invoiceAmount"],
      ["System ID", "Payment Number", "Total RECS", "REC Price", "Invoice Amount ($)"],
    ],
  },
  abpCsgSystemMapping: {
    label: "ABP CSG-System Mapping",
    description:
      "Linked ABP settlement mapping upload (CSG ID to System ID). Shared with ABP Monthly Invoice Settlement.",
    requiredHeaderSets: [["csgId", "systemId"], ["CSG ID", "System ID"]],
  },
  abpQuickBooksRows: {
    label: "ABP QuickBooks Rows",
    description:
      "Linked ABP settlement QuickBooks detail rows. Shared with ABP Monthly Invoice Settlement.",
    requiredHeaderSets: [
      ["invoiceNumber", "lineAmount", "description"],
      ["Date", "Num", "Customer", "Product/service description"],
    ],
  },
  abpProjectApplicationRows: {
    label: "ABP ProjectApplication Rows",
    description:
      "Linked ABP settlement ProjectApplication rows. Shared with ABP Monthly Invoice Settlement.",
    requiredHeaderSets: [
      ["applicationId", "inverterSizeKwAcPart1"],
      ["Application_ID", "Inverter_Size_kW_AC_Part_1"],
    ],
  },
  abpPortalInvoiceMapRows: {
    label: "ABP Portal Invoice Map Rows",
    description:
      "Linked ABP settlement portal invoice map (CSG ID to invoice number). Shared with ABP Monthly Invoice Settlement.",
    requiredHeaderSets: [["csgId", "invoiceNumber"], ["CSG ID", "Invoice Number"]],
  },
  abpCsgPortalDatabaseRows: {
    label: "ABP CSG Portal Database Rows",
    description:
      "Linked ABP settlement CSG portal database rows for installer/company attributes and collateral reimbursement flags.",
    requiredHeaderSets: [["systemId", "installerName"], ["System ID", "Installer"]],
  },
  abpIccReport2Rows: {
    label: "ABP ICC Report 2 Rows",
    description:
      "Shared ICC Report 2 upload (CSV/XLSX). Used by Early Payment and Solar REC modules.",
    requiredHeaderSets: [
      ["Application ID", "Total Quantity of RECs Contracted", "REC Price"],
      ["Application_ID", "Total Quantity of RECs Contracted", "REC Price"],
    ],
  },
  abpIccReport3Rows: {
    label: "ABP ICC Report 3 Rows",
    description:
      "Shared ICC Report 3 upload (CSV/XLSX). Used by Early Payment and Solar REC modules.",
    requiredHeaderSets: [
      ["Application ID", "Total Quantity of RECs Contracted", "REC Price"],
      ["Application_ID", "Total Quantity of RECs Contracted", "REC Price"],
    ],
  },
  deliveryScheduleBase: {
    label: "Delivery Schedule (Schedule B)",
    description:
      "REC delivery obligations per system per year, populated automatically by the Schedule B PDF scraper in the Delivery Tracker tab. Delivered quantities are computed from Transfer History uploads.",
    requiredHeaderSets: [
      ["tracking_system_ref_id", "year1_quantity_required"],
    ],
  },
  transferHistory: {
    label: "Transfer History (GATS)",
    description:
      "GATS transfer records. Multi-file append supported. Transfers from Carbon Solutions SREC to utilities count as deliveries; reverse transfers are subtracted. Allocated by Transfer Completion Date to energy year (June 1 – May 31).",
    requiredHeaderSets: [
      ["Unit ID", "Quantity", "Transferor", "Transferee"],
    ],
  },
};

// OWNERSHIP_ORDER, CHANGE_OWNERSHIP_ORDER — moved to @/solar-rec-dashboard/lib/constants

const MULTI_APPEND_DATASET_KEYS = new Set<DatasetKey>(["accountSolarGeneration", "convertedReads", "transferHistory"]);
const TABULAR_DATASET_KEYS = new Set<DatasetKey>(["abpIccReport2Rows", "abpIccReport3Rows"]);
/**
 * Datasets whose contents are populated by an in-app workflow (e.g. the
 * Schedule B PDF scanner on the Delivery Tracker tab), NOT by uploading a
 * CSV in the Step 1 panel. These still render in Step 1 so the user can
 * see row count / cloud sync status / clear them, but the file input is
 * replaced with an explanatory badge pointing at the correct workflow.
 */
const SCANNER_MANAGED_DATASET_KEYS = new Set<DatasetKey>(["deliveryScheduleBase"]);
const CORE_REQUIRED_DATASET_KEYS: DatasetKey[] = ["abpReport"];

/**
 * Datasets that have a server-side parser wired
 * (`server/services/core/datasetUploadParsers.ts`). For these,
 * the Step 1 panel renders a v2 upload button alongside the
 * legacy "Choose CSV" affordance.
 *
 * Phase 4 (2026-04-28) — expanded from {contractedDate} to every
 * dataset that supports CSV upload. The single excluded key is
 * `deliveryScheduleBase`, which is populated by the Schedule B
 * PDF scanner on the Delivery Tracker tab — never a direct CSV
 * upload.
 *
 * Phase 5 (forthcoming) removes the legacy affordance entirely
 * and drops this set.
 *
 * Keep in lockstep with the parser registry. The check is on the
 * client only — the server still rejects an upload for an
 * unimplemented dataset with a clear error message.
 */
const IMPLEMENTED_V2_DATASETS = new Set<DatasetKey>([
  "contractedDate",
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "convertedReads",
  "annualProductionEstimates",
  "generatorDetails",
  "abpUtilityInvoiceRows",
  "abpCsgSystemMapping",
  "abpQuickBooksRows",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  "transferHistory",
]);

/**
 * Phase 16: per-tab dataset priority. When the dashboard mounts with
 * `?tab=X`, we hydrate these datasets first so the user's landing
 * tab has data ASAP; everything else streams in after. Every list
 * implicitly inherits `CORE_REQUIRED_DATASET_KEYS` because the
 * top-level summary still reads ABP-derived counts even though the
 * main SystemRecord[] snapshot now comes from the server.
 *
 * Tabs not listed here hydrate in manifest order behind the core set.
 */
const TAB_PRIORITY_DATASETS: Record<string, DatasetKey[]> = {
  "performance-ratio": [
    "solarApplications",
    "convertedReads",
    "annualProductionEstimates",
    "generatorDetails",
    "generationEntry",
    "accountSolarGeneration",
  ],
  "offline-monitoring": ["solarApplications"],
  "delivery-tracker": ["deliveryScheduleBase", "transferHistory"],
  "contracts": ["deliveryScheduleBase", "transferHistory"],
  "annual-review": ["deliveryScheduleBase", "transferHistory"],
  "performance-eval": ["deliveryScheduleBase", "transferHistory"],
  "snapshot-log": ["deliveryScheduleBase", "transferHistory"],
  "forecast": [
    "deliveryScheduleBase",
    "transferHistory",
    "annualProductionEstimates",
    "accountSolarGeneration",
    "generationEntry",
  ],
  "financials": [
    "abpProjectApplicationRows",
    "abpUtilityInvoiceRows",
    "abpQuickBooksRows",
    "abpPortalInvoiceMapRows",
    "abpCsgPortalDatabaseRows",
    "abpIccReport2Rows",
    "abpIccReport3Rows",
  ],
  "app-pipeline": ["generatorDetails", "abpCsgSystemMapping", "abpIccReport3Rows"],
  "trends": ["convertedReads", "transferHistory", "deliveryScheduleBase"],
};

function buildHydrationPriorityKeys(activeTab: string): Set<DatasetKey> {
  const keys = new Set<DatasetKey>(CORE_REQUIRED_DATASET_KEYS);
  const tabExtras = TAB_PRIORITY_DATASETS[activeTab];
  if (tabExtras) {
    for (const key of tabExtras) keys.add(key);
  }
  return keys;
}

type DashboardTabId = (typeof DASHBOARD_TAB_VALUES)[number];

function isDashboardTabId(value: string): value is DashboardTabId {
  return DASHBOARD_TAB_VALUE_SET.has(value);
}

function getTabFromSearch(search: string): DashboardTabId | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  if (!tab || !isDashboardTabId(tab)) return null;
  return tab;
}

// resolveContractValueAmount, resolveValueGapAmount — moved to @/solar-rec-dashboard/lib/helpers


// normalizeMonitoringMethod — inlined as a private helper inside
// @/solar-rec-dashboard/lib/buildSystems (Phase 19). It was only
// used by the `systems` builder and is now worker-side.

// normalizeMonitoringPlatform — moved to @/solar-rec-dashboard/lib/helpers


// buildDeliveryYearLabel, buildRecReviewDeliveryYearLabel,
// RecPerformanceThreeYearValues, deriveRecPerformanceThreeYearValues
// — moved to @/solar-rec-dashboard/lib/helpers/recPerformance

function buildScheduleYearEntries(row: CsvRow): ScheduleYearEntry[] {
  const entries: ScheduleYearEntry[] = [];

  for (let yearIndex = 1; yearIndex <= 15; yearIndex += 1) {
    const requiredRaw = row[`year${yearIndex}_quantity_required`];
    const deliveredRaw = row[`year${yearIndex}_quantity_delivered`];
    const startRaw = clean(row[`year${yearIndex}_start_date`]);
    const endRaw = clean(row[`year${yearIndex}_end_date`]);

    const required = parseNumber(requiredRaw) ?? 0;
    const delivered = parseNumber(deliveredRaw) ?? 0;
    const startDate = parseDate(startRaw);
    const endDate = parseDate(endRaw);

    if (!startRaw && !endRaw && required === 0 && delivered === 0) continue;

    const key = startDate ? startDate.toISOString().slice(0, 10) : `${startRaw}-${yearIndex}`;

    entries.push({
      yearIndex,
      required,
      delivered,
      startDate,
      endDate,
      startRaw,
      endRaw,
      key,
    });
  }

  return entries.sort((a, b) => {
    const aTime = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bTime = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.yearIndex - b.yearIndex;
  });
}

function buildSystemSnapshotKey(system: SystemRecord): string {
  if (system.systemId) return `id:${system.systemId}`;
  if (system.trackingSystemRefId) return `tracking:${system.trackingSystemRefId}`;
  return `name:${system.systemName.toLowerCase()}`;
}

// getMonitoringDetailsForSystem — moved to @/solar-rec-dashboard/lib/helpers

// classifyMonitoringAccessType, resolveOfflineMonitoringAccessFields — moved to @/solar-rec-dashboard/lib/helpers

// formatTransitionBreakdown — moved to @/solar-rec-dashboard/components/SnapshotLogTab

type CsvParserWorkerRequest =
  | {
      id: number;
      mode: "text";
      text: string;
    }
  | {
      id: number;
      mode: "file";
      file: File;
    };

type CsvParserWorkerResponse =
  | {
      id: number;
      ok: true;
      headers: string[];
      rows: CsvRow[];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

function isDatasetKey(value: string): value is DatasetKey {
  return Object.prototype.hasOwnProperty.call(DATASET_DEFINITIONS, value);
}

function accountSolarGenerationRowKey(row: CsvRow): string {
  return [
    clean(row["GATS Gen ID"]),
    clean(row["Month of Generation"]),
    clean(row["Last Meter Read Date"]),
    resolveLastMeterReadRawValue(row),
    clean(row["Facility Name"]),
  ].join("|");
}

function convertedReadsRowKey(row: CsvRow): string {
  return [
    getCsvValueByHeader(row, "monitoring"),
    getCsvValueByHeader(row, "monitoring_system_id"),
    getCsvValueByHeader(row, "monitoring_system_name"),
    getCsvValueByHeader(row, "lifetime_meter_read_wh"),
    getCsvValueByHeader(row, "read_date"),
  ].join("|");
}

function transferHistoryRowKey(row: CsvRow): string {
  return [
    clean(row["Transaction ID"]),
    clean(row["Unit ID"]),
    clean(row["Transfer Completion Date"]),
    clean(row.Quantity),
  ].join("|");
}

function datasetAppendRowKey(key: DatasetKey, row: CsvRow): string {
  if (key === "accountSolarGeneration") return accountSolarGenerationRowKey(row);
  if (key === "convertedReads") return convertedReadsRowKey(row);
  if (key === "transferHistory") return transferHistoryRowKey(row);
  return "";
}

function splitTextIntoChunks(value: string, chunkSize: number): string[] {
  if (value.length <= chunkSize) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildRemoteDatasetChunkKey(datasetKey: string, chunkIndex: number): string {
  return `${datasetKey}_chunk_${String(chunkIndex).padStart(4, "0")}`;
}

function deriveDatasetKeyFromStorageKey(storageKey: string): DatasetKey | null {
  const baseKey = storageKey.includes("_chunk_") ? storageKey.split("_chunk_")[0] : storageKey;
  return baseKey in DATASET_DEFINITIONS ? (baseKey as DatasetKey) : null;
}

function buildChunkPointerPayload(chunkKeys: string[]): string {
  return JSON.stringify({
    _chunkedDataset: true,
    chunkKeys,
  });
}

function parseChunkPointerPayload(payload: string): string[] | null {
  try {
    const parsed = JSON.parse(payload) as { _chunkedDataset?: unknown; chunkKeys?: unknown };
    if (parsed._chunkedDataset !== true) return null;
    if (!Array.isArray(parsed.chunkKeys) || parsed.chunkKeys.length === 0) return null;
    const chunkKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const chunkKeys = parsed.chunkKeys.filter(
      (key): key is string => typeof key === "string" && chunkKeyPattern.test(key)
    );
    return chunkKeys.length === parsed.chunkKeys.length ? chunkKeys : null;
  } catch {
    return null;
  }
}

function buildDatasetKeyManifestPayload(keys: DatasetKey[]): string {
  return JSON.stringify({
    keys,
    updatedAt: new Date().toISOString(),
  });
}

function parseDatasetKeyManifestPayload(payload: string): DatasetKey[] {
  try {
    const parsed = JSON.parse(payload) as { keys?: unknown };
    if (!Array.isArray(parsed.keys)) return [];
    return parsed.keys.filter((key): key is DatasetKey => typeof key === "string" && isDatasetKey(key));
  } catch {
    return [];
  }
}

function createRemoteSourceId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 16);
}

function buildRemoteSourceStorageKey(datasetKey: DatasetKey, sourceId: string): string {
  const normalizedDataset = datasetKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const normalizedSource = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Reserve room for "_chunk_0000" suffix so chunk keys stay within 64-char server key limit.
  return `src_${normalizedDataset}_${normalizedSource}`.slice(0, 52);
}

/**
 * Mirror of the server's `isServerManagedConvertedReadsSourceId`
 * (server/solar/convertedReadsBridge.ts). Sources with these ID prefixes
 * in the `convertedReads` manifest are written by the server (monitoring
 * batch bridge + `pushConvertedReadsSource` tRPC mutation) and must be
 * preserved across client auto-syncs — the dashboard's in-memory manifest
 * can be stale relative to them.
 */
function isServerManagedConvertedReadsSourceId(sourceId: string): boolean {
  return sourceId.startsWith("mon_batch_") || sourceId.startsWith("individual_");
}

function isCsvLikeFile(fileName: string, contentType?: string): boolean {
  const lowerName = clean(fileName).toLowerCase();
  const lowerType = clean(contentType).toLowerCase();
  return lowerName.endsWith(".csv") || lowerType.includes("csv") || lowerType.startsWith("text/");
}

/**
 * Run async tasks with bounded concurrency to avoid exhausting browser
 * connection limits. Without this, Promise.all on 50+ tRPC mutations
 * causes ERR_INSUFFICIENT_RESOURCES crashes.
 */
async function mapWithBoundedConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/** Max concurrent tRPC mutations for remote dataset WRITES (saves, chunk deletes). */
const REMOTE_WRITE_CONCURRENCY = 4;
/**
 * Remote hydrate used to fan out very aggressively across datasets,
 * source files, and chunk reads. The previous value of 1 was set after
 * an explosively-parallel version (50+ concurrent) caused memory spikes
 * in Chrome on cold-cache hydration of large portfolios. But strict
 * serial reads make cold-cache hydration take minutes for a portfolio
 * with 2k+ chunks — concurrency=8 is the safe middle ground: 8x
 * throughput, ~8 × 250KB ≈ 2MB peak chunk-buffer pressure, still well
 * below memory-spike territory. See the get-dataset-assembled batch
 * endpoint for the longer-term fix that collapses chunk fan-out
 * server-side.
 */
const REMOTE_READ_CONCURRENCY = 8;
/** Byte slice size for streamed remote file uploads. Keeps browser memory bounded. */
const REMOTE_FILE_STREAM_SLICE_BYTES = 256 * 1024;

function concatUint8Arrays(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, initialDelayMs = 250): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = initialDelayMs * attempt;
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
  throw (lastError instanceof Error ? lastError : new Error("Operation failed after retries."));
}

function serializeDatasetForRemote(dataset: CsvDataset): string {
  const payload: RemoteDatasetPayload = {
    fileName: dataset.fileName,
    uploadedAt: dataset.uploadedAt.toISOString(),
    headers: dataset.headers,
    csvText: buildCsv(dataset.headers, dataset.rows),
    sources: dataset.sources?.map((source) => ({
      fileName: source.fileName,
      uploadedAt: source.uploadedAt.toISOString(),
      rowCount: source.rowCount,
    })),
  };
  return JSON.stringify(payload);
}

function deserializeRemoteDatasetPayload(payload: string): CsvDataset | null {
  try {
    const parsed = JSON.parse(payload) as RemoteDatasetPayload;
    const uploadedAt = new Date(parsed.uploadedAt);
    if (Number.isNaN(uploadedAt.getTime())) return null;
    const parsedCsv = parseCsv(parsed.csvText ?? "");
    const headers =
      parsedCsv.headers.length > 0 ? parsedCsv.headers : Array.isArray(parsed.headers) ? parsed.headers : [];
    const rows = parsedCsv.rows;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources
          .map((source) => {
            const sourceUploadedAt = new Date(source.uploadedAt);
            if (Number.isNaN(sourceUploadedAt.getTime())) return null;
            return {
              fileName: source.fileName,
              uploadedAt: sourceUploadedAt,
              rowCount: source.rowCount,
            };
          })
          .filter((source): source is NonNullable<typeof source> => source !== null)
      : undefined;

    return {
      fileName: parsed.fileName,
      uploadedAt,
      headers,
      rows,
      rowCount: rows.length,
      sources,
    };
  } catch {
    return null;
  }
}

// sumSchedule — inlined as a private helper inside
// @/solar-rec-dashboard/lib/buildSystems (Phase 19).

// ownershipBadgeClass, changeOwnershipBadgeClass — moved to @/solar-rec-dashboard/lib/helpers

// createLogId — moved to @/solar-rec-dashboard/lib/helpers

/**
 * On-disk (IndexedDB) shape for a persisted CSV dataset.
 *
 * Phase 15 — columnar persistence: the `_v: 2` branch stores rows as
 * `columnData: string[][]` (one inner array per header, aligned by
 * index) instead of `rows: CsvRow[]`. The columnar shape stores each
 * header string ONCE per dataset rather than once per row, which:
 *   - shrinks IndexedDB footprint 30–50% for wide datasets (the
 *     Transfer History sheet goes from ~30 MB to ~15 MB)
 *   - halves structured-clone work on save/load (half as many JS
 *     objects to walk)
 *   - doesn't touch any tab code, because the deserializer
 *     re-materialises `CsvRow[]` in memory — tabs still see
 *     `row[header]` everywhere
 *
 * Legacy row-oriented records (`rows: CsvRow[]`) are still readable
 * forever — `deserializeDatasetRecord` accepts both shapes and the
 * next save rewrites them in the new shape.
 */
type SerializedCsvDataset =
  | {
      _v?: undefined;
      fileName: string;
      uploadedAt: string;
      headers: string[];
      rows: CsvRow[];
      sources?: Array<{
        fileName: string;
        uploadedAt: string;
        rowCount: number;
      }>;
    }
  | {
      _v: 2;
      fileName: string;
      uploadedAt: string;
      headers: string[];
      columnData: string[][];
      rowCount: number;
      sources?: Array<{
        fileName: string;
        uploadedAt: string;
        rowCount: number;
      }>;
    };

type SerializedDatasetsManifest = {
  keys: DatasetKey[];
  updatedAt: string;
};

type RemoteDatasetPayload = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  csvText: string;
  sources?: Array<{
    fileName: string;
    uploadedAt: string;
    rowCount: number;
  }>;
};

type RemoteDatasetSourceEncoding = "utf8" | "base64";

type RemoteDatasetSourceRef = {
  id: string;
  fileName: string;
  uploadedAt: string;
  rowCount: number;
  sizeBytes: number;
  storageKey: string;
  chunkKeys?: string[];
  encoding: RemoteDatasetSourceEncoding;
  contentType: string;
};

type RemoteDatasetSourceManifestPayload = {
  _rawSourcesV1: true;
  version: 1;
  sources: RemoteDatasetSourceRef[];
};

type RemoteDatasetManifestEntry = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rowCount: number;
  sources?: Array<{
    fileName: string;
    uploadedAt: string;
    rowCount: number;
  }>;
};

type DatasetCloudSyncStatus = "pending" | "synced" | "failed" | "not-synced";

type DatasetSyncProgressState = {
  stage: "uploading" | "database-sync" | "refreshing-snapshot";
  percent: number;
  message: string;
  current?: number;
  total?: number;
  unitLabel?: string;
  jobId?: string;
  updatedAt: number;
};

function clampSyncPercent(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatSyncProgressUnits(progress: DatasetSyncProgressState): string | null {
  if (
    typeof progress.current !== "number" ||
    typeof progress.total !== "number" ||
    progress.total <= 0
  ) {
    return null;
  }

  if (progress.unitLabel === "bytes") {
    const toMb = (value: number) => `${formatNumber(value / 1024 / 1024, 1)} MB`;
    return `${toMb(progress.current)} / ${toMb(progress.total)}`;
  }

  const unitLabel = progress.unitLabel ?? "items";
  return `${formatNumber(progress.current)} / ${formatNumber(progress.total)} ${unitLabel}`;
}

type SerializedDashboardLogEntry = Omit<DashboardLogEntry, "createdAt" | "datasets" | "cooStatuses"> & {
  createdAt: string;
  datasets: Array<{
    key: DatasetKey;
    label: string;
    fileName: string;
    rows: number;
    updatedAt: string;
  }>;
  cooStatuses: Array<{
    key: string;
    status: ChangeOwnershipStatus;
    systemName?: string;
  }>;
};

function parseRemoteSourceManifestPayload(payload: string): RemoteDatasetSourceManifestPayload | null {
  try {
    const parsed = JSON.parse(payload) as {
      _rawSourcesV1?: unknown;
      version?: unknown;
      sources?: unknown;
    };
    if (parsed._rawSourcesV1 !== true || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.sources)) return null;
    const keyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const sources: RemoteDatasetSourceRef[] = parsed.sources
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as Partial<RemoteDatasetSourceRef>;
        if (!candidate.id || typeof candidate.id !== "string") return null;
        if (!candidate.fileName || typeof candidate.fileName !== "string") return null;
        if (!candidate.uploadedAt || typeof candidate.uploadedAt !== "string") return null;
        if (!candidate.storageKey || typeof candidate.storageKey !== "string") return null;
        if (!keyPattern.test(candidate.storageKey)) return null;
        if (!candidate.encoding || (candidate.encoding !== "utf8" && candidate.encoding !== "base64")) return null;
        const rowCount = Number(candidate.rowCount ?? 0);
        const sizeBytes = Number(candidate.sizeBytes ?? 0);
        const chunkKeys = Array.isArray(candidate.chunkKeys)
          ? candidate.chunkKeys.filter((chunkKey): chunkKey is string =>
              typeof chunkKey === "string" && keyPattern.test(chunkKey)
            )
          : undefined;

        const normalized: RemoteDatasetSourceRef = {
          id: candidate.id,
          fileName: candidate.fileName,
          uploadedAt: candidate.uploadedAt,
          rowCount: Number.isFinite(rowCount) ? rowCount : 0,
          sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
          storageKey: candidate.storageKey,
          encoding: candidate.encoding,
          contentType:
            typeof candidate.contentType === "string" && candidate.contentType.length > 0
              ? candidate.contentType
              : "application/octet-stream",
        };
        if (chunkKeys && chunkKeys.length > 0) {
          normalized.chunkKeys = chunkKeys;
        }
        return normalized;
      })
      .filter((entry): entry is RemoteDatasetSourceRef => entry !== null);

    return {
      _rawSourcesV1: true,
      version: 1,
      sources,
    };
  } catch {
    return null;
  }
}

async function computeSha256Hex(value: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

// Lazy-dataset infrastructure (row-materialization on demand, columnar
// serialization round-trip, non-enumerable source symbol) lives in
// @/solar-rec-dashboard/lib/lazyDataset so it's testable + reusable.
// See that module's docstring for the design rationale.

function deserializeDatasetRecord(dataset: SerializedCsvDataset | undefined): CsvDataset | null {
  if (!dataset) return null;
  const uploadedAt = new Date(dataset.uploadedAt);
  if (Number.isNaN(uploadedAt.getTime())) return null;

  const sources = Array.isArray(dataset.sources)
    ? dataset.sources
        .map((source) => {
          const sourceUploadedAt = new Date(source.uploadedAt);
          if (Number.isNaN(sourceUploadedAt.getTime())) return null;
          return {
            fileName: source.fileName,
            uploadedAt: sourceUploadedAt,
            rowCount: source.rowCount,
          };
        })
        .filter((source): source is NonNullable<typeof source> => source !== null)
    : undefined;

  const headers = Array.isArray(dataset.headers) ? dataset.headers : [];

  // Phase 15: dispatch on the version tag. New records carry `_v: 2`
  // and a columnar payload; legacy records have a `rows` array. Both
  // shapes land in the same in-memory `CsvDataset` so callers don't
  // care.
  //
  // v2 (columnar) records now flow through buildLazyCsvDataset so
  // rows only materialize when a tab actually reads them. The
  // columnar arrays are kept on a hidden symbol field for
  // serializeDatasetRecord to reuse.
  if (dataset._v === 2) {
    const rowCount = Number.isFinite(dataset.rowCount) ? dataset.rowCount : 0;
    const columnData = Array.isArray(dataset.columnData) ? dataset.columnData : [];
    return buildLazyCsvDataset({
      fileName: dataset.fileName,
      uploadedAt,
      headers,
      columnData,
      rowCount,
      sources,
    });
  }

  const legacyRows = Array.isArray(dataset.rows) ? dataset.rows : [];
  return {
    fileName: dataset.fileName,
    uploadedAt,
    headers,
    rows: legacyRows,
    // Task 5.14 PR-1: scalar row count for legacy v1 records too.
    // Backfill = rows.length on read; the next save round-trips
    // through the v2 columnar serializer (which already carries
    // rowCount), so this branch only runs once per legacy record.
    rowCount: legacyRows.length,
    sources,
  };
}

function deserializeDatasets(
  parsed: Record<string, SerializedCsvDataset | undefined>
): Partial<Record<DatasetKey, CsvDataset>> {
  const loaded: Partial<Record<DatasetKey, CsvDataset>> = {};
  (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
    const deserialized = deserializeDatasetRecord(parsed[key]);
    if (!deserialized) return;
    loaded[key] = deserialized;
  });
  return loaded;
}

/**
 * Phase 15: serialize a dataset in the compact columnar shape. The
 * cost of `buildColumnarFromRows` is a single O(rows × headers) pass,
 * paid once per save — but structured-clone then walks ~half as many
 * JS objects (N columns instead of N×rows row records), and IndexedDB
 * stores each header name once rather than once per row.
 */
function serializeDatasetRecord(dataset: CsvDataset): SerializedCsvDataset {
  const sources = dataset.sources?.map((source) => ({
    fileName: source.fileName,
    uploadedAt: source.uploadedAt.toISOString(),
    rowCount: source.rowCount,
  }));

  // Fast-path: if this dataset came from the IDB hydration path via
  // buildLazyCsvDataset, the original columnar arrays are cached on
  // the hidden symbol slot. Reuse them instead of walking rows back
  // into columns — that rebuild forces full materialization and
  // defeats the lazy-rows memory win.
  const columnarSource = getDatasetColumnarSource(dataset);
  if (columnarSource) {
    // Cast away readonly at the serialization boundary — IDB's
    // structured-clone makes its own deep copy of both arrays, so the
    // frozen input is never actually mutated. Typing the wire shape
    // as readonly wasn't worth threading through SerializedCsvDataset.
    return {
      _v: 2,
      fileName: dataset.fileName,
      uploadedAt: dataset.uploadedAt.toISOString(),
      headers: columnarSource.headers as string[],
      columnData: columnarSource.columnData as string[][],
      rowCount: columnarSource.rowCount,
      sources,
    };
  }

  return {
    _v: 2,
    fileName: dataset.fileName,
    uploadedAt: dataset.uploadedAt.toISOString(),
    headers: dataset.headers,
    columnData: buildColumnarFromRows(dataset.headers, dataset.rows),
    rowCount: dataset.rows.length,
    sources,
  };
}

function serializeDatasets(
  datasets: Partial<Record<DatasetKey, CsvDataset>>
): Record<string, SerializedCsvDataset | undefined> {
  const serialized: Record<string, SerializedCsvDataset | undefined> = {};
  (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
    const dataset = datasets[key];
    if (!dataset) return;
    serialized[key] = serializeDatasetRecord(dataset);
  });
  return serialized;
}

function loadLegacyDatasetsFromLocalStorage(): Partial<Record<DatasetKey, CsvDataset>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LEGACY_DATASETS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SerializedCsvDataset | undefined>;
    return deserializeDatasets(parsed);
  } catch {
    return {};
  }
}

// Phase 13c: cache the IndexedDB connection at module scope so every
// save doesn't pay the ~10–50ms open handshake. The connection stays
// open for the life of the tab unless the browser forcibly closes it
// (versionchange from another tab, tab goes into BFCache, etc.), at
// which point we null the cache and the next call reopens cleanly.
let cachedDashboardDb: IDBDatabase | null = null;
let cachedDashboardDbPromise: Promise<IDBDatabase> | null = null;

function invalidateCachedDashboardDb(): void {
  cachedDashboardDb = null;
  cachedDashboardDbPromise = null;
}

async function openDashboardDatabase(): Promise<IDBDatabase> {
  // Phase 5a (2026-04-28): the dashboard no longer opens an
  // IndexedDB connection at runtime. Every call site in this
  // file has been migrated to the no-op'd load/save helpers
  // above. If anything still reaches this function, it's a bug
  // — fail fast with a clear message.
  throw new Error(
    "openDashboardDatabase: IndexedDB removed by Phase 5a; this caller is leftover."
  );
}

function dashboardDatasetStorageKey(key: DatasetKey): string {
  return `dataset:${key}`;
}

// Phase 13c: per-dataset signature for the diff-save path. Same
// shape as buildDatasetStorageSignature for a single entry so the
// two can't drift out of sync.
function buildSingleDatasetSignature(dataset: CsvDataset | undefined): string {
  if (!dataset) return "";
  // Prefer the cached columnar rowCount so we don't trigger lazy-rows
  // materialization for every save-diff pass. Freshly uploaded
  // datasets without a columnar source fall back to reading the
  // materialized rows (cheap — they're already real arrays).
  const columnarSource = getDatasetColumnarSource(dataset);
  const rowCount = columnarSource ? columnarSource.rowCount : dataset.rows.length;
  return `${dataset.fileName}|${dataset.uploadedAt.toISOString()}|${rowCount}|${dataset.sources?.length ?? 0}`;
}

// Module-level cache of "what we last wrote to IndexedDB per key",
// used by saveDatasetsToStorage to skip store.put calls for datasets
// that didn't change. Hydrated either by loadDatasetsFromStorage
// (after a successful initial read) or by saveDatasetsToStorage
// itself (after a successful write). Missing keys = never saved.
const lastSavedDatasetSignatures: Partial<Record<DatasetKey, string>> = {};

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

/**
 * Phase 16 + 17c: progressive, prioritized, **batched** dataset hydration.
 *
 * The hydration still walks IndexedDB one dataset at a time with a
 * microtask yield between each read so the main thread stays
 * responsive for input/scroll during a cold load. But instead of
 * landing each dataset with its own `setDatasets` call (which made
 * the expensive `systems` memo re-fire on every progress tick), we
 * **batch** the commits into at most two flushes:
 *
 *   - PRIORITY batch: flushed as soon as every priority key has
 *     been read. This is what makes the user's landing tab
 *     interactive ASAP.
 *   - BACKGROUND batch: flushed when everything else is loaded.
 *
 * With ~6 dataset slots feeding the `systems` memo, the pre-17c
 * flow fired `systems` ~6 times during hydrate. With 17c it fires
 * at most 2 times — close to the theoretical minimum for
 * progressive-plus-priority loading.
 *
 * `onProgress(loaded, total)` still fires per dataset so the UI
 * can show a fine-grained counter.
 *
 * Legacy record fallbacks still flush once through `onBatch`.
 */
interface ProgressiveHydrationOptions {
  priorityKeys?: Set<DatasetKey>;
  onBatch: (batch: Partial<Record<DatasetKey, CsvDataset>>, phase: "priority" | "background") => void;
  onProgress?: (loaded: number, total: number) => void;
  /**
   * Fires when a single dataset fails to hydrate. Siblings continue —
   * this is a signal, not a halt. Caller typically records the error
   * in state so the card for that key can surface it instead of
   * showing "Not uploaded" (which would misleadingly suggest the
   * user had never uploaded it).
   */
  onError?: (key: DatasetKey, error: unknown) => void;
}

async function loadDatasetsFromStorage(_options: ProgressiveHydrationOptions): Promise<void> {
  // Phase 5a (2026-04-28) of the IndexedDB-removal refactor:
  // hydration from IDB disabled. The dashboard mounts with empty
  // `datasets` state; the 6 main tabs hydrate from server-side
  // aggregators (`useSystemSnapshot`, `getDashboard*Aggregates`
  // — see the comment on `serverSnapshot` ~L4026 for context).
  // Phase 5c will delete this function and its call sites entirely
  // once the parent-level `.rows` consumers (Phase 5b) are off the
  // legacy state map.
  return;
}

async function saveDatasetsToStorage(_datasets: Partial<Record<DatasetKey, CsvDataset>>): Promise<void> {
  // Phase 5a (2026-04-28): IndexedDB writes disabled. v2 uploads
  // (Phase 1-4) write straight to `srDs*` tables on the server;
  // legacy v1 uploads still hit the cloud-side `saveDataset` proc
  // (the chunked-CSV manifest path). Neither needs a local IDB
  // copy. Phase 5c will delete this function + call sites.
  return;
}

function serializeDashboardLogs(
  logEntries: DashboardLogEntry[],
  options?: { includeSystemName?: boolean }
): SerializedDashboardLogEntry[] {
  const includeSystemName = options?.includeSystemName ?? true;
  return logEntries.map((entry) => ({
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    datasets: entry.datasets.map((dataset) => ({
      ...dataset,
      updatedAt: dataset.updatedAt.toISOString(),
    })),
    cooStatuses: entry.cooStatuses.map((status) =>
      includeSystemName
        ? {
            key: status.key,
            status: status.status,
            systemName: status.systemName,
          }
        : {
            key: status.key,
            status: status.status,
          }
    ),
  }));
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function compactLogsForRemoteSync(
  logEntries: DashboardLogEntry[]
): SerializedDashboardLogEntry[] {
  let serialized = serializeDashboardLogs(logEntries.slice(-REMOTE_LOG_ENTRY_LIMIT), {
    includeSystemName: false,
  });

  while (serialized.length > 0) {
    const text = safeJsonStringify(serialized);
    if (text && text.length <= MAX_REMOTE_STATE_LOG_BYTES) break;
    const dropCount = Math.max(1, Math.ceil(serialized.length / 3));
    serialized = serialized.slice(dropCount);
  }

  return serialized;
}

function buildLogSyncSignature(logEntries: DashboardLogEntry[]): string {
  const count = logEntries.length;
  if (count === 0) return "0";
  const newest = logEntries[0];
  const oldest = logEntries[count - 1];
  return `${count}|${newest?.id ?? ""}|${newest?.createdAt.toISOString() ?? ""}|${oldest?.id ?? ""}|${oldest?.createdAt.toISOString() ?? ""}`;
}

function buildDatasetStorageSignature(datasets: Partial<Record<DatasetKey, CsvDataset>>): string {
  return (Object.keys(DATASET_DEFINITIONS) as DatasetKey[])
    .map((key) => {
      const dataset = datasets[key];
      if (!dataset) return `${key}:`;
      return `${key}:${dataset.fileName}|${dataset.uploadedAt.toISOString()}|${dataset.rows.length}|${dataset.sources?.length ?? 0}`;
    })
    .join("||");
}

function deserializeDashboardLogs(raw: string): DashboardLogEntry[] {
  try {
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      createdAt: string;
      totalSystems: number;
      reportingSystems: number;
      reportingPercent?: number | null;
      changeOwnershipSystems: number;
      changeOwnershipPercent?: number | null;
      transferredReporting: number;
      transferredNotReporting: number;
      terminatedReporting: number;
      terminatedNotReporting: number;
      changedNotTransferredReporting: number;
      changedNotTransferredNotReporting: number;
      totalContractedValue: number;
      totalDeliveredValue: number;
      totalGap: number;
      contractedValueReporting?: number;
      contractedValueNotReporting?: number;
      contractedValueReportingPercent?: number | null;
      datasets: Array<{ key: DatasetKey; label: string; fileName: string; rows: number; updatedAt: string }>;
      cooStatuses?: Array<{ key: string; systemName?: string; status: ChangeOwnershipStatus }>;
      recPerformanceContracts2025?: Array<{
        contractId: string;
        deliveryYearLabel?: string;
        requiredToAvoidShortfallRecs: number;
        deliveredTowardShortfallRecs: number;
        deliveredPercentOfRequired?: number | null;
        unallocatedShortfallRecs: number;
      }>;
    }>;
    return parsed
      .map((entry) => {
        const createdAt = new Date(entry.createdAt);
        if (Number.isNaN(createdAt.getTime())) return null;
        const datasets = (entry.datasets ?? [])
          .map((dataset) => {
            const updatedAt = new Date(dataset.updatedAt);
            if (Number.isNaN(updatedAt.getTime())) return null;
            return { ...dataset, updatedAt };
          })
          .filter((dataset): dataset is NonNullable<typeof dataset> => dataset !== null);
        const cooStatuses = (entry.cooStatuses ?? [])
          .map((item) => {
            if (!item || typeof item.key !== "string") return null;
            if (typeof item.status !== "string") return null;
            if (!CHANGE_OWNERSHIP_ORDER.includes(item.status as ChangeOwnershipStatus)) return null;
            const status = item.status as ChangeOwnershipStatus;
            const systemName = typeof item.systemName === "string" ? item.systemName : undefined;
            return systemName ? { key: item.key, status, systemName } : { key: item.key, status };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);
        const recPerformanceContracts2025 = (entry.recPerformanceContracts2025 ?? [])
          .map((item) => {
            if (!item || typeof item.contractId !== "string") return null;
            const requiredToAvoidShortfallRecs = Number(item.requiredToAvoidShortfallRecs ?? 0);
            const deliveredTowardShortfallRecs = Number(item.deliveredTowardShortfallRecs ?? 0);
            const unallocatedShortfallRecs = Number(item.unallocatedShortfallRecs ?? 0);
            if (
              !Number.isFinite(requiredToAvoidShortfallRecs) ||
              !Number.isFinite(deliveredTowardShortfallRecs) ||
              !Number.isFinite(unallocatedShortfallRecs)
            ) {
              return null;
            }
            const parsedPercent =
              item.deliveredPercentOfRequired === null || item.deliveredPercentOfRequired === undefined
                ? toPercentValue(deliveredTowardShortfallRecs, requiredToAvoidShortfallRecs)
                : Number(item.deliveredPercentOfRequired);
            const deliveredPercentOfRequired =
              parsedPercent === null || Number.isFinite(parsedPercent) ? parsedPercent : null;

            return {
              contractId: item.contractId,
              deliveryYearLabel: item.deliveryYearLabel || SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL,
              requiredToAvoidShortfallRecs,
              deliveredTowardShortfallRecs,
              deliveredPercentOfRequired,
              unallocatedShortfallRecs,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);
        return {
          ...entry,
          createdAt,
          reportingPercent: entry.reportingPercent ?? toPercentValue(entry.reportingSystems, entry.totalSystems),
          changeOwnershipPercent:
            entry.changeOwnershipPercent ?? toPercentValue(entry.changeOwnershipSystems, entry.totalSystems),
          contractedValueReporting: entry.contractedValueReporting ?? 0,
          contractedValueNotReporting: entry.contractedValueNotReporting ?? 0,
          contractedValueReportingPercent:
            entry.contractedValueReportingPercent ??
            toPercentValue(entry.contractedValueReporting ?? 0, entry.totalContractedValue),
          datasets,
          cooStatuses,
          recPerformanceContracts2025,
        };
      })
      .filter((entry): entry is DashboardLogEntry => entry !== null);
  } catch {
    return [];
  }
}

function loadPersistedLogs(): DashboardLogEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(LOGS_STORAGE_KEY);
  if (!raw) return [];
  if (raw.length > MAX_LOCAL_LOG_STORAGE_CHARS) {
    window.localStorage.removeItem(LOGS_STORAGE_KEY);
    return [];
  }
  return deserializeDashboardLogs(raw);
}

async function loadLogsFromStorage(): Promise<DashboardLogEntry[]> {
  // Phase 5a (2026-04-28): IndexedDB hydration of snapshot logs
  // disabled. Logs persist via the localStorage fallback already
  // wired into `loadPersistedLogs()` — that's where the actual
  // log entries live for cross-session continuity. Phase 5c will
  // delete this function + its caller after Phase 5b finishes
  // migrating any remaining IDB consumers.
  return loadPersistedLogs();
}

async function saveLogsToStorage(_logEntries: DashboardLogEntry[]): Promise<void> {
  // Phase 5a (2026-04-28): IDB writes disabled. Snapshot logs
  // continue to write to localStorage in the original
  // saveLogsToStorage path (which we no-op here entirely);
  // the localStorage fallback in `compactLogsForRemoteSync` is
  // sufficient for this surface.
  return;
}

// loadPersistedCompliantSources — moved to @/solar-rec-dashboard/components/PerformanceRatioTab


export default function SolarRecDashboard() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const trpcUtils = trpc.useUtils();
  const solarRecTrpcUtils = solarRecTrpc.useUtils();
  const [datasets, setDatasets] = useState<Partial<Record<DatasetKey, CsvDataset>>>({});
  const [datasetsHydrated, setDatasetsHydrated] = useState(false);
  // Phase 16: progress counter for the streaming hydration path, so
  // the data-health header can show "Loading 3/15 datasets…" while
  // the active tab is already interactive.
  const [hydrationProgress, setHydrationProgress] = useState<{ loaded: number; total: number }>({
    loaded: 0,
    total: 0,
  });
  // "Load all" toggle state. Default mount hydration prioritizes the
  // active tab's datasets; Load All forces every manifest entry into
  // state for cross-tab work / exports.
  const [loadingAllDatasets, setLoadingAllDatasets] = useState(false);
  const [loadAllProgress, setLoadAllProgress] = useState<{ loaded: number; total: number } | null>(
    null
  );
  const [logEntries, setLogEntries] = useState<DashboardLogEntry[]>(() => loadPersistedLogs());
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DatasetKey, string>>>({});
  // Per-dataset hydration failures. Value is a user-facing message
  // surfaced on the card so the user can tell "hydration failed"
  // apart from "never uploaded." Cleared when a key next hydrates
  // successfully, or when the dataset is explicitly removed.
  const [hydrationErrors, setHydrationErrors] = useState<PerDatasetErrorMap>({});
  const recordHydrationError = useCallback((key: DatasetKey, error: unknown) => {
    setHydrationErrors((current) => ({
      ...current,
      [key]: toUserFacingHydrationMessage(error),
    }));
  }, []);
  const clearHydrationErrorsForKeys = useCallback((keys: readonly DatasetKey[]) => {
    if (keys.length === 0) return;
    setHydrationErrors((current) => {
      if (keys.every((key) => !current[key])) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }, []);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const uploadQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const activeUploadTaskRef = useRef(false);
  const queuedUploadTaskCountRef = useRef(0);
  const [activeUploadTaskLabel, setActiveUploadTaskLabel] = useState<string | null>(null);
  const [queuedUploadTaskCount, setQueuedUploadTaskCount] = useState(0);
  const [localOnlyDatasets, setLocalOnlyDatasets] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [datasetCloudSyncStatus, setDatasetCloudSyncStatus] = useState<
    Partial<Record<DatasetKey, DatasetCloudSyncStatus>>
  >({});
  const [datasetSyncProgress, setDatasetSyncProgress] = useState<
    Partial<Record<DatasetKey, DatasetSyncProgressState>>
  >({});
  const [forceSyncingDatasets, setForceSyncingDatasets] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [lastDbErrors, setLastDbErrors] = useState<
    Partial<Record<DatasetKey, { message: string; at: number }>>
  >({});
  // srDs sync-job issues. Pre-fix the 10min polling timeout fired
  // a console.warn and cleared progress, so the Cloud Sync tile
  // silently flipped to "synced" while the row-table population
  // was still pending or had failed unobserved. This map captures
  // both the timeout case and the explicit "failed" terminal state
  // so the UI can show a real error and a retry button.
  const [syncJobIssues, setSyncJobIssues] = useState<
    Partial<
      Record<
        DatasetKey,
        { kind: "timeout" | "failed"; jobId: string; message?: string; at: number }
      >
    >
  >({});
  const [migratingLocalOnlyDatasets, setMigratingLocalOnlyDatasets] = useState(false);
  const [remoteSourceManifests, setRemoteSourceManifests] = useState<
    Partial<Record<DatasetKey, RemoteDatasetSourceManifestPayload>>
  >({});
  const [serverCloudDatasetManifest, setServerCloudDatasetManifest] = useState<
    Partial<Record<DatasetKey, RemoteDatasetManifestEntry>>
  >({});
  const [localDatasetPayloadHashes, setLocalDatasetPayloadHashes] = useState<
    Partial<Record<DatasetKey, string>>
  >({});
  const [forceDatasetSyncTick, setForceDatasetSyncTick] = useState(0);
  const [remoteStateHydrated, setRemoteStateHydrated] = useState(false);
  const allDatasetKeys = useMemo(
    () => Object.keys(DATASET_DEFINITIONS) as DatasetKey[],
    []
  );
  // Server-side storage: resolve scopeId for migration + tab endpoints
  const scopeIdQuery = solarRecTrpc.solarRecDashboard.getScopeId.useQuery(undefined, {
    retry: 2,
    staleTime: 5 * 60 * 1000,
  });
  const scopeId = scopeIdQuery.data?.scopeId ?? null;
  const scopeIdRef = useRef<string | null>(scopeId);
  scopeIdRef.current = scopeId;

  const remoteDashboardStateQuery = solarRecTrpc.solarRecDashboard.getState.useQuery(undefined, {
    retry: 4,
    retryDelay: (attempt) => Math.min(2000 * (attempt + 1), 10_000),
    staleTime: 5 * 60 * 1000,
    // This query only seeds legacy cloud hydration metadata. Once
    // the tab is open we explicitly invalidate on successful uploads,
    // so focus/reconnect refetches just re-trigger expensive remote
    // hydrate work and can stampede the server.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const datasetCloudStatusesQuery =
    solarRecTrpc.solarRecDashboard.getDatasetCloudStatuses.useQuery(
      { keys: allDatasetKeys },
      {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      }
    );
  // PR-6 (data-flow series): server-side dataset summaries replace
  // the in-memory `rows.length` reads that powered the Datasets-Loaded
  // counter, the Total-Rows readout, and (in PR-7) the Data Quality
  // tab. This query is cheap (~5 KB response, 2-3 DB roundtrips) and
  // lets the dashboard report accurate counts WITHOUT having every
  // dataset's CsvRow[] materialized in JS heap. Keyed off scope so
  // refetch-on-tab-focus picks up uploads from teammates.
  const datasetSummariesQuery =
    solarRecTrpc.solarRecDashboard.getDatasetSummariesAll.useQuery(undefined, {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
  const datasetSummariesByKey = useMemo(() => {
    const map: Partial<Record<string, { rowCount: number | null; byteCount: number | null; cloudStatus: "synced" | "failed" | "missing"; lastUpdated: string | null; isRowBacked: boolean }>> = {};
    if (datasetSummariesQuery.data?.summaries) {
      for (const s of datasetSummariesQuery.data.summaries) {
        map[s.datasetKey] = {
          rowCount: s.rowCount,
          byteCount: s.byteCount,
          cloudStatus: s.cloudStatus,
          lastUpdated: s.lastUpdated,
          isRowBacked: s.isRowBacked,
        };
      }
    }
    return map;
  }, [datasetSummariesQuery.data]);
  const saveRemoteDashboardState = solarRecTrpc.solarRecDashboard.saveState.useMutation();
  const getRemoteDataset = solarRecTrpc.solarRecDashboard.getDataset.useMutation();
  // Task 5.14 PR-5 (2026-04-27): the previous batched cold-cache
  // path (`getDatasetAssembled` mutation) is gone. Cold hydration
  // now always takes the per-key `getRemoteDataset` route below
  // (manifest → per-source chunks) so the only dataset payload
  // that crosses the wire on cold mount is the chunk-sized one
  // the legacy save path already produces. Eliminates the 50–150
  // MB single-response memory bombs that crashed Chrome tabs in
  // the 2026-04-26 OOM events. Server-side procedure removal +
  // dead-code sweep ships in PR-6.
  // Every saveDataset response is inspected here so the dbError
  // field actually reaches the UI. Pre-fix the 35+ mutateAsync call
  // sites discarded the response wholesale, which is the
  // LOCAL-ONLY-NEVER-PERSISTS bug surfacing as a green badge.
  // Hooking onSuccess at the mutation level avoids a mechanical
  // refactor of every call site.
  const saveRemoteDataset = solarRecTrpc.solarRecDashboard.saveDataset.useMutation({
    onSuccess: (data, variables) => {
      const datasetKey = deriveDatasetKeyFromStorageKey(variables.key);
      if (!datasetKey) return;
      // Read the post-PR2 server contract: when DB persist fails, the
      // server returns `partial: true` plus a non-null dbError. Fall
      // back to the legacy `persistedToDatabase === false` check so a
      // cached pre-PR2 response shape doesn't slip through unflagged.
      const isPartialFailure =
        data.partial === true || data.persistedToDatabase === false;
      if (isPartialFailure && data.dbError) {
        setLastDbErrors((previous) => ({
          ...previous,
          [datasetKey]: { message: data.dbError ?? "Unknown DB error", at: Date.now() },
        }));
        setDatasetCloudSyncStatus((previous) =>
          previous[datasetKey] === "failed"
            ? previous
            : { ...previous, [datasetKey]: "failed" }
        );
        return;
      }
      // success — drop any stale dbError for this dataset.
      setLastDbErrors((previous) => {
        if (!previous[datasetKey]) return previous;
        const next = { ...previous };
        delete next[datasetKey];
        return next;
      });
    },
  });
  // Atomic read-merge-write for the convertedReads manifest. Used in place
  // of saveRemoteDataset when key === "convertedReads" so server-managed
  // sources (mon_batch_*, individual_*) survive dashboard auto-sync even
  // when the client's in-memory state was hydrated before the server-side
  // bridge added them.
  const syncConvertedReadsUserSources =
    solarRecTrpc.solarRecDashboard.syncConvertedReadsUserSources.useMutation();
  const syncCoreDatasetToSrDs =
    solarRecTrpc.solarRecDashboard.syncCoreDatasetFromStorage.useMutation();
  const syncCoreDatasetToSrDsRef = useRef(syncCoreDatasetToSrDs);
  syncCoreDatasetToSrDsRef.current = syncCoreDatasetToSrDs;
  const activeCoreDatasetSyncJobRef = useRef<Partial<Record<DatasetKey, string>>>({});
  const setDatasetSyncProgressState = useCallback(
    (key: DatasetKey, progress: DatasetSyncProgressState | undefined) => {
      setDatasetSyncProgress((previous) => {
        if (!progress) {
          if (!previous[key]) return previous;
          const next = { ...previous };
          delete next[key];
          return next;
        }

        const existing = previous[key];
        if (
          existing &&
          existing.stage === progress.stage &&
          existing.percent === progress.percent &&
          existing.message === progress.message &&
          existing.current === progress.current &&
          existing.total === progress.total &&
          existing.unitLabel === progress.unitLabel &&
          existing.jobId === progress.jobId
        ) {
          return previous;
        }

        return { ...previous, [key]: progress };
      });
    },
    []
  );

  /**
   * Core-dataset keys whose uploads should re-sync into the typed
   * srDs* tables so the server-side system snapshot stays fresh.
   * Other keys (non-core datasets that don't feed the snapshot)
   * are skipped — saving time.
   */
  const CORE_DATASET_KEYS_FOR_SNAPSHOT = useMemo(
    () =>
      new Set<string>([
        "solarApplications",
        "abpReport",
        "generationEntry",
        "accountSolarGeneration",
        "contractedDate",
        "deliveryScheduleBase",
        "transferHistory",
      ]),
    []
  );

  const setDatabaseSyncProgressFromStatus = useCallback(
    (
      key: DatasetKey,
      jobId: string,
      status: {
        progress?: {
          percent: number;
          message: string;
          current: number;
          total: number;
          unitLabel: string;
        } | null;
      } | null
    ) => {
      const progress = status?.progress;
      if (!progress) return;
      setDatasetSyncProgressState(key, {
        stage: "database-sync",
        percent: clampSyncPercent(progress.percent),
        message: progress.message,
        current: progress.current,
        total: progress.total,
        unitLabel: progress.unitLabel,
        jobId,
        updatedAt: Date.now(),
      });
    },
    [setDatasetSyncProgressState]
  );

  const CORE_DATASET_SYNC_POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const CORE_DATASET_SYNC_POLL_INTERVAL_MS = 2000;

  const finishCoreDatasetSync = useCallback(
    async (
      key: DatasetKey,
      jobId: string,
      state: "done" | "unknown"
    ) => {
      if (activeCoreDatasetSyncJobRef.current[key] === jobId) {
        delete activeCoreDatasetSyncJobRef.current[key];
      }

      // Clear any prior timeout/failure on success so the
      // dataset card reverts to its normal badge state.
      if (state === "done") {
        setSyncJobIssues((previous) => {
          if (!previous[key]) return previous;
          const next = { ...previous };
          delete next[key];
          return next;
        });
      }

      const sid = scopeIdRef.current;

      if (state === "done") {
        if (!sid) {
          setDatasetSyncProgressState(key, undefined);
          return;
        }
        setDatasetSyncProgressState(key, {
          stage: "refreshing-snapshot",
          percent: 100,
          message: "Refreshing server snapshot",
          current: 1,
          total: 1,
          unitLabel: "steps",
          jobId,
          updatedAt: Date.now(),
        });
        await Promise.all([
          solarRecTrpcUtils.solarRecDashboard.getSystemSnapshot.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getTransferDeliveryLookup.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getActiveDatasetVersions.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getSystemSnapshotHash.invalidate({ scopeId: sid }),
        ]);
        window.setTimeout(() => {
          setDatasetSyncProgressState(key, undefined);
        }, 1500);
        return;
      }

      setDatasetSyncProgressState(key, undefined);

      // Best effort: the in-memory job registry may have been lost after
      // a restart even though the underlying batch already activated.
      if (sid) {
        await Promise.all([
          solarRecTrpcUtils.solarRecDashboard.getSystemSnapshot.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getTransferDeliveryLookup.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getActiveDatasetVersions.invalidate({ scopeId: sid }),
          solarRecTrpcUtils.solarRecDashboard.getSystemSnapshotHash.invalidate({ scopeId: sid }),
        ]);
      }
      // eslint-disable-next-line no-console
      console.error(
        `[solar-rec] srDs sync for ${key} became unknown before completion; progress UI cleared without marking success.`
      );
    },
    [setDatasetSyncProgressState, trpcUtils]
  );

  /**
   * Fire-and-forget trigger for a core-dataset srDs sync. Starts
   * a background job on the server (returning a jobId immediately)
   * and polls for completion in the background. On terminal
   * success, invalidates every tRPC query downstream of srDs*.
   *
   * Server-side contract:
   *   - syncCoreDatasetFromStorage returns { jobId, state:"pending" }
   *     immediately. The ingest runs on the Node event loop; no
   *     single HTTP request spans it, so Render's ~100s proxy
   *     timeout no longer matters.
   *   - getCoreDatasetSyncStatus({ jobId }) returns the current
   *     state: pending → running → (done | failed | unknown).
   *
   * Single-flight is enforced server-side: repeated saves for the
   * same (scope, datasetKey) return the same jobId and launch one
   * ingest.
   *
   * The invalidation list is inlined rather than going through the
   * invalidateServerDerivedSolarData helper so this callback can
   * live above that helper's declaration without a TDZ.
   */
  const triggerCoreDatasetSrDsSync = useCallback(
    (key: string) => {
      if (!CORE_DATASET_KEYS_FOR_SNAPSHOT.has(key)) return;

      void (async () => {
        let jobId: string;
        try {
          const startResult = await syncCoreDatasetToSrDsRef.current.mutateAsync(
            { datasetKey: key }
          );
          jobId = startResult.jobId;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[solar-rec] srDs sync for ${key} failed to start:`,
            err
          );
          return;
        }

        activeCoreDatasetSyncJobRef.current[key as DatasetKey] = jobId;
        setDatasetSyncProgressState(key as DatasetKey, {
          stage: "database-sync",
          percent: 0,
          message: "Queued for database sync",
          current: 0,
          total: 1,
          unitLabel: "steps",
          jobId,
          updatedAt: Date.now(),
        });

        const deadlineMs = Date.now() + CORE_DATASET_SYNC_POLL_TIMEOUT_MS;

        while (Date.now() < deadlineMs) {
          // Skip if a newer job for this key has since started —
          // the later trigger's polling loop owns the invalidation.
          if (activeCoreDatasetSyncJobRef.current[key as DatasetKey] !== jobId) {
            return;
          }

          const status = await solarRecTrpcUtils.solarRecDashboard.getCoreDatasetSyncStatus
            .fetch({ jobId })
            .catch(() => null);

          setDatabaseSyncProgressFromStatus(
            key as DatasetKey,
            jobId,
            status
          );

          if (!status || status.state === "pending" || status.state === "running") {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, CORE_DATASET_SYNC_POLL_INTERVAL_MS)
            );
            continue;
          }

          if (status.state === "failed") {
            if (activeCoreDatasetSyncJobRef.current[key as DatasetKey] === jobId) {
              delete activeCoreDatasetSyncJobRef.current[key as DatasetKey];
            }
            setDatasetSyncProgressState(key as DatasetKey, undefined);
            setSyncJobIssues((previous) => ({
              ...previous,
              [key as DatasetKey]: {
                kind: "failed",
                jobId,
                message: status.error ?? "Server reported the sync job failed.",
                at: Date.now(),
              },
            }));
            setDatasetCloudSyncStatus((previous) =>
              previous[key as DatasetKey] === "failed"
                ? previous
                : { ...previous, [key as DatasetKey]: "failed" }
            );
            // eslint-disable-next-line no-console
            console.error(
              `[solar-rec] srDs sync for ${key} failed:`,
              status.error
            );
            return;
          }

          // state === "done" | "unknown" — invalidate downstream
          // queries. "unknown" means the in-memory job state was
          // lost (for example after a restart), so do a best-effort
          // invalidate but do not present that as a successful 100%
          // completion to the user.
          await finishCoreDatasetSync(
            key as DatasetKey,
            jobId,
            status.state === "done" ? "done" : "unknown"
          );
          return;
        }

        if (activeCoreDatasetSyncJobRef.current[key as DatasetKey] === jobId) {
          delete activeCoreDatasetSyncJobRef.current[key as DatasetKey];
        }
        setDatasetSyncProgressState(key as DatasetKey, undefined);
        setSyncJobIssues((previous) => ({
          ...previous,
          [key as DatasetKey]: { kind: "timeout", jobId, at: Date.now() },
        }));
        // eslint-disable-next-line no-console
        console.error(
          `[solar-rec] srDs sync for ${key} polling timed out after 10min`
        );
      })();
    },
    [
      CORE_DATASET_SYNC_POLL_INTERVAL_MS,
      CORE_DATASET_SYNC_POLL_TIMEOUT_MS,
      CORE_DATASET_KEYS_FOR_SNAPSHOT,
      finishCoreDatasetSync,
      setDatabaseSyncProgressFromStatus,
      setDatasetSyncProgressState,
      trpcUtils,
    ]
  );
  const saveRemoteDashboardStateRef = useRef(saveRemoteDashboardState);
  saveRemoteDashboardStateRef.current = saveRemoteDashboardState;
  const getRemoteDatasetRef = useRef(getRemoteDataset);
  getRemoteDatasetRef.current = getRemoteDataset;
  const saveRemoteDatasetRef = useRef(saveRemoteDataset);
  saveRemoteDatasetRef.current = saveRemoteDataset;
  const syncConvertedReadsUserSourcesRef = useRef(syncConvertedReadsUserSources);
  syncConvertedReadsUserSourcesRef.current = syncConvertedReadsUserSources;
  const invalidateDatasetCloudStatuses = useCallback(() => {
    void solarRecTrpcUtils.solarRecDashboard.getDatasetCloudStatuses.invalidate({
      keys: allDatasetKeys,
    });
  }, [allDatasetKeys, trpcUtils]);
  const remoteDatasetSignatureRef = useRef<Partial<Record<DatasetKey, string>>>({});
  const remoteDatasetChunkKeysRef = useRef<Partial<Record<DatasetKey, string[]>>>({});
  const forcedRemoteDatasetSyncKeysRef = useRef<Set<DatasetKey>>(new Set());
  const remoteSourceManifestsRef = useRef<Partial<Record<DatasetKey, RemoteDatasetSourceManifestPayload>>>({});
  remoteSourceManifestsRef.current = remoteSourceManifests;
  // ownershipFilter, searchTerm — moved to @/solar-rec-dashboard/components/OwnershipTab
  // changeOwnership{Filter,Search,SortBy,SortDir} — moved to @/solar-rec-dashboard/components/ChangeOwnershipTab
  // offline* filter/sort state — moved to @/solar-rec-dashboard/components/OfflineMonitoringTab
  // performance{ContractId,DeliveryYearKey,PreviousSurplusInput,PreviousDrawdownInput}
  // + RecPerfSortKey + recPerf{SortBy,SortDir,Search,StatusFilter} +
  // recPerformanceResultsPage + handleRecPerfSort + recPerfSortIndicator
  // — moved to @/solar-rec-dashboard/components/RecPerformanceEvaluationTab
  // meterReads{Result,Error,Busy} — moved to @/solar-rec-dashboard/components/MeterReadsTab
  // performanceRatio filter/sort/page state — moved to @/solar-rec-dashboard/components/PerformanceRatioTab
  // recValuePage — moved to @/solar-rec-dashboard/components/RecValueTab
  // sizeSiteList{Page,Collapsed} — moved to @/solar-rec-dashboard/components/SizeReportingTab
  // snapshotContractPage — moved to @/solar-rec-dashboard/components/SnapshotLogTab
  // contractSummaryPage, contractDetailPage — moved to @/solar-rec-dashboard/components/ContractsTab
  // annualContractVintagePage, annualContractSummaryPage — moved to @/solar-rec-dashboard/components/AnnualReviewTab
  // offlineDetailPage — moved to @/solar-rec-dashboard/components/OfflineMonitoringTab
  // compliantSourcePage, compliantReportPage — moved to @/solar-rec-dashboard/components/PerformanceRatioTab
  // FinancialSortKey, RescanStatus types + financialSortBy/SortDir/Search/Filter,
  // rescanStatuses, batchRescanRunning, batchRescanCancelledRef state
  // — moved to @/solar-rec-dashboard/components/FinancialsTab
  //
  // Optimistic override cache: lives in the parent because the Pipeline
  // tab's cash flow aggregator also reads it. Financials writes via
  // setLocalOverrides passed as a prop.
  const [localOverrides, setLocalOverrides] = useState<Map<string, { vfp: number; acp: number }>>(new Map());
  const [uploadsExpanded, setUploadsExpanded] = useState(false);
  // Compliant source state + refs — moved to @/solar-rec-dashboard/components/PerformanceRatioTab
  // monthlySnapshotTransitions — moved to @/solar-rec-dashboard/components/SnapshotLogTab
  const [activeTab, setActiveTab] = useState<DashboardTabId>(
    () => (getTabFromSearch(search) ?? DEFAULT_DASHBOARD_TAB) as DashboardTabId
  );
  const visitedTabsRef = useRef(new Set<string>([activeTab]));
  useEffect(() => {
    visitedTabsRef.current.add(activeTab);
  }, [activeTab]);
  // pipeline{Count,Kw,Interconnected,CashFlow}Range, pipelineReportLoading,
  // generatePipelineReport — moved to @/solar-rec-dashboard/components/AppPipelineTab
  // Tab-active flags kept in the parent are the ones that still
  // gate a SHARED memo (one that's computed in the parent and
  // fed to one or more child tabs as props). Flags whose original
  // consumer memo moved into a child tab component have been
  // removed — the child's mount lifecycle is now the gate.
  const isContractsTabActive = activeTab === "contracts";
  const isAnnualReviewTabActive = activeTab === "annual-review";
  const isPerformanceEvalTabActive = activeTab === "performance-eval" || activeTab === "snapshot-log";
  const isPerformanceRatioTabActive = activeTab === "performance-ratio";
  const isForecastTabActive = activeTab === "forecast";
  const isOverviewTabActive = activeTab === "overview";
  const isPipelineTabActive = activeTab === "app-pipeline";
  const isFinancialsTabActive = activeTab === "financials";
  const isDeliveryTrackerTabActive = activeTab === "delivery-tracker";
  // Removed dead flags whose consumer memos moved out of the parent:
  // isTrendsTabActive, isAlertsTabActive, isComparisonsTabActive,
  // isDataQualityTabActive, isOfflineTabActive.
  const handleActiveTabChange = useCallback(
    (nextTabValue: string) => {
      if (!isDashboardTabId(nextTabValue)) return;
      startTransition(() => {
        setActiveTab(nextTabValue as DashboardTabId);
      });

      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      if (nextTabValue === DEFAULT_DASHBOARD_TAB) {
        params.delete("tab");
      } else {
        params.set("tab", nextTabValue);
      }

      const nextSearch = params.toString();
      const nextLocation = `${location}${nextSearch ? `?${nextSearch}` : ""}`;
      const currentLocation = `${location}${search ? `?${search}` : ""}`;
      if (nextLocation !== currentLocation) {
        setLocation(nextLocation);
      }
    },
    [location, search, setLocation]
  );
  const [selectedSystemKey, setSelectedSystemKey] = useState<string | null>(null);

  // systemNameLink — dead code removed in Phase 10. Each extracted
  // tab now defines its own locally (e.g. FinancialsTab) or calls
  // setSelectedSystemKey directly via the onSelectSystem prop.

  const isContractsComputationActive =
    isContractsTabActive || isAnnualReviewTabActive || isPerformanceEvalTabActive || isForecastTabActive;
  const datasetsRef = useRef(datasets);
  datasetsRef.current = datasets;
  const logEntriesRef = useRef(logEntries);
  logEntriesRef.current = logEntries;
  const datasetsHydratedRef = useRef(false);
  const remoteStateHydratedRef = useRef(false);
  const remoteLogsSignatureRef = useRef<string>("0");
  const remoteLogsChunkKeysRef = useRef<string[]>([]);
  const localDatasetSignatureRef = useRef<string>("");
  const localLogsSignatureRef = useRef<string>("0");
  // Phase 14: CSV parser worker pool. A single parser worker used
  // to queue up every parse request (cold hydrate of 15 datasets ran
  // one at a time on one worker — slow). We now spin up
  // CSV_WORKER_POOL_SIZE workers on first use and dispatch each
  // incoming request to the worker with the fewest in-flight tasks
  // (least-loaded). The global `csvParserPendingRef` map is keyed by
  // a monotonic id so any worker can resolve its own tasks
  // independently of the others.
  const csvParserPoolRef = useRef<Worker[] | null>(null);
  const csvParserPoolInFlightRef = useRef<number[]>([]);
  const csvParserPoolWorkerByIdRef = useRef(new Map<number, number>());
  const csvParserRequestSeqRef = useRef(1);
  const csvParserPendingRef = useRef(
    new Map<number, { resolve: (value: { headers: string[]; rows: CsvRow[] }) => void; reject: (error: Error) => void }>()
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const nextHashes: Partial<Record<DatasetKey, string>> = {};

      for (const key of allDatasetKeys) {
        if (localOnlyDatasets[key]) continue;
        const sourceManifest = remoteSourceManifests[key];
        const dataset = datasets[key];
        const payload =
          sourceManifest?.sources?.length
            ? safeJsonStringify(sourceManifest)
            : dataset
              ? serializeDatasetForRemote(dataset)
              : null;
        if (!payload) continue;
        const hash = await computeSha256Hex(payload);
        if (!hash) continue;
        nextHashes[key] = hash;
      }

      if (cancelled) return;

      setLocalDatasetPayloadHashes((current) => {
        const next: Partial<Record<DatasetKey, string>> = {};
        allDatasetKeys.forEach((key) => {
          const hash = nextHashes[key];
          if (hash) {
            next[key] = hash;
            return;
          }
          if (!datasets[key] && !remoteSourceManifests[key]?.sources?.length) {
            return;
          }
          if (current[key]) {
            next[key] = current[key];
          }
        });
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [allDatasetKeys, datasets, localOnlyDatasets, remoteSourceManifests]);

  useEffect(() => {
    const tabFromQuery = getTabFromSearch(search);
    const nextTab = (tabFromQuery ?? DEFAULT_DASHBOARD_TAB) as DashboardTabId;
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }, [activeTab, search]);

  // Phase 14: spin up (or return the existing) pool of CSV parser
  // workers. Each worker parses one CSV at a time; the pool lets us
  // parse up to CSV_WORKER_POOL_SIZE datasets concurrently.
  // Returns null in environments without Web Workers (SSR, very
  // old browsers), which triggers the synchronous main-thread
  // fallback in the parse* wrappers below.
  const ensureCsvParserPool = useCallback(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    if (csvParserPoolRef.current && csvParserPoolRef.current.length > 0) {
      return csvParserPoolRef.current;
    }

    const poolSize = Math.max(
      1,
      Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4),
    );
    const workers: Worker[] = [];
    for (let index = 0; index < poolSize; index += 1) {
      const worker = new Worker(
        new URL("../../workers/csvParser.worker.ts", import.meta.url),
        { type: "module" },
      );

      worker.onmessage = (event: MessageEvent<CsvParserWorkerResponse>) => {
        const message = event.data;
        const pending = csvParserPendingRef.current.get(message.id);
        if (pending) {
          csvParserPendingRef.current.delete(message.id);
          if (message.ok) {
            pending.resolve({ headers: message.headers, rows: message.rows });
          } else {
            pending.reject(new Error(message.error || "Failed to parse CSV in worker."));
          }
        }
        // Decrement the in-flight counter for the worker that owned
        // this task — this lets the dispatch logic pick the now-idle
        // worker for the next request.
        const workerIndex = csvParserPoolWorkerByIdRef.current.get(message.id);
        if (workerIndex !== undefined) {
          csvParserPoolWorkerByIdRef.current.delete(message.id);
          const counter = csvParserPoolInFlightRef.current[workerIndex];
          if (counter !== undefined && counter > 0) {
            csvParserPoolInFlightRef.current[workerIndex] = counter - 1;
          }
        }
      };

      worker.onerror = () => {
        // One worker in the pool crashed — reject every pending task
        // routed to that worker, terminate the whole pool, and null
        // the refs so the next parse call rebuilds a fresh pool.
        csvParserPendingRef.current.forEach(({ reject }) => {
          reject(new Error("CSV parsing worker crashed."));
        });
        csvParserPendingRef.current.clear();
        csvParserPoolWorkerByIdRef.current.clear();
        (csvParserPoolRef.current ?? []).forEach((w) => {
          try {
            w.terminate();
          } catch {
            // Ignore; we're tearing the pool down.
          }
        });
        csvParserPoolRef.current = null;
        csvParserPoolInFlightRef.current = [];
      };

      workers.push(worker);
    }

    csvParserPoolRef.current = workers;
    csvParserPoolInFlightRef.current = new Array(workers.length).fill(0);
    return workers;
  }, []);

  // Pick the least-loaded worker in the pool. Ties break toward the
  // lowest index so the pool warms up in order.
  const pickCsvParserWorker = useCallback((): { worker: Worker; index: number } | null => {
    const pool = ensureCsvParserPool();
    if (!pool || pool.length === 0) return null;
    const inFlight = csvParserPoolInFlightRef.current;
    let bestIndex = 0;
    let bestLoad = inFlight[0] ?? 0;
    for (let i = 1; i < pool.length; i += 1) {
      const load = inFlight[i] ?? 0;
      if (load < bestLoad) {
        bestIndex = i;
        bestLoad = load;
      }
    }
    return { worker: pool[bestIndex]!, index: bestIndex };
  }, [ensureCsvParserPool]);

  const parseCsvFileAsync = useCallback(
    async (file: File): Promise<{ headers: string[]; rows: CsvRow[] }> => {
      const picked = pickCsvParserWorker();
      if (!picked) {
        const text = await file.text();
        return parseCsv(text);
      }

      return new Promise((resolve, reject) => {
        const id = csvParserRequestSeqRef.current++;
        csvParserPendingRef.current.set(id, { resolve, reject });
        csvParserPoolWorkerByIdRef.current.set(id, picked.index);
        csvParserPoolInFlightRef.current[picked.index] =
          (csvParserPoolInFlightRef.current[picked.index] ?? 0) + 1;
        const message: CsvParserWorkerRequest = { id, mode: "file", file };
        picked.worker.postMessage(message);
      });
    },
    [pickCsvParserWorker],
  );

  const parseCsvTextAsync = useCallback(
    async (text: string): Promise<{ headers: string[]; rows: CsvRow[] }> => {
      const picked = pickCsvParserWorker();
      if (!picked) {
        return parseCsv(text);
      }

      return new Promise((resolve, reject) => {
        const id = csvParserRequestSeqRef.current++;
        csvParserPendingRef.current.set(id, { resolve, reject });
        csvParserPoolWorkerByIdRef.current.set(id, picked.index);
        csvParserPoolInFlightRef.current[picked.index] =
          (csvParserPoolInFlightRef.current[picked.index] ?? 0) + 1;
        const message: CsvParserWorkerRequest = { id, mode: "text", text };
        picked.worker.postMessage(message);
      });
    },
    [pickCsvParserWorker],
  );

  const invalidateServerDerivedSolarData = useCallback(async () => {
    if (!scopeId) return;
    await Promise.all([
      solarRecTrpcUtils.solarRecDashboard.getSystemSnapshot.invalidate({ scopeId }),
      solarRecTrpcUtils.solarRecDashboard.getTransferDeliveryLookup.invalidate({ scopeId }),
      solarRecTrpcUtils.solarRecDashboard.getActiveDatasetVersions.invalidate({ scopeId }),
      solarRecTrpcUtils.solarRecDashboard.getSystemSnapshotHash.invalidate({ scopeId }),
    ]);
  }, [scopeId, trpcUtils]);

  const pollCoreDatasetSyncJob = useCallback(
    async (key: DatasetKey, jobId: string) => {
      const deadlineMs = Date.now() + CORE_DATASET_SYNC_POLL_TIMEOUT_MS;

      while (Date.now() < deadlineMs) {
        if (activeCoreDatasetSyncJobRef.current[key] !== jobId) return;

        const status =
          await solarRecTrpcUtils.solarRecDashboard.getCoreDatasetSyncStatus.fetch({
            jobId,
          }).catch(() => null);

        setDatabaseSyncProgressFromStatus(key, jobId, status);

        if (!status || status.state === "running" || status.state === "pending") {
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, CORE_DATASET_SYNC_POLL_INTERVAL_MS)
          );
          continue;
        }

        if (status.state === "failed") {
          if (activeCoreDatasetSyncJobRef.current[key] === jobId) {
            delete activeCoreDatasetSyncJobRef.current[key];
          }
          setDatasetSyncProgressState(key, undefined);
          setSyncJobIssues((previous) => ({
            ...previous,
            [key]: {
              kind: "failed",
              jobId,
              message: status.error ?? "Server reported the sync job failed.",
              at: Date.now(),
            },
          }));
          setDatasetCloudSyncStatus((previous) =>
            previous[key] === "failed" ? previous : { ...previous, [key]: "failed" }
          );
          // eslint-disable-next-line no-console
          console.error(`[solar-rec] srDs sync for ${key} failed:`, status.error);
          return;
        }

        await finishCoreDatasetSync(
          key,
          jobId,
          status.state === "done" ? "done" : "unknown"
        );
        return;
      }

      if (activeCoreDatasetSyncJobRef.current[key] === jobId) {
        delete activeCoreDatasetSyncJobRef.current[key];
      }
      setDatasetSyncProgressState(key, undefined);
      setSyncJobIssues((previous) => ({
        ...previous,
        [key]: { kind: "timeout", jobId, at: Date.now() },
      }));
      // eslint-disable-next-line no-console
      console.error(`[solar-rec] srDs sync for ${key} did not finish before client polling timed out.`);
    },
    [
      CORE_DATASET_SYNC_POLL_INTERVAL_MS,
      CORE_DATASET_SYNC_POLL_TIMEOUT_MS,
      finishCoreDatasetSync,
      setDatabaseSyncProgressFromStatus,
      setDatasetSyncProgressState,
      trpcUtils,
    ]
  );

  // Resume polling for any background sync job that was already
  // in flight when the tab mounted (e.g. the user reloaded during
  // a long ingest). Without this, the server keeps running the
  // job to completion but the client loses track of it and
  // downstream tRPC queries stay stale until the next unrelated
  // invalidation.
  useEffect(() => {
    if (!scopeId) return;
    let cancelled = false;
    void (async () => {
      const active = await solarRecTrpcUtils.solarRecDashboard.getActiveCoreDatasetSyncJobs
        .fetch()
        .catch(() => null);
      if (cancelled || !active) return;
      for (const job of active) {
        if (!isDatasetKey(job.datasetKey)) continue;
        if (activeCoreDatasetSyncJobRef.current[job.datasetKey] === job.jobId) {
          continue;
        }
        activeCoreDatasetSyncJobRef.current[job.datasetKey] = job.jobId;
        setDatabaseSyncProgressFromStatus(job.datasetKey, job.jobId, {
          progress:
            (job as {
              progress?: {
                percent: number;
                message: string;
                current: number;
                total: number;
                unitLabel: string;
              } | null;
            }).progress ?? null,
        });
        void pollCoreDatasetSyncJob(job.datasetKey, job.jobId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeId, trpcUtils, pollCoreDatasetSyncJob]);

  const uploadRemoteChunkPayload = useCallback(async (key: string, payload: string) => {
    await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload }));
  }, []);

  // Phase 13a: chunk uploads now run in parallel via Promise.all.
  // Each chunk is an independent mutation keyed by its chunk index,
  // so order doesn't matter and the existing per-call withRetry
  // already handles transient failures. The chunk-pointer write is
  // held back until *all* chunk writes succeed so a reader never sees
  // a pointer referencing a chunk that isn't yet committed.
  const saveRemotePayloadWithChunks = useCallback(async (key: string, payload: string): Promise<string[]> => {
    const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
    if (chunks.length === 1) {
      await uploadRemoteChunkPayload(key, payload);
      return [];
    }

    const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(key, index));
    await mapWithBoundedConcurrency(
      chunks.map((chunk, index) => ({ chunk, index })),
      REMOTE_WRITE_CONCURRENCY,
      ({ chunk, index }) =>
        uploadRemoteChunkPayload(chunkKeys[index]!, chunk)
    );
    await uploadRemoteChunkPayload(key, buildChunkPointerPayload(chunkKeys));
    return chunkKeys;
  }, [uploadRemoteChunkPayload]);

  const saveRemoteTextFileWithChunks = useCallback(
    async (
      key: string,
      file: File,
      onProgress?: (processedBytes: number, totalBytes: number) => void
    ): Promise<string[]> => {
      const chunkKeys: string[] = [];
      const decoder = new TextDecoder();
      let chunkIndex = 0;
      let bufferedText = "";
      onProgress?.(0, file.size);

      const flushBufferedText = async (force = false) => {
        while (
          bufferedText.length >= REMOTE_DATASET_CHUNK_CHAR_LIMIT ||
          (force && bufferedText.length > 0)
        ) {
          const nextChunk = bufferedText.slice(0, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          bufferedText = bufferedText.slice(REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          const chunkKey = buildRemoteDatasetChunkKey(key, chunkIndex++);
          await uploadRemoteChunkPayload(chunkKey, nextChunk);
          chunkKeys.push(chunkKey);
        }
      };

      for (let offset = 0; offset < file.size; offset += REMOTE_FILE_STREAM_SLICE_BYTES) {
        const slice = file.slice(offset, offset + REMOTE_FILE_STREAM_SLICE_BYTES);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        const isLastSlice = offset + REMOTE_FILE_STREAM_SLICE_BYTES >= file.size;
        bufferedText += decoder.decode(bytes, { stream: !isLastSlice });
        await flushBufferedText(false);
        onProgress?.(Math.min(offset + bytes.length, file.size), file.size);
      }

      await flushBufferedText(true);
      if (chunkKeys.length === 0) {
        await uploadRemoteChunkPayload(key, "");
        onProgress?.(file.size, file.size);
        return [];
      }

      await uploadRemoteChunkPayload(key, buildChunkPointerPayload(chunkKeys));
      onProgress?.(file.size, file.size);
      return chunkKeys;
    },
    [uploadRemoteChunkPayload]
  );

  const saveRemoteBinaryFileWithChunks = useCallback(
    async (
      key: string,
      file: File,
      onProgress?: (processedBytes: number, totalBytes: number) => void
    ): Promise<string[]> => {
      const chunkKeys: string[] = [];
      let chunkIndex = 0;
      let bufferedBase64 = "";
      let carryBytes = new Uint8Array(0);
      onProgress?.(0, file.size);

      const flushBufferedBase64 = async (force = false) => {
        while (
          bufferedBase64.length >= REMOTE_DATASET_CHUNK_CHAR_LIMIT ||
          (force && bufferedBase64.length > 0)
        ) {
          const nextChunk = bufferedBase64.slice(0, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          bufferedBase64 = bufferedBase64.slice(REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          const chunkKey = buildRemoteDatasetChunkKey(key, chunkIndex++);
          await uploadRemoteChunkPayload(chunkKey, nextChunk);
          chunkKeys.push(chunkKey);
        }
      };

      for (let offset = 0; offset < file.size; offset += REMOTE_FILE_STREAM_SLICE_BYTES) {
        const slice = file.slice(offset, offset + REMOTE_FILE_STREAM_SLICE_BYTES);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        const combined = concatUint8Arrays(carryBytes, bytes);
        const fullGroupLength = combined.length - (combined.length % 3);

        if (fullGroupLength > 0) {
          bufferedBase64 += bytesToBase64(combined.subarray(0, fullGroupLength));
          await flushBufferedBase64(false);
        }

        carryBytes = combined.slice(fullGroupLength);
        onProgress?.(Math.min(offset + bytes.length, file.size), file.size);
      }

      if (carryBytes.length > 0) {
        bufferedBase64 += bytesToBase64(carryBytes);
      }

      await flushBufferedBase64(true);
      if (chunkKeys.length === 0) {
        await uploadRemoteChunkPayload(key, "");
        onProgress?.(file.size, file.size);
        return [];
      }

      await uploadRemoteChunkPayload(key, buildChunkPointerPayload(chunkKeys));
      onProgress?.(file.size, file.size);
      return chunkKeys;
    },
    [uploadRemoteChunkPayload]
  );

  // Phase 13a: chunk clears are also independent mutations — parallel
  // them too. The primary-key clear (empty payload) is kept as its
  // own call because readers use that as the "tombstone" signal, and
  // we want the ordering: clear pointer first, then detach chunks.
  const clearRemotePayloadWithChunks = useCallback(async (key: string, chunkKeys: string[] | undefined) => {
    await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload: "" }));
    if (!Array.isArray(chunkKeys) || chunkKeys.length === 0) return;
    await mapWithBoundedConcurrency(chunkKeys, REMOTE_WRITE_CONCURRENCY, (chunkKey) =>
      withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }))
    );
  }, []);

  const setDatasetCloudSyncBadge = useCallback(
    (key: DatasetKey, status: DatasetCloudSyncStatus | undefined) => {
      setDatasetCloudSyncStatus((previous) => {
        if (!status) {
          if (!previous[key]) return previous;
          const next = { ...previous };
          delete next[key];
          return next;
        }
        if (previous[key] === status) return previous;
        return { ...previous, [key]: status };
      });
    },
    []
  );

  const syncDatasetSourceManifestToCloud = useCallback(
    async (key: DatasetKey, manifest: RemoteDatasetSourceManifestPayload): Promise<boolean> => {
      const manifestPayload = safeJsonStringify(manifest);
      if (!manifestPayload) {
        setDatasetCloudSyncBadge(key, "failed");
        setStorageNotice(`Could not serialize ${DATASET_DEFINITIONS[key].label} source manifest for cloud sync.`);
        return false;
      }

      try {
        // convertedReads manifest is server-owned (monitoring batch bridge
        // + individual meter-reads pushes write directly to it). Route
        // client-driven edits through the merge mutation so server-managed
        // sources survive the write.
        if (key === "convertedReads") {
          const userSources = manifest.sources.filter(
            (source) => !isServerManagedConvertedReadsSourceId(source.id)
          );
          await withRetry(() =>
            syncConvertedReadsUserSourcesRef.current.mutateAsync({
              userSources: userSources.map((source) => ({
                id: source.id,
                fileName: source.fileName,
                uploadedAt: source.uploadedAt,
                rowCount: source.rowCount,
                sizeBytes: source.sizeBytes,
                storageKey: source.storageKey,
                chunkKeys: source.chunkKeys,
                encoding: source.encoding,
                contentType: source.contentType,
              })),
            })
          );
          const latestSource = manifest.sources[manifest.sources.length - 1];
          const rowCount = datasetsRef.current[key]?.rows.length ?? latestSource?.rowCount ?? 0;
          remoteDatasetSignatureRef.current[key] =
            `raw:${manifest.sources.length}|${latestSource?.id ?? ""}|${latestSource?.uploadedAt ?? ""}|${rowCount}`;
          remoteDatasetChunkKeysRef.current[key] = [];
          setLocalOnlyDatasets((previous) => ({ ...previous, [key]: false }));
          setDatasetCloudSyncBadge(key, "pending");
          invalidateDatasetCloudStatuses();
          if (CORE_DATASET_KEYS_FOR_SNAPSHOT.has(key)) {
            triggerCoreDatasetSrDsSync(key);
          } else {
            setDatasetSyncProgressState(key, {
              stage: "uploading",
              percent: 100,
              message: "Cloud upload complete",
              current: latestSource?.sizeBytes ?? rowCount,
              total: latestSource?.sizeBytes ?? rowCount,
              unitLabel: latestSource?.sizeBytes ? "bytes" : "rows",
              updatedAt: Date.now(),
            });
            window.setTimeout(() => {
              setDatasetSyncProgressState(key, undefined);
            }, 1500);
          }
          return true;
        }

        const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
        const chunkKeys = await saveRemotePayloadWithChunks(key, manifestPayload);
        const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
        for (const staleChunkKey of staleChunkKeys) {
          await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }));
        }
        remoteDatasetChunkKeysRef.current[key] = chunkKeys;

        const latestSource = manifest.sources[manifest.sources.length - 1];
        const rowCount = datasetsRef.current[key]?.rows.length ?? latestSource?.rowCount ?? 0;
        remoteDatasetSignatureRef.current[key] =
          `raw:${manifest.sources.length}|${latestSource?.id ?? ""}|${latestSource?.uploadedAt ?? ""}|${rowCount}`;

        const activeKeys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((candidate) => {
          if (candidate === key) return manifest.sources.length > 0;
          return Boolean(datasetsRef.current[candidate]);
        });

        await withRetry(() =>
          saveRemoteDatasetRef.current.mutateAsync({
            key: REMOTE_DATASET_KEY_MANIFEST,
            payload: buildDatasetKeyManifestPayload(activeKeys),
          })
        );

        const verification = await withRetry(() => getRemoteDatasetRef.current.mutateAsync({ key })).catch(() => null);
        if (!verification?.payload) {
          throw new Error("Cloud verification returned empty payload.");
        }

        setLocalOnlyDatasets((previous) => ({ ...previous, [key]: false }));
        setDatasetCloudSyncBadge(key, "pending");
        invalidateDatasetCloudStatuses();

        // Phase 8.1.5: fire-and-forget srDs sync for core datasets
        // so the server-side system snapshot rebuilds with the new
        // rows. Doesn't block the user — if the sync fails the old
        // srDs batch stays active as the reader's source of truth.
        if (CORE_DATASET_KEYS_FOR_SNAPSHOT.has(key)) {
          triggerCoreDatasetSrDsSync(key);
        } else {
          setDatasetSyncProgressState(key, {
            stage: "uploading",
            percent: 100,
            message: "Cloud upload complete",
            current: latestSource?.sizeBytes ?? rowCount,
            total: latestSource?.sizeBytes ?? rowCount,
            unitLabel: latestSource?.sizeBytes ? "bytes" : "rows",
            updatedAt: Date.now(),
          });
          window.setTimeout(() => {
            setDatasetSyncProgressState(key, undefined);
          }, 1500);
        }

        return true;
      } catch (error) {
        setDatasetSyncProgressState(key, undefined);
        setDatasetCloudSyncBadge(key, "failed");
        const message =
          error instanceof Error ? error.message : "Unknown error while syncing source manifest to cloud.";
        setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} source manifest to cloud: ${message}`);
        return false;
      }
    },
    [
      invalidateDatasetCloudStatuses,
      saveRemotePayloadWithChunks,
      setDatasetCloudSyncBadge,
      setDatasetSyncProgressState,
      triggerCoreDatasetSrDsSync,
      CORE_DATASET_KEYS_FOR_SNAPSHOT,
    ]
  );

  const uploadRemoteSourceFile = useCallback(
    async (
      key: DatasetKey,
      source: {
        file: File;
        uploadedAt: Date;
        rowCount: number;
      },
      onProgress?: (processedBytes: number, totalBytes: number) => void
    ): Promise<RemoteDatasetSourceRef> => {
      const sourceId = createRemoteSourceId();
      const storageKey = buildRemoteSourceStorageKey(key, sourceId);
      const contentType = source.file.type || "application/octet-stream";
      const csvLike = isCsvLikeFile(source.file.name, contentType);
      const encoding: RemoteDatasetSourceEncoding = csvLike ? "utf8" : "base64";

      // Stream the file in slices — never more than
      // REMOTE_FILE_STREAM_SLICE_BYTES of raw bytes (plus one chunk
      // worth of encoded text) resident in memory at once. The
      // earlier `file.text()` / `file.arrayBuffer()` approach put
      // the entire payload in browser memory before chunking,
      // which could OOM the tab on large CSVs (200MB+).
      const chunkKeys = csvLike
        ? await saveRemoteTextFileWithChunks(storageKey, source.file, onProgress)
        : await saveRemoteBinaryFileWithChunks(storageKey, source.file, onProgress);

      return {
        id: sourceId,
        fileName: source.file.name,
        uploadedAt: source.uploadedAt.toISOString(),
        rowCount: source.rowCount,
        sizeBytes: source.file.size,
        storageKey,
        chunkKeys: chunkKeys.length > 0 ? chunkKeys : undefined,
        encoding,
        contentType,
      } satisfies RemoteDatasetSourceRef;
    },
    [saveRemoteTextFileWithChunks, saveRemoteBinaryFileWithChunks]
  );

  const persistDatasetSourceFilesToCloud = useCallback(
    async (
      key: DatasetKey,
      mode: "replace" | "append",
      uploads: Array<{
        file: File;
        uploadedAt: Date;
        rowCount: number;
      }>
    ): Promise<boolean> => {
      if (uploads.length === 0) return false;
      setDatasetCloudSyncBadge(key, "pending");
      try {
        // Append-mode safety: when the user clicks "Add CSV(s)" on a
        // multi-append dataset that's still "Tap tab to load" (cloud-
        // saved but not locally hydrated), `remoteSourceManifestsRef`
        // is empty for this key. Pre-fix, this caused
        // `previousSources = []` → the merge collapsed every prior
        // source down to just the new upload — silently clobbering
        // the cloud manifest. (User-visible regression: a
        // transferHistory dataset with 68 accumulated GATS uploads
        // shrank to 1 after a single Add CSV(s) click.) Fetch the
        // authoritative manifest from server before merging; if the
        // fetch fails on append, abort the upload rather than
        // collapse the manifest.
        if (
          mode === "append" &&
          MULTI_APPEND_DATASET_KEYS.has(key) &&
          !remoteSourceManifestsRef.current[key]
        ) {
          try {
            const response = await withRetry(
              () => getRemoteDatasetRef.current.mutateAsync({ key }),
              3,
              250
            );
            const payload = response?.payload;
            if (payload) {
              const chunkKeys = parseChunkPointerPayload(payload);
              let manifestText: string | null = payload;
              if (chunkKeys && chunkKeys.length > 0) {
                const chunkResponses = await mapWithBoundedConcurrency(
                  chunkKeys,
                  REMOTE_READ_CONCURRENCY,
                  (chunkKey) =>
                    withRetry(
                      () => getRemoteDatasetRef.current.mutateAsync({ key: chunkKey }),
                      3,
                      250
                    ).catch(() => null)
                );
                let combined = "";
                let allOk = true;
                for (const chunkResponse of chunkResponses) {
                  if (!chunkResponse?.payload) {
                    allOk = false;
                    break;
                  }
                  combined += chunkResponse.payload;
                }
                manifestText = allOk ? combined : null;
              }
              const fetchedManifest = manifestText
                ? parseRemoteSourceManifestPayload(manifestText)
                : null;
              if (fetchedManifest) {
                remoteSourceManifestsRef.current[key] = fetchedManifest;
                setRemoteSourceManifests((previous) => ({
                  ...previous,
                  [key]: fetchedManifest,
                }));
              }
            }
          } catch (manifestError) {
            // Hard fail: surfacing this is critical because the
            // alternative is a silent manifest clobber.
            setDatasetCloudSyncBadge(key, "failed");
            const message =
              manifestError instanceof Error
                ? manifestError.message
                : "Unknown error while fetching the existing source manifest.";
            setStorageNotice(
              `Could not read the existing ${DATASET_DEFINITIONS[key].label} manifest from cloud — append aborted to avoid clobbering prior sources. ${message}`
            );
            return false;
          }
        }
        const previousManifest = remoteSourceManifestsRef.current[key];
        const previousSources = previousManifest?.sources ?? [];
        const uploadedSources: RemoteDatasetSourceRef[] = [];
        const totalBytes = uploads.reduce(
          (sum, source) => sum + Math.max(source.file.size, 0),
          0
        );
        let completedBytes = 0;

        setDatasetSyncProgressState(key, {
          stage: "uploading",
          percent: 0,
          message:
            uploads.length > 1
              ? "Uploading source files to cloud"
              : "Uploading source file to cloud",
          current: 0,
          total: totalBytes,
          unitLabel: "bytes",
          updatedAt: Date.now(),
        });

        for (let index = 0; index < uploads.length; index += 1) {
          const source = uploads[index]!;
          const uploadedSource = await uploadRemoteSourceFile(
            key,
            source,
            (processedBytes, sourceTotalBytes) => {
              const currentBytes = completedBytes + processedBytes;
              setDatasetSyncProgressState(key, {
                stage: "uploading",
                percent: clampSyncPercent(
                  totalBytes > 0 ? (currentBytes / totalBytes) * 100 : 100
                ),
                message:
                  uploads.length > 1
                    ? `Uploading source files (${index + 1}/${uploads.length})`
                    : "Uploading source file to cloud",
                current: currentBytes,
                total: totalBytes,
                unitLabel: "bytes",
                updatedAt: Date.now(),
              });
              if (sourceTotalBytes === 0 && totalBytes === 0) {
                setDatasetSyncProgressState(key, {
                  stage: "uploading",
                  percent: 100,
                  message: "Uploading source file to cloud",
                  current: 0,
                  total: 0,
                  unitLabel: "bytes",
                  updatedAt: Date.now(),
                });
              }
            }
          );
          uploadedSources.push(uploadedSource);
          completedBytes += Math.max(source.file.size, 0);
        }

        const mergedSources =
          mode === "append" ? [...previousSources, ...uploadedSources] : uploadedSources;
        const nextManifest: RemoteDatasetSourceManifestPayload = {
          _rawSourcesV1: true,
          version: 1,
          sources: mergedSources,
        };

        if (mode === "replace" && previousSources.length > 0) {
          for (const staleSource of previousSources) {
            try {
              await clearRemotePayloadWithChunks(staleSource.storageKey, staleSource.chunkKeys);
            } catch {
              // Best effort stale-source cleanup.
            }
          }
        }

        setRemoteSourceManifests((previous) => ({
          ...previous,
          [key]: nextManifest,
        }));

        const synced = await syncDatasetSourceManifestToCloud(key, nextManifest);
        if (synced) {
          setForceDatasetSyncTick((previous) => previous + 1);
        }
        return synced;
      } catch (error) {
        setDatasetSyncProgressState(key, undefined);
        const message = error instanceof Error ? error.message : "Unknown error while syncing source files to cloud.";
        setDatasetCloudSyncBadge(key, "failed");
        setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} source file(s) to cloud: ${message}`);
        return false;
      }
    },
    [
      clearRemotePayloadWithChunks,
      setDatasetCloudSyncBadge,
      setDatasetSyncProgressState,
      syncDatasetSourceManifestToCloud,
      uploadRemoteSourceFile,
    ]
  );

  // Phase 14: unmount cleanup now terminates every worker in the
  // pool and clears the per-worker in-flight counters.
  useEffect(() => {
    return () => {
      csvParserPendingRef.current.forEach(({ reject }) => {
        reject(new Error("CSV parser worker terminated."));
      });
      csvParserPendingRef.current.clear();
      csvParserPoolWorkerByIdRef.current.clear();
      (csvParserPoolRef.current ?? []).forEach((worker) => {
        try {
          worker.terminate();
        } catch {
          // Ignore — we're tearing down anyway.
        }
      });
      csvParserPoolRef.current = null;
      csvParserPoolInFlightRef.current = [];
    };
  }, []);

  const jumpToSection = (sectionId: string) => {
    if (typeof document === "undefined") return;
    const target = document.getElementById(sectionId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const enqueueDatasetUploadTask = async <T,>(
    label: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const previousTail = uploadQueueTailRef.current;
    const queuedBehindAnotherTask =
      activeUploadTaskRef.current || queuedUploadTaskCountRef.current > 0;

    if (queuedBehindAnotherTask) {
      queuedUploadTaskCountRef.current += 1;
      setQueuedUploadTaskCount(queuedUploadTaskCountRef.current);
      setStorageNotice(
        `${label} queued. Uploads now run one at a time to keep Chrome stable.`
      );
    }

    const wrappedTask = previousTail.catch(() => undefined).then(async () => {
      if (queuedBehindAnotherTask) {
        queuedUploadTaskCountRef.current = Math.max(
          0,
          queuedUploadTaskCountRef.current - 1
        );
        setQueuedUploadTaskCount(queuedUploadTaskCountRef.current);
      }

      activeUploadTaskRef.current = true;
      setActiveUploadTaskLabel(label);

      try {
        return await task();
      } finally {
        activeUploadTaskRef.current = false;
        setActiveUploadTaskLabel((current) =>
          current === label ? null : current
        );
      }
    });

    uploadQueueTailRef.current = wrappedTask.then(
      () => undefined,
      () => undefined
    );

    return wrappedTask;
  };

  // saveCompliantSourceEntry, removeCompliantSourceEntry, importCompliantSourceCsv — moved to @/solar-rec-dashboard/components/PerformanceRatioTab

  const handleUpload = async (key: DatasetKey, file: File | null, mode: "replace" | "append" = "replace") => {
    if (!file) return;

    const config = DATASET_DEFINITIONS[key];
    if (file.size > MAX_SINGLE_CSV_UPLOAD_BYTES) {
      setUploadErrors((previous) => ({
        ...previous,
        [key]: `${file.name} is too large (${formatNumber(file.size / 1024 / 1024, 1)} MB). Please split files larger than ${formatNumber(MAX_SINGLE_CSV_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      }));
      return;
    }

    try {
      await enqueueDatasetUploadTask(`${config.label} upload`, async () => {
        const parsed = TABULAR_DATASET_KEYS.has(key)
          ? file.name.toLowerCase().endsWith(".csv")
            ? await parseCsvFileAsync(file)
            : await parseTabularFile(file)
          : await parseCsvFileAsync(file);
        const isValid = config.requiredHeaderSets.some((set) =>
          matchesExpectedHeaders(parsed.headers, set)
        );

        if (!isValid) {
          setUploadErrors((previous) => ({
            ...previous,
            [key]: `This file does not match the expected ${config.label} format.`,
          }));
          return;
        }

        const uploadedAt = new Date();
        const shouldAppend =
          MULTI_APPEND_DATASET_KEYS.has(key) && mode === "append";
        setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
        setDatasets((previous) => ({
          ...previous,
          [key]: (() => {
            const existing = previous[key];

            if (shouldAppend && existing) {
              const combinedHeaders = Array.from(
                new Set([...existing.headers, ...parsed.headers])
              );
              const existingRows = existing.rows;
              const dedupeKeys = new Set(
                existingRows.map((row) => datasetAppendRowKey(key, row))
              );
              const appendedRows = parsed.rows.filter((row) => {
                const dedupeKey = datasetAppendRowKey(key, row);
                if (!dedupeKey) return true;
                if (dedupeKeys.has(dedupeKey)) return false;
                dedupeKeys.add(dedupeKey);
                return true;
              });

              const existingSources =
                existing.sources && existing.sources.length > 0
                  ? existing.sources
                  : [
                      {
                        fileName: existing.fileName,
                        uploadedAt: existing.uploadedAt,
                        rowCount: existing.rows.length,
                      },
                    ];
              const sources = [
                ...existingSources,
                {
                  fileName: file.name,
                  uploadedAt,
                  rowCount: parsed.rows.length,
                },
              ];

              const combinedRows = [...existingRows, ...appendedRows];
              return {
                fileName: `${sources.length} files loaded`,
                uploadedAt,
                headers: combinedHeaders,
                rows: combinedRows,
                rowCount: combinedRows.length,
                sources,
              } satisfies CsvDataset;
            }

            return {
              fileName: file.name,
              uploadedAt,
              headers: parsed.headers,
              rows: parsed.rows,
              rowCount: parsed.rows.length,
              sources: MULTI_APPEND_DATASET_KEYS.has(key)
                ? [
                    {
                      fileName: file.name,
                      uploadedAt,
                      rowCount: parsed.rows.length,
                    },
                  ]
                : undefined,
            } satisfies CsvDataset;
          })(),
        }));

        await persistDatasetSourceFilesToCloud(
          key,
          shouldAppend ? "append" : "replace",
          [{ file, uploadedAt, rowCount: parsed.rows.length }]
        );
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error while reading CSV.";
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
    }
  };

  const handleMultiCsvUploads = async (key: DatasetKey, files: File[]) => {
    if (files.length === 0) return;
    if (!MULTI_APPEND_DATASET_KEYS.has(key)) {
      await handleUpload(key, files[0] ?? null, "replace");
      return;
    }

    const config = DATASET_DEFINITIONS[key];
    const parsedFiles: Array<{ file: File; fileName: string; uploadedAt: Date; headers: string[]; rows: CsvRow[] }> = [];

    try {
      await enqueueDatasetUploadTask(`${config.label} upload`, async () => {
        for (const file of files) {
          if (file.size > MAX_SINGLE_CSV_UPLOAD_BYTES) {
            setUploadErrors((previous) => ({
              ...previous,
              [key]: `${file.name} is too large (${formatNumber(file.size / 1024 / 1024, 1)} MB). Please split files larger than ${formatNumber(MAX_SINGLE_CSV_UPLOAD_BYTES / 1024 / 1024)} MB.`,
            }));
            return;
          }
          const parsed = await parseCsvFileAsync(file);
          const isValid = config.requiredHeaderSets.some((set) =>
            matchesExpectedHeaders(parsed.headers, set)
          );
          if (!isValid) {
            setUploadErrors((previous) => ({
              ...previous,
              [key]: `${file.name} does not match the expected ${config.label} format.`,
            }));
            return;
          }

          parsedFiles.push({
            file,
            fileName: file.name,
            uploadedAt: new Date(),
            headers: parsed.headers,
            rows: parsed.rows,
          });

          // Yield between files to keep the browser responsive during large multi-upload batches.
          await new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), 0);
          });
        }

        setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
        setDatasets((previous) => {
          const existing = previous[key];
          const combinedHeaders = existing ? [...existing.headers] : [];
          parsedFiles.forEach((parsedFile) => {
            parsedFile.headers.forEach((header) => {
              if (!combinedHeaders.includes(header)) combinedHeaders.push(header);
            });
          });

          const combinedRows = existing ? [...existing.rows] : [];
          const dedupeKeys = new Set(
            combinedRows.map((row) => datasetAppendRowKey(key, row))
          );
          parsedFiles.forEach((parsedFile) => {
            parsedFile.rows.forEach((row) => {
              const dedupeKey = datasetAppendRowKey(key, row);
              if (dedupeKey && dedupeKeys.has(dedupeKey)) return;
              if (dedupeKey) dedupeKeys.add(dedupeKey);
              combinedRows.push(row);
            });
          });

          const existingSources =
            existing?.sources && existing.sources.length > 0
              ? existing.sources
              : existing
                ? [
                    {
                      fileName: existing.fileName,
                      uploadedAt: existing.uploadedAt,
                      rowCount: existing.rows.length,
                    },
                  ]
                : [];

          const newSources = parsedFiles.map((parsedFile) => ({
            fileName: parsedFile.fileName,
            uploadedAt: parsedFile.uploadedAt,
            rowCount: parsedFile.rows.length,
          }));
          const sources = [...existingSources, ...newSources];

          const uploadedAt =
            parsedFiles[parsedFiles.length - 1]?.uploadedAt ?? new Date();

          return {
            ...previous,
            [key]: {
              fileName: `${sources.length} files loaded`,
              uploadedAt,
              headers: combinedHeaders,
              rows: combinedRows,
              rowCount: combinedRows.length,
              sources,
            } satisfies CsvDataset,
          };
        });

        await persistDatasetSourceFilesToCloud(
          key,
          "append",
          parsedFiles.map((parsedFile) => ({
            file: parsedFile.file,
            uploadedAt: parsedFile.uploadedAt,
            rowCount: parsedFile.rows.length,
          }))
        );
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error while reading CSV files.";
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
    }
  };

  const clearDataset = (key: DatasetKey) => {
    setDatasets((previous) => ({ ...previous, [key]: undefined }));
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    setLocalOnlyDatasets((previous) => ({ ...previous, [key]: false }));
    setDatasetCloudSyncBadge(key, undefined);
    setDatasetSyncProgressState(key, undefined);
    setForceSyncingDatasets((previous) => ({ ...previous, [key]: false }));
    setRemoteSourceManifests((previous) => ({ ...previous, [key]: undefined }));
    setLastDbErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setSyncJobIssues((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    forcedRemoteDatasetSyncKeysRef.current.delete(key);
    delete activeCoreDatasetSyncJobRef.current[key];
  };

  const clearAll = () => {
    setDatasets({});
    setUploadErrors({});
    setLocalOnlyDatasets({});
    setDatasetCloudSyncStatus({});
    setDatasetSyncProgress({});
    setForceSyncingDatasets({});
    setRemoteSourceManifests({});
    setLastDbErrors({});
    setSyncJobIssues({});
    forcedRemoteDatasetSyncKeysRef.current.clear();
    activeCoreDatasetSyncJobRef.current = {};
    // meterReads state is now owned by MeterReadsTab; it resets on unmount.
  };

  const queueForceDatasetSync = (key: DatasetKey) => {
    const dataset = datasets[key];
    if (!dataset) return;
    forcedRemoteDatasetSyncKeysRef.current.add(key);
    setForceSyncingDatasets((previous) => ({ ...previous, [key]: true }));
    setDatasetCloudSyncBadge(key, "pending");
    const hasSourceManifest = Boolean(remoteSourceManifestsRef.current[key]?.sources?.length);

    if (!hasSourceManifest) {
      const fallbackFileName = dataset.fileName.toLowerCase().endsWith(".csv")
        ? dataset.fileName
        : `${toCsvFileSlug(DATASET_DEFINITIONS[key].label)}-cloud-backfill.csv`;
      const csvText = buildCsv(dataset.headers, dataset.rows);
      const fallbackFile = new File([csvText], fallbackFileName, { type: "text/csv" });
      setStorageNotice(
        `Preparing ${DATASET_DEFINITIONS[key].label} for forced cloud sync by creating a source-file backup.`
      );
      void persistDatasetSourceFilesToCloud(key, "replace", [
        {
          file: fallbackFile,
          uploadedAt: dataset.uploadedAt,
          rowCount: dataset.rows.length,
        },
      ]);
      return;
    }

    setStorageNotice(
      `Force cloud sync queued for ${DATASET_DEFINITIONS[key].label}. Large datasets may take longer to upload.`
    );
    setForceDatasetSyncTick((previous) => previous + 1);
  };

  const localOnlyDatasetCount = useMemo(
    () =>
      (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(localOnlyDatasets[key])).length,
    [localOnlyDatasets]
  );

  const migrateAllLocalOnlyDatasets = useCallback(async () => {
    if (migratingLocalOnlyDatasets) return;
    const keys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(localOnlyDatasets[key]));
    if (keys.length === 0) {
      setStorageNotice("No local-only datasets found to migrate.");
      return;
    }

    setMigratingLocalOnlyDatasets(true);
    setStorageNotice(`Starting cloud migration for ${formatNumber(keys.length)} local-only dataset(s).`);
    let migrated = 0;

    try {
      for (const key of keys) {
        const dataset = datasetsRef.current[key];
        if (!dataset) continue;
        const hasSourceManifest = Boolean(remoteSourceManifestsRef.current[key]?.sources?.length);
        if (hasSourceManifest) continue;

        const fallbackFileName = dataset.fileName.toLowerCase().endsWith(".csv")
          ? dataset.fileName
          : `${toCsvFileSlug(DATASET_DEFINITIONS[key].label)}-cloud-backfill.csv`;
        const csvText = buildCsv(dataset.headers, dataset.rows);
        const fallbackFile = new File([csvText], fallbackFileName, { type: "text/csv" });
        setDatasetCloudSyncBadge(key, "pending");
        const ok = await persistDatasetSourceFilesToCloud(key, "replace", [
          {
            file: fallbackFile,
            uploadedAt: dataset.uploadedAt,
            rowCount: dataset.rows.length,
          },
        ]);
        if (ok) migrated += 1;
      }

      if (migrated > 0) {
        setStorageNotice(
          `Queued cloud migration for ${formatNumber(migrated)} dataset(s). Sync continues in the background.`
        );
      } else {
        setStorageNotice("Could not queue cloud migration for local-only datasets.");
      }
    } finally {
      setMigratingLocalOnlyDatasets(false);
    }
  }, [localOnlyDatasets, migratingLocalOnlyDatasets, persistDatasetSourceFilesToCloud, setDatasetCloudSyncBadge]);

  // handleMeterReadsUpload / downloadMeterReadsCsv — moved to
  // @/solar-rec-dashboard/components/MeterReadsTab

  const part2VerifiedAbpRows = useMemo(() => {
    return (datasets.abpReport?.rows ?? []).filter((row) => isPart2VerifiedAbpRow(row));
  }, [datasets.abpReport]);

  const abpEligibleTotalSystems = useMemo(() => {
    const uniqueEligibleKeys = new Set<string>();

    part2VerifiedAbpRows.forEach((row, index) => {
      const { dedupeKey } = resolvePart2ProjectIdentity(row, index);
      uniqueEligibleKeys.add(dedupeKey);
    });

    return uniqueEligibleKeys.size;
  }, [part2VerifiedAbpRows]);

  const abpEligibleTrackingIdsStrict = useMemo(() => {
    const ids = new Set<string>();
    part2VerifiedAbpRows.forEach((row) => {
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (trackingId) ids.add(trackingId);
    });
    return ids;
  }, [part2VerifiedAbpRows]);

  // Phase 8.2 of the server-side architecture migration:
  //
  // The client no longer runs buildSystems() on the main thread.
  // SystemRecord[] comes exclusively from the server snapshot
  // (via useSystemSnapshot hook), which fetches from tRPC and
  // polls during build. The ~200ms buildSystems compute on the
  // main thread is eliminated entirely.
  //
  // Empty-array states while the server is loading or building
  // are fine — the rest of the dashboard already handles dataset
  // hydration loading states the same way.
  //
  // Phase 8.3 (future) removes the IDB-based dataset loading once
  // non-core datasets (Financials, Invoice Match, etc.) have
  // server-backed equivalents. For now the datasets state map
  // stays populated to support those tabs that still read raw
  // CSV rows (e.g. AlertsTab reading deliveryScheduleBase rows).
  const serverSnapshot = useSystemSnapshot();

  const systems = useMemo<SystemRecord[]>(
    () => serverSnapshot.systems ?? [],
    [serverSnapshot.systems],
  );


  const summary = useMemo(() => {
    const eligiblePart2ApplicationIds = new Set<string>();
    const eligiblePart2PortalSystemIds = new Set<string>();
    const eligiblePart2TrackingIds = new Set<string>();
    part2VerifiedAbpRows.forEach((row) => {
      const applicationId = clean(row.Application_ID);
      const portalSystemId = clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
      if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
      if (trackingId) eligiblePart2TrackingIds.add(trackingId);
    });

    const scopedPart2Systems = systems.filter((system) => {
      const byPortalSystemId = system.systemId ? eligiblePart2PortalSystemIds.has(system.systemId) : false;
      const byApplicationId = system.stateApplicationRefId
        ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
        : false;
      const byTrackingId = system.trackingSystemRefId ? eligiblePart2TrackingIds.has(system.trackingSystemRefId) : false;
      return byPortalSystemId || byApplicationId || byTrackingId;
    });

    const systemsById = new Map<string, SystemRecord[]>();
    const systemsByApplicationId = new Map<string, SystemRecord[]>();
    const systemsByTrackingId = new Map<string, SystemRecord[]>();
    const systemsByName = new Map<string, SystemRecord[]>();

    const addIndexedSystem = (
      map: Map<string, SystemRecord[]>,
      key: string | null | undefined,
      system: SystemRecord
    ) => {
      const normalized = clean(key);
      if (!normalized) return;
      const existing = map.get(normalized) ?? [];
      existing.push(system);
      map.set(normalized, existing);
    };

    scopedPart2Systems.forEach((system) => {
      addIndexedSystem(systemsById, system.systemId, system);
      addIndexedSystem(systemsByApplicationId, system.stateApplicationRefId, system);
      addIndexedSystem(systemsByTrackingId, system.trackingSystemRefId, system);
      addIndexedSystem(systemsByName, system.systemName.toLowerCase(), system);
    });

    let notTransferredReporting = 0;
    let transferredReporting = 0;
    let notTransferredNotReporting = 0;
    let transferredNotReporting = 0;
    let terminatedReporting = 0;
    let terminatedNotReporting = 0;
    const uniquePart2Projects = new Set<string>();
    const ownershipRows: OwnershipOverviewExportRow[] = [];

    part2VerifiedAbpRows.forEach((row, index) => {
      const { applicationId, portalSystemId, trackingId, projectName, projectNameKey, dedupeKey } =
        resolvePart2ProjectIdentity(row, index);
      if (uniquePart2Projects.has(dedupeKey)) return;
      uniquePart2Projects.add(dedupeKey);

      const matchedSystems = new Map<string, SystemRecord>();
      (systemsById.get(portalSystemId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByApplicationId.get(applicationId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByTrackingId.get(trackingId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByName.get(projectNameKey) ?? []).forEach((system) => matchedSystems.set(system.key, system));

      if (matchedSystems.size === 0) {
        notTransferredNotReporting += 1;
        ownershipRows.push({
          key: `part2:${dedupeKey}`,
          part2ProjectName: projectName || "(Unmatched Part II Row)",
          part2ApplicationId: applicationId || null,
          part2SystemId: portalSystemId || null,
          part2TrackingId: trackingId || null,
          source: "Part II Unmatched",
          systemName: projectName || "(Unmatched Part II Row)",
          systemId: portalSystemId || null,
          stateApplicationRefId: applicationId || null,
          trackingSystemRefId: trackingId || null,
          ownershipStatus: "Not Transferred and Not Reporting",
          isReporting: false,
          isTransferred: false,
          isTerminated: false,
          contractType: null,
          contractStatusText: "N/A",
          latestReportingDate: null,
          contractedDate: null,
          zillowStatus: null,
          zillowSoldDate: null,
        });
        return;
      }

      let isReporting = false;
      let isTransferred = false;
      let isTerminated = false;
      matchedSystems.forEach((system) => {
        if (system.isReporting) isReporting = true;
        if (system.isTransferred) isTransferred = true;
        if (system.isTerminated) isTerminated = true;
      });

      const ownershipStatus: OwnershipStatus = isTerminated
        ? isReporting
          ? "Terminated and Reporting"
          : "Terminated and Not Reporting"
        : isTransferred
          ? isReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting"
          : isReporting
            ? "Not Transferred and Reporting"
            : "Not Transferred and Not Reporting";

      const matchedSystemList = Array.from(matchedSystems.values());
      const representative =
        matchedSystemList.find((system) => system.ownershipStatus === ownershipStatus) ??
        matchedSystemList[0];

      ownershipRows.push({
        key: `part2:${dedupeKey}`,
        part2ProjectName: projectName || representative.systemName,
        part2ApplicationId: applicationId || null,
        part2SystemId: portalSystemId || null,
        part2TrackingId: trackingId || null,
        source: "Matched System",
        systemName: representative.systemName,
        systemId: representative.systemId,
        stateApplicationRefId: representative.stateApplicationRefId,
        trackingSystemRefId: representative.trackingSystemRefId,
        ownershipStatus,
        isReporting,
        isTransferred,
        isTerminated,
        contractType: representative.contractType,
        contractStatusText: representative.contractStatusText,
        latestReportingDate: representative.latestReportingDate,
        contractedDate: representative.contractedDate,
        zillowStatus: representative.zillowStatus,
        zillowSoldDate: representative.zillowSoldDate,
      });

      if (isTerminated) {
        if (isReporting) terminatedReporting += 1;
        else terminatedNotReporting += 1;
        return;
      }
      if (isTransferred) {
        if (isReporting) transferredReporting += 1;
        else transferredNotReporting += 1;
        return;
      }
      if (isReporting) notTransferredReporting += 1;
      else notTransferredNotReporting += 1;
    });

    const totalSystems = uniquePart2Projects.size;
    const reportingSystems = notTransferredReporting + transferredReporting + terminatedReporting;
    const reportingPercent = toPercentValue(reportingSystems, totalSystems);
    const smallSystems = scopedPart2Systems.filter((system) => system.sizeBucket === "<=10 kW AC").length;
    const largeSystems = scopedPart2Systems.filter((system) => system.sizeBucket === ">10 kW AC").length;
    const unknownSizeSystems = scopedPart2Systems.filter((system) => system.sizeBucket === "Unknown").length;

    const terminatedTotal = terminatedReporting + terminatedNotReporting;
    const reportingOwnershipTotal = notTransferredReporting + transferredReporting;
    const notReportingOwnershipTotal = notTransferredNotReporting + transferredNotReporting;

    const withValueData = scopedPart2Systems.filter(
      (system) => resolveContractValueAmount(system) > 0 || (system.deliveredValue ?? 0) > 0
    );
    const totalContractedValue = withValueData.reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
    const totalDeliveredValue = withValueData.reduce((sum, system) => sum + (system.deliveredValue ?? 0), 0);
    const contractedValueReporting = withValueData
      .filter((system) => system.isReporting)
      .reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
    const contractedValueNotReporting = totalContractedValue - contractedValueReporting;
    const contractedValueReportingPercent = toPercentValue(contractedValueReporting, totalContractedValue);
    const deliveredValuePercent = toPercentValue(totalDeliveredValue, totalContractedValue);

    return {
      totalSystems,
      reportingSystems,
      reportingPercent,
      smallSystems,
      largeSystems,
      unknownSizeSystems,
      ownershipOverview: {
        reportingOwnershipTotal,
        notTransferredReporting,
        transferredReporting,
        notReportingOwnershipTotal,
        notTransferredNotReporting,
        transferredNotReporting,
        terminatedReporting,
        terminatedNotReporting,
        terminatedTotal,
      },
      ownershipRows,
      withValueDataCount: withValueData.length,
      totalContractedValue,
      totalDeliveredValue,
      totalGap: totalContractedValue - totalDeliveredValue,
      contractedValueReporting,
      contractedValueNotReporting,
      contractedValueReportingPercent,
      deliveredValuePercent,
    };
  }, [part2VerifiedAbpRows, systems]);

  const part2EligibleSystemsForSizeReporting = useMemo(() => {
    const eligiblePart2ApplicationIds = new Set<string>();
    const eligiblePart2PortalSystemIds = new Set<string>();
    const eligiblePart2TrackingIds = new Set<string>();
    part2VerifiedAbpRows.forEach((row) => {
      const applicationId = clean(row.Application_ID);
      const portalSystemId = clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
      if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
      if (trackingId) eligiblePart2TrackingIds.add(trackingId);
    });

    return systems
      .filter((system) => {
        const byPortalSystemId = system.systemId ? eligiblePart2PortalSystemIds.has(system.systemId) : false;
        const byApplicationId = system.stateApplicationRefId
          ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
          : false;
        const byTrackingId = system.trackingSystemRefId
          ? eligiblePart2TrackingIds.has(system.trackingSystemRefId)
          : false;
        return byPortalSystemId || byApplicationId || byTrackingId;
      });
  }, [part2VerifiedAbpRows, systems]);

  // overviewPart2Totals — moved to OverviewTab (Phase 12)

  const snapshotPart2ValueSummary = useMemo(() => {
    const totalContractedValue = part2EligibleSystemsForSizeReporting.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0
    );
    const contractedValueReporting = part2EligibleSystemsForSizeReporting
      .filter((system) => system.isReporting)
      .reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
    const contractedValueNotReporting = totalContractedValue - contractedValueReporting;
    const contractedValueReportingPercent = toPercentValue(contractedValueReporting, totalContractedValue);
    const totalDeliveredValue = part2EligibleSystemsForSizeReporting.reduce(
      (sum, system) => sum + (system.deliveredValue ?? 0),
      0
    );
    const totalGap = totalContractedValue - totalDeliveredValue;

    return {
      totalContractedValue,
      totalDeliveredValue,
      totalGap,
      contractedValueReporting,
      contractedValueNotReporting,
      contractedValueReportingPercent,
    };
  }, [part2EligibleSystemsForSizeReporting]);

  const sizeBreakdownRows = useMemo(() => {
    const breakdown = ["<=10 kW AC", ">10 kW AC", "Unknown"] as SizeBucket[];
    return breakdown.map((bucket) => {
      const scoped = part2EligibleSystemsForSizeReporting.filter((system) => system.sizeBucket === bucket);
      const reporting = scoped.filter((system) => system.isReporting).length;
      const notReporting = scoped.length - reporting;
      const reportingPercent = toPercentValue(reporting, scoped.length);
      const contractedValue = scoped.reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
      const deliveredValue = scoped.reduce((sum, system) => sum + (system.deliveredValue ?? 0), 0);
      return {
        bucket,
        total: scoped.length,
        reporting,
        notReporting,
        reportingPercent,
        contractedValue,
        deliveredValue,
        valueDeliveredPercent: toPercentValue(deliveredValue, contractedValue),
      };
    });
  }, [part2EligibleSystemsForSizeReporting]);

  // sizeTabNotReportingPart2Rows + sizeSiteList pagination + visibleSizeSiteListRows
  // — moved to SizeReportingTab

  // recValueRows + recValue pagination + visibleRecValueRows
  // — moved to RecValueTab (Phase 12)

  // filteredOwnershipRows — moved to @/solar-rec-dashboard/components/OwnershipTab

  const changeOwnershipRows = useMemo(() => {
    const eligiblePart2ApplicationIds = new Set<string>();
    const eligiblePart2PortalSystemIds = new Set<string>();
    const eligiblePart2TrackingIds = new Set<string>();
    part2VerifiedAbpRows.forEach((row) => {
      const applicationId = clean(row.Application_ID);
      const portalSystemId = clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
      if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
      if (trackingId) eligiblePart2TrackingIds.add(trackingId);
    });

    const scopedPart2Systems = systems.filter((system) => {
      const byPortalSystemId = system.systemId ? eligiblePart2PortalSystemIds.has(system.systemId) : false;
      const byApplicationId = system.stateApplicationRefId
        ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
        : false;
      const byTrackingId = system.trackingSystemRefId ? eligiblePart2TrackingIds.has(system.trackingSystemRefId) : false;
      return byPortalSystemId || byApplicationId || byTrackingId;
    });

    const systemsById = new Map<string, SystemRecord[]>();
    const systemsByApplicationId = new Map<string, SystemRecord[]>();
    const systemsByTrackingId = new Map<string, SystemRecord[]>();
    const systemsByName = new Map<string, SystemRecord[]>();

    const addIndexedSystem = (
      map: Map<string, SystemRecord[]>,
      key: string | null | undefined,
      system: SystemRecord
    ) => {
      const normalized = clean(key);
      if (!normalized) return;
      const existing = map.get(normalized) ?? [];
      existing.push(system);
      map.set(normalized, existing);
    };

    scopedPart2Systems.forEach((system) => {
      addIndexedSystem(systemsById, system.systemId, system);
      addIndexedSystem(systemsByApplicationId, system.stateApplicationRefId, system);
      addIndexedSystem(systemsByTrackingId, system.trackingSystemRefId, system);
      addIndexedSystem(systemsByName, system.systemName.toLowerCase(), system);
    });

    const uniquePart2Projects = new Set<string>();
    const rows: SystemRecord[] = [];

    part2VerifiedAbpRows.forEach((row, index) => {
      const { applicationId, portalSystemId, trackingId, projectNameKey, dedupeKey } =
        resolvePart2ProjectIdentity(row, index);
      if (uniquePart2Projects.has(dedupeKey)) return;
      uniquePart2Projects.add(dedupeKey);

      const matchedSystems = new Map<string, SystemRecord>();
      (systemsById.get(portalSystemId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByApplicationId.get(applicationId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByTrackingId.get(trackingId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByName.get(projectNameKey) ?? []).forEach((system) => matchedSystems.set(system.key, system));

      const allMatched = Array.from(matchedSystems.values());
      const nonTerminatedSystems = allMatched.filter((system) => !system.isTerminated);
      if (nonTerminatedSystems.length === 0) {
        const hasChangedOwnership = allMatched.some((system) => system.hasChangedOwnership);
        if (hasChangedOwnership) {
          const representative = allMatched[0];
          const isReporting = allMatched.some((system) => system.isReporting);
          const latestReportingDate = allMatched.reduce<Date | null>(
            (latest, system) => maxDate(latest, system.latestReportingDate),
            null
          );
          rows.push({
            ...representative,
            key: `coo:${dedupeKey}`,
            latestReportingDate,
            isReporting,
            isTerminated: true,
            isTransferred: false,
            hasChangedOwnership: true,
            changeOwnershipStatus: "Terminated",
            ownershipStatus: isReporting ? "Terminated and Reporting" : "Terminated and Not Reporting",
          });
        }
        return;
      }

      const hasChangedOwnership = nonTerminatedSystems.some((system) => system.hasChangedOwnership);
      if (!hasChangedOwnership) return;

      const isReporting = nonTerminatedSystems.some((system) => system.isReporting);
      const isTransferred = nonTerminatedSystems.some(
        (system) =>
          system.isTransferred || clean(system.changeOwnershipStatus ?? "").startsWith("Transferred")
      );
      const hasChangeOwnershipNotTransferred = nonTerminatedSystems.some((system) =>
        clean(system.changeOwnershipStatus ?? "").startsWith("Change of Ownership - Not Transferred")
      );

      const changeOwnershipStatus: ChangeOwnershipStatus = hasChangeOwnershipNotTransferred
        ? isReporting
          ? "Change of Ownership - Not Transferred and Reporting"
          : "Change of Ownership - Not Transferred and Not Reporting"
        : isTransferred
          ? isReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting"
          : isReporting
            ? "Change of Ownership - Not Transferred and Reporting"
            : "Change of Ownership - Not Transferred and Not Reporting";

      const representative =
        nonTerminatedSystems.find((system) => system.changeOwnershipStatus === changeOwnershipStatus) ??
        nonTerminatedSystems.find(
          (system) => system.hasChangedOwnership && system.changeOwnershipStatus !== null
        ) ??
        nonTerminatedSystems[0];

      const latestReportingDate = nonTerminatedSystems.reduce<Date | null>(
        (latest, system) => maxDate(latest, system.latestReportingDate),
        null
      );

      rows.push({
        ...representative,
        key: `coo:${dedupeKey}`,
        latestReportingDate,
        isReporting,
        isTerminated: false,
        isTransferred,
        ownershipStatus: isTransferred
          ? isReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting"
          : isReporting
            ? "Not Transferred and Reporting"
            : "Not Transferred and Not Reporting",
        hasChangedOwnership: true,
        changeOwnershipStatus,
      });
    });

    return rows.sort((a, b) =>
      a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true })
    );
  }, [part2VerifiedAbpRows, systems]);

  const changeOwnershipSummary = useMemo<ChangeOwnershipSummary>(() => {
    const total = changeOwnershipRows.length;
    const reporting = changeOwnershipRows.filter((system) => system.isReporting).length;
    const notReporting = total - reporting;
    const reportingPercent = toPercentValue(reporting, total);
    const contractedValueTotal = changeOwnershipRows.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0
    );
    const contractedValueReporting = changeOwnershipRows
      .filter((system) => system.isReporting)
      .reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
    const contractedValueNotReporting = contractedValueTotal - contractedValueReporting;
    const counts = CHANGE_OWNERSHIP_ORDER.map((status) => {
      const count =
        status === "Terminated"
          ? changeOwnershipRows.filter((s) => s.changeOwnershipStatus?.startsWith("Terminated")).length
          : changeOwnershipRows.filter((s) => s.changeOwnershipStatus === status).length;
      return { status, count, percent: toPercentValue(count, total) };
    });
    return {
      total,
      reporting,
      notReporting,
      reportingPercent,
      contractedValueTotal,
      contractedValueReporting,
      contractedValueNotReporting,
      counts,
    };
  }, [changeOwnershipRows]);

  const cooNotTransferredNotReportingCurrentCount = useMemo(
    () =>
      changeOwnershipRows.filter(
        (system) => system.changeOwnershipStatus === COO_TARGET_STATUS
      ).length,
    [changeOwnershipRows]
  );

  // filteredChangeOwnershipRows — moved to @/solar-rec-dashboard/components/ChangeOwnershipTab

  const ownershipCountTileRows = useMemo(
    () => ({
      reporting: summary.ownershipRows.filter(
        (row) => row.ownershipStatus === "Not Transferred and Reporting" || row.ownershipStatus === "Transferred and Reporting"
      ),
      notReporting: summary.ownershipRows.filter(
        (row) =>
          row.ownershipStatus === "Not Transferred and Not Reporting" ||
          row.ownershipStatus === "Transferred and Not Reporting"
      ),
      terminated: summary.ownershipRows.filter(
        (row) => row.ownershipStatus === "Terminated and Reporting" || row.ownershipStatus === "Terminated and Not Reporting"
      ),
    }),
    [summary.ownershipRows]
  );

  // offlineBaseSystems, offlineSystems, offlineMonitoringOptions, offlinePlatformOptions,
  // offlineInstallerOptions, offlineMonitoringBreakdownRows, offlineInstallerBreakdownRows,
  // offlinePlatformBreakdownRows, filteredOfflineSystems, offlineSummary, filter-reset useEffect
  // — moved to @/solar-rec-dashboard/components/OfflineMonitoringTab

  const abpApplicationIdBySystemKey = useMemo(() => {
    const mapping = new Map<string, string>();
    part2VerifiedAbpRows.forEach((row) => {
      const abpApplicationId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const projectName = clean(row.Project_Name) || clean(row.system_name);

      if (abpApplicationId) mapping.set(`id:${abpApplicationId}`, abpApplicationId);
      if (trackingId && abpApplicationId) mapping.set(`tracking:${trackingId}`, abpApplicationId);
      if (projectName && abpApplicationId) mapping.set(`name:${projectName.toLowerCase()}`, abpApplicationId);
    });
    return mapping;
  }, [part2VerifiedAbpRows]);

  const abpAcSizeKwBySystemKey = useMemo(() => {
    const mapping = new Map<string, number>();

    const setIfMissing = (key: string, value: number | null) => {
      if (!key || value === null) return;
      if (!mapping.has(key)) mapping.set(key, value);
    };

    part2VerifiedAbpRows.forEach((row) => {
      const acSizeKw = parseAbpAcSizeKw(row);
      const abpApplicationId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const projectName = clean(row.Project_Name) || clean(row.system_name);

      setIfMissing(abpApplicationId ? `id:${abpApplicationId}` : "", acSizeKw);
      setIfMissing(trackingId ? `tracking:${trackingId}` : "", acSizeKw);
      setIfMissing(projectName ? `name:${projectName.toLowerCase()}` : "", acSizeKw);
    });

    return mapping;
  }, [part2VerifiedAbpRows]);

  const abpAcSizeKwByApplicationId = useMemo(() => {
    const mapping = new Map<string, number>();

    part2VerifiedAbpRows.forEach((row) => {
      const applicationId = clean(row.Application_ID) || clean(row.application_id);
      if (!applicationId) return;
      if (mapping.has(applicationId)) return;

      const acSizeKw = parseAbpAcSizeKw(row);
      if (acSizeKw === null) return;

      mapping.set(applicationId, acSizeKw);
    });

    return mapping;
  }, [part2VerifiedAbpRows]);

  const abpPart2VerificationDateByApplicationId = useMemo(() => {
    const mapping = new Map<string, Date>();

    part2VerifiedAbpRows.forEach((row) => {
      const part2VerifiedDateRaw =
        clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      const part2VerifiedDate = parsePart2VerificationDate(part2VerifiedDateRaw);
      if (!part2VerifiedDate) return;

      const applicationId = clean(row.Application_ID) || clean(row.system_id);
      if (!applicationId) return;

      const existing = mapping.get(applicationId);
      if (!existing || part2VerifiedDate < existing) {
        mapping.set(applicationId, part2VerifiedDate);
      }
    });

    return mapping;
  }, [part2VerifiedAbpRows]);

  const monitoringDetailsBySystemKey = useMemo(() => {
    const mapping = new Map<string, MonitoringDetailsRecord>();

    const mergeDetails = (
      key: string,
      detail: MonitoringDetailsRecord
    ) => {
      const current = mapping.get(key);
      if (!current) {
        mapping.set(key, detail);
        return;
      }
      const merged = { ...current };
      (Object.keys(detail) as Array<keyof typeof detail>).forEach((field) => {
        if (!merged[field] && detail[field]) merged[field] = detail[field];
      });
      mapping.set(key, merged);
    };

    (datasets.solarApplications?.rows ?? []).forEach((row) => {
      const systemId = clean(row.system_id) || clean(row.Application_ID);
      const trackingId =
        clean(row.tracking_system_ref_id) ||
        clean(row.reporting_entity_ref_id) ||
        clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2);
      const systemName = clean(row.system_name) || clean(row.Project_Name);
      if (!systemId && !trackingId && !systemName) return;

      const detail = {
        online_monitoring_access_type: clean(row.online_monitoring_access_type),
        online_monitoring: clean(row.online_monitoring),
        online_monitoring_granted_username: clean(row.online_monitoring_granted_username),
        online_monitoring_username: clean(row.online_monitoring_username),
        online_monitoring_system_name: clean(row.online_monitoring_system_name),
        online_monitoring_system_id: clean(row.online_monitoring_system_id),
        online_monitoring_password: clean(row.online_monitoring_password),
        online_monitoring_website_api_link: clean(row.online_monitoring_website_api_link),
        online_monitoring_entry_method: clean(row.online_monitoring_entry_method),
        online_monitoring_notes: clean(row.online_monitoring_notes),
        online_monitoring_self_report: clean(row.online_monitoring_self_report),
        online_monitoring_rgm_info: clean(row.online_monitoring_rgm_info),
        online_monitoring_no_submit_generation: clean(row.online_monitoring_no_submit_generation),
        system_online: clean(row.system_online),
        last_reported_online_date: clean(row.last_reported_online_date),
      };

      if (systemId) mergeDetails(`id:${systemId}`, detail);
      if (trackingId) mergeDetails(`tracking:${trackingId}`, detail);
      if (systemName) mergeDetails(`name:${systemName.toLowerCase()}`, detail);
    });

    return mapping;
  }, [datasets.solarApplications]);

  // Gate: only compute when perf-ratio or forecast tab is active.
  // These tabs have heavy internal memos that process this data — computing
  // eagerly caused browser crashes from cascading O(n²) operations.
  const annualProductionByTrackingId = useMemo(() => {
    if (!isPerformanceRatioTabActive && !isForecastTabActive) return new Map<string, AnnualProductionProfile>();
    return buildAnnualProductionByTrackingId(datasets.annualProductionEstimates?.rows ?? []);
  }, [datasets.annualProductionEstimates, isPerformanceRatioTabActive, isForecastTabActive]);

  // Shared between the Performance Ratio tab (via props) and Forecast tab
  // (directly in forecastProjections). Stays in the parent so both callers
  // share one computation when both tabs use the same dataset snapshot.
  const generationBaselineByTrackingId = useMemo(() => {
    if (!isPerformanceRatioTabActive && !isForecastTabActive) return new Map<string, GenerationBaseline>();
    return buildGenerationBaselineByTrackingId(
      datasets.generationEntry?.rows ?? [],
      datasets.accountSolarGeneration?.rows ?? [],
    );
  }, [datasets.accountSolarGeneration, datasets.generationEntry, isPerformanceRatioTabActive, isForecastTabActive]);

  // generatorDateOnlineByTrackingId, portalMonitoringCandidates, performanceRatioMatchIndexes,
  // convertedReadRows, performanceRatioResult, performanceRatioMonitoringOptions, filteredPerformanceRatioRows,
  // performanceRatioTotalPages/CurrentPage/visible*, performanceRatioSummary, compliantSourceByPortalId,
  // autoCompliantSourceByPortalId, compliantSourcesTableRows, compliantSourceTotalPages/visible*,
  // compliantPerformanceRatioRows, compliantPerformanceRatioSummary, compliantReportTotalPages/visible*,
  // downloadPerformanceRatioCsv, downloadCompliantPerformanceRatioCsv
  // — ALL moved to @/solar-rec-dashboard/components/PerformanceRatioTab
  const downloadOwnershipCountTileCsv = (tile: "reporting" | "notReporting" | "terminated") => {
    const tileRows = ownershipCountTileRows[tile]
      .slice()
      .sort((a, b) => a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }));

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "state_application_id",
      "part2_project_name",
      "part2_application_id",
      "part2_system_id",
      "part2_tracking_id",
      "source",
      "status_category",
      "reporting",
      "transferred",
      "terminated",
      "contract_type",
      "contract_status",
      "last_reporting_date",
      "contract_date",
      "zillow_status",
      "zillow_sold_date",
    ];

    const rows = tileRows.map((row) => ({
      system_name: row.systemName,
      system_id: row.systemId ?? "",
      tracking_id: row.trackingSystemRefId ?? "",
      state_application_id: row.stateApplicationRefId ?? "",
      part2_project_name: row.part2ProjectName,
      part2_application_id: row.part2ApplicationId ?? "",
      part2_system_id: row.part2SystemId ?? "",
      part2_tracking_id: row.part2TrackingId ?? "",
      source: row.source,
      status_category: row.ownershipStatus,
      reporting: row.isReporting ? "Yes" : "No",
      transferred: row.isTransferred ? "Yes" : "No",
      terminated: row.isTerminated ? "Yes" : "No",
      contract_type: row.contractType ?? "",
      contract_status: row.contractStatusText,
      last_reporting_date: row.latestReportingDate ? row.latestReportingDate.toISOString().slice(0, 10) : "",
      contract_date: row.contractedDate ? row.contractedDate.toISOString().slice(0, 10) : "",
      zillow_status: row.zillowStatus ?? "",
      zillow_sold_date: row.zillowSoldDate ? row.zillowSoldDate.toISOString().slice(0, 10) : "",
    }));

    const tileLabel = tile === "reporting" ? "Reporting" : tile === "notReporting" ? "Not Reporting" : "Terminated";
    const csv = buildCsv(headers, rows);
    const fileName = `ownership-status-${toCsvFileSlug(tileLabel)}-${timestampForCsvFileName()}.csv`;
    triggerCsvDownload(fileName, csv);
  };

  const downloadChangeOwnershipCountTileCsv = (status: ChangeOwnershipStatus) => {
    const rows = changeOwnershipRows
      .filter((system) => system.changeOwnershipStatus === status)
      .slice()
      .sort((a, b) => a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }))
      .map((system) => ({
        system_name: system.systemName,
        system_id: system.systemId ?? "",
        tracking_id: system.trackingSystemRefId ?? "",
        status_category: system.ownershipStatus,
        change_ownership_status: system.changeOwnershipStatus ?? "",
        reporting: system.isReporting ? "Yes" : "No",
        transferred: system.isTransferred ? "Yes" : "No",
        terminated: system.isTerminated ? "Yes" : "No",
        contract_type: system.contractType ?? "",
        contract_status: system.contractStatusText,
        contract_date: system.contractedDate ? system.contractedDate.toISOString().slice(0, 10) : "",
        zillow_status: system.zillowStatus ?? "",
        zillow_sold_date: system.zillowSoldDate ? system.zillowSoldDate.toISOString().slice(0, 10) : "",
        last_reporting_date: system.latestReportingDate ? system.latestReportingDate.toISOString().slice(0, 10) : "",
      }));

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "status_category",
      "change_ownership_status",
      "reporting",
      "transferred",
      "terminated",
      "contract_type",
      "contract_status",
      "contract_date",
      "zillow_status",
      "zillow_sold_date",
      "last_reporting_date",
    ];

    const csv = buildCsv(headers, rows);
    const fileName = `ownership-change-${toCsvFileSlug(status)}-${timestampForCsvFileName()}.csv`;
    triggerCsvDownload(fileName, csv);
  };

  // downloadChangeOwnershipDetailFilteredCsv — moved to @/solar-rec-dashboard/components/ChangeOwnershipTab

  // zeroReportingInstallerPlatformRows, downloadOfflineSystemsCsv, downloadOfflineDetailFilteredCsv
  // — moved to @/solar-rec-dashboard/components/OfflineMonitoringTab

  // downloadSizeSiteListCsv — moved to @/solar-rec-dashboard/components/SizeReportingTab

  const recPriceByTrackingId = useMemo(() => {
    if (!isContractsComputationActive) return new Map<string, number>();
    const mapping = new Map<string, number>();
    part2EligibleSystemsForSizeReporting.forEach((system) => {
      if (!system.trackingSystemRefId || system.recPrice === null) return;
      mapping.set(system.trackingSystemRefId, system.recPrice);
    });
    return mapping;
  }, [isContractsComputationActive, part2EligibleSystemsForSizeReporting]);

  const eligibleTrackingIds = useMemo(() => {
    if (!isContractsComputationActive) return new Set<string>();
    const ids = new Set<string>();
    part2EligibleSystemsForSizeReporting.forEach((system) => {
      if (!system.trackingSystemRefId) return;
      ids.add(system.trackingSystemRefId);
    });
    return ids;
  }, [isContractsComputationActive, part2EligibleSystemsForSizeReporting]);

  const systemsByTrackingId = useMemo(() => {
    if (!isContractsComputationActive) return new Map<string, SystemRecord>();
    const mapping = new Map<string, SystemRecord>();
    part2EligibleSystemsForSizeReporting.forEach((system) => {
      if (!system.trackingSystemRefId) return;
      mapping.set(system.trackingSystemRefId, system);
    });
    return mapping;
  }, [isContractsComputationActive, part2EligibleSystemsForSizeReporting]);

  // ── Transfer-Based Delivery Lookup (shared by Perf Eval + Forecast + Delivery Tracker) ──
  //
  // Phase 8.4 of the server-side architecture migration:
  // The server now computes this lookup from the active
  // transferHistory batch and returns it via tRPC. We prefer the
  // server result when available, falling back to a client-side
  // build only while the server fetch is in flight. This is the
  // same stale-while-revalidate pattern as useSystemSnapshot.
  //
  // Once we retire IDB dataset loading (Phase 8.6+), the client
  // fallback can be dropped entirely.
  const serverTransferDeliveryLookup = useTransferDeliveryLookup();

  // Phase 5b (2026-04-28) of the IndexedDB-removal refactor: the
  // client-side fallback that walked `datasets.transferHistory?.rows`
  // is dropped. After Phase 5a the dashboard mounts with empty
  // `datasets`, so the fallback only ever produced an empty Map
  // anyway. The server-computed lookup (built from the active
  // transferHistory batch in srDsTransferHistory) is the only
  // source now; an empty Map is returned while the snapshot
  // hasn't loaded or hasn't been built yet — matching the
  // pre-Phase-5a behavior for "transferHistory not uploaded."
  const transferDeliveryLookup = useMemo(
    () => serverTransferDeliveryLookup.lookup ?? new Map<string, Map<number, number>>(),
    [serverTransferDeliveryLookup.lookup]
  );

  const performanceSourceRows = useMemo<PerformanceSourceRow[]>(() => {
    if (!isPerformanceEvalTabActive && !isForecastTabActive) return [];
    // Phase 1a: obligations come from deliveryScheduleBase exclusively.
    // Deliveries are always derived from transferDeliveryLookup (which
    // is itself derived from transferHistory). No more conditional
    // override — if transferHistory is empty, delivered = 0 across
    // the board, which matches the user's expectation.
    return (datasets.deliveryScheduleBase?.rows ?? [])
      .map((row, rowIndex) => {
        const trackingSystemRefId = clean(row.tracking_system_ref_id);
        if (!trackingSystemRefId || !eligibleTrackingIds.has(trackingSystemRefId)) return null;
        const system = systemsByTrackingId.get(trackingSystemRefId);
        const years = buildScheduleYearEntries(row);
        if (years.length === 0) return null;

        // transferHistory is always the source of truth for delivered values.
        // The delivery year label matches the schedule start year's energy
        // year directly (2023-06-01 → "2023-2024" → EY 2023 transfers).
        const systemTransfers = transferDeliveryLookup.get(trackingSystemRefId.toLowerCase());

        // Find the earliest energy year with a positive transfer (delivery to utility).
        let firstTransferEnergyYear = null as number | null;
        if (systemTransfers) {
          systemTransfers.forEach((qty, ey) => {
            if (qty > 0 && (firstTransferEnergyYear === null || ey < firstTransferEnergyYear)) {
              firstTransferEnergyYear = ey;
            }
          });
        }

        for (const year of years) {
          if (!year.startDate) {
            year.delivered = 0;
            continue;
          }
          const eyStartYear = year.startDate.getFullYear();
          year.delivered = systemTransfers?.get(eyStartYear) ?? 0;
        }

        return {
          key: `${trackingSystemRefId}-${rowIndex}`,
          contractId: clean(row.utility_contract_number) || "Unassigned",
          systemId: system?.systemId ?? null,
          trackingSystemRefId,
          systemName: clean(row.system_name) || system?.systemName || trackingSystemRefId,
          batchId: clean(row.batch_id) || clean(row.state_certification_number) || null,
          recPrice: system?.recPrice ?? null,
          years,
          firstTransferEnergyYear,
        } satisfies PerformanceSourceRow;
      })
      .filter((row): row is PerformanceSourceRow => row !== null);
  }, [datasets.deliveryScheduleBase, eligibleTrackingIds, isPerformanceEvalTabActive, isForecastTabActive, systemsByTrackingId, transferDeliveryLookup]);

  // performanceContractOptions, effectivePerformanceContractId,
  // performanceDeliveryYearOptions, defaultPerformanceDeliveryYearKey,
  // effectivePerformanceDeliveryYearKey, performanceSelectedDeliveryYearLabel,
  // performancePreviousSurplus, performancePreviousDrawdown,
  // recPerformanceEvaluation, recPerformanceContractYearSummaryRows,
  // recPerformanceContractYearSummaryTotals, filteredRecPerformanceRows,
  // recPerformanceResults{TotalPages,CurrentPage,PageStart,PageEnd}Index,
  // visibleRecPerformanceRows
  // — moved to @/solar-rec-dashboard/components/RecPerformanceEvaluationTab

  // Stays in parent because createLogEntry (snapshot builder) and the
  // Snapshot Log tab's per-contract shortfall aggregation both read
  // it. Same input as the perf-eval memo, different reduction.
  const recPerformanceSnapshotContracts2025 = useMemo(() => {
    const byContract = new Map<
      string,
      {
        contractId: string;
        deliveryYearLabel: string;
        requiredToAvoidShortfallRecs: number;
        deliveredTowardShortfallRecs: number;
        unallocatedShortfallRecs: number;
      }
    >();

    performanceSourceRows.forEach((row) => {
      const targetYearIndex = row.years.findIndex((year) => {
        const label = buildDeliveryYearLabel(year.startDate, year.endDate, year.startRaw, year.endRaw);
        return label === SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL;
      });
      if (targetYearIndex < 0) return;

      const dyCurrent = row.years[targetYearIndex];
      if (!dyCurrent || dyCurrent.required <= 0) return;

      const dyPrevious = targetYearIndex > 0 ? row.years[targetYearIndex - 1] : null;
      const dyTwoBack = targetYearIndex > 1 ? row.years[targetYearIndex - 2] : null;

      const requiredThreeYear =
        (dyCurrent?.required ?? 0) + (dyPrevious?.required ?? 0) + (dyTwoBack?.required ?? 0);
      const deliveredThreeYear =
        (dyCurrent?.delivered ?? 0) + (dyPrevious?.delivered ?? 0) + (dyTwoBack?.delivered ?? 0);

      let current = byContract.get(row.contractId);
      if (!current) {
        current = {
          contractId: row.contractId,
          deliveryYearLabel: SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL,
          requiredToAvoidShortfallRecs: 0,
          deliveredTowardShortfallRecs: 0,
          unallocatedShortfallRecs: 0,
        };
        byContract.set(row.contractId, current);
      }

      current.requiredToAvoidShortfallRecs += requiredThreeYear;
      current.deliveredTowardShortfallRecs += deliveredThreeYear;
    });

    return Array.from(byContract.values())
      .map((contract) => {
        const unallocatedShortfallRecs = Math.max(
          0,
          contract.requiredToAvoidShortfallRecs - contract.deliveredTowardShortfallRecs
        );
        return {
          ...contract,
          unallocatedShortfallRecs,
          deliveredPercentOfRequired: toPercentValue(
            contract.deliveredTowardShortfallRecs,
            contract.requiredToAvoidShortfallRecs
          ),
        };
      })
      .sort((a, b) => a.contractId.localeCompare(b.contractId, undefined, { numeric: true, sensitivity: "base" }));
  }, [performanceSourceRows]);
  // offlineDetailTotalPages/CurrentPage/visibleOfflineDetailRows — moved to OfflineMonitoringTab

  // Pagination clamp useEffects for contracts/annual-review tables
  // — moved to @/solar-rec-dashboard/components/{ContractsTab,AnnualReviewTab}
  // (each page index is now clamped via Math.min inside the child's render,
  // matching the pattern in the other extracted tabs).

  // recPerformanceResultsPage clamp + reset useEffects
  // — moved to @/solar-rec-dashboard/components/RecPerformanceEvaluationTab

  // offlineDetailPage clamping useEffect — moved to OfflineMonitoringTab

  // Phase E: depend on individual dataset slots instead of the entire
  // `datasets` object to avoid recomputation when unrelated datasets change.
  const localDatasetManifest = useMemo<Partial<Record<DatasetKey, RemoteDatasetManifestEntry>>>(
    () => {
      const manifest: Partial<Record<DatasetKey, RemoteDatasetManifestEntry>> = {};
      (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
        const dataset = datasets[key];
        if (!dataset) return;
        manifest[key] = {
          fileName: dataset.fileName,
          uploadedAt: dataset.uploadedAt.toISOString(),
          headers: dataset.headers,
          rowCount: dataset.rows.length,
          sources: dataset.sources?.map((source) => ({
            fileName: source.fileName,
            uploadedAt: source.uploadedAt.toISOString(),
            rowCount: source.rowCount,
          })),
        };
      });
      return manifest;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // listing individual slots instead of the whole `datasets` object so
    // unchanged slots don't trigger recomputation.
    [
      datasets.solarApplications, datasets.abpReport, datasets.generationEntry,
      datasets.accountSolarGeneration, datasets.contractedDate, datasets.convertedReads,
      datasets.annualProductionEstimates, datasets.generatorDetails,
      datasets.abpUtilityInvoiceRows, datasets.abpCsgSystemMapping,
      datasets.abpQuickBooksRows, datasets.abpProjectApplicationRows,
      datasets.abpPortalInvoiceMapRows, datasets.abpCsgPortalDatabaseRows,
      datasets.abpIccReport2Rows, datasets.abpIccReport3Rows,
      datasets.deliveryScheduleBase, datasets.transferHistory,
    ]
  );

  const mergedRemoteDatasetManifest = useMemo<
    Partial<Record<DatasetKey, RemoteDatasetManifestEntry>>
  >(() => {
    const merged: Partial<Record<DatasetKey, RemoteDatasetManifestEntry>> = {
      ...serverCloudDatasetManifest,
    };
    allDatasetKeys.forEach((key) => {
      const localEntry = localDatasetManifest[key];
      if (localEntry) {
        merged[key] = localEntry;
        return;
      }
      const status = datasetCloudStatusesQuery.data?.statuses.find(
        (entry) => entry.datasetKey === key
      );
      if (status?.recoverable === false) {
        delete merged[key];
      }
    });
    return merged;
  }, [
    allDatasetKeys,
    datasetCloudStatusesQuery.data?.statuses,
    localDatasetManifest,
    serverCloudDatasetManifest,
  ]);

  const serverDatasetCloudStatusByKey = useMemo(() => {
    const entries = datasetCloudStatusesQuery.data?.statuses ?? [];
    return entries.reduce<
      Partial<
        Record<
          DatasetKey,
          {
            recoverable: boolean;
            payloadSha256: string | null;
          }
        >
      >
    >((accumulator, entry) => {
      if (isDatasetKey(entry.datasetKey)) {
        accumulator[entry.datasetKey] = {
          recoverable: entry.recoverable,
          payloadSha256: entry.payloadSha256,
        };
      }
      return accumulator;
    }, {});
  }, [datasetCloudStatusesQuery.data?.statuses]);

  useEffect(() => {
    // Safety net: clear lingering overrideCloudStatus once the server
    // confirms recoverable. Upload flows clear their own override on
    // success; this catches overrides left behind when the success
    // path didn't run (e.g. tab closed mid-sync). "failed" is
    // preserved so users still see the error state.
    setDatasetCloudSyncStatus((current) => {
      let changed = false;
      const next = { ...current };
      allDatasetKeys.forEach((key) => {
        const status = serverDatasetCloudStatusByKey[key];
        if (!status?.recoverable) return;
        if (!next[key]) return;
        // Preserve "failed" so the user still sees the error even
        // when server eventually has the data from a later retry.
        if (next[key] === "failed") return;
        delete next[key];
        changed = true;
      });
      return changed ? next : current;
    });
  }, [allDatasetKeys, serverDatasetCloudStatusByKey]);

  const manifestOnlyRemoteStatePayload = useMemo(() => {
    return (
      safeJsonStringify({
        datasetManifest: mergedRemoteDatasetManifest,
        logs: [],
      }) ?? "{\"datasetManifest\":{},\"logs\":[]}"
    );
  }, [mergedRemoteDatasetManifest]);

  const remoteStatePayload = useMemo(() => {
    return {
      payload: manifestOnlyRemoteStatePayload,
      usedManifestOnly: false,
    };
  }, [manifestOnlyRemoteStatePayload]);

  useEffect(() => {
    datasetsHydratedRef.current = datasetsHydrated;
  }, [datasetsHydrated]);

  useEffect(() => {
    remoteStateHydratedRef.current = remoteStateHydrated;
  }, [remoteStateHydrated]);

  // Prune hydration errors on set → unset transitions — i.e., the
  // user explicitly cleared a dataset (Remove button / clearDataset)
  // that was previously loaded. Stale "Hydration failed" text would
  // otherwise sit on an empty slot after the manual remove.
  //
  // Crucially we do NOT prune on "still empty" keys, because a key
  // can legitimately have `hydrationErrors[key]` set while
  // `datasets[key]` is undefined — that's the state immediately
  // after onError fires for a dataset that never managed to hydrate.
  // Only the transition matters.
  const previousDatasetPresenceRef = useRef<Partial<Record<DatasetKey, boolean>>>({});
  // Sticky-true ref: once a dataset has been hydrated locally in this
  // browser session, this stays true for the rest of the session. The
  // auto-persist effect uses it to gate the destructive `!dataset`
  // CLEAR path so the dashboard never wipes cloud state for a dataset
  // the user has not actually loaded. Without this guard a user who
  // mounts the dashboard, but never tap-to-loads convertedReads, would
  // fall through to the convertedReads CLEAR path on the first effect
  // tick and wipe every user CSV source from the cloud manifest.
  const everLoadedDatasetsRef = useRef<Partial<Record<DatasetKey, boolean>>>({});
  useEffect(() => {
    const previous = previousDatasetPresenceRef.current;
    const removed: DatasetKey[] = [];
    const nextPresence: Partial<Record<DatasetKey, boolean>> = {};
    (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
      const isPresent = Boolean(datasets[key]);
      nextPresence[key] = isPresent;
      if (isPresent) {
        everLoadedDatasetsRef.current[key] = true;
      }
      if (previous[key] && !isPresent) removed.push(key);
    });
    previousDatasetPresenceRef.current = nextPresence;
    if (removed.length > 0) {
      clearHydrationErrorsForKeys(removed);
    }
  }, [datasets, clearHydrationErrorsForKeys]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Progressive hydration: every manifest entry is fetched
        // (lazy rows keep it cheap), priority keys determine ORDER
        // so the active tab lands first. Datasets flush in two
        // batches — priority, then background — so downstream memos
        // re-fire at most twice during hydrate.
        const priorityKeys = buildHydrationPriorityKeys(
          getTabFromSearch(search) ?? DEFAULT_DASHBOARD_TAB,
        );

        const [, loadedLogs] = await Promise.all([
          loadDatasetsFromStorage({
            priorityKeys,
            onBatch: (batch, _phase) => {
              if (cancelled) return;
              const landedKeys = Object.keys(batch) as DatasetKey[];
              setDatasets((current) => {
                const next = { ...current };
                let changed = false;
                for (const [key, dataset] of Object.entries(batch) as Array<
                  [DatasetKey, CsvDataset]
                >) {
                  if (next[key]) continue;
                  next[key] = dataset;
                  changed = true;
                }
                return changed ? next : current;
              });
              clearHydrationErrorsForKeys(landedKeys);
            },
            onProgress: (loaded, total) => {
              if (cancelled) return;
              setHydrationProgress({ loaded, total });
            },
            onError: recordHydrationError,
          }),
          loadLogsFromStorage(),
        ]);
        if (cancelled) return;
        if (loadedLogs.length > 0) {
          setLogEntries((current) => {
            if (current.length === 0) return loadedLogs;
            return loadedLogs.length >= current.length ? loadedLogs : current;
          });
        }
        setStorageNotice(null);
      } catch {
        if (cancelled) return;
        setStorageNotice("Could not load saved file data.");
      } finally {
        if (!cancelled) setDatasetsHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, search]);

  /**
   * User-invoked hydration with explicit progress, no priority
   * ordering. Mount hydration already pulls every manifest entry
   * (lazy rows keep it cheap), but it interleaves priority and
   * background batches; this path runs a single-flush hydrate with
   * a visible N/total counter so the user can wait for all rows to
   * materialize before starting cross-tab work.
   */
  const loadAllDatasets = useCallback(async () => {
    if (loadingAllDatasets) return;
    setLoadingAllDatasets(true);
    setLoadAllProgress({ loaded: 0, total: 0 });
    try {
      await loadDatasetsFromStorage({
        // No priority ordering — previously-loaded keys are skipped
        // inside onBatch via `if (next[key]) continue`.
        onBatch: (batch) => {
          const landedKeys = Object.keys(batch) as DatasetKey[];
          setDatasets((current) => {
            const next = { ...current };
            let changed = false;
            for (const [key, dataset] of Object.entries(batch) as Array<
              [DatasetKey, CsvDataset]
            >) {
              if (next[key]) continue;
              next[key] = dataset;
              changed = true;
            }
            return changed ? next : current;
          });
          clearHydrationErrorsForKeys(landedKeys);
        },
        onError: recordHydrationError,
        onProgress: (loaded, total) => {
          setLoadAllProgress({ loaded, total });
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[loadAllDatasets] failed:", err);
      setStorageNotice("Could not finish loading all datasets. Try again.");
    } finally {
      setLoadingAllDatasets(false);
      setLoadAllProgress(null);
    }
  }, [loadingAllDatasets]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (remoteDashboardStateQuery.status === "pending") return;
      const stateRequestErrored = remoteDashboardStateQuery.status === "error";
      if (stateRequestErrored && !cancelled) {
        setStorageNotice("Could not load dashboard state metadata from cloud. Trying dataset fallback sync.");
      }

      const loadRemoteDatasets = async (keys: DatasetKey[]) => {
        const loadedDatasets: Partial<Record<DatasetKey, CsvDataset>> = {};
        const loadedSignatures: Partial<Record<DatasetKey, string>> = {};
        const loadedChunkKeys: Partial<Record<DatasetKey, string[]>> = {};
        const loadedSourceManifests: Partial<Record<DatasetKey, RemoteDatasetSourceManifestPayload>> = {};
        // Phase 13b: fetch all chunks in parallel and join them in
        // chunk-key order. Previously this was a serial for-await
        // loop that paid the full RTT per chunk — a 6-chunk dataset
        // on a 200ms link was 1.2s of pure latency.
        const loadChunkedPayload = async (chunkKeys: string[]): Promise<string | null> => {
          if (cancelled || chunkKeys.length === 0) return null;
          const responses = await mapWithBoundedConcurrency(
            chunkKeys,
            REMOTE_READ_CONCURRENCY,
            (chunkKey) =>
              withRetry(
                () => getRemoteDatasetRef.current.mutateAsync({ key: chunkKey }),
                3,
                250
              ).catch(() => null)
          );
          if (cancelled) return null;
          let combined = "";
          for (const chunkResponse of responses) {
            if (!chunkResponse?.payload) return null;
            combined += chunkResponse.payload;
          }
          return combined;
        };
        const loadPayloadByKey = async (
          key: string
        ): Promise<{
          payload: string;
          chunkKeys: string[];
        } | null> => {
          const response = await withRetry(
            () => getRemoteDatasetRef.current.mutateAsync({ key }),
            3,
            250
          ).catch(() => null);
          if (!response?.payload) return null;
          const chunkKeys = parseChunkPointerPayload(response.payload);
          if (chunkKeys && chunkKeys.length > 0) {
            const chunkedPayload = await loadChunkedPayload(chunkKeys);
            if (!chunkedPayload) return null;
            return {
              payload: chunkedPayload,
              chunkKeys,
            };
          }
          return {
            payload: response.payload,
            chunkKeys: [],
          };
        };
        const parseSourcePayloadForDataset = async (
          key: DatasetKey,
          source: RemoteDatasetSourceRef,
          payload: string
        ): Promise<{ headers: string[]; rows: CsvRow[] } | null> => {
          try {
            const csvLike = isCsvLikeFile(source.fileName, source.contentType);
            if (source.encoding === "utf8") {
              const file = new File([payload], source.fileName, { type: source.contentType });
              if (csvLike || !TABULAR_DATASET_KEYS.has(key)) {
                return await parseCsvFileAsync(file);
              }
              return await parseTabularFile(file);
            }

            const bytes = base64ToBytes(payload);
            const arrayBuffer = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer;
            const file = new File([arrayBuffer], source.fileName, { type: source.contentType });
            if (TABULAR_DATASET_KEYS.has(key) && !csvLike) {
              return await parseTabularFile(file);
            }
            const text = await file.text();
            return await parseCsvTextAsync(text);
          } catch {
            return null;
          }
        };

        // Phase 13b: load all datasets in parallel. Each iteration
        // writes a different key in the result maps (loadedDatasets,
        // loadedSignatures, etc.), so there's no contention under
        // Promise.all. Source-manifest datasets also fan out their
        // per-source fetches inside loadSingleDataset — three levels
        // of concurrency (dataset × sources × chunks) for cold-hydrate.
        // Previously this was a 15-dataset × 3-chunk serial walk ≈
        // 9s of pure RTT.
        const loadSingleDataset = async (rawKey: DatasetKey) => {
          if (cancelled) return;
          const debug = isSolarRecDebugEnabled();
          const t0 = debug ? performance.now() : 0;
          try {
            // Task 5.14 PR-5 (2026-04-27): the previous "next-best
            // path" — the single-roundtrip batch endpoint
            // `getDatasetAssembled` — is gone. It used to fetch a
            // dataset's manifest + every source's payload in one
            // tRPC call, but the assembled response could grow to
            // 50–150 MB on populated scopes (the convertedReads
            // multi-source manifest, transferHistory's accumulated
            // GATS history) which blew up Chrome tabs on JSON.parse.
            // Cold hydration now always takes the per-key route
            // below: load the top-level manifest, then fetch each
            // source's chunk-sized payload with bounded
            // concurrency. The wire payload per round-trip is
            // capped by `REMOTE_DATASET_CHUNK_CHAR_LIMIT` (250 KB)
            // so memory stays bounded and the JSON.parse path
            // never has more than a chunk in flight at a time.
            //
            // Server-side procedure removal + the dead chunked-CSV
            // reassembly helper land in PR-6 once we're sure no
            // other client surface calls into it.
            let datasetPayload: string | null = null;
            let topChunkKeys: string[] = [];

            {
              const loadedPayload = await loadPayloadByKey(rawKey);
              if (!loadedPayload?.payload) {
                if (debug) {
                  const ms = Math.round(performance.now() - t0);
                  // eslint-disable-next-line no-console
                  console.log(`${HYDRATE_LOG_PREFIX_CLOUD} ${rawKey} ${ms}ms (no payload)`);
                }
                return;
              }
              datasetPayload = loadedPayload.payload;
              topChunkKeys = loadedPayload.chunkKeys;
            }
            loadedChunkKeys[rawKey] = topChunkKeys;

            const sourceManifest = parseRemoteSourceManifestPayload(datasetPayload);
            if (sourceManifest) {
              // Per-source: prefer the batch-assembled payload (cheap
              // map lookup); fall back to per-key fetch for every
              // source. Parsing still runs in parallel so we don't
              // block on the slowest CSV.
              const sourcePayloads = await mapWithBoundedConcurrency(
                sourceManifest.sources,
                REMOTE_READ_CONCURRENCY,
                async (source) => {
                  if (cancelled) return null;
                  let sourcePayloadText: string | null = null;
                  let sourceChunkKeys: string[] = [];
                  const sourcePayload = await loadPayloadByKey(source.storageKey);
                  if (!sourcePayload?.payload) return null;
                  sourcePayloadText = sourcePayload.payload;
                  sourceChunkKeys = sourcePayload.chunkKeys;
                  if (!sourcePayloadText) return null;
                  const parsed = await parseSourcePayloadForDataset(rawKey, source, sourcePayloadText);
                  if (!parsed) return null;
                  return {
                    source: {
                      ...source,
                      chunkKeys:
                        source.chunkKeys && source.chunkKeys.length > 0
                          ? source.chunkKeys
                          : sourceChunkKeys,
                    },
                    parsed,
                  };
                }
              );
              const parsedSourceData = sourcePayloads.filter(
                (entry): entry is NonNullable<typeof entry> => entry !== null,
              );

              if (parsedSourceData.length > 0) {
                const normalizedSources = parsedSourceData.map(({ source, parsed }) => ({
                  ...source,
                  rowCount: source.rowCount > 0 ? source.rowCount : parsed.rows.length,
                }));
                const sourceRows = normalizedSources.map((source) => ({
                  fileName: source.fileName,
                  uploadedAt: new Date(source.uploadedAt),
                  rowCount: source.rowCount,
                }));

                if (MULTI_APPEND_DATASET_KEYS.has(rawKey)) {
                  const headers: string[] = [];
                  const rows: CsvRow[] = [];
                  const dedupeKeys = new Set<string>();
                  parsedSourceData.forEach(({ parsed }) => {
                    parsed.headers.forEach((header) => {
                      if (!headers.includes(header)) headers.push(header);
                    });
                    parsed.rows.forEach((row) => {
                      const dedupeKey = datasetAppendRowKey(rawKey, row);
                      if (dedupeKey && dedupeKeys.has(dedupeKey)) return;
                      if (dedupeKey) dedupeKeys.add(dedupeKey);
                      rows.push(row);
                    });
                  });

                  const uploadedAt =
                    sourceRows[sourceRows.length - 1]?.uploadedAt ??
                    new Date();
                  loadedDatasets[rawKey] = {
                    fileName:
                      sourceRows.length > 1
                        ? `${sourceRows.length} files loaded`
                        : sourceRows[0]?.fileName ?? `${DATASET_DEFINITIONS[rawKey].label} upload`,
                    uploadedAt,
                    headers,
                    rows,
                    rowCount: rows.length,
                    sources: sourceRows,
                  };
                  const newest = normalizedSources[normalizedSources.length - 1];
                  loadedSignatures[rawKey] =
                    `raw:${normalizedSources.length}|${newest?.id ?? ""}|${newest?.uploadedAt ?? ""}|${rows.length}`;
                } else {
                  const latest = parsedSourceData[parsedSourceData.length - 1];
                  const latestSource =
                    normalizedSources[normalizedSources.length - 1];
                  const latestRows = latest?.parsed.rows ?? [];
                  loadedDatasets[rawKey] = {
                    fileName: latestSource?.fileName ?? `${DATASET_DEFINITIONS[rawKey].label} upload`,
                    uploadedAt: latestSource?.uploadedAt ? new Date(latestSource.uploadedAt) : new Date(),
                    headers: latest?.parsed.headers ?? [],
                    rows: latestRows,
                    rowCount: latestRows.length,
                    sources: sourceRows,
                  };
                  loadedSignatures[rawKey] =
                    `raw:${normalizedSources.length}|${latestSource?.id ?? ""}|${latestSource?.uploadedAt ?? ""}|${latestRows.length}`;
                }

                loadedSourceManifests[rawKey] = {
                  _rawSourcesV1: true,
                  version: 1,
                  sources: normalizedSources,
                };
                return;
              }
            }

            const deserializedDataset = deserializeRemoteDatasetPayload(datasetPayload);
            if (!deserializedDataset) return;
            loadedDatasets[rawKey] = deserializedDataset;
            loadedSignatures[rawKey] = `${deserializedDataset.fileName}|${deserializedDataset.uploadedAt.toISOString()}|${deserializedDataset.rows.length}|${deserializedDataset.sources?.length ?? 0}`;
            if (debug) {
              const ms = Math.round(performance.now() - t0);
              // eslint-disable-next-line no-console
              console.log(
                `${HYDRATE_LOG_PREFIX_CLOUD} ${rawKey} ${ms}ms (${deserializedDataset.rows.length} rows)`,
              );
            }
          } catch (error) {
            // Keep going; partial data is better than none. Record the
            // error so the per-card UI can distinguish "failed to
            // hydrate" from "never uploaded."
            if (debug) {
              const ms = Math.round(performance.now() - t0);
              // eslint-disable-next-line no-console
              console.error(`${HYDRATE_LOG_PREFIX_CLOUD} ${rawKey} FAILED after ${ms}ms`, error);
            }
            if (!cancelled) {
              recordHydrationError(rawKey, error);
            }
          }
        };

        await mapWithBoundedConcurrency(keys, REMOTE_READ_CONCURRENCY, (rawKey) => loadSingleDataset(rawKey));

        return { loadedDatasets, loadedSignatures, loadedChunkKeys, loadedSourceManifests };
      };

      try {
        const payload = remoteDashboardStateQuery.data?.payload;
        let manifest: Record<string, RemoteDatasetManifestEntry> = {};
        let stateLogs: DashboardLogEntry[] = [];

        if (payload) {
          const parsed = JSON.parse(payload) as {
            datasetManifest?: Record<string, RemoteDatasetManifestEntry>;
            logs?: unknown;
          };

          if (Array.isArray(parsed.logs)) {
            stateLogs = deserializeDashboardLogs(JSON.stringify(parsed.logs));
          }

          manifest = parsed.datasetManifest ?? {};
        }

        if (!cancelled && Object.keys(manifest).length > 0) {
          setServerCloudDatasetManifest((current) => ({
            ...current,
            ...manifest,
          }));
        }

        // Cloud fallback is network-bound and can include very large
        // source CSVs, so automatic hydration only fetches the active
        // tab's priority keys. The local IDB path can still hydrate the
        // full manifest cheaply via lazy rows.
        const priorityKeys = buildHydrationPriorityKeys(
          getTabFromSearch(search) ?? DEFAULT_DASHBOARD_TAB
        );
        const keysToLoad = resolveHydrationKeys({
          manifestKeys: Object.keys(manifest),
          priorityKeys,
          isDatasetKey,
          includeManifestEntries: false,
        });

        if (keysToLoad.size === 0) {
          try {
            const manifestResponse = await withRetry(
              () => getRemoteDatasetRef.current.mutateAsync({ key: REMOTE_DATASET_KEY_MANIFEST }),
              3,
              250
            );
            if (manifestResponse?.payload) {
              parseDatasetKeyManifestPayload(manifestResponse.payload).forEach((key) => keysToLoad.add(key));
            }
          } catch {
            // Optional fallback key; ignore errors.
          }
        }

        const { loadedDatasets, loadedSignatures, loadedChunkKeys, loadedSourceManifests } =
          await loadRemoteDatasets(Array.from(keysToLoad));

        let loadedCloudLogs: DashboardLogEntry[] = [];
        try {
          const logsResponse = await withRetry(
            () => getRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY }),
            3,
            250
          );
          if (logsResponse?.payload) {
            let logsPayload = logsResponse.payload;
            const chunkKeys = parseChunkPointerPayload(logsResponse.payload);
            if (chunkKeys) {
              remoteLogsChunkKeysRef.current = chunkKeys;
              // Phase 13b: fetch log chunks in parallel and stitch
              // them together in chunk-key order. Aborts the batch
              // if any chunk comes back empty (partial log history
              // is worse than no log history here).
              if (!cancelled && chunkKeys.length > 0) {
                const chunkResponses = await mapWithBoundedConcurrency(
                  chunkKeys,
                  REMOTE_READ_CONCURRENCY,
                  (chunkKey) =>
                    withRetry(
                      () => getRemoteDatasetRef.current.mutateAsync({ key: chunkKey }),
                      3,
                      250
                    ).catch(() => null)
                );
                if (!cancelled) {
                  let combinedLogsPayload = "";
                  let allLogsChunksLoaded = true;
                  for (const chunkResponse of chunkResponses) {
                    if (!chunkResponse?.payload) {
                      allLogsChunksLoaded = false;
                      break;
                    }
                    combinedLogsPayload += chunkResponse.payload;
                  }
                  if (allLogsChunksLoaded && combinedLogsPayload) {
                    logsPayload = combinedLogsPayload;
                  }
                }
              }
            } else {
              remoteLogsChunkKeysRef.current = [];
            }
            loadedCloudLogs = deserializeDashboardLogs(logsPayload);
            remoteLogsSignatureRef.current = buildLogSyncSignature(loadedCloudLogs);
          } else {
            remoteLogsChunkKeysRef.current = [];
            remoteLogsSignatureRef.current = "0";
          }
        } catch {
          // Keep existing logs if remote log fetch fails.
        }

        if (!cancelled) {
          if (Object.keys(loadedDatasets).length > 0) {
            setDatasets((current) => {
              if (Object.keys(current).length === 0) return loadedDatasets;
              const merged = { ...current };
              for (const [key, value] of Object.entries(loadedDatasets)) {
                if (!value) continue;
                const existing = merged[key as DatasetKey];
                if (!existing) {
                  merged[key as DatasetKey] = value;
                  continue;
                }
                // If the remote version has a newer uploadedAt, replace local.
                // This lets externally-mutated datasets (meter reads pages, the
                // monitoring batch converted-reads bridge, etc.) overwrite a
                // stale IndexedDB copy instead of being silently ignored.
                // Local-only edits are preserved because their uploadedAt is
                // always >= the last remote version.
                if (value.uploadedAt.getTime() > existing.uploadedAt.getTime()) {
                  merged[key as DatasetKey] = value;
                }
              }
              return merged;
            });
            setDatasetCloudSyncStatus((current) => {
              const next = { ...current };
              (Object.keys(loadedDatasets) as DatasetKey[]).forEach((key) => {
                if (loadedDatasets[key]) {
                  delete next[key];
                }
              });
              return next;
            });
            // Parallels the IDB path's clear-on-success: a dataset
            // that just successfully hydrated from cloud should lose
            // any prior "Hydration failed" badge.
            clearHydrationErrorsForKeys(
              (Object.keys(loadedDatasets) as DatasetKey[]).filter(
                (key) => loadedDatasets[key] !== undefined,
              ),
            );
          }
          remoteDatasetSignatureRef.current = loadedSignatures;
          remoteDatasetChunkKeysRef.current = loadedChunkKeys;
          if (Object.keys(loadedSourceManifests).length > 0) {
            setRemoteSourceManifests((current) => ({
              ...current,
              ...loadedSourceManifests,
            }));
          }
          if (loadedCloudLogs.length > 0) {
            setLogEntries((current) => (loadedCloudLogs.length >= current.length ? loadedCloudLogs : current));
          } else if (stateLogs.length > 0) {
            setLogEntries((current) => (current.length >= stateLogs.length ? current : stateLogs));
          }
          if (Object.keys(loadedDatasets).length > 0 || loadedCloudLogs.length > 0 || stateLogs.length > 0) {
            setStorageNotice(null);
          } else if (stateRequestErrored) {
            setStorageNotice("Cloud state sync failed on this device. Retrying in the background.");
          } else {
            setStorageNotice(null);
          }
        }
      } catch {
        if (!cancelled) setStorageNotice("Could not parse synced dashboard data.");
      } finally {
        if (!cancelled) {
          setRemoteStateHydrated(true);
          setDatasetsHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    parseCsvFileAsync,
    parseCsvTextAsync,
    remoteDashboardStateQuery.data,
    remoteDashboardStateQuery.status,
  ]);

  useEffect(() => {
    if (remoteDashboardStateQuery.status !== "error") return;
    if (Object.keys(datasets).length > 0) return;

    const timeout = window.setTimeout(() => {
      void remoteDashboardStateQuery.refetch();
    }, 15_000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [datasets, remoteDashboardStateQuery.refetch, remoteDashboardStateQuery.status]);

  // Re-trigger data loading when the page becomes visible again (e.g. mobile
  // browser tab was backgrounded during initial load, cancelling hydration).
  useEffect(() => {
    const handleVisibilityResume = () => {
      if (document.visibilityState !== "visible") return;
      if (remoteStateHydratedRef.current && datasetsHydratedRef.current) return;
      // Hydration was interrupted — kick off a refetch so the load effect re-runs.
      void remoteDashboardStateQuery.refetch();
    };
    document.addEventListener("visibilitychange", handleVisibilityResume);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityResume);
    };
  }, [remoteDashboardStateQuery.refetch]);

  useEffect(() => {
    const flushLocalPersistence = () => {
      if (!datasetsHydratedRef.current && Object.keys(datasetsRef.current).length === 0) return;

      void (async () => {
        try {
          const nextDatasetSignature = buildDatasetStorageSignature(datasetsRef.current);
          if (localDatasetSignatureRef.current !== nextDatasetSignature) {
            await saveDatasetsToStorage(datasetsRef.current);
            localDatasetSignatureRef.current = nextDatasetSignature;
          }

          const nextLogSignature = buildLogSyncSignature(logEntriesRef.current);
          if (localLogsSignatureRef.current !== nextLogSignature) {
            await saveLogsToStorage(logEntriesRef.current);
            localLogsSignatureRef.current = nextLogSignature;
          }
        } catch {
          // Best-effort flush on navigation.
        }
      })();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushLocalPersistence();
      }
    };

    window.addEventListener("pagehide", flushLocalPersistence);
    window.addEventListener("beforeunload", flushLocalPersistence);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushLocalPersistence);
      window.removeEventListener("beforeunload", flushLocalPersistence);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!datasetsHydrated && Object.keys(datasets).length === 0) return;

    // Debounced local persistence — defers heavy JSON.stringify off the render path
    const localSaveTimeout = window.setTimeout(() => {
      void (async () => {
        try {
          const nextDatasetSignature = buildDatasetStorageSignature(datasets);
          if (localDatasetSignatureRef.current !== nextDatasetSignature) {
            await saveDatasetsToStorage(datasets);
            localDatasetSignatureRef.current = nextDatasetSignature;
          }

          const nextLogSignature = buildLogSyncSignature(logEntries);
          if (localLogsSignatureRef.current !== nextLogSignature) {
            await saveLogsToStorage(logEntries);
            localLogsSignatureRef.current = nextLogSignature;
          }
        } catch {
          setStorageNotice(
            "Local browser storage is full or unavailable. Keeping data in cloud sync may take longer for large uploads."
          );
        }
      })();
    }, 250);

    if (!datasetsHydrated || !remoteStateHydrated) {
      return () => {
        window.clearTimeout(localSaveTimeout);
      };
    }

    if (remoteDashboardStateQuery.status === "error") {
      setStorageNotice(null);
      return () => {
        window.clearTimeout(localSaveTimeout);
      };
    }

    if (remoteDashboardStateQuery.status !== "success") {
      return () => {
        window.clearTimeout(localSaveTimeout);
      };
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          await saveRemoteDashboardStateRef.current.mutateAsync({ payload: remoteStatePayload.payload });
          if (cancelled) return;
          if (remoteStatePayload.usedManifestOnly) {
            setStorageNotice("Cloud sync saved dataset metadata only; snapshot history was too large to sync.");
            return;
          }
          setStorageNotice(null);
        } catch {
          try {
            await saveRemoteDashboardStateRef.current.mutateAsync({ payload: manifestOnlyRemoteStatePayload });
            if (cancelled) return;
            setStorageNotice("Cloud sync saved dataset metadata only; snapshot history was too large to sync.");
          } catch {
            if (cancelled) return;
            setStorageNotice("Could not sync dashboard state metadata to cloud storage.");
          }
        }
      })();
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(localSaveTimeout);
      window.clearTimeout(timeout);
    };
  }, [
    datasets,
    datasetsHydrated,
    manifestOnlyRemoteStatePayload,
    remoteDashboardStateQuery.status,
    remoteStateHydrated,
    remoteStatePayload.payload,
    remoteStatePayload.usedManifestOnly,
    logEntries,
  ]);

  useEffect(() => {
    if (!datasetsHydrated || !remoteStateHydrated) return;
    if (remoteDashboardStateQuery.status !== "success") return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSignatures: Partial<Record<DatasetKey, string>> = {};
        const nextLocalOnlyDatasets: Partial<Record<DatasetKey, boolean>> = {};

        for (const key of Object.keys(DATASET_DEFINITIONS) as DatasetKey[]) {
          const dataset = datasets[key];
          const sourceManifest = remoteSourceManifestsRef.current[key];
          const forceSyncRequested = forcedRemoteDatasetSyncKeysRef.current.has(key);
          const previousSyncSignature = remoteDatasetSignatureRef.current[key] ?? "";
          if (!dataset) {
            forcedRemoteDatasetSyncKeysRef.current.delete(key);
            setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));

            // Hard guard: only run the destructive cloud cleanup if
            // the user actually loaded this dataset in the current
            // session. Without this, simply mounting the dashboard
            // (which leaves convertedReads in its "Tap tab to load"
            // state) would fall through to the
            // syncConvertedReadsUserSources({ userSources: [] }) call
            // below and wipe every user CSV source from cloud — which
            // is exactly the user-reported regression that turned a
            // ~1M-row Converted Reads dataset into a single
            // monitoring-batch source after running one provider on
            // /solar-rec/monitoring.
            if (!everLoadedDatasetsRef.current[key]) {
              continue;
            }

            // Special-case convertedReads: the manifest may contain
            // server-managed sources (mon_batch_*, individual_*) the
            // dashboard doesn't own. A client clear must only remove the
            // user-uploaded sources' chunks, and must rewrite the
            // manifest through the server's merge mutation so the
            // server-managed entries survive.
            if (key === "convertedReads") {
              if (sourceManifest?.sources && sourceManifest.sources.length > 0) {
                const userSources = sourceManifest.sources.filter(
                  (source) => !isServerManagedConvertedReadsSourceId(source.id)
                );
                await mapWithBoundedConcurrency(
                  userSources,
                  REMOTE_WRITE_CONCURRENCY,
                  (source) =>
                    clearRemotePayloadWithChunks(source.storageKey, source.chunkKeys).catch(() => {
                      // Best effort per-source cleanup.
                    })
                );
                setRemoteSourceManifests((previous) => ({ ...previous, [key]: undefined }));
              }
              try {
                await withRetry(() =>
                  syncConvertedReadsUserSourcesRef.current.mutateAsync({ userSources: [] })
                );
                delete remoteDatasetSignatureRef.current[key];
                delete remoteDatasetChunkKeysRef.current[key];
                setDatasetCloudSyncBadge(key, undefined);
                invalidateDatasetCloudStatuses();
              } catch {
                setDatasetCloudSyncBadge(key, "failed");
                setStorageNotice(
                  `Could not clear ${DATASET_DEFINITIONS[key].label} dataset from cloud storage.`
                );
                return;
              }
              continue;
            }

            if (sourceManifest?.sources && sourceManifest.sources.length > 0) {
              // Phase 13a: source cleanups are best-effort and fully
              // independent — fan them out.
              await mapWithBoundedConcurrency(
                sourceManifest.sources,
                REMOTE_WRITE_CONCURRENCY,
                (source) =>
                  clearRemotePayloadWithChunks(source.storageKey, source.chunkKeys).catch(() => {
                    // Best effort source cleanup.
                  })
              );
              setRemoteSourceManifests((previous) => ({ ...previous, [key]: undefined }));
            }
            if (!remoteDatasetSignatureRef.current[key]) continue;
            const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
            try {
              // Phase 13a: primary-key tombstone first (readers use
              // this as the "deleted" signal), then clear all chunk
              // slots in parallel.
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload: "" }));
              if (previousChunkKeys.length > 0) {
                await mapWithBoundedConcurrency(previousChunkKeys, REMOTE_WRITE_CONCURRENCY, (chunkKey) =>
                  withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }))
                );
              }
              delete remoteDatasetSignatureRef.current[key];
              delete remoteDatasetChunkKeysRef.current[key];
              setDatasetCloudSyncBadge(key, undefined);
              invalidateDatasetCloudStatuses();
            } catch {
              setDatasetCloudSyncBadge(key, "failed");
              setStorageNotice(`Could not clear ${DATASET_DEFINITIONS[key].label} dataset from cloud storage.`);
              return;
            }
            continue;
          }

          if (sourceManifest?.sources && sourceManifest.sources.length > 0) {
            const latestSource = sourceManifest.sources[sourceManifest.sources.length - 1];
            const syncSignature =
              `raw:${sourceManifest.sources.length}|${latestSource?.id ?? ""}|${latestSource?.uploadedAt ?? ""}|${dataset.rows.length}`;
            nextSignatures[key] = syncSignature;

            if (remoteDatasetSignatureRef.current[key] === syncSignature) {
              if (forceSyncRequested) {
                forcedRemoteDatasetSyncKeysRef.current.delete(key);
                setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
                setStorageNotice(`${DATASET_DEFINITIONS[key].label} is already synced to cloud.`);
              }
              continue;
            }

            // Special-case convertedReads: server owns the manifest (it
            // holds monitoring-batch + individual meter-reads entries the
            // dashboard may not know about). Route through the merge
            // mutation so server-managed sources survive the auto-sync.
            if (key === "convertedReads") {
              const userSources = sourceManifest.sources.filter(
                (source) => !isServerManagedConvertedReadsSourceId(source.id)
              );
              try {
                await withRetry(() =>
                  syncConvertedReadsUserSourcesRef.current.mutateAsync({
                    userSources: userSources.map((source) => ({
                      id: source.id,
                      fileName: source.fileName,
                      uploadedAt: source.uploadedAt,
                      rowCount: source.rowCount,
                      sizeBytes: source.sizeBytes,
                      storageKey: source.storageKey,
                      chunkKeys: source.chunkKeys,
                      encoding: source.encoding,
                      contentType: source.contentType,
                    })),
                  })
                );
                remoteDatasetSignatureRef.current[key] = syncSignature;
                // Server owns the manifest blob at key "convertedReads",
                // so we don't track chunk keys for it locally anymore.
                remoteDatasetChunkKeysRef.current[key] = [];
                if (forceSyncRequested) {
                  forcedRemoteDatasetSyncKeysRef.current.delete(key);
                  setForceSyncingDatasets((previous) =>
                    previous[key] ? { ...previous, [key]: false } : previous
                  );
                  setStorageNotice(
                    `Force cloud sync completed for ${DATASET_DEFINITIONS[key].label}.`
                  );
                }
                setDatasetCloudSyncBadge(key, "pending");
                invalidateDatasetCloudStatuses();
                triggerCoreDatasetSrDsSync(key);
              } catch {
                if (forceSyncRequested) {
                  forcedRemoteDatasetSyncKeysRef.current.delete(key);
                  setForceSyncingDatasets((previous) =>
                    previous[key] ? { ...previous, [key]: false } : previous
                  );
                }
                setDatasetCloudSyncBadge(key, "failed");
                setStorageNotice(
                  `Could not sync ${DATASET_DEFINITIONS[key].label} source manifest to cloud storage.`
                );
                return;
              }
              continue;
            }

            const manifestPayload = safeJsonStringify(sourceManifest);
            if (!manifestPayload) {
              setStorageNotice(`Could not serialize ${DATASET_DEFINITIONS[key].label} source manifest for cloud sync.`);
              return;
            }

            try {
              const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
              const chunkKeys = await saveRemotePayloadWithChunks(key, manifestPayload);
              const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
              for (const staleChunkKey of staleChunkKeys) {
                await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }));
              }
              remoteDatasetChunkKeysRef.current[key] = chunkKeys;
              remoteDatasetSignatureRef.current[key] = syncSignature;
              if (forceSyncRequested) {
                forcedRemoteDatasetSyncKeysRef.current.delete(key);
                setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
                setStorageNotice(`Force cloud sync completed for ${DATASET_DEFINITIONS[key].label}.`);
              }
              setDatasetCloudSyncBadge(key, "pending");
              invalidateDatasetCloudStatuses();
              // Phase 8.1.5: keep srDs* in sync for core datasets.
              triggerCoreDatasetSrDsSync(key);
            } catch {
              if (forceSyncRequested) {
                forcedRemoteDatasetSyncKeysRef.current.delete(key);
                setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
              }
              setDatasetCloudSyncBadge(key, "failed");
              setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} source manifest to cloud storage.`);
              return;
            }
            continue;
          }

          const baseSignature = `${dataset.fileName}|${dataset.uploadedAt.toISOString()}|${dataset.rows.length}|${dataset.sources?.length ?? 0}`;
          // 2026-04-12 fix: Always use the same signature regardless of
          // local-only status. The `local-only:` prefix caused a race where
          // force-synced data got a "normal" signature, then the next auto-sync
          // created a different "local-only:" signature for the SAME content,
          // bypassing the "no change" guard and triggering the destructive
          // clear path that wiped all chunk payloads.
          const syncSignature = baseSignature;
          nextSignatures[key] = syncSignature;

          // 2026-04-27 fix: removed the 3 MB pre-flight cap that used
          // to flip large datasets (Schedule B at ~3 MB chunked-CSV
          // size, the appended-monitoring `convertedReads` blob,
          // etc.) into a "Local-only sync — too large for auto sync"
          // dead-end. The cap was set when chunked-CSV writes were
          // hitting tRPC body-size limits, but the actual save path
          // below already chunks the payload at
          // `REMOTE_DATASET_CHUNK_CHAR_LIMIT` (250 KB) into
          // serial mutateAsync calls, so a 3 MB payload is just 12
          // sequential 250 KB writes — no proxy/tRPC limit to hit.
          // Post-Tasks 5.12 + 5.13 the canonical writes for
          // Schedule B + convertedReads go through the row tables
          // anyway, so the auto-sync chunked-CSV path is the legacy
          // cache path, not the path holding the data hostage.
          // `nextLocalOnlyDatasets` stays declared upstream for
          // back-compat with the migration UI; it just stays empty
          // now so no dataset gets parked in the "local-only" badge.

          if (remoteDatasetSignatureRef.current[key] === syncSignature) {
            if (forceSyncRequested) {
              forcedRemoteDatasetSyncKeysRef.current.delete(key);
              setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
              setStorageNotice(`${DATASET_DEFINITIONS[key].label} is already synced to cloud.`);
            }
            continue;
          }

          try {
            const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
            const payload = serializeDatasetForRemote(dataset);
            const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);

            if (chunks.length === 1) {
              // Phase 13a: tombstone the primary key, then clear stale
              // chunks in parallel (all independent mutations).
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload }));
              if (previousChunkKeys.length > 0) {
                await mapWithBoundedConcurrency(previousChunkKeys, REMOTE_WRITE_CONCURRENCY, (chunkKey) =>
                  withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }))
                );
              }
              remoteDatasetChunkKeysRef.current[key] = [];
            } else {
              // Phase 13a: upload all new chunks concurrently, clear
              // stale ones concurrently too, then commit the chunk
              // pointer last so readers never observe a partial state.
              const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(key, index));
              await mapWithBoundedConcurrency(
                chunks.map((chunk, index) => ({ chunk, index })),
                REMOTE_WRITE_CONCURRENCY,
                ({ chunk, index }) =>
                  withRetry(() =>
                    saveRemoteDatasetRef.current.mutateAsync({
                      key: chunkKeys[index],
                      payload: chunk,
                    })
                  )
              );
              const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
              if (staleChunkKeys.length > 0) {
                await mapWithBoundedConcurrency(staleChunkKeys, REMOTE_WRITE_CONCURRENCY, (staleChunkKey) =>
                  withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }))
                );
              }
              await withRetry(() =>
                saveRemoteDatasetRef.current.mutateAsync({
                  key,
                  payload: buildChunkPointerPayload(chunkKeys),
                })
              );
              remoteDatasetChunkKeysRef.current[key] = chunkKeys;
            }

            remoteDatasetSignatureRef.current[key] = syncSignature;
            if (forceSyncRequested) {
              forcedRemoteDatasetSyncKeysRef.current.delete(key);
              setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
              setStorageNotice(`Force cloud sync completed for ${DATASET_DEFINITIONS[key].label}.`);
            }
            setDatasetCloudSyncBadge(key, "pending");
            invalidateDatasetCloudStatuses();
          } catch {
            if (forceSyncRequested) {
              forcedRemoteDatasetSyncKeysRef.current.delete(key);
              setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
            }
            setDatasetCloudSyncBadge(key, "failed");
            setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} dataset to cloud storage.`);
            return;
          }
        }

        const activeKeys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(datasets[key]));
        try {
          await withRetry(() =>
            saveRemoteDatasetRef.current.mutateAsync({
              key: REMOTE_DATASET_KEY_MANIFEST,
              payload: buildDatasetKeyManifestPayload(activeKeys),
            })
          );
        } catch {
          setStorageNotice("Could not sync dataset manifest to cloud storage.");
          return;
        }

        remoteDatasetSignatureRef.current = nextSignatures;
        setLocalOnlyDatasets(nextLocalOnlyDatasets);
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    clearRemotePayloadWithChunks,
    datasets,
    datasetsHydrated,
    forceDatasetSyncTick,
    invalidateDatasetCloudStatuses,
    remoteDashboardStateQuery.status,
    remoteStateHydrated,
    saveRemotePayloadWithChunks,
    setDatasetCloudSyncBadge,
    triggerCoreDatasetSrDsSync,
  ]);

  useEffect(() => {
    if (!datasetsHydrated || !remoteStateHydrated) return;
    if (remoteDashboardStateQuery.status !== "success") return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSignature = buildLogSyncSignature(logEntries);
        if (remoteLogsSignatureRef.current === nextSignature) return;

        const previousChunkKeys = remoteLogsChunkKeysRef.current ?? [];
        // Phase 13a: same parallel-chunk pattern as saveRemotePayloadWithChunks
        // but kept inline here because it mixes in the REMOTE_LOG_SYNC_MAX_CHUNKS
        // guard + the stale-chunk diff. All mutations inside are independent.
        const syncLogsPayload = async (payload: string) => {
          const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          if (chunks.length > REMOTE_LOG_SYNC_MAX_CHUNKS) {
            throw new Error(`Snapshot log payload too large for cloud sync (${chunks.length} chunks).`);
          }

          if (chunks.length === 1) {
            await withRetry(() =>
              saveRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY, payload })
            );
            if (previousChunkKeys.length > 0) {
              await mapWithBoundedConcurrency(previousChunkKeys, REMOTE_WRITE_CONCURRENCY, (chunkKey) =>
                withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }))
              );
            }
            return [] as string[];
          }

          const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(REMOTE_SNAPSHOT_LOGS_KEY, index));
          await mapWithBoundedConcurrency(
            chunks.map((chunk, index) => ({ chunk, index })),
            REMOTE_WRITE_CONCURRENCY,
            ({ chunk, index }) =>
              withRetry(() =>
                saveRemoteDatasetRef.current.mutateAsync({
                  key: chunkKeys[index],
                  payload: chunk,
                })
              )
          );
          const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
          if (staleChunkKeys.length > 0) {
            await mapWithBoundedConcurrency(staleChunkKeys, REMOTE_WRITE_CONCURRENCY, (staleChunkKey) =>
              withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }))
            );
          }
          await withRetry(() =>
            saveRemoteDatasetRef.current.mutateAsync({
              key: REMOTE_SNAPSHOT_LOGS_KEY,
              payload: buildChunkPointerPayload(chunkKeys),
            })
          );
          return chunkKeys;
        };

        if (logEntries.length === 0) {
          try {
            await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY, payload: "" }));
            if (previousChunkKeys.length > 0) {
              await mapWithBoundedConcurrency(previousChunkKeys, REMOTE_WRITE_CONCURRENCY, (chunkKey) =>
                withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }))
              );
            }
            remoteLogsChunkKeysRef.current = [];
            remoteLogsSignatureRef.current = nextSignature;
          } catch {
            setStorageNotice("Could not clear snapshot logs from cloud storage.");
          }
          return;
        }

        const payload = safeJsonStringify(serializeDashboardLogs(logEntries, { includeSystemName: false })) ?? "[]";

        try {
          remoteLogsChunkKeysRef.current = await syncLogsPayload(payload);
          remoteLogsSignatureRef.current = nextSignature;
        } catch {
          try {
            const compactLogs = compactLogsForRemoteSync(logEntries);
            const compactPayload = safeJsonStringify(compactLogs) ?? "[]";
            remoteLogsChunkKeysRef.current = await syncLogsPayload(compactPayload);
            remoteLogsSignatureRef.current = nextSignature;
            setStorageNotice(
              "Cloud sync saved compact snapshot logs due size limits. Full history remains on this browser."
            );
          } catch {
            setStorageNotice("Could not sync snapshot logs to cloud storage.");
          }
        }
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    datasetsHydrated,
    logEntries,
    remoteDashboardStateQuery.status,
    remoteStateHydrated,
  ]);

  // compliant source localStorage sync + URL.revokeObjectURL cleanup
  // — moved to @/solar-rec-dashboard/components/PerformanceRatioTab

  const createLogEntry = () => {
    const statusCount = (status: ChangeOwnershipStatus) =>
      changeOwnershipRows.filter((system) => system.changeOwnershipStatus === status).length;
    const snapshotCooStatuses = changeOwnershipRows
      .map((system) => {
        if (!system.changeOwnershipStatus) return null;
        return {
          key: buildSystemSnapshotKey(system),
          status: system.changeOwnershipStatus,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const entry: DashboardLogEntry = {
      id: createLogId(),
      createdAt: new Date(),
      totalSystems: summary.totalSystems,
      reportingSystems: summary.reportingSystems,
      reportingPercent: summary.reportingPercent,
      changeOwnershipSystems: changeOwnershipSummary.total,
      changeOwnershipPercent: toPercentValue(changeOwnershipSummary.total, summary.totalSystems),
      transferredReporting: statusCount("Transferred and Reporting"),
      transferredNotReporting: statusCount("Transferred and Not Reporting"),
      terminatedReporting: summary.ownershipOverview.terminatedReporting,
      terminatedNotReporting: summary.ownershipOverview.terminatedNotReporting,
      changedNotTransferredReporting: statusCount("Change of Ownership - Not Transferred and Reporting"),
      changedNotTransferredNotReporting: statusCount("Change of Ownership - Not Transferred and Not Reporting"),
      totalContractedValue: snapshotPart2ValueSummary.totalContractedValue,
      totalDeliveredValue: snapshotPart2ValueSummary.totalDeliveredValue,
      totalGap: snapshotPart2ValueSummary.totalGap,
      contractedValueReporting: snapshotPart2ValueSummary.contractedValueReporting,
      contractedValueNotReporting: snapshotPart2ValueSummary.contractedValueNotReporting,
      contractedValueReportingPercent: snapshotPart2ValueSummary.contractedValueReportingPercent,
      datasets: (Object.keys(DATASET_DEFINITIONS) as DatasetKey[])
        .map((key) => {
          const dataset = datasets[key];
          if (!dataset) return null;
          return {
            key,
            label: DATASET_DEFINITIONS[key].label,
            fileName: dataset.fileName,
            rows: dataset.rows.length,
            updatedAt: dataset.uploadedAt,
          };
        })
        .filter((dataset): dataset is NonNullable<typeof dataset> => dataset !== null),
      cooStatuses: snapshotCooStatuses,
      recPerformanceContracts2025: recPerformanceSnapshotContracts2025,
    };

    setLogEntries((previous) => [entry, ...previous].slice(0, 500));
  };

  const clearLogs = () => {
    setLogEntries([]);
  };

  const deleteLogEntry = (id: string) => {
    setLogEntries((previous) => previous.filter((entry) => entry.id !== id));
  };

  // monthlySnapshotTransitions useEffect, snapshotLogColumns,
  // snapshotContractIds, snapshotContractMetricsByLogId,
  // snapshotContract{TotalPages,CurrentPage,Start/EndIndex},
  // visibleSnapshotContractIds, snapshotTrendRows, snapshotTrendSummary,
  // snapshotContractPage clamp useEffect, snapshotMetricRows
  // — moved to @/solar-rec-dashboard/components/SnapshotLogTab

  const missingCoreDatasets = datasetsHydrated
    ? CORE_REQUIRED_DATASET_KEYS.filter((key) => !datasets[key])
    : [];

  const activeDatasetSyncProgress = useMemo(() => {
    const entries = Object.entries(datasetSyncProgress) as Array<
      [DatasetKey, DatasetSyncProgressState]
    >;
    if (entries.length === 0) return null;
    entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    const [datasetKey, progress] = entries[0]!;
    return { datasetKey, progress };
  }, [datasetSyncProgress]);

  const dataHealthSummary = useMemo(() => {
    const loadedDatasetKeys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(datasets[key]));
    // Task 5.14 PR-2 (2026-04-27): Total-Rows-Loaded reads the
    // server-side `rowCount` from `getDatasetSummariesAll` for every
    // dataset. The previous in-memory `rows.length` fallback existed
    // for the 11 non-row-backed datasets that data-flow PR-6 couldn't
    // cover — Task 5.12 (PRs 1–10) closed that gap, so the fallback
    // is dead code and the swap to summaries-only is safe. During
    // the brief initial-load window before `datasetSummariesQuery`
    // returns, the count shows 0; once the query lands (within a
    // second on a warm cache) it shows the real number.
    const totalRowsLoaded = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).reduce(
      (sum, key) => sum + (datasetSummariesByKey[key]?.rowCount ?? 0),
      0
    );
    // Task 5.14 PR-2: staleness reads the server-side `lastUpdated`
    // (ISO string) instead of the in-memory `datasets[k].uploadedAt`.
    // Both reach for the same value at steady state; the swap drops
    // the dataHealthSummary's dependency on the row-array side of
    // `datasets[k]`.
    const staleDatasets = loadedDatasetKeys.filter((key) => {
      const lastUpdatedRaw = datasetSummariesByKey[key]?.lastUpdated;
      const lastUpdated = lastUpdatedRaw ? new Date(lastUpdatedRaw) : null;
      return isStaleUpload(lastUpdated);
    });

    // Header sync status rolls up serverDatasetCloudStatusByKey across
    // every loaded dataset. "Cloud sync incomplete (N)" whenever any
    // loaded dataset reports recoverable=false; "Cloud sync healthy"
    // otherwise. In-flight upload / save / loading states take
    // precedence over the rollup.
    //
    // Scanner-managed datasets (deliveryScheduleBase) are excluded
    // because they're populated by a separate workflow and their own
    // card handles the badge.
    let incompleteCount = 0;
    if (loadedDatasetKeys.length > 0) {
      for (const key of loadedDatasetKeys) {
        if (SCANNER_MANAGED_DATASET_KEYS.has(key)) continue;
        const serverStatus = serverDatasetCloudStatusByKey[key];
        // No status yet == still fetching; don't count as incomplete.
        if (serverStatus === undefined) continue;
        if (!serverStatus.recoverable) {
          incompleteCount += 1;
        }
      }
    }

    const syncStatus = activeUploadTaskLabel
      ? queuedUploadTaskCount > 0
        ? `Processing ${activeUploadTaskLabel} (${formatNumber(queuedUploadTaskCount)} queued)`
        : `Processing ${activeUploadTaskLabel}`
      : remoteDashboardStateQuery.status === "pending"
        ? "Checking cloud sync..."
        : saveRemoteDashboardState.isPending || saveRemoteDataset.isPending
          ? "Syncing to cloud..."
          : remoteDashboardStateQuery.status === "error"
            ? "Cloud sync currently unavailable"
            : incompleteCount > 0
              ? `Cloud sync incomplete (${formatNumber(incompleteCount)} dataset${incompleteCount === 1 ? "" : "s"})`
              : "Cloud sync healthy";

    return {
      loadedDatasetCount: loadedDatasetKeys.length,
      totalDatasetCount: Object.keys(DATASET_DEFINITIONS).length,
      totalRowsLoaded,
      staleDatasetCount: staleDatasets.length,
      staleDatasetLabels: staleDatasets.map((key) => DATASET_DEFINITIONS[key].label),
      missingRequiredCount: missingCoreDatasets.length,
      syncStatus,
      cloudSyncIncompleteCount: incompleteCount,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- individual slots
  }, [
    datasets.solarApplications, datasets.abpReport, datasets.generationEntry,
    datasets.accountSolarGeneration, datasets.contractedDate, datasets.convertedReads,
    datasets.annualProductionEstimates, datasets.generatorDetails,
    datasets.abpUtilityInvoiceRows, datasets.abpCsgSystemMapping,
    datasets.abpQuickBooksRows, datasets.abpProjectApplicationRows,
    datasets.abpPortalInvoiceMapRows, datasets.abpCsgPortalDatabaseRows,
    datasets.abpIccReport2Rows, datasets.abpIccReport3Rows,
    datasets.deliveryScheduleBase, datasets.transferHistory,
    missingCoreDatasets.length,
    activeUploadTaskLabel,
    queuedUploadTaskCount,
    remoteDashboardStateQuery.status,
    saveRemoteDashboardState.isPending,
    saveRemoteDataset.isPending,
    serverDatasetCloudStatusByKey,
    // PR-6 (data-flow): Total-Rows-Loaded prefers server-side counts.
    datasetSummariesByKey,
  ]);

  const part2FilterAudit = useMemo(() => {
    const totalAbpRows = datasetSummariesByKey['abpReport']?.rowCount ?? 0;
    const part2Rows = part2VerifiedAbpRows.length;
    const excludedRows = Math.max(0, totalAbpRows - part2Rows);
    return {
      totalAbpRows,
      part2Rows,
      excludedRows,
      part2UniqueSystems: abpEligibleTotalSystems,
      scopedSystems: part2EligibleSystemsForSizeReporting.length,
      scopedCoveragePercent: toPercentValue(part2EligibleSystemsForSizeReporting.length, abpEligibleTotalSystems),
    };
  }, [
    abpEligibleTotalSystems,
    datasetSummariesByKey,
    part2EligibleSystemsForSizeReporting.length,
    part2VerifiedAbpRows.length,
  ]);

  // sizeReportingChartRows, ownershipStackedChartRows
  // — moved to OverviewTab (Phase 12)
  // recValueByStatusChartRows, recTopGapChartRows
  // — moved to RecValueTab (Phase 12)

  // contractPerformanceChartRows, annualVintageTrendChartRows
  // — moved to @/solar-rec-dashboard/components/{ContractsTab,AnnualReviewTab}

  // ── Application Pipeline: Part 1 / Part 2 from ABP, Interconnected from Generator Details ──
  // pipelineMonthlyRows, pipelineRows3Year, pipelineRows12Month, pipelineBands,
  // pipelineRowGroupIndex, cashFlowRows12MonthRef, handleGeneratePipelineReport
  // — moved to @/solar-rec-dashboard/components/AppPipelineTab
  // trendProductionMoM, trendTopSiteIds, trendDeliveryPace — moved to @/solar-rec-dashboard/components/TrendsTab
  // Forecast constants, ForecastContractRow type, forecastProjections,
  // forecastSummary — moved to @/solar-rec-dashboard/components/ForecastTab

  // ── Delivery Tracker ────────────────────────────────────────────
// Phase 1a: obligations come exclusively from deliveryScheduleBase (the
// Schedule B scrape output). recDeliverySchedules has been removed from
// the entire dashboard. Deliveries come exclusively from transferHistory
// via buildDeliveryTrackerData's internal transfer-matching logic.
//
// The tracker now also surfaces `transfersMissingObligation` — distinct
// tracking IDs that have transfers but no matching Schedule B PDF yet,
// so the user can see exactly which systems still need scraping.
// Task 5.13 PR-1 (2026-04-27): the Delivery Tracker aggregate moved
// off raw-row materialization. Server reads `srDsDeliverySchedule` +
// `srDsTransferHistory` for the active scope, runs
// `buildDeliveryTrackerData`, and returns the same shape the client
// used to build locally. Result is cached in
// `solarRecComputedArtifacts` keyed by the input batch-IDs hash, so
// repeat tab activations are O(cache-read). superjson preserves the
// Date fields in `yearStart`/`yearEnd` end-to-end.
const deliveryTrackerQuery =
  solarRecTrpc.solarRecDashboard.getDashboardDeliveryTrackerAggregates.useQuery(
    undefined,
    {
      enabled: isDeliveryTrackerTabActive,
      staleTime: 60_000,
    }
  );
const deliveryTrackerData = deliveryTrackerQuery.data ?? EMPTY_DELIVERY_TRACKER_DATA;

// ── Alerts ──────────────────────────────────────────────────────
// AlertItem type, alerts memo, alertSummary memo — moved to @/solar-rec-dashboard/components/AlertsTab
// comparisonInstallers, comparisonPlatforms — moved to @/solar-rec-dashboard/components/ComparisonsTab

// ── Financials: Part II Verified System IDs (strict) ────────────
const part2VerifiedSystemIds = useMemo(() => {
  const ids = new Set<string>();
  part2VerifiedAbpRows.forEach((row) => {
    const appId = clean(row.Application_ID) || clean(row.system_id);
    if (appId) ids.add(appId);
  });
  return ids;
}, [part2VerifiedAbpRows]);

// part2VerifiedSystems, financialRevenueAtRisk — moved to @/solar-rec-dashboard/components/FinancialsTab
// ── Financials: Profit & Collateralization ──────────────────────
const financialCsgIds = useMemo(() => {
  if (!isFinancialsTabActive && !isPipelineTabActive && !isOverviewTabActive) return [];
  const mappingRows = datasets.abpCsgSystemMapping?.rows ?? [];
  const ids = new Set<string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    if (csgId) ids.add(csgId);
  }
  return Array.from(ids);
}, [isFinancialsTabActive, isPipelineTabActive, isOverviewTabActive, datasets.abpCsgSystemMapping]);

// Task 5.7 PR-B (2026-04-26): getContractScanResultsByCsgIds moved
// from main `abpSettlementRouter` to standalone `contractScan` —
// dashboard already imports `solarRecTrpc` (PR #110) so this is a
// straight call-site swap.
const contractScanResultsQuery = solarRecTrpc.contractScan.getContractScanResultsByCsgIds.useQuery(
  { csgIds: financialCsgIds },
  { enabled: (isFinancialsTabActive || isPipelineTabActive || isOverviewTabActive) && financialCsgIds.length > 0 }
);
// updateContractOverride, rescanSingleContract mutations + editingFinancialRow state
// — moved to @/solar-rec-dashboard/components/FinancialsTab

// ProfitRow — moved to @/solar-rec-dashboard/state/types

const financialProfitData = useMemo<FinancialProfitData>(() => {
  const empty = { rows: [] as ProfitRow[], totalProfit: 0, avgProfit: 0, totalCollateralization: 0, totalUtilityCollateral: 0, totalAdditionalCollateral: 0, totalCcAuth: 0, systemsWithData: 0 };
  if (!isFinancialsTabActive && !isOverviewTabActive) return empty;

  const scanResults = contractScanResultsQuery.data ?? [];
  if (scanResults.length === 0) return empty;

  // Build lookup maps
  const scanByCsgId = new Map<string, (typeof scanResults)[number]>();
  for (const r of scanResults) {
    scanByCsgId.set(r.csgId, r);
  }

  const mappingRows = datasets.abpCsgSystemMapping?.rows ?? [];
  const csgIdByAppId = new Map<string, string>();
  const appIdByCsgId = new Map<string, string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    const systemId = (row.systemId || row["System ID"] || "").trim();
    if (csgId && systemId) {
      csgIdByAppId.set(systemId, csgId);
      appIdByCsgId.set(csgId, systemId);
    }
  }

  // Build ICC Report 3 lookup by applicationId → grossContractValue
  const iccRows = datasets.abpIccReport3Rows?.rows ?? [];
  // 2026-04-11: replaced raw parseFloat with parseNumber (line 793)
  // which strips $, commas, %, and whitespace before parsing. The ICC
  // Report 3 CSV uses currency-formatted values like "$1,234.56" that
  // parseFloat can't handle — every row returned NaN, gross was
  // always 0, and no appIds made it into iccByAppId.
  const iccByAppId = new Map<string, { grossContractValue: number; recQuantity: number; recPrice: number }>();
  for (const row of iccRows) {
    const appId = (
      row["Application ID"] || row.Application_ID || row.application_id || ""
    ).trim();
    if (!appId) continue;
    const gcv =
      parseNumber(
        row["Total REC Delivery Contract Value"] ||
        row["REC Delivery Contract Value"] ||
        row["Total Contract Value"]
      ) ?? 0;
    const rq =
      parseNumber(
        row["Total Quantity of RECs Contracted"] ||
        row["Contracted SRECs"] ||
        row.SRECs
      ) ?? 0;
    const rp = parseNumber(row["REC Price"]) ?? 0;
    const gross = gcv > 0 ? gcv : rq * rp;
    if (gross > 0) {
      iccByAppId.set(appId, { grossContractValue: gross, recQuantity: rq, recPrice: rp });
    }
  }

  // Build Part I submit date lookup from ABP report rows
  const abpRows = datasets.abpReport?.rows ?? [];
  const part1DateByAppId = new Map<string, Date>();
  for (const row of abpRows) {
    const appId = (row.Application_ID || row.application_id || "").trim();
    if (!appId) continue;
    const raw = row.Part_1_Submission_Date || row.Part_1_submission_date || row.Part_1_Original_Submission_Date || "";
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) part1DateByAppId.set(appId, d);
    }
  }

  const profitRows: ProfitRow[] = [];
  const APPLICATION_FEE_CUTOFF = new Date("2024-06-01");

  for (const abpRow of part2VerifiedAbpRows) {
    const appId = (abpRow.Application_ID || abpRow.application_id || "").trim();
    if (!appId) continue;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;

    const scan = scanByCsgId.get(csgId);
    const icc = iccByAppId.get(appId);
    if (!scan || !icc) continue;

    const gcv = icc.grossContractValue;
    const localOv = localOverrides.get(csgId);
    const hasOverride = localOv != null || scan.overriddenAt != null;
    const vfp = localOv?.vfp ?? scan.overrideVendorFeePercent ?? scan.vendorFeePercent ?? 0;
    const vendorFeeAmount = roundMoney(gcv * (vfp / 100));
    const utilityCollateral = roundMoney(gcv * 0.05);
    const acp = localOv?.acp ?? scan.overrideAdditionalCollateralPercent ?? scan.additionalCollateralPercent ?? 0;
    const additionalCollateralAmount = roundMoney(gcv * (acp / 100));

    // CC auth 5%: if CC auth not completed AND not absent from contract, apply 5%
    const ccAuthCompleted = scan.ccAuthorizationCompleted;
    const ccAuth5Percent = ccAuthCompleted === false ? roundMoney(gcv * 0.05) : 0;

    // Application fee
    const acSizeKw = scan.acSizeKw ?? 0;
    const part1Date = part1DateByAppId.get(appId);
    let applicationFee = 0;
    if (part1Date && acSizeKw > 0) {
      if (part1Date < APPLICATION_FEE_CUTOFF) {
        applicationFee = Math.min(roundMoney(10 * acSizeKw), 5000);
      } else {
        applicationFee = Math.min(roundMoney(20 * acSizeKw), 15000);
      }
    }

    const totalDeductions = roundMoney(
      vendorFeeAmount + utilityCollateral + additionalCollateralAmount + ccAuth5Percent + applicationFee
    );
    // 2026-04-12: profit = vendor fee (what Carbon Solutions earns),
    // NOT gross minus all deductions. The vendor fee is the revenue;
    // the rest (collateral, app fees) are borne by the project.
    const profit = vendorFeeAmount;
    const totalCollateralization = roundMoney(utilityCollateral + additionalCollateralAmount + ccAuth5Percent);

    // Validation: flag rows where collateral > 30% of GCV.
    const collateralPercent = gcv > 0 ? totalCollateralization / gcv : 0;
    const needsReview = collateralPercent > 0.30;
    const reviewReason = needsReview
      ? `Collateral is ${(collateralPercent * 100).toFixed(1)}% of GCV`
      : "";

    profitRows.push({
      systemName: scan.systemName ?? appId,
      applicationId: appId,
      csgId,
      grossContractValue: gcv,
      vendorFeePercent: vfp,
      vendorFeeAmount,
      utilityCollateral,
      additionalCollateralPercent: acp,
      additionalCollateralAmount,
      ccAuth5Percent,
      applicationFee,
      totalDeductions,
      profit,
      totalCollateralization,
      needsReview,
      reviewReason,
      hasOverride,
    });
  }

  const totalProfit = profitRows.reduce((a, r) => a + r.profit, 0);
  const totalColl = profitRows.reduce((a, r) => a + r.totalCollateralization, 0);
  const totalUtilColl = profitRows.reduce((a, r) => a + r.utilityCollateral, 0);
  const totalAddlColl = profitRows.reduce((a, r) => a + r.additionalCollateralAmount, 0);
  const totalCcAuthColl = profitRows.reduce((a, r) => a + r.ccAuth5Percent, 0);

  return {
    rows: profitRows.sort((a, b) => b.profit - a.profit),
    totalProfit: roundMoney(totalProfit),
    avgProfit: profitRows.length > 0 ? roundMoney(totalProfit / profitRows.length) : 0,
    totalCollateralization: roundMoney(totalColl),
    totalUtilityCollateral: roundMoney(totalUtilColl),
    totalAdditionalCollateral: roundMoney(totalAddlColl),
    totalCcAuth: roundMoney(totalCcAuthColl),
    systemsWithData: profitRows.length,
  };
}, [
  isFinancialsTabActive,
  isOverviewTabActive,
  part2VerifiedAbpRows,
  contractScanResultsQuery.data,
  datasets.abpCsgSystemMapping,
  datasets.abpIccReport3Rows,
  datasets.abpReport,
  localOverrides,
]);

// ── Pipeline: Cash Flow by Month (M+1 from Part II verification) ──
// pipelineCashFlowRows, cashFlowRows3Year, cashFlowRows12Month, cashFlowRows12MonthRef — moved to @/solar-rec-dashboard/components/AppPipelineTab

// ── Financials: debug panel data (drive the collapsible diagnostic
//    block under the profit table). Walks the same join chain as
//    financialProfitData and counts attrition at every step so the
//    user can see EXACTLY which dataset is missing or mis-keyed.
//    Pure: gated on isFinancialsTabActive so it doesn't run on
//    other tabs.
const financialProfitDebug = useMemo(() => {
  if (!isFinancialsTabActive) {
    return null;
  }

  const mappingRows = datasets.abpCsgSystemMapping?.rows ?? [];
  const iccRows = datasets.abpIccReport3Rows?.rows ?? [];
  const scanResults = contractScanResultsQuery.data ?? [];

  // Step 1: parse the mapping into both directions
  const csgIdByAppId = new Map<string, string>();
  const appIdByCsgId = new Map<string, string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    const systemId = (row.systemId || row["System ID"] || "").trim();
    if (csgId && systemId) {
      csgIdByAppId.set(systemId, csgId);
      appIdByCsgId.set(csgId, systemId);
    }
  }

  // Step 2: scan-by-csgId
  const scanByCsgId = new Map<string, (typeof scanResults)[number]>();
  for (const r of scanResults) {
    scanByCsgId.set(r.csgId, r);
  }

  // Step 3: ICC by appId — match the same field-name fallbacks AND
  // use parseNumber (not parseFloat) to mirror the fix in
  // financialProfitData. Raw parseFloat chokes on currency-formatted
  // strings like "$1,234.56", making every row's gross === 0 and
  // dropping the appId entirely.
  const iccAppIds = new Set<string>();
  for (const row of iccRows) {
    const appId = (
      row["Application ID"] || row.Application_ID || row.application_id || ""
    ).trim();
    if (!appId) continue;
    const gcv =
      parseNumber(
        row["Total REC Delivery Contract Value"] ||
          row["REC Delivery Contract Value"] ||
          row["Total Contract Value"]
      ) ?? 0;
    const rq =
      parseNumber(
        row["Total Quantity of RECs Contracted"] ||
          row["Contracted SRECs"] ||
          row.SRECs
      ) ?? 0;
    const rp = parseNumber(row["REC Price"]) ?? 0;
    const gross = gcv > 0 ? gcv : rq * rp;
    if (gross > 0) iccAppIds.add(appId);
  }

  // Step 4: walk the join chain on part2VerifiedAbpRows and count
  // attrition at every step.
  let withAppId = 0;
  let withCsgId = 0;
  let withScan = 0;
  let withIcc = 0;
  let final = 0;
  for (const abpRow of part2VerifiedAbpRows) {
    const appId = (abpRow.Application_ID || abpRow.application_id || "").trim();
    if (!appId) continue;
    withAppId += 1;

    const csgId = csgIdByAppId.get(appId);
    if (!csgId) continue;
    withCsgId += 1;

    if (scanByCsgId.has(csgId)) {
      withScan += 1;
    }
    if (iccAppIds.has(appId)) {
      withIcc += 1;
    }

    if (scanByCsgId.has(csgId) && iccAppIds.has(appId)) {
      final += 1;
    }
  }

  // Sample IDs from each side for the user to eyeball mismatches
  const sample = <T,>(arr: T[], n: number) => arr.slice(0, n);
  const mappingCsgIdSamples = sample(
    Array.from(appIdByCsgId.keys()),
    5
  );
  const scanCsgIdSamples = sample(
    scanResults.map((r) => r.csgId),
    5
  );
  const mappingAppIdSamples = sample(
    Array.from(csgIdByAppId.keys()),
    5
  );
  const iccAppIdSamples = sample(Array.from(iccAppIds), 5);
  const part2AppIdSamples = sample(
    part2VerifiedAbpRows
      .map((r) => (r.Application_ID || r.application_id || "").trim())
      .filter((id) => id.length > 0),
    5
  );

  // ICC Report headers: surface the actual column names from the CSV
  // so the user can see if the expected field names (Application ID,
  // Total REC Delivery Contract Value, etc.) match what's in the file.
  const iccHeaders = datasets.abpIccReport3Rows?.headers ?? [];
  const iccFirstRow = iccRows.length > 0 ? iccRows[0] : null;
  // Try ALL known variants of the appId field to show which one works.
  const iccAppIdFieldFound =
    iccFirstRow
      ? ["Application ID", "Application_ID", "application_id"]
          .filter((key) => key in iccFirstRow && (iccFirstRow[key] ?? "").trim().length > 0)
      : [];
  const iccContractValueFieldFound =
    iccFirstRow
      ? [
          "Total REC Delivery Contract Value",
          "REC Delivery Contract Value",
          "Total Contract Value",
        ].filter(
          (key) =>
            key in iccFirstRow &&
            (iccFirstRow[key] ?? "").trim().length > 0
        )
      : [];
  const queryError = contractScanResultsQuery.error;
  const queryErrorMessage =
    queryError instanceof Error
      ? queryError.message
      : queryError
        ? String(queryError)
        : null;

  return {
    queryStatus: contractScanResultsQuery.status,
    queryFetching: contractScanResultsQuery.isFetching,
    queryEnabled: isFinancialsTabActive && financialCsgIds.length > 0,
    queryErrorMessage,
    counts: {
      part2VerifiedAbpRows: part2VerifiedAbpRows.length,
      mappingRows: mappingRows.length,
      iccReport3Rows: iccRows.length,
      financialCsgIdsCount: financialCsgIds.length,
      scanResultsReturned: scanResults.length,
    },
    chain: {
      iterated: part2VerifiedAbpRows.length,
      withAppId,
      withCsgId,
      withScan,
      withIcc,
      final,
    },
    samples: {
      mappingCsgIds: mappingCsgIdSamples,
      scanCsgIds: scanCsgIdSamples,
      mappingAppIds: mappingAppIdSamples,
      iccAppIds: iccAppIdSamples,
      part2AppIds: part2AppIdSamples,
    },
    icc: {
      headers: iccHeaders.slice(0, 20),
      appIdFieldFound: iccAppIdFieldFound,
      contractValueFieldFound: iccContractValueFieldFound,
    },
  };
}, [
  isFinancialsTabActive,
  part2VerifiedAbpRows,
  contractScanResultsQuery.data,
  contractScanResultsQuery.status,
  contractScanResultsQuery.isFetching,
  financialCsgIds,
  datasets.abpCsgSystemMapping,
  datasets.abpIccReport3Rows,
]);


// ── Data Quality: Freshness ─────────────────────────────────────
// dataQualityFreshness, dataQualityUnmatched — moved to @/solar-rec-dashboard/components/DataQualityTab

// ── AI Data Context per Tab ─────────────────────────────────────
const aiDataContext = useMemo(() => {
  const MAX_ROWS = 200;
  const truncate = <T,>(arr: T[], limit = MAX_ROWS) => arr.slice(0, limit);
  const pick = <T extends Record<string, unknown>>(obj: T, keys: string[]) => {
    const result: Record<string, unknown> = {};
    for (const k of keys) if (k in obj) result[k] = obj[k];
    return result;
  };

  try {
    switch (activeTab) {
      case "forecast":
        // forecastProjections moved into ForecastTab — chat context
        // loses the per-contract payload but still tracks the tab.
        return JSON.stringify({ tab: "forecast", systemCount: systems.length });
      case "financials":
        return JSON.stringify({
          tab: "financials",
          profitRows: truncate(financialProfitData.rows),
          totalProfit: financialProfitData.totalProfit,
          avgProfit: financialProfitData.avgProfit,
          totalCollateralization: financialProfitData.totalCollateralization,
        });
      case "performance-eval":
        return JSON.stringify({
          tab: "performance-eval",
          systems: truncate(
            performanceSourceRows.map((r) => ({
              trackingId: r.trackingSystemRefId,
              contractId: r.contractId,
              systemName: r.systemName,
              years: r.years.map((y) => ({
                key: y.key,
                required: y.required,
                delivered: y.delivered,
              })),
            }))
          ),
        });
      case "delivery-tracker":
        return JSON.stringify({
          tab: "delivery-tracker",
          contracts: deliveryTrackerData.contracts,
          totalTransfers: deliveryTrackerData.totalTransfers,
          unmatchedTransfers: deliveryTrackerData.unmatchedTransfers,
        });
      case "overview":
        return JSON.stringify({
          tab: "overview",
          systems: truncate(
            systems.map((s) =>
              pick(s as unknown as Record<string, unknown>, [
                "systemName", "systemId", "trackingSystemRefId",
                "installedKwAc", "recPrice", "contractedRecs",
                "deliveredRecs", "contractedValue", "deliveredValue",
                "valueGap", "isReporting", "isTerminated",
                "latestReportingDate", "installerName", "monitoringPlatform",
              ])
            )
          ),
          totalSystems: systems.length,
        });
      case "alerts":
        // alerts/alertSummary moved into AlertsTab — chat context loses
        // the per-alert payload but still knows the user is on that tab.
        return JSON.stringify({ tab: "alerts" });
      case "comparisons":
        // comparisonInstallers/Platforms moved into ComparisonsTab —
        // chat context loses the comparison rows but still tracks tab.
        return JSON.stringify({ tab: "comparisons" });
      default:
        return JSON.stringify({
          tab: activeTab,
          systemCount: systems.length,
          note: "Limited context for this tab. Ask general portfolio questions.",
        });
    }
  } catch {
    return JSON.stringify({ tab: activeTab, error: "Failed to serialize data context" });
  }
}, [
  activeTab, financialProfitData,
  performanceSourceRows, deliveryTrackerData, systems,
]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-emerald-50/40">
      <div className="container py-6 space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
              <Database className="h-3.5 w-3.5" />
              Solar REC Analytics
            </div>
            <h1 className="text-2xl font-bold tracking-wide uppercase text-foreground">Coherence Portfolio Analytics & Data Core</h1>
            <p className="text-sm text-slate-600">
              Import updated CSV exports anytime to refresh every view and status category.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setLocation("/dashboard")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
            <Button variant="outline" onClick={createLogEntry}>
              Log Snapshot
            </Button>
            <Button variant="outline" onClick={() => setUploadsExpanded((current) => !current)}>
              {uploadsExpanded ? "Hide Uploads" : "Show Uploads"}
              {uploadsExpanded ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
            </Button>
            <Button variant="outline" onClick={clearAll}>
              Clear All Files
            </Button>
          </div>
        </div>

        <Card className="sticky top-2 z-20 border-slate-300 bg-white/95 backdrop-blur-sm">
          <CardContent className="py-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Datasets Loaded</p>
                <p className="text-lg font-semibold text-slate-900">
                  {formatNumber(dataHealthSummary.loadedDatasetCount)} / {formatNumber(dataHealthSummary.totalDatasetCount)}
                </p>
                {/* Phase 16: progressive hydration progress. Disappears
                    once hydration finishes or no records exist. */}
                {!datasetsHydrated && hydrationProgress.total > 0 ? (
                  <p className="mt-1 text-[11px] text-sky-700">
                    Loading cache: {formatNumber(hydrationProgress.loaded)} / {formatNumber(hydrationProgress.total)}
                  </p>
                ) : null}
                {/* Load All toggle — only shown after initial hydration
                    settled AND there are still unloaded datasets. Mount
                    hydration is tab-priority-filtered; this bypasses
                    that filter and hydrates the rest. */}
                {datasetsHydrated &&
                dataHealthSummary.loadedDatasetCount < dataHealthSummary.totalDatasetCount ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingAllDatasets}
                    onClick={() => void loadAllDatasets()}
                    className="mt-2 h-7 w-full px-2 text-[11px]"
                  >
                    {loadingAllDatasets
                      ? loadAllProgress && loadAllProgress.total > 0
                        ? `Loading ${formatNumber(loadAllProgress.loaded)}/${formatNumber(loadAllProgress.total)}…`
                        : "Loading…"
                      : `Load all (${formatNumber(
                          dataHealthSummary.totalDatasetCount - dataHealthSummary.loadedDatasetCount
                        )} remaining)`}
                  </Button>
                ) : null}
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Rows Loaded</p>
                <p className="text-lg font-semibold text-slate-900">{formatNumber(dataHealthSummary.totalRowsLoaded)}</p>
              </div>
              <div
                className={`rounded-md border px-3 py-2 ${
                  dataHealthSummary.missingRequiredCount > 0
                    ? "border-amber-300 bg-amber-50"
                    : "border-emerald-300 bg-emerald-50"
                }`}
              >
                <p className="text-xs uppercase tracking-wide text-slate-500">Missing Required</p>
                <p
                  className={`text-lg font-semibold ${
                    dataHealthSummary.missingRequiredCount > 0 ? "text-amber-900" : "text-emerald-800"
                  }`}
                >
                  {formatNumber(dataHealthSummary.missingRequiredCount)}
                </p>
              </div>
              <div
                className={`rounded-md border px-3 py-2 ${
                  dataHealthSummary.staleDatasetCount > 0
                    ? "border-amber-300 bg-amber-50"
                    : "border-emerald-300 bg-emerald-50"
                }`}
              >
                <p className="text-xs uppercase tracking-wide text-slate-500">Stale Uploads (&gt;14d)</p>
                <p
                  className={`text-lg font-semibold ${
                    dataHealthSummary.staleDatasetCount > 0 ? "text-amber-900" : "text-emerald-800"
                  }`}
                >
                  {formatNumber(dataHealthSummary.staleDatasetCount)}
                </p>
              </div>
              <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Part II Filter QA</p>
                <p className="text-sm font-semibold text-slate-900">
                  {formatNumber(part2FilterAudit.scopedSystems)} / {formatNumber(part2FilterAudit.part2UniqueSystems)} systems mapped
                </p>
                <p className="mt-1 text-xs text-slate-700">
                  Coverage: {formatPercent(part2FilterAudit.scopedCoveragePercent)}
                </p>
                <p className="text-xs text-slate-700">
                  Rows: {formatNumber(part2FilterAudit.part2Rows)} Part II, {formatNumber(part2FilterAudit.excludedRows)} excluded
                </p>
              </div>
              <div className={`rounded-md border px-3 py-2 xl:col-span-2 ${
                Object.values(syncJobIssues).some(issue => issue.kind === "timeout" || issue.kind === "failed")
                  ? "border-rose-300 bg-rose-50"
                  : "border-slate-200 bg-slate-50"
              }`}>
                <p className="text-xs uppercase tracking-wide text-slate-500">Cloud Sync</p>
                
                {Object.keys(datasetSyncProgress).length > 0 ? (
                  <div className="mt-1">
                    <p className="text-sm font-semibold text-slate-900">
                      Syncing {Object.keys(datasetSyncProgress).length} dataset(s)...
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600 truncate">
                      {Object.keys(datasetSyncProgress).map(k => DATASET_DEFINITIONS[k as DatasetKey].label).join(", ")}
                    </p>
                    <button
                      className="mt-1 text-xs font-medium text-sky-600 hover:text-sky-700 hover:underline"
                      onClick={() => {
                        setUploadsExpanded(true);
                        // The container for dataset cards has id="dataset-cards" in this codebase.
                        document.getElementById("dataset-cards")?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      View progress &darr;
                    </button>
                  </div>
                ) : Object.values(syncJobIssues).some(issue => issue.kind === "timeout" || issue.kind === "failed") ? (
                  <div className="mt-1">
                    <p className="text-sm font-semibold text-rose-900">Sync Attention Needed</p>
                    <p className="mt-1 text-xs text-rose-800">Check alerts below.</p>
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-slate-900">{dataHealthSummary.syncStatus}</p>
                )}

                {dataHealthSummary.staleDatasetLabels.length > 0 && Object.keys(datasetSyncProgress).length === 0 ? (
                  <p className="mt-1 text-xs text-amber-800">
                    Stale: {dataHealthSummary.staleDatasetLabels.join(", ")}
                  </p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>

        {missingCoreDatasets.length > 0 ? (
          <Card className="border-amber-200 bg-amber-50/60">
            <CardHeader>
              <CardTitle className="text-base text-amber-900 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Missing Required Files
              </CardTitle>
              <CardDescription className="text-amber-800">
                Upload these files to get complete results:{" "}
                {missingCoreDatasets.map((key) => DATASET_DEFINITIONS[key].label).join(", ")}.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {Object.keys(lastDbErrors).length > 0 ? (
          <Card className="border-rose-300 bg-rose-50/80">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-rose-900 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Cloud DB persistence failed
              </CardTitle>
              <CardDescription className="text-rose-800">
                The CSV blob saved to cloud storage but the row-table write failed. Until this clears the dataset will not appear in server-side aggregates and Cloud Verified will stay false. Click Force Cloud Sync on the dataset card to retry.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="space-y-1.5 text-sm">
                {(Object.entries(lastDbErrors) as Array<[
                  DatasetKey,
                  { message: string; at: number },
                ]>)
                  .sort((a, b) => b[1].at - a[1].at)
                  .map(([key, info]) => (
                    <li key={key} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                      <span className="font-medium text-rose-900">
                        {DATASET_DEFINITIONS[key].label}:
                      </span>
                      <span className="font-mono text-xs text-rose-800 break-all">
                        {info.message.length > 200
                          ? `${info.message.slice(0, 200)}…`
                          : info.message}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-rose-900 hover:bg-rose-100"
                        onClick={() => {
                          setLastDbErrors((previous) => {
                            if (!previous[key]) return previous;
                            const next = { ...previous };
                            delete next[key];
                            return next;
                          });
                        }}
                      >
                        Dismiss
                      </Button>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {Object.keys(syncJobIssues).length > 0 ? (
          <Card className="border-amber-300 bg-amber-50/80">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-amber-900 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Row-table sync needs attention
              </CardTitle>
              <CardDescription className="text-amber-800">
                The chunked-CSV blob is in cloud storage but the row-table population either failed or stopped reporting after 10 minutes. Until this clears, server-side aggregates (DeliveryTracker, Trends, etc.) will use stale rows.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="space-y-1.5 text-sm">
                {(Object.entries(syncJobIssues) as Array<[
                  DatasetKey,
                  { kind: "timeout" | "failed"; jobId: string; message?: string; at: number },
                ]>)
                  .sort((a, b) => b[1].at - a[1].at)
                  .map(([key, info]) => (
                    <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-amber-900">
                        {DATASET_DEFINITIONS[key].label}:
                      </span>
                      <span className="text-xs text-amber-800">
                        {info.kind === "timeout"
                          ? "Polling stopped after 10 min — job may still be running."
                          : `Sync failed: ${(info.message ?? "").slice(0, 200)}`}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          activeCoreDatasetSyncJobRef.current[key] = info.jobId;
                          setSyncJobIssues((previous) => {
                            if (!previous[key]) return previous;
                            const next = { ...previous };
                            delete next[key];
                            return next;
                          });
                          void pollCoreDatasetSyncJob(key, info.jobId);
                        }}
                      >
                        Resume polling
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-amber-900 hover:bg-amber-100"
                        onClick={() => {
                          setSyncJobIssues((previous) => {
                            if (!previous[key]) return previous;
                            const next = { ...previous };
                            delete next[key];
                            return next;
                          });
                        }}
                      >
                        Dismiss
                      </Button>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {storageNotice ? (
          <Card className="border-rose-200 bg-rose-50/70">
            <CardHeader>
              <CardTitle className="text-base text-rose-900">Storage Notice</CardTitle>
              <CardDescription className="text-rose-800">{storageNotice}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <Tabs value={activeTab} onValueChange={handleActiveTabChange}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 overflow-visible whitespace-normal p-0">
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="overview">Overview</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="size">Size + Reporting</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="value">REC Value</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="contracts">Utility Contracts</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="annual-review">Annual REC Review</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="performance-eval">REC Performance Eval</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="change-ownership">Change of Ownership</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="ownership">Ownership Status</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="offline-monitoring">Offline by Monitoring</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="meter-reads">Meter Reads</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="performance-ratio">Performance Ratio</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="snapshot-log">Snapshot Log</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="app-pipeline">Application Pipeline</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="trends">Trends</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="forecast">Forecast</TabsTrigger>
            {/* The (count) suffix used to come from a parent-level
                `alertSummary.total`, but the alerts memo was gated by
                isAlertsTabActive so the count was always 0 unless you
                were already on the tab. AlertsTab now owns that state. */}
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="alerts">
              Alerts
            </TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="comparisons">Comparisons</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="financials">Financials</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="data-quality">Data Quality</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="delivery-tracker">Delivery Tracker</TabsTrigger>
          </TabsList>

          {visitedTabsRef.current.has("overview") && (
            <div style={{ display: activeTab === "overview" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading overview tab...</div>}>
                <OverviewTabLazy
                  summary={summary}
                  financialProfitData={financialProfitData}
                  changeOwnershipSummary={changeOwnershipSummary}
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                  sizeBreakdownRows={sizeBreakdownRows}
                  part2VerifiedAbpRows={part2VerifiedAbpRows}
                  systems={systems}
                  onDownloadOwnershipTile={downloadOwnershipCountTileCsv}
                  onDownloadChangeOwnershipTile={downloadChangeOwnershipCountTileCsv}
                  onJumpToOfflineMonitoring={() => handleActiveTabChange("offline-monitoring")}
                />
              </Suspense>
            </div>
          )}
          {visitedTabsRef.current.has("size") && (
            <div style={{ display: activeTab === "size" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading size tab...</div>}>
                <SizeReportingTabLazy
                  sizeBreakdownRows={sizeBreakdownRows}
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("value") && (
            <div style={{ display: activeTab === "value" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading REC value tab...</div>}>
                <RecValueTabLazy
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                  snapshotPart2ValueSummary={snapshotPart2ValueSummary}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("contracts") && (
            <div style={{ display: activeTab === "contracts" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading utility contracts tab...</div>}>
                <ContractsTabLazy isActive={activeTab === "contracts"} />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("annual-review") && (
            <div style={{ display: activeTab === "annual-review" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading annual REC review tab...</div>}>
                <AnnualReviewTabLazy isActive={activeTab === "annual-review"} />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("performance-eval") && (
            <div style={{ display: activeTab === "performance-eval" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading REC performance evaluation tab...</div>}>
                <RecPerformanceEvaluationTabLazy
                  performanceSourceRows={performanceSourceRows}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("change-ownership") && (
            <div style={{ display: activeTab === "change-ownership" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading change of ownership tab...</div>}>
                <ChangeOwnershipTabLazy
                  changeOwnershipRows={changeOwnershipRows}
                  changeOwnershipSummary={changeOwnershipSummary}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("ownership") && (
            <div style={{ display: activeTab === "ownership" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading ownership tab...</div>}>
                <OwnershipTabLazy
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("offline-monitoring") && (
            <div style={{ display: activeTab === "offline-monitoring" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading offline monitoring tab...</div>}>
                <OfflineMonitoringTabLazy
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                  abpEligibleTrackingIdsStrict={abpEligibleTrackingIdsStrict}
                  abpApplicationIdBySystemKey={abpApplicationIdBySystemKey}
                  monitoringDetailsBySystemKey={monitoringDetailsBySystemKey}
                  jumpToSection={jumpToSection}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("meter-reads") && (
            <div style={{ display: activeTab === "meter-reads" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading meter reads tab...</div>}>
                <MeterReadsTabLazy />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("performance-ratio") && (
            <div style={{ display: activeTab === "performance-ratio" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading performance ratio tab...</div>}>
                <PerformanceRatioTabLazy
                  convertedReads={datasets.convertedReads ?? null}
                  annualProductionEstimates={datasets.annualProductionEstimates ?? null}
                  generatorDetails={datasets.generatorDetails ?? null}
                  convertedReadsLabel={DATASET_DEFINITIONS.convertedReads.label}
                  annualProductionEstimatesLabel={DATASET_DEFINITIONS.annualProductionEstimates.label}
                  part2EligibleSystemsForSizeReporting={part2EligibleSystemsForSizeReporting}
                  monitoringDetailsBySystemKey={monitoringDetailsBySystemKey}
                  abpAcSizeKwByApplicationId={abpAcSizeKwByApplicationId}
                  abpPart2VerificationDateByApplicationId={abpPart2VerificationDateByApplicationId}
                  abpAcSizeKwBySystemKey={abpAcSizeKwBySystemKey}
                  annualProductionByTrackingId={annualProductionByTrackingId}
                  generationBaselineByTrackingId={generationBaselineByTrackingId}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("snapshot-log") && (
            <div style={{ display: activeTab === "snapshot-log" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading snapshot log tab...</div>}>
                <SnapshotLogTabLazy
                  logEntries={logEntries}
                  recPerformanceSnapshotContracts2025={recPerformanceSnapshotContracts2025}
                  cooNotTransferredNotReportingCurrentCount={cooNotTransferredNotReportingCurrentCount}
                  onCreateLogEntry={createLogEntry}
                  onClearLogs={clearLogs}
                  onDeleteLogEntry={deleteLogEntry}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("app-pipeline") && (
            <div style={{ display: activeTab === "app-pipeline" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading app pipeline tab...</div>}>
                <AppPipelineTabLazy
                  localOverrides={localOverrides}
                  financialCsgIdCount={financialCsgIds.length}
                  isActive={activeTab === "app-pipeline"}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("trends") && (
            <div style={{ display: activeTab === "trends" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading trends tab...</div>}>
                <TrendsTabLazy
                  logEntries={logEntries}
                  isActive={activeTab === "trends"}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("forecast") && (
            <div style={{ display: activeTab === "forecast" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading forecast tab...</div>}>
                <ForecastTabLazy
                  performanceSourceRows={performanceSourceRows}
                  systems={systems}
                  annualProductionByTrackingId={annualProductionByTrackingId}
                  generationBaselineByTrackingId={generationBaselineByTrackingId}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("alerts") && (
            <div style={{ display: activeTab === "alerts" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading alerts tab...</div>}>
                <AlertsTabLazy
                  systems={systems}
                  datasets={datasets}
                  isActive={activeTab === "alerts"}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("comparisons") && (
            <div style={{ display: activeTab === "comparisons" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading comparisons tab...</div>}>
                <ComparisonsTabLazy systems={systems} />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("financials") && (
            <div style={{ display: activeTab === "financials" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading financials tab...</div>}>
                <FinancialsTabLazy
                  systems={systems}
                  part2VerifiedAbpRows={part2VerifiedAbpRows}
                  financialProfitData={financialProfitData}
                  contractScanResults={contractScanResultsQuery.data ?? []}
                  contractScanStatus={contractScanResultsQuery.status}
                  contractScanIsFetching={contractScanResultsQuery.isFetching}
                  contractScanError={contractScanResultsQuery.error}
                  contractScanRefetch={contractScanResultsQuery.refetch}
                  financialCsgIds={financialCsgIds}
                  abpCsgSystemMapping={datasets.abpCsgSystemMapping ?? null}
                  abpIccReport3Rows={datasets.abpIccReport3Rows ?? null}
                  localOverrides={localOverrides}
                  setLocalOverrides={setLocalOverrides}
                  onSelectSystem={setSelectedSystemKey}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("data-quality") && (
            <div style={{ display: activeTab === "data-quality" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading data quality tab...</div>}>
                <DataQualityTabLazy
                  datasets={datasets}
                  datasetSummariesByKey={datasetSummariesByKey}
                  isActive={activeTab === "data-quality"}
                />
              </Suspense>
            </div>
          )}

          {visitedTabsRef.current.has("delivery-tracker") && (
            <div style={{ display: activeTab === "delivery-tracker" ? "contents" : "none" }}>
              <Suspense fallback={<div className="mt-4 text-sm text-slate-500">Loading delivery tracker tab...</div>}>
                <DeliveryTrackerTabLazy
                  deliveryTrackerData={deliveryTrackerData}
                  scheduleBImportSlot={
                  <>
                    {/* ── Schedule B PDF Import ────────────────────────── */}
                    <ScheduleBImport
                      transferDeliveryLookup={transferDeliveryLookup}
                      existingDeliverySchedule={datasets.deliveryScheduleBase?.rows ?? null}
                      onClearAppliedSchedule={() => {
                        // Phase 1a follow-up: Clear on the Schedule B card wipes
                        // the applied deliveryScheduleBase dataset so the tracker
                        // starts fresh. Also reset the stale signature ref so
                        // the next apply always fires a genuine cloud sync.
                        delete remoteDatasetSignatureRef.current.deliveryScheduleBase;
                        clearDataset("deliveryScheduleBase");
                      }}
                      // apply-track-v1 + contract-id-mapping-v1: after a
                      // server-side apply or mapping mutation lands, reload
                      // deliveryScheduleBase from the cloud so local state
                      // mirrors the server's post-apply truth. This eliminates
                      // the "Dataset has: N stays flat" bug caused by the
                      // client doing an independent parallel merge (see the
                      // deprecated onApply handler below).
                      //
                      // Hardening pass 2026-04-11: previously this had silent
                      // console.warn bail-outs on "no payload" and "null
                      // deserialize" that left the user staring at stale data
                      // with no error indication. Now every bail-out surfaces a
                      // toast, logs enough shape info to diagnose, AND falls
                      // back to the source-manifest path if the flat-payload
                      // deserializer can't handle what the server wrote.
                      onApplyComplete={async () => {
                        try {
                          const response = await getRemoteDatasetRef.current
                            .mutateAsync({ key: "deliveryScheduleBase" })
                            .catch((fetchErr) => {
                              console.error(
                                "[onApplyComplete] getRemoteDataset threw",
                                fetchErr
                              );
                              return null;
                            });
                          if (!response?.payload) {
                            toast.error(
                              "Apply landed on the server but the cloud reload returned no payload. Refresh the page if the Delivery Tracker doesn't update."
                            );
                            console.error(
                              "[onApplyComplete] getRemoteDataset returned no payload; leaving local state untouched"
                            );
                            return;
                          }

                          // Primary path: flat {fileName,uploadedAt,headers,csvText}
                          // shape (what applyScheduleBToDeliveryObligations and
                          // applyScheduleBContractIdMapping both write).
                          let loaded = deserializeRemoteDatasetPayload(
                            response.payload
                          );

                          // Fallback path: source-manifest shape. If the cloud
                          // has an older {_rawSourcesV1: true, sources: [...]}
                          // payload (from a pre-apply-track-v1 era), resolve
                          // the latest source's storageKey and parse that.
                          // Mirrors the main rehydration path in
                          // loadRemoteDatasets at ~line 7167.
                          if (!loaded) {
                            const sourceManifest = parseRemoteSourceManifestPayload(
                              response.payload
                            );
                            if (sourceManifest && sourceManifest.sources.length > 0) {
                              try {
                                const latest =
                                  sourceManifest.sources[
                                    sourceManifest.sources.length - 1
                                  ];
                                const sourceResponse =
                                  await getRemoteDatasetRef.current
                                    .mutateAsync({ key: latest.storageKey })
                                    .catch(() => null);
                                if (sourceResponse?.payload) {
                                  const decoded =
                                    latest.encoding === "base64"
                                      ? new TextDecoder().decode(
                                          base64ToBytes(sourceResponse.payload)
                                        )
                                      : sourceResponse.payload;
                                  const parsedCsv = await parseCsvTextAsync(decoded);
                                  loaded = {
                                    fileName: latest.fileName || "Schedule B Import",
                                    uploadedAt: new Date(latest.uploadedAt),
                                    headers: parsedCsv.headers,
                                    rows: parsedCsv.rows,
                                    rowCount: parsedCsv.rows.length,
                                  };
                                }
                              } catch (manifestErr) {
                                console.error(
                                  "[onApplyComplete] source-manifest fallback failed",
                                  manifestErr
                                );
                              }
                            }
                          }

                          if (!loaded) {
                            // Still null — log the payload shape prefix so we
                            // can diagnose from the browser console without
                            // another deploy round-trip.
                            const preview = response.payload.slice(0, 200);
                            toast.error(
                              "Apply landed on the server but the local dataset couldn't be refreshed. Open DevTools console for details, or refresh the page."
                            );
                            console.error(
                              "[onApplyComplete] deserializeRemoteDatasetPayload and source-manifest fallback both returned null. Payload preview:",
                              preview
                            );
                            return;
                          }

                          setDatasets((prev) => ({
                            ...prev,
                            deliveryScheduleBase: loaded,
                          }));
                          // Sync the signature ref to match the freshly loaded
                          // dataset so the sync effect at ~line 7565 doesn't
                          // immediately re-upload the same payload (would be a
                          // harmless redundant round-trip, but still wasteful).
                          remoteDatasetSignatureRef.current.deliveryScheduleBase = `${loaded.fileName}|${loaded.uploadedAt.toISOString()}|${loaded.rows.length}|${loaded.sources?.length ?? 0}`;
                          setDatasetCloudSyncStatus((prev) => ({
                            ...prev,
                            deliveryScheduleBase: "synced",
                          }));
                          console.log(
                            `[onApplyComplete] reloaded deliveryScheduleBase: ${loaded.rows.length} rows, uploadedAt=${loaded.uploadedAt.toISOString()}`
                          );
                        } catch (err) {
                          console.error(
                            "[onApplyComplete] failed to reload deliveryScheduleBase",
                            err
                          );
                          toast.error(
                            err instanceof Error
                              ? `Cloud reload failed: ${err.message}`
                              : "Cloud reload failed"
                          );
                        }
                      }}
                      // @deprecated apply-track-v1: the parallel client-side
                      // merge below is superseded by onApplyComplete's cloud
                      // reload. Kept for backward compatibility during rollout;
                      // delete in a follow-up after verifying prod behavior.
                      onApply={(rows) => {
                        const makeDeliveryRowKey = (row: CsvRow, fallbackPrefix: string, index: number) => {
                          const trackingId = clean(row.tracking_system_ref_id).toUpperCase();
                          if (trackingId) return `tracking:${trackingId}`;
                          const designatedSystemId = clean(row.designated_system_id);
                          if (designatedSystemId) return `designated:${designatedSystemId}`;
                          const systemName = clean(row.system_name).toLowerCase();
                          if (systemName) return `name:${systemName}`;
                          return `${fallbackPrefix}:${index}`;
                        };

                        // Persistence fix (Phase 0, Bug 4): clear any stale sync
                        // signature so the cloud-sync effect at ~line 8438 treats the
                        // new dataset as a genuine change regardless of whether the
                        // previous signature was raw:... (manifest era) or
                        // local-only:... (silent-drop branch).
                        delete remoteDatasetSignatureRef.current.deliveryScheduleBase;

                        const beforeRowCount = datasets.deliveryScheduleBase?.rows.length ?? 0;

                        setDatasets((prev) => {
                          const existingRows = prev.deliveryScheduleBase?.rows ?? [];
                          const mergedByKey = new Map<string, CsvRow>();
                          const orderedKeys: string[] = [];

                          existingRows.forEach((row, index) => {
                            const key = makeDeliveryRowKey(row, "existing", index);
                            if (mergedByKey.has(key)) return;
                            mergedByKey.set(key, row);
                            orderedKeys.push(key);
                          });

                          let incomingNewCount = 0;
                          let incomingMergedCount = 0;
                          rows.forEach((row, index) => {
                            const key = makeDeliveryRowKey(row, "scheduleb", index);
                            const existing = mergedByKey.get(key);
                            if (existing) {
                              mergedByKey.set(key, { ...existing, ...row });
                              incomingMergedCount += 1;
                              return;
                            }
                            mergedByKey.set(key, row);
                            orderedKeys.push(key);
                            incomingNewCount += 1;
                          });

                          const mergedRows = orderedKeys
                            .map((key) => mergedByKey.get(key))
                            .filter((row): row is CsvRow => Boolean(row));

                          const mergedHeaders: string[] = [];
                          const pushHeader = (header: string) => {
                            if (!header || mergedHeaders.includes(header)) return;
                            mergedHeaders.push(header);
                          };
                          (prev.deliveryScheduleBase?.headers ?? []).forEach(pushHeader);
                          rows.flatMap((row) => Object.keys(row)).forEach(pushHeader);
                          mergedRows.flatMap((row) => Object.keys(row)).forEach(pushHeader);

                          // Diagnostic toast so the user can see exactly what
                          // happened: rows received, new vs. merged-into-existing,
                          // dataset size before/after. Without this the UX is
                          // opaque when "Apply says success but tracker count
                          // doesn't change" (usually because the new rows all
                          // collided with existing tracking IDs).
                          toast.info(
                            `Apply: ${rows.length} incoming (${incomingNewCount} new, ${incomingMergedCount} merged). Dataset ${beforeRowCount} → ${mergedRows.length} rows.`,
                            { duration: 8000 }
                          );

                          return {
                            ...prev,
                            deliveryScheduleBase: {
                              fileName: prev.deliveryScheduleBase?.fileName ?? "Schedule B Import",
                              uploadedAt: new Date(),
                              headers: mergedHeaders,
                              rows: mergedRows,
                              rowCount: mergedRows.length,
                            },
                          };
                        });
                        // Phase 0 persistence fix: do NOT wipe the source manifest.
                        // A synthesized (merged) dataset was never backed by a
                        // manifest, so setting it to undefined just poisons the
                        // sync path — it forced the inline-serialize branch to
                        // recompute from a stale signature. Leave it alone and let
                        // the dataset sync effect take the normal synth path.
                        setDatasetCloudSyncBadge("deliveryScheduleBase", "pending");
                        setForceSyncingDatasets((prev) => ({ ...prev, deliveryScheduleBase: false }));
                        forcedRemoteDatasetSyncKeysRef.current.delete("deliveryScheduleBase");
                      }}
                    />
                  </>
                }
              />
              </Suspense>
            </div>
          )}
          {/* AI Data Assistant — shared across all tabs */}
          <div className="mt-4">
            <Suspense fallback={null}>
              <TabAIChatLazy
                tabId={activeTab}
                dataContext={aiDataContext}
                isActive={true}
              />
            </Suspense>
          </div>
        </Tabs>

        <Card className="border-slate-200">
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">Step 1: Import Your CSV Files</CardTitle>
                <CardDescription className="mt-1">
                  Upload each export into its matching slot. Files can be replaced later with newer exports. Account
                  Solar Generation and Converted Reads support multi-file append for building longer history.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setUploadsExpanded((current) => !current)}>
                {uploadsExpanded ? "Hide Upload Slots" : "Show Upload Slots"}
                {uploadsExpanded ? (
                  <ChevronUp className="ml-2 h-4 w-4" />
                ) : (
                  <ChevronDown className="ml-2 h-4 w-4" />
                )}
              </Button>
              {localOnlyDatasetCount > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={migratingLocalOnlyDatasets}
                  onClick={() => void migrateAllLocalOnlyDatasets()}
                >
                  {migratingLocalOnlyDatasets
                    ? "Migrating..."
                    : `Migrate ${formatNumber(localOnlyDatasetCount)} Local-only`}
                </Button>
              ) : null}
            </div>
          </CardHeader>
          {uploadsExpanded ? (
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).map((key) => {
                const config = DATASET_DEFINITIONS[key];
                const dataset = datasets[key];
                const manifestEntry = mergedRemoteDatasetManifest[key];
                const error = uploadErrors[key];
                const hydrationError = hydrationErrors[key];
                const isMultiAppend = MULTI_APPEND_DATASET_KEYS.has(key);
                const isScannerManaged = SCANNER_MANAGED_DATASET_KEYS.has(key);
                const serverCloudStatus = serverDatasetCloudStatusByKey[key];
                const hasCloudBackfillMarker = Boolean(
                  dataset &&
                    (dataset.fileName.toLowerCase().includes("cloud-backfill") ||
                      dataset.sources?.some((source) => source.fileName.toLowerCase().includes("cloud-backfill")))
                );
                const syncProgress = datasetSyncProgress[key];
                const overrideCloudStatus = datasetCloudSyncStatus[key];
                let cloudStatusForDataset: DatasetCloudSyncStatus | undefined = overrideCloudStatus;
                if (!cloudStatusForDataset && !localOnlyDatasets[key]) {
                  if (serverCloudStatus?.recoverable) {
                    // Server's recoverable flag is the source of truth.
                    // Upload flows set overrideCloudStatus = "pending"
                    // via setDatasetCloudSyncBadge so in-flight syncs
                    // still show amber; see the effect that clears the
                    // override when the server catches up.
                    cloudStatusForDataset = "synced";
                  } else if (dataset || manifestEntry || hasCloudBackfillMarker) {
                    cloudStatusForDataset = "not-synced";
                  }
                }

                return (
                  <div key={key} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-slate-900">{config.label}</p>
                      <p className="text-xs text-slate-600">{config.description}</p>
                    </div>

                    {dataset ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800">
                            {/*
                              Task 5.14 PR-3: read the scalar
                              `dataset.rowCount` (PR-1) instead of
                              `dataset.rows.length`. The latter would
                              trip the lazy `.rows` getter and walk
                              the columnar source into a full
                              CsvRow[] just to call `.length` on it
                              — wasteful on every Step 1 render.
                              `rowCount` is set at construction time
                              by `buildLazyCsvDataset` and matches
                              `rows.length` exactly.
                            */}
                            {dataset.rowCount} rows loaded
                          </Badge>
                          {localOnlyDatasets[key] ? (
                            <Badge className="border-amber-200 bg-amber-100 text-amber-900">
                              Local-only sync
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "pending" ? (
                            <Badge className="border-blue-200 bg-blue-100 text-blue-900">
                              Cloud sync pending
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "synced" ? (
                            <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800">
                              Cloud verified
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "failed" ? (
                            <Badge className="border-rose-200 bg-rose-100 text-rose-800">
                              Cloud sync failed
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "not-synced" ? (
                            <Badge className="border-amber-200 bg-amber-100 text-amber-900">
                              Not synced to cloud
                            </Badge>
                          ) : null}
                          {forceSyncingDatasets[key] ? (
                            <Badge className="border-blue-200 bg-blue-100 text-blue-900">
                              Forcing cloud sync...
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-slate-600">{dataset.fileName}</p>
                        {isMultiAppend && dataset.sources && dataset.sources.length > 0 ? (
                          <p className="text-xs text-slate-500">{formatNumber(dataset.sources.length)} files appended</p>
                        ) : null}
                        <p className="text-xs text-slate-500">Last updated {dataset.uploadedAt.toLocaleString()}</p>
                        {isMultiAppend && dataset.sources && dataset.sources.length > 0 ? (
                          <div className="max-h-24 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
                            {dataset.sources
                              .slice()
                              .reverse()
                              .slice(0, 8)
                              .map((source) => (
                                <p
                                  key={`${source.fileName}-${source.uploadedAt.toISOString()}`}
                                  className="text-xs text-slate-600"
                                >
                                  {source.fileName} ({formatNumber(source.rowCount)} rows)
                                </p>
                              ))}
                          </div>
                        ) : null}
                      </div>
                    ) : manifestEntry ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="border-slate-200 bg-slate-100 text-slate-700">
                            {manifestEntry.rowCount} rows saved
                          </Badge>
                          {cloudStatusForDataset === "pending" ? (
                            <Badge className="border-blue-200 bg-blue-100 text-blue-900">
                              Cloud sync pending
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "synced" ? (
                            <Badge className="border-amber-200 bg-amber-100 text-amber-900">
                              In cloud · tap tab to load
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "failed" ? (
                            <Badge className="border-rose-200 bg-rose-100 text-rose-800">
                              Cloud sync failed
                            </Badge>
                          ) : null}
                          {cloudStatusForDataset === "not-synced" ? (
                            <Badge className="border-amber-200 bg-amber-100 text-amber-900">
                              Not synced to cloud
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-slate-600">
                          {manifestEntry.fileName}
                        </p>
                        <p className="text-xs text-slate-500">
                          Last updated {new Date(manifestEntry.uploadedAt).toLocaleString()}
                        </p>
                        <p className="text-xs text-slate-500">
                          Full rows reload when this dataset's tab is opened.
                        </p>
                      </div>
                    ) : serverCloudStatus?.recoverable ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="border-amber-200 bg-amber-100 text-amber-900">
                            In cloud · tap tab to load
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-500">
                          Saved in cloud. Full rows reload when this dataset's tab is opened.
                        </p>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-slate-600">
                        Not uploaded
                      </Badge>
                    )}

                    {syncProgress ? (
                      <div className="space-y-1.5 rounded-md border border-sky-200 bg-sky-50/70 px-3 py-2">
                        <div className="flex items-center justify-between gap-3 text-xs text-sky-900">
                          <span className="font-medium">{syncProgress.message}</span>
                          <span>{formatNumber(syncProgress.percent, 0)}%</span>
                        </div>
                        <Progress value={syncProgress.percent} className="h-2 bg-sky-100" />
                        {formatSyncProgressUnits(syncProgress) ? (
                          <p className="text-[11px] text-sky-900/80">
                            {formatSyncProgressUnits(syncProgress)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {error ? <p className="text-xs text-rose-700">{error}</p> : null}
                    {hydrationError ? (
                      <p className="text-xs text-rose-700">
                        Hydration failed: {hydrationError}
                      </p>
                    ) : null}

                    {isScannerManaged ? (
                      <div className="space-y-2">
                        <p className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                          Populated by the Schedule B PDF scanner on the <strong>Delivery Tracker</strong> tab.
                          Upload Schedule B PDFs there to (re)generate this dataset. Direct CSV upload is not
                          supported.
                        </p>
                        <div className="flex items-center gap-2">
                          {dataset ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm">Clear</Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Clear dataset?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will remove the local copy and queue a cloud-side delete. The dataset will need to be re-uploaded or re-scanned.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => clearDataset(key)}>Clear</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : null}
                          {dataset && localOnlyDatasets[key] ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={Boolean(forceSyncingDatasets[key])}
                              onClick={() => queueForceDatasetSync(key)}
                            >
                              {forceSyncingDatasets[key] ? "Forcing..." : "Force Cloud Sync"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                          <Upload className="h-4 w-4" />
                          {isMultiAppend ? "Add CSV(s)" : (TABULAR_DATASET_KEYS.has(key) ? "Choose File" : "Choose CSV")}
                          <input
                            type="file"
                            accept={TABULAR_DATASET_KEYS.has(key) ? ".csv,.xlsx,.xls,.xlsm,.xlsb,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ".csv,text/csv"}
                            className="hidden"
                            multiple={isMultiAppend}
                            onChange={(event) => {
                              if (isMultiAppend) {
                                const files = Array.from(event.target.files ?? []);
                                void handleMultiCsvUploads(key, files);
                                event.currentTarget.value = "";
                                return;
                              }

                              const file = event.target.files?.[0] ?? null;
                              void handleUpload(key, file, "replace");
                              event.currentTarget.value = "";
                            }}
                          />
                        </label>
                        {/* Phase 3 of the IndexedDB-removal refactor:
                            ONE dataset has a server-side parser
                            wired (`contractedDate`). Show the v2
                            button alongside the legacy CTA so the
                            team can dogfood without losing the
                            fallback. Phase 4 expands to the rest;
                            Phase 5 removes the legacy affordance. */}
                        {IMPLEMENTED_V2_DATASETS.has(key) ? (
                          <DatasetUploadV2Button
                            datasetKey={key}
                            label="Upload (v2)"
                            variant="secondary"
                            onSuccess={() => {
                              // Refresh every server-side query
                              // that reads from this dataset. Per
                              // CLAUDE.md "Solar REC Dashboard data
                              // flow", the server is the source of
                              // truth — invalidating these queries
                              // pulls fresh counts + snapshot in
                              // automatically.
                              // `getDataset` is a mutation (the
                              // chunked-CSV reader) so it isn't
                              // invalidatable; the queries below
                              // are what the dashboard actually
                              // reads to hydrate row counts +
                              // system records.
                              void solarRecTrpcUtils.solarRecDashboard.getDatasetSummariesAll.invalidate();
                              void solarRecTrpcUtils.solarRecDashboard.getSystemSnapshot.invalidate();
                              void solarRecTrpcUtils.solarRecDashboard.getDatasetCloudStatuses.invalidate();
                              void solarRecTrpcUtils.solarRecDashboard.listDatasetUploadJobs.invalidate();
                            }}
                          />
                        ) : null}
                        {dataset ? (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm">Remove</Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove dataset?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will remove the local copy and queue a cloud-side delete. You will need to re-upload a CSV to restore it.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => clearDataset(key)}>Remove</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ) : null}
                        {dataset && localOnlyDatasets[key] ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(forceSyncingDatasets[key])}
                            onClick={() => queueForceDatasetSync(key)}
                          >
                            {forceSyncingDatasets[key] ? "Forcing..." : "Force Cloud Sync"}
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          ) : (
            <CardContent className="pt-0">
              <p className="text-sm text-slate-600">
                Upload slots are collapsed to keep analytics front-and-center. Use “Show Upload Slots” when you need
                to import or replace files.
              </p>
            </CardContent>
          )}
        </Card>

        {/* ── System Detail Sheet ───────────────────────────────────── */}
        {/* The sheet component itself is lazy-loaded — it's an
            infrequently-used side panel, so there's no reason to
            eager-load ~12 KB of sheet/table markup on first page
            paint. Parent retains the selectedSystemKey state
            because any tab can open the sheet. */}
        <Suspense fallback={null}>
          <SystemDetailSheetLazy
            selectedSystemKey={selectedSystemKey}
            onClose={() => setSelectedSystemKey(null)}
            systems={systems}
            convertedReads={datasets.convertedReads ?? null}
          />
        </Suspense>
      </div>
    </div>
  );
}
