import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, Database, FileText, Loader2, Trash2, Upload } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";

const TabAIChatLazy = lazy(() =>
  import("@/components/dashboard/TabAIChat").then((m) => ({
    default: m.TabAIChat,
  }))
);
import {
  buildMeterReadDownloadFileName,
  convertMeterReadWorkbook,
  type MeterReadsConversionResult,
} from "@/lib/meterReads";
import { clean, formatCurrency, formatPercent } from "@/lib/helpers";
import { parseTabularFile } from "@/lib/csvParsing";
import {
  buildDeliveryTrackerData,
  EMPTY_DELIVERY_TRACKER_DATA,
} from "@/solar-rec-dashboard/lib/buildDeliveryTrackerData";
import {
  buildTransferDeliveryLookup,
  getDeliveredForYear,
  getDeliveredLifetime,
} from "@/solar-rec-dashboard/lib/transferHistoryDeliveries";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";
import {
  buildCsv,
  matchesExpectedHeaders,
  parseCsv,
  timestampForCsvFileName,
  toCsvFileSlug,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import { base64ToBytes, bytesToBase64 } from "@/solar-rec-dashboard/lib/binaryEncoding";
import { ScheduleBImport } from "@/solar-rec-dashboard/components/ScheduleBImport";

type DatasetKey =
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

type OwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Not Transferred and Reporting"
  | "Not Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting";

type ChangeOwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting"
  | "Change of Ownership - Not Transferred and Reporting"
  | "Change of Ownership - Not Transferred and Not Reporting";

type SizeBucket = "<=10 kW AC" | ">10 kW AC" | "Unknown";

type CsvDataset = {
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

type ContractDeliveryAggregate = {
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

type TransitionStatus = ChangeOwnershipStatus | "No COO Status";

type PipelineMonthRow = {
  month: string;        // "YYYY-MM"
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

type AnnualVintageAggregate = {
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

type AnnualContractVintageAggregate = {
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

type DashboardLogEntry = {
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

type SnapshotMetricRow =
  | {
      kind: "section";
      label: string;
      sectionTone: "slate" | "blue" | "emerald";
    }
  | {
      kind: "metric";
      label: string;
      value: (entry: DashboardLogEntry) => string;
      level?: 0 | 1;
      metricTone?: "default" | "neutral" | "warn";
    };

type ScheduleYearEntry = {
  yearIndex: number;
  required: number;
  delivered: number;
  startDate: Date | null;
  endDate: Date | null;
  startRaw: string;
  endRaw: string;
  key: string;
};

type PerformanceSourceRow = {
  key: string;
  contractId: string;
  systemId: string | null;
  trackingSystemRefId: string;
  systemName: string;
  batchId: string | null;
  recPrice: number | null;
  years: ScheduleYearEntry[];
};

type RecPerformanceResultRow = {
  key: string;
  applicationId: string;
  unitId: string;
  batchId: string;
  systemName: string;
  contractId: string;
  scheduleYearNumber: number; // Which year in the schedule DY3 corresponds to (1-15)
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

type RecPerformanceContractYearSummaryRow = {
  contractId: string;
  systemsInThreeYearReview: number;
  totalRecDeliveryObligation: number;
  totalDeliveriesFromThreeYearReview: number;
  recDelta: number;
  totalDrawdownAmount: number;
};

type OfflineBreakdownRow = {
  key: string;
  label: string;
  totalSystems: number;
  offlineSystems: number;
  offlinePercent: number | null;
  offlineContractValue: number;
  totalContractValue: number;
  offlineContractValuePercent: number | null;
};

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

type SystemRecord = {
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

type MonitoringDetailsRecord = {
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

type OfflineMonitoringAccessFields = {
  accessType: string;
  monitoringSiteId: string;
  monitoringSiteName: string;
  monitoringLink: string;
  monitoringUsername: string;
  monitoringPassword: string;
};

type PerformanceRatioMatchType =
  | "Monitoring + System ID + System Name"
  | "Monitoring + System ID"
  | "Monitoring + System Name";

type PortalMonitoringCandidate = {
  key: string;
  system: SystemRecord;
  monitoringTokens: string[];
  idTokens: string[];
  nameTokens: string[];
};

type ConvertedReadInputRow = {
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

type GenerationBaseline = {
  valueWh: number | null;
  date: Date | null;
  source: "Generation Entry" | "Account Solar Generation";
};

type AnnualProductionProfile = {
  trackingSystemRefId: string;
  facilityName: string;
  monthlyKwh: number[];
};

type PerformanceRatioRow = {
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

type CompliantSourceEvidence = {
  id: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  objectUrl: string;
  uploadedAt: Date;
};

type CompliantSourceEntry = {
  portalId: string;
  compliantSource: string;
  updatedAt: Date;
  evidence: CompliantSourceEvidence[];
};

type CompliantSourceTableRow = {
  portalId: string;
  compliantSource: string;
  updatedAt: Date | null;
  evidence: CompliantSourceEvidence[];
  sourceType: "Manual" | "Auto";
};

type CompliantPerformanceRatioRow = PerformanceRatioRow & {
  compliantSource: string | null;
  evidenceCount: number;
  meterReadMonthYear: string;
  readWindowMonthYear: string;
};

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

const OWNERSHIP_ORDER: OwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Not Transferred and Reporting",
  "Not Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
];

const CHANGE_OWNERSHIP_ORDER: ChangeOwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
];

const COO_TARGET_STATUS: ChangeOwnershipStatus = "Change of Ownership - Not Transferred and Not Reporting";
const NO_COO_STATUS = "No COO Status";
const TEN_KW_COMPLIANT_SOURCE = "10kW AC or Less";
const AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY: Record<string, string> = {
  enphase: "Enphase",
  alsoenergy: "AlsoEnergy",
  "solar log": "Solar-Log",
  "sdsi arraymeter": "SDSI Arraymeter",
  "locus energy": "Locus Energy",
  "vision metering": "Vision Metering",
  sensergm: "SenseRGM",
  "ekm encompass io": "EKM Encompass.io",
};

const LEGACY_DATASETS_STORAGE_KEY = "solarRecDashboardDatasetsV1";
const LOGS_STORAGE_KEY = "solarRecDashboardLogsV1";
const DASHBOARD_DB_NAME = "solarRecDashboardDb";
const DASHBOARD_DB_VERSION = 2;
const DASHBOARD_DATASETS_STORE = "datasets";
const DASHBOARD_DATASETS_RECORD_KEY = "activeDatasets";
const DASHBOARD_DATASETS_MANIFEST_KEY = "__dataset_manifest_v2__";
const DASHBOARD_LOGS_RECORD_KEY = "__snapshot_logs_v2__";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_SITE_LIST_PAGE_SIZE = 10;
const PERFORMANCE_RATIO_PAGE_SIZE = 10;
const COMPLIANT_SOURCE_PAGE_SIZE = 10;
const COMPLIANT_REPORT_PAGE_SIZE = 10;
const REC_VALUE_PAGE_SIZE = 50;
const SNAPSHOT_CONTRACT_PAGE_SIZE = 25;
const CONTRACT_SUMMARY_PAGE_SIZE = 50;
const CONTRACT_DETAIL_PAGE_SIZE = 50;
const ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE = 50;
const ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE = 50;
const REC_PERFORMANCE_RESULTS_PAGE_SIZE = 50;
const OFFLINE_DETAIL_PAGE_SIZE = 50;
const SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL = "2025-2026";
const IL_ABP_TRANSFERRED_CONTRACT_TYPE = "il abp - transferred";
const IL_ABP_TERMINATED_CONTRACT_TYPE = "il abp - terminated";
const MAX_REMOTE_STATE_LOG_BYTES = 120_000;
const MAX_REMOTE_STATE_PAYLOAD_CHARS = 180_000;
const REMOTE_LOG_ENTRY_LIMIT = 40;
// Keep chunks comfortably below common API gateway body limits after JSON encoding overhead.
const REMOTE_DATASET_CHUNK_CHAR_LIMIT = 250_000;
const MAX_REMOTE_DATASET_SYNC_ESTIMATED_CHARS = 3_000_000;
const REMOTE_LOG_SYNC_MAX_CHUNKS = 120;
const MAX_LOCAL_LOG_STORAGE_CHARS = 250_000;
const REMOTE_DATASET_KEY_MANIFEST = "dataset_manifest_v1";
const REMOTE_SNAPSHOT_LOGS_KEY = "snapshot_logs_v1";
const MONTH_HEADERS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const COMPLIANT_SOURCE_STORAGE_KEY = "solarRecDashboardCompliantSourcesV1";
const MAX_COMPLIANT_SOURCE_CHARS = 100;
const MAX_COMPLIANT_FILE_BYTES = 12 * 1024 * 1024;
const MAX_SINGLE_CSV_UPLOAD_BYTES = 150 * 1024 * 1024;
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
const CORE_REQUIRED_DATASET_KEYS: DatasetKey[] = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
];
const STALE_UPLOAD_DAYS = 14;
const DASHBOARD_TAB_VALUES = [
  "overview",
  "size",
  "value",
  "contracts",
  "annual-review",
  "performance-eval",
  "change-ownership",
  "ownership",
  "offline-monitoring",
  "meter-reads",
  "performance-ratio",
  "snapshot-log",
  "app-pipeline",
  "trends",
  "forecast",
  "alerts",
  "comparisons",
  "financials",
  "data-quality",
  "delivery-tracker",
] as const;
type DashboardTabId = (typeof DASHBOARD_TAB_VALUES)[number];
const DEFAULT_DASHBOARD_TAB: DashboardTabId = "overview";
const DASHBOARD_TAB_VALUE_SET = new Set<string>(DASHBOARD_TAB_VALUES);

const GENERATION_BASELINE_VALUE_HEADERS = [
  "Last Meter Read (kWh)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Most Recent Production (kWh)",
  "Most Recent Production",
  "Generation (kWh)",
  "Production (kWh)",
];

const GENERATION_BASELINE_DATE_HEADERS = ["Last Meter Read Date", "Last Month of Gen", "Effective Date", "Month of Generation"];
const GENERATOR_DETAILS_AC_SIZE_HEADERS = [
  "AC Size (kW)",
  "AC Size kW",
  "System AC Size (kW)",
  "System Size (kW AC)",
  "Inverter Size (kW AC)",
  "Inverter Size kW AC",
  "Nameplate Capacity (kW)",
  "Nameplate Capacity kW",
  "Rated Capacity (kW)",
  "Capacity (kW)",
];

function resolvePart2ProjectIdentity(row: CsvRow, index: number) {
  const applicationId = clean(row.Application_ID) || clean(row.application_id);
  const portalSystemId = clean(row.system_id);
  const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
  const projectName = clean(row.Project_Name) || clean(row.system_name);
  const projectNameKey = projectName.toLowerCase();
  const dedupeKey = portalSystemId
    ? `system:${portalSystemId}`
    : trackingId
      ? `tracking:${trackingId}`
      : applicationId
        ? `application:${applicationId}`
        : projectName
          ? `name:${projectNameKey}`
          : `row:${index}`;

  return {
    applicationId,
    portalSystemId,
    trackingId,
    projectName,
    projectNameKey,
    dedupeKey,
  };
}

function isDashboardTabId(value: string): value is DashboardTabId {
  return DASHBOARD_TAB_VALUE_SET.has(value);
}

function getTabFromSearch(search: string): DashboardTabId | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  if (!tab || !isDashboardTabId(tab)) return null;
  return tab;
}

function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usDateTime = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
  );
  if (usDateTime) {
    const month = Number(usDateTime[1]) - 1;
    const day = Number(usDateTime[2]);
    const year = Number(usDateTime[3]) < 100 ? 2000 + Number(usDateTime[3]) : Number(usDateTime[3]);
    let hours = usDateTime[4] ? Number(usDateTime[4]) : 0;
    const minutes = usDateTime[5] ? Number(usDateTime[5]) : 0;
    const meridiem = usDateTime[6]?.toUpperCase();

    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    const date = new Date(year, month, day, hours, minutes);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function parsePart2VerificationDate(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw || raw.toLowerCase() === "null") return null;

  const excelSerial = raw.match(/^\d{5}(?:\.\d+)?$/);
  if (excelSerial) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial >= 20_000 && serial <= 80_000) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const utcDate = new Date(excelEpoch.getTime() + Math.round(serial * DAY_MS));
      const converted = new Date(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate());
      const year = converted.getFullYear();
      if (year >= 2009 && year <= 2100) return converted;
    }
    return null;
  }

  const looksLikeCalendarDate =
    /(?:19|20)\d{2}/.test(raw) &&
    (raw.includes("/") || raw.includes("-") || /[A-Za-z]{3,9}/.test(raw));
  if (!looksLikeCalendarDate) return null;

  const parsed = parseDate(raw);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  if (year < 2009 || year > 2100) return null;
  return parsed;
}

function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
}

function parseDateOnlineAsMidMonth(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const slashMonthYear = raw.match(/^(\d{1,2})[\/-](\d{4})$/);
  if (slashMonthYear) {
    const month = Number(slashMonthYear[1]) - 1;
    const year = Number(slashMonthYear[2]);
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoMonthYear = raw.match(/^(\d{4})[\/-](\d{1,2})$/);
  if (isoMonthYear) {
    const year = Number(isoMonthYear[1]);
    const month = Number(isoMonthYear[2]) - 1;
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = parseDate(raw);
  if (!parsed) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), 15);
}

function parseAbpAcSizeKw(row: CsvRow): number | null {
  // Strict rule: ABP AC size may only come from Inverter_Size_kW_AC_Part_2.
  return parseNumber(row.Inverter_Size_kW_AC_Part_2 || getCsvValueByHeader(row, "Inverter_Size_kW_AC_Part_2"));
}

function parseGeneratorDetailsAcSizeKw(row: CsvRow): number | null {
  for (const header of GENERATOR_DETAILS_AC_SIZE_HEADERS) {
    const parsed = parseNumber(row[header] || getCsvValueByHeader(row, header));
    if (parsed !== null) return parsed;
  }

  for (const [header, value] of Object.entries(row)) {
    const normalizedHeader = clean(header).toLowerCase();
    if (!normalizedHeader.includes("kw")) continue;
    if (normalizedHeader.includes("dc")) continue;
    if (
      normalizedHeader.includes("ac") ||
      normalizedHeader.includes("capacity") ||
      normalizedHeader.includes("nameplate") ||
      normalizedHeader.includes("inverter")
    ) {
      const parsed = parseNumber(value);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

function resolveLastMeterReadRawValue(row: CsvRow): string {
  const direct =
    clean(row["Last Meter Read (kWh)"]) ||
    clean(row["Last Meter Read (kW)"]) ||
    clean(row["Last Meter Read"]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = clean(key).toLowerCase();
    if (normalizedKey.includes("last meter read") && !normalizedKey.includes("date")) {
      const candidate = clean(value);
      if (candidate) return candidate;
    }
  }

  return "";
}

function resolveStateApplicationRefId(row: CsvRow): string | null {
  const exact = clean(row.state_certification_number);
  return exact || null;
}

function isValidCompliantSourceText(value: string): boolean {
  if (!value || value.length > MAX_COMPLIANT_SOURCE_CHARS) return false;
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return /^[A-Za-z0-9 _,-]+$/.test(value);
}

function getCsvValueByHeader(row: CsvRow, headerName: string): string {
  const target = clean(headerName).toLowerCase();
  for (const [header, value] of Object.entries(row)) {
    if (clean(header).toLowerCase() === target) return clean(value);
  }
  return "";
}

function parseEnergyToWh(value: string | undefined, headerLabel: string, defaultUnit: "kwh" | "wh" = "kwh"): number | null {
  const parsed = parseNumber(value);
  if (parsed === null) return null;
  const header = clean(headerLabel).toLowerCase();
  if (header.includes("mwh")) return Math.round(parsed * 1_000_000);
  if (header.includes("kwh")) return Math.round(parsed * 1_000);
  if (header.includes("wh")) return Math.round(parsed);
  if (defaultUnit === "kwh") return Math.round(parsed * 1_000);
  return Math.round(parsed);
}

function toStartOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function calculateExpectedWhForRange(monthlyKwh: number[], startDate: Date, endDate: Date): number | null {
  if (monthlyKwh.length !== 12) return null;
  const start = toStartOfDay(startDate);
  const end = toStartOfDay(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return 0;

  let cursor = start;
  let expectedWh = 0;

  while (cursor < end) {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const segmentEnd = monthEnd < end ? monthEnd : end;
    const dayCount = (segmentEnd.getTime() - cursor.getTime()) / DAY_MS;
    const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / DAY_MS;
    const monthlyValueKwh = monthlyKwh[cursor.getMonth()] ?? 0;
    expectedWh += (monthlyValueKwh * 1_000 * dayCount) / daysInMonth;
    cursor = segmentEnd;
  }

  return Number.isFinite(expectedWh) ? expectedWh : null;
}

function normalizeMonitoringMatch(value: string | null | undefined): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveMonitoringPlatformCompliantSource(value: string | null | undefined): string | null {
  const normalized = normalizeMonitoringMatch(value);
  if (!normalized) return null;
  return AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY[normalized] ?? null;
}

function getAutoCompliantSourcePriority(value: string): number {
  return value === TEN_KW_COMPLIANT_SOURCE ? 1 : 2;
}

function isTenKwAcOrLess(portalAcSizeKw: number | null, abpAcSizeKw: number | null): boolean {
  const hasAnySize = portalAcSizeKw !== null || abpAcSizeKw !== null;
  if (!hasAnySize) return false;
  const portalOk = portalAcSizeKw === null || portalAcSizeKw <= 10;
  const abpOk = abpAcSizeKw === null || abpAcSizeKw <= 10;
  return portalOk && abpOk;
}

function normalizeSystemIdMatch(value: string | null | undefined): string {
  const compact = clean(value).replaceAll(",", "").replace(/\s+/g, "");
  if (!compact) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(compact)) {
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) return String(Math.trunc(parsed));
  }
  return compact.toUpperCase();
}

function normalizeSystemNameMatch(value: string | null | undefined): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function splitRawCandidates(value: string): string[] {
  return clean(value)
    .split(/[|;,/\n\r]+/)
    .map((part) => clean(part))
    .filter(Boolean);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((value) => {
    const normalized = clean(value);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function maxDate(current: Date | null, candidate: Date | null): Date | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

function firstNonNull(...values: Array<number | null>): number | null {
  for (const value of values) {
    if (value !== null) return value;
  }
  return null;
}

function firstNonEmptyString(...values: string[]): string | null {
  for (const value of values) {
    if (clean(value)) return clean(value);
  }
  return null;
}

function resolveContractValueAmount(system: SystemRecord): number {
  return firstNonNull(system.totalContractAmount, system.contractedValue) ?? 0;
}

function resolveValueGapAmount(system: SystemRecord): number {
  return resolveContractValueAmount(system) - (system.deliveredValue ?? 0);
}

function normalizeContractType(value: string | null | undefined): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function isTransferredContractType(value: string | null | undefined): boolean {
  return normalizeContractType(value) === IL_ABP_TRANSFERRED_CONTRACT_TYPE;
}

function isTerminatedContractType(value: string | null | undefined): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

function normalizeMonitoringMethod(accessTypeRaw: string, entryMethodRaw: string, selfReportRaw: string): string {
  const accessType = clean(accessTypeRaw).toLowerCase();
  if (accessType === "granted") return "Granted Access";
  if (accessType === "pwd" || accessType === "password") return "Password";
  if (accessType === "link") return "Link";
  if (accessType === "self") return "Self-Report";
  if (accessType.includes("grant")) return "Granted Access";
  if (accessType.includes("pass")) return "Password";
  if (accessType.includes("link")) return "Link";
  if (accessType.includes("self")) return "Self-Report";

  const selfReport = clean(selfReportRaw).toLowerCase();
  if (["1", "true", "yes", "y"].includes(selfReport)) return "Self-Report";

  const entryMethod = clean(entryMethodRaw);
  if (entryMethod) return `Other - ${entryMethod}`;

  return "Unknown";
}

function normalizeMonitoringPlatform(platformRaw: string, websiteRaw: string, notesRaw: string): string {
  const candidates = [clean(platformRaw), clean(websiteRaw), clean(notesRaw)]
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  const inferFromText = (text: string): string | null => {
    if (text.includes("solaredge") || text.includes("solar edge")) return "SolarEdge";
    if (text.includes("enphase")) return "Enphase";
    if (text.includes("hoymiles") || text.includes("s-miles")) return "Hoymiles S-Miles Cloud";
    if (text.includes("fronius") || text.includes("solar.web") || text.includes("solarweb.com")) return "Fronius Solar.web";
    if (text.includes("apsystems")) return "APSystems";
    if (text.includes("ennexos")) return "ennexOS";
    if (text.includes("tesla")) return "Tesla";
    if (text.includes("egauge") || text.includes("eguage")) return "eGauge";
    if (text.includes("sunpower")) return "SUNPOWER";
    if (text.includes("sdsi") || text.includes("arraymeter")) return "SDSI ArrayMeter";
    if (text.includes("generac") || text.includes("pwrfleet") || text.includes("pwrcell")) return "Generac PWRfleet";
    if (text.includes("chilicon")) return "Chilicon Power";
    if (text.includes("solis")) return "Solis";
    if (text.includes("encompass") || text.includes("ekm")) return "EKM Encompass.io";
    if (text.includes("duracell")) return "DURACELL Power Center";
    if (text.includes("solar-log") || text.includes("solarlog")) return "Solar-Log";
    if (text.includes("sensergm")) return "SenseRGM";
    if (text.includes("sems") || text.includes("goodwe")) return "GoodWe SEMS Portal";
    if (text.includes("alsoenergy")) return "AlsoEnergy";
    if (text.includes("locus")) return "Locus Energy";
    if (text.includes("sol-ark")) return "Sol-Ark PowerView Inteless";
    if (text.includes("mysolark")) return "MySolArk";
    if (text.includes("chint")) return "Chint Power Systems";
    if (text.includes("growatt")) return "Growatt";
    if (text.includes("sunnyportal")) return "SunnyPortal";
    if (text.includes("eg4")) return "EG4Electronics";
    if (text.includes("tigo")) return "Tigo";
    if (text.includes("vision metering")) return "Vision Metering";
    if (text.includes("solectria") || text.includes("solrenview")) return "Solectria SolrenView";
    if (text.includes("sigenergy") || text.includes("sigencloud")) return "Sigenergy";
    if (text.includes("savant")) return "Savant Power Storage";
    if (text.includes("aurora vision")) return "Aurora Vision";
    if (text.includes("franklin")) return "FranklinWH";
    if (text.includes("outback optics")) return "Outback Optics RE";
    if (text.includes("elkor")) return "ELKOR Cloud";
    if (text.includes("emporia")) return "Emporia Energy";
    if (text.includes("wattch")) return "Wattch.io";
    if (text.includes("aptos")) return "Aptos Solar";
    if (text.includes("insight cloud")) return "Insight Cloud";
    if (text.includes("third part")) return "Third Party Reporting";
    return null;
  };

  for (const candidate of candidates) {
    const inferred = inferFromText(candidate);
    if (inferred) return inferred;
  }

  const primary = clean(platformRaw);
  if (primary && !primary.toLowerCase().startsWith("http")) return primary;
  return "Unknown";
}

function formatDate(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatMonthYear(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

function toReadWindowMonthStart(value: Date): Date {
  if (value.getDate() <= 15) {
    return new Date(value.getFullYear(), value.getMonth() - 1, 1);
  }
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return "N/A";
  if (digits > 0) return value.toFixed(digits);
  return NUMBER_FORMATTER.format(value);
}

function formatKwh(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatCapacityKw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function toPercentValue(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function isStaleUpload(uploadedAt: Date | null | undefined, thresholdDays = STALE_UPLOAD_DAYS): boolean {
  if (!uploadedAt) return true;
  const ageMs = Date.now() - uploadedAt.getTime();
  return ageMs > thresholdDays * DAY_MS;
}

function formatSignedNumber(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value > 0) return `+${NUMBER_FORMATTER.format(value)}`;
  if (value < 0) return `-${NUMBER_FORMATTER.format(Math.abs(value))}`;
  return "0";
}

function buildDeliveryYearLabel(start: Date | null, end: Date | null, startRaw: string, endRaw: string): string {
  if (start && end) {
    return `${start.getFullYear()}-${end.getFullYear()}`;
  }
  if (startRaw && endRaw) return `${startRaw} to ${endRaw}`;
  if (startRaw) return startRaw;
  if (start) return formatDate(start);
  return "Unknown";
}

function buildRecReviewDeliveryYearLabel(start: Date | null, end: Date | null, startRaw: string, endRaw: string): string {
  // Delivery year label matches the energy year of the schedule start
  // date: schedule start 2023-06-01 → "2023-2024" (the June-to-May
  // energy year). No +1 offset — the schedule start IS the delivery
  // year start.
  return buildDeliveryYearLabel(start, end, startRaw, endRaw);
}

type RecPerformanceThreeYearValues = {
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

function deriveRecPerformanceThreeYearValues(
  sourceRow: PerformanceSourceRow,
  targetYearIndex: number
): RecPerformanceThreeYearValues | null {
  // REC Performance Eval rule: only include systems in their 3rd schedule year or later.
  if (targetYearIndex < 2) return null;

  const dyOneYear = sourceRow.years[targetYearIndex - 2];
  const dyTwoYear = sourceRow.years[targetYearIndex - 1];
  const dyThreeYear = sourceRow.years[targetYearIndex];
  if (!dyOneYear || !dyTwoYear || !dyThreeYear) return null;

  // Use the actual schedule year number (1-15), not the array index,
  // because empty years can be filtered out by buildScheduleYearEntries,
  // shifting array indices. yearIndex 3 = third delivery year.
  const isThirdDeliveryYear = dyThreeYear.yearIndex === 3;
  const values: Array<{ value: number; source: "Actual" | "Expected" }> = isThirdDeliveryYear
    ? [
        { value: dyOneYear.delivered, source: "Actual" },
        { value: dyTwoYear.delivered, source: "Actual" },
        { value: dyThreeYear.delivered, source: "Actual" },
      ]
    : [
        { value: dyOneYear.required, source: "Expected" },
        { value: dyTwoYear.required, source: "Expected" },
        { value: dyThreeYear.delivered, source: "Actual" },
      ];

  return {
    scheduleYearNumber: dyThreeYear.yearIndex,
    deliveryYearOne: values[0].value,
    deliveryYearTwo: values[1].value,
    deliveryYearThree: values[2].value,
    deliveryYearOneSource: values[0].source,
    deliveryYearTwoSource: values[1].source,
    deliveryYearThreeSource: values[2].source,
    rollingAverage: Math.floor((values[0].value + values[1].value + values[2].value) / 3),
    expectedRecs: dyThreeYear.required,
  };
}

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

function getMonitoringDetailsForSystem(
  system: SystemRecord,
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>
): MonitoringDetailsRecord | undefined {
  const keyById = system.systemId ? `id:${system.systemId}` : "";
  const keyByTracking = system.trackingSystemRefId ? `tracking:${system.trackingSystemRefId}` : "";
  const keyByName = `name:${system.systemName.toLowerCase()}`;

  return (
    (keyById ? monitoringDetailsBySystemKey.get(keyById) : undefined) ??
    (keyByTracking ? monitoringDetailsBySystemKey.get(keyByTracking) : undefined) ??
    monitoringDetailsBySystemKey.get(keyByName)
  );
}

function classifyMonitoringAccessType(accessTypeRaw: string): "granted" | "link" | "login" | "other" {
  const normalized = clean(accessTypeRaw).toLowerCase();
  if (!normalized) return "other";
  if (normalized.includes("grant")) return "granted";
  if (normalized.includes("link")) return "link";
  if (
    normalized.includes("password") ||
    normalized.includes("pass") ||
    normalized.includes("pwd") ||
    normalized.includes("login")
  ) {
    return "login";
  }
  return "other";
}

function resolveOfflineMonitoringAccessFields(
  system: SystemRecord,
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>
): OfflineMonitoringAccessFields {
  const details = getMonitoringDetailsForSystem(system, monitoringDetailsBySystemKey);
  const accessType = clean(details?.online_monitoring_access_type) || clean(system.monitoringType);
  const category = classifyMonitoringAccessType(accessType);
  const monitoringSiteId = clean(details?.online_monitoring_system_id);
  const monitoringSiteName = clean(details?.online_monitoring_system_name);
  const monitoringLink = clean(details?.online_monitoring_website_api_link);
  const monitoringUsername =
    firstNonEmptyString(clean(details?.online_monitoring_username), clean(details?.online_monitoring_granted_username)) ?? "";
  const monitoringPassword = clean(details?.online_monitoring_password);

  if (category === "granted") {
    return {
      accessType,
      monitoringSiteId,
      monitoringSiteName,
      monitoringLink: "",
      monitoringUsername: "",
      monitoringPassword: "",
    };
  }

  if (category === "link") {
    return {
      accessType,
      monitoringSiteId: "",
      monitoringSiteName: "",
      monitoringLink,
      monitoringUsername: "",
      monitoringPassword: "",
    };
  }

  if (category === "login") {
    return {
      accessType,
      monitoringSiteId: "",
      monitoringSiteName,
      monitoringLink: "",
      monitoringUsername,
      monitoringPassword,
    };
  }

  return {
    accessType,
    monitoringSiteId,
    monitoringSiteName,
    monitoringLink,
    monitoringUsername,
    monitoringPassword,
  };
}

function formatTransitionBreakdown(breakdown: Map<TransitionStatus, number>): string {
  const orderedStatuses: TransitionStatus[] = [...CHANGE_OWNERSHIP_ORDER, NO_COO_STATUS];
  const parts = orderedStatuses
    .map((status) => ({ status, count: breakdown.get(status) ?? 0 }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.status}: ${NUMBER_FORMATTER.format(item.count)}`);
  return parts.length > 0 ? parts.join(" | ") : "None";
}

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

function isCsvLikeFile(fileName: string, contentType?: string): boolean {
  const lowerName = clean(fileName).toLowerCase();
  const lowerType = clean(contentType).toLowerCase();
  return lowerName.endsWith(".csv") || lowerType.includes("csv") || lowerType.startsWith("text/");
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

function estimateDatasetRemotePayloadChars(
  dataset: CsvDataset,
  hardLimit: number
): number {
  // Rough upper bound for CSV payload size without allocating the full payload string.
  let total = 0;
  total += dataset.fileName.length + 128;
  total += dataset.headers.reduce((sum, header) => sum + header.length + 3, 0) + 2;

  for (const row of dataset.rows) {
    for (const header of dataset.headers) {
      total += clean(row[header]).length + 3;
    }
    total += 2;
    if (total > hardLimit) return total;
  }

  if (dataset.sources) {
    for (const source of dataset.sources) {
      total += source.fileName.length + 64;
      if (total > hardLimit) return total;
    }
  }

  return total;
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
      sources,
    };
  } catch {
    return null;
  }
}

function sumSchedule(row: CsvRow, suffix: "_quantity_required" | "_quantity_delivered"): number | null {
  let total = 0;
  let hasData = false;

  Object.entries(row).forEach(([header, value]) => {
    if (!header.endsWith(suffix)) return;
    const parsed = parseNumber(value);
    if (parsed === null) return;
    total += parsed;
    hasData = true;
  });

  return hasData ? total : null;
}

function ownershipBadgeClass(status: OwnershipStatus): string {
  if (status.startsWith("Transferred")) return "bg-blue-100 text-blue-800 border-blue-200";
  if (status.startsWith("Terminated")) return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

function changeOwnershipBadgeClass(status: ChangeOwnershipStatus): string {
  if (status.startsWith("Transferred")) return "bg-blue-100 text-blue-800 border-blue-200";
  if (status.startsWith("Terminated")) return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-amber-100 text-amber-900 border-amber-200";
}

function createLogId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type SerializedCsvDataset = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows: CsvRow[];
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

type DatasetCloudSyncStatus = "pending" | "synced" | "failed";

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

  return {
    fileName: dataset.fileName,
    uploadedAt,
    headers: Array.isArray(dataset.headers) ? dataset.headers : [],
    rows: Array.isArray(dataset.rows) ? dataset.rows : [],
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

function serializeDatasetRecord(dataset: CsvDataset): SerializedCsvDataset {
  return {
    fileName: dataset.fileName,
    uploadedAt: dataset.uploadedAt.toISOString(),
    headers: dataset.headers,
    rows: dataset.rows,
    sources: dataset.sources?.map((source) => ({
      fileName: source.fileName,
      uploadedAt: source.uploadedAt.toISOString(),
      rowCount: source.rowCount,
    })),
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

async function openDashboardDatabase(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }

    const request = window.indexedDB.open(DASHBOARD_DB_NAME, DASHBOARD_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DASHBOARD_DATASETS_STORE)) {
        db.createObjectStore(DASHBOARD_DATASETS_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

function dashboardDatasetStorageKey(key: DatasetKey): string {
  return `dataset:${key}`;
}

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function loadDatasetsFromStorage(): Promise<Partial<Record<DatasetKey, CsvDataset>>> {
  if (typeof window === "undefined") return {};

  if (!("indexedDB" in window)) {
    return loadLegacyDatasetsFromLocalStorage();
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openDashboardDatabase();
    const openDb = db;
    const stored = await new Promise<{
      manifest: SerializedDatasetsManifest | null;
      legacy: Record<string, SerializedCsvDataset | undefined> | null;
    }>((resolve, reject) => {
      const transaction = openDb.transaction(DASHBOARD_DATASETS_STORE, "readonly");
      const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
      const manifestRequest = store.get(DASHBOARD_DATASETS_MANIFEST_KEY);
      const legacyRequest = store.get(DASHBOARD_DATASETS_RECORD_KEY);

      transaction.oncomplete = () => {
        resolve({
          manifest: (manifestRequest.result as SerializedDatasetsManifest | undefined) ?? null,
          legacy:
            (legacyRequest.result as Record<string, SerializedCsvDataset | undefined> | undefined) ?? null,
        });
      };
      transaction.onabort = () => reject(transaction.error ?? new Error("Failed reading datasets from IndexedDB."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Failed reading datasets from IndexedDB."));
    });

    if (stored.manifest && Array.isArray(stored.manifest.keys) && stored.manifest.keys.length > 0) {
      const keys = stored.manifest.keys.filter((key): key is DatasetKey => isDatasetKey(key));
      if (keys.length > 0) {
        const transaction = openDb.transaction(DASHBOARD_DATASETS_STORE, "readonly");
        const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
        const rows = await Promise.all(
          keys.map(async (key) => {
            const serialized = (await idbRequestToPromise(
              store.get(dashboardDatasetStorageKey(key))
            )) as SerializedCsvDataset | undefined;
            return { key, serialized };
          })
        );
        const loaded: Partial<Record<DatasetKey, CsvDataset>> = {};
        rows.forEach(({ key, serialized }) => {
          const dataset = deserializeDatasetRecord(serialized);
          if (!dataset) return;
          loaded[key] = dataset;
        });
        if (Object.keys(loaded).length > 0) {
          return loaded;
        }
      }
    }

    if (stored.legacy) {
      const legacyDatasets = deserializeDatasets(stored.legacy);
      if (Object.keys(legacyDatasets).length > 0) {
        await saveDatasetsToStorage(legacyDatasets);
        return legacyDatasets;
      }
    }

    const legacy = loadLegacyDatasetsFromLocalStorage();
    if (Object.keys(legacy).length > 0) {
      await saveDatasetsToStorage(legacy);
      globalThis.localStorage.removeItem(LEGACY_DATASETS_STORAGE_KEY);
      return legacy;
    }

    return {};
  } catch {
    return loadLegacyDatasetsFromLocalStorage();
  } finally {
    if (db) db.close();
  }
}

async function saveDatasetsToStorage(datasets: Partial<Record<DatasetKey, CsvDataset>>): Promise<void> {
  if (typeof window === "undefined") return;

  if (!("indexedDB" in window)) {
    const legacySerialized = serializeDatasets(datasets);
    globalThis.localStorage.setItem(LEGACY_DATASETS_STORAGE_KEY, JSON.stringify(legacySerialized));
    return;
  }

  const db = await openDashboardDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DASHBOARD_DATASETS_STORE, "readwrite");
    const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
    const activeKeys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(datasets[key]));
    const manifest: SerializedDatasetsManifest = {
      keys: activeKeys,
      updatedAt: new Date().toISOString(),
    };

    store.put(manifest, DASHBOARD_DATASETS_MANIFEST_KEY);
    store.delete(DASHBOARD_DATASETS_RECORD_KEY);

    (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
      const dataset = datasets[key];
      if (!dataset) {
        store.delete(dashboardDatasetStorageKey(key));
        return;
      }
      store.put(serializeDatasetRecord(dataset), dashboardDatasetStorageKey(key));
    });

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("Failed saving datasets to IndexedDB."));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Failed saving datasets to IndexedDB."));
    };
  });
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
  if (typeof window === "undefined") return [];

  if (!("indexedDB" in window)) {
    return loadPersistedLogs();
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openDashboardDatabase();
    const openDb = db;
    const logsPayload = (await new Promise<unknown>((resolve, reject) => {
      const transaction = openDb.transaction(DASHBOARD_DATASETS_STORE, "readonly");
      const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
      const request = store.get(DASHBOARD_LOGS_RECORD_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed reading snapshot logs from IndexedDB."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Failed reading snapshot logs from IndexedDB."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Failed reading snapshot logs from IndexedDB."));
    })) as string | null | undefined;

    if (typeof logsPayload === "string" && logsPayload.length > 0) {
      const parsed = deserializeDashboardLogs(logsPayload);
      if (parsed.length > 0) return parsed;
    }

    const localFallback = loadPersistedLogs();
    if (localFallback.length > 0) {
      await saveLogsToStorage(localFallback);
      return localFallback;
    }
    return [];
  } catch {
    return loadPersistedLogs();
  } finally {
    if (db) db.close();
  }
}

async function saveLogsToStorage(logEntries: DashboardLogEntry[]): Promise<void> {
  if (typeof window === "undefined") return;

  const compactLogs = compactLogsForRemoteSync(logEntries);
  const compactText = safeJsonStringify(compactLogs) ?? "[]";
  try {
    window.localStorage.setItem(LOGS_STORAGE_KEY, compactText);
  } catch {
    // Non-fatal fallback path.
  }

  if (!("indexedDB" in window)) return;

  const fullText = safeJsonStringify(serializeDashboardLogs(logEntries, { includeSystemName: false })) ?? "[]";
  const db = await openDashboardDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DASHBOARD_DATASETS_STORE, "readwrite");
    const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
    store.put(fullText, DASHBOARD_LOGS_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("Failed saving snapshot logs to IndexedDB."));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Failed saving snapshot logs to IndexedDB."));
    };
  });
}

function loadPersistedCompliantSources(): CompliantSourceEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COMPLIANT_SOURCE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{
      portalId: string;
      compliantSource: string;
      updatedAt: string;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const portalId = clean(item.portalId);
        const compliantSource = clean(item.compliantSource);
        const updatedAt = new Date(item.updatedAt);
        if (!portalId || !compliantSource || Number.isNaN(updatedAt.getTime())) return null;
        return {
          portalId,
          compliantSource,
          updatedAt,
          evidence: [],
        } satisfies CompliantSourceEntry;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  } catch {
    return [];
  }
}


export default function SolarRecDashboard() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const [datasets, setDatasets] = useState<Partial<Record<DatasetKey, CsvDataset>>>({});
  const [datasetsHydrated, setDatasetsHydrated] = useState(false);
  const [logEntries, setLogEntries] = useState<DashboardLogEntry[]>(() => loadPersistedLogs());
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DatasetKey, string>>>({});
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [localOnlyDatasets, setLocalOnlyDatasets] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [datasetCloudSyncStatus, setDatasetCloudSyncStatus] = useState<
    Partial<Record<DatasetKey, DatasetCloudSyncStatus>>
  >({});
  const [forceSyncingDatasets, setForceSyncingDatasets] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [migratingLocalOnlyDatasets, setMigratingLocalOnlyDatasets] = useState(false);
  const [remoteSourceManifests, setRemoteSourceManifests] = useState<
    Partial<Record<DatasetKey, RemoteDatasetSourceManifestPayload>>
  >({});
  const [forceDatasetSyncTick, setForceDatasetSyncTick] = useState(0);
  const [remoteStateHydrated, setRemoteStateHydrated] = useState(false);
  const remoteDashboardStateQuery = trpc.solarRecDashboard.getState.useQuery(undefined, {
    retry: 4,
    retryDelay: (attempt) => Math.min(2000 * (attempt + 1), 10_000),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const saveRemoteDashboardState = trpc.solarRecDashboard.saveState.useMutation();
  const getRemoteDataset = trpc.solarRecDashboard.getDataset.useMutation();
  const saveRemoteDataset = trpc.solarRecDashboard.saveDataset.useMutation();
  const saveRemoteDashboardStateRef = useRef(saveRemoteDashboardState);
  saveRemoteDashboardStateRef.current = saveRemoteDashboardState;
  const getRemoteDatasetRef = useRef(getRemoteDataset);
  getRemoteDatasetRef.current = getRemoteDataset;
  const saveRemoteDatasetRef = useRef(saveRemoteDataset);
  saveRemoteDatasetRef.current = saveRemoteDataset;
  const remoteDatasetSignatureRef = useRef<Partial<Record<DatasetKey, string>>>({});
  const remoteDatasetChunkKeysRef = useRef<Partial<Record<DatasetKey, string[]>>>({});
  const forcedRemoteDatasetSyncKeysRef = useRef<Set<DatasetKey>>(new Set());
  const remoteSourceManifestsRef = useRef<Partial<Record<DatasetKey, RemoteDatasetSourceManifestPayload>>>({});
  remoteSourceManifestsRef.current = remoteSourceManifests;
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipStatus | "All">("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [changeOwnershipFilter, setChangeOwnershipFilter] = useState<ChangeOwnershipStatus | "All">("All");
  const [changeOwnershipSearch, setChangeOwnershipSearch] = useState("");
  const [changeOwnershipSortBy, setChangeOwnershipSortBy] = useState<
    | "systemName"
    | "contractValue"
    | "installedKwAc"
    | "contractDate"
    | "zillowSoldDate"
    | "status"
    | "reporting"
  >("contractValue");
  const [changeOwnershipSortDir, setChangeOwnershipSortDir] = useState<"asc" | "desc">("desc");
  const [offlineMonitoringFilter, setOfflineMonitoringFilter] = useState("All");
  const [offlinePlatformFilter, setOfflinePlatformFilter] = useState("All");
  const [offlineInstallerFilter, setOfflineInstallerFilter] = useState("All");
  const [offlineSearch, setOfflineSearch] = useState("");
  const [offlineMonitoringSortBy, setOfflineMonitoringSortBy] = useState<
    "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
  >("offlineSystems");
  const [offlineMonitoringSortDir, setOfflineMonitoringSortDir] = useState<"asc" | "desc">("desc");
  const [offlinePlatformSortBy, setOfflinePlatformSortBy] = useState<
    "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
  >("offlineSystems");
  const [offlinePlatformSortDir, setOfflinePlatformSortDir] = useState<"asc" | "desc">("desc");
  const [offlineInstallerSortBy, setOfflineInstallerSortBy] = useState<
    "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
  >("offlineSystems");
  const [offlineInstallerSortDir, setOfflineInstallerSortDir] = useState<"asc" | "desc">("desc");
  const [offlineDetailSortBy, setOfflineDetailSortBy] = useState<
    "systemName" | "monitoringType" | "monitoringPlatform" | "installerName" | "contractedValue" | "latestReportingDate"
  >("contractedValue");
  const [offlineDetailSortDir, setOfflineDetailSortDir] = useState<"asc" | "desc">("desc");
  const [performanceContractId, setPerformanceContractId] = useState("");
  const [performanceDeliveryYearKey, setPerformanceDeliveryYearKey] = useState("");
  const [performancePreviousSurplusInput, setPerformancePreviousSurplusInput] = useState("0");
  const [performancePreviousDrawdownInput, setPerformancePreviousDrawdownInput] = useState("0");
  const [meterReadsResult, setMeterReadsResult] = useState<MeterReadsConversionResult | null>(null);
  const [meterReadsError, setMeterReadsError] = useState<string | null>(null);
  const [meterReadsBusy, setMeterReadsBusy] = useState(false);
  const [performanceRatioMonitoringFilter, setPerformanceRatioMonitoringFilter] = useState("All");
  const [performanceRatioMatchFilter, setPerformanceRatioMatchFilter] = useState<PerformanceRatioMatchType | "All">("All");
  const [performanceRatioSearch, setPerformanceRatioSearch] = useState("");
  const [performanceRatioSortBy, setPerformanceRatioSortBy] = useState<
    "performanceRatioPercent" | "productionDeltaWh" | "expectedProductionWh" | "systemName" | "readDate"
  >("performanceRatioPercent");
  const [performanceRatioSortDir, setPerformanceRatioSortDir] = useState<"asc" | "desc">("desc");
  const [performanceRatioPage, setPerformanceRatioPage] = useState(1);
  const [recValuePage, setRecValuePage] = useState(1);
  const [sizeSiteListCollapsed, setSizeSiteListCollapsed] = useState(false);
  const [sizeSiteListPage, setSizeSiteListPage] = useState(1);
  const [snapshotContractPage, setSnapshotContractPage] = useState(1);
  const [contractSummaryPage, setContractSummaryPage] = useState(1);
  const [contractDetailPage, setContractDetailPage] = useState(1);
  const [annualContractVintagePage, setAnnualContractVintagePage] = useState(1);
  const [annualContractSummaryPage, setAnnualContractSummaryPage] = useState(1);
  const [recPerformanceResultsPage, setRecPerformanceResultsPage] = useState(1);
  const [offlineDetailPage, setOfflineDetailPage] = useState(1);
  const [compliantSourcePage, setCompliantSourcePage] = useState(1);
  const [compliantReportPage, setCompliantReportPage] = useState(1);
  // Financials table sort/filter state. Mirrors changeOwnership pattern.
  type FinancialSortKey =
    | "systemName"
    | "grossContractValue"
    | "vendorFeePercent"
    | "vendorFeeAmount"
    | "utilityCollateral"
    | "additionalCollateralPercent"
    | "additionalCollateralAmount"
    | "ccAuth5Percent"
    | "applicationFee"
    | "totalDeductions"
    | "profit"
    | "totalCollateralization";
  const [financialSortBy, setFinancialSortBy] = useState<FinancialSortKey>("profit");
  const [financialSortDir, setFinancialSortDir] = useState<"asc" | "desc">("desc");
  const [financialSearch, setFinancialSearch] = useState("");
  const [financialFilter, setFinancialFilter] = useState<"all" | "needs-review" | "ok">("all");
  const [uploadsExpanded, setUploadsExpanded] = useState(false);
  const [compliantSourceEntries, setCompliantSourceEntries] = useState<CompliantSourceEntry[]>(
    () => loadPersistedCompliantSources()
  );
  const [compliantSourcePortalIdInput, setCompliantSourcePortalIdInput] = useState("");
  const [compliantSourceTextInput, setCompliantSourceTextInput] = useState("");
  const [compliantSourceEvidenceFiles, setCompliantSourceEvidenceFiles] = useState<File[]>([]);
  const [compliantSourceUploadError, setCompliantSourceUploadError] = useState<string | null>(null);
  const [compliantSourceCsvMessage, setCompliantSourceCsvMessage] = useState<string | null>(null);
  const compliantSourceEntriesRef = useRef<CompliantSourceEntry[]>(compliantSourceEntries);
  compliantSourceEntriesRef.current = compliantSourceEntries;
  const [monthlySnapshotTransitions, setMonthlySnapshotTransitions] = useState<
    Array<{
      monthKey: string;
      monthLabel: string;
      movedIn: number;
      movedOut: number;
      net: number;
      endingCount: number;
      movedInBreakdown: string;
      movedOutBreakdown: string;
    }>
  >([]);
  const [activeTab, setActiveTab] = useState<DashboardTabId>(
    () => getTabFromSearch(search) ?? DEFAULT_DASHBOARD_TAB
  );
  const [pipelineCountRange, setPipelineCountRange] = useState<"3year" | "12month">("3year");
  const [pipelineKwRange, setPipelineKwRange] = useState<"3year" | "12month">("3year");
  const [pipelineInterconnectedRange, setPipelineInterconnectedRange] = useState<"3year" | "12month">("3year");
  const [pipelineReportLoading, setPipelineReportLoading] = useState(false);
  const generatePipelineReport = trpc.openai.generatePipelineReport.useMutation();
  const isContractsTabActive = activeTab === "contracts";
  const isAnnualReviewTabActive = activeTab === "annual-review";
  const isPerformanceEvalTabActive = activeTab === "performance-eval" || activeTab === "snapshot-log";
  const isOfflineTabActive = activeTab === "offline-monitoring";
  const isPerformanceRatioTabActive = activeTab === "performance-ratio";
  const isTrendsTabActive = activeTab === "trends";
  const isForecastTabActive = activeTab === "forecast";
  const isAlertsTabActive = activeTab === "alerts";
  const isComparisonsTabActive = activeTab === "comparisons";
  const isFinancialsTabActive = activeTab === "financials";
  const isDataQualityTabActive = activeTab === "data-quality";
  const isDeliveryTrackerTabActive = activeTab === "delivery-tracker";
  const handleActiveTabChange = useCallback(
    (nextTabValue: string) => {
      if (!isDashboardTabId(nextTabValue)) return;
      setActiveTab(nextTabValue);

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

  // Helper: make system names clickable to open detail sheet
  const systemNameLink = (systemName: string, systemKey: string) => (
    <button
      type="button"
      className="text-left font-medium text-blue-700 hover:text-blue-900 hover:underline cursor-pointer"
      onClick={() => setSelectedSystemKey(systemKey)}
    >
      {systemName}
    </button>
  );
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
  const csvParserWorkerRef = useRef<Worker | null>(null);
  const csvParserRequestSeqRef = useRef(1);
  const csvParserPendingRef = useRef(
    new Map<number, { resolve: (value: { headers: string[]; rows: CsvRow[] }) => void; reject: (error: Error) => void }>()
  );

  useEffect(() => {
    const tabFromQuery = getTabFromSearch(search);
    const nextTab = tabFromQuery ?? DEFAULT_DASHBOARD_TAB;
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }, [activeTab, search]);

  const ensureCsvParserWorker = useCallback(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    if (csvParserWorkerRef.current) return csvParserWorkerRef.current;

    const worker = new Worker(new URL("../../workers/csvParser.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<CsvParserWorkerResponse>) => {
      const message = event.data;
      const pending = csvParserPendingRef.current.get(message.id);
      if (!pending) return;
      csvParserPendingRef.current.delete(message.id);
      if (message.ok) {
        pending.resolve({ headers: message.headers, rows: message.rows });
        return;
      }
      pending.reject(new Error(message.error || "Failed to parse CSV in worker."));
    };

    worker.onerror = () => {
      csvParserPendingRef.current.forEach(({ reject }) => {
        reject(new Error("CSV parsing worker crashed."));
      });
      csvParserPendingRef.current.clear();
      worker.terminate();
      csvParserWorkerRef.current = null;
    };

    csvParserWorkerRef.current = worker;
    return worker;
  }, []);

  const parseCsvFileAsync = useCallback(
    async (file: File): Promise<{ headers: string[]; rows: CsvRow[] }> => {
      const worker = ensureCsvParserWorker();
      if (!worker) {
        const text = await file.text();
        return parseCsv(text);
      }

      return new Promise((resolve, reject) => {
        const id = csvParserRequestSeqRef.current++;
        csvParserPendingRef.current.set(id, { resolve, reject });
        const message: CsvParserWorkerRequest = { id, mode: "file", file };
        worker.postMessage(message);
      });
    },
    [ensureCsvParserWorker]
  );

  const parseCsvTextAsync = useCallback(
    async (text: string): Promise<{ headers: string[]; rows: CsvRow[] }> => {
      const worker = ensureCsvParserWorker();
      if (!worker) {
        return parseCsv(text);
      }

      return new Promise((resolve, reject) => {
        const id = csvParserRequestSeqRef.current++;
        csvParserPendingRef.current.set(id, { resolve, reject });
        const message: CsvParserWorkerRequest = { id, mode: "text", text };
        worker.postMessage(message);
      });
    },
    [ensureCsvParserWorker]
  );

  const saveRemotePayloadWithChunks = useCallback(async (key: string, payload: string): Promise<string[]> => {
    const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
    if (chunks.length === 1) {
      await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload }));
      return [];
    }

    const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(key, index));
    for (let index = 0; index < chunks.length; index += 1) {
      await withRetry(() =>
        saveRemoteDatasetRef.current.mutateAsync({
          key: chunkKeys[index],
          payload: chunks[index],
        })
      );
    }
    await withRetry(() =>
      saveRemoteDatasetRef.current.mutateAsync({
        key,
        payload: buildChunkPointerPayload(chunkKeys),
      })
    );
    return chunkKeys;
  }, []);

  const clearRemotePayloadWithChunks = useCallback(async (key: string, chunkKeys: string[] | undefined) => {
    await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload: "" }));
    if (!Array.isArray(chunkKeys)) return;
    for (const chunkKey of chunkKeys) {
      await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
    }
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
        setDatasetCloudSyncBadge(key, "synced");
        return true;
      } catch (error) {
        setDatasetCloudSyncBadge(key, "failed");
        const message =
          error instanceof Error ? error.message : "Unknown error while syncing source manifest to cloud.";
        setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} source manifest to cloud: ${message}`);
        return false;
      }
    },
    [saveRemotePayloadWithChunks, setDatasetCloudSyncBadge]
  );

  const uploadRemoteSourceFile = useCallback(
    async (
      key: DatasetKey,
      source: {
        file: File;
        uploadedAt: Date;
        rowCount: number;
      }
    ): Promise<RemoteDatasetSourceRef> => {
      const sourceId = createRemoteSourceId();
      const storageKey = buildRemoteSourceStorageKey(key, sourceId);
      const contentType = source.file.type || "application/octet-stream";
      const csvLike = isCsvLikeFile(source.file.name, contentType);
      let encoding: RemoteDatasetSourceEncoding = "utf8";
      let payload = "";

      if (csvLike) {
        payload = await source.file.text();
      } else {
        encoding = "base64";
        const bytes = new Uint8Array(await source.file.arrayBuffer());
        payload = bytesToBase64(bytes);
      }

      const chunkKeys = await saveRemotePayloadWithChunks(storageKey, payload);
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
    [saveRemotePayloadWithChunks]
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
        const previousManifest = remoteSourceManifestsRef.current[key];
        const previousSources = previousManifest?.sources ?? [];
        const uploadedSources: RemoteDatasetSourceRef[] = [];

        for (const source of uploads) {
          const uploadedSource = await uploadRemoteSourceFile(key, source);
          uploadedSources.push(uploadedSource);
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
        const message = error instanceof Error ? error.message : "Unknown error while syncing source files to cloud.";
        setDatasetCloudSyncBadge(key, "failed");
        setStorageNotice(`Could not sync ${DATASET_DEFINITIONS[key].label} source file(s) to cloud: ${message}`);
        return false;
      }
    },
    [clearRemotePayloadWithChunks, setDatasetCloudSyncBadge, syncDatasetSourceManifestToCloud, uploadRemoteSourceFile]
  );

  useEffect(() => {
    return () => {
      csvParserPendingRef.current.forEach(({ reject }) => {
        reject(new Error("CSV parser worker terminated."));
      });
      csvParserPendingRef.current.clear();
      csvParserWorkerRef.current?.terminate();
      csvParserWorkerRef.current = null;
    };
  }, []);

  const jumpToSection = (sectionId: string) => {
    if (typeof document === "undefined") return;
    const target = document.getElementById(sectionId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const saveCompliantSourceEntry = () => {
    const portalId = clean(compliantSourcePortalIdInput);
    const compliantSource = clean(compliantSourceTextInput);
    if (!portalId) {
      setCompliantSourceUploadError("Portal ID is required.");
      return;
    }
    if (!isValidCompliantSourceText(compliantSource)) {
      setCompliantSourceUploadError(
        `Compliant Source must contain only letters, numbers, spaces, underscores, hyphens, or commas, and be ${MAX_COMPLIANT_SOURCE_CHARS} characters or fewer.`
      );
      return;
    }

    const invalidFile = compliantSourceEvidenceFiles.find((file) => {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const isImage = file.type.startsWith("image/");
      return !isPdf && !isImage;
    });
    if (invalidFile) {
      setCompliantSourceUploadError("Evidence uploads support only images and PDFs.");
      return;
    }

    const oversizedFile = compliantSourceEvidenceFiles.find((file) => file.size > MAX_COMPLIANT_FILE_BYTES);
    if (oversizedFile) {
      setCompliantSourceUploadError(
        `${oversizedFile.name} is too large. Max file size is ${formatNumber(MAX_COMPLIANT_FILE_BYTES / 1024 / 1024)} MB.`
      );
      return;
    }

    const now = new Date();
    const newEvidence: CompliantSourceEvidence[] = compliantSourceEvidenceFiles.map((file) => ({
      id: createLogId(),
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      fileSizeBytes: file.size,
      objectUrl: URL.createObjectURL(file),
      uploadedAt: now,
    }));

    setCompliantSourceEntries((previous) => {
      const existing = previous.find((entry) => entry.portalId === portalId);
      if (!existing) {
        return [
          ...previous,
          {
            portalId,
            compliantSource,
            updatedAt: now,
            evidence: newEvidence,
          },
        ];
      }
      return previous.map((entry) =>
        entry.portalId === portalId
          ? {
              ...entry,
              compliantSource,
              updatedAt: now,
              evidence: [...entry.evidence, ...newEvidence],
            }
          : entry
      );
    });

    setCompliantSourceUploadError(null);
    setCompliantSourceTextInput("");
    setCompliantSourceEvidenceFiles([]);
  };

  const removeCompliantSourceEntry = (portalId: string) => {
    setCompliantSourceEntries((previous) => {
      const target = previous.find((entry) => entry.portalId === portalId);
      target?.evidence.forEach((item) => URL.revokeObjectURL(item.objectUrl));
      return previous.filter((entry) => entry.portalId !== portalId);
    });
  };

  const importCompliantSourceCsv = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = await parseCsvFileAsync(file);
      if (!matchesExpectedHeaders(parsed.headers, ["portal_id", "source"])) {
        setCompliantSourceUploadError("CSV must include headers: portal_id, source");
        setCompliantSourceCsvMessage(null);
        return;
      }

      const importedAt = new Date();
      const validRows: Array<{ portalId: string; source: string }> = [];
      let skippedMissing = 0;
      let skippedInvalid = 0;

      parsed.rows.forEach((row) => {
        const portalId = getCsvValueByHeader(row, "portal_id");
        const source = getCsvValueByHeader(row, "source");
        if (!portalId || !source) {
          skippedMissing += 1;
          return;
        }
        if (!isValidCompliantSourceText(source)) {
          skippedInvalid += 1;
          return;
        }
        validRows.push({ portalId, source });
      });

      if (validRows.length === 0) {
        setCompliantSourceUploadError("No valid compliant source rows found in CSV.");
        setCompliantSourceCsvMessage(null);
        return;
      }

      setCompliantSourceEntries((previous) => {
        const byPortal = new Map(previous.map((entry) => [entry.portalId, entry]));
        validRows.forEach(({ portalId, source }) => {
          const existing = byPortal.get(portalId);
          if (existing) {
            byPortal.set(portalId, {
              ...existing,
              compliantSource: source,
              updatedAt: importedAt,
            });
          } else {
            byPortal.set(portalId, {
              portalId,
              compliantSource: source,
              updatedAt: importedAt,
              evidence: [],
            });
          }
        });
        return Array.from(byPortal.values());
      });

      setCompliantSourceUploadError(null);
      setCompliantSourceCsvMessage(
        `Imported ${formatNumber(validRows.length)} row(s). Skipped ${formatNumber(skippedMissing)} missing and ${formatNumber(skippedInvalid)} invalid source row(s).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not import compliant source CSV.";
      setCompliantSourceUploadError(message);
      setCompliantSourceCsvMessage(null);
    }
  };

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
      const parsed = TABULAR_DATASET_KEYS.has(key)
        ? file.name.toLowerCase().endsWith(".csv")
          ? await parseCsvFileAsync(file)
          : await parseTabularFile(file)
        : await (async () => {
            return await parseCsvFileAsync(file);
          })();
      const isValid = config.requiredHeaderSets.some((set) => matchesExpectedHeaders(parsed.headers, set));

      if (!isValid) {
        setUploadErrors((previous) => ({
          ...previous,
          [key]: `This file does not match the expected ${config.label} format.`,
        }));
        return;
      }

      const uploadedAt = new Date();
      const shouldAppend = MULTI_APPEND_DATASET_KEYS.has(key) && mode === "append";
      setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
      setDatasets((previous) => ({
        ...previous,
        [key]: (() => {
          const existing = previous[key];

          if (shouldAppend && existing) {
            const combinedHeaders = Array.from(new Set([...existing.headers, ...parsed.headers]));
            const existingRows = existing.rows;
            const dedupeKeys = new Set(existingRows.map((row) => datasetAppendRowKey(key, row)));
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

            return {
              fileName: `${sources.length} files loaded`,
              uploadedAt,
              headers: combinedHeaders,
              rows: [...existingRows, ...appendedRows],
              sources,
            } satisfies CsvDataset;
          }

          return {
            fileName: file.name,
            uploadedAt,
            headers: parsed.headers,
            rows: parsed.rows,
            sources:
              MULTI_APPEND_DATASET_KEYS.has(key)
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

      void persistDatasetSourceFilesToCloud(
        key,
        shouldAppend ? "append" : "replace",
        [{ file, uploadedAt, rowCount: parsed.rows.length }]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error while reading CSV.";
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
      for (const file of files) {
        if (file.size > MAX_SINGLE_CSV_UPLOAD_BYTES) {
          setUploadErrors((previous) => ({
            ...previous,
            [key]: `${file.name} is too large (${formatNumber(file.size / 1024 / 1024, 1)} MB). Please split files larger than ${formatNumber(MAX_SINGLE_CSV_UPLOAD_BYTES / 1024 / 1024)} MB.`,
          }));
          return;
        }
        const parsed = await parseCsvFileAsync(file);
        const isValid = config.requiredHeaderSets.some((set) => matchesExpectedHeaders(parsed.headers, set));
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
        const dedupeKeys = new Set(combinedRows.map((row) => datasetAppendRowKey(key, row)));
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

        const uploadedAt = parsedFiles[parsedFiles.length - 1]?.uploadedAt ?? new Date();

        return {
          ...previous,
          [key]: {
            fileName: `${sources.length} files loaded`,
            uploadedAt,
            headers: combinedHeaders,
            rows: combinedRows,
            sources,
          } satisfies CsvDataset,
        };
      });

      void persistDatasetSourceFilesToCloud(
        key,
        "append",
        parsedFiles.map((parsedFile) => ({
          file: parsedFile.file,
          uploadedAt: parsedFile.uploadedAt,
          rowCount: parsedFile.rows.length,
        }))
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error while reading CSV files.";
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
    }
  };

  const clearDataset = (key: DatasetKey) => {
    setDatasets((previous) => ({ ...previous, [key]: undefined }));
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
    setLocalOnlyDatasets((previous) => ({ ...previous, [key]: false }));
    setDatasetCloudSyncBadge(key, undefined);
    setForceSyncingDatasets((previous) => ({ ...previous, [key]: false }));
    setRemoteSourceManifests((previous) => ({ ...previous, [key]: undefined }));
    forcedRemoteDatasetSyncKeysRef.current.delete(key);
  };

  const clearAll = () => {
    setDatasets({});
    setUploadErrors({});
    setLocalOnlyDatasets({});
    setDatasetCloudSyncStatus({});
    setForceSyncingDatasets({});
    setRemoteSourceManifests({});
    forcedRemoteDatasetSyncKeysRef.current.clear();
    setMeterReadsResult(null);
    setMeterReadsError(null);
    setMeterReadsBusy(false);
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

  const handleMeterReadsUpload = async (file: File | null) => {
    if (!file) return;

    setMeterReadsBusy(true);
    setMeterReadsError(null);

    try {
      const result = await convertMeterReadWorkbook(file);
      setMeterReadsResult(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error while converting meter read workbook.";
      setMeterReadsError(message);
    } finally {
      setMeterReadsBusy(false);
    }
  };

  const downloadMeterReadsCsv = () => {
    if (!meterReadsResult) return;

    const blob = new Blob([meterReadsResult.csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildMeterReadDownloadFileName(meterReadsResult.readDate);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

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

  const systems = useMemo<SystemRecord[]>(() => {
    const abpReportRows = part2VerifiedAbpRows;
    const eligibleAbpSystemIds = new Set<string>();
    const eligibleAbpTrackingIds = new Set<string>();
    const eligibleAbpNames = new Set<string>();

    abpReportRows.forEach((row) => {
      const systemId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const name = clean(row.Project_Name) || clean(row.system_name);

      if (systemId) eligibleAbpSystemIds.add(systemId);
      if (trackingId) eligibleAbpTrackingIds.add(trackingId);
      if (name) eligibleAbpNames.add(name.toLowerCase());
    });

    if (abpReportRows.length === 0) {
      return [];
    }

    const contractedBySystemId = new Map<string, Date>();
    (datasets.contractedDate?.rows ?? []).forEach((row) => {
      const systemId = clean(row.id);
      const contractedDate = parseDate(row.contracted);
      if (!systemId || !contractedDate) return;
      contractedBySystemId.set(systemId, contractedDate);
    });

    const builders = new Map<string, SystemBuilder>();
    const keyByTracking = new Map<string, string>();
    const keyBySystemId = new Map<string, string>();

    const ensureBuilder = (trackingSystemRefId: string | null, systemId: string | null): SystemBuilder => {
      const existingKeyByTracking = trackingSystemRefId ? keyByTracking.get(trackingSystemRefId) : undefined;
      if (existingKeyByTracking) return builders.get(existingKeyByTracking)!;

      const existingKeyBySystemId = systemId ? keyBySystemId.get(systemId) : undefined;
      if (existingKeyBySystemId) {
        if (trackingSystemRefId) keyByTracking.set(trackingSystemRefId, existingKeyBySystemId);
        return builders.get(existingKeyBySystemId)!;
      }

      const key = trackingSystemRefId || (systemId ? `system-${systemId}` : `unknown-${builders.size + 1}`);
      const created: SystemBuilder = {
        key,
        systemId: systemId || null,
        stateApplicationRefId: null,
        trackingSystemRefId: trackingSystemRefId || null,
        primaryName: null,
        names: new Set<string>(),
        installedKwAc: null,
        installedKwDc: null,
        recPrice: null,
        totalContractAmount: null,
        annualRecs: null,
        recsOnContract: null,
        recsDeliveredQty: null,
        scheduleRequired: null,
        scheduleDelivered: null,
        latestGenerationDate: null,
        latestGenerationReadDate: null,
        latestGenerationReadWh: null,
        lastRecDeliveredGenerationDate: null,
        contractedDate: null,
        contractType: null,
        zillowStatus: null,
        zillowSoldDate: null,
        transferSeen: false,
        statusText: "",
        monitoringType: null,
        monitoringPlatform: null,
        installerName: null,
        part2VerificationDate: null,
      };

      builders.set(key, created);
      if (trackingSystemRefId) keyByTracking.set(trackingSystemRefId, key);
      if (systemId) keyBySystemId.set(systemId, key);
      return created;
    };

    const updateLatestGenerationRead = (builder: SystemBuilder, candidateDate: Date | null, candidateWh: number | null) => {
      if (!candidateDate || candidateWh === null) return;
      const existingTime = builder.latestGenerationReadDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      const candidateTime = candidateDate.getTime();
      if (candidateTime > existingTime || (candidateTime === existingTime && builder.latestGenerationReadWh === null)) {
        builder.latestGenerationReadDate = candidateDate;
        builder.latestGenerationReadWh = candidateWh;
      }
    };

    (datasets.solarApplications?.rows ?? []).forEach((row) => {
      const systemId = clean(row.system_id) || clean(row.Application_ID) || null;
      const stateApplicationRefId = resolveStateApplicationRefId(row);
      const trackingSystemRefId =
        clean(row.tracking_system_ref_id) ||
        clean(row.reporting_entity_ref_id) ||
        clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
        null;
      const builder = ensureBuilder(trackingSystemRefId, systemId);

      if (systemId) builder.systemId = systemId;
      if (stateApplicationRefId) builder.stateApplicationRefId = stateApplicationRefId;
      if (trackingSystemRefId) builder.trackingSystemRefId = trackingSystemRefId;

      const systemName = clean(row.system_name) || clean(row.Project_Name);
      if (systemName) {
        builder.names.add(systemName);
        if (!builder.primaryName) builder.primaryName = systemName;
      }

      const installed = firstNonNull(
        parseNumber(row.installed_system_size_kw_ac),
        parseNumber(row.planned_system_size_kw_ac),
        parseNumber(row["financialDetail.contract_kw_ac"]),
        parseNumber(row.Inverter_Size_kW_AC_Part_2),
        parseNumber(row.Inverter_Size_kW_AC_Part_1)
      );
      if (installed !== null) builder.installedKwAc = installed;

      const installedDc = firstNonNull(
        parseNumber(row.installed_system_size_kw_dc),
        parseNumber(row.planned_system_size_kw_dc),
        parseNumber(row["financialDetail.contract_kw_dc"]),
        parseNumber(row.Inverter_Size_kW_DC_Part_2),
        parseNumber(row.Inverter_Size_kW_DC_Part_1)
      );
      if (installedDc !== null) builder.installedKwDc = installedDc;

      const part2DateRaw = clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      const part2Date = parsePart2VerificationDate(part2DateRaw);
      if (part2Date && !builder.part2VerificationDate) builder.part2VerificationDate = part2Date;

      const recPrice = parseNumber(row.rec_price);
      if (recPrice !== null) builder.recPrice = recPrice;

      const totalContractAmount = parseNumber(row.total_contract_amount);
      if (totalContractAmount !== null) builder.totalContractAmount = totalContractAmount;

      const annualRecs = parseNumber(row.annual_recs);
      if (annualRecs !== null) builder.annualRecs = annualRecs;

      const recsOnContract = parseNumber(row.recs_on_contract);
      if (recsOnContract !== null) builder.recsOnContract = recsOnContract;

      const recsDeliveredQuantity = parseNumber(row.recs_delivered_quantity);
      if (recsDeliveredQuantity !== null) builder.recsDeliveredQty = recsDeliveredQuantity;

      if (builder.recsOnContract === null) {
        builder.recsOnContract = firstNonNull(
          parseNumber(row["_15_Year_REC_Estimate_MWh_PVWatts_Part_2"]),
          parseNumber(row["_15_Year_REC_Estimate_MWh_Custom_Part_2"]),
          parseNumber(row["_15_Year_REC_Estimate_MWh_Calculated_Part_1"]),
          parseNumber(row["_20_Year_REC_Estimate_MWh_PVWatts_Part_2"]),
          parseNumber(row["_20_Year_REC_Estimate_MWh_Custom_Part_2"]),
          parseNumber(row["_20_Year_REC_Estimate_MWh_Calculated_Part_1"])
        );
      }

      builder.lastRecDeliveredGenerationDate = maxDate(
        builder.lastRecDeliveredGenerationDate,
        parseDate(row.last_rec_delivered_generation_date)
      );

      builder.contractedDate = maxDate(
        builder.contractedDate,
        contractedBySystemId.get(systemId ?? "") ??
          parseDate(row.contract_execution_date) ??
          parseDate(row.contract_start_date) ??
          parseDate(row.Part_1_Submission_Date) ??
          parseDate(row.Part_1_Original_Submission_Date)
      );

      const contractType = clean(row.contract_type);
      if (contractType) {
        builder.contractType = contractType;
        if (isTransferredContractType(contractType)) {
          builder.transferSeen = true;
        }
      }

      const zillowStatus = clean(row["zillowData.status"]) || clean(row.Zillow_Status);
      if (zillowStatus) builder.zillowStatus = zillowStatus;

      builder.monitoringType = normalizeMonitoringMethod(
        row.online_monitoring_access_type,
        row.online_monitoring_entry_method,
        row.online_monitoring_self_report
      );
      builder.monitoringPlatform = normalizeMonitoringPlatform(
        row.online_monitoring,
        row.online_monitoring_website_api_link,
        row.online_monitoring_notes
      );

      const installerName = firstNonEmptyString(
        clean(row["partnerCompany.name"]),
        clean(row.installer_company_name),
        clean(row.installer_name),
        clean(row.system_installer),
        clean(row["lastInstallerUpdatedBy.name"])
      );
      if (installerName) builder.installerName = installerName;

      builder.zillowSoldDate = maxDate(
        builder.zillowSoldDate,
        parseDate(row["zillowData.last_price_action_date"]) ??
          parseDate(row.zillow_last_price_action_date) ??
          parseDate(row["zillowData.updated_at"])
      );

      const zillowEvent = clean(row["zillowData.last_price_action_event"]).toLowerCase();
      if (zillowEvent.includes("sold")) {
        builder.zillowStatus = builder.zillowStatus || "Sold";
      }

      const statusParts = [
        clean(row.contract_status),
        clean(row.contract_type),
        clean(row.internal_status),
        clean(row["project.status"]),
        clean(row.tracking_system_status),
        clean(row.Part_1_Status),
        clean(row.Part_2_Status),
        clean(row.Batch_Status),
      ].filter(Boolean);
      if (statusParts.length > 0) builder.statusText = statusParts.join(" | ");
    });

    // Set Part II verification date from ABP report rows onto matching builders.
    // The ABP report has Part_2_App_Verification_Date which solarApplications may not.
    abpReportRows.forEach((row) => {
      const systemId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (!systemId && !trackingId) return;

      const part2DateRaw = clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      const part2Date = parsePart2VerificationDate(part2DateRaw);
      if (!part2Date) return;

      // Find matching builder by systemId or trackingId
      const key = (trackingId ? keyByTracking.get(trackingId) : undefined) ??
        (systemId ? keyBySystemId.get(systemId) : undefined);
      if (!key) return;
      const builder = builders.get(key);
      if (builder && !builder.part2VerificationDate) {
        builder.part2VerificationDate = part2Date;
      }
    });

    // Phase 1a: obligations come exclusively from deliveryScheduleBase
    // (Schedule B scrape output). Deliveries come exclusively from
    // transferHistory, aggregated lifetime-total per tracking ID via
    // the shared buildTransferDeliveryLookup helper.
    const scheduleSourceRows = datasets.deliveryScheduleBase?.rows ?? [];
    const transferLookup = buildTransferDeliveryLookup(datasets.transferHistory?.rows ?? []);

    scheduleSourceRows.forEach((row) => {
      const trackingSystemRefId = clean(row.tracking_system_ref_id) || null;
      if (!trackingSystemRefId) return;
      const builder = ensureBuilder(trackingSystemRefId, null);

      const systemName = clean(row.system_name);
      if (systemName) {
        builder.names.add(systemName);
        if (!builder.primaryName) builder.primaryName = systemName;
      }

      const required = sumSchedule(row, "_quantity_required");
      if (required !== null) builder.scheduleRequired = required;

      // Delivered is always transferHistory-derived. No more fallback
      // to the (now-deleted) year{N}_quantity_delivered column on RDS.
      builder.scheduleDelivered = getDeliveredLifetime(transferLookup, trackingSystemRefId);
    });

    (datasets.accountSolarGeneration?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["GATS Gen ID"]) || null;
      if (!trackingSystemRefId) return;
      const builder = ensureBuilder(trackingSystemRefId, null);

      const systemName = clean(row["Facility Name"]);
      if (systemName) {
        builder.names.add(systemName);
        if (!builder.primaryName) builder.primaryName = systemName;
      }

      const monthOfGeneration = parseDate(row["Month of Generation"]);
      builder.latestGenerationDate = maxDate(builder.latestGenerationDate, monthOfGeneration);

      const latestMeterReadWh = parseEnergyToWh(resolveLastMeterReadRawValue(row), "Last Meter Read (kWh)", "kwh");
      const latestMeterReadDate = parseDate(row["Last Meter Read Date"]) ?? monthOfGeneration;
      updateLatestGenerationRead(builder, latestMeterReadDate, latestMeterReadWh);
    });

    (datasets.generationEntry?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["Unit ID"]) || null;
      if (!trackingSystemRefId) return;
      const builder = ensureBuilder(trackingSystemRefId, null);

      const systemName = clean(row["Facility Name"]);
      if (systemName) {
        builder.names.add(systemName);
        if (!builder.primaryName) builder.primaryName = systemName;
      }

      const lastMonthOfGen = parseDate(row["Last Month of Gen"]);
      builder.latestGenerationDate = maxDate(builder.latestGenerationDate, lastMonthOfGen);

      let latestReadWh: number | null = null;
      for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
        latestReadWh = parseEnergyToWh(row[header], header, "kwh");
        if (latestReadWh !== null) break;
      }
      const latestReadDate =
        parseDate(row["Last Meter Read Date"]) ??
        parseDate(row["Effective Date"]) ??
        parseDate(row["Month of Generation"]) ??
        lastMonthOfGen;
      updateLatestGenerationRead(builder, latestReadDate, latestReadWh);
    });

    const threshold = new Date();
    // Reporting is month-based, so use the first day of the month three months back.
    threshold.setHours(0, 0, 0, 0);
    threshold.setDate(1);
    threshold.setMonth(threshold.getMonth() - 3);

    return Array.from(builders.values())
      .map((builder) => {
        const latestReportingDate = maxDate(builder.latestGenerationDate, builder.lastRecDeliveredGenerationDate);
        const isReporting = latestReportingDate ? latestReportingDate >= threshold : false;

        const sizeBucket: SizeBucket =
          builder.installedKwAc === null
            ? "Unknown"
            : builder.installedKwAc <= 10
              ? "<=10 kW AC"
              : ">10 kW AC";

        const contractedRecs = firstNonNull(builder.scheduleRequired, builder.recsOnContract, builder.annualRecs);
        const deliveredRecs = firstNonNull(builder.scheduleDelivered, builder.recsDeliveredQty);

        const contractedValue =
          builder.recPrice !== null && contractedRecs !== null ? builder.recPrice * contractedRecs : null;
        const deliveredValue =
          builder.recPrice !== null && deliveredRecs !== null ? builder.recPrice * deliveredRecs : null;
        const valueGap =
          contractedValue !== null && deliveredValue !== null ? contractedValue - deliveredValue : null;
        const latestReportingKwh =
          builder.latestGenerationReadWh !== null ? Math.round((builder.latestGenerationReadWh / 1_000) * 1_000) / 1_000 : null;

        const isContractTransferred = isTransferredContractType(builder.contractType);
        const isContractTerminated = isTerminatedContractType(builder.contractType);
        const isTerminated = isContractTerminated;
        const zillowStatusNormalized = clean(builder.zillowStatus).toLowerCase();
        const isZillowSold = zillowStatusNormalized.includes("sold");
        const hasZillowConfirmedOwnershipChange =
          isZillowSold &&
          !!builder.zillowSoldDate &&
          !!builder.contractedDate &&
          builder.zillowSoldDate > builder.contractedDate;
        const hasChangedOwnership = isContractTransferred || isContractTerminated || hasZillowConfirmedOwnershipChange;

        let ownershipStatus: OwnershipStatus;
        if (isTerminated) {
          ownershipStatus = isReporting ? "Terminated and Reporting" : "Terminated and Not Reporting";
        } else if (builder.transferSeen || isContractTransferred) {
          ownershipStatus = isReporting ? "Transferred and Reporting" : "Transferred and Not Reporting";
        } else {
          ownershipStatus = isReporting ? "Not Transferred and Reporting" : "Not Transferred and Not Reporting";
        }

        let changeOwnershipStatus: ChangeOwnershipStatus | null = null;
        if (hasChangedOwnership) {
          if (isContractTransferred) {
            changeOwnershipStatus = isReporting ? "Transferred and Reporting" : "Transferred and Not Reporting";
          } else if (isContractTerminated) {
            changeOwnershipStatus = isReporting ? "Terminated and Reporting" : "Terminated and Not Reporting";
          } else {
            changeOwnershipStatus = isReporting
              ? "Change of Ownership - Not Transferred and Reporting"
              : "Change of Ownership - Not Transferred and Not Reporting";
          }
        }

        const fallbackName = builder.names.values().next().value;
        const systemName = builder.primaryName || fallbackName || builder.trackingSystemRefId || builder.key;

        return {
          key: builder.key,
          systemId: builder.systemId,
          stateApplicationRefId: builder.stateApplicationRefId,
          trackingSystemRefId: builder.trackingSystemRefId,
          systemName,
          installedKwAc: builder.installedKwAc,
          installedKwDc: builder.installedKwDc,
          sizeBucket,
          recPrice: builder.recPrice,
          totalContractAmount: builder.totalContractAmount,
          contractedRecs,
          deliveredRecs,
          contractedValue,
          deliveredValue,
          valueGap,
          latestReportingDate,
          latestReportingKwh,
          isReporting,
          isTerminated,
          isTransferred: builder.transferSeen,
          ownershipStatus,
          hasChangedOwnership,
          changeOwnershipStatus,
          contractStatusText: builder.statusText || "N/A",
          contractType: builder.contractType,
          zillowStatus: builder.zillowStatus,
          zillowSoldDate: builder.zillowSoldDate,
          contractedDate: builder.contractedDate,
          monitoringType: builder.monitoringType || "Unknown",
          monitoringPlatform: builder.monitoringPlatform || "Unknown",
          installerName: builder.installerName || "Unknown",
          part2VerificationDate: builder.part2VerificationDate,
        } satisfies SystemRecord;
      })
      .filter((system) => {
        const bySystemId = system.systemId ? eligibleAbpSystemIds.has(system.systemId) : false;
        const byTrackingId = system.trackingSystemRefId
          ? eligibleAbpTrackingIds.has(system.trackingSystemRefId)
          : false;
        const byName = eligibleAbpNames.has(system.systemName.toLowerCase());
        if (system.systemId || system.trackingSystemRefId) {
          return bySystemId || byTrackingId;
        }
        return byName;
      })
      .sort((a, b) => a.systemName.localeCompare(b.systemName));
  }, [datasets, part2VerifiedAbpRows]);

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

  const overviewPart2Totals = useMemo(() => {
    const totalContractedValuePart2 = part2EligibleSystemsForSizeReporting.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0
    );
    const cumulativeKwAcPart2 = part2EligibleSystemsForSizeReporting.reduce(
      (sum, system) => sum + (system.installedKwAc ?? 0),
      0
    );
    const cumulativeKwDcPart2 = part2EligibleSystemsForSizeReporting.reduce(
      (sum, system) => sum + (system.installedKwDc ?? 0),
      0
    );

    return {
      totalContractedValuePart2,
      cumulativeKwAcPart2,
      cumulativeKwDcPart2,
    };
  }, [part2EligibleSystemsForSizeReporting]);

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

  const sizeTabNotReportingPart2Rows = useMemo(() => {
    return part2EligibleSystemsForSizeReporting
      .filter((system) => !system.isReporting)
      .sort((a, b) => a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }));
  }, [part2EligibleSystemsForSizeReporting]);

  const sizeSiteListTotalPages = Math.max(
    1,
    Math.ceil(sizeTabNotReportingPart2Rows.length / SIZE_SITE_LIST_PAGE_SIZE)
  );
  const sizeSiteListCurrentPage = Math.min(sizeSiteListPage, sizeSiteListTotalPages);
  const sizeSiteListPageStartIndex = (sizeSiteListCurrentPage - 1) * SIZE_SITE_LIST_PAGE_SIZE;
  const sizeSiteListPageEndIndex = sizeSiteListPageStartIndex + SIZE_SITE_LIST_PAGE_SIZE;
  const visibleSizeSiteListRows = useMemo(
    () => sizeTabNotReportingPart2Rows.slice(sizeSiteListPageStartIndex, sizeSiteListPageEndIndex),
    [sizeTabNotReportingPart2Rows, sizeSiteListPageStartIndex, sizeSiteListPageEndIndex]
  );

  const recValueRows = useMemo(
    () =>
      part2EligibleSystemsForSizeReporting
        .filter((system) => resolveContractValueAmount(system) > 0 || (system.deliveredValue ?? 0) > 0)
        .sort((a, b) => resolveValueGapAmount(b) - resolveValueGapAmount(a)),
    [part2EligibleSystemsForSizeReporting]
  );
  const recValueTotalPages = Math.max(1, Math.ceil(recValueRows.length / REC_VALUE_PAGE_SIZE));
  const recValueCurrentPage = Math.min(recValuePage, recValueTotalPages);
  const recValuePageStartIndex = (recValueCurrentPage - 1) * REC_VALUE_PAGE_SIZE;
  const recValuePageEndIndex = recValuePageStartIndex + REC_VALUE_PAGE_SIZE;
  const visibleRecValueRows = useMemo(
    () => recValueRows.slice(recValuePageStartIndex, recValuePageEndIndex),
    [recValuePageEndIndex, recValuePageStartIndex, recValueRows]
  );

  const filteredOwnershipRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return part2EligibleSystemsForSizeReporting.filter((system) => {
      const matchesFilter = ownershipFilter === "All" ? true : system.ownershipStatus === ownershipFilter;
      if (!matchesFilter) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.contractStatusText,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [ownershipFilter, part2EligibleSystemsForSizeReporting, searchTerm]);

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

      const nonTerminatedSystems = Array.from(matchedSystems.values()).filter((system) => !system.isTerminated);
      if (nonTerminatedSystems.length === 0) return;

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

  const changeOwnershipSummary = useMemo(() => {
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
    const counts = CHANGE_OWNERSHIP_ORDER.map((status) => ({
      status,
      count: changeOwnershipRows.filter((system) => system.changeOwnershipStatus === status).length,
      percent: toPercentValue(
        changeOwnershipRows.filter((system) => system.changeOwnershipStatus === status).length,
        total
      ),
    }));
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

  const filteredChangeOwnershipRows = useMemo(() => {
    const normalizedSearch = changeOwnershipSearch.trim().toLowerCase();
    const rows = changeOwnershipRows.filter((system) => {
      const matchesFilter =
        changeOwnershipFilter === "All" ? true : system.changeOwnershipStatus === changeOwnershipFilter;
      if (!matchesFilter) return false;
      if (!normalizedSearch) return true;

      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.contractType ?? "",
        system.zillowStatus ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });

    const direction = changeOwnershipSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const byName =
        a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction;

      if (changeOwnershipSortBy === "systemName") return byName;
      if (changeOwnershipSortBy === "status") {
        const aStatus = a.changeOwnershipStatus ?? "";
        const bStatus = b.changeOwnershipStatus ?? "";
        const diff =
          aStatus.localeCompare(bStatus, undefined, { sensitivity: "base", numeric: true }) * direction;
        return diff === 0 ? byName : diff;
      }
      if (changeOwnershipSortBy === "reporting") {
        const aValue = a.isReporting ? 1 : 0;
        const bValue = b.isReporting ? 1 : 0;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "contractValue") {
        const aValue = resolveContractValueAmount(a);
        const bValue = resolveContractValueAmount(b);
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "installedKwAc") {
        const aValue = a.installedKwAc ?? Number.NEGATIVE_INFINITY;
        const bValue = b.installedKwAc ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }
      if (changeOwnershipSortBy === "contractDate") {
        const aValue = a.contractedDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bValue = b.contractedDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) return byName;
        return (aValue - bValue) * direction;
      }

      const aValue = a.zillowSoldDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bValue = b.zillowSoldDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aValue === bValue) return byName;
      return (aValue - bValue) * direction;
    });

    return rows;
  }, [
    changeOwnershipFilter,
    changeOwnershipRows,
    changeOwnershipSearch,
    changeOwnershipSortBy,
    changeOwnershipSortDir,
  ]);

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

  const offlineBaseSystems = useMemo(
    () => {
      if (!isOfflineTabActive) return [] as SystemRecord[];
      return part2EligibleSystemsForSizeReporting.filter(
        (system) =>
          !!system.trackingSystemRefId &&
          abpEligibleTrackingIdsStrict.has(system.trackingSystemRefId)
      );
    },
    [abpEligibleTrackingIdsStrict, isOfflineTabActive, part2EligibleSystemsForSizeReporting]
  );

  const offlineSystems = useMemo(
    () => offlineBaseSystems.filter((system) => !system.isReporting),
    [offlineBaseSystems]
  );

  const offlineMonitoringOptions = useMemo(
    () => {
      if (!isOfflineTabActive) return [] as string[];
      return Array.from(new Set(offlineBaseSystems.map((system) => system.monitoringType || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      );
    },
    [isOfflineTabActive, offlineBaseSystems]
  );

  const offlinePlatformOptions = useMemo(
    () => {
      if (!isOfflineTabActive) return [] as string[];
      return Array.from(new Set(offlineBaseSystems.map((system) => system.monitoringPlatform || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      );
    },
    [isOfflineTabActive, offlineBaseSystems]
  );

  const offlineInstallerOptions = useMemo(
    () => {
      if (!isOfflineTabActive) return [] as string[];
      return Array.from(new Set(offlineBaseSystems.map((system) => system.installerName || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      );
    },
    [isOfflineTabActive, offlineBaseSystems]
  );

  const offlineMonitoringBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
    if (!isOfflineTabActive) return [];
    const groups = new Map<
      string,
      { label: string; totalSystems: number; offlineSystems: number; totalContractValue: number; offlineContractValue: number }
    >();

    offlineBaseSystems.forEach((system) => {
      const label = system.monitoringType || "Unknown";
      let current = groups.get(label);
      if (!current) {
        current = { label, totalSystems: 0, offlineSystems: 0, totalContractValue: 0, offlineContractValue: 0 };
        groups.set(label, current);
      }
      current.totalSystems += 1;
      current.totalContractValue += resolveContractValueAmount(system);
      if (!system.isReporting) {
        current.offlineSystems += 1;
        current.offlineContractValue += resolveContractValueAmount(system);
      }
    });

    const rows = Array.from(groups.values()).map((group) => ({
      key: group.label,
      label: group.label,
      totalSystems: group.totalSystems,
      offlineSystems: group.offlineSystems,
      offlinePercent: toPercentValue(group.offlineSystems, group.totalSystems),
      offlineContractValue: group.offlineContractValue,
      totalContractValue: group.totalContractValue,
      offlineContractValuePercent: toPercentValue(group.offlineContractValue, group.totalContractValue),
    }));

    rows.sort((a, b) => {
      const direction = offlineMonitoringSortDir === "asc" ? 1 : -1;
      const byLabel =
        a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) * direction;
      if (offlineMonitoringSortBy === "label") return byLabel;
      const aValue = a[offlineMonitoringSortBy] ?? -Infinity;
      const bValue = b[offlineMonitoringSortBy] ?? -Infinity;
      if (aValue === bValue) return byLabel;
      return ((aValue as number) - (bValue as number)) * direction;
    });
    return rows;
  }, [isOfflineTabActive, offlineMonitoringSortBy, offlineMonitoringSortDir, offlineBaseSystems]);

  const offlineInstallerBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
    if (!isOfflineTabActive) return [];
    const groups = new Map<
      string,
      { label: string; totalSystems: number; offlineSystems: number; totalContractValue: number; offlineContractValue: number }
    >();

    offlineBaseSystems.forEach((system) => {
      const label = system.installerName || "Unknown";
      let current = groups.get(label);
      if (!current) {
        current = { label, totalSystems: 0, offlineSystems: 0, totalContractValue: 0, offlineContractValue: 0 };
        groups.set(label, current);
      }
      current.totalSystems += 1;
      current.totalContractValue += resolveContractValueAmount(system);
      if (!system.isReporting) {
        current.offlineSystems += 1;
        current.offlineContractValue += resolveContractValueAmount(system);
      }
    });

    const rows = Array.from(groups.values()).map((group) => ({
      key: group.label,
      label: group.label,
      totalSystems: group.totalSystems,
      offlineSystems: group.offlineSystems,
      offlinePercent: toPercentValue(group.offlineSystems, group.totalSystems),
      offlineContractValue: group.offlineContractValue,
      totalContractValue: group.totalContractValue,
      offlineContractValuePercent: toPercentValue(group.offlineContractValue, group.totalContractValue),
    }));

    rows.sort((a, b) => {
      const direction = offlineInstallerSortDir === "asc" ? 1 : -1;
      const byLabel =
        a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) * direction;
      if (offlineInstallerSortBy === "label") return byLabel;
      const aValue = a[offlineInstallerSortBy] ?? -Infinity;
      const bValue = b[offlineInstallerSortBy] ?? -Infinity;
      if (aValue === bValue) return byLabel;
      return ((aValue as number) - (bValue as number)) * direction;
    });
    return rows;
  }, [isOfflineTabActive, offlineInstallerSortBy, offlineInstallerSortDir, offlineBaseSystems]);

  const offlinePlatformBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
    if (!isOfflineTabActive) return [];
    const groups = new Map<
      string,
      { label: string; totalSystems: number; offlineSystems: number; totalContractValue: number; offlineContractValue: number }
    >();

    offlineBaseSystems.forEach((system) => {
      const label = system.monitoringPlatform || "Unknown";
      let current = groups.get(label);
      if (!current) {
        current = { label, totalSystems: 0, offlineSystems: 0, totalContractValue: 0, offlineContractValue: 0 };
        groups.set(label, current);
      }
      current.totalSystems += 1;
      current.totalContractValue += resolveContractValueAmount(system);
      if (!system.isReporting) {
        current.offlineSystems += 1;
        current.offlineContractValue += resolveContractValueAmount(system);
      }
    });

    const rows = Array.from(groups.values()).map((group) => ({
      key: group.label,
      label: group.label,
      totalSystems: group.totalSystems,
      offlineSystems: group.offlineSystems,
      offlinePercent: toPercentValue(group.offlineSystems, group.totalSystems),
      offlineContractValue: group.offlineContractValue,
      totalContractValue: group.totalContractValue,
      offlineContractValuePercent: toPercentValue(group.offlineContractValue, group.totalContractValue),
    }));

    rows.sort((a, b) => {
      const direction = offlinePlatformSortDir === "asc" ? 1 : -1;
      const byLabel =
        a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) * direction;
      if (offlinePlatformSortBy === "label") return byLabel;
      const aValue = a[offlinePlatformSortBy] ?? -Infinity;
      const bValue = b[offlinePlatformSortBy] ?? -Infinity;
      if (aValue === bValue) return byLabel;
      return ((aValue as number) - (bValue as number)) * direction;
    });
    return rows;
  }, [isOfflineTabActive, offlinePlatformSortBy, offlinePlatformSortDir, offlineBaseSystems]);

  const filteredOfflineSystems = useMemo(() => {
    if (!isOfflineTabActive) return [] as SystemRecord[];
    const normalizedSearch = offlineSearch.trim().toLowerCase();
    const rows = offlineSystems.filter((system) => {
      const monitoringMatch =
        offlineMonitoringFilter === "All" ? true : system.monitoringType === offlineMonitoringFilter;
      if (!monitoringMatch) return false;
      const platformMatch =
        offlinePlatformFilter === "All" ? true : system.monitoringPlatform === offlinePlatformFilter;
      if (!platformMatch) return false;
      const installerMatch = offlineInstallerFilter === "All" ? true : system.installerName === offlineInstallerFilter;
      if (!installerMatch) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        system.systemName,
        system.systemId ?? "",
        system.trackingSystemRefId ?? "",
        system.monitoringType,
        system.monitoringPlatform,
        system.installerName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });

    rows.sort((a, b) => {
      const direction = offlineDetailSortDir === "asc" ? 1 : -1;
      if (offlineDetailSortBy === "systemName") {
        return (
          a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
        );
      }
      if (offlineDetailSortBy === "monitoringType") {
        return (
          a.monitoringType.localeCompare(b.monitoringType, undefined, { sensitivity: "base", numeric: true }) *
          direction
        );
      }
      if (offlineDetailSortBy === "monitoringPlatform") {
        return (
          a.monitoringPlatform.localeCompare(b.monitoringPlatform, undefined, { sensitivity: "base", numeric: true }) *
          direction
        );
      }
      if (offlineDetailSortBy === "installerName") {
        return (
          a.installerName.localeCompare(b.installerName, undefined, { sensitivity: "base", numeric: true }) *
          direction
        );
      }
      if (offlineDetailSortBy === "latestReportingDate") {
        const aTime = a.latestReportingDate?.getTime() ?? -Infinity;
        const bTime = b.latestReportingDate?.getTime() ?? -Infinity;
        if (aTime === bTime) {
          return (
            a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
          );
        }
        return (aTime - bTime) * direction;
      }
      const aValue = resolveContractValueAmount(a);
      const bValue = resolveContractValueAmount(b);
      if (aValue === bValue) {
        return (
          a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
        );
      }
      return (aValue - bValue) * direction;
    });
    return rows;
  }, [
    isOfflineTabActive,
    offlineDetailSortBy,
    offlineDetailSortDir,
    offlineInstallerFilter,
    offlineMonitoringFilter,
    offlinePlatformFilter,
    offlineSearch,
    offlineSystems,
  ]);

  const offlineSummary = useMemo(() => {
    if (!isOfflineTabActive) {
      return {
        offlineSystemCount: 0,
        offlineSystemPercent: null,
        filteredOfflineCount: 0,
        monitoringTypeCount: 0,
        monitoringPlatformCount: 0,
        installerCount: 0,
        totalOfflineContractValue: 0,
        totalPortfolioContractValue: 0,
        offlineContractValuePercent: null,
      };
    }
    const totalOfflineContractValue = offlineSystems.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0
    );
    const totalPortfolioContractValue = offlineBaseSystems.reduce(
      (sum, system) => sum + resolveContractValueAmount(system),
      0
    );
    return {
      offlineSystemCount: offlineSystems.length,
      offlineSystemPercent: toPercentValue(offlineSystems.length, offlineBaseSystems.length),
      filteredOfflineCount: filteredOfflineSystems.length,
      monitoringTypeCount: offlineMonitoringBreakdownRows.length,
      monitoringPlatformCount: offlinePlatformBreakdownRows.length,
      installerCount: offlineInstallerBreakdownRows.length,
      totalOfflineContractValue,
      totalPortfolioContractValue,
      offlineContractValuePercent: toPercentValue(totalOfflineContractValue, totalPortfolioContractValue),
    };
  }, [
    filteredOfflineSystems.length,
    isOfflineTabActive,
    offlineInstallerBreakdownRows.length,
    offlineMonitoringBreakdownRows.length,
    offlinePlatformBreakdownRows.length,
    offlineBaseSystems,
    offlineSystems,
  ]);

  useEffect(() => {
    setOfflineDetailPage(1);
  }, [
    offlineDetailSortBy,
    offlineDetailSortDir,
    offlineInstallerFilter,
    offlineMonitoringFilter,
    offlinePlatformFilter,
    offlineSearch,
  ]);

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

  const annualProductionByTrackingId = useMemo(() => {
    if (!isPerformanceRatioTabActive && !isForecastTabActive) return new Map<string, AnnualProductionProfile>();
    const mapping = new Map<string, AnnualProductionProfile>();

    (datasets.annualProductionEstimates?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["Unit ID"]) || clean(row.unit_id);
      if (!trackingSystemRefId) return;

      const monthlyKwh = MONTH_HEADERS.map((month) => parseNumber(row[month] ?? row[month.toLowerCase()]) ?? 0);
      const current = mapping.get(trackingSystemRefId);
      if (!current) {
        mapping.set(trackingSystemRefId, {
          trackingSystemRefId,
          facilityName: clean(row.Facility) || clean(row["Facility Name"]),
          monthlyKwh,
        });
        return;
      }

      const mergedMonthly = current.monthlyKwh.map((value, index) => {
        const candidate = monthlyKwh[index] ?? 0;
        return candidate > 0 ? candidate : value;
      });
      mapping.set(trackingSystemRefId, {
        trackingSystemRefId,
        facilityName: current.facilityName || clean(row.Facility) || clean(row["Facility Name"]),
        monthlyKwh: mergedMonthly,
      });
    });

    return mapping;
  }, [datasets.annualProductionEstimates, isPerformanceRatioTabActive, isForecastTabActive]);

  const generatorDateOnlineByTrackingId = useMemo(() => {
    if (!isPerformanceRatioTabActive) return new Map<string, Date>();
    const mapping = new Map<string, Date>();

    (datasets.generatorDetails?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["GATS Unit ID"]) || clean(row.gats_unit_id) || clean(row["Unit ID"]);
      if (!trackingSystemRefId) return;
      const dateOnline =
        parseDateOnlineAsMidMonth(row["Date Online"] ?? row["Date online"] ?? row.date_online ?? row.date_online_month_year);
      if (!dateOnline) return;

      const existing = mapping.get(trackingSystemRefId);
      if (!existing || dateOnline < existing) {
        mapping.set(trackingSystemRefId, dateOnline);
      }
    });

    return mapping;
  }, [datasets.generatorDetails, isPerformanceRatioTabActive]);

  const generationBaselineByTrackingId = useMemo(() => {
    if (!isPerformanceRatioTabActive && !isForecastTabActive) return new Map<string, GenerationBaseline>();
    const mapping = new Map<string, GenerationBaseline>();

    const updateBaseline = (
      trackingSystemRefId: string,
      candidate: GenerationBaseline
    ) => {
      const existing = mapping.get(trackingSystemRefId);
      if (!existing) {
        mapping.set(trackingSystemRefId, candidate);
        return;
      }

      const existingTime = existing.date?.getTime() ?? Number.NEGATIVE_INFINITY;
      const candidateTime = candidate.date?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (candidateTime > existingTime) {
        mapping.set(trackingSystemRefId, candidate);
        return;
      }
      if (candidateTime === existingTime) {
        const existingRank = existing.source === "Generation Entry" ? 2 : 1;
        const candidateRank = candidate.source === "Generation Entry" ? 2 : 1;
        if (candidateRank > existingRank) {
          mapping.set(trackingSystemRefId, candidate);
        }
      }
    };

    (datasets.generationEntry?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["Unit ID"]);
      if (!trackingSystemRefId) return;

      let valueWh: number | null = null;
      for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
        valueWh = parseEnergyToWh(row[header], header, "kwh");
        if (valueWh !== null) break;
      }
      if (valueWh === null) return;

      let date: Date | null = null;
      for (const header of GENERATION_BASELINE_DATE_HEADERS) {
        date = parseDate(row[header]);
        if (date) break;
      }

      updateBaseline(trackingSystemRefId, {
        valueWh,
        date,
        source: "Generation Entry",
      });
    });

    (datasets.accountSolarGeneration?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row["GATS Gen ID"]);
      if (!trackingSystemRefId) return;

      const valueWh = parseEnergyToWh(
        resolveLastMeterReadRawValue(row),
        "Last Meter Read (kWh)",
        "kwh"
      );
      if (valueWh === null) return;

      const date = parseDate(row["Last Meter Read Date"]) ?? parseDate(row["Month of Generation"]);
      updateBaseline(trackingSystemRefId, {
        valueWh,
        date,
        source: "Account Solar Generation",
      });
    });

    return mapping;
  }, [datasets.accountSolarGeneration, datasets.generationEntry, isPerformanceRatioTabActive, isForecastTabActive]);

  const portalMonitoringCandidates = useMemo<PortalMonitoringCandidate[]>(() => {
    if (!isPerformanceRatioTabActive) return [];
    return part2EligibleSystemsForSizeReporting
      .filter((system) => !!system.trackingSystemRefId)
      .map((system) => {
        const details = getMonitoringDetailsForSystem(system, monitoringDetailsBySystemKey);
        const normalizedPlatform = normalizeMonitoringPlatform(
          details?.online_monitoring ?? system.monitoringPlatform,
          details?.online_monitoring_website_api_link ?? "",
          details?.online_monitoring_notes ?? ""
        );

        const monitoringTokens = uniqueNonEmpty([
          normalizeMonitoringMatch(system.monitoringPlatform),
          normalizeMonitoringMatch(details?.online_monitoring),
          normalizeMonitoringMatch(normalizedPlatform),
        ]);

        const idTokens = uniqueNonEmpty([
          ...splitRawCandidates(details?.online_monitoring_system_id ?? "").map((value) => normalizeSystemIdMatch(value)),
          normalizeSystemIdMatch(system.systemId),
        ]);

        const nameTokens = uniqueNonEmpty([
          ...splitRawCandidates(details?.online_monitoring_system_name ?? "").map((value) =>
            normalizeSystemNameMatch(value)
          ),
          normalizeSystemNameMatch(system.systemName),
        ]);

        return {
          key: system.key,
          system,
          monitoringTokens,
          idTokens,
          nameTokens,
        } satisfies PortalMonitoringCandidate;
      });
  }, [isPerformanceRatioTabActive, monitoringDetailsBySystemKey, part2EligibleSystemsForSizeReporting]);

  const performanceRatioMatchIndexes = useMemo(() => {
    if (!isPerformanceRatioTabActive) {
      return {
        byMonitoringAndId: new Map<string, Set<string>>(),
        byMonitoringAndName: new Map<string, Set<string>>(),
        byMonitoringAndIdAndName: new Map<string, Set<string>>(),
        candidateByKey: new Map<string, PortalMonitoringCandidate>(),
      };
    }
    const byMonitoringAndId = new Map<string, Set<string>>();
    const byMonitoringAndName = new Map<string, Set<string>>();
    const byMonitoringAndIdAndName = new Map<string, Set<string>>();
    const candidateByKey = new Map<string, PortalMonitoringCandidate>();

    const add = (map: Map<string, Set<string>>, key: string, candidateKey: string) => {
      if (!key) return;
      const current = map.get(key);
      if (current) {
        current.add(candidateKey);
        return;
      }
      map.set(key, new Set([candidateKey]));
    };

    portalMonitoringCandidates.forEach((candidate) => {
      candidateByKey.set(candidate.key, candidate);

      candidate.monitoringTokens.forEach((monitoringToken) => {
        candidate.idTokens.forEach((idToken) => {
          add(byMonitoringAndId, `${monitoringToken}__${idToken}`, candidate.key);
        });
        candidate.nameTokens.forEach((nameToken) => {
          add(byMonitoringAndName, `${monitoringToken}__${nameToken}`, candidate.key);
        });
        candidate.idTokens.forEach((idToken) => {
          candidate.nameTokens.forEach((nameToken) => {
            add(byMonitoringAndIdAndName, `${monitoringToken}__${idToken}__${nameToken}`, candidate.key);
          });
        });
      });
    });

    return { byMonitoringAndId, byMonitoringAndName, byMonitoringAndIdAndName, candidateByKey };
  }, [isPerformanceRatioTabActive, portalMonitoringCandidates]);

  const convertedReadRows = useMemo<ConvertedReadInputRow[]>(() => {
    if (!isPerformanceRatioTabActive) return [];
    return (datasets.convertedReads?.rows ?? []).map((row, index) => {
      const monitoring = clean(row.monitoring);
      const monitoringSystemId = clean(row.monitoring_system_id);
      const monitoringSystemName = clean(row.monitoring_system_name);
      const readDateRaw = clean(row.read_date);
      return {
        key: `converted-${index}`,
        monitoring,
        monitoringNormalized: normalizeMonitoringMatch(monitoring),
        monitoringSystemId,
        monitoringSystemIdNormalized: normalizeSystemIdMatch(monitoringSystemId),
        monitoringSystemName,
        monitoringSystemNameNormalized: normalizeSystemNameMatch(monitoringSystemName),
        lifetimeReadWh: parseEnergyToWh(row.lifetime_meter_read_wh, "lifetime_meter_read_wh", "wh"),
        readDate: parseDate(readDateRaw),
        readDateRaw,
      };
    });
  }, [datasets.convertedReads, isPerformanceRatioTabActive]);

  const performanceRatioResult = useMemo(() => {
    if (!isPerformanceRatioTabActive) {
      return {
        rows: [] as PerformanceRatioRow[],
        convertedReadCount: 0,
        matchedConvertedReads: 0,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      };
    }
    const rows: PerformanceRatioRow[] = [];
    let matchedConvertedReads = 0;
    let unmatchedConvertedReads = 0;
    let invalidConvertedReads = 0;

    convertedReadRows.forEach((readRow) => {
      if (
        !readRow.monitoringNormalized ||
        readRow.lifetimeReadWh === null ||
        (!readRow.monitoringSystemIdNormalized && !readRow.monitoringSystemNameNormalized)
      ) {
        invalidConvertedReads += 1;
        return;
      }

      const bothMatches =
        readRow.monitoringSystemIdNormalized && readRow.monitoringSystemNameNormalized
          ? performanceRatioMatchIndexes.byMonitoringAndIdAndName.get(
              `${readRow.monitoringNormalized}__${readRow.monitoringSystemIdNormalized}__${readRow.monitoringSystemNameNormalized}`
            ) ?? new Set<string>()
          : new Set<string>();

      const idMatches = readRow.monitoringSystemIdNormalized
        ? performanceRatioMatchIndexes.byMonitoringAndId.get(
            `${readRow.monitoringNormalized}__${readRow.monitoringSystemIdNormalized}`
          ) ?? new Set<string>()
        : new Set<string>();

      const nameMatches = readRow.monitoringSystemNameNormalized
        ? performanceRatioMatchIndexes.byMonitoringAndName.get(
            `${readRow.monitoringNormalized}__${readRow.monitoringSystemNameNormalized}`
          ) ?? new Set<string>()
        : new Set<string>();

      const matchedCandidateKeys = new Set<string>([
        ...Array.from(bothMatches.values()),
        ...Array.from(idMatches.values()),
        ...Array.from(nameMatches.values()),
      ]);

      if (matchedCandidateKeys.size === 0) {
        unmatchedConvertedReads += 1;
        return;
      }
      matchedConvertedReads += 1;

      matchedCandidateKeys.forEach((candidateKey) => {
        const candidate = performanceRatioMatchIndexes.candidateByKey.get(candidateKey);
        if (!candidate || !candidate.system.trackingSystemRefId) return;

        const baseline = generationBaselineByTrackingId.get(candidate.system.trackingSystemRefId);
        const generatorDateOnline = generatorDateOnlineByTrackingId.get(candidate.system.trackingSystemRefId) ?? null;
        const baselineValueWh = baseline?.valueWh ?? (generatorDateOnline ? 0 : null);
        const baselineDate = baseline?.date ?? generatorDateOnline;
        const baselineSource =
          baseline?.source ?? (generatorDateOnline ? "Generator Details (Date Online @ day 15, baseline 0)" : null);
        const annualProfile = annualProductionByTrackingId.get(candidate.system.trackingSystemRefId);
        const productionDeltaWh =
          readRow.lifetimeReadWh !== null && baselineValueWh !== null
            ? readRow.lifetimeReadWh - baselineValueWh
            : null;
        const expectedProductionWh =
          baselineDate && readRow.readDate && annualProfile
            ? calculateExpectedWhForRange(annualProfile.monthlyKwh, baselineDate, readRow.readDate)
            : null;
        const performanceRatioPercent =
          productionDeltaWh !== null && expectedProductionWh !== null && expectedProductionWh > 0
            ? (productionDeltaWh / expectedProductionWh) * 100
            : null;

        const matchType: PerformanceRatioMatchType = bothMatches.has(candidateKey)
          ? "Monitoring + System ID + System Name"
          : idMatches.has(candidateKey)
            ? "Monitoring + System ID"
            : "Monitoring + System Name";

        rows.push({
          key: `${readRow.key}-${candidateKey}-${rows.length + 1}`,
          convertedReadKey: readRow.key,
          matchType,
          monitoring: readRow.monitoring,
          monitoringSystemId: readRow.monitoringSystemId,
          monitoringSystemName: readRow.monitoringSystemName,
          readDate: readRow.readDate,
          readDateRaw: readRow.readDateRaw,
          lifetimeReadWh: readRow.lifetimeReadWh,
          trackingSystemRefId: candidate.system.trackingSystemRefId,
          systemId: candidate.system.systemId,
          stateApplicationRefId: candidate.system.stateApplicationRefId,
          systemName: candidate.system.systemName,
          installerName: candidate.system.installerName,
          monitoringPlatform: candidate.system.monitoringPlatform,
          portalAcSizeKw: candidate.system.installedKwAc,
          abpAcSizeKw: candidate.system.stateApplicationRefId
            ? abpAcSizeKwByApplicationId.get(candidate.system.stateApplicationRefId) ?? null
            : null,
          part2VerificationDate:
            candidate.system.stateApplicationRefId
              ? abpPart2VerificationDateByApplicationId.get(candidate.system.stateApplicationRefId) ?? null
              : null,
          baselineReadWh: baselineValueWh,
          baselineDate,
          baselineSource,
          productionDeltaWh,
          expectedProductionWh,
          performanceRatioPercent,
          contractValue: resolveContractValueAmount(candidate.system),
        });
      });
    });

    rows.sort((a, b) => {
      const aTime = a.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bTime = b.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aTime !== bTime) return bTime - aTime;
      const aRatio = a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
      const bRatio = b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
      if (aRatio !== bRatio) return bRatio - aRatio;
      return a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true });
    });

    return {
      rows,
      convertedReadCount: convertedReadRows.length,
      matchedConvertedReads,
      unmatchedConvertedReads,
      invalidConvertedReads,
    };
  }, [
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId,
    annualProductionByTrackingId,
    convertedReadRows,
    generatorDateOnlineByTrackingId,
    generationBaselineByTrackingId,
    isPerformanceRatioTabActive,
    performanceRatioMatchIndexes,
  ]);

  const performanceRatioMonitoringOptions = useMemo(
    () =>
      Array.from(new Set(performanceRatioResult.rows.map((row) => row.monitoring)))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })),
    [performanceRatioResult.rows]
  );

  const filteredPerformanceRatioRows = useMemo(() => {
    const search = performanceRatioSearch.trim().toLowerCase();

    const rows = performanceRatioResult.rows.filter((row) => {
      if (performanceRatioMonitoringFilter !== "All" && row.monitoring !== performanceRatioMonitoringFilter) return false;
      if (performanceRatioMatchFilter !== "All" && row.matchType !== performanceRatioMatchFilter) return false;
      if (!search) return true;
      const haystack = [
        row.systemName,
        row.systemId ?? "",
        row.trackingSystemRefId,
        row.monitoring,
        row.monitoringSystemId,
        row.monitoringSystemName,
        row.installerName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });

    rows.sort((a, b) => {
      const direction = performanceRatioSortDir === "asc" ? 1 : -1;
      if (performanceRatioSortBy === "systemName") {
        return (
          a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
        );
      }
      if (performanceRatioSortBy === "readDate") {
        const aValue = a.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bValue = b.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (aValue === bValue) {
          return (
            a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
          );
        }
        return (aValue - bValue) * direction;
      }

      const aValue = a[performanceRatioSortBy] ?? Number.NEGATIVE_INFINITY;
      const bValue = b[performanceRatioSortBy] ?? Number.NEGATIVE_INFINITY;
      if (aValue === bValue) {
        return (
          a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }) * direction
        );
      }
      return ((aValue as number) - (bValue as number)) * direction;
    });

    return rows;
  }, [
    performanceRatioSearch,
    performanceRatioResult.rows,
    performanceRatioMonitoringFilter,
    performanceRatioMatchFilter,
    performanceRatioSortBy,
    performanceRatioSortDir,
  ]);

  const performanceRatioTotalPages = Math.max(
    1,
    Math.ceil(filteredPerformanceRatioRows.length / PERFORMANCE_RATIO_PAGE_SIZE)
  );
  const performanceRatioCurrentPage = Math.min(performanceRatioPage, performanceRatioTotalPages);
  const performanceRatioPageStartIndex = (performanceRatioCurrentPage - 1) * PERFORMANCE_RATIO_PAGE_SIZE;
  const performanceRatioPageEndIndex = performanceRatioPageStartIndex + PERFORMANCE_RATIO_PAGE_SIZE;
  const visiblePerformanceRatioRows = useMemo(
    () => filteredPerformanceRatioRows.slice(performanceRatioPageStartIndex, performanceRatioPageEndIndex),
    [filteredPerformanceRatioRows, performanceRatioPageEndIndex, performanceRatioPageStartIndex]
  );

  useEffect(() => {
    setPerformanceRatioPage(1);
  }, [
    performanceRatioMonitoringFilter,
    performanceRatioMatchFilter,
    performanceRatioSortBy,
    performanceRatioSortDir,
    performanceRatioSearch,
  ]);

  useEffect(() => {
    if (performanceRatioPage <= performanceRatioTotalPages) return;
    setPerformanceRatioPage(performanceRatioTotalPages);
  }, [performanceRatioPage, performanceRatioTotalPages]);

  const performanceRatioSummary = useMemo(() => {
    const rows = performanceRatioResult.rows;
    const withBaseline = rows.filter((row) => row.baselineReadWh !== null).length;
    const withExpected = rows.filter((row) => row.expectedProductionWh !== null && row.expectedProductionWh > 0).length;
    const withRatio = rows.filter((row) => row.performanceRatioPercent !== null).length;
    const totalDeltaWh = rows.reduce((sum, row) => sum + (row.productionDeltaWh ?? 0), 0);
    const totalExpectedWh = rows.reduce((sum, row) => sum + (row.expectedProductionWh ?? 0), 0);
    const totalContractValue = rows.reduce((sum, row) => sum + row.contractValue, 0);

    return {
      convertedReadCount: performanceRatioResult.convertedReadCount,
      matchedConvertedReads: performanceRatioResult.matchedConvertedReads,
      unmatchedConvertedReads: performanceRatioResult.unmatchedConvertedReads,
      invalidConvertedReads: performanceRatioResult.invalidConvertedReads,
      allocationCount: rows.length,
      withBaseline,
      withExpected,
      withRatio,
      totalDeltaWh,
      totalExpectedWh,
      portfolioRatioPercent: toPercentValue(totalDeltaWh, totalExpectedWh),
      totalContractValue,
    };
  }, [performanceRatioResult]);

  const compliantSourceByPortalId = useMemo(() => {
    const mapping = new Map<string, CompliantSourceEntry>();
    compliantSourceEntries.forEach((entry) => {
      if (!entry.portalId) return;
      mapping.set(entry.portalId, entry);
    });
    return mapping;
  }, [compliantSourceEntries]);

  const autoCompliantSourceByPortalId = useMemo(() => {
    const mapping = new Map<string, string>();
    part2EligibleSystemsForSizeReporting.forEach((system) => {
      if (!system.systemId) return;
      const keyById = system.systemId ? `id:${system.systemId}` : "";
      const keyByTracking = system.trackingSystemRefId ? `tracking:${system.trackingSystemRefId}` : "";
      const keyByName = `name:${system.systemName.toLowerCase()}`;
      const abpAcSizeKw =
        (keyById ? abpAcSizeKwBySystemKey.get(keyById) : undefined) ??
        (keyByTracking ? abpAcSizeKwBySystemKey.get(keyByTracking) : undefined) ??
        abpAcSizeKwBySystemKey.get(keyByName) ??
        null;

      const monitoringPlatformCompliantSource = resolveMonitoringPlatformCompliantSource(system.monitoringPlatform);
      const isTenKwCompliant = isTenKwAcOrLess(system.installedKwAc, abpAcSizeKw);
      const candidateSource = monitoringPlatformCompliantSource ?? (isTenKwCompliant ? TEN_KW_COMPLIANT_SOURCE : null);
      if (!candidateSource) return;

      const existingSource = mapping.get(system.systemId);
      if (
        !existingSource ||
        getAutoCompliantSourcePriority(candidateSource) > getAutoCompliantSourcePriority(existingSource)
      ) {
        mapping.set(system.systemId, candidateSource);
      }
    });
    return mapping;
  }, [abpAcSizeKwBySystemKey, part2EligibleSystemsForSizeReporting]);

  const compliantSourcesTableRows = useMemo<CompliantSourceTableRow[]>(() => {
    const mapping = new Map<string, CompliantSourceTableRow>();

    autoCompliantSourceByPortalId.forEach((compliantSource, portalId) => {
      mapping.set(portalId, {
        portalId,
        compliantSource,
        updatedAt: null,
        evidence: [],
        sourceType: "Auto",
      });
    });

    compliantSourceEntries.forEach((entry) => {
      if (!entry.portalId) return;
      mapping.set(entry.portalId, {
        portalId: entry.portalId,
        compliantSource: entry.compliantSource,
        updatedAt: entry.updatedAt,
        evidence: entry.evidence,
        sourceType: "Manual",
      });
    });

    return Array.from(mapping.values()).sort((a, b) => {
      if (a.sourceType !== b.sourceType) return a.sourceType === "Manual" ? -1 : 1;
      const aUpdated = a.updatedAt?.getTime() ?? 0;
      const bUpdated = b.updatedAt?.getTime() ?? 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      return a.portalId.localeCompare(b.portalId, undefined, { sensitivity: "base", numeric: true });
    });
  }, [autoCompliantSourceByPortalId, compliantSourceEntries]);

  const compliantSourceTotalPages = Math.max(
    1,
    Math.ceil(compliantSourcesTableRows.length / COMPLIANT_SOURCE_PAGE_SIZE)
  );
  const compliantSourceCurrentPage = Math.min(compliantSourcePage, compliantSourceTotalPages);
  const compliantSourcePageStartIndex = (compliantSourceCurrentPage - 1) * COMPLIANT_SOURCE_PAGE_SIZE;
  const compliantSourcePageEndIndex = compliantSourcePageStartIndex + COMPLIANT_SOURCE_PAGE_SIZE;
  const visibleCompliantSourceEntries = useMemo(
    () => compliantSourcesTableRows.slice(compliantSourcePageStartIndex, compliantSourcePageEndIndex),
    [compliantSourcePageEndIndex, compliantSourcePageStartIndex, compliantSourcesTableRows]
  );

  const compliantPerformanceRatioRows = useMemo<CompliantPerformanceRatioRow[]>(() => {
    const eligibleRows = performanceRatioResult.rows.filter((row) => {
      if (!row.part2VerificationDate) return false;
      if (row.performanceRatioPercent === null) return false;
      return row.performanceRatioPercent >= 30 && row.performanceRatioPercent <= 150;
    });

    const bestBySystem = new Map<string, CompliantPerformanceRatioRow>();

    eligibleRows.forEach((row) => {
      const systemKey =
        row.stateApplicationRefId ||
        row.systemId ||
        row.trackingSystemRefId ||
        row.systemName.toLowerCase();
      const compliantEntry = row.systemId ? compliantSourceByPortalId.get(row.systemId) : undefined;
      const rowAutoCompliantSource =
        resolveMonitoringPlatformCompliantSource(row.monitoringPlatform) ??
        (isTenKwAcOrLess(row.portalAcSizeKw, row.abpAcSizeKw) ? TEN_KW_COMPLIANT_SOURCE : null);
      const autoCompliantSource =
        rowAutoCompliantSource ?? (row.systemId ? autoCompliantSourceByPortalId.get(row.systemId) : undefined);
      const readWindowMonthYear = row.readDate
        ? formatMonthYear(toReadWindowMonthStart(row.readDate))
        : "N/A";
      const candidate: CompliantPerformanceRatioRow = {
        ...row,
        compliantSource: compliantEntry?.compliantSource ?? autoCompliantSource ?? null,
        evidenceCount: compliantEntry?.evidence.length ?? 0,
        meterReadMonthYear: formatMonthYear(row.readDate),
        readWindowMonthYear,
      };

      const existing = bestBySystem.get(systemKey);
      if (!existing) {
        bestBySystem.set(systemKey, candidate);
        return;
      }
      const candidateWindowTime = candidate.readDate
        ? toReadWindowMonthStart(candidate.readDate).getTime()
        : Number.NEGATIVE_INFINITY;
      const existingWindowTime = existing.readDate
        ? toReadWindowMonthStart(existing.readDate).getTime()
        : Number.NEGATIVE_INFINITY;
      if (candidateWindowTime > existingWindowTime) {
        bestBySystem.set(systemKey, candidate);
        return;
      }
      if (candidateWindowTime === existingWindowTime) {
        const candidateRatio = candidate.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        const existingRatio = existing.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        if (candidateRatio > existingRatio) {
          bestBySystem.set(systemKey, candidate);
          return;
        }
        if (candidateRatio === existingRatio) {
          const candidateReadTime = candidate.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          const existingReadTime = existing.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
          if (candidateReadTime > existingReadTime) {
            bestBySystem.set(systemKey, candidate);
          }
        }
      }
    });

    return Array.from(bestBySystem.values()).sort((a, b) => {
      const readWindowTimeDiff =
        (b.readDate ? toReadWindowMonthStart(b.readDate).getTime() : Number.NEGATIVE_INFINITY) -
        (a.readDate ? toReadWindowMonthStart(a.readDate).getTime() : Number.NEGATIVE_INFINITY);
      if (readWindowTimeDiff !== 0) return readWindowTimeDiff;
      const ratioDiff =
        (b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY) -
        (a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY);
      if (ratioDiff !== 0) return ratioDiff;
      return a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true });
    });
  }, [autoCompliantSourceByPortalId, compliantSourceByPortalId, performanceRatioResult.rows]);

  const compliantPerformanceRatioSummary = useMemo(() => {
    const rows = compliantPerformanceRatioRows;
    const withCompliantSource = rows.filter((row) => !!row.compliantSource).length;
    const withEvidence = rows.filter((row) => row.evidenceCount > 0).length;
    return {
      count: rows.length,
      withCompliantSource,
      withEvidence,
    };
  }, [compliantPerformanceRatioRows]);

  const compliantReportTotalPages = Math.max(
    1,
    Math.ceil(compliantPerformanceRatioRows.length / COMPLIANT_REPORT_PAGE_SIZE)
  );
  const compliantReportCurrentPage = Math.min(compliantReportPage, compliantReportTotalPages);
  const compliantReportPageStartIndex = (compliantReportCurrentPage - 1) * COMPLIANT_REPORT_PAGE_SIZE;
  const compliantReportPageEndIndex = compliantReportPageStartIndex + COMPLIANT_REPORT_PAGE_SIZE;
  const visibleCompliantPerformanceRows = useMemo(
    () => compliantPerformanceRatioRows.slice(compliantReportPageStartIndex, compliantReportPageEndIndex),
    [compliantPerformanceRatioRows, compliantReportPageEndIndex, compliantReportPageStartIndex]
  );

  useEffect(() => {
    if (compliantSourcePage <= compliantSourceTotalPages) return;
    setCompliantSourcePage(compliantSourceTotalPages);
  }, [compliantSourcePage, compliantSourceTotalPages]);

  useEffect(() => {
    if (compliantReportPage <= compliantReportTotalPages) return;
    setCompliantReportPage(compliantReportTotalPages);
  }, [compliantReportPage, compliantReportTotalPages]);

  useEffect(() => {
    if (sizeSiteListPage <= sizeSiteListTotalPages) return;
    setSizeSiteListPage(sizeSiteListTotalPages);
  }, [sizeSiteListPage, sizeSiteListTotalPages]);

  useEffect(() => {
    if (recValuePage <= recValueTotalPages) return;
    setRecValuePage(recValueTotalPages);
  }, [recValuePage, recValueTotalPages]);

  const downloadPerformanceRatioCsv = () => {
    const headers = [
      "system_name",
      "nonid",
      "portal_id",
      "state_certification_number",
      "csg_portal_ac_size_kw",
      "abp_report_ac_size_kw",
      "abp_part_2_verification_date",
      "installer_name",
      "monitoring_platform",
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "match_type",
      "read_date",
      "meter_read_month_year",
      "read_window_month_year",
      "baseline_date",
      "baseline_source",
      "lifetime_read_wh",
      "baseline_read_wh",
      "production_delta_wh",
      "expected_production_wh",
      "performance_ratio_percent",
      "contract_value",
    ];

    const rows = filteredPerformanceRatioRows.map((row) => ({
      system_name: row.systemName,
      nonid: row.trackingSystemRefId,
      portal_id: row.systemId ?? "",
      state_certification_number: row.stateApplicationRefId ?? "",
      csg_portal_ac_size_kw: row.portalAcSizeKw ?? "",
      abp_report_ac_size_kw: row.abpAcSizeKw ?? "",
      abp_part_2_verification_date: row.part2VerificationDate
        ? row.part2VerificationDate.toISOString().slice(0, 10)
        : "",
      installer_name: row.installerName,
      monitoring_platform: row.monitoringPlatform,
      monitoring: row.monitoring,
      monitoring_system_id: row.monitoringSystemId,
      monitoring_system_name: row.monitoringSystemName,
      match_type: row.matchType,
      read_date: row.readDate ? row.readDate.toISOString().slice(0, 10) : row.readDateRaw,
      meter_read_month_year: formatMonthYear(row.readDate),
      read_window_month_year: row.readDate ? formatMonthYear(toReadWindowMonthStart(row.readDate)) : "N/A",
      baseline_date: row.baselineDate ? row.baselineDate.toISOString().slice(0, 10) : "",
      baseline_source: row.baselineSource ?? "",
      lifetime_read_wh: row.lifetimeReadWh ?? "",
      baseline_read_wh: row.baselineReadWh ?? "",
      production_delta_wh: row.productionDeltaWh ?? "",
      expected_production_wh: row.expectedProductionWh ?? "",
      performance_ratio_percent: row.performanceRatioPercent ?? "",
      contract_value: row.contractValue,
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `performance-ratio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadCompliantPerformanceRatioCsv = () => {
    const headers = [
      "system_name",
      "nonid",
      "portal_id",
      "state_certification_number",
      "csg_portal_ac_size_kw",
      "abp_report_ac_size_kw",
      "abp_part_2_verification_date",
      "installer_name",
      "monitoring_platform",
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "match_type",
      "read_date",
      "meter_read_month_year",
      "read_window_month_year",
      "baseline_date",
      "baseline_source",
      "lifetime_read_wh",
      "baseline_read_wh",
      "production_delta_wh",
      "expected_production_wh",
      "performance_ratio_percent",
      "contract_value",
      "compliant_source",
      "compliant_evidence_count",
    ];

    const rows = compliantPerformanceRatioRows.map((row) => ({
      system_name: row.systemName,
      nonid: row.trackingSystemRefId,
      portal_id: row.systemId ?? "",
      state_certification_number: row.stateApplicationRefId ?? "",
      csg_portal_ac_size_kw: row.portalAcSizeKw ?? "",
      abp_report_ac_size_kw: row.abpAcSizeKw ?? "",
      abp_part_2_verification_date: row.part2VerificationDate ? row.part2VerificationDate.toISOString().slice(0, 10) : "",
      installer_name: row.installerName,
      monitoring_platform: row.monitoringPlatform,
      monitoring: row.monitoring,
      monitoring_system_id: row.monitoringSystemId,
      monitoring_system_name: row.monitoringSystemName,
      match_type: row.matchType,
      read_date: row.readDate ? row.readDate.toISOString().slice(0, 10) : row.readDateRaw,
      meter_read_month_year: row.meterReadMonthYear,
      read_window_month_year: row.readWindowMonthYear,
      baseline_date: row.baselineDate ? row.baselineDate.toISOString().slice(0, 10) : "",
      baseline_source: row.baselineSource ?? "",
      lifetime_read_wh: row.lifetimeReadWh ?? "",
      baseline_read_wh: row.baselineReadWh ?? "",
      production_delta_wh: row.productionDeltaWh ?? "",
      expected_production_wh: row.expectedProductionWh ?? "",
      performance_ratio_percent: row.performanceRatioPercent ?? "",
      contract_value: row.contractValue,
      compliant_source: row.compliantSource ?? "",
      compliant_evidence_count: row.evidenceCount,
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `performance-ratio-compliant-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

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

  const downloadChangeOwnershipDetailFilteredCsv = () => {
    if (filteredChangeOwnershipRows.length === 0) return;

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "ac_size_kw",
      "contract_value",
      "contract_date",
      "zillow_sold_date",
      "zillow_status",
      "contract_type",
      "status_category",
      "reporting",
    ];

    const rows = filteredChangeOwnershipRows.map((system) => ({
      system_name: system.systemName,
      system_id: system.systemId ?? "",
      tracking_id: system.trackingSystemRefId ?? "",
      ac_size_kw: system.installedKwAc ?? "",
      contract_value: resolveContractValueAmount(system),
      contract_date: system.contractedDate ? system.contractedDate.toISOString().slice(0, 10) : "",
      zillow_sold_date: system.zillowSoldDate ? system.zillowSoldDate.toISOString().slice(0, 10) : "",
      zillow_status: system.zillowStatus ?? "",
      contract_type: system.contractType ?? "",
      status_category: system.changeOwnershipStatus ?? "",
      reporting: system.isReporting ? "Yes" : "No",
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `coo-flagged-systems-detail-${timestampForCsvFileName()}.csv`;
    triggerCsvDownload(fileName, csv);
  };

  const zeroReportingInstallerPlatformRows = useMemo(() => {
    const groups = new Map<
      string,
      { installerName: string; monitoringPlatform: string; totalSystems: number; reportingSystems: number }
    >();

    offlineBaseSystems.forEach((system) => {
      const installerName = system.installerName || "Unknown";
      const monitoringPlatform = system.monitoringPlatform || "Unknown";
      const key = `${installerName}__${monitoringPlatform}`;
      let current = groups.get(key);
      if (!current) {
        current = { installerName, monitoringPlatform, totalSystems: 0, reportingSystems: 0 };
        groups.set(key, current);
      }
      current.totalSystems += 1;
      if (system.isReporting) current.reportingSystems += 1;
    });

    return Array.from(groups.values())
      .filter((group) => group.totalSystems > 10 && group.reportingSystems === 0)
      .map((group) => ({
        ...group,
        reportingPercent: toPercentValue(group.reportingSystems, group.totalSystems),
      }))
      .sort((a, b) => b.totalSystems - a.totalSystems);
  }, [offlineBaseSystems]);

  const downloadOfflineSystemsCsv = () => {
    const headers = [
      "nonid",
      "csg_portal_id",
      "abp_report_id",
      "system_name",
      "installer_name",
      "monitoring_method",
      "monitoring_platform",
      "online_monitoring_access_type",
      "online_monitoring",
      "online_monitoring_granted_username",
      "online_monitoring_username",
      "online_monitoring_system_name",
      "online_monitoring_system_id",
      "online_monitoring_password",
      "online_monitoring_website_api_link",
      "online_monitoring_entry_method",
      "online_monitoring_notes",
      "online_monitoring_self_report",
      "online_monitoring_rgm_info",
      "online_monitoring_no_submit_generation",
      "system_online",
      "last_reported_online_date",
      "last_gats_reporting_date",
      "last_report_kwh",
      "contract_value",
    ];

    const rows = offlineSystems
      .slice()
      .sort((a, b) => a.systemName.localeCompare(b.systemName, undefined, { sensitivity: "base", numeric: true }))
      .map((system) => {
        const keyById = system.systemId ? `id:${system.systemId}` : "";
        const keyByTracking = system.trackingSystemRefId ? `tracking:${system.trackingSystemRefId}` : "";
        const keyByName = `name:${system.systemName.toLowerCase()}`;

        const abpReportId =
          (keyById ? abpApplicationIdBySystemKey.get(keyById) : undefined) ??
          (keyByTracking ? abpApplicationIdBySystemKey.get(keyByTracking) : undefined) ??
          abpApplicationIdBySystemKey.get(keyByName) ??
          "";
        const monitoringDetails = getMonitoringDetailsForSystem(system, monitoringDetailsBySystemKey);

        return {
          nonid: system.trackingSystemRefId ?? "",
          csg_portal_id: system.systemId ?? "",
          abp_report_id: abpReportId,
          system_name: system.systemName,
          installer_name: system.installerName,
          monitoring_method: system.monitoringType,
          monitoring_platform: system.monitoringPlatform,
          online_monitoring_access_type: monitoringDetails?.online_monitoring_access_type ?? "",
          online_monitoring: monitoringDetails?.online_monitoring ?? "",
          online_monitoring_granted_username: monitoringDetails?.online_monitoring_granted_username ?? "",
          online_monitoring_username: monitoringDetails?.online_monitoring_username ?? "",
          online_monitoring_system_name: monitoringDetails?.online_monitoring_system_name ?? "",
          online_monitoring_system_id: monitoringDetails?.online_monitoring_system_id ?? "",
          online_monitoring_password: monitoringDetails?.online_monitoring_password ?? "",
          online_monitoring_website_api_link: monitoringDetails?.online_monitoring_website_api_link ?? "",
          online_monitoring_entry_method: monitoringDetails?.online_monitoring_entry_method ?? "",
          online_monitoring_notes: monitoringDetails?.online_monitoring_notes ?? "",
          online_monitoring_self_report: monitoringDetails?.online_monitoring_self_report ?? "",
          online_monitoring_rgm_info: monitoringDetails?.online_monitoring_rgm_info ?? "",
          online_monitoring_no_submit_generation: monitoringDetails?.online_monitoring_no_submit_generation ?? "",
          system_online: monitoringDetails?.system_online ?? "",
          last_reported_online_date: monitoringDetails?.last_reported_online_date ?? "",
          last_gats_reporting_date: formatDate(system.latestReportingDate),
          last_report_kwh: system.latestReportingKwh ?? "",
          contract_value: resolveContractValueAmount(system),
        };
      });

    const csv = buildCsv(headers, rows);
    const fileName = `offline-systems-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadOfflineDetailFilteredCsv = () => {
    if (filteredOfflineSystems.length === 0) return;

    const headers = [
      "system_name",
      "system_id",
      "tracking_id",
      "monitoring_method",
      "monitoring_platform",
      "access_type",
      "monitoring_site_id",
      "monitoring_site_name",
      "monitoring_link",
      "monitoring_username",
      "monitoring_password",
      "installer_name",
      "last_reporting_date",
      "last_report_kwh",
      "contract_value",
    ];

    const rows = filteredOfflineSystems.map((system) => {
      const accessFields = resolveOfflineMonitoringAccessFields(system, monitoringDetailsBySystemKey);
      return {
        system_name: system.systemName,
        system_id: system.systemId ?? "",
        tracking_id: system.trackingSystemRefId ?? "",
        monitoring_method: system.monitoringType,
        monitoring_platform: system.monitoringPlatform,
        access_type: accessFields.accessType,
        monitoring_site_id: accessFields.monitoringSiteId,
        monitoring_site_name: accessFields.monitoringSiteName,
        monitoring_link: accessFields.monitoringLink,
        monitoring_username: accessFields.monitoringUsername,
        monitoring_password: accessFields.monitoringPassword,
        installer_name: system.installerName,
        last_reporting_date: formatDate(system.latestReportingDate),
        last_report_kwh: system.latestReportingKwh ?? "",
        contract_value: resolveContractValueAmount(system),
      };
    });

    const csv = buildCsv(headers, rows);
    const fileName = `offline-systems-detail-filtered-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    triggerCsvDownload(fileName, csv);
  };

  const downloadSizeSiteListCsv = () => {
    const headers = [
      "system_name",
      "tracking_id",
      "portal_id",
      "state_certification_number",
      "size_bucket",
      "system_size_kw_ac",
      "last_reporting_date",
    ];

    const rows = sizeTabNotReportingPart2Rows.map((system) => ({
      system_name: system.systemName,
      tracking_id: system.trackingSystemRefId ?? "",
      portal_id: system.systemId ?? "",
      state_certification_number: system.stateApplicationRefId ?? "",
      size_bucket: system.sizeBucket,
      system_size_kw_ac: system.installedKwAc ?? "",
      last_reporting_date: system.latestReportingDate ? system.latestReportingDate.toISOString().slice(0, 10) : "",
    }));

    const csv = buildCsv(headers, rows);
    const fileName = `size-reporting-sites-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

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
  const transferDeliveryLookup = useMemo(() => {
    const lookup = new Map<string, Map<number, number>>();
    const transferRows = datasets.transferHistory?.rows ?? [];
    if (transferRows.length === 0) return lookup;

    for (const row of transferRows) {
      const unitId = clean(row["Unit ID"]);
      if (!unitId) continue;
      const qty = parseNumber(row.Quantity) ?? 0;
      if (qty === 0) continue;

      const transferor = (clean(row.Transferor) ?? "").toLowerCase();
      const transferee = (clean(row.Transferee) ?? "").toLowerCase();

      let direction = 0;
      const isFromCS = transferor.includes("carbon solutions");
      const isToCS = transferee.includes("carbon solutions");
      const transfereeIsUtility = ["comed", "ameren", "midamerican"].some(u => transferee.includes(u));
      const transferorIsUtility = ["comed", "ameren", "midamerican"].some(u => transferor.includes(u));

      if (isFromCS && transfereeIsUtility) direction = 1;
      else if (transferorIsUtility && isToCS) direction = -1;
      else continue;

      const completionDateRaw = clean(row["Transfer Completion Date"]);
      const completionDate = completionDateRaw ? parseDate(completionDateRaw) : null;
      if (!completionDate) continue;

      const month = completionDate.getMonth();
      const year = completionDate.getFullYear();
      const eyStartYear = month >= 5 ? year : year - 1;

      const key = unitId.toLowerCase();
      if (!lookup.has(key)) lookup.set(key, new Map());
      const yearMap = lookup.get(key)!;
      yearMap.set(eyStartYear, (yearMap.get(eyStartYear) ?? 0) + qty * direction);
    }

    return lookup;
  }, [datasets.transferHistory]);

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
        } satisfies PerformanceSourceRow;
      })
      .filter((row): row is PerformanceSourceRow => row !== null);
  }, [datasets.deliveryScheduleBase, eligibleTrackingIds, isPerformanceEvalTabActive, isForecastTabActive, systemsByTrackingId, transferDeliveryLookup]);

  const performanceContractOptions = useMemo(
    () =>
      Array.from(new Set(performanceSourceRows.map((row) => row.contractId))).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
      ),
    [performanceSourceRows]
  );

  const effectivePerformanceContractId =
    performanceContractId === "__ALL__" || performanceContractOptions.includes(performanceContractId)
      ? performanceContractId
      : (performanceContractOptions[0] ?? "");

  const performanceDeliveryYearOptions = useMemo(() => {
    if (!isPerformanceEvalTabActive) return [];
    const byKey = new Map<
      string,
      {
        key: string;
        label: string;
        startDate: Date | null;
        endDate: Date | null;
      }
    >();

    performanceSourceRows
      .filter((row) => effectivePerformanceContractId === "__ALL__" || row.contractId === effectivePerformanceContractId)
      .forEach((row) => {
        row.years.forEach((year) => {
          const existing = byKey.get(year.key);
          const label = buildRecReviewDeliveryYearLabel(year.startDate, year.endDate, year.startRaw, year.endRaw);
          if (existing) return;
          byKey.set(year.key, {
            key: year.key,
            label,
            startDate: year.startDate,
            endDate: year.endDate,
          });
        });
      });

    return Array.from(byKey.values()).sort((a, b) => {
      const aTime = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bTime = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
  }, [effectivePerformanceContractId, isPerformanceEvalTabActive, performanceSourceRows]);

  const defaultPerformanceDeliveryYearKey = useMemo(() => {
    if (performanceDeliveryYearOptions.length === 0) return "";
    const now = new Date();
    const nowMs = now.getTime();

    // Prefer the currently-active schedule year window for this contract.
    const activeOption = performanceDeliveryYearOptions.find((option) => {
      if (!option.startDate || !option.endDate) return false;
      return nowMs >= option.startDate.getTime() && nowMs <= option.endDate.getTime();
    });
    if (activeOption) return activeOption.key;

    // Fallback to the most recent year that has already started.
    const startedOptions = performanceDeliveryYearOptions.filter(
      (option) => option.startDate && option.startDate.getTime() <= nowMs
    );
    if (startedOptions.length > 0) {
      return startedOptions[startedOptions.length - 1]!.key;
    }

    // Final fallback: earliest available year.
    return performanceDeliveryYearOptions[0]!.key;
  }, [performanceDeliveryYearOptions]);

  const effectivePerformanceDeliveryYearKey =
    performanceDeliveryYearOptions.some((option) => option.key === performanceDeliveryYearKey)
      ? performanceDeliveryYearKey
      : defaultPerformanceDeliveryYearKey;

  const performanceSelectedDeliveryYearLabel =
    performanceDeliveryYearOptions.find((option) => option.key === effectivePerformanceDeliveryYearKey)?.label ??
    "N/A";

  const performancePreviousSurplus = parseNumber(performancePreviousSurplusInput) ?? 0;
  const performancePreviousDrawdown = parseNumber(performancePreviousDrawdownInput) ?? 0;

  const recPerformanceEvaluation = useMemo(() => {
    if (!isPerformanceEvalTabActive) {
      return {
        rows: [] as RecPerformanceResultRow[],
        systemCount: 0,
        shortfallSystemCount: 0,
        surplusBeforeAllocation: 0,
        totalAllocatedRecs: 0,
        netSurplusAfterAllocation: 0,
        unallocatedShortfallRecs: 0,
        drawdownThisReport: 0,
        drawdownCumulative: performancePreviousDrawdown,
      };
    }
    const baseRows: RecPerformanceResultRow[] = performanceSourceRows
      .filter((row) => effectivePerformanceContractId === "__ALL__" || row.contractId === effectivePerformanceContractId)
      .map((row) => {
        const targetYearIndex = row.years.findIndex((year) => year.key === effectivePerformanceDeliveryYearKey);
        if (targetYearIndex === -1) return null;

        const recWindow = deriveRecPerformanceThreeYearValues(row, targetYearIndex);
        if (!recWindow) return null;

        const surplusShortfall = recWindow.rollingAverage - recWindow.expectedRecs;

        return {
          key: row.key,
          applicationId: row.systemId ?? "N/A",
          unitId: row.trackingSystemRefId,
          batchId: row.batchId ?? "N/A",
          systemName: row.systemName,
          contractId: row.contractId,
          scheduleYearNumber: recWindow.scheduleYearNumber, // Which year in this system's schedule
          deliveryYearOne: recWindow.deliveryYearOne,
          deliveryYearTwo: recWindow.deliveryYearTwo,
          deliveryYearThree: recWindow.deliveryYearThree,
          deliveryYearOneSource: recWindow.deliveryYearOneSource,
          deliveryYearTwoSource: recWindow.deliveryYearTwoSource,
          deliveryYearThreeSource: recWindow.deliveryYearThreeSource,
          rollingAverage: recWindow.rollingAverage,
          contractPrice: row.recPrice,
          expectedRecs: recWindow.expectedRecs,
          surplusShortfall,
          allocatedRecs: 0,
          drawdownPayment: 0,
        } satisfies RecPerformanceResultRow;
      })
      .filter((row): row is RecPerformanceResultRow => row !== null)
      .sort((a, b) => a.applicationId.localeCompare(b.applicationId, undefined, { numeric: true, sensitivity: "base" }));

    const surplusBeforeAllocation = baseRows.reduce((sum, row) => sum + Math.max(0, row.surplusShortfall), 0);
    let remainingPool = performancePreviousSurplus + surplusBeforeAllocation;

    const deficitIndexes = baseRows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.surplusShortfall < 0)
      .sort((a, b) => {
        const aPrice = a.row.contractPrice ?? Number.POSITIVE_INFINITY;
        const bPrice = b.row.contractPrice ?? Number.POSITIVE_INFINITY;
        if (aPrice !== bPrice) return aPrice - bPrice;
        return a.row.applicationId.localeCompare(b.row.applicationId, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });

    deficitIndexes.forEach(({ index }) => {
      const row = baseRows[index];
      const shortfall = Math.abs(row.surplusShortfall);
      const allocated = Math.min(shortfall, remainingPool);
      remainingPool -= allocated;
      const remainingShortfall = shortfall - allocated;
      const drawdown = -remainingShortfall * (row.contractPrice ?? 0);

      baseRows[index] = {
        ...row,
        allocatedRecs: allocated,
        drawdownPayment: Number(drawdown.toFixed(2)),
      };
    });

    const totalAllocatedRecs = baseRows.reduce((sum, row) => sum + row.allocatedRecs, 0);
    const drawdownThisReport = baseRows.reduce(
      (sum, row) => sum + Math.abs(Math.min(row.drawdownPayment, 0)),
      0
    );
    const unallocatedShortfallRecs = baseRows.reduce(
      (sum, row) => sum + Math.max(0, Math.abs(Math.min(0, row.surplusShortfall)) - row.allocatedRecs),
      0
    );

    return {
      rows: baseRows,
      systemCount: baseRows.length,
      surplusSystemCount: baseRows.filter((row) => row.surplusShortfall > 0).length,
      shortfallSystemCount: baseRows.filter((row) => row.surplusShortfall < 0).length,
      surplusBeforeAllocation,
      totalAllocatedRecs,
      netSurplusAfterAllocation: performancePreviousSurplus + surplusBeforeAllocation - totalAllocatedRecs,
      unallocatedShortfallRecs,
      drawdownThisReport,
      drawdownCumulative: drawdownThisReport + performancePreviousDrawdown,
    };
  }, [
    effectivePerformanceContractId,
    effectivePerformanceDeliveryYearKey,
    isPerformanceEvalTabActive,
    performancePreviousDrawdown,
    performancePreviousSurplus,
    performanceSourceRows,
  ]);

  const recPerformanceContractYearSummaryRows = useMemo<RecPerformanceContractYearSummaryRow[]>(() => {
    if (!isPerformanceEvalTabActive || !effectivePerformanceDeliveryYearKey) {
      return [];
    }

    type Builder = {
      contractId: string;
      systemsInThreeYearReview: number;
      totalRecDeliveryObligation: number;
      totalDeliveriesFromThreeYearReview: number;
      recDelta: number;
      totalDrawdownAmount: number;
    };

    const summaryByContract = new Map<string, Builder>();

    const getOrCreate = (contractId: string): Builder => {
      const existing = summaryByContract.get(contractId);
      if (existing) return existing;
      const next: Builder = {
        contractId,
        systemsInThreeYearReview: 0,
        totalRecDeliveryObligation: 0,
        totalDeliveriesFromThreeYearReview: 0,
        recDelta: 0,
        totalDrawdownAmount: 0,
      };
      summaryByContract.set(contractId, next);
      return next;
    };

    performanceContractOptions.forEach((contractId) => {
      getOrCreate(contractId);
    });
    getOrCreate("846");
    getOrCreate("918");
    getOrCreate("Unassigned");

    performanceSourceRows.forEach((row) => {
      const contractId = clean(row.contractId) || "Unassigned";
      const targetYearIndex = row.years.findIndex((year) => year.key === effectivePerformanceDeliveryYearKey);
      const recWindow = deriveRecPerformanceThreeYearValues(row, targetYearIndex);
      if (!recWindow) return;

      const recDelta = recWindow.rollingAverage - recWindow.expectedRecs;
      const shortfall = Math.max(0, recWindow.expectedRecs - recWindow.rollingAverage);
      const drawdownAmount = shortfall * (row.recPrice ?? 0);

      const summary = getOrCreate(contractId);
      summary.systemsInThreeYearReview += 1;
      summary.totalRecDeliveryObligation += recWindow.expectedRecs;
      summary.totalDeliveriesFromThreeYearReview += recWindow.rollingAverage;
      summary.recDelta += recDelta;
      summary.totalDrawdownAmount += drawdownAmount;
    });

    return Array.from(summaryByContract.values())
      .map((row) => ({
        ...row,
        totalDrawdownAmount: Number(row.totalDrawdownAmount.toFixed(2)),
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId, undefined, { numeric: true, sensitivity: "base" }));
  }, [
    effectivePerformanceDeliveryYearKey,
    isPerformanceEvalTabActive,
    performanceContractOptions,
    performanceSourceRows,
  ]);

  const recPerformanceContractYearSummaryTotals = useMemo(() => {
    return recPerformanceContractYearSummaryRows.reduce(
      (acc, row) => {
        if (row.systemsInThreeYearReview <= 0) return acc;
        acc.contractsDueThisYear += 1;
        acc.totalSystemsInThreeYearReview += row.systemsInThreeYearReview;
        acc.totalRecDeliveryObligation += row.totalRecDeliveryObligation;
        acc.totalDeliveriesFromThreeYearReview += row.totalDeliveriesFromThreeYearReview;
        acc.recDelta += row.recDelta;
        acc.totalDrawdownAmount += row.totalDrawdownAmount;
        return acc;
      },
      {
        contractsDueThisYear: 0,
        totalSystemsInThreeYearReview: 0,
        totalRecDeliveryObligation: 0,
        totalDeliveriesFromThreeYearReview: 0,
        recDelta: 0,
        totalDrawdownAmount: 0,
      }
    );
  }, [recPerformanceContractYearSummaryRows]);

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

  const annualContractVintageRows = useMemo<AnnualContractVintageAggregate[]>(() => {
    if (!isAnnualReviewTabActive) return [];
    const groups = new Map<
      string,
      {
        contractId: string;
        deliveryStartDate: Date | null;
        deliveryStartRaw: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        trackingIds: Set<string>;
        reportingTrackingIds: Set<string>;
      }
    >();

    // Phase 1a: obligations from deliveryScheduleBase, delivered values
    // from transferDeliveryLookup bucketed into the year1 energy year.
    (datasets.deliveryScheduleBase?.rows ?? []).forEach((row) => {
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const deliveryStartRaw = clean(row.year1_start_date);
      if (!deliveryStartRaw) return;

      const deliveryStartDate = parseDate(deliveryStartRaw);
      const required = parseNumber(row.year1_quantity_required) ?? 0;
      const delivered = deliveryStartDate
        ? getDeliveredForYear(transferDeliveryLookup, trackingId, deliveryStartDate.getFullYear())
        : 0;
      const recPrice = recPriceByTrackingId.get(trackingId) ?? null;

      const dateKey = deliveryStartDate
        ? `${deliveryStartDate.getFullYear()}-${String(deliveryStartDate.getMonth() + 1).padStart(2, "0")}-${String(deliveryStartDate.getDate()).padStart(2, "0")}`
        : deliveryStartRaw;
      const key = `${contractId}__${dateKey}`;

      let current = groups.get(key);
      if (!current) {
        current = {
          contractId,
          deliveryStartDate,
          deliveryStartRaw,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          trackingIds: new Set<string>(),
          reportingTrackingIds: new Set<string>(),
        };
        groups.set(key, current);
      }

      current.required += required;
      current.delivered += delivered;
      current.trackingIds.add(trackingId);
      if (recPrice !== null) {
        current.requiredValue += required * recPrice;
        current.deliveredValue += delivered * recPrice;
      }
      if (systemsByTrackingId.get(trackingId)?.isReporting) {
        current.reportingTrackingIds.add(trackingId);
      }
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        deliveryStartDate: group.deliveryStartDate,
        deliveryStartRaw: group.deliveryStartRaw,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
        projectCount: group.trackingIds.size,
        reportingProjectCount: group.reportingTrackingIds.size,
        reportingProjectPercent: toPercentValue(group.reportingTrackingIds.size, group.trackingIds.size),
      }))
      .sort((a, b) => {
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aTime !== bTime) return aTime - bTime;
        return a.contractId.localeCompare(b.contractId);
      });
  }, [datasets.deliveryScheduleBase, eligibleTrackingIds, isAnnualReviewTabActive, recPriceByTrackingId, systemsByTrackingId, transferDeliveryLookup]);

  const annualVintageRows = useMemo<AnnualVintageAggregate[]>(() => {
    if (!isAnnualReviewTabActive) return [];
    const groups = new Map<
      string,
      {
        deliveryStartDate: Date | null;
        deliveryStartRaw: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        projectCount: number;
        reportingProjectCount: number;
      }
    >();

    annualContractVintageRows.forEach((row) => {
      const dateKey = row.deliveryStartDate
        ? `${row.deliveryStartDate.getFullYear()}-${String(row.deliveryStartDate.getMonth() + 1).padStart(2, "0")}-${String(row.deliveryStartDate.getDate()).padStart(2, "0")}`
        : row.deliveryStartRaw;
      let current = groups.get(dateKey);
      if (!current) {
        current = {
          deliveryStartDate: row.deliveryStartDate,
          deliveryStartRaw: row.deliveryStartRaw,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          projectCount: 0,
          reportingProjectCount: 0,
        };
        groups.set(dateKey, current);
      }

      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.projectCount += row.projectCount;
      current.reportingProjectCount += row.reportingProjectCount;
    });

    return Array.from(groups.values())
      .map((group) => ({
        deliveryStartDate: group.deliveryStartDate,
        deliveryStartRaw: group.deliveryStartRaw,
        label: group.deliveryStartDate ? formatDate(group.deliveryStartDate) : group.deliveryStartRaw,
        projectCount: group.projectCount,
        reportingProjectCount: group.reportingProjectCount,
        reportingProjectPercent: toPercentValue(group.reportingProjectCount, group.projectCount),
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
      }))
      .sort((a, b) => {
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
  }, [annualContractVintageRows, isAnnualReviewTabActive]);

  const annualContractSummaryRows = useMemo(() => {
    if (!isAnnualReviewTabActive) return [];
    const groups = new Map<
      string,
      {
        contractId: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        projectCount: number;
        reportingProjectCount: number;
        startDates: Set<string>;
      }
    >();

    annualContractVintageRows.forEach((row) => {
      let current = groups.get(row.contractId);
      if (!current) {
        current = {
          contractId: row.contractId,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          projectCount: 0,
          reportingProjectCount: 0,
          startDates: new Set<string>(),
        };
        groups.set(row.contractId, current);
      }

      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.projectCount += row.projectCount;
      current.reportingProjectCount += row.reportingProjectCount;
      current.startDates.add(row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw);
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        projectCount: group.projectCount,
        reportingProjectCount: group.reportingProjectCount,
        reportingProjectPercent: toPercentValue(group.reportingProjectCount, group.projectCount),
        startDateCount: group.startDates.size,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId));
  }, [annualContractVintageRows, isAnnualReviewTabActive]);

  const annualPortfolioSummary = useMemo(() => {
    if (!isAnnualReviewTabActive) {
      return {
        totalRequired: 0,
        totalDelivered: 0,
        totalGap: 0,
        totalDeliveredPercent: null,
        totalRequiredValue: 0,
        totalDeliveredValue: 0,
        totalValueGap: 0,
        totalValueDeliveredPercent: null,
        totalProjects: 0,
        totalReportingProjects: 0,
        totalReportingProjectPercent: null,
        vintageCount: 0,
        latestVintage: null,
        rollingThreeRequired: 0,
        rollingThreeDelivered: 0,
        rollingThreeDeliveredPercent: null,
        rollingThreeRequiredValue: 0,
        rollingThreeDeliveredValue: 0,
        rollingThreeValueDeliveredPercent: null,
      };
    }
    const totalRequired = annualVintageRows.reduce((sum, row) => sum + row.required, 0);
    const totalDelivered = annualVintageRows.reduce((sum, row) => sum + row.delivered, 0);
    const totalRequiredValue = annualVintageRows.reduce((sum, row) => sum + row.requiredValue, 0);
    const totalDeliveredValue = annualVintageRows.reduce((sum, row) => sum + row.deliveredValue, 0);
    const totalProjects = annualVintageRows.reduce((sum, row) => sum + row.projectCount, 0);
    const totalReportingProjects = annualVintageRows.reduce((sum, row) => sum + row.reportingProjectCount, 0);

    const latestVintage = annualVintageRows.length > 0 ? annualVintageRows[annualVintageRows.length - 1] : null;
    const rollingThreeRows = annualVintageRows.slice(-3);
    const rollingThreeRequired = rollingThreeRows.reduce((sum, row) => sum + row.required, 0);
    const rollingThreeDelivered = rollingThreeRows.reduce((sum, row) => sum + row.delivered, 0);
    const rollingThreeRequiredValue = rollingThreeRows.reduce((sum, row) => sum + row.requiredValue, 0);
    const rollingThreeDeliveredValue = rollingThreeRows.reduce((sum, row) => sum + row.deliveredValue, 0);

    return {
      totalRequired,
      totalDelivered,
      totalGap: totalRequired - totalDelivered,
      totalDeliveredPercent: toPercentValue(totalDelivered, totalRequired),
      totalRequiredValue,
      totalDeliveredValue,
      totalValueGap: totalRequiredValue - totalDeliveredValue,
      totalValueDeliveredPercent: toPercentValue(totalDeliveredValue, totalRequiredValue),
      totalProjects,
      totalReportingProjects,
      totalReportingProjectPercent: toPercentValue(totalReportingProjects, totalProjects),
      vintageCount: annualVintageRows.length,
      latestVintage,
      rollingThreeRequired,
      rollingThreeDelivered,
      rollingThreeDeliveredPercent: toPercentValue(rollingThreeDelivered, rollingThreeRequired),
      rollingThreeRequiredValue,
      rollingThreeDeliveredValue,
      rollingThreeValueDeliveredPercent: toPercentValue(rollingThreeDeliveredValue, rollingThreeRequiredValue),
    };
  }, [annualVintageRows, isAnnualReviewTabActive]);

  const contractDeliveryRows = useMemo<ContractDeliveryAggregate[]>(() => {
    if (!isContractsTabActive) return [];
    const groups = new Map<
      string,
      {
        contractId: string;
        deliveryStartDate: Date | null;
        deliveryStartRaw: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        trackingIds: Set<string>;
        pricedTrackingIds: Set<string>;
      }
    >();

    // Phase 1a: obligations from deliveryScheduleBase, delivered values
    // from transferDeliveryLookup bucketed into the year1 energy year.
    (datasets.deliveryScheduleBase?.rows ?? []).forEach((row) => {
      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

      const deliveryStartRaw = clean(row.year1_start_date);
      if (!deliveryStartRaw) return;

      const deliveryStartDate = parseDate(deliveryStartRaw);
      const required = parseNumber(row.year1_quantity_required) ?? 0;
      const delivered = deliveryStartDate
        ? getDeliveredForYear(transferDeliveryLookup, trackingId, deliveryStartDate.getFullYear())
        : 0;
      const recPrice = recPriceByTrackingId.get(trackingId) ?? null;

      const dateKey = deliveryStartDate
        ? `${deliveryStartDate.getFullYear()}-${String(deliveryStartDate.getMonth() + 1).padStart(2, "0")}-${String(deliveryStartDate.getDate()).padStart(2, "0")}`
        : deliveryStartRaw;
      const key = `${contractId}__${dateKey}`;

      let current = groups.get(key);
      if (!current) {
        current = {
          contractId,
          deliveryStartDate,
          deliveryStartRaw,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          trackingIds: new Set<string>(),
          pricedTrackingIds: new Set<string>(),
        };
        groups.set(key, current);
      }

      current.required += required;
      current.delivered += delivered;
      current.trackingIds.add(trackingId);
      if (recPrice !== null) {
        current.requiredValue += required * recPrice;
        current.deliveredValue += delivered * recPrice;
        current.pricedTrackingIds.add(trackingId);
      }
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        deliveryStartDate: group.deliveryStartDate,
        deliveryStartRaw: group.deliveryStartRaw,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
        projectCount: group.trackingIds.size,
        pricedProjectCount: group.pricedTrackingIds.size,
      }))
      .sort((a, b) => {
        const contractCompare = a.contractId.localeCompare(b.contractId);
        if (contractCompare !== 0) return contractCompare;
        const aTime = a.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bTime = b.deliveryStartDate?.getTime() ?? Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
  }, [datasets.deliveryScheduleBase, eligibleTrackingIds, isContractsTabActive, recPriceByTrackingId, transferDeliveryLookup]);

  const contractSummaryRows = useMemo(() => {
    if (!isContractsTabActive) return [];
    const groups = new Map<
      string,
      {
        contractId: string;
        required: number;
        delivered: number;
        requiredValue: number;
        deliveredValue: number;
        startDates: Set<string>;
        projectCount: number;
        pricedProjectCount: number;
      }
    >();

    contractDeliveryRows.forEach((row) => {
      let current = groups.get(row.contractId);
      if (!current) {
        current = {
          contractId: row.contractId,
          required: 0,
          delivered: 0,
          requiredValue: 0,
          deliveredValue: 0,
          startDates: new Set<string>(),
          projectCount: 0,
          pricedProjectCount: 0,
        };
        groups.set(row.contractId, current);
      }
      current.required += row.required;
      current.delivered += row.delivered;
      current.requiredValue += row.requiredValue;
      current.deliveredValue += row.deliveredValue;
      current.startDates.add(row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw);
      current.projectCount += row.projectCount;
      current.pricedProjectCount += row.pricedProjectCount;
    });

    return Array.from(groups.values())
      .map((group) => ({
        contractId: group.contractId,
        required: group.required,
        delivered: group.delivered,
        gap: group.required - group.delivered,
        deliveredPercent: toPercentValue(group.delivered, group.required),
        requiredValue: group.requiredValue,
        deliveredValue: group.deliveredValue,
        valueGap: group.requiredValue - group.deliveredValue,
        valueDeliveredPercent: toPercentValue(group.deliveredValue, group.requiredValue),
        startDateCount: group.startDates.size,
        projectCount: group.projectCount,
        pricedProjectCount: group.pricedProjectCount,
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId));
  }, [contractDeliveryRows, isContractsTabActive]);

  const contractSummaryTotalPages = Math.max(1, Math.ceil(contractSummaryRows.length / CONTRACT_SUMMARY_PAGE_SIZE));
  const contractSummaryCurrentPage = Math.min(contractSummaryPage, contractSummaryTotalPages);
  const contractSummaryPageStartIndex = (contractSummaryCurrentPage - 1) * CONTRACT_SUMMARY_PAGE_SIZE;
  const contractSummaryPageEndIndex = contractSummaryPageStartIndex + CONTRACT_SUMMARY_PAGE_SIZE;
  const visibleContractSummaryRows = useMemo(
    () => contractSummaryRows.slice(contractSummaryPageStartIndex, contractSummaryPageEndIndex),
    [contractSummaryPageEndIndex, contractSummaryPageStartIndex, contractSummaryRows]
  );

  const contractDetailTotalPages = Math.max(1, Math.ceil(contractDeliveryRows.length / CONTRACT_DETAIL_PAGE_SIZE));
  const contractDetailCurrentPage = Math.min(contractDetailPage, contractDetailTotalPages);
  const contractDetailPageStartIndex = (contractDetailCurrentPage - 1) * CONTRACT_DETAIL_PAGE_SIZE;
  const contractDetailPageEndIndex = contractDetailPageStartIndex + CONTRACT_DETAIL_PAGE_SIZE;
  const visibleContractDeliveryRows = useMemo(
    () => contractDeliveryRows.slice(contractDetailPageStartIndex, contractDetailPageEndIndex),
    [contractDeliveryRows, contractDetailPageEndIndex, contractDetailPageStartIndex]
  );

  const annualContractVintageTotalPages = Math.max(
    1,
    Math.ceil(annualContractVintageRows.length / ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE)
  );
  const annualContractVintageCurrentPage = Math.min(annualContractVintagePage, annualContractVintageTotalPages);
  const annualContractVintagePageStartIndex =
    (annualContractVintageCurrentPage - 1) * ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE;
  const annualContractVintagePageEndIndex =
    annualContractVintagePageStartIndex + ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE;
  const visibleAnnualContractVintageRows = useMemo(
    () => annualContractVintageRows.slice(annualContractVintagePageStartIndex, annualContractVintagePageEndIndex),
    [annualContractVintagePageEndIndex, annualContractVintagePageStartIndex, annualContractVintageRows]
  );

  const annualContractSummaryTotalPages = Math.max(
    1,
    Math.ceil(annualContractSummaryRows.length / ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE)
  );
  const annualContractSummaryCurrentPage = Math.min(annualContractSummaryPage, annualContractSummaryTotalPages);
  const annualContractSummaryPageStartIndex =
    (annualContractSummaryCurrentPage - 1) * ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE;
  const annualContractSummaryPageEndIndex =
    annualContractSummaryPageStartIndex + ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE;
  const visibleAnnualContractSummaryRows = useMemo(
    () => annualContractSummaryRows.slice(annualContractSummaryPageStartIndex, annualContractSummaryPageEndIndex),
    [annualContractSummaryPageEndIndex, annualContractSummaryPageStartIndex, annualContractSummaryRows]
  );

  const recPerformanceResultsTotalPages = Math.max(
    1,
    Math.ceil(recPerformanceEvaluation.rows.length / REC_PERFORMANCE_RESULTS_PAGE_SIZE)
  );
  const recPerformanceResultsCurrentPage = Math.min(recPerformanceResultsPage, recPerformanceResultsTotalPages);
  const recPerformanceResultsPageStartIndex =
    (recPerformanceResultsCurrentPage - 1) * REC_PERFORMANCE_RESULTS_PAGE_SIZE;
  const recPerformanceResultsPageEndIndex =
    recPerformanceResultsPageStartIndex + REC_PERFORMANCE_RESULTS_PAGE_SIZE;
  const visibleRecPerformanceRows = useMemo(
    () => recPerformanceEvaluation.rows.slice(recPerformanceResultsPageStartIndex, recPerformanceResultsPageEndIndex),
    [recPerformanceEvaluation.rows, recPerformanceResultsPageEndIndex, recPerformanceResultsPageStartIndex]
  );

  const offlineDetailTotalPages = Math.max(1, Math.ceil(filteredOfflineSystems.length / OFFLINE_DETAIL_PAGE_SIZE));
  const offlineDetailCurrentPage = Math.min(offlineDetailPage, offlineDetailTotalPages);
  const offlineDetailPageStartIndex = (offlineDetailCurrentPage - 1) * OFFLINE_DETAIL_PAGE_SIZE;
  const offlineDetailPageEndIndex = offlineDetailPageStartIndex + OFFLINE_DETAIL_PAGE_SIZE;
  const visibleOfflineDetailRows = useMemo(
    () => filteredOfflineSystems.slice(offlineDetailPageStartIndex, offlineDetailPageEndIndex),
    [filteredOfflineSystems, offlineDetailPageEndIndex, offlineDetailPageStartIndex]
  );

  useEffect(() => {
    if (contractSummaryPage <= contractSummaryTotalPages) return;
    setContractSummaryPage(contractSummaryTotalPages);
  }, [contractSummaryPage, contractSummaryTotalPages]);

  useEffect(() => {
    if (contractDetailPage <= contractDetailTotalPages) return;
    setContractDetailPage(contractDetailTotalPages);
  }, [contractDetailPage, contractDetailTotalPages]);

  useEffect(() => {
    if (annualContractVintagePage <= annualContractVintageTotalPages) return;
    setAnnualContractVintagePage(annualContractVintageTotalPages);
  }, [annualContractVintagePage, annualContractVintageTotalPages]);

  useEffect(() => {
    if (annualContractSummaryPage <= annualContractSummaryTotalPages) return;
    setAnnualContractSummaryPage(annualContractSummaryTotalPages);
  }, [annualContractSummaryPage, annualContractSummaryTotalPages]);

  useEffect(() => {
    if (recPerformanceResultsPage <= recPerformanceResultsTotalPages) return;
    setRecPerformanceResultsPage(recPerformanceResultsTotalPages);
  }, [recPerformanceResultsPage, recPerformanceResultsTotalPages]);

  useEffect(() => {
    if (offlineDetailPage <= offlineDetailTotalPages) return;
    setOfflineDetailPage(offlineDetailTotalPages);
  }, [offlineDetailPage, offlineDetailTotalPages]);

  useEffect(() => {
    setRecPerformanceResultsPage(1);
  }, [effectivePerformanceContractId, effectivePerformanceDeliveryYearKey]);

  const remoteDatasetManifest = useMemo<Partial<Record<DatasetKey, RemoteDatasetManifestEntry>>>(
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
    [datasets]
  );

  const manifestOnlyRemoteStatePayload = useMemo(() => {
    return (
      safeJsonStringify({
        datasetManifest: remoteDatasetManifest,
        logs: [],
      }) ?? "{\"datasetManifest\":{},\"logs\":[]}"
    );
  }, [remoteDatasetManifest]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loadedDatasets, loadedLogs] = await Promise.all([
          loadDatasetsFromStorage(),
          loadLogsFromStorage(),
        ]);
        if (cancelled) return;
        setDatasets((current) => (Object.keys(current).length > 0 ? current : loadedDatasets));
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
  }, []);

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
        const loadChunkedPayload = async (chunkKeys: string[]): Promise<string | null> => {
          let combined = "";
          for (const chunkKey of chunkKeys) {
            if (cancelled) return null;
            const chunkResponse = await withRetry(
              () => getRemoteDatasetRef.current.mutateAsync({ key: chunkKey }),
              3,
              250
            ).catch(() => null);
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

        for (const rawKey of keys) {
          if (cancelled) break;
          try {
            const loadedPayload = await loadPayloadByKey(rawKey);
            if (!loadedPayload?.payload) continue;
            const datasetPayload = loadedPayload.payload;
            loadedChunkKeys[rawKey] = loadedPayload.chunkKeys;

            const sourceManifest = parseRemoteSourceManifestPayload(datasetPayload);
            if (sourceManifest) {
              const parsedSourceData: Array<{
                source: RemoteDatasetSourceRef;
                parsed: { headers: string[]; rows: CsvRow[] };
              }> = [];

              for (const source of sourceManifest.sources) {
                if (cancelled) break;
                const sourcePayload = await loadPayloadByKey(source.storageKey);
                if (!sourcePayload?.payload) continue;
                const parsed = await parseSourcePayloadForDataset(rawKey, source, sourcePayload.payload);
                if (!parsed) continue;
                parsedSourceData.push({
                  source: {
                    ...source,
                    chunkKeys:
                      source.chunkKeys && source.chunkKeys.length > 0
                        ? source.chunkKeys
                        : sourcePayload.chunkKeys,
                  },
                  parsed,
                });
              }

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
                    sources: sourceRows,
                  };
                  const newest = normalizedSources[normalizedSources.length - 1];
                  loadedSignatures[rawKey] =
                    `raw:${normalizedSources.length}|${newest?.id ?? ""}|${newest?.uploadedAt ?? ""}|${rows.length}`;
                } else {
                  const latest = parsedSourceData[parsedSourceData.length - 1];
                  const latestSource =
                    normalizedSources[normalizedSources.length - 1];
                  loadedDatasets[rawKey] = {
                    fileName: latestSource?.fileName ?? `${DATASET_DEFINITIONS[rawKey].label} upload`,
                    uploadedAt: latestSource?.uploadedAt ? new Date(latestSource.uploadedAt) : new Date(),
                    headers: latest?.parsed.headers ?? [],
                    rows: latest?.parsed.rows ?? [],
                    sources: sourceRows,
                  };
                  loadedSignatures[rawKey] =
                    `raw:${normalizedSources.length}|${latestSource?.id ?? ""}|${latestSource?.uploadedAt ?? ""}|${latest?.parsed.rows.length ?? 0}`;
                }

                loadedSourceManifests[rawKey] = {
                  _rawSourcesV1: true,
                  version: 1,
                  sources: normalizedSources,
                };
                continue;
              }
            }

            const deserializedDataset = deserializeRemoteDatasetPayload(datasetPayload);
            if (!deserializedDataset) continue;
            loadedDatasets[rawKey] = deserializedDataset;
            loadedSignatures[rawKey] = `${deserializedDataset.fileName}|${deserializedDataset.uploadedAt.toISOString()}|${deserializedDataset.rows.length}|${deserializedDataset.sources?.length ?? 0}`;
          } catch {
            // Keep going; partial data is better than none.
          }
        }

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

        const keysToLoad = new Set<DatasetKey>();
        Object.keys(manifest).forEach((rawKey) => {
          if (!isDatasetKey(rawKey)) return;
          keysToLoad.add(rawKey);
        });

        (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
          keysToLoad.add(key);
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
              let combinedLogsPayload = "";
              let allLogsChunksLoaded = true;
              for (const chunkKey of chunkKeys) {
                if (cancelled) {
                  allLogsChunksLoaded = false;
                  break;
                }
                const chunkResponse = await withRetry(
                  () => getRemoteDatasetRef.current.mutateAsync({ key: chunkKey }),
                  3,
                  250
                ).catch(() => null);
                if (!chunkResponse?.payload) {
                  allLogsChunksLoaded = false;
                  break;
                }
                combinedLogsPayload += chunkResponse.payload;
              }
              if (allLogsChunksLoaded && combinedLogsPayload) {
                logsPayload = combinedLogsPayload;
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
                if (!merged[key as DatasetKey] && value) {
                  merged[key as DatasetKey] = value;
                }
              }
              return merged;
            });
            setDatasetCloudSyncStatus((current) => {
              const next = { ...current };
              (Object.keys(loadedDatasets) as DatasetKey[]).forEach((key) => {
                if (loadedDatasets[key]) {
                  next[key] = "synced";
                }
              });
              return next;
            });
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
            if (sourceManifest?.sources && sourceManifest.sources.length > 0) {
              for (const source of sourceManifest.sources) {
                try {
                  await clearRemotePayloadWithChunks(source.storageKey, source.chunkKeys);
                } catch {
                  // Best effort source cleanup.
                }
              }
              setRemoteSourceManifests((previous) => ({ ...previous, [key]: undefined }));
            }
            if (!remoteDatasetSignatureRef.current[key]) continue;
            const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
            try {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload: "" }));
              for (const chunkKey of previousChunkKeys) {
                await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
              }
              delete remoteDatasetSignatureRef.current[key];
              delete remoteDatasetChunkKeysRef.current[key];
              setDatasetCloudSyncBadge(key, undefined);
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
              setDatasetCloudSyncBadge(key, "synced");
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
              setDatasetCloudSyncBadge(key, "synced");
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
          const estimatedRemotePayloadChars = estimateDatasetRemotePayloadChars(
            dataset,
            MAX_REMOTE_DATASET_SYNC_ESTIMATED_CHARS
          );
          const shouldKeepLocalOnly =
            !forceSyncRequested && estimatedRemotePayloadChars > MAX_REMOTE_DATASET_SYNC_ESTIMATED_CHARS;
          // 2026-04-12 fix: Always use the same signature regardless of
          // local-only status. The `local-only:` prefix caused a race where
          // force-synced data got a "normal" signature, then the next auto-sync
          // created a different "local-only:" signature for the SAME content,
          // bypassing the "no change" guard and triggering the destructive
          // clear path that wiped all chunk payloads.
          const syncSignature = baseSignature;
          nextSignatures[key] = syncSignature;
          if (shouldKeepLocalOnly) {
            nextLocalOnlyDatasets[key] = true;
          }

          if (remoteDatasetSignatureRef.current[key] === syncSignature) {
            if (forceSyncRequested) {
              forcedRemoteDatasetSyncKeysRef.current.delete(key);
              setForceSyncingDatasets((previous) => (previous[key] ? { ...previous, [key]: false } : previous));
              setStorageNotice(`${DATASET_DEFINITIONS[key].label} is already synced to cloud.`);
            }
            continue;
          }

          if (shouldKeepLocalOnly) {
            // 2026-04-12 fix: NEVER write empty payloads to clear remote
            // data. The previous code here wrote empty strings to the main
            // key and all chunk keys, which destroyed force-synced data
            // when the auto-sync timer fired after the force-sync flag
            // was cleared. Stale cloud data is infinitely better than
            // no cloud data. Users can Force Cloud Sync to update.
            remoteDatasetSignatureRef.current[key] = syncSignature;
            setDatasetCloudSyncBadge(key, undefined);
            if (!previousSyncSignature || !remoteDatasetChunkKeysRef.current[key]?.length) {
              setStorageNotice(
                `${DATASET_DEFINITIONS[key].label} is too large for auto sync (${(estimatedRemotePayloadChars / 1_000_000).toFixed(1)} MB). Use Force Cloud Sync to update.`
              );
            }
            continue;
          }

          try {
            const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
            const payload = serializeDatasetForRemote(dataset);
            const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);

            if (chunks.length === 1) {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload }));
              for (const chunkKey of previousChunkKeys) {
                await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
              }
              remoteDatasetChunkKeysRef.current[key] = [];
            } else {
              const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(key, index));
              for (let index = 0; index < chunks.length; index += 1) {
                await withRetry(() =>
                  saveRemoteDatasetRef.current.mutateAsync({
                    key: chunkKeys[index],
                    payload: chunks[index],
                  })
                );
              }
              const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
              for (const staleChunkKey of staleChunkKeys) {
                await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }));
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
            setDatasetCloudSyncBadge(key, "synced");
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
    remoteDashboardStateQuery.status,
    remoteStateHydrated,
    saveRemotePayloadWithChunks,
    setDatasetCloudSyncBadge,
  ]);

  useEffect(() => {
    if (!datasetsHydrated || !remoteStateHydrated) return;
    if (remoteDashboardStateQuery.status !== "success") return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSignature = buildLogSyncSignature(logEntries);
        if (remoteLogsSignatureRef.current === nextSignature) return;

        const previousChunkKeys = remoteLogsChunkKeysRef.current ?? [];
        const syncLogsPayload = async (payload: string) => {
          const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);
          if (chunks.length > REMOTE_LOG_SYNC_MAX_CHUNKS) {
            throw new Error(`Snapshot log payload too large for cloud sync (${chunks.length} chunks).`);
          }

          if (chunks.length === 1) {
            await withRetry(() =>
              saveRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY, payload })
            );
            for (const chunkKey of previousChunkKeys) {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
            }
            return [] as string[];
          }

          const chunkKeys = chunks.map((_, index) => buildRemoteDatasetChunkKey(REMOTE_SNAPSHOT_LOGS_KEY, index));
          for (let index = 0; index < chunks.length; index += 1) {
            await withRetry(() =>
              saveRemoteDatasetRef.current.mutateAsync({
                key: chunkKeys[index],
                payload: chunks[index],
              })
            );
          }
          const staleChunkKeys = previousChunkKeys.filter((chunkKey) => !chunkKeys.includes(chunkKey));
          for (const staleChunkKey of staleChunkKeys) {
            await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: staleChunkKey, payload: "" }));
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
            for (const chunkKey of previousChunkKeys) {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = compliantSourceEntries.map((entry) => ({
      portalId: entry.portalId,
      compliantSource: entry.compliantSource,
      updatedAt: entry.updatedAt.toISOString(),
    }));
    window.localStorage.setItem(COMPLIANT_SOURCE_STORAGE_KEY, JSON.stringify(payload));
  }, [compliantSourceEntries]);

  useEffect(() => {
    return () => {
      compliantSourceEntriesRef.current.forEach((entry) => {
        entry.evidence.forEach((item) => URL.revokeObjectURL(item.objectUrl));
      });
    };
  }, []);

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

  useEffect(() => {
    if (activeTab !== "snapshot-log") return;

    const timeout = window.setTimeout(() => {
      const monthLatest = new Map<string, DashboardLogEntry>();

      logEntries.forEach((entry) => {
        const key = `${entry.createdAt.getFullYear()}-${String(entry.createdAt.getMonth() + 1).padStart(2, "0")}`;
        const existing = monthLatest.get(key);
        if (!existing || entry.createdAt > existing.createdAt) {
          monthLatest.set(key, entry);
        }
      });

      const monthlySeries = Array.from(monthLatest.entries())
        .map(([key, entry]) => ({ monthKey: key, entry }))
        .sort((a, b) => a.entry.createdAt.getTime() - b.entry.createdAt.getTime());

      const transitions: Array<{
        monthKey: string;
        monthLabel: string;
        movedIn: number;
        movedOut: number;
        net: number;
        endingCount: number;
        movedInBreakdown: string;
        movedOutBreakdown: string;
      }> = [];

      for (let i = 1; i < monthlySeries.length; i += 1) {
        const previous = monthlySeries[i - 1];
        const current = monthlySeries[i];

        const previousMap = new Map<string, TransitionStatus>();
        const currentMap = new Map<string, TransitionStatus>();
        const previousTargetKeys = new Set<string>();
        const currentTargetKeys = new Set<string>();

        previous.entry.cooStatuses.forEach((item) => {
          previousMap.set(item.key, item.status);
          if (item.status === COO_TARGET_STATUS) previousTargetKeys.add(item.key);
        });
        current.entry.cooStatuses.forEach((item) => {
          currentMap.set(item.key, item.status);
          if (item.status === COO_TARGET_STATUS) currentTargetKeys.add(item.key);
        });

        const allKeys = new Set<string>([
          ...Array.from(previousTargetKeys),
          ...Array.from(currentTargetKeys),
        ]);
        const movedInBreakdown = new Map<TransitionStatus, number>();
        const movedOutBreakdown = new Map<TransitionStatus, number>();
        let movedIn = 0;
        let movedOut = 0;
        let endingCount = 0;

        allKeys.forEach((key) => {
          const prevStatus = previousMap.get(key) ?? NO_COO_STATUS;
          const currStatus = currentMap.get(key) ?? NO_COO_STATUS;

          if (currStatus === COO_TARGET_STATUS) endingCount += 1;
          if (prevStatus !== COO_TARGET_STATUS && currStatus === COO_TARGET_STATUS) {
            movedIn += 1;
            movedInBreakdown.set(prevStatus, (movedInBreakdown.get(prevStatus) ?? 0) + 1);
          }
          if (prevStatus === COO_TARGET_STATUS && currStatus !== COO_TARGET_STATUS) {
            movedOut += 1;
            movedOutBreakdown.set(currStatus, (movedOutBreakdown.get(currStatus) ?? 0) + 1);
          }
        });

        transitions.push({
          monthKey: current.monthKey,
          monthLabel: current.entry.createdAt.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
          movedIn,
          movedOut,
          net: movedIn - movedOut,
          endingCount,
          movedInBreakdown: formatTransitionBreakdown(movedInBreakdown),
          movedOutBreakdown: formatTransitionBreakdown(movedOutBreakdown),
        });
      }

      setMonthlySnapshotTransitions(transitions.reverse());
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeTab, logEntries]);

  const snapshotLogColumns = useMemo(() => logEntries.slice(0, 12), [logEntries]);
  const snapshotContractIds = useMemo(
    () => {
      const ids = new Set<string>();
      snapshotLogColumns.forEach((entry) => {
        (entry.recPerformanceContracts2025 ?? []).forEach((item) => {
          ids.add(item.contractId);
        });
      });
      if (ids.size === 0) {
        recPerformanceSnapshotContracts2025.forEach((item) => ids.add(item.contractId));
      }
      return Array.from(ids).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    },
    [recPerformanceSnapshotContracts2025, snapshotLogColumns]
  );
  const snapshotContractMetricsByLogId = useMemo(() => {
    const mapping = new Map<
      string,
      Map<
        string,
        {
          contractId: string;
          deliveryYearLabel: string;
          requiredToAvoidShortfallRecs: number;
          deliveredTowardShortfallRecs: number;
          deliveredPercentOfRequired: number | null;
          unallocatedShortfallRecs: number;
        }
      >
    >();
    snapshotLogColumns.forEach((entry) => {
      const byContract = new Map<
        string,
        {
          contractId: string;
          deliveryYearLabel: string;
          requiredToAvoidShortfallRecs: number;
          deliveredTowardShortfallRecs: number;
          deliveredPercentOfRequired: number | null;
          unallocatedShortfallRecs: number;
        }
      >();
      (entry.recPerformanceContracts2025 ?? []).forEach((item) => {
        byContract.set(item.contractId, item);
      });
      mapping.set(entry.id, byContract);
    });
    return mapping;
  }, [snapshotLogColumns]);
  const snapshotContractTotalPages = Math.max(
    1,
    Math.ceil(snapshotContractIds.length / SNAPSHOT_CONTRACT_PAGE_SIZE)
  );
  const snapshotContractCurrentPage = Math.min(snapshotContractPage, snapshotContractTotalPages);
  const snapshotContractStartIndex = (snapshotContractCurrentPage - 1) * SNAPSHOT_CONTRACT_PAGE_SIZE;
  const snapshotContractEndIndex = snapshotContractStartIndex + SNAPSHOT_CONTRACT_PAGE_SIZE;
  const visibleSnapshotContractIds = useMemo(
    () => snapshotContractIds.slice(snapshotContractStartIndex, snapshotContractEndIndex),
    [snapshotContractEndIndex, snapshotContractIds, snapshotContractStartIndex]
  );
  const snapshotTrendRows = useMemo(
    () =>
      [...logEntries]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((entry) => ({
          id: entry.id,
          label: entry.createdAt.toLocaleDateString([], { month: "numeric", day: "numeric" }),
          timestamp: entry.createdAt.toLocaleString(),
          reportingPercent:
            entry.reportingPercent ?? toPercentValue(entry.reportingSystems, entry.totalSystems),
          cooNotTransferredNotReportingPercent: toPercentValue(
            entry.changedNotTransferredNotReporting,
            entry.totalSystems
          ),
          changeOwnershipPercent:
            entry.changeOwnershipPercent ?? toPercentValue(entry.changeOwnershipSystems, entry.totalSystems),
        })),
    [logEntries]
  );

  useEffect(() => {
    if (snapshotContractPage <= snapshotContractTotalPages) return;
    setSnapshotContractPage(snapshotContractTotalPages);
  }, [snapshotContractPage, snapshotContractTotalPages]);

  const snapshotMetricRows = useMemo<SnapshotMetricRow[]>(
    () => [
      { kind: "section", label: "Portfolio Coverage", sectionTone: "slate" },
      {
        kind: "metric",
        label: "Part II Verified ABP Customers",
        value: (entry: DashboardLogEntry) => formatNumber(entry.totalSystems),
      },
      {
        kind: "metric",
        label: "Quantity Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatNumber(entry.reportingSystems),
      },
      {
        kind: "metric",
        label: "Percentage Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatPercent(entry.reportingPercent),
        metricTone: "neutral",
      },

      { kind: "section", label: "Change of Ownership", sectionTone: "blue" },
      {
        kind: "metric",
        label: "Quantity Change of Ownership",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changeOwnershipSystems),
      },
      {
        kind: "metric",
        label: "Percentage Change of Ownership",
        value: (entry: DashboardLogEntry) => formatPercent(entry.changeOwnershipPercent),
        metricTone: "neutral",
      },
      {
        kind: "metric",
        label: "IL ABP - Transferred",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.transferredReporting + entry.transferredNotReporting),
      },
      {
        kind: "metric",
        label: "Transferred and Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatNumber(entry.transferredReporting),
      },
      {
        kind: "metric",
        label: "Transferred and Not Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatNumber(entry.transferredNotReporting),
      },
      {
        kind: "metric",
        label: "IL ABP - Terminated",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.terminatedReporting + entry.terminatedNotReporting),
      },
      {
        kind: "metric",
        label: "COO - Not Transferred and Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changedNotTransferredReporting),
      },
      {
        kind: "metric",
        label: "COO - Not Transferred and Not Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changedNotTransferredNotReporting),
        metricTone: "warn",
      },

      { kind: "section", label: "Contract Value", sectionTone: "emerald" },
      {
        kind: "metric",
        label: "Total Contract Value",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalContractedValue),
      },
      {
        kind: "metric",
        label: "Total Contract Value Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatCurrency(entry.contractedValueReporting),
      },
      {
        kind: "metric",
        label: "Total Contract Value Not Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatCurrency(entry.contractedValueNotReporting),
      },
      {
        kind: "metric",
        label: "Percent Contract Value Reporting",
        level: 1,
        value: (entry: DashboardLogEntry) => formatPercent(entry.contractedValueReportingPercent),
        metricTone: "neutral",
      },
      {
        kind: "metric",
        label: "Total Delivered Value",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalDeliveredValue),
      },
      {
        kind: "metric",
        label: "Total Value Gap",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalGap),
        metricTone: "warn",
      },
    ],
    []
  );

  const missingCoreDatasets = datasetsHydrated
    ? CORE_REQUIRED_DATASET_KEYS.filter((key) => !datasets[key])
    : [];

  const dataHealthSummary = useMemo(() => {
    const loadedDatasetKeys = (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).filter((key) => Boolean(datasets[key]));
    const totalRowsLoaded = loadedDatasetKeys.reduce((sum, key) => sum + (datasets[key]?.rows.length ?? 0), 0);
    const staleDatasets = loadedDatasetKeys.filter((key) => isStaleUpload(datasets[key]?.uploadedAt));
    const syncStatus =
      remoteDashboardStateQuery.status === "pending"
        ? "Checking cloud sync..."
        : saveRemoteDashboardState.isPending || saveRemoteDataset.isPending
          ? "Syncing to cloud..."
          : remoteDashboardStateQuery.status === "error"
            ? "Cloud sync currently unavailable"
            : "Cloud sync healthy";

    return {
      loadedDatasetCount: loadedDatasetKeys.length,
      totalDatasetCount: Object.keys(DATASET_DEFINITIONS).length,
      totalRowsLoaded,
      staleDatasetCount: staleDatasets.length,
      staleDatasetLabels: staleDatasets.map((key) => DATASET_DEFINITIONS[key].label),
      missingRequiredCount: missingCoreDatasets.length,
      syncStatus,
    };
  }, [
    datasets,
    missingCoreDatasets.length,
    remoteDashboardStateQuery.status,
    saveRemoteDashboardState.isPending,
    saveRemoteDataset.isPending,
  ]);

  const part2FilterAudit = useMemo(() => {
    const totalAbpRows = datasets.abpReport?.rows.length ?? 0;
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
    datasets.abpReport?.rows.length,
    part2EligibleSystemsForSizeReporting.length,
    part2VerifiedAbpRows.length,
  ]);

  const sizeReportingChartRows = useMemo(
    () =>
      sizeBreakdownRows.map((row) => ({
        bucket: row.bucket,
        reporting: row.reporting,
        notReporting: row.notReporting,
      })),
    [sizeBreakdownRows]
  );

  const ownershipStackedChartRows = useMemo(() => {
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

    const rows = [
      { label: "Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
      { label: "Not Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
    ];

    const uniquePart2Projects = new Set<string>();

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

      if (matchedSystems.size === 0) {
        rows[1].notTransferred += 1;
        return;
      }

      let isReporting = false;
      let isTransferred = false;
      let isTerminated = false;
      let isChangeOwnershipNotTransferred = false;

      matchedSystems.forEach((system) => {
        if (system.isReporting) isReporting = true;
        if (system.isTransferred) isTransferred = true;
        if (system.isTerminated) isTerminated = true;
        const normalizedChangeOwnershipStatus = clean(system.changeOwnershipStatus ?? "");
        if (normalizedChangeOwnershipStatus.startsWith("Change of Ownership - Not Transferred")) {
          isChangeOwnershipNotTransferred = true;
        }
      });

      if (isTerminated) return;

      const target = isReporting ? rows[0] : rows[1];
      if (isChangeOwnershipNotTransferred) {
        target.changeOwnership += 1;
      } else if (isTransferred) {
        target.transferred += 1;
      } else {
        target.notTransferred += 1;
      }
    });

    return rows;
  }, [part2VerifiedAbpRows, systems]);

  const recValueByStatusChartRows = useMemo(() => {
    const groups = new Map<
      "Reporting" | "Not Reporting" | "Terminated",
      { label: string; systems: number; contractedValue: number; deliveredValue: number }
    >([
      ["Reporting", { label: "Reporting", systems: 0, contractedValue: 0, deliveredValue: 0 }],
      ["Not Reporting", { label: "Not Reporting", systems: 0, contractedValue: 0, deliveredValue: 0 }],
      ["Terminated", { label: "Terminated", systems: 0, contractedValue: 0, deliveredValue: 0 }],
    ]);

    part2EligibleSystemsForSizeReporting.forEach((system) => {
      const groupKey: "Reporting" | "Not Reporting" | "Terminated" = system.isTerminated
        ? "Terminated"
        : system.isReporting
          ? "Reporting"
          : "Not Reporting";
      const group = groups.get(groupKey);
      if (!group) return;
      group.systems += 1;
      group.contractedValue += resolveContractValueAmount(system);
      group.deliveredValue += system.deliveredValue ?? 0;
    });

    return Array.from(groups.values()).map((group) => ({
      ...group,
      valueGap: group.contractedValue - group.deliveredValue,
      deliveredPercent: toPercentValue(group.deliveredValue, group.contractedValue),
    }));
  }, [part2EligibleSystemsForSizeReporting]);

  const recTopGapChartRows = useMemo(
    () =>
      [...recValueRows]
        .map((row) => ({
          label:
            row.systemName.length > 28
              ? `${row.systemName.slice(0, 25).trimEnd()}...`
              : row.systemName,
          valueGap: Math.max(0, resolveValueGapAmount(row)),
        }))
        .sort((a, b) => b.valueGap - a.valueGap)
        .slice(0, 12),
    [recValueRows]
  );

  const contractPerformanceChartRows = useMemo(
    () =>
      contractSummaryRows
        .map((row) => ({
          contractId: row.contractId,
          required: row.required,
          delivered: row.delivered,
          deliveredPercent: row.deliveredPercent ?? 0,
        }))
        .slice(0, 20),
    [contractSummaryRows]
  );

  const annualVintageTrendChartRows = useMemo(
    () =>
      annualVintageRows.map((row) => ({
        label: row.label,
        required: row.required,
        delivered: row.delivered,
        deliveredPercent: row.deliveredPercent ?? 0,
      })),
    [annualVintageRows]
  );

  // ── Application Pipeline: Part 1 / Part 2 from ABP, Interconnected from Generator Details ──
  const pipelineMonthlyRows = useMemo<PipelineMonthRow[]>(() => {
    type RawBucket = {
      part1Count: number; part2Count: number; part1KwAc: number; part2KwAc: number;
      interconnectedCount: number; interconnectedKwAc: number;
    };
    const buckets = new Map<string, RawBucket>();

    const ensureBucket = (month: string) => {
      if (!buckets.has(month)) {
        buckets.set(month, { part1Count: 0, part2Count: 0, part1KwAc: 0, part2KwAc: 0, interconnectedCount: 0, interconnectedKwAc: 0 });
      }
      return buckets.get(month)!;
    };

    const today = new Date();
    const isFuture = (d: Date) => d > today;

    // Part 1 and Part 2 come from ABP report rows, deduped by canonical project key.
    const seenPart1 = new Set<string>();
    const seenPart2 = new Set<string>();
    (datasets.abpReport?.rows ?? []).forEach((row, index) => {
      const { dedupeKey } = resolvePart2ProjectIdentity(row, index);

      // Part 1: keyed on Part_1_submission_date, kW from Inverter_Size_kW_AC_Part_1
      if (!seenPart1.has(dedupeKey)) {
        const submissionDate =
          parseDate(row.Part_1_submission_date) ??
          parseDate(row.Part_1_Submission_Date) ??
          parseDate(row.Part_1_Original_Submission_Date);
        if (submissionDate && !isFuture(submissionDate)) {
          seenPart1.add(dedupeKey);
          const month = `${submissionDate.getFullYear()}-${String(submissionDate.getMonth() + 1).padStart(2, "0")}`;
          const bucket = ensureBucket(month);
          bucket.part1Count += 1;

          const acKw = parseNumber(row.Inverter_Size_kW_AC_Part_1);
          if (acKw !== null) bucket.part1KwAc += acKw;
        }
      }

      // Part 2: keyed on Part_2_App_Verification_Date, kW from Inverter_Size_kW_AC_Part_2
      if (!seenPart2.has(dedupeKey)) {
        const part2DateRaw =
          clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
        const verificationDate = parsePart2VerificationDate(part2DateRaw);
        if (verificationDate && !isFuture(verificationDate)) {
          seenPart2.add(dedupeKey);
          const month = `${verificationDate.getFullYear()}-${String(verificationDate.getMonth() + 1).padStart(2, "0")}`;
          const bucket = ensureBucket(month);
          bucket.part2Count += 1;

          const acKw = parseAbpAcSizeKw(row);
          if (acKw !== null) bucket.part2KwAc += acKw;
        }
      }
    });

    // Interconnected comes from GATS Generator Details: Date Online / Interconnection date by GATS Unit ID.
    const fallbackAcKwByTrackingId = new Map<string, number>();
    systems.forEach((system) => {
      const trackingId = clean(system.trackingSystemRefId);
      if (!trackingId || system.installedKwAc === null) return;
      if (!fallbackAcKwByTrackingId.has(trackingId)) {
        fallbackAcKwByTrackingId.set(trackingId, system.installedKwAc);
      }
    });

    const seenInterconnectedTrackingIds = new Set<string>();
    (datasets.generatorDetails?.rows ?? []).forEach((row) => {
      const trackingId = clean(row["GATS Unit ID"]) || clean(row.gats_unit_id) || clean(row["Unit ID"]) || clean(row.unit_id);
      if (!trackingId || seenInterconnectedTrackingIds.has(trackingId)) return;

      const onlineDate =
        parseDateOnlineAsMidMonth(row["Date Online"] ?? row["Date online"] ?? row.date_online ?? row.date_online_month_year) ??
        parseDate(row.Interconnection_Approval_Date_UTC_Part_2) ??
        parseDate(row.Project_Online_Date_Part_2) ??
        parseDate(row["Date Online"] ?? row.date_online);
      if (!onlineDate || isFuture(onlineDate)) return;
      seenInterconnectedTrackingIds.add(trackingId);

      const month = `${onlineDate.getFullYear()}-${String(onlineDate.getMonth() + 1).padStart(2, "0")}`;
      const bucket = ensureBucket(month);
      bucket.interconnectedCount += 1;

      const acKw = parseGeneratorDetailsAcSizeKw(row) ?? fallbackAcKwByTrackingId.get(trackingId) ?? null;
      if (acKw !== null) bucket.interconnectedKwAc += acKw;
    });

    // Build rows with prior-year comparison
    const rawRows = Array.from(buckets.entries())
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Index raw data by month for prior-year lookup
    const byMonth = new Map(rawRows.map((r) => [r.month, r]));

    return rawRows.map((row) => {
      const [yearStr, monthStr] = row.month.split("-");
      const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
      const prev = byMonth.get(prevMonth);
      return {
        ...row,
        prevPart1Count: prev?.part1Count ?? 0,
        prevPart2Count: prev?.part2Count ?? 0,
        prevPart1KwAc: prev?.part1KwAc ?? 0,
        prevPart2KwAc: prev?.part2KwAc ?? 0,
        prevInterconnectedCount: prev?.interconnectedCount ?? 0,
        prevInterconnectedKwAc: prev?.interconnectedKwAc ?? 0,
      };
    });
  }, [datasets.abpReport, datasets.generatorDetails, systems]);

  const pipelineRows3Year = useMemo(() => {
    const now = new Date();
    const cutoff = `${now.getFullYear() - 3}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return pipelineMonthlyRows.filter((row) => row.month >= cutoff);
  }, [pipelineMonthlyRows]);

  const pipelineRows12Month = useMemo(() => {
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;
    return pipelineMonthlyRows.filter((row) => row.month >= cutoff);
  }, [pipelineMonthlyRows]);

  /** Build alternating 4-month shaded bands for pipeline charts.
   *  Returns ReferenceArea x1/x2 pairs for every other group of 4. */
  const pipelineBands = useCallback((rows: PipelineMonthRow[]) => {
    if (rows.length === 0) return [];
    const bands: Array<{ x1: string; x2: string }> = [];
    let i = 0;
    while (i < rows.length) {
      // skip 4 (unshaded)
      i += 4;
      // shade next 4
      if (i < rows.length) {
        const start = rows[i].month;
        const end = rows[Math.min(i + 3, rows.length - 1)].month;
        bands.push({ x1: start, x2: end });
        i += 4;
      }
    }
    return bands;
  }, []);

  /** Determine which 4-month group index a row belongs to (0-based from the start of the list).
   *  Even groups = white, odd groups = shaded. */
  const pipelineRowGroupIndex = useCallback((rows: PipelineMonthRow[], month: string) => {
    const idx = rows.findIndex((r) => r.month === month);
    return Math.floor(idx / 4);
  }, []);

  /** Generate a PDF pipeline report with ChatGPT analysis + data tables. */
  const handleGeneratePipelineReport = useCallback(async () => {
    if (pipelineReportLoading) return;
    setPipelineReportLoading(true);
    try {
      // Exclude the current (incomplete) month — only use fully completed months
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const completed3Year = pipelineRows3Year.filter((r) => r.month < currentMonth);
      const completed12Month = pipelineRows12Month.filter((r) => r.month < currentMonth);

      // Compute summary totals
      const sumFields = (rows: PipelineMonthRow[]) => ({
        totalPart1: rows.reduce((s, r) => s + r.part1Count, 0),
        totalPart2: rows.reduce((s, r) => s + r.part2Count, 0),
        totalPart1KwAc: rows.reduce((s, r) => s + r.part1KwAc, 0),
        totalPart2KwAc: rows.reduce((s, r) => s + r.part2KwAc, 0),
        totalInterconnected: rows.reduce((s, r) => s + r.interconnectedCount, 0),
        totalInterconnectedKwAc: rows.reduce((s, r) => s + r.interconnectedKwAc, 0),
      });
      const summaryTotals = {
        threeYear: sumFields(completed3Year),
        twelveMonth: sumFields(completed12Month),
      };

      // Call ChatGPT for analysis
      let result: { analysis: string };
      try {
        result = await generatePipelineReport.mutateAsync({
          generatedAt: new Date().toISOString(),
          rows3Year: completed3Year,
          rows12Month: completed12Month,
          summaryTotals,
        });
      } catch (apiErr: any) {
        const apiMsg = apiErr?.message || apiErr?.data?.message || JSON.stringify(apiErr);
        alert(`ChatGPT API call failed:\n\n${apiMsg}`);
        setPipelineReportLoading(false);
        return;
      }

      // Build PDF
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const ml = 48; // margin left
      const mr = 48;
      const cw = pageWidth - ml - mr; // content width
      let y = 0;

      const navy: [number, number, number] = [15, 35, 75];
      const accent: [number, number, number] = [37, 99, 235];
      const slate500: [number, number, number] = [100, 116, 139];
      const slate200: [number, number, number] = [226, 232, 240];

      /** Ensure enough room; add page if not. Returns true if a new page was added. */
      const footerReserve = 52; // space for footer line + text
      const ensureSpace = (needed: number) => {
        if (y + needed > pageHeight - footerReserve) { doc.addPage(); y = 48; }
      };

      // ── Header banner ──
      doc.setFillColor(...navy);
      doc.rect(0, 0, pageWidth, 80, "F");
      doc.setFontSize(22);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text("Application Pipeline Report", ml, 42);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(180, 200, 230);
      doc.text(`Generated ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`, ml, 62);
      y = 104;

      // ── Helper: section heading with accent line ──
      const sectionHeading = (title: string) => {
        ensureSpace(40);
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...navy);
        doc.text(title, ml, y);
        y += 4;
        doc.setDrawColor(...accent);
        doc.setLineWidth(2);
        doc.line(ml, y, ml + 80, y);
        doc.setDrawColor(0);
        y += 14;
      };

      // ── Render markdown analysis ──
      const bodySize = 10;
      const lineH = 14;
      const bulletIndent = 14;
      const textWidth = cw - 2; // slight buffer to prevent right-edge truncation
      const analysisLines = result.analysis.split("\n");

      for (const line of analysisLines) {
        const trimmed = line.trim();
        if (!trimmed) { y += 6; continue; }

        // ## Heading → section heading
        if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
          y += 8;
          const heading = trimmed.replace(/^#+\s+/, "").replace(/\*\*/g, "");
          sectionHeading(heading);
          continue;
        }

        ensureSpace(lineH * 2);

        // Bold-only line
        if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
          doc.setFontSize(bodySize);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(30, 30, 30);
          const text = trimmed.replace(/\*\*/g, "");
          const wrapped = doc.splitTextToSize(text, textWidth) as string[];
          for (const wline of wrapped) {
            ensureSpace(lineH);
            doc.text(wline, ml, y);
            y += lineH;
          }
          doc.setFont("helvetica", "normal");
          continue;
        }

        // Bullet point
        const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("• ");
        if (isBullet) {
          const text = trimmed.slice(2).replace(/\*\*/g, "");
          doc.setFontSize(bodySize);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(50, 50, 50);
          // Bullet marker
          doc.setFillColor(...accent);
          doc.circle(ml + 4, y - 3, 2, "F");
          const bulletTextWidth = textWidth - bulletIndent - 4;
          const wrapped = doc.splitTextToSize(text, bulletTextWidth) as string[];
          for (const wline of wrapped) {
            ensureSpace(lineH);
            doc.text(wline, ml + bulletIndent, y);
            y += lineH;
          }
          y += 2;
          continue;
        }

        // Regular paragraph text — handle inline **bold** segments
        doc.setFontSize(bodySize);
        doc.setTextColor(50, 50, 50);
        const cleanText = trimmed.replace(/\*\*/g, "");
        doc.setFont("helvetica", "normal");
        const wrapped = doc.splitTextToSize(cleanText, textWidth) as string[];
        for (const wline of wrapped) {
          ensureSpace(lineH);
          doc.text(wline, ml, y);
          y += lineH;
        }
      }

      // ── Summary Statistics Table ──
      y += 16;
      sectionHeading("Summary Statistics");

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [["Metric", "Last 12 Months", "Last 3 Years"]],
        body: [
          ["Part I Submitted (Count)", formatNumber(summaryTotals.twelveMonth.totalPart1), formatNumber(summaryTotals.threeYear.totalPart1)],
          ["Part II Verified (Count)", formatNumber(summaryTotals.twelveMonth.totalPart2), formatNumber(summaryTotals.threeYear.totalPart2)],
          ["Part I Submitted (kW AC)", formatNumber(summaryTotals.twelveMonth.totalPart1KwAc, 1), formatNumber(summaryTotals.threeYear.totalPart1KwAc, 1)],
          ["Part II Verified (kW AC)", formatNumber(summaryTotals.twelveMonth.totalPart2KwAc, 1), formatNumber(summaryTotals.threeYear.totalPart2KwAc, 1)],
          ["Interconnected (Count)", formatNumber(summaryTotals.twelveMonth.totalInterconnected), formatNumber(summaryTotals.threeYear.totalInterconnected)],
          ["Interconnected (kW AC)", formatNumber(summaryTotals.twelveMonth.totalInterconnectedKwAc, 1), formatNumber(summaryTotals.threeYear.totalInterconnectedKwAc, 1)],
        ],
        styles: { fontSize: 9, cellPadding: 6, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
      });

      y = (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 28 : y + 140;

      // ── Year-over-Year Comparison Table ──
      sectionHeading("Year-over-Year Comparison (Trailing 12 Months)");

      const pyTotals = {
        part1: completed12Month.reduce((s, r) => s + r.prevPart1Count, 0),
        part2: completed12Month.reduce((s, r) => s + r.prevPart2Count, 0),
        part1Kw: completed12Month.reduce((s, r) => s + r.prevPart1KwAc, 0),
        part2Kw: completed12Month.reduce((s, r) => s + r.prevPart2KwAc, 0),
        ic: completed12Month.reduce((s, r) => s + r.prevInterconnectedCount, 0),
        icKw: completed12Month.reduce((s, r) => s + r.prevInterconnectedKwAc, 0),
      };
      const t12 = summaryTotals.twelveMonth;
      const pctChg = (cur: number, prev: number) => prev === 0 ? (cur > 0 ? "+∞" : "—") : `${cur >= prev ? "+" : ""}${(((cur - prev) / prev) * 100).toFixed(1)}%`;

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [["Metric", "Current Period", "Prior Year", "Change"]],
        body: [
          ["Part I Submitted (Count)", formatNumber(t12.totalPart1), formatNumber(pyTotals.part1), pctChg(t12.totalPart1, pyTotals.part1)],
          ["Part II Verified (Count)", formatNumber(t12.totalPart2), formatNumber(pyTotals.part2), pctChg(t12.totalPart2, pyTotals.part2)],
          ["Part I Submitted (kW AC)", formatNumber(t12.totalPart1KwAc, 1), formatNumber(pyTotals.part1Kw, 1), pctChg(t12.totalPart1KwAc, pyTotals.part1Kw)],
          ["Part II Verified (kW AC)", formatNumber(t12.totalPart2KwAc, 1), formatNumber(pyTotals.part2Kw, 1), pctChg(t12.totalPart2KwAc, pyTotals.part2Kw)],
          ["Interconnected (Count)", formatNumber(t12.totalInterconnected), formatNumber(pyTotals.ic), pctChg(t12.totalInterconnected, pyTotals.ic)],
          ["Interconnected (kW AC)", formatNumber(t12.totalInterconnectedKwAc, 1), formatNumber(pyTotals.icKw, 1), pctChg(t12.totalInterconnectedKwAc, pyTotals.icKw)],
        ],
        styles: { fontSize: 9, cellPadding: 6, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
        didParseCell: (data: any) => {
          // Color the Change column: green for positive, red for negative
          if (data.section === "body" && data.column.index === 3) {
            const val = data.cell.raw as string;
            if (val.startsWith("+")) data.cell.styles.textColor = [22, 163, 74];
            else if (val.startsWith("-")) data.cell.styles.textColor = [220, 38, 38];
          }
        },
      });

      y = (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 28 : y + 140;

      // ── Monthly Detail Table ──
      sectionHeading("Monthly Detail (Last 12 Months)");

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [["Month", "Part I (#)", "Part II (#)", "Part I (kW)", "Part II (kW)", "Interconn. (#)", "Interconn. (kW)"]],
        body: completed12Month.map((r) => [
          r.month,
          formatNumber(r.part1Count),
          formatNumber(r.part2Count),
          formatNumber(r.part1KwAc, 1),
          formatNumber(r.part2KwAc, 1),
          formatNumber(r.interconnectedCount),
          formatNumber(r.interconnectedKwAc, 1),
        ]),
        styles: { fontSize: 8, cellPadding: 5, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
      });

      // ── Footer on every page ──
      const totalPages = doc.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...slate500);
        doc.text("Coherence — Application Pipeline Report", ml, pageHeight - 24);
        doc.text(`Page ${p} of ${totalPages}`, pageWidth - mr, pageHeight - 24, { align: "right" });
        // thin line above footer
        doc.setDrawColor(...slate200);
        doc.setLineWidth(0.5);
        doc.line(ml, pageHeight - 36, pageWidth - mr, pageHeight - 36);
      }

      // Download
      const pdfBlob = doc.output("blob");
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Pipeline_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("PDF build error:", err);
      const msg = err?.message || String(err);
      alert(`PDF generation failed:\n\n${msg}`);
    } finally {
      setPipelineReportLoading(false);
    }
  }, [pipelineReportLoading, pipelineRows3Year, pipelineRows12Month, generatePipelineReport]);

// ── Trends: Month-over-Month Production ──────────────────────────
const trendProductionMoM = useMemo(() => {
  if (!isTrendsTabActive) return [];
  const rows = datasets.convertedReads?.rows ?? [];
  if (rows.length === 0) return [];

  // Group by system_id + month
  const siteMonths = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const sysId = row.monitoring_system_id || row.monitoring_system_name || "";
    if (!sysId) continue;
    const rawWh = parseFloat(row.lifetime_meter_read_wh || "");
    if (!Number.isFinite(rawWh)) continue;
    const readDate = row.read_date || "";
    if (!readDate) continue;
    // Parse M/D/YYYY or YYYY-MM-DD
    const d = new Date(readDate);
    if (isNaN(d.getTime())) continue;
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    if (!siteMonths.has(sysId)) siteMonths.set(sysId, new Map());
    const months = siteMonths.get(sysId)!;
    // Keep the max lifetime read per month
    const existing = months.get(monthKey) ?? 0;
    if (rawWh > existing) months.set(monthKey, rawWh);
  }

  // Calculate deltas
  type SiteTrend = { siteId: string; months: { month: string; deltaKwh: number }[] };
  const siteTrends: SiteTrend[] = [];

  siteMonths.forEach((months, siteId) => {
    const sorted = Array.from(months.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const deltas: { month: string; deltaKwh: number }[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const delta = (sorted[i][1] - sorted[i - 1][1]) / 1000; // Wh to kWh
      if (delta > 0) deltas.push({ month: sorted[i][0], deltaKwh: Math.round(delta) });
    }
    if (deltas.length > 0) siteTrends.push({ siteId, months: deltas });
  });

  // Get all months across all sites
  const allMonths = Array.from(new Set(siteTrends.flatMap(s => s.months.map(m => m.month)))).sort();

  // Top 10 sites by total production
  const sorted = siteTrends
    .map(s => ({ ...s, total: s.months.reduce((a, m) => a + m.deltaKwh, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Build chart data: each row is a month, each column is a site
  return allMonths.map(month => {
    const point: Record<string, string | number> = { month };
    for (const site of sorted) {
      const m = site.months.find(mm => mm.month === month);
      point[site.siteId] = m?.deltaKwh ?? 0;
    }
    return point;
  });
}, [isTrendsTabActive, datasets.convertedReads]);

const trendTopSiteIds = useMemo(() => {
  if (trendProductionMoM.length === 0) return [];
  const first = trendProductionMoM[0];
  return Object.keys(first).filter(k => k !== "month").slice(0, 10);
}, [trendProductionMoM]);

// ── Trends: Delivery Pace ──────────────────────────────────────
// Phase 1a: obligations from deliveryScheduleBase (Schedule B scrape),
// delivered values from transferDeliveryLookup bucketed per energy year.
const trendDeliveryPace = useMemo(() => {
  if (!isTrendsTabActive) return [];
  const now = new Date();
  const scheduleRows = datasets.deliveryScheduleBase?.rows ?? [];
  if (scheduleRows.length === 0) return [];

  // Group by utility contract, find active delivery year
  const contractPace = new Map<string, { contract: string; required: number; delivered: number; expectedPace: number; actualPace: number }>();

  for (const row of scheduleRows) {
    const contractId = row.utility_contract_number || "Unknown";
    const trackingId = clean(row.tracking_system_ref_id);

    for (let y = 1; y <= 15; y++) {
      const startRaw = row[`year${y}_start_date`];
      const endRaw = row[`year${y}_end_date`];
      const required = parseFloat(row[`year${y}_quantity_required`] || "0") || 0;
      if (!startRaw || required === 0) continue;

      const start = new Date(startRaw);
      const end = endRaw ? new Date(endRaw) : new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
      if (now < start || now > end) continue; // Not active

      // Delivered for this (system, year) comes from the transfer lookup.
      const delivered = trackingId
        ? getDeliveredForYear(transferDeliveryLookup, trackingId, start.getFullYear())
        : 0;

      const totalMs = end.getTime() - start.getTime();
      const elapsedMs = now.getTime() - start.getTime();
      const expectedPace = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
      const actualPace = required > 0 ? (delivered / required) * 100 : 0;

      const existing = contractPace.get(contractId);
      if (!existing) {
        contractPace.set(contractId, { contract: contractId, required, delivered, expectedPace: Math.min(100, expectedPace), actualPace: Math.min(100, actualPace) });
      } else {
        existing.required += required;
        existing.delivered += delivered;
        // Recompute pace for the aggregate
        existing.actualPace = existing.required > 0 ? (existing.delivered / existing.required) * 100 : 0;
        existing.expectedPace = Math.min(100, expectedPace); // Use latest active year's pace
      }
    }
  }

  return Array.from(contractPace.values()).sort((a, b) => a.contract.localeCompare(b.contract));
}, [isTrendsTabActive, datasets.deliveryScheduleBase, transferDeliveryLookup]);

// ── Forecast: REC Performance-Based Projections (dynamic energy year) ──
// Energy year runs May 1 – April 30. After May 31, shift to next energy year.
const FORECAST_NOW = new Date();
const FORECAST_EY_START_YEAR = FORECAST_NOW.getMonth() >= 5 // June (0-indexed: 5) or later
  ? FORECAST_NOW.getFullYear()       // e.g., June 2026 → EY 2026-2027
  : FORECAST_NOW.getFullYear() - 1;  // e.g., April 2026 → EY 2025-2026
const FORECAST_EY_END_YEAR = FORECAST_EY_START_YEAR + 1;
const FORECAST_EY_LABEL = `${FORECAST_EY_START_YEAR}-${FORECAST_EY_END_YEAR}`;
const FORECAST_ENERGY_YEAR_END = new Date(FORECAST_EY_END_YEAR, 3, 30); // April 30
const FORECAST_ENERGY_YEAR_START = new Date(FORECAST_EY_START_YEAR, 4, 1); // May 1
const FORECAST_FLOOR_DATE = new Date(FORECAST_EY_START_YEAR - 1, 5, 1); // June 1, two years before end

type ForecastContractRow = {
  contract: string;
  systemsTotal: number;
  systemsReporting: number;
  requiredRecs: number;
  baselineRollingAvg: number;
  revisedRollingAvgReporting: number;
  revisedRollingAvgAll: number;
  delPercent: number | null;
  gapReporting: number;
  gapAll: number;
};

const forecastProjections = useMemo<ForecastContractRow[]>(() => {
  if (!isForecastTabActive) return [];
  if (performanceSourceRows.length === 0) return [];

  // Use the same 3-year rolling logic as REC Performance Eval to match baseline numbers.
  // For each system: find the delivery year matching FORECAST_EY_LABEL,
  // require targetYearIndex >= 2 (3rd year or later), compute rolling average.
  const contractMap = new Map<string, {
    contract: string;
    systemsTotal: number;
    systemsReporting: number;
    requiredRecs: number;
    baselineRollingAvg: number;
    revisedRollingAvgReporting: number;
    revisedRollingAvgAll: number;
  }>();

  for (const sourceRow of performanceSourceRows) {
    // Find the target year matching the energy year label (same logic as perf eval)
    const targetYearIndex = sourceRow.years.findIndex((year) => {
      const label = buildRecReviewDeliveryYearLabel(year.startDate, year.endDate, year.startRaw, year.endRaw);
      return label === FORECAST_EY_LABEL;
    });
    const recWindow = deriveRecPerformanceThreeYearValues(sourceRow, targetYearIndex);
    if (!recWindow) continue; // Must be in 3rd delivery year or later

    const dy1Val = recWindow.deliveryYearOne;
    const dy2Val = recWindow.deliveryYearTwo;
    const dy3Actual = recWindow.deliveryYearThree; // What's been delivered so far in DY3
    const obligation = recWindow.expectedRecs;

    // Baseline rolling average (no projection)
    const baselineRollingAvg = recWindow.rollingAverage;

    const trackingId = sourceRow.trackingSystemRefId;
    const profile = annualProductionByTrackingId.get(trackingId);
    const baseline = generationBaselineByTrackingId.get(trackingId);
    const sys = systems.find(s => s.trackingSystemRefId === trackingId);
    const isReporting = sys?.isReporting ?? false;

    // Determine start date: latest meter reading from GATS
    let meterReadDate = baseline?.date ?? null;
    if (meterReadDate && meterReadDate < FORECAST_FLOOR_DATE) {
      meterReadDate = FORECAST_FLOOR_DATE;
    }

    // Calculate projected RECs for remaining EY
    let projectedRecsForSystem = 0;
    if (profile && meterReadDate) {
      const endDate = FORECAST_ENERGY_YEAR_END;
      if (meterReadDate < endDate) {
        const expectedWh = calculateExpectedWhForRange(profile.monthlyKwh, meterReadDate, endDate);
        if (expectedWh !== null && expectedWh > 0) {
          projectedRecsForSystem = Math.floor((expectedWh / 1000) / 1000);
        }
      }
    } else if (profile && !meterReadDate) {
      const expectedWh = calculateExpectedWhForRange(profile.monthlyKwh, FORECAST_FLOOR_DATE, FORECAST_ENERGY_YEAR_END);
      if (expectedWh !== null && expectedWh > 0) {
        projectedRecsForSystem = Math.floor((expectedWh / 1000) / 1000);
      }
    }

    // Revised DY3: plug projected RECs into the current year's delivery,
    // then recompute the rolling average. This avoids double-counting
    // by running the projected generation through the same /3 averaging.
    const dy3RevisedReporting = isReporting && meterReadDate
      ? dy3Actual + projectedRecsForSystem
      : dy3Actual;
    const dy3RevisedAll = dy3Actual + projectedRecsForSystem;

    const revisedRollingAvgReporting = Math.floor((dy1Val + dy2Val + dy3RevisedReporting) / 3);
    const revisedRollingAvgAll = Math.floor((dy1Val + dy2Val + dy3RevisedAll) / 3);

    // Accumulate by contract
    const contractId = sourceRow.contractId;
    const existing = contractMap.get(contractId) ?? {
      contract: contractId,
      systemsTotal: 0,
      systemsReporting: 0,
      requiredRecs: 0,
      baselineRollingAvg: 0,
      revisedRollingAvgReporting: 0,
      revisedRollingAvgAll: 0,
    };

    existing.systemsTotal++;
    if (isReporting) existing.systemsReporting++;
    existing.requiredRecs += obligation;
    existing.baselineRollingAvg += baselineRollingAvg;
    existing.revisedRollingAvgReporting += revisedRollingAvgReporting;
    existing.revisedRollingAvgAll += revisedRollingAvgAll;
    contractMap.set(contractId, existing);
  }

  return Array.from(contractMap.values())
    .map(c => ({
      ...c,
      delPercent: c.requiredRecs > 0 ? (c.baselineRollingAvg / c.requiredRecs) * 100 : null,
      gapReporting: c.revisedRollingAvgReporting - c.requiredRecs,
      gapAll: c.revisedRollingAvgAll - c.requiredRecs,
    }))
    .sort((a, b) => a.gapReporting - b.gapReporting);
}, [isForecastTabActive, performanceSourceRows, annualProductionByTrackingId, generationBaselineByTrackingId, systems]);

const forecastSummary = useMemo(() => {
  const total = forecastProjections.length;
  const totalRevisedReporting = forecastProjections.reduce((a, c) => a + c.revisedRollingAvgReporting, 0);
  const totalRevisedAll = forecastProjections.reduce((a, c) => a + c.revisedRollingAvgAll, 0);
  const atRisk = forecastProjections.filter(c => c.gapReporting < 0).length;
  return { total, totalRevisedReporting, totalRevisedAll, atRisk };
}, [forecastProjections]);

// ── Delivery Tracker ────────────────────────────────────────────
// Phase 1a: obligations come exclusively from deliveryScheduleBase (the
// Schedule B scrape output). recDeliverySchedules has been removed from
// the entire dashboard. Deliveries come exclusively from transferHistory
// via buildDeliveryTrackerData's internal transfer-matching logic.
//
// The tracker now also surfaces `transfersMissingObligation` — distinct
// tracking IDs that have transfers but no matching Schedule B PDF yet,
// so the user can see exactly which systems still need scraping.
const deliveryTrackerData = useMemo(() => {
  if (!isDeliveryTrackerTabActive) {
    return EMPTY_DELIVERY_TRACKER_DATA;
  }

  return buildDeliveryTrackerData({
    scheduleRows: datasets.deliveryScheduleBase?.rows ?? [],
    transferRows: datasets.transferHistory?.rows ?? [],
  });
}, [
  isDeliveryTrackerTabActive,
  datasets.deliveryScheduleBase,
  datasets.transferHistory,
]);

// ── Alerts ──────────────────────────────────────────────────────
type AlertItem = { id: string; severity: "critical" | "warning" | "info"; type: string; system: string; message: string; action: string };

const alerts = useMemo<AlertItem[]>(() => {
  if (!isAlertsTabActive) return [];
  const items: AlertItem[] = [];
  const now = new Date();
  const OFFLINE_DAYS_THRESHOLD = 90;
  const PACE_THRESHOLD = 0.8;

  // Offline > 90 days
  systems.forEach((sys) => {
    if (sys.isReporting) return;
    if (!sys.latestReportingDate) {
      items.push({ id: `offline-never-${sys.key}`, severity: "critical", type: "Offline", system: sys.systemName, message: "Never reported any generation data", action: "Check monitoring connection" });
      return;
    }
    const daysOffline = Math.floor((now.getTime() - sys.latestReportingDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysOffline > OFFLINE_DAYS_THRESHOLD) {
      items.push({ id: `offline-${sys.key}`, severity: daysOffline > 180 ? "critical" : "warning", type: "Offline", system: sys.systemName, message: `Offline for ${daysOffline} days (last: ${sys.latestReportingDate.toLocaleDateString()})`, action: "Verify monitoring access" });
    }
  });

  // Delivery pace below 80%
  trendDeliveryPace.forEach((p) => {
    if (p.expectedPace > 10 && p.actualPace / p.expectedPace < PACE_THRESHOLD) {
      items.push({ id: `pace-${p.contract}`, severity: p.actualPace / p.expectedPace < 0.5 ? "critical" : "warning", type: "Delivery Pace", system: p.contract, message: `Delivery at ${p.actualPace.toFixed(0)}% vs expected ${p.expectedPace.toFixed(0)}%`, action: "Review contract delivery" });
    }
  });

  // Zero delivered with active contract
  systems.forEach((sys) => {
    if ((sys.contractedRecs ?? 0) > 0 && (sys.deliveredRecs ?? 0) === 0 && !sys.isTerminated) {
      items.push({ id: `zero-delivered-${sys.key}`, severity: "warning", type: "Zero Delivery", system: sys.systemName, message: `${formatNumber(sys.contractedRecs)} RECs contracted but 0 delivered`, action: "Check generation and REC issuance" });
    }
  });

  // Stale datasets
  const DATASET_KEYS = Object.keys(datasets) as Array<keyof typeof datasets>;
  DATASET_KEYS.forEach((key) => {
    const ds = datasets[key];
    if (!ds || !ds.uploadedAt) return;
    const ageDays = Math.floor((now.getTime() - ds.uploadedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (ageDays > 14) {
      items.push({ id: `stale-${key}`, severity: ageDays > 30 ? "warning" : "info", type: "Stale Data", system: String(key), message: `Last updated ${ageDays} days ago`, action: "Upload fresh data" });
    }
  });

  return items.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
  });
}, [isAlertsTabActive, systems, trendDeliveryPace, datasets]);

const alertSummary = useMemo(() => ({
  critical: alerts.filter(a => a.severity === "critical").length,
  warning: alerts.filter(a => a.severity === "warning").length,
  info: alerts.filter(a => a.severity === "info").length,
  total: alerts.length,
}), [alerts]);

// ── Comparisons: Installer Performance ──────────────────────────
const comparisonInstallers = useMemo(() => {
  if (!isComparisonsTabActive) return [];
  const groups = new Map<string, { name: string; total: number; reporting: number; totalValue: number; deliveredValue: number }>();

  systems.forEach((sys) => {
    const name = sys.installerName || "Unknown";
    const g = groups.get(name) ?? { name, total: 0, reporting: 0, totalValue: 0, deliveredValue: 0 };
    g.total++;
    if (sys.isReporting) g.reporting++;
    g.totalValue += sys.contractedValue ?? 0;
    g.deliveredValue += sys.deliveredValue ?? 0;
    groups.set(name, g);
  });

  return Array.from(groups.values())
    .map(g => ({ ...g, reportingPercent: toPercentValue(g.reporting, g.total), deliveryPercent: toPercentValue(g.deliveredValue, g.totalValue) }))
    .sort((a, b) => b.total - a.total);
}, [isComparisonsTabActive, systems]);

// ── Comparisons: Platform Reliability ───────────────────────────
const comparisonPlatforms = useMemo(() => {
  if (!isComparisonsTabActive) return [];
  const groups = new Map<string, { name: string; total: number; reporting: number; offline: number; offlineValue: number }>();

  systems.forEach((sys) => {
    const name = sys.monitoringPlatform || "Unknown";
    const g = groups.get(name) ?? { name, total: 0, reporting: 0, offline: 0, offlineValue: 0 };
    g.total++;
    if (sys.isReporting) g.reporting++;
    else {
      g.offline++;
      g.offlineValue += sys.contractedValue ?? 0;
    }
    groups.set(name, g);
  });

  return Array.from(groups.values())
    .map(g => ({ ...g, reportingPercent: toPercentValue(g.reporting, g.total), offlinePercent: toPercentValue(g.offline, g.total) }))
    .sort((a, b) => b.total - a.total);
}, [isComparisonsTabActive, systems]);

// ── Financials: Part II Verified System IDs (strict) ────────────
const part2VerifiedSystemIds = useMemo(() => {
  const ids = new Set<string>();
  part2VerifiedAbpRows.forEach((row) => {
    const appId = clean(row.Application_ID) || clean(row.system_id);
    if (appId) ids.add(appId);
  });
  return ids;
}, [part2VerifiedAbpRows]);

// ── Financials: Part II Filtered Systems ────────────────────────
const part2VerifiedSystems = useMemo(() => {
  if (!isFinancialsTabActive) return [];
  return systems.filter((sys) => sys.part2VerificationDate !== null);
}, [isFinancialsTabActive, systems]);

// ── Financials: Revenue at Risk ─────────────────────────────────
const financialRevenueAtRisk = useMemo(() => {
  if (!isFinancialsTabActive) return { total: 0, percent: null as number | null, byType: [] as { type: string; count: number; value: number }[], systems: [] as { name: string; riskType: string; value: number; lastDate: string; daysOffline: number }[] };
  const now = new Date();
  const atRiskSystems: { name: string; riskType: string; value: number; lastDate: string; daysOffline: number }[] = [];

  part2VerifiedSystems.forEach((sys) => {
    if ((sys.contractedValue ?? 0) <= 0) return;
    let riskType = "";
    if (!sys.isReporting) riskType = "Offline";
    else if (sys.isTerminated) riskType = "Terminated";
    if (!riskType) return;

    const daysOffline = sys.latestReportingDate ? Math.floor((now.getTime() - sys.latestReportingDate.getTime()) / (1000 * 60 * 60 * 24)) : 999;
    atRiskSystems.push({
      name: sys.systemName,
      riskType,
      value: sys.contractedValue ?? 0,
      lastDate: sys.latestReportingDate?.toLocaleDateString() ?? "Never",
      daysOffline,
    });
  });

  const totalAtRisk = atRiskSystems.reduce((a, s) => a + s.value, 0);
  const totalPortfolio = part2VerifiedSystems.reduce((a, s) => a + (s.contractedValue ?? 0), 0);

  const byType = new Map<string, { type: string; count: number; value: number }>();
  atRiskSystems.forEach(s => {
    const g = byType.get(s.riskType) ?? { type: s.riskType, count: 0, value: 0 };
    g.count++;
    g.value += s.value;
    byType.set(s.riskType, g);
  });

  return {
    total: totalAtRisk,
    percent: toPercentValue(totalAtRisk, totalPortfolio),
    byType: Array.from(byType.values()),
    systems: atRiskSystems.sort((a, b) => b.value - a.value),
  };
}, [isFinancialsTabActive, part2VerifiedSystems]);

// ── Financials: Profit & Collateralization ──────────────────────
const financialCsgIds = useMemo(() => {
  if (!isFinancialsTabActive) return [];
  const mappingRows = datasets.abpCsgSystemMapping?.rows ?? [];
  const ids = new Set<string>();
  for (const row of mappingRows) {
    const csgId = (row.csgId || row["CSG ID"] || "").trim();
    if (csgId) ids.add(csgId);
  }
  return Array.from(ids);
}, [isFinancialsTabActive, datasets.abpCsgSystemMapping]);

const contractScanResultsQuery = trpc.abpSettlement.getContractScanResultsByCsgIds.useQuery(
  { csgIds: financialCsgIds },
  { enabled: isFinancialsTabActive && financialCsgIds.length > 0 }
);
const updateContractOverride = trpc.abpSettlement.updateContractOverride.useMutation();
const rescanSingleContract = trpc.abpSettlement.rescanSingleContract.useMutation();
const [editingFinancialRow, setEditingFinancialRow] = useState<{
  csgId: string;
  systemName: string;
  vendorFeePercent: string;
  additionalCollateralPercent: string;
  notes: string;
} | null>(null);

type ProfitRow = {
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
  // Validation: flag rows where collateral exceeds 30% of GCV.
  needsReview: boolean;
  reviewReason: string;
  hasOverride: boolean;
};

const financialProfitData = useMemo<{
  rows: ProfitRow[];
  totalProfit: number;
  avgProfit: number;
  totalCollateralization: number;
  systemsWithData: number;
}>(() => {
  const empty = { rows: [] as ProfitRow[], totalProfit: 0, avgProfit: 0, totalCollateralization: 0, systemsWithData: 0 };
  if (!isFinancialsTabActive) return empty;

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
    const hasOverride = scan.overriddenAt != null;
    const vfp = scan.overrideVendorFeePercent ?? scan.vendorFeePercent ?? 0;
    const vendorFeeAmount = roundMoney(gcv * (vfp / 100));
    const utilityCollateral = roundMoney(gcv * 0.05);
    const acp = scan.overrideAdditionalCollateralPercent ?? scan.additionalCollateralPercent ?? 0;
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

  return {
    rows: profitRows.sort((a, b) => b.profit - a.profit),
    totalProfit: roundMoney(totalProfit),
    avgProfit: profitRows.length > 0 ? roundMoney(totalProfit / profitRows.length) : 0,
    totalCollateralization: roundMoney(totalColl),
    systemsWithData: profitRows.length,
  };
}, [
  isFinancialsTabActive,
  part2VerifiedAbpRows,
  contractScanResultsQuery.data,
  datasets.abpCsgSystemMapping,
  datasets.abpIccReport3Rows,
  datasets.abpReport,
]);

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

// ── Financials: filtered + sorted rows for interactive table ────
const filteredFinancialRows = useMemo(() => {
  if (!isFinancialsTabActive) return [];
  let rows = financialProfitData.rows;

  // Filter by review status
  if (financialFilter === "needs-review") {
    rows = rows.filter((r) => r.needsReview);
  } else if (financialFilter === "ok") {
    rows = rows.filter((r) => !r.needsReview);
  }

  // Filter by search term (system name, app ID, csg ID)
  const needle = financialSearch.trim().toLowerCase();
  if (needle) {
    rows = rows.filter((r) =>
      [r.systemName, r.applicationId, r.csgId]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }

  // Sort by selected column
  const dir = financialSortDir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const key = financialSortBy;
    if (key === "systemName") {
      return (
        a.systemName.localeCompare(b.systemName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    }
    return ((a[key] as number) - (b[key] as number)) * dir;
  });

  return rows;
}, [
  isFinancialsTabActive,
  financialProfitData.rows,
  financialFilter,
  financialSearch,
  financialSortBy,
  financialSortDir,
]);

const financialFlaggedCount = useMemo(
  () => financialProfitData.rows.filter((r) => r.needsReview).length,
  [financialProfitData.rows]
);

// ── Financials: sortable header helper (used in JSX below) ──────
const financialSortIndicator = (col: FinancialSortKey) =>
  financialSortBy === col ? (financialSortDir === "asc" ? " ▲" : " ▼") : "";
const handleFinancialSort = (col: FinancialSortKey) => {
  if (financialSortBy === col) {
    setFinancialSortDir((d) => (d === "asc" ? "desc" : "asc"));
  } else {
    setFinancialSortBy(col);
    setFinancialSortDir("desc");
  }
};

// ── Data Quality: Freshness ─────────────────────────────────────
const dataQualityFreshness = useMemo(() => {
  if (!isDataQualityTabActive) return [];
  const now = new Date();
  const DATASET_LABELS: Record<string, string> = {
    solarApplications: "Solar Applications",
    abpReport: "ABP Report",
    generationEntry: "Generation Entry",
    accountSolarGeneration: "Account Solar Generation",
    contractedDate: "Contracted Date",
    annualProductionEstimates: "Annual Production Estimates",
    generatorDetails: "Generator Details",
    convertedReads: "Converted Reads",
    deliveryScheduleBase: "Delivery Schedule (Schedule B)",
    transferHistory: "Transfer History (GATS)",
  };

  return Object.entries(DATASET_LABELS).map(([key, label]) => {
    const ds = datasets[key as keyof typeof datasets];
    const uploadedAt = ds?.uploadedAt ?? null;
    const ageDays = uploadedAt ? Math.floor((now.getTime() - uploadedAt.getTime()) / (1000 * 60 * 60 * 24)) : null;
    const rowCount = ds?.rows?.length ?? 0;
    const status = !uploadedAt ? "Missing" : ageDays! <= 7 ? "Fresh" : ageDays! <= 14 ? "Stale" : "Critical";
    return { key, label, uploadedAt: uploadedAt?.toLocaleDateString() ?? "Not uploaded", ageDays, rowCount, status };
  });
}, [isDataQualityTabActive, datasets]);

// ── Data Quality: Unmatched Reconciliation ──────────────────────
const dataQualityUnmatched = useMemo(() => {
  if (!isDataQualityTabActive) return { inScheduleNotMonitoring: [] as string[], inMonitoringNotSchedule: [] as string[], matchedPercent: null as number | null };
  const scheduleIds = new Set<string>();
  const monitoringIds = new Set<string>();

  // Phase 1a: the Delivery Tracker / Performance Eval obligations now come
  // from deliveryScheduleBase (Schedule B scrape), so we reconcile tracking
  // IDs against that dataset instead of the removed recDeliverySchedules.
  (datasets.deliveryScheduleBase?.rows ?? []).forEach(row => {
    const id = row.tracking_system_ref_id || row.system_id || "";
    if (id) scheduleIds.add(id.toLowerCase());
  });

  (datasets.convertedReads?.rows ?? []).forEach(row => {
    const id = row.monitoring_system_id || "";
    if (id) monitoringIds.add(id.toLowerCase());
  });

  const inScheduleNotMonitoring = Array.from(scheduleIds).filter(id => !monitoringIds.has(id));
  const inMonitoringNotSchedule = Array.from(monitoringIds).filter(id => !scheduleIds.has(id));
  const combined = new Set(Array.from(scheduleIds).concat(Array.from(monitoringIds)));
  const totalUnique = combined.size;
  const matched = totalUnique - inScheduleNotMonitoring.length - inMonitoringNotSchedule.length;
  const matchedPercent = toPercentValue(matched, totalUnique);

  return { inScheduleNotMonitoring, inMonitoringNotSchedule, matchedPercent };
}, [isDataQualityTabActive, datasets.deliveryScheduleBase, datasets.convertedReads]);

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
        return JSON.stringify({
          tab: "forecast",
          contracts: forecastProjections,
          systemCount: systems.length,
          note: "gapReporting/gapAll: positive=surplus, negative=shortfall. revisedRollingAvg includes projected RECs through EY end.",
        });
      case "financials":
        return JSON.stringify({
          tab: "financials",
          profitRows: truncate(financialProfitData.rows),
          totalProfit: financialProfitData.totalProfit,
          avgProfit: financialProfitData.avgProfit,
          totalCollateralization: financialProfitData.totalCollateralization,
          revenueAtRisk: financialRevenueAtRisk,
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
        return JSON.stringify({
          tab: "alerts",
          alerts: truncate(alerts),
          summary: alertSummary,
        });
      case "comparisons":
        return JSON.stringify({
          tab: "comparisons",
          installers: comparisonInstallers,
          platforms: comparisonPlatforms,
        });
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
  activeTab, forecastProjections, financialProfitData, financialRevenueAtRisk,
  performanceSourceRows, deliveryTrackerData, systems, alerts, alertSummary,
  comparisonInstallers, comparisonPlatforms,
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
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 xl:col-span-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Cloud Sync</p>
                <p className="text-sm font-semibold text-slate-900">{dataHealthSummary.syncStatus}</p>
                {dataHealthSummary.staleDatasetLabels.length > 0 ? (
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
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="alerts">
              Alerts{alertSummary.total > 0 ? ` (${alertSummary.total})` : ""}
            </TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="comparisons">Comparisons</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="financials">Financials</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="data-quality">Data Quality</TabsTrigger>
            <TabsTrigger className="h-8 px-2 text-xs md:text-sm" value="delivery-tracker">Delivery Tracker</TabsTrigger>
          </TabsList>

          {activeTab === "overview" && (<div className="space-y-4 mt-4">
            {/* Row 1: System counts — compact, short values */}
            <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardHeader>
                  <CardDescription>Total Systems</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.totalSystems)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Reporting in Last 3 Months</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.reportingSystems)}</CardTitle>
                  <CardDescription>{formatPercent(summary.reportingPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>{`<=10 kW AC`}</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.smallSystems)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>{`>10 kW AC`}</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.largeSystems)}</CardTitle>
                </CardHeader>
              </Card>
            </div>
            {/* Row 2: Part II verified values — wider cards for long numbers */}
            <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardDescription>Total Contracted Value (Part II Verified)</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(overviewPart2Totals.totalContractedValuePart2)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Cumulative kW AC (Part II Verified)</CardDescription>
                  <CardTitle className="text-2xl">{formatCapacityKw(overviewPart2Totals.cumulativeKwAcPart2)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Cumulative kW DC (Part II Verified)</CardDescription>
                  <CardTitle className="text-2xl">{formatCapacityKw(overviewPart2Totals.cumulativeKwDcPart2)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Reporting by Size Bucket</CardTitle>
                  <CardDescription>Stacked reporting vs not reporting counts.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={sizeReportingChartRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="reporting" stackId="size-status" fill="#16a34a" name="Reporting" />
                        <Bar dataKey="notReporting" stackId="size-status" fill="#f59e0b" name="Not Reporting" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Ownership Mix by Reporting State</CardTitle>
                  <CardDescription>
                    Part II verified, non-terminated systems split into Not Transferred, Transferred, and Change of Ownership.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={ownershipStackedChartRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="notTransferred" stackId="ownership" fill="#0ea5e9" name="Not Transferred" />
                        <Bar dataKey="transferred" stackId="ownership" fill="#8b5cf6" name="Transferred" />
                        <Bar dataKey="changeOwnership" stackId="ownership" fill="#f97316" name="Change of Ownership" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ownership and Reporting Status Counts</CardTitle>
                <CardDescription>
                  Part II verified systems only. Click any tile to export matching systems to CSV.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => downloadOwnershipCountTileCsv("reporting")}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-emerald-800">Reporting</p>
                    <p className="text-2xl font-semibold text-emerald-900">
                      {formatNumber(summary.ownershipOverview.reportingOwnershipTotal)}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActiveTabChange("offline-monitoring")}
                    title="View offline systems"
                    className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-amber-800">Not Reporting</p>
                    <p className="text-2xl font-semibold text-amber-900">
                      {formatNumber(summary.ownershipOverview.notReportingOwnershipTotal)}
                    </p>
                    <p className="text-[10px] text-amber-600 mt-1">Click to view offline systems</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadOwnershipCountTileCsv("terminated")}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-slate-700">Terminated</p>
                    <p className="text-2xl font-semibold text-slate-900">
                      {formatNumber(summary.ownershipOverview.terminatedTotal)}
                    </p>
                  </button>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Change of Ownership</p>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <button
                    type="button"
                    onClick={() => downloadChangeOwnershipCountTileCsv("Transferred and Reporting")}
                    className="rounded-lg border border-emerald-300 bg-emerald-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-emerald-900">Ownership Changed, Transferred and Reporting</p>
                    <p className="text-2xl font-semibold text-emerald-950">
                      {formatNumber(
                        changeOwnershipSummary.counts.find((item) => item.status === "Transferred and Reporting")
                          ?.count ?? 0
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadChangeOwnershipCountTileCsv("Change of Ownership - Not Transferred and Reporting")}
                    className="rounded-lg border border-green-200 bg-green-50 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-green-800">
                      Change of Ownership - Not Transferred and Reporting
                    </p>
                    <p className="text-2xl font-semibold text-green-900">
                      {formatNumber(
                        changeOwnershipSummary.counts.find(
                          (item) => item.status === "Change of Ownership - Not Transferred and Reporting"
                        )?.count ?? 0
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadChangeOwnershipCountTileCsv("Transferred and Not Reporting")}
                    className="rounded-lg border border-amber-300 bg-amber-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-amber-800">Ownership Changed, Transferred but not Reporting</p>
                    <p className="text-2xl font-semibold text-amber-900">
                      {formatNumber(
                        changeOwnershipSummary.counts.find((item) => item.status === "Transferred and Not Reporting")
                          ?.count ?? 0
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadChangeOwnershipCountTileCsv("Change of Ownership - Not Transferred and Not Reporting")}
                    className="rounded-lg border border-rose-300 bg-rose-100 p-3 text-left transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
                  >
                    <p className="text-xs font-semibold text-rose-800">
                      Ownership Changed, but not Transferred and not Reporting
                    </p>
                    <p className="text-2xl font-semibold text-rose-900">
                      {formatNumber(
                        changeOwnershipSummary.counts.find(
                          (item) => item.status === "Change of Ownership - Not Transferred and Not Reporting"
                        )?.count ?? 0
                      )}
                    </p>
                  </button>
                </div>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "size" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Size Bucket Reporting Matrix</CardTitle>
                <CardDescription>
                  Reporting is based on the most recent generation month being within the last 3 months.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Size Bucket</TableHead>
                      <TableHead>Total Systems</TableHead>
                      <TableHead>Reporting</TableHead>
                      <TableHead>Not Reporting</TableHead>
                      <TableHead>Reporting %</TableHead>
                      <TableHead>Contracted Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sizeBreakdownRows.map((row) => (
                      <TableRow key={row.bucket}>
                        <TableCell className="font-medium">{row.bucket}</TableCell>
                        <TableCell>{formatNumber(row.total)}</TableCell>
                        <TableCell>{formatNumber(row.reporting)}</TableCell>
                        <TableCell>{formatNumber(row.notReporting)}</TableCell>
                        <TableCell>{formatPercent(row.reportingPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.contractedValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Systems Not Reporting in Last 3 Months</CardTitle>
                    <CardDescription>Part II verified systems only.</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={downloadSizeSiteListCsv}>
                      Download Site List CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSizeSiteListCollapsed((value) => !value)}
                    >
                      {sizeSiteListCollapsed ? "Expand List" : "Collapse List"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleSizeSiteListRows.length)} of{" "}
                    {formatNumber(sizeTabNotReportingPart2Rows.length)} systems
                  </span>
                  {!sizeSiteListCollapsed ? (
                    <span>
                      Page {formatNumber(sizeSiteListCurrentPage)} of {formatNumber(sizeSiteListTotalPages)}
                    </span>
                  ) : null}
                </div>
                {sizeSiteListCollapsed ? (
                  <p className="text-sm text-slate-600">
                    Site list is collapsed. Click <strong>Expand List</strong> to view rows.
                  </p>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>System</TableHead>
                          <TableHead>Tracking ID</TableHead>
                          <TableHead>Portal ID</TableHead>
                          <TableHead>State Certification #</TableHead>
                          <TableHead>Size Bucket</TableHead>
                          <TableHead>System Size (kW AC)</TableHead>
                          <TableHead>Last Reporting Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleSizeSiteListRows.map((system) => (
                          <TableRow key={system.key}>
                            <TableCell className="font-medium">{system.systemName}</TableCell>
                            <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                            <TableCell>{system.systemId ?? "N/A"}</TableCell>
                            <TableCell>{system.stateApplicationRefId ?? "N/A"}</TableCell>
                            <TableCell>{system.sizeBucket}</TableCell>
                            <TableCell>{system.installedKwAc === null ? "N/A" : formatNumber(system.installedKwAc, 3)}</TableCell>
                            <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                          </TableRow>
                        ))}
                        {visibleSizeSiteListRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={7} className="py-6 text-center text-slate-500">
                              No Part II verified non-reporting systems found.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSizeSiteListPage((page) => Math.max(1, page - 1))}
                        disabled={sizeSiteListCurrentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSizeSiteListPage((page) => Math.min(sizeSiteListTotalPages, page + 1))}
                        disabled={sizeSiteListCurrentPage >= sizeSiteListTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>)}

		          {activeTab === "value" && (<div className="space-y-4 mt-4">
            <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
              <Card>
                <CardHeader>
                  <CardDescription>Part II Systems with Value Data</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(recValueRows.length)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Total Contracted Value (Part II Verified)</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(snapshotPart2ValueSummary.totalContractedValue)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Value Gap (Contracted - Delivered)</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(snapshotPart2ValueSummary.totalGap)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Contract Value Reporting %</CardDescription>
                  <CardTitle className="text-2xl">
                    {formatPercent(snapshotPart2ValueSummary.contractedValueReportingPercent)}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

	            <div className="grid gap-4 lg:grid-cols-2">
	              <Card>
	                <CardHeader>
	                  <CardTitle className="text-base">Contracted vs Delivered Value by Reporting Status</CardTitle>
	                  <CardDescription>Part II verified systems grouped into Reporting, Not Reporting, and Terminated.</CardDescription>
	                </CardHeader>
	                <CardContent>
	                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
	                    <ResponsiveContainer width="100%" height="100%">
	                      <BarChart data={recValueByStatusChartRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
	                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
	                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
	                        <YAxis tick={{ fontSize: 12 }} />
	                        <Tooltip
	                          formatter={(value: number, name: string) => [formatCurrency(value), name]}
	                        />
	                        <Legend />
	                        <Bar dataKey="contractedValue" fill="#0ea5e9" name="Contracted Value" />
	                        <Bar dataKey="deliveredValue" fill="#16a34a" name="Delivered Value" />
	                      </BarChart>
	                    </ResponsiveContainer>
	                  </div>
	                </CardContent>
	              </Card>

	              <Card>
	                <CardHeader>
	                  <CardTitle className="text-base">Top Value Gaps by System</CardTitle>
	                  <CardDescription>Largest contracted-vs-delivered dollar gaps across Part II verified systems.</CardDescription>
	                </CardHeader>
	                <CardContent>
	                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
	                    <ResponsiveContainer width="100%" height="100%">
	                      <BarChart data={recTopGapChartRows} margin={{ top: 8, right: 12, left: 4, bottom: 56 }}>
	                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
	                        <XAxis dataKey="label" angle={-35} textAnchor="end" interval={0} height={72} tick={{ fontSize: 10 }} />
	                        <YAxis tick={{ fontSize: 12 }} />
	                        <Tooltip formatter={(value: number) => [formatCurrency(value), "Value Gap"]} />
	                        <Bar dataKey="valueGap" fill="#f59e0b" name="Value Gap" />
	                      </BarChart>
	                    </ResponsiveContainer>
	                  </div>
	                </CardContent>
	              </Card>
	            </div>

	            <Card>
	              <CardHeader>
	                <CardTitle className="text-base">REC Value by System</CardTitle>
                <CardDescription>
                  Compares delivered value vs contracted value at system REC price.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleRecValueRows.length)} of {formatNumber(recValueRows.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(recValueCurrentPage)} of {formatNumber(recValueTotalPages)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>System</TableHead>
                      <TableHead>Tracking ID</TableHead>
                      <TableHead>REC Price</TableHead>
                      <TableHead>Contracted RECs</TableHead>
                      <TableHead>Delivered RECs</TableHead>
                      <TableHead>% Delivered RECs</TableHead>
                      <TableHead>Contracted Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>% Delivered Value</TableHead>
                      <TableHead>Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRecValueRows.map((system) => (
                      <TableRow key={system.key}>
                        <TableCell className="font-medium">{system.systemName}</TableCell>
                        <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                        <TableCell>{formatCurrency(system.recPrice)}</TableCell>
                        <TableCell>{formatNumber(system.contractedRecs)}</TableCell>
                        <TableCell>{formatNumber(system.deliveredRecs)}</TableCell>
                        <TableCell>
                          {formatPercent(
                            toPercentValue(system.deliveredRecs ?? 0, system.contractedRecs ?? 0)
                          )}
                        </TableCell>
                        <TableCell>{formatCurrency(resolveContractValueAmount(system))}</TableCell>
                        <TableCell>{formatCurrency(system.deliveredValue)}</TableCell>
                        <TableCell>
                          {formatPercent(
                            toPercentValue(system.deliveredValue ?? 0, resolveContractValueAmount(system))
                          )}
                        </TableCell>
                        <TableCell className={resolveValueGapAmount(system) > 0 ? "text-amber-700" : ""}>
                          {formatCurrency(resolveValueGapAmount(system))}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleRecValueRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-6 text-center text-slate-500">
                          No systems with REC value data available.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRecValuePage((page) => Math.max(1, page - 1))}
                    disabled={recValueCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRecValuePage((page) => Math.min(recValueTotalPages, page + 1))}
                    disabled={recValueCurrentPage >= recValueTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>)}

	          {activeTab === "contracts" && (<div className="space-y-4 mt-4">
	            <Card>
              <CardHeader>
                <CardTitle className="text-base">Utility Contract ID Tracking</CardTitle>
                <CardDescription>
                  Aggregated by Utility Contract ID and <code>year1_start_date</code>. Matching Contract ID + start
                  date rows are combined.
                </CardDescription>
	              </CardHeader>
	            </Card>

	            <Card>
	              <CardHeader>
	                <CardTitle className="text-base">Contract Delivery Performance Chart</CardTitle>
	                <CardDescription>
	                  Required vs delivered RECs by contract ID (top 20 rows shown), with delivered percent overlay.
	                </CardDescription>
	              </CardHeader>
	              <CardContent>
	                <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
	                  <ResponsiveContainer width="100%" height="100%">
	                    <BarChart data={contractPerformanceChartRows} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
	                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
	                      <XAxis dataKey="contractId" tick={{ fontSize: 11 }} />
	                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
	                      <YAxis
	                        yAxisId="right"
	                        orientation="right"
	                        domain={[0, 100]}
	                        tickFormatter={(value: number) => `${value}%`}
	                        tick={{ fontSize: 11 }}
	                      />
	                      <Tooltip
	                        formatter={(value: number, name: string) => {
	                          if (name === "Delivered %") return [`${formatNumber(value, 1)}%`, name];
	                          return [formatNumber(value), name];
	                        }}
	                      />
	                      <Legend />
	                      <Bar yAxisId="left" dataKey="required" fill="#94a3b8" name="Required RECs" />
	                      <Bar yAxisId="left" dataKey="delivered" fill="#16a34a" name="Delivered RECs" />
	                      <Line
	                        yAxisId="right"
	                        type="monotone"
	                        dataKey="deliveredPercent"
	                        stroke="#2563eb"
	                        strokeWidth={2}
	                        dot={false}
	                        name="Delivered %"
	                      />
	                    </BarChart>
	                  </ResponsiveContainer>
	                </div>
	              </CardContent>
	            </Card>

	            <Card>
	              <CardHeader>
	                <CardTitle className="text-base">Contract Summary</CardTitle>
                <CardDescription>Total required vs delivered by Utility Contract ID.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleContractSummaryRows.length)} of {formatNumber(contractSummaryRows.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(contractSummaryCurrentPage)} of {formatNumber(contractSummaryTotalPages)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Utility Contract ID</TableHead>
                      <TableHead>Start Dates</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Total Required</TableHead>
                      <TableHead>Total Delivered</TableHead>
                      <TableHead>Delivered %</TableHead>
                      <TableHead>Contracted Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                      <TableHead>Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleContractSummaryRows.map((row) => (
                      <TableRow key={row.contractId}>
                        <TableCell className="font-medium">{row.contractId}</TableCell>
                        <TableCell>{formatNumber(row.startDateCount)}</TableCell>
                        <TableCell>{formatNumber(row.projectCount)}</TableCell>
                        <TableCell>{formatNumber(row.required)}</TableCell>
                        <TableCell>{formatNumber(row.delivered)}</TableCell>
                        <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                        <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                          {formatNumber(row.gap)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleContractSummaryRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-6 text-center text-slate-500">
                          No contract summary rows available for current filters.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setContractSummaryPage((page) => Math.max(1, page - 1))}
                    disabled={contractSummaryCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setContractSummaryPage((page) => Math.min(contractSummaryTotalPages, page + 1))}
                    disabled={contractSummaryCurrentPage >= contractSummaryTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contract + Delivery Start Date Detail</CardTitle>
                <CardDescription>
                  For matching contract ID and start date, required and delivered values are aggregated.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleContractDeliveryRows.length)} of {formatNumber(contractDeliveryRows.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(contractDetailCurrentPage)} of {formatNumber(contractDetailTotalPages)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Utility Contract ID</TableHead>
                      <TableHead>Project Delivery Start Date</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Priced Projects</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Delivered</TableHead>
                      <TableHead>Delivered %</TableHead>
                      <TableHead>Contracted Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                      <TableHead>Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleContractDeliveryRows.map((row) => (
                      <TableRow key={`${row.contractId}-${row.deliveryStartRaw}`}>
                        <TableCell className="font-medium">{row.contractId}</TableCell>
                        <TableCell>{row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw}</TableCell>
                        <TableCell>{formatNumber(row.projectCount)}</TableCell>
                        <TableCell>{formatNumber(row.pricedProjectCount)}</TableCell>
                        <TableCell>{formatNumber(row.required)}</TableCell>
                        <TableCell>{formatNumber(row.delivered)}</TableCell>
                        <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                        <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>
                          {formatNumber(row.gap)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleContractDeliveryRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="py-6 text-center text-slate-500">
                          No contract delivery rows available for current filters.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setContractDetailPage((page) => Math.max(1, page - 1))}
                    disabled={contractDetailCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setContractDetailPage((page) => Math.min(contractDetailTotalPages, page + 1))}
                    disabled={contractDetailCurrentPage >= contractDetailTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "annual-review" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Annual REC Delivery Obligation Review</CardTitle>
                <CardDescription>
                  Excel-aligned annual view based on Project Delivery Start Date (<code>year1_start_date</code>) and
                  Utility Contract ID.
                </CardDescription>
              </CardHeader>
            </Card>

            <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              <Card>
                <CardHeader>
                  <CardDescription>Annual Required RECs</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(annualPortfolioSummary.totalRequired)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Annual Delivered RECs</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(annualPortfolioSummary.totalDelivered)}</CardTitle>
                  <CardDescription>{formatPercent(annualPortfolioSummary.totalDeliveredPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>REC Gap</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(annualPortfolioSummary.totalGap)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Required Value</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(annualPortfolioSummary.totalRequiredValue)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Delivered Value</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(annualPortfolioSummary.totalDeliveredValue)}</CardTitle>
                  <CardDescription>{formatPercent(annualPortfolioSummary.totalValueDeliveredPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Value Gap</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(annualPortfolioSummary.totalValueGap)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

	            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardHeader>
                  <CardDescription>Delivery Vintages</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(annualPortfolioSummary.vintageCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Reporting Projects</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(annualPortfolioSummary.totalReportingProjects)}</CardTitle>
                  <CardDescription>{formatPercent(annualPortfolioSummary.totalReportingProjectPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>3-Year Rolling Delivery %</CardDescription>
                  <CardTitle className="text-2xl">{formatPercent(annualPortfolioSummary.rollingThreeDeliveredPercent)}</CardTitle>
                  <CardDescription>
                    {formatNumber(annualPortfolioSummary.rollingThreeDelivered)} /{" "}
                    {formatNumber(annualPortfolioSummary.rollingThreeRequired)} RECs
                  </CardDescription>
                </CardHeader>
              </Card>
	              <Card>
	                <CardHeader>
	                  <CardDescription>3-Year Rolling Value %</CardDescription>
                  <CardTitle className="text-2xl">
                    {formatPercent(annualPortfolioSummary.rollingThreeValueDeliveredPercent)}
                  </CardTitle>
                  <CardDescription>
                    {formatCurrency(annualPortfolioSummary.rollingThreeDeliveredValue)} /{" "}
                    {formatCurrency(annualPortfolioSummary.rollingThreeRequiredValue)}
                  </CardDescription>
	                </CardHeader>
	              </Card>
	            </div>

	            <Card>
	              <CardHeader>
	                <CardTitle className="text-base">Annual Vintage Trend (Required vs Delivered)</CardTitle>
	                <CardDescription>
	                  Trend by Project Delivery Start Date with delivered percent overlay.
	                </CardDescription>
	              </CardHeader>
	              <CardContent>
	                <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
	                  <ResponsiveContainer width="100%" height="100%">
	                    <LineChart data={annualVintageTrendChartRows} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
	                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
	                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
	                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
	                      <YAxis
	                        yAxisId="right"
	                        orientation="right"
	                        domain={[0, 100]}
	                        tickFormatter={(value: number) => `${value}%`}
	                        tick={{ fontSize: 11 }}
	                      />
	                      <Tooltip
	                        formatter={(value: number, name: string) => {
	                          if (name === "Delivered %") return [`${formatNumber(value, 1)}%`, name];
	                          return [formatNumber(value), name];
	                        }}
	                      />
	                      <Legend />
	                      <Line
	                        yAxisId="left"
	                        type="monotone"
	                        dataKey="required"
	                        stroke="#64748b"
	                        strokeWidth={2}
	                        dot
	                        name="Required RECs"
	                      />
	                      <Line
	                        yAxisId="left"
	                        type="monotone"
	                        dataKey="delivered"
	                        stroke="#16a34a"
	                        strokeWidth={2}
	                        dot
	                        name="Delivered RECs"
	                      />
	                      <Line
	                        yAxisId="right"
	                        type="monotone"
	                        dataKey="deliveredPercent"
	                        stroke="#2563eb"
	                        strokeWidth={2}
	                        dot={false}
	                        name="Delivered %"
	                      />
	                    </LineChart>
	                  </ResponsiveContainer>
	                </div>
	              </CardContent>
	            </Card>

	            <Card>
	              <CardHeader>
	                <CardTitle className="text-base">Annual Vintage Summary</CardTitle>
                <CardDescription>
                  Aggregated across all contracts by Project Delivery Start Date (June 1 vintages).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project Delivery Start Date</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Reporting Projects</TableHead>
                      <TableHead>Reporting %</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Delivered</TableHead>
                      <TableHead>Delivered %</TableHead>
                      <TableHead>Required Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                      <TableHead>REC Gap</TableHead>
                      <TableHead>Value Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {annualVintageRows.map((row) => (
                      <TableRow key={row.deliveryStartDate ? row.deliveryStartDate.toISOString() : row.deliveryStartRaw}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <TableCell>{formatNumber(row.projectCount)}</TableCell>
                        <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                        <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                        <TableCell>{formatNumber(row.required)}</TableCell>
                        <TableCell>{formatNumber(row.delivered)}</TableCell>
                        <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                        <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>{formatNumber(row.gap)}</TableCell>
                        <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                          {formatCurrency(row.valueGap)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contract + Vintage Annual Detail</CardTitle>
                <CardDescription>
                  Combined by Utility Contract ID and Project Delivery Start Date.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleAnnualContractVintageRows.length)} of{" "}
                    {formatNumber(annualContractVintageRows.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(annualContractVintageCurrentPage)} of{" "}
                    {formatNumber(annualContractVintageTotalPages)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Utility Contract ID</TableHead>
                      <TableHead>Project Delivery Start Date</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Reporting Projects</TableHead>
                      <TableHead>Reporting %</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Delivered</TableHead>
                      <TableHead>Delivered %</TableHead>
                      <TableHead>Required Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                      <TableHead>REC Gap</TableHead>
                      <TableHead>Value Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleAnnualContractVintageRows.map((row) => (
                      <TableRow key={`${row.contractId}-${row.deliveryStartRaw}`}>
                        <TableCell className="font-medium">{row.contractId}</TableCell>
                        <TableCell>{row.deliveryStartDate ? formatDate(row.deliveryStartDate) : row.deliveryStartRaw}</TableCell>
                        <TableCell>{formatNumber(row.projectCount)}</TableCell>
                        <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                        <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                        <TableCell>{formatNumber(row.required)}</TableCell>
                        <TableCell>{formatNumber(row.delivered)}</TableCell>
                        <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                        <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>{formatNumber(row.gap)}</TableCell>
                        <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                          {formatCurrency(row.valueGap)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleAnnualContractVintageRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={13} className="py-6 text-center text-slate-500">
                          No annual contract vintage rows available.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAnnualContractVintagePage((page) => Math.max(1, page - 1))}
                    disabled={annualContractVintageCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setAnnualContractVintagePage((page) =>
                        Math.min(annualContractVintageTotalPages, page + 1)
                      )
                    }
                    disabled={annualContractVintageCurrentPage >= annualContractVintageTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Annual Contract Totals</CardTitle>
                <CardDescription>
                  Contract-level annual totals across all start dates.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleAnnualContractSummaryRows.length)} of{" "}
                    {formatNumber(annualContractSummaryRows.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(annualContractSummaryCurrentPage)} of{" "}
                    {formatNumber(annualContractSummaryTotalPages)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Utility Contract ID</TableHead>
                      <TableHead>Start Dates</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Reporting Projects</TableHead>
                      <TableHead>Reporting %</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Delivered</TableHead>
                      <TableHead>Delivered %</TableHead>
                      <TableHead>Required Value</TableHead>
                      <TableHead>Delivered Value</TableHead>
                      <TableHead>Value Delivered %</TableHead>
                      <TableHead>REC Gap</TableHead>
                      <TableHead>Value Gap</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleAnnualContractSummaryRows.map((row) => (
                      <TableRow key={row.contractId}>
                        <TableCell className="font-medium">{row.contractId}</TableCell>
                        <TableCell>{formatNumber(row.startDateCount)}</TableCell>
                        <TableCell>{formatNumber(row.projectCount)}</TableCell>
                        <TableCell>{formatNumber(row.reportingProjectCount)}</TableCell>
                        <TableCell>{formatPercent(row.reportingProjectPercent)}</TableCell>
                        <TableCell>{formatNumber(row.required)}</TableCell>
                        <TableCell>{formatNumber(row.delivered)}</TableCell>
                        <TableCell>{formatPercent(row.deliveredPercent)}</TableCell>
                        <TableCell>{formatCurrency(row.requiredValue)}</TableCell>
                        <TableCell>{formatCurrency(row.deliveredValue)}</TableCell>
                        <TableCell>{formatPercent(row.valueDeliveredPercent)}</TableCell>
                        <TableCell className={row.gap > 0 ? "text-amber-700" : ""}>{formatNumber(row.gap)}</TableCell>
                        <TableCell className={row.valueGap > 0 ? "text-amber-700" : ""}>
                          {formatCurrency(row.valueGap)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleAnnualContractSummaryRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={13} className="py-6 text-center text-slate-500">
                          No annual contract summary rows available.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAnnualContractSummaryPage((page) => Math.max(1, page - 1))}
                    disabled={annualContractSummaryCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setAnnualContractSummaryPage((page) =>
                        Math.min(annualContractSummaryTotalPages, page + 1)
                      )
                    }
                    disabled={annualContractSummaryCurrentPage >= annualContractSummaryTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "performance-eval" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">3-Year Rolling Average Annual Report Logic</CardTitle>
                <CardDescription>
                  Mirrors the REC Performance Evaluation model: rolling average by system, expected delivery, surplus
                  allocation, and drawdown payments.
                  <span className="ml-2 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    Deliveries from Transfer History
                  </span>
                </CardDescription>
              </CardHeader>
            </Card>

            {performanceContractOptions.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">No Performance Data Available</CardTitle>
                  <CardDescription>
                    Upload ABP Report and Solar Applications, then scrape Schedule B PDFs in the Delivery
                    Tracker tab to populate obligations, to calculate performance evaluation metrics.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Evaluation Controls</CardTitle>
                    <CardDescription>
                      Select the contract and delivery year, then set prior carry-forward values if needed.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Contract ID</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={effectivePerformanceContractId}
                        onChange={(event) => setPerformanceContractId(event.target.value)}
                      >
                        <option value="__ALL__">All Contracts</option>
                        {performanceContractOptions.map((contractId) => (
                          <option key={contractId} value={contractId}>
                            {contractId}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Delivery Year</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={effectivePerformanceDeliveryYearKey}
                        onChange={(event) => setPerformanceDeliveryYearKey(event.target.value)}
                      >
                        {performanceDeliveryYearOptions.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">
                        Previous DY Aggregate Surplus RECs (after allocation)
                      </label>
                      <Input
                        type="number"
                        step="1"
                        value={performancePreviousSurplusInput}
                        onChange={(event) => setPerformancePreviousSurplusInput(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">
                        Previous DY Aggregate Drawdown Payments (&lt;$5,000)
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={performancePreviousDrawdownInput}
                        onChange={(event) => setPerformancePreviousDrawdownInput(event.target.value)}
                      />
                    </div>
                  </CardContent>
                </Card>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <Card>
                    <CardHeader>
                      <CardDescription>Contract ID</CardDescription>
                      <CardTitle className="text-2xl">{effectivePerformanceContractId === "__ALL__" ? "All Contracts" : (effectivePerformanceContractId || "N/A")}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Delivery Year</CardDescription>
                      <CardTitle className="text-2xl">{performanceSelectedDeliveryYearLabel}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Systems in Evaluation</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.systemCount)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Shortfall Systems</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.shortfallSystemCount)}</CardTitle>
                    </CardHeader>
                  </Card>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <Card>
                    <CardHeader>
                      <CardDescription>Surplus RECs (before allocation, this report)</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.surplusBeforeAllocation)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>RECs Allocated (lowest price first)</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.totalAllocatedRecs)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Net Surplus RECs After Allocation</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.netSurplusAfterAllocation)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Unallocated Shortfall RECs</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(recPerformanceEvaluation.unallocatedShortfallRecs)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Drawdown Payments (this report)</CardDescription>
                      <CardTitle className="text-2xl">{formatCurrency(recPerformanceEvaluation.drawdownThisReport)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Drawdown Payments (cumulative)</CardDescription>
                      <CardTitle className="text-2xl">{formatCurrency(recPerformanceEvaluation.drawdownCumulative)}</CardTitle>
                    </CardHeader>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Current Year 3-Year Rolling Summary by Contract</CardTitle>
                    <CardDescription>
                      Delivery Year {performanceSelectedDeliveryYearLabel}. Includes only systems currently in 3-year
                      rolling review for that year. Contracts 846, 918, and Unassigned are shown even when obligation is 0.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <Card>
                        <CardHeader>
                          <CardDescription>Contracts Due This Year</CardDescription>
                          <CardTitle className="text-2xl">
                            {formatNumber(recPerformanceContractYearSummaryTotals.contractsDueThisYear)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardDescription>Systems in 3-Year Review (Current Year)</CardDescription>
                          <CardTitle className="text-2xl">
                            {formatNumber(recPerformanceContractYearSummaryTotals.totalSystemsInThreeYearReview)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardDescription>Total REC Delivery Obligation (3-Year Rolling)</CardDescription>
                          <CardTitle className="text-2xl">
                            {formatNumber(recPerformanceContractYearSummaryTotals.totalRecDeliveryObligation)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardDescription>Total Deliveries (3-Year Rolling Review Systems)</CardDescription>
                          <CardTitle className="text-2xl">
                            {formatNumber(recPerformanceContractYearSummaryTotals.totalDeliveriesFromThreeYearReview)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardDescription>Delta RECs (Delivered - Obligation)</CardDescription>
                          <CardTitle
                            className={`text-2xl ${
                              recPerformanceContractYearSummaryTotals.recDelta < 0
                                ? "text-rose-700"
                                : recPerformanceContractYearSummaryTotals.recDelta > 0
                                  ? "text-emerald-700"
                                  : ""
                            }`}
                          >
                            {formatSignedNumber(recPerformanceContractYearSummaryTotals.recDelta)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardDescription>Total Drawdown Amount</CardDescription>
                          <CardTitle className="text-2xl">
                            {formatCurrency(recPerformanceContractYearSummaryTotals.totalDrawdownAmount)}
                          </CardTitle>
                        </CardHeader>
                      </Card>
                    </div>

                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Contract ID</TableHead>
                          <TableHead>Systems in 3-Year Review</TableHead>
                          <TableHead>3-Year Rolling Obligation (RECs)</TableHead>
                          <TableHead>Total Deliveries (3-Year Rolling)</TableHead>
                          <TableHead>Delta RECs</TableHead>
                          <TableHead>Total Drawdown Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {recPerformanceContractYearSummaryRows.map((row) => (
                          <TableRow key={`rec-performance-contract-summary-${row.contractId}`}>
                            <TableCell className="font-medium">{row.contractId}</TableCell>
                            <TableCell>{formatNumber(row.systemsInThreeYearReview)}</TableCell>
                            <TableCell>{formatNumber(row.totalRecDeliveryObligation)}</TableCell>
                            <TableCell>{formatNumber(row.totalDeliveriesFromThreeYearReview)}</TableCell>
                            <TableCell
                              className={
                                row.recDelta < 0 ? "text-rose-700 font-semibold" : row.recDelta > 0 ? "text-emerald-700 font-semibold" : ""
                              }
                            >
                              {formatSignedNumber(row.recDelta)}
                            </TableCell>
                            <TableCell>{formatCurrency(row.totalDrawdownAmount)}</TableCell>
                          </TableRow>
                        ))}
                        {recPerformanceContractYearSummaryRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} className="py-6 text-center text-slate-500">
                              No contract-level REC performance rows available for this delivery year.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-start justify-between">
                    <div>
                      <CardTitle className="text-base">Results by System</CardTitle>
                      <CardDescription>
                        Columns follow the REC Performance Evaluation workbook structure.
                      </CardDescription>
                    </div>
                    {recPerformanceEvaluation.rows.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const csv = buildCsv(
                            [
                              "application_id", "unit_id", "system_name", "contract_id",
                              "schedule_year", "dy1_recs", "dy1_source",
                              "dy2_recs", "dy2_source", "dy3_recs", "dy3_source",
                              "three_year_avg_floor", "contract_price",
                              "expected_recs", "surplus_shortfall",
                              "recs_allocated", "drawdown_payment",
                            ],
                            recPerformanceEvaluation.rows.map((r) => ({
                              application_id: r.applicationId,
                              unit_id: r.unitId,
                              system_name: r.systemName,
                              contract_id: r.contractId,
                              schedule_year: r.scheduleYearNumber,
                              dy1_recs: r.deliveryYearOne,
                              dy1_source: r.deliveryYearOneSource,
                              dy2_recs: r.deliveryYearTwo,
                              dy2_source: r.deliveryYearTwoSource,
                              dy3_recs: r.deliveryYearThree,
                              dy3_source: r.deliveryYearThreeSource,
                              three_year_avg_floor: r.rollingAverage,
                              contract_price: r.contractPrice,
                              expected_recs: r.expectedRecs,
                              surplus_shortfall: r.surplusShortfall,
                              recs_allocated: r.allocatedRecs,
                              drawdown_payment: r.drawdownPayment,
                            }))
                          );
                          const contractSlug = effectivePerformanceContractId === "__ALL__" ? "all-contracts" : `contract-${effectivePerformanceContractId}`;
                          triggerCsvDownload(
                            `rec-performance-eval-${contractSlug}-dy${performanceSelectedDeliveryYearLabel}-${timestampForCsvFileName()}.csv`,
                            csv
                          );
                        }}>Export CSV</Button>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span>
                        Showing {formatNumber(visibleRecPerformanceRows.length)} of{" "}
                        {formatNumber(recPerformanceEvaluation.rows.length)} rows
                      </span>
                      <span>
                        Page {formatNumber(recPerformanceResultsCurrentPage)} of{" "}
                        {formatNumber(recPerformanceResultsTotalPages)}
                      </span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Application ID</TableHead>
                          <TableHead>Unit ID</TableHead>
                          <TableHead>System</TableHead>
                          <TableHead>Yr</TableHead>
                          <TableHead>DY 1 (RECs)</TableHead>
                          <TableHead>DY 2 (RECs)</TableHead>
                          <TableHead>DY 3 (RECs)</TableHead>
                          <TableHead>3-Year Avg (Floor)</TableHead>
                          <TableHead>Contract Price ($/REC)</TableHead>
                          <TableHead>Expected RECs</TableHead>
                          <TableHead>Surplus / (Shortfall)</TableHead>
                          <TableHead>RECs Allocated</TableHead>
                          <TableHead>Drawdown Payment</TableHead>
                          <TableHead>DY 1 Source</TableHead>
                          <TableHead>DY 2 Source</TableHead>
                          <TableHead>DY 3 Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleRecPerformanceRows.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell>{row.applicationId}</TableCell>
                            <TableCell>{row.unitId}</TableCell>
                            <TableCell className="font-medium">{row.systemName}</TableCell>
                            <TableCell className="text-center text-xs text-slate-500">{row.scheduleYearNumber}</TableCell>
                            <TableCell>{formatNumber(row.deliveryYearOne)}</TableCell>
                            <TableCell>{formatNumber(row.deliveryYearTwo)}</TableCell>
                            <TableCell>{formatNumber(row.deliveryYearThree)}</TableCell>
                            <TableCell>{formatNumber(row.rollingAverage)}</TableCell>
                            <TableCell>{formatCurrency(row.contractPrice)}</TableCell>
                            <TableCell>{formatNumber(row.expectedRecs)}</TableCell>
                            <TableCell
                              className={
                                row.surplusShortfall < 0 ? "text-rose-700 font-semibold" : row.surplusShortfall > 0 ? "text-emerald-700 font-semibold" : ""
                              }
                            >
                              {formatSignedNumber(row.surplusShortfall)}
                            </TableCell>
                            <TableCell>{formatNumber(row.allocatedRecs)}</TableCell>
                            <TableCell className={row.drawdownPayment < 0 ? "text-rose-700 font-semibold" : ""}>
                              {formatCurrency(row.drawdownPayment)}
                            </TableCell>
                            <TableCell>{row.deliveryYearOneSource}</TableCell>
                            <TableCell>{row.deliveryYearTwoSource}</TableCell>
                            <TableCell>{row.deliveryYearThreeSource}</TableCell>
                          </TableRow>
                        ))}
                        {visibleRecPerformanceRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={16} className="py-6 text-center text-slate-500">
                              No REC performance rows available.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRecPerformanceResultsPage((page) => Math.max(1, page - 1))}
                        disabled={recPerformanceResultsCurrentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setRecPerformanceResultsPage((page) =>
                            Math.min(recPerformanceResultsTotalPages, page + 1)
                          )
                        }
                        disabled={recPerformanceResultsCurrentPage >= recPerformanceResultsTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>)}

          {activeTab === "change-ownership" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Change of Ownership Logic</CardTitle>
                <CardDescription>
                  A system is flagged for COO when contract type is IL ABP - Transferred/Terminated, or when Zillow is
                  Sold and sold date is after contract date.
                </CardDescription>
              </CardHeader>
            </Card>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardDescription>Flagged Change of Ownership Systems</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(changeOwnershipSummary.total)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Reporting (Last 3 Months)</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(changeOwnershipSummary.reporting)}</CardTitle>
                  <CardDescription>{formatPercent(changeOwnershipSummary.reportingPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Not Reporting (Last 3 Months)</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(changeOwnershipSummary.notReporting)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardDescription>Contract Value (COO Total)</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(changeOwnershipSummary.contractedValueTotal)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Contract Value Reporting</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(changeOwnershipSummary.contractedValueReporting)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Contract Value Not Reporting</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(changeOwnershipSummary.contractedValueNotReporting)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status Breakdown</CardTitle>
                <CardDescription>
                  Uses contract type for IL ABP Transferred/Terminated, otherwise marks as Change of Ownership - Not
                  Transferred.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {changeOwnershipSummary.counts.map((item) => (
                  <div key={item.status} className="rounded-lg border border-slate-200 p-3 bg-white">
                    <p className="text-xs text-slate-500">{item.status}</p>
                    <p className="text-2xl font-semibold text-slate-900">{formatNumber(item.count)}</p>
                    <p className="text-xs text-slate-500">{formatPercent(item.percent)}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <CardTitle className="text-base">Flagged Systems Detail</CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadChangeOwnershipDetailFilteredCsv}
                    disabled={filteredChangeOwnershipRows.length === 0}
                  >
                    Export Filtered Table CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Filter by status</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={changeOwnershipFilter}
                      onChange={(event) =>
                        setChangeOwnershipFilter(event.target.value as ChangeOwnershipStatus | "All")
                      }
                    >
                      <option value="All">All Categories</option>
                      {CHANGE_OWNERSHIP_ORDER.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Search</label>
                    <Input
                      placeholder="System name, IDs, contract type..."
                      value={changeOwnershipSearch}
                      onChange={(event) => setChangeOwnershipSearch(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Sort by</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={changeOwnershipSortBy}
                      onChange={(event) =>
                        setChangeOwnershipSortBy(
                          event.target.value as
                            | "systemName"
                            | "contractValue"
                            | "installedKwAc"
                            | "contractDate"
                            | "zillowSoldDate"
                            | "status"
                            | "reporting"
                        )
                      }
                    >
                      <option value="contractValue">Contract Value</option>
                      <option value="installedKwAc">AC Size (kW)</option>
                      <option value="contractDate">Contract Date</option>
                      <option value="zillowSoldDate">Zillow Sold Date</option>
                      <option value="status">Status Category</option>
                      <option value="reporting">Reporting</option>
                      <option value="systemName">System Name</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Direction</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={changeOwnershipSortDir}
                      onChange={(event) => setChangeOwnershipSortDir(event.target.value as "asc" | "desc")}
                    >
                      <option value="desc">Descending</option>
                      <option value="asc">Ascending</option>
                    </select>
                  </div>
                </div>

                {filteredChangeOwnershipRows.length > 500 ? (
                  <p className="text-xs text-slate-500">
                    Showing first 500 of {formatNumber(filteredChangeOwnershipRows.length)} systems.
                  </p>
                ) : null}

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>System</TableHead>
                      <TableHead>system_id</TableHead>
                      <TableHead>Tracking ID</TableHead>
                      <TableHead>AC Size (kW)</TableHead>
                      <TableHead>Contract Value</TableHead>
                      <TableHead>Contract Date</TableHead>
                      <TableHead>Zillow Sold Date</TableHead>
                      <TableHead>Zillow Status</TableHead>
                      <TableHead>Contract Type</TableHead>
                      <TableHead>Status Category</TableHead>
                      <TableHead>Reporting?</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredChangeOwnershipRows.slice(0, 500).map((system) => (
                      <TableRow key={system.key}>
                        <TableCell className="font-medium">{system.systemName}</TableCell>
                        <TableCell>{system.systemId ?? "N/A"}</TableCell>
                        <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                        <TableCell>{formatCapacityKw(system.installedKwAc)}</TableCell>
                        <TableCell>{formatCurrency(resolveContractValueAmount(system))}</TableCell>
                        <TableCell>{formatDate(system.contractedDate)}</TableCell>
                        <TableCell>{formatDate(system.zillowSoldDate)}</TableCell>
                        <TableCell>{system.zillowStatus ?? "N/A"}</TableCell>
                        <TableCell>{system.contractType ?? "N/A"}</TableCell>
                        <TableCell>
                          {system.changeOwnershipStatus ? (
                            <span
                              className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${changeOwnershipBadgeClass(system.changeOwnershipStatus)}`}
                            >
                              {system.changeOwnershipStatus}
                            </span>
                          ) : (
                            "N/A"
                          )}
                        </TableCell>
                        <TableCell>{system.isReporting ? "Yes" : "No"}</TableCell>
                      </TableRow>
                    ))}
                    {filteredChangeOwnershipRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="py-6 text-center text-slate-500">
                          No flagged systems match the current filters.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "ownership" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ownership Status Classifier</CardTitle>
                <CardDescription>
                  Categories: Transferred, Not Transferred, and Terminated crossed with Reporting / Not Reporting.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Filter by category</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={ownershipFilter}
                      onChange={(event) => setOwnershipFilter(event.target.value as OwnershipStatus | "All")}
                    >
                      <option value="All">All Categories</option>
                      {OWNERSHIP_ORDER.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Search</label>
                    <Input
                      placeholder="System name, system_id, tracking ID..."
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                    />
                  </div>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>System</TableHead>
                      <TableHead>system_id</TableHead>
                      <TableHead>Tracking ID</TableHead>
                      <TableHead>Status Category</TableHead>
                      <TableHead>Reporting?</TableHead>
                      <TableHead>Transferred?</TableHead>
                      <TableHead>Terminated?</TableHead>
                      <TableHead>Contract Type</TableHead>
                      <TableHead>Last Reporting Date</TableHead>
                      <TableHead>Contracted Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOwnershipRows.slice(0, 500).map((system) => (
                      <TableRow key={system.key}>
                        <TableCell className="font-medium">{system.systemName}</TableCell>
                        <TableCell>{system.systemId ?? "N/A"}</TableCell>
                        <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${ownershipBadgeClass(system.ownershipStatus)}`}
                          >
                            {system.ownershipStatus}
                          </span>
                        </TableCell>
                        <TableCell>{system.isReporting ? "Yes" : "No"}</TableCell>
                        <TableCell>{system.isTransferred ? "Yes" : "No"}</TableCell>
                        <TableCell>{system.isTerminated ? "Yes" : "No"}</TableCell>
                        <TableCell>{system.contractType ?? "N/A"}</TableCell>
                        <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                        <TableCell>{formatDate(system.contractedDate)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "offline-monitoring" && (<div className="space-y-4 mt-4">
            <Card id="offline-overview" className="scroll-mt-24">
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <CardTitle className="text-base">Non-Reporting Systems by Monitoring Method, Platform, and Installer</CardTitle>
                    <CardDescription>
                      Offline status means not reporting to GATS within the last 3 months.
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={downloadOfflineSystemsCsv}>
                    Download Offline Systems CSV
                  </Button>
                </div>
              </CardHeader>
            </Card>

            <Card className="border-slate-200/80 bg-slate-50/70">
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Jump to</span>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-overview")}>
                    Overview
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-summary")}>
                    Summary
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-by-method")}>
                    By Method
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-by-platform")}>
                    By Platform
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-by-installer")}>
                    By Installer
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-zero-reporting")}>
                    0% Reporting
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => jumpToSection("offline-detail")}>
                    Offline Detail
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div id="offline-summary" className="grid gap-4 md:grid-cols-2 xl:grid-cols-6 scroll-mt-24">
              <Card>
                <CardHeader>
                  <CardDescription>Total Offline Systems</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(offlineSummary.offlineSystemCount)}</CardTitle>
                  <CardDescription>{formatPercent(offlineSummary.offlineSystemPercent)}</CardDescription>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Filtered Offline Systems</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(offlineSummary.filteredOfflineCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Monitoring Methods</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(offlineSummary.monitoringTypeCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Monitoring Platforms</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(offlineSummary.monitoringPlatformCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Installers</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(offlineSummary.installerCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Offline Contract Value</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(offlineSummary.totalOfflineContractValue)}</CardTitle>
                  <CardDescription>{formatPercent(offlineSummary.offlineContractValuePercent)}</CardDescription>
                </CardHeader>
              </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card id="offline-by-method" className="scroll-mt-24">
                <CardHeader>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <CardTitle className="text-base">Offline by Monitoring Method</CardTitle>
                      <CardDescription>
                        Includes offline percentage and contract value by monitoring method (Granted Access, Password, Link, etc).
                      </CardDescription>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-700">Sort by</label>
                        <select
                          className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                          value={offlineMonitoringSortBy}
                          onChange={(event) =>
                            setOfflineMonitoringSortBy(
                              event.target.value as "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
                            )
                          }
                        >
                          <option value="offlineSystems">Offline Systems</option>
                          <option value="offlinePercent">Offline %</option>
                          <option value="offlineContractValue">Offline Contract Value</option>
                          <option value="label">Monitoring Method</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-700">Direction</label>
                        <select
                          className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                          value={offlineMonitoringSortDir}
                          onChange={(event) => setOfflineMonitoringSortDir(event.target.value as "asc" | "desc")}
                        >
                          <option value="desc">Descending</option>
                          <option value="asc">Ascending</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Monitoring Method</TableHead>
                        <TableHead>Total Systems</TableHead>
                        <TableHead>Offline Systems</TableHead>
                        <TableHead>Offline %</TableHead>
                        <TableHead>Offline Contract Value</TableHead>
                        <TableHead>Offline Value %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {offlineMonitoringBreakdownRows.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell className="font-medium">{row.label}</TableCell>
                          <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                          <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                          <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                          <TableCell>{formatCurrency(row.offlineContractValue)}</TableCell>
                          <TableCell>{formatPercent(row.offlineContractValuePercent)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card id="offline-by-platform" className="scroll-mt-24">
                <CardHeader>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <CardTitle className="text-base">Offline by Monitoring Platform</CardTitle>
                      <CardDescription>
                        Includes offline percentage and contract value by monitoring platform (SolarEdge, Enphase, ennexOS, etc).
                      </CardDescription>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-700">Sort by</label>
                        <select
                          className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                          value={offlinePlatformSortBy}
                          onChange={(event) =>
                            setOfflinePlatformSortBy(
                              event.target.value as "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
                            )
                          }
                        >
                          <option value="offlineSystems">Offline Systems</option>
                          <option value="offlinePercent">Offline %</option>
                          <option value="offlineContractValue">Offline Contract Value</option>
                          <option value="label">Monitoring Platform</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-700">Direction</label>
                        <select
                          className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                          value={offlinePlatformSortDir}
                          onChange={(event) => setOfflinePlatformSortDir(event.target.value as "asc" | "desc")}
                        >
                          <option value="desc">Descending</option>
                          <option value="asc">Ascending</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Monitoring Platform</TableHead>
                        <TableHead>Total Systems</TableHead>
                        <TableHead>Offline Systems</TableHead>
                        <TableHead>Offline %</TableHead>
                        <TableHead>Offline Contract Value</TableHead>
                        <TableHead>Offline Value %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {offlinePlatformBreakdownRows.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell className="font-medium">{row.label}</TableCell>
                          <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                          <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                          <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                          <TableCell>{formatCurrency(row.offlineContractValue)}</TableCell>
                          <TableCell>{formatPercent(row.offlineContractValuePercent)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            <Card id="offline-by-installer" className="scroll-mt-24">
              <CardHeader>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <CardTitle className="text-base">Offline by Installer</CardTitle>
                    <CardDescription>
                      Includes offline percentage and contract value by installer.
                    </CardDescription>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Sort by</label>
                      <select
                        className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                        value={offlineInstallerSortBy}
                        onChange={(event) =>
                          setOfflineInstallerSortBy(
                            event.target.value as "offlineSystems" | "offlinePercent" | "offlineContractValue" | "label"
                          )
                        }
                      >
                        <option value="offlineSystems">Offline Systems</option>
                        <option value="offlinePercent">Offline %</option>
                        <option value="offlineContractValue">Offline Contract Value</option>
                        <option value="label">Installer</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Direction</label>
                      <select
                        className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                        value={offlineInstallerSortDir}
                        onChange={(event) => setOfflineInstallerSortDir(event.target.value as "asc" | "desc")}
                      >
                        <option value="desc">Descending</option>
                        <option value="asc">Ascending</option>
                      </select>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Installer</TableHead>
                      <TableHead>Total Systems</TableHead>
                      <TableHead>Offline Systems</TableHead>
                      <TableHead>Offline %</TableHead>
                      <TableHead>Offline Contract Value</TableHead>
                      <TableHead>Offline Value %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {offlineInstallerBreakdownRows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                        <TableCell>{formatNumber(row.offlineSystems)}</TableCell>
                        <TableCell>{formatPercent(row.offlinePercent)}</TableCell>
                        <TableCell>{formatCurrency(row.offlineContractValue)}</TableCell>
                        <TableCell>{formatPercent(row.offlineContractValuePercent)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card id="offline-zero-reporting" className="scroll-mt-24">
              <CardHeader>
                <CardTitle className="text-base">Installer + Monitoring Platform with 0% Reporting (&gt;10 Systems)</CardTitle>
                <CardDescription>
                  Combinations where no systems are reporting and total systems exceed 10.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {zeroReportingInstallerPlatformRows.length === 0 ? (
                  <p className="text-sm text-slate-600">No combinations currently match this criteria.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Installer</TableHead>
                        <TableHead>Monitoring Platform</TableHead>
                        <TableHead>Total Systems</TableHead>
                        <TableHead>Reporting %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {zeroReportingInstallerPlatformRows.map((row) => (
                        <TableRow key={`${row.installerName}-${row.monitoringPlatform}`}>
                          <TableCell className="font-medium">{row.installerName}</TableCell>
                          <TableCell>{row.monitoringPlatform}</TableCell>
                          <TableCell>{formatNumber(row.totalSystems)}</TableCell>
                          <TableCell className="text-rose-700 font-semibold">
                            {formatPercent(row.reportingPercent)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card id="offline-detail" className="scroll-mt-24">
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <CardTitle className="text-base">Offline Systems Detail</CardTitle>
                    <CardDescription>Filterable and sortable list of non-reporting systems.</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadOfflineDetailFilteredCsv}
                    disabled={filteredOfflineSystems.length === 0}
                  >
                    Export Filtered Table CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Monitoring method</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={offlineMonitoringFilter}
                      onChange={(event) => setOfflineMonitoringFilter(event.target.value)}
                    >
                      <option value="All">All Monitoring Methods</option>
                      {offlineMonitoringOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Monitoring platform</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={offlinePlatformFilter}
                      onChange={(event) => setOfflinePlatformFilter(event.target.value)}
                    >
                      <option value="All">All Platforms</option>
                      {offlinePlatformOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Installer</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={offlineInstallerFilter}
                      onChange={(event) => setOfflineInstallerFilter(event.target.value)}
                    >
                      <option value="All">All Installers</option>
                      {offlineInstallerOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Sort by</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={offlineDetailSortBy}
                      onChange={(event) =>
                        setOfflineDetailSortBy(
                          event.target.value as
                            | "systemName"
                            | "monitoringType"
                            | "monitoringPlatform"
                            | "installerName"
                            | "contractedValue"
                            | "latestReportingDate"
                        )
                      }
                    >
                      <option value="contractedValue">Contract Value</option>
                      <option value="latestReportingDate">Last Reporting Date</option>
                      <option value="systemName">System Name</option>
                      <option value="monitoringType">Monitoring Method</option>
                      <option value="monitoringPlatform">Monitoring Platform</option>
                      <option value="installerName">Installer</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Direction</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                      value={offlineDetailSortDir}
                      onChange={(event) => setOfflineDetailSortDir(event.target.value as "asc" | "desc")}
                    >
                      <option value="desc">Descending</option>
                      <option value="asc">Ascending</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Search</label>
                    <Input
                      placeholder="System, IDs, method, platform, installer, monitoring access..."
                      value={offlineSearch}
                      onChange={(event) => setOfflineSearch(event.target.value)}
                    />
                  </div>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>System</TableHead>
                      <TableHead>system_id</TableHead>
                      <TableHead>Tracking ID</TableHead>
                      <TableHead>Monitoring Method</TableHead>
                      <TableHead>Monitoring Platform</TableHead>
                      <TableHead>Access Type</TableHead>
                      <TableHead>Monitoring Site ID</TableHead>
                      <TableHead>Monitoring Site Name</TableHead>
                      <TableHead>Monitoring Link</TableHead>
                      <TableHead>Monitoring Username</TableHead>
                      <TableHead>Monitoring Password</TableHead>
                      <TableHead>Installer</TableHead>
                      <TableHead>Last Reporting Date</TableHead>
                      <TableHead>Last Report (kWh)</TableHead>
                      <TableHead>Contract Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleOfflineDetailRows.map((system) => {
                      const accessFields = resolveOfflineMonitoringAccessFields(system, monitoringDetailsBySystemKey);
                      return (
                        <TableRow key={system.key}>
                          <TableCell className="font-medium">{system.systemName}</TableCell>
                          <TableCell>{system.systemId ?? "N/A"}</TableCell>
                          <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                          <TableCell>{system.monitoringType}</TableCell>
                          <TableCell>{system.monitoringPlatform}</TableCell>
                          <TableCell>{accessFields.accessType || "N/A"}</TableCell>
                          <TableCell>{accessFields.monitoringSiteId || "N/A"}</TableCell>
                          <TableCell>{accessFields.monitoringSiteName || "N/A"}</TableCell>
                          <TableCell className="max-w-[18rem] break-all">
                            {accessFields.monitoringLink ? (
                              <a
                                href={accessFields.monitoringLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 underline"
                              >
                                {accessFields.monitoringLink}
                              </a>
                            ) : (
                              "N/A"
                            )}
                          </TableCell>
                          <TableCell>{accessFields.monitoringUsername || "N/A"}</TableCell>
                          <TableCell>{accessFields.monitoringPassword || "N/A"}</TableCell>
                          <TableCell>{system.installerName}</TableCell>
                          <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                          <TableCell>{formatKwh(system.latestReportingKwh)}</TableCell>
                          <TableCell>{formatCurrency(system.contractedValue)}</TableCell>
                        </TableRow>
                      );
                    })}
                    {visibleOfflineDetailRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={15} className="py-6 text-center text-slate-500">
                          No offline systems match the current filters.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    Showing {formatNumber(visibleOfflineDetailRows.length)} of{" "}
                    {formatNumber(filteredOfflineSystems.length)} rows
                  </span>
                  <span>
                    Page {formatNumber(offlineDetailCurrentPage)} of {formatNumber(offlineDetailTotalPages)}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOfflineDetailPage((page) => Math.max(1, page - 1))}
                    disabled={offlineDetailCurrentPage <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOfflineDetailPage((page) => Math.min(offlineDetailTotalPages, page + 1))}
                    disabled={offlineDetailCurrentPage >= offlineDetailTotalPages}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "meter-reads" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Meter Read Workbook Converter</CardTitle>
                <CardDescription>
                  Upload the monthly meter read Excel workbook and generate the full portal-ready CSV output in one step.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                    <Upload className="h-4 w-4" />
                    Choose Excel Workbook
                    <input
                      type="file"
                      accept=".xlsx,.xlsm,.xlsb,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        void handleMeterReadsUpload(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>

                  <Button variant="outline" onClick={downloadMeterReadsCsv} disabled={!meterReadsResult || meterReadsBusy}>
                    Download Converted CSV
                  </Button>

                  {meterReadsBusy ? (
                    <Badge className="bg-blue-100 text-blue-800 border-blue-200">Processing workbook...</Badge>
                  ) : null}
                </div>

                {meterReadsError ? <p className="text-sm text-rose-700">{meterReadsError}</p> : null}

                {meterReadsResult ? (
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs text-slate-500">Source Workbook</p>
                      <p className="text-sm font-medium text-slate-900 break-all">{meterReadsResult.sourceWorkbookName}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs text-slate-500">Read Date</p>
                      <p className="text-sm font-medium text-slate-900">{meterReadsResult.readDate}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs text-slate-500">Output Rows</p>
                      <p className="text-sm font-medium text-slate-900">{formatNumber(meterReadsResult.totalRows)}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs text-slate-500">Monitoring Platforms</p>
                      <p className="text-sm font-medium text-slate-900">{formatNumber(meterReadsResult.byMonitoring.length)}</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">
                    No workbook converted yet. Choose an Excel file to generate the output CSV.
                  </p>
                )}

                {meterReadsResult && meterReadsResult.notes.length > 0 ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                    <p className="text-xs font-medium text-amber-900 mb-2">Conversion Notes</p>
                    <ul className="list-disc pl-5 space-y-1 text-xs text-amber-800">
                      {meterReadsResult.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {meterReadsResult ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Rows by Monitoring Platform</CardTitle>
                  <CardDescription>
                    Confirms how many rows were generated per platform before you download/upload.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Monitoring</TableHead>
                        <TableHead>Rows</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {meterReadsResult.byMonitoring.map((item) => (
                        <TableRow key={item.monitoring}>
                          <TableCell className="font-medium">{item.monitoring}</TableCell>
                          <TableCell>{formatNumber(item.rows)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}
          </div>)}

          {activeTab === "performance-ratio" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Converted Reads Performance Ratio</CardTitle>
                <CardDescription>
                  Matches converted reads to ABP Part II verified portal systems using monitoring + system ID, monitoring
                  + system name, or monitoring + both. Performance Ratio = production delta from baseline / expected
                  production over the same period. If no GATS baseline exists, optional Generator Details upload is used
                  as fallback (Date Online month/year assumed day 15, baseline meter read = 0).
                </CardDescription>
              </CardHeader>
            </Card>

            {!datasets.convertedReads || !datasets.annualProductionEstimates ? (
              <Card className="border-amber-200 bg-amber-50/60">
                <CardHeader>
                  <CardTitle className="text-base text-amber-900">Missing Files for Performance Ratio</CardTitle>
                  <CardDescription className="text-amber-800">
                    Upload these files in Step 1:{" "}
                    {[
                      !datasets.convertedReads ? DATASET_DEFINITIONS.convertedReads.label : null,
                      !datasets.annualProductionEstimates ? DATASET_DEFINITIONS.annualProductionEstimates.label : null,
                    ]
                      .filter((value): value is string => value !== null)
                      .join(", ")}
                    .
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
                  <Card>
                    <CardHeader>
                      <CardDescription>Converted Read Rows</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(performanceRatioSummary.convertedReadCount)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Matched Read Rows</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(performanceRatioSummary.matchedConvertedReads)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Unmatched Read Rows</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(performanceRatioSummary.unmatchedConvertedReads)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Allocations (Read-to-System)</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(performanceRatioSummary.allocationCount)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Portfolio Performance Ratio</CardDescription>
                      <CardTitle className="text-2xl">{formatPercent(performanceRatioSummary.portfolioRatioPercent)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Total Delta Production (kWh)</CardDescription>
                      <CardTitle className="text-2xl">{formatNumber(performanceRatioSummary.totalDeltaWh / 1_000)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Total Expected Production (kWh)</CardDescription>
                      <CardTitle className="text-2xl">
                        {formatNumber(performanceRatioSummary.totalExpectedWh / 1_000)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Performance Ratio Filters</CardTitle>
                    <CardDescription>
                      Expected production uses Annual Production Estimates monthly values, prorated by days when the read
                      window starts/ends mid-month.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Monitoring</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={performanceRatioMonitoringFilter}
                        onChange={(event) => setPerformanceRatioMonitoringFilter(event.target.value)}
                      >
                        <option value="All">All Monitoring</option>
                        {performanceRatioMonitoringOptions.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Match Type</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={performanceRatioMatchFilter}
                        onChange={(event) => setPerformanceRatioMatchFilter(event.target.value as PerformanceRatioMatchType | "All")}
                      >
                        <option value="All">All Match Types</option>
                        <option value="Monitoring + System ID + System Name">Monitoring + System ID + System Name</option>
                        <option value="Monitoring + System ID">Monitoring + System ID</option>
                        <option value="Monitoring + System Name">Monitoring + System Name</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Sort by</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={performanceRatioSortBy}
                        onChange={(event) =>
                          setPerformanceRatioSortBy(
                            event.target.value as
                              | "performanceRatioPercent"
                              | "productionDeltaWh"
                              | "expectedProductionWh"
                              | "systemName"
                              | "readDate"
                          )
                        }
                      >
                        <option value="performanceRatioPercent">Performance Ratio</option>
                        <option value="productionDeltaWh">Production Delta</option>
                        <option value="expectedProductionWh">Expected Production</option>
                        <option value="readDate">Read Date</option>
                        <option value="systemName">System Name</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-medium text-slate-700">Direction</label>
                      <select
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                        value={performanceRatioSortDir}
                        onChange={(event) => setPerformanceRatioSortDir(event.target.value as "asc" | "desc")}
                      >
                        <option value="desc">Descending</option>
                        <option value="asc">Ascending</option>
                      </select>
                    </div>

                    <div className="space-y-1 xl:col-span-2">
                      <label className="text-sm font-medium text-slate-700">Search</label>
                      <Input
                        placeholder="System name, NONID, monitoring system id/name, installer..."
                        value={performanceRatioSearch}
                        onChange={(event) => setPerformanceRatioSearch(event.target.value)}
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">Performance Ratio Allocation Detail</CardTitle>
                        <CardDescription>
                          Each row is one converted read allocated to one matching portal project. Showing rows{" "}
                          {filteredPerformanceRatioRows.length === 0
                            ? "0"
                            : formatNumber(performanceRatioPageStartIndex + 1)}
                          -
                          {formatNumber(
                            Math.min(performanceRatioPageEndIndex, filteredPerformanceRatioRows.length)
                          )}{" "}
                          of {formatNumber(filteredPerformanceRatioRows.length)}.
                        </CardDescription>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPerformanceRatioPage((page) => Math.max(1, page - 1))}
                          disabled={performanceRatioCurrentPage <= 1}
                        >
                          Previous
                        </Button>
                        <p className="text-xs text-slate-600">
                          Page {formatNumber(performanceRatioCurrentPage)} of {formatNumber(performanceRatioTotalPages)}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setPerformanceRatioPage((page) =>
                              Math.min(performanceRatioTotalPages, page + 1)
                            )
                          }
                          disabled={performanceRatioCurrentPage >= performanceRatioTotalPages}
                        >
                          Next
                        </Button>
                        <Button variant="outline" size="sm" onClick={downloadPerformanceRatioCsv}>
                          Download Performance Ratio CSV
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>System</TableHead>
                          <TableHead>NONID</TableHead>
                          <TableHead>Portal ID</TableHead>
                          <TableHead>Monitoring</TableHead>
                          <TableHead>Match Type</TableHead>
                          <TableHead>Read Date</TableHead>
                          <TableHead>Baseline Date</TableHead>
                          <TableHead>Baseline Source</TableHead>
                          <TableHead>Read (kWh)</TableHead>
                          <TableHead>Delta (kWh)</TableHead>
                          <TableHead>Expected (kWh)</TableHead>
                          <TableHead>Performance Ratio</TableHead>
                          <TableHead>Contract Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visiblePerformanceRatioRows.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell className="font-medium">{row.systemName}</TableCell>
                            <TableCell>{row.trackingSystemRefId}</TableCell>
                            <TableCell>{row.systemId ?? "N/A"}</TableCell>
                            <TableCell>{row.monitoring}</TableCell>
                            <TableCell>{row.matchType}</TableCell>
                            <TableCell>{row.readDate ? formatDate(row.readDate) : row.readDateRaw || "N/A"}</TableCell>
                            <TableCell>{formatDate(row.baselineDate)}</TableCell>
                            <TableCell>{row.baselineSource ?? "N/A"}</TableCell>
                            <TableCell>{formatNumber(row.lifetimeReadWh !== null ? row.lifetimeReadWh / 1_000 : null)}</TableCell>
                            <TableCell>
                              {row.productionDeltaWh === null
                                ? "N/A"
                                : formatSignedNumber(row.productionDeltaWh / 1_000)}
                            </TableCell>
                            <TableCell>{formatNumber(row.expectedProductionWh !== null ? row.expectedProductionWh / 1_000 : null)}</TableCell>
                            <TableCell
                              className={
                                row.performanceRatioPercent !== null && row.performanceRatioPercent < 100
                                  ? "text-amber-700 font-medium"
                                  : ""
                              }
                            >
                              {formatPercent(row.performanceRatioPercent)}
                            </TableCell>
                            <TableCell>{formatCurrency(row.contractValue)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Compliant Sources</CardTitle>
                    <CardDescription>
                      Tie a compliant-source string (max 100 chars: letters, numbers, spaces, underscores, hyphens, commas) and optional image/PDF evidence to
                      a portal ID. Auto sources are also listed when monitoring platform is compliant (Enphase, AlsoEnergy,
                      Solar-Log, SDSI Arraymeter, Locus Energy, Vision Metering, SenseRGM) or when both AC sizes are 10kW AC or less.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white">
                          <Upload className="h-4 w-4" />
                          Upload Compliant Source CSV
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0] ?? null;
                              void importCompliantSourceCsv(file);
                              event.currentTarget.value = "";
                            }}
                          />
                        </label>
                        <p className="text-xs text-slate-600">Required headers: `portal_id`, `source`</p>
                      </div>
                      {compliantSourceCsvMessage ? (
                        <p className="mt-2 text-xs text-emerald-700">{compliantSourceCsvMessage}</p>
                      ) : null}
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-slate-700">Portal ID</label>
                        <Input
                          value={compliantSourcePortalIdInput}
                          onChange={(event) => setCompliantSourcePortalIdInput(event.target.value)}
                          placeholder="e.g. 107313"
                        />
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <label className="text-sm font-medium text-slate-700">Compliant Source</label>
                        <Input
                          value={compliantSourceTextInput}
                          onChange={(event) => setCompliantSourceTextInput(event.target.value.slice(0, MAX_COMPLIANT_SOURCE_CHARS))}
                          placeholder="Letters, numbers, spaces, underscores, hyphens, commas"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        <Upload className="h-4 w-4" />
                        Upload Evidence (Image/PDF)
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          multiple
                          className="hidden"
                          onChange={(event) => {
                            const files = Array.from(event.target.files ?? []);
                            setCompliantSourceEvidenceFiles(files);
                          }}
                        />
                      </label>
                      <p className="text-xs text-slate-500">
                        {compliantSourceEvidenceFiles.length > 0
                          ? `${formatNumber(compliantSourceEvidenceFiles.length)} file(s) selected`
                          : "No evidence files selected"}
                      </p>
                      <Button variant="outline" size="sm" onClick={saveCompliantSourceEntry}>
                        Save Compliant Source
                      </Button>
                    </div>

                    {compliantSourceUploadError ? (
                      <p className="text-sm text-rose-700">{compliantSourceUploadError}</p>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600">
                        Showing rows{" "}
                        {compliantSourcesTableRows.length === 0
                          ? "0"
                          : formatNumber(compliantSourcePageStartIndex + 1)}
                        -{formatNumber(Math.min(compliantSourcePageEndIndex, compliantSourcesTableRows.length))} of{" "}
                        {formatNumber(compliantSourcesTableRows.length)}.
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCompliantSourcePage((page) => Math.max(1, page - 1))}
                          disabled={compliantSourceCurrentPage <= 1}
                        >
                          Previous
                        </Button>
                        <p className="text-xs text-slate-600">
                          Page {formatNumber(compliantSourceCurrentPage)} of {formatNumber(compliantSourceTotalPages)}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setCompliantSourcePage((page) => Math.min(compliantSourceTotalPages, page + 1))
                          }
                          disabled={compliantSourceCurrentPage >= compliantSourceTotalPages}
                        >
                          Next
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Portal ID</TableHead>
                            <TableHead>Compliant Source</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Evidence</TableHead>
                            <TableHead>Updated</TableHead>
                            <TableHead>Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {compliantSourcesTableRows.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={6} className="text-center text-slate-500">
                                No compliant sources available yet.
                              </TableCell>
                            </TableRow>
                          ) : (
                            visibleCompliantSourceEntries.map((entry) => (
                              <TableRow key={`${entry.sourceType}-${entry.portalId}`}>
                                <TableCell className="font-medium">{entry.portalId}</TableCell>
                                <TableCell>{entry.compliantSource}</TableCell>
                                <TableCell>{entry.sourceType}</TableCell>
                                <TableCell>
                                  {entry.evidence.length === 0 ? (
                                    <span className="text-slate-500">No files</span>
                                  ) : (
                                    <div className="flex flex-wrap gap-2">
                                      {entry.evidence.map((item) => (
                                        <a
                                          key={item.id}
                                          href={item.objectUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-xs text-blue-700 underline"
                                        >
                                          {item.fileName}
                                        </a>
                                      ))}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>{entry.updatedAt ? formatDate(entry.updatedAt) : "Auto"}</TableCell>
                                <TableCell>
                                  {entry.sourceType === "Manual" ? (
                                    <Button variant="ghost" size="sm" onClick={() => removeCompliantSourceEntry(entry.portalId)}>
                                      Remove
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-slate-500">Auto</span>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">Compliant Performance Ratio Report</CardTitle>
                        <CardDescription>
                          Same report logic, but only systems with Part II verification dates and performance ratio between
                          30% and 150% (inclusive). If multiple reads qualify, the newest read window (16th to 15th) is
                          selected first; within that window, the highest ratio per system is kept.
                        </CardDescription>
                      </div>
                      <Button variant="outline" size="sm" onClick={downloadCompliantPerformanceRatioCsv}>
                        Download Compliant Report CSV
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Systems in Compliant Report</p>
                        <p className="text-xl font-semibold text-slate-900">
                          {formatNumber(compliantPerformanceRatioSummary.count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">With Compliant Source Text</p>
                        <p className="text-xl font-semibold text-slate-900">
                          {formatNumber(compliantPerformanceRatioSummary.withCompliantSource)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">With Evidence Files</p>
                        <p className="text-xl font-semibold text-slate-900">
                          {formatNumber(compliantPerformanceRatioSummary.withEvidence)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600">
                        Showing rows{" "}
                        {compliantPerformanceRatioRows.length === 0
                          ? "0"
                          : formatNumber(compliantReportPageStartIndex + 1)}
                        -{formatNumber(Math.min(compliantReportPageEndIndex, compliantPerformanceRatioRows.length))} of{" "}
                        {formatNumber(compliantPerformanceRatioRows.length)}.
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCompliantReportPage((page) => Math.max(1, page - 1))}
                          disabled={compliantReportCurrentPage <= 1}
                        >
                          Previous
                        </Button>
                        <p className="text-xs text-slate-600">
                          Page {formatNumber(compliantReportCurrentPage)} of {formatNumber(compliantReportTotalPages)}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setCompliantReportPage((page) => Math.min(compliantReportTotalPages, page + 1))
                          }
                          disabled={compliantReportCurrentPage >= compliantReportTotalPages}
                        >
                          Next
                        </Button>
                      </div>
                    </div>

                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>System</TableHead>
                          <TableHead>NONID</TableHead>
                          <TableHead>Portal ID</TableHead>
                          <TableHead>Part II Verified</TableHead>
                          <TableHead>Read Date</TableHead>
                          <TableHead>Meter Read Month</TableHead>
                          <TableHead>Read Window Month</TableHead>
                          <TableHead>Performance Ratio</TableHead>
                          <TableHead>Compliant Source</TableHead>
                          <TableHead>Evidence Files</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {compliantPerformanceRatioRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={10} className="text-center text-slate-500">
                              No systems currently meet the compliant report criteria.
                            </TableCell>
                          </TableRow>
                        ) : (
                          visibleCompliantPerformanceRows.map((row) => (
                            <TableRow key={`compliant-${row.key}`}>
                              <TableCell className="font-medium">{row.systemName}</TableCell>
                              <TableCell>{row.trackingSystemRefId}</TableCell>
                              <TableCell>{row.systemId ?? "N/A"}</TableCell>
                              <TableCell>{formatDate(row.part2VerificationDate)}</TableCell>
                              <TableCell>{row.readDate ? formatDate(row.readDate) : row.readDateRaw || "N/A"}</TableCell>
                              <TableCell>{row.meterReadMonthYear}</TableCell>
                              <TableCell>{row.readWindowMonthYear}</TableCell>
                              <TableCell>{formatPercent(row.performanceRatioPercent)}</TableCell>
                              <TableCell>{row.compliantSource ?? "N/A"}</TableCell>
                              <TableCell>{formatNumber(row.evidenceCount)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </div>)}

          {activeTab === "snapshot-log" && (<div className="space-y-4 mt-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardDescription>{COO_TARGET_STATUS}</CardDescription>
                  <CardTitle className="text-2xl">
                    {formatNumber(cooNotTransferredNotReportingCurrentCount)}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Months with Transition Data</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(monthlySnapshotTransitions.length)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Snapshots Available</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(logEntries.length)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Snapshot Trend Graphic</CardTitle>
                <CardDescription>
                  This chart updates automatically as each new snapshot is logged.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {snapshotTrendRows.length === 0 ? (
                  <p className="text-sm text-slate-600">No snapshots logged yet.</p>
                ) : (
                  <div className="h-80 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={snapshotTrendRows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value) => `${value}%`}
                        />
                        <Tooltip
                          labelFormatter={(_, payload) =>
                            payload && payload.length > 0 ? String(payload[0]?.payload?.timestamp ?? "") : ""
                          }
                          formatter={(value: number | string) =>
                            typeof value === "number" ? `${value.toFixed(1)}%` : value
                          }
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="reportingPercent"
                          name="Reporting to GATS (%)"
                          stroke="#0f766e"
                          strokeWidth={2}
                          dot={{ r: 2 }}
                          activeDot={{ r: 4 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="cooNotTransferredNotReportingPercent"
                          name="COO Not Transferred + Not Reporting (%)"
                          stroke="#b45309"
                          strokeWidth={2}
                          dot={{ r: 2 }}
                          activeDot={{ r: 4 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="changeOwnershipPercent"
                          name="Change of Ownership (%)"
                          stroke="#334155"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monthly Movement Tracker</CardTitle>
                <CardDescription>
                  Tracks monthly movement into and out of <span className="font-medium">{COO_TARGET_STATUS}</span>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {monthlySnapshotTransitions.length === 0 ? (
                  <p className="text-sm text-slate-600">
                    Need snapshots across at least 2 different months to calculate transitions.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead>Moved Into Status</TableHead>
                        <TableHead>Moved In From</TableHead>
                        <TableHead>Moved Out of Status</TableHead>
                        <TableHead>Moved Out To</TableHead>
                        <TableHead>Net Change</TableHead>
                        <TableHead>Ending Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {monthlySnapshotTransitions.map((item) => (
                        <TableRow key={item.monthKey}>
                          <TableCell className="font-medium">{item.monthLabel}</TableCell>
                          <TableCell>{formatNumber(item.movedIn)}</TableCell>
                          <TableCell className="max-w-[320px] whitespace-normal">{item.movedInBreakdown}</TableCell>
                          <TableCell>{formatNumber(item.movedOut)}</TableCell>
                          <TableCell className="max-w-[320px] whitespace-normal">{item.movedOutBreakdown}</TableCell>
                          <TableCell className={item.net < 0 ? "text-rose-700" : item.net > 0 ? "text-emerald-700" : ""}>
                            {formatNumber(item.net)}
                          </TableCell>
                          <TableCell>{formatNumber(item.endingCount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Vertical Snapshot Log</CardTitle>
                    <CardDescription>
                      Each click of <span className="font-medium">Log Snapshot</span> creates a new dated column.
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={createLogEntry}>
                      Log Snapshot
                    </Button>
                    <Button variant="ghost" size="sm" onClick={clearLogs} disabled={logEntries.length === 0}>
                      Clear Logs
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {snapshotLogColumns.length === 0 ? (
                  <p className="text-sm text-slate-600">No snapshots logged yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        {snapshotLogColumns.map((entry) => (
                          <TableHead key={entry.id}>
                            <div className="flex min-w-[130px] flex-col gap-1">
                              <span>
                                {entry.createdAt.toLocaleDateString()} {entry.createdAt.toLocaleTimeString()}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-fit px-2 text-rose-700 hover:text-rose-800"
                                onClick={() => deleteLogEntry(entry.id)}
                              >
                                <Trash2 className="mr-1 h-3.5 w-3.5" />
                                Delete
                              </Button>
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshotMetricRows.map((metric) => {
                        if (metric.kind === "section") {
                          const sectionClass =
                            metric.sectionTone === "blue"
                              ? "bg-blue-50 text-blue-900"
                              : metric.sectionTone === "emerald"
                                ? "bg-emerald-50 text-emerald-900"
                                : "bg-slate-100 text-slate-900";
                          return (
                            <TableRow key={metric.label} className={sectionClass}>
                              <TableCell
                                colSpan={snapshotLogColumns.length + 1}
                                className="font-semibold uppercase tracking-wide text-xs"
                              >
                                {metric.label}
                              </TableCell>
                            </TableRow>
                          );
                        }

                        const labelClass = metric.level === 1 ? "pl-7 text-slate-700" : "text-slate-900";
                        const valueClass =
                          metric.metricTone === "warn"
                            ? "text-amber-700 font-semibold"
                            : metric.metricTone === "neutral"
                              ? "text-slate-700"
                              : "text-slate-900";

                        return (
                          <TableRow key={metric.label}>
                            <TableCell className={`font-medium ${labelClass}`}>
                              {metric.level === 1 ? <span className="mr-2 text-slate-400">↳</span> : null}
                              {metric.label}
                            </TableCell>
                            {snapshotLogColumns.map((entry) => (
                              <TableCell key={`${entry.id}-${metric.label}`} className={valueClass}>
                                {metric.value(entry)}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">REC Performance Eval Snapshot by Contract</CardTitle>
                <CardDescription>
                  Delivery Year {SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL}. Shows only contracts with delivery
                  obligations in that year, including unallocated shortfall, required to avoid shortfall, delivered so
                  far, and delivered percentage.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {snapshotLogColumns.length === 0 ? (
                  <p className="text-sm text-slate-600">No snapshots logged yet.</p>
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between text-xs text-slate-600">
                      <span>
                        Showing contracts {formatNumber(snapshotContractStartIndex + 1)}-
                        {formatNumber(Math.min(snapshotContractEndIndex, snapshotContractIds.length))} of{" "}
                        {formatNumber(snapshotContractIds.length)}
                      </span>
                      <span>
                        Page {formatNumber(snapshotContractCurrentPage)} of {formatNumber(snapshotContractTotalPages)}
                      </span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Contract ID</TableHead>
                          {snapshotLogColumns.map((entry) => (
                            <TableHead key={`contract-snapshot-${entry.id}`}>
                              <div className="min-w-[180px]">
                                {entry.createdAt.toLocaleDateString()} {entry.createdAt.toLocaleTimeString()}
                              </div>
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleSnapshotContractIds.map((contractId) => (
                          <TableRow key={`snapshot-contract-${contractId}`}>
                            <TableCell className="font-medium">{contractId}</TableCell>
                            {snapshotLogColumns.map((entry) => {
                              const metric = snapshotContractMetricsByLogId.get(entry.id)?.get(contractId);
                              return (
                                <TableCell key={`${entry.id}-${contractId}`}>
                                  <div className="space-y-0.5 text-xs leading-5 text-slate-700">
                                    <p>Unallocated: {formatNumber(metric?.unallocatedShortfallRecs ?? 0)}</p>
                                    <p>Required: {formatNumber(metric?.requiredToAvoidShortfallRecs ?? 0)}</p>
                                    <p>Delivered: {formatNumber(metric?.deliveredTowardShortfallRecs ?? 0)}</p>
                                    <p>Delivered %: {formatPercent(metric?.deliveredPercentOfRequired ?? null)}</p>
                                  </div>
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSnapshotContractPage((page) => Math.max(1, page - 1))}
                        disabled={snapshotContractCurrentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSnapshotContractPage((page) => Math.min(snapshotContractTotalPages, page + 1))}
                        disabled={snapshotContractCurrentPage >= snapshotContractTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "app-pipeline" && (<div className="space-y-4 mt-4">
            {/* ====== Application Pipeline (Count) ====== */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Application Pipeline (Count)</CardTitle>
                    <CardDescription>
                      Monthly count of Part I Submitted and Part II Verified applications, deduplicated by Application ID. Prior-year values shown for comparison.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={pipelineCountRange === "3year" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineCountRange("3year")}
                    >
                      Last 3 Years
                    </Button>
                    <Button
                      variant={pipelineCountRange === "12month" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineCountRange("12month")}
                    >
                      Last 12 Months
                    </Button>
                    <div className="w-px h-6 bg-slate-200 mx-1" />
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                      disabled={pipelineReportLoading || pipelineMonthlyRows.length === 0}
                      onClick={handleGeneratePipelineReport}
                    >
                      {pipelineReportLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                      {pipelineReportLoading ? "Generating…" : "PDF Report"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month}
                      margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      {pipelineBands(pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((band) => (
                        <ReferenceArea key={band.x1} x1={band.x1} x2={band.x2} fill="#f1f5f9" fillOpacity={0.7} ifOverflow="extendDomain" />
                      ))}
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={50} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="part1Count" fill="#3b82f6" name="Part I Submitted" />
                      <Bar dataKey="part2Count" fill="#16a34a" name="Part II Verified" />
                      <Line type="monotone" dataKey="prevPart1Count" stroke="#93c5fd" strokeDasharray="5 3" strokeWidth={2} dot={false} name="Part I (Prior Year)" />
                      <Line type="monotone" dataKey="prevPart2Count" stroke="#86efac" strokeDasharray="5 3" strokeWidth={2} dot={false} name="Part II (Prior Year)" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Part I Submitted</TableHead>
                        <TableHead className="text-right text-blue-300">Part I (Prior Yr)</TableHead>
                        <TableHead className="text-right">Part II Verified</TableHead>
                        <TableHead className="text-right text-emerald-300">Part II (Prior Yr)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                            No pipeline data available. Upload ABP Report files.
                          </TableCell>
                        </TableRow>
                      ) : (
                        (pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((row) => {
                          const rows = pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
                          const groupIdx = pipelineRowGroupIndex(rows, row.month);
                          const shaded = groupIdx % 2 === 1;
                          return (
                            <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                              <TableCell className="font-medium">{row.month}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.part1Count)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevPart1Count)}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.part2Count)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevPart2Count)}</TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* ====== Application Pipeline (kW AC) ====== */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Application Pipeline (kW AC)</CardTitle>
                    <CardDescription>
                      Monthly sum of inverter capacity — Inverter_Size_kW_AC_Part_1 for Part I, Inverter_Size_kW_AC_Part_2 for Part II. Prior-year values shown for comparison.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant={pipelineKwRange === "3year" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineKwRange("3year")}
                    >
                      Last 3 Years
                    </Button>
                    <Button
                      variant={pipelineKwRange === "12month" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineKwRange("12month")}
                    >
                      Last 12 Months
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month}
                      margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      {pipelineBands(pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((band) => (
                        <ReferenceArea key={band.x1} x1={band.x1} x2={band.x2} fill="#f1f5f9" fillOpacity={0.7} ifOverflow="extendDomain" />
                      ))}
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value: number) => formatNumber(value, 1) + " kW"} />
                      <Legend />
                      <Bar dataKey="part1KwAc" fill="#3b82f6" name="Part I kW AC" />
                      <Bar dataKey="part2KwAc" fill="#16a34a" name="Part II kW AC" />
                      <Line type="monotone" dataKey="prevPart1KwAc" stroke="#93c5fd" strokeDasharray="5 3" strokeWidth={2} dot={false} name="Part I kW AC (Prior Year)" />
                      <Line type="monotone" dataKey="prevPart2KwAc" stroke="#86efac" strokeDasharray="5 3" strokeWidth={2} dot={false} name="Part II kW AC (Prior Year)" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Part I kW AC</TableHead>
                        <TableHead className="text-right text-blue-300">Part I kW (Prior Yr)</TableHead>
                        <TableHead className="text-right">Part II kW AC</TableHead>
                        <TableHead className="text-right text-emerald-300">Part II kW (Prior Yr)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                            No pipeline data available. Upload ABP Report files.
                          </TableCell>
                        </TableRow>
                      ) : (
                        (pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((row) => {
                          const rows = pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
                          const groupIdx = pipelineRowGroupIndex(rows, row.month);
                          const shaded = groupIdx % 2 === 1;
                          return (
                            <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                              <TableCell className="font-medium">{row.month}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.part1KwAc, 1)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevPart1KwAc, 1)}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.part2KwAc, 1)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevPart2KwAc, 1)}</TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* ====== Capacity Interconnected (kW AC by Energization_Date) ====== */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Capacity Interconnected (kW AC)</CardTitle>
                    <CardDescription>
                      Monthly interconnections from GATS Generator Details (`Date Online` + `GATS Unit ID`). kW AC uses
                      Generator Details size fields when present, with tracking-ID fallback to portfolio AC size.
                      Prior-year values shown for comparison.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant={pipelineInterconnectedRange === "3year" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineInterconnectedRange("3year")}
                    >
                      Last 3 Years
                    </Button>
                    <Button
                      variant={pipelineInterconnectedRange === "12month" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPipelineInterconnectedRange("12month")}
                    >
                      Last 12 Months
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month}
                      margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      {pipelineBands(pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((band) => (
                        <ReferenceArea key={band.x1} x1={band.x1} x2={band.x2} fill="#f1f5f9" fillOpacity={0.7} ifOverflow="extendDomain" />
                      ))}
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value: number) => formatNumber(value, 1) + " kW"} />
                      <Legend />
                      <Bar dataKey="interconnectedKwAc" fill="#8b5cf6" name="Interconnected kW AC" />
                      <Line type="monotone" dataKey="prevInterconnectedKwAc" stroke="#c4b5fd" strokeDasharray="5 3" strokeWidth={2} dot={false} name="Interconnected kW AC (Prior Year)" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Systems Interconnected</TableHead>
                        <TableHead className="text-right text-violet-300">Systems (Prior Yr)</TableHead>
                        <TableHead className="text-right">kW AC Interconnected</TableHead>
                        <TableHead className="text-right text-violet-300">kW AC (Prior Yr)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                            No interconnection data available. Upload GATS Generator Details with `GATS Unit ID` and
                            `Date Online`.
                          </TableCell>
                        </TableRow>
                      ) : (
                        (pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month).map((row) => {
                          const rows = pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
                          const groupIdx = pipelineRowGroupIndex(rows, row.month);
                          const shaded = groupIdx % 2 === 1;
                          return (
                            <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                              <TableCell className="font-medium">{row.month}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.interconnectedCount)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevInterconnectedCount)}</TableCell>
                              <TableCell className="text-right">{formatNumber(row.interconnectedKwAc, 1)}</TableCell>
                              <TableCell className="text-right text-slate-400">{formatNumber(row.prevInterconnectedKwAc, 1)}</TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "trends" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Delivery Pace by Contract</CardTitle>
                <CardDescription>Expected pace (based on time elapsed) vs actual delivery pace for active contracts.</CardDescription>
              </CardHeader>
              <CardContent>
                {trendDeliveryPace.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">Scrape Schedule B PDFs in the Delivery Tracker tab and upload Transfer History to see delivery pace.</p>
                ) : (
                  <div className="h-72 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={trendDeliveryPace} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="contract" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={60} />
                        <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                        <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                        <Legend />
                        <Bar dataKey="expectedPace" fill="#94a3b8" name="Expected Pace %" />
                        <Bar dataKey="actualPace" fill="#16a34a" name="Actual Pace %" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Month-over-Month Production (Top 10 Sites)</CardTitle>
                <CardDescription>Monthly production deltas (kWh) from converted reads, showing top 10 sites by total output.</CardDescription>
              </CardHeader>
              <CardContent>
                {trendProductionMoM.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">Upload Converted Reads to see production trends.</p>
                ) : (
                  <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendProductionMoM} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Legend />
                        {trendTopSiteIds.map((siteId, i) => (
                          <Line key={siteId} type="monotone" dataKey={siteId} stroke={["#16a34a","#0ea5e9","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316","#6366f1","#84cc16"][i % 10]} name={siteId.length > 25 ? siteId.slice(0, 22) + "..." : siteId} dot={false} strokeWidth={2} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reporting Rate Over Time</CardTitle>
                <CardDescription>Historical reporting percentage from dashboard snapshots.</CardDescription>
              </CardHeader>
              <CardContent>
                {logEntries.length < 2 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">Take at least 2 snapshots to see reporting rate trends.</p>
                ) : (
                  <div className="h-64 rounded-md border border-slate-200 bg-white p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={logEntries.slice().reverse().map(e => ({ date: e.createdAt.toLocaleDateString(), reportingPercent: e.reportingPercent ?? 0, totalSystems: e.totalSystems }))} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="reportingPercent" stroke="#16a34a" name="Reporting %" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "forecast" && (<div className="space-y-4 mt-4">
            <Card className="border-sky-200 bg-sky-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">REC Production Forecast — Energy Year {FORECAST_EY_LABEL}</CardTitle>
                <CardDescription>
                  Projected additional RECs per contract based on estimated production from each system&apos;s latest GATS meter read date through April 30, {FORECAST_EY_END_YEAR}.
                  Uses Annual Production Estimates with daily pro-rata. Floor date: June 1, {FORECAST_EY_START_YEAR - 1}. 1 REC = 1,000 kWh (floored per system).
                  Floor date advances each energy year (always June 1 of the prior energy year).
                </CardDescription>
              </CardHeader>
            </Card>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card><CardHeader><CardDescription>Contracts</CardDescription><CardTitle className="text-2xl">{forecastSummary.total}</CardTitle></CardHeader></Card>
              <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30"><CardHeader><CardDescription>Revised Avg (Reporting)</CardDescription><CardTitle className="text-2xl text-emerald-800 dark:text-emerald-400">{formatNumber(forecastSummary.totalRevisedReporting)}</CardTitle></CardHeader></Card>
              <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-800 dark:bg-sky-950/30"><CardHeader><CardDescription>Revised Avg (All Sites)</CardDescription><CardTitle className="text-2xl text-sky-800 dark:text-sky-400">{formatNumber(forecastSummary.totalRevisedAll)}</CardTitle></CardHeader></Card>
              <Card className={forecastSummary.atRisk > 0 ? "border-rose-200 bg-rose-50/50 dark:border-rose-800 dark:bg-rose-950/30" : "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30"}><CardHeader><CardDescription>Contracts At Risk</CardDescription><CardTitle className="text-2xl">{forecastSummary.atRisk}</CardTitle></CardHeader></Card>
            </div>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Projected REC Production by Contract</CardTitle>
                    <CardDescription>
                      <strong>Projection 1 (Reporting):</strong> Only sites reporting in the last 3 months.{" "}
                      <strong>Projection 2 (All Sites):</strong> All eligible sites including non-reporting (using June 1, 2024 floor for missing dates).
                    </CardDescription>
                  </div>
                  {forecastProjections.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(
                        ["contract", "systems_total", "systems_reporting", "obligation_recs", "baseline_rolling_avg", "del_pct", "revised_avg_reporting", "revised_avg_all", "gap_reporting", "gap_all"],
                        forecastProjections.map(c => ({
                          contract: c.contract, systems_total: c.systemsTotal, systems_reporting: c.systemsReporting,
                          obligation_recs: c.requiredRecs, baseline_rolling_avg: c.baselineRollingAvg,
                          del_pct: c.delPercent !== null ? c.delPercent.toFixed(1) : "",
                          revised_avg_reporting: c.revisedRollingAvgReporting, revised_avg_all: c.revisedRollingAvgAll,
                          gap_reporting: c.gapReporting, gap_all: c.gapAll,
                        }))
                      );
                      triggerCsvDownload(`rec-forecast-ey${FORECAST_EY_LABEL}-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {forecastProjections.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">
                    Scrape Schedule B PDFs, upload Transfer History, Account Solar Generation, and Annual Production Estimates to see forecasts.
                  </p>
                ) : (
                  <>
                    <div className="h-80 rounded-md border border-slate-200 bg-white p-2 mb-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={forecastProjections} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="contract" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={60} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="requiredRecs" fill="#94a3b8" name="Obligation" />
                          <Bar dataKey="baselineRollingAvg" fill="#16a34a" name="Baseline 3-Yr Avg" />
                          <Bar dataKey="revisedRollingAvgReporting" fill="#0ea5e9" name="Revised Avg (Reporting)" />
                          <Bar dataKey="revisedRollingAvgAll" fill="#8b5cf6" name="Revised Avg (All)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead>Contract</TableHead>
                          <TableHead className="text-right">Systems</TableHead>
                          <TableHead className="text-right">Reporting</TableHead>
                          <TableHead className="text-right">Obligation</TableHead>
                          <TableHead className="text-right">Baseline 3-Yr Avg</TableHead>
                          <TableHead className="text-right">Del. %</TableHead>
                          <TableHead className="text-right text-sky-700">Revised Avg (Reporting)</TableHead>
                          <TableHead className="text-right text-sky-700">%</TableHead>
                          <TableHead className="text-right text-violet-700">Revised Avg (All)</TableHead>
                          <TableHead className="text-right text-violet-700">%</TableHead>
                          <TableHead className="text-right">Gap (Reporting)</TableHead>
                          <TableHead className="text-right">Gap (All)</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {forecastProjections.map((c) => {
                            const delPct = c.delPercent !== null ? c.delPercent.toFixed(1) : "N/A";
                            const revisedPctReporting = c.requiredRecs > 0 ? ((c.revisedRollingAvgReporting / c.requiredRecs) * 100).toFixed(1) : "N/A";
                            const revisedPctAll = c.requiredRecs > 0 ? ((c.revisedRollingAvgAll / c.requiredRecs) * 100).toFixed(1) : "N/A";
                            const gapReportingPositive = c.gapReporting >= 0;
                            const gapAllPositive = c.gapAll >= 0;
                            return (
                              <TableRow key={c.contract}>
                                <TableCell className="font-medium">{c.contract}</TableCell>
                                <TableCell className="text-right">{c.systemsTotal}</TableCell>
                                <TableCell className="text-right">{c.systemsReporting}</TableCell>
                                <TableCell className="text-right">{formatNumber(c.requiredRecs)}</TableCell>
                                <TableCell className="text-right">{formatNumber(c.baselineRollingAvg)}</TableCell>
                                <TableCell className="text-right">{delPct}%</TableCell>
                                <TableCell className="text-right font-medium text-sky-700 dark:text-sky-400">{formatNumber(c.revisedRollingAvgReporting)}</TableCell>
                                <TableCell className="text-right text-xs text-sky-600 dark:text-sky-500">{revisedPctReporting}%</TableCell>
                                <TableCell className="text-right font-medium text-violet-700 dark:text-violet-400">{formatNumber(c.revisedRollingAvgAll)}</TableCell>
                                <TableCell className="text-right text-xs text-violet-600 dark:text-violet-500">{revisedPctAll}%</TableCell>
                                <TableCell className="text-right">
                                  <Badge variant="outline" className={gapReportingPositive ? "text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700" : "text-red-700 border-red-300 dark:text-red-400 dark:border-red-700"}>
                                    {gapReportingPositive ? "+" : ""}{formatNumber(c.gapReporting)}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  <Badge variant="outline" className={gapAllPositive ? "text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700" : "text-red-700 border-red-300 dark:text-red-400 dark:border-red-700"}>
                                    {gapAllPositive ? "+" : ""}{formatNumber(c.gapAll)}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "alerts" && (<div className="space-y-4 mt-4">
            <div className="grid grid-cols-3 gap-3">
              <Card className="border-rose-200 bg-rose-50/50"><CardHeader><CardDescription>Critical</CardDescription><CardTitle className="text-2xl text-rose-800">{alertSummary.critical}</CardTitle></CardHeader></Card>
              <Card className="border-amber-200 bg-amber-50/50"><CardHeader><CardDescription>Warning</CardDescription><CardTitle className="text-2xl text-amber-800">{alertSummary.warning}</CardTitle></CardHeader></Card>
              <Card className="border-sky-200 bg-sky-50/50"><CardHeader><CardDescription>Info</CardDescription><CardTitle className="text-2xl text-sky-800">{alertSummary.info}</CardTitle></CardHeader></Card>
            </div>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle className="text-base">All Alerts</CardTitle><CardDescription>{alerts.length} alerts detected across your portfolio.</CardDescription></div>
                  {alerts.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(["severity", "type", "system", "message", "action"], alerts.map(a => ({ severity: a.severity, type: a.type, system: a.system, message: a.message, action: a.action })));
                      triggerCsvDownload(`alerts-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {alerts.length === 0 ? (
                  <p className="text-sm text-emerald-600 py-4 text-center">No alerts. Your portfolio looks healthy.</p>
                ) : (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="w-24">Severity</TableHead><TableHead className="w-32">Type</TableHead><TableHead>System / Contract</TableHead><TableHead>Details</TableHead><TableHead>Action</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {alerts.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell><Badge variant={a.severity === "critical" ? "destructive" : a.severity === "warning" ? "secondary" : "outline"}>{a.severity}</Badge></TableCell>
                          <TableCell className="text-sm">{a.type}</TableCell>
                          <TableCell className="font-medium text-sm">{a.system}</TableCell>
                          <TableCell className="text-sm text-slate-600">{a.message}</TableCell>
                          <TableCell className="text-sm text-slate-500">{a.action}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "comparisons" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle className="text-base">Installer Performance</CardTitle><CardDescription>Systems grouped by installer with reporting rate and delivery metrics.</CardDescription></div>
                  {comparisonInstallers.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(["installer", "total_systems", "reporting", "reporting_percent", "total_value", "delivered_value", "delivery_percent"], comparisonInstallers.map(i => ({ installer: i.name, total_systems: i.total, reporting: i.reporting, reporting_percent: i.reportingPercent !== null ? i.reportingPercent.toFixed(1) : "", total_value: i.totalValue, delivered_value: i.deliveredValue, delivery_percent: i.deliveryPercent !== null ? i.deliveryPercent.toFixed(1) : "" })));
                      triggerCsvDownload(`installer-performance-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {comparisonInstallers.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">No system data available.</p>
                ) : (
                  <>
                    <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={comparisonInstallers.slice(0, 15)} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={60} />
                          <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                          <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                          <Bar dataKey="reportingPercent" fill="#16a34a" name="Reporting %" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Installer</TableHead><TableHead className="text-right">Systems</TableHead><TableHead className="text-right">Reporting</TableHead><TableHead className="text-right">Reporting %</TableHead><TableHead className="text-right">Contract Value</TableHead><TableHead className="text-right">Delivery %</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {comparisonInstallers.map((i) => (
                          <TableRow key={i.name}>
                            <TableCell className="font-medium">{i.name}</TableCell>
                            <TableCell className="text-right">{i.total}</TableCell>
                            <TableCell className="text-right">{i.reporting}</TableCell>
                            <TableCell className="text-right">{i.reportingPercent !== null ? `${i.reportingPercent.toFixed(1)}%` : "N/A"}</TableCell>
                            <TableCell className="text-right">${formatNumber(i.totalValue)}</TableCell>
                            <TableCell className="text-right">{i.deliveryPercent !== null ? `${i.deliveryPercent.toFixed(1)}%` : "N/A"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle className="text-base">Monitoring Platform Reliability</CardTitle><CardDescription>Reporting rate and offline metrics by monitoring platform.</CardDescription></div>
                  {comparisonPlatforms.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(["platform", "total_systems", "reporting", "reporting_percent", "offline", "offline_value"], comparisonPlatforms.map(p => ({ platform: p.name, total_systems: p.total, reporting: p.reporting, reporting_percent: p.reportingPercent !== null ? p.reportingPercent.toFixed(1) : "", offline: p.offline, offline_value: p.offlineValue })));
                      triggerCsvDownload(`platform-reliability-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {comparisonPlatforms.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">No system data available.</p>
                ) : (
                  <>
                    <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={comparisonPlatforms.slice(0, 15)} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={60} />
                          <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                          <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                          <Bar dataKey="reportingPercent" fill="#0ea5e9" name="Reporting %" />
                          <Bar dataKey="offlinePercent" fill="#ef4444" name="Offline %" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Platform</TableHead><TableHead className="text-right">Systems</TableHead><TableHead className="text-right">Reporting</TableHead><TableHead className="text-right">Reporting %</TableHead><TableHead className="text-right">Offline</TableHead><TableHead className="text-right">Offline Value</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {comparisonPlatforms.map((p) => (
                          <TableRow key={p.name}>
                            <TableCell className="font-medium">{p.name}</TableCell>
                            <TableCell className="text-right">{p.total}</TableCell>
                            <TableCell className="text-right">{p.reporting}</TableCell>
                            <TableCell className="text-right">{p.reportingPercent !== null ? `${p.reportingPercent.toFixed(1)}%` : "N/A"}</TableCell>
                            <TableCell className="text-right">{p.offline}</TableCell>
                            <TableCell className="text-right">${formatNumber(p.offlineValue)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "financials" && (<div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Card className="border-rose-200 bg-rose-50/50"><CardHeader><CardDescription>Revenue at Risk</CardDescription><CardTitle className="text-2xl text-rose-800">${formatNumber(financialRevenueAtRisk.total)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>% of Portfolio</CardDescription><CardTitle className="text-2xl">{financialRevenueAtRisk.percent !== null ? `${financialRevenueAtRisk.percent.toFixed(1)}%` : "N/A"}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Systems at Risk</CardDescription><CardTitle className="text-2xl">{financialRevenueAtRisk.systems.length}</CardTitle></CardHeader></Card>
            </div>

            {financialRevenueAtRisk.byType.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Revenue at Risk by Category</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-48 rounded-md border border-slate-200 bg-white p-2 mb-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={financialRevenueAtRisk.byType} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="type" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(v: number) => `$${formatNumber(v)}`} />
                        <Bar dataKey="value" fill="#ef4444" name="Value at Risk" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle className="text-base">Systems at Risk</CardTitle><CardDescription>Systems with contracted value that are offline or terminated.</CardDescription></div>
                  {financialRevenueAtRisk.systems.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(["system", "risk_type", "contract_value", "last_reporting", "days_offline"], financialRevenueAtRisk.systems.map(s => ({ system: s.name, risk_type: s.riskType, contract_value: s.value, last_reporting: s.lastDate, days_offline: s.daysOffline })));
                      triggerCsvDownload(`revenue-at-risk-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {financialRevenueAtRisk.systems.length === 0 ? (
                  <p className="text-sm text-emerald-600 py-4 text-center">No systems at risk. All contracted systems are reporting.</p>
                ) : (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>System</TableHead><TableHead>Risk Type</TableHead><TableHead className="text-right">Contract Value</TableHead><TableHead>Last Reporting</TableHead><TableHead className="text-right">Days Offline</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {financialRevenueAtRisk.systems.slice(0, 50).map((s, i) => {
                        const matchedSys = systems.find(sys => sys.systemName === s.name);
                        return (
                        <TableRow key={i}>
                          <TableCell>{matchedSys ? systemNameLink(s.name, matchedSys.key) : <span className="font-medium">{s.name}</span>}</TableCell>
                          <TableCell><Badge variant={s.riskType === "Offline" ? "destructive" : "secondary"}>{s.riskType}</Badge></TableCell>
                          <TableCell className="text-right">${formatNumber(s.value)}</TableCell>
                          <TableCell>{s.lastDate}</TableCell>
                          <TableCell className="text-right">{s.daysOffline}</TableCell>
                        </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* ── Profit & Collateralization Section ───────────── */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card className="border-emerald-200 bg-emerald-50/50"><CardHeader><CardDescription>Total Profit (Vendor Fee)</CardDescription><CardTitle className="text-2xl text-emerald-800">${formatNumber(financialProfitData.totalProfit)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Avg Profit / System</CardDescription><CardTitle className="text-2xl">${formatNumber(financialProfitData.avgProfit)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Total Collateralization</CardDescription><CardTitle className="text-2xl">${formatNumber(financialProfitData.totalCollateralization)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Systems w/ Data</CardDescription><CardTitle className="text-2xl">{financialProfitData.systemsWithData}</CardTitle></CardHeader></Card>
              <Card className={financialFlaggedCount > 0 ? "border-amber-200 bg-amber-50/50" : ""}><CardHeader><CardDescription>Needs Review (&gt;30% Coll.)</CardDescription><CardTitle className={`text-2xl ${financialFlaggedCount > 0 ? "text-amber-800" : ""}`}>{financialFlaggedCount}</CardTitle></CardHeader></Card>
            </div>

            {financialProfitData.rows.length === 0 && financialCsgIds.length === 0 && (
              <Card className="border-amber-200 bg-amber-50/50">
                <CardContent className="py-4">
                  <p className="text-sm text-amber-800">
                    Upload the ABP CSG-System Mapping, ICC Report 3, and complete a contract scan job on the{" "}
                    <a href="/contract-scrape-manager" className="underline font-medium">Contract Scraper</a>{" "}
                    page to see profit and collateralization analysis.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Financials debug panel — walks the join chain
                financialProfitData uses and shows where rows are
                being dropped. Always visible (collapsed) when on the
                Financials tab so you can see WHY the table is empty
                without going to DevTools. */}
            {financialProfitDebug && (
              <Card className="border-slate-200">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Financials data flow debug</CardTitle>
                  <CardDescription>
                    Walks the same join chain the profit table uses, counting attrition at every step. Use this to identify which dataset or which join is dropping rows.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-2">
                  <details>
                    <summary className="text-xs cursor-pointer text-slate-600 hover:text-slate-900">
                      Expand diagnostic (final result: {formatNumber(financialProfitDebug.chain.final)} profit rows)
                    </summary>
                    <div className="mt-3 space-y-3 text-xs font-mono">
                      <div>
                        <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                          Query state
                        </p>
                        <ul className="space-y-0.5">
                          <li>
                            getContractScanResultsByCsgIds enabled:{" "}
                            <span
                              className={
                                financialProfitDebug.queryEnabled
                                  ? "text-emerald-700"
                                  : "text-rose-700"
                              }
                            >
                              {String(financialProfitDebug.queryEnabled)}
                            </span>
                          </li>
                          <li>
                            query status:{" "}
                            <span
                              className={
                                financialProfitDebug.queryStatus === "error"
                                  ? "text-rose-700 font-bold"
                                  : ""
                              }
                            >
                              {financialProfitDebug.queryStatus}
                            </span>
                          </li>
                          <li>query fetching: {String(financialProfitDebug.queryFetching)}</li>
                          {financialProfitDebug.queryErrorMessage && (
                            <li className="text-rose-700">
                              error: {financialProfitDebug.queryErrorMessage}
                            </li>
                          )}
                        </ul>
                      </div>
                      <div>
                        <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                          Input dataset row counts
                        </p>
                        <ul className="space-y-0.5">
                          <li>
                            part2VerifiedAbpRows:{" "}
                            <strong>{formatNumber(financialProfitDebug.counts.part2VerifiedAbpRows)}</strong>
                          </li>
                          <li>
                            abpCsgSystemMapping rows:{" "}
                            <strong>{formatNumber(financialProfitDebug.counts.mappingRows)}</strong>
                          </li>
                          <li>
                            abpIccReport3Rows:{" "}
                            <strong>{formatNumber(financialProfitDebug.counts.iccReport3Rows)}</strong>
                          </li>
                          <li>
                            financialCsgIds (passed to query):{" "}
                            <strong>{formatNumber(financialProfitDebug.counts.financialCsgIdsCount)}</strong>
                          </li>
                          <li>
                            contractScanResults returned by query:{" "}
                            <strong>{formatNumber(financialProfitDebug.counts.scanResultsReturned)}</strong>
                          </li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                          Join chain attrition
                        </p>
                        <ul className="space-y-0.5">
                          <li>
                            iterated part2VerifiedAbpRows:{" "}
                            <strong>{formatNumber(financialProfitDebug.chain.iterated)}</strong>
                          </li>
                          <li>
                            ↳ with non-empty Application_ID:{" "}
                            <strong>{formatNumber(financialProfitDebug.chain.withAppId)}</strong>
                          </li>
                          <li>
                            ↳ with csgId in mapping:{" "}
                            <strong>{formatNumber(financialProfitDebug.chain.withCsgId)}</strong>
                          </li>
                          <li>
                            ↳ with scan result for that csgId:{" "}
                            <strong>{formatNumber(financialProfitDebug.chain.withScan)}</strong>
                          </li>
                          <li>
                            ↳ with ICC Report row for appId:{" "}
                            <strong>{formatNumber(financialProfitDebug.chain.withIcc)}</strong>
                          </li>
                          <li>
                            FINAL (scan AND icc both present):{" "}
                            <strong className="text-emerald-700">
                              {formatNumber(financialProfitDebug.chain.final)}
                            </strong>
                          </li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                          Sample IDs (first 5 of each — eyeball for mismatches)
                        </p>
                        <ul className="space-y-0.5">
                          <li>
                            mapping csgIds: [
                            {financialProfitDebug.samples.mappingCsgIds.join(", ") || "(empty)"}
                            ]
                          </li>
                          <li>
                            scan result csgIds: [
                            {financialProfitDebug.samples.scanCsgIds.join(", ") || "(empty)"}
                            ]
                          </li>
                          <li>
                            mapping appIds: [
                            {financialProfitDebug.samples.mappingAppIds.join(", ") || "(empty)"}
                            ]
                          </li>
                          <li>
                            ICC report appIds: [
                            {financialProfitDebug.samples.iccAppIds.join(", ") || "(empty)"}
                            ]
                          </li>
                          <li>
                            part2 verified appIds: [
                            {financialProfitDebug.samples.part2AppIds.join(", ") || "(empty)"}
                            ]
                          </li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-bold uppercase tracking-wider text-[10px] text-slate-500 mb-1">
                          ICC Report 3 column analysis
                        </p>
                        <ul className="space-y-0.5">
                          <li>
                            CSV headers (first 20):{" "}
                            {financialProfitDebug.icc.headers.length > 0
                              ? `[${financialProfitDebug.icc.headers.join(", ")}]`
                              : "(no headers)"}
                          </li>
                          <li>
                            appId field match:{" "}
                            <span
                              className={
                                financialProfitDebug.icc.appIdFieldFound
                                  .length > 0
                                  ? "text-emerald-700"
                                  : "text-rose-700 font-bold"
                              }
                            >
                              {financialProfitDebug.icc.appIdFieldFound
                                .length > 0
                                ? financialProfitDebug.icc.appIdFieldFound.join(
                                    ", "
                                  )
                                : "NONE — expected 'Application ID', 'Application_ID', or 'application_id'"}
                            </span>
                          </li>
                          <li>
                            contract value field match:{" "}
                            <span
                              className={
                                financialProfitDebug.icc
                                  .contractValueFieldFound.length > 0
                                  ? "text-emerald-700"
                                  : "text-rose-700 font-bold"
                              }
                            >
                              {financialProfitDebug.icc
                                .contractValueFieldFound.length > 0
                                ? financialProfitDebug.icc.contractValueFieldFound.join(
                                    ", "
                                  )
                                : "NONE — expected 'Total REC Delivery Contract Value', 'REC Delivery Contract Value', or 'Total Contract Value'"}
                            </span>
                          </li>
                        </ul>
                      </div>
                      <p className="text-[10px] text-slate-500 italic">
                        Diagnostic added 2026-04-11 to debug "contract scraper data not reaching Financials". If the chain shows withScan=0 but withCsgId&gt;0, the csgIds in your mapping don't match what the scraper has. If withScan&gt;0 but final=0, ICC Report 3 is missing rows for those appIds.
                      </p>
                    </div>
                  </details>
                </CardContent>
              </Card>
            )}

            {financialProfitData.rows.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Profit & Collateralization by System</CardTitle>
                      <CardDescription>Part II verified systems only. Profit = vendor fee. Collateral &gt; 30% of GCV flagged for review.</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(
                        [
                          "system_name", "application_id", "csg_id", "gross_contract_value",
                          "vendor_fee_percent", "vendor_fee_amount", "utility_5pct_collateral",
                          "additional_collateral_percent", "additional_collateral_amount",
                          "cc_auth_5pct", "application_fee", "total_deductions", "profit",
                          "total_collateralization", "needs_review", "review_reason",
                        ],
                        financialProfitData.rows.map(r => ({
                          system_name: r.systemName,
                          application_id: r.applicationId,
                          csg_id: r.csgId,
                          gross_contract_value: r.grossContractValue,
                          vendor_fee_percent: r.vendorFeePercent,
                          vendor_fee_amount: r.vendorFeeAmount,
                          utility_5pct_collateral: r.utilityCollateral,
                          additional_collateral_percent: r.additionalCollateralPercent,
                          additional_collateral_amount: r.additionalCollateralAmount,
                          cc_auth_5pct: r.ccAuth5Percent,
                          application_fee: r.applicationFee,
                          total_deductions: r.totalDeductions,
                          profit: r.profit,
                          total_collateralization: r.totalCollateralization,
                          needs_review: r.needsReview ? "Yes" : "",
                          review_reason: r.reviewReason,
                        }))
                      );
                      triggerCsvDownload(`profit-collateralization-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* ── Filter / search controls ───────────────────── */}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={financialSearch}
                      onChange={(e) => setFinancialSearch(e.target.value)}
                      placeholder="Search system, app ID, CSG ID…"
                      className="flex-1 min-w-[180px] rounded-sm border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <select
                      value={financialFilter}
                      onChange={(e) =>
                        setFinancialFilter(
                          e.target.value as "all" | "needs-review" | "ok"
                        )
                      }
                      className="rounded-sm border bg-background px-2 py-1.5 text-xs"
                    >
                      <option value="all">
                        All ({formatNumber(financialProfitData.rows.length)})
                      </option>
                      <option value="needs-review">
                        Needs Review ({formatNumber(financialFlaggedCount)})
                      </option>
                      <option value="ok">
                        OK (
                        {formatNumber(
                          financialProfitData.rows.length -
                            financialFlaggedCount
                        )}
                        )
                      </option>
                    </select>
                    <span className="text-xs text-muted-foreground">
                      Showing{" "}
                      {formatNumber(
                        Math.min(100, filteredFinancialRows.length)
                      )}{" "}
                      of {formatNumber(filteredFinancialRows.length)}
                    </span>
                  </div>
                  {/* ── Table ────────────────────────────────────────── */}
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50" onClick={() => handleFinancialSort("systemName")}>System{financialSortIndicator("systemName")}</TableHead>
                          <TableHead>App ID</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("grossContractValue")}>Gross Contract{financialSortIndicator("grossContractValue")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("vendorFeePercent")}>Vendor Fee %{financialSortIndicator("vendorFeePercent")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("vendorFeeAmount")}>Vendor Fee ${financialSortIndicator("vendorFeeAmount")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("utilityCollateral")}>Utility 5%{financialSortIndicator("utilityCollateral")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("additionalCollateralPercent")}>Add. Coll. %{financialSortIndicator("additionalCollateralPercent")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("additionalCollateralAmount")}>Add. Coll. ${financialSortIndicator("additionalCollateralAmount")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("ccAuth5Percent")}>CC Auth 5%{financialSortIndicator("ccAuth5Percent")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("applicationFee")}>App Fee{financialSortIndicator("applicationFee")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("totalDeductions")}>Total Ded.{financialSortIndicator("totalDeductions")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("profit")}>Profit{financialSortIndicator("profit")}</TableHead>
                          <TableHead className="cursor-pointer select-none hover:bg-slate-50 text-right" onClick={() => handleFinancialSort("totalCollateralization")}>Total Coll.{financialSortIndicator("totalCollateralization")}</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredFinancialRows.slice(0, 100).map((r) => (
                          <TableRow
                            key={r.csgId}
                            className={
                              r.needsReview
                                ? "bg-amber-50/60 border-l-2 border-amber-400"
                                : ""
                            }
                          >
                            <TableCell className="font-medium text-xs max-w-[160px] truncate">
                              {r.needsReview && (
                                <span className="text-amber-600 mr-1" title={r.reviewReason}>⚠</span>
                              )}
                              {r.systemName}
                            </TableCell>
                            <TableCell className="text-xs">{r.applicationId}</TableCell>
                            <TableCell className="text-right">${formatNumber(r.grossContractValue)}</TableCell>
                            <TableCell className="text-right">{r.vendorFeePercent}%</TableCell>
                            <TableCell className="text-right">${formatNumber(r.vendorFeeAmount)}</TableCell>
                            <TableCell className="text-right">${formatNumber(r.utilityCollateral)}</TableCell>
                            <TableCell className="text-right">{r.additionalCollateralPercent}%</TableCell>
                            <TableCell className="text-right">${formatNumber(r.additionalCollateralAmount)}</TableCell>
                            <TableCell className="text-right">${formatNumber(r.ccAuth5Percent)}</TableCell>
                            <TableCell className="text-right">${formatNumber(r.applicationFee)}</TableCell>
                            <TableCell className="text-right font-medium">${formatNumber(r.totalDeductions)}</TableCell>
                            <TableCell className="text-right font-semibold text-emerald-700">${formatNumber(r.profit)}</TableCell>
                            <TableCell className="text-right">${formatNumber(r.totalCollateralization)}</TableCell>
                            <TableCell>
                              {r.hasOverride && (
                                <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200 text-[10px] mr-1">
                                  Edited
                                </Badge>
                              )}
                              {r.needsReview ? (
                                <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200 text-[10px]">
                                  Review
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px]">OK</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() =>
                                    setEditingFinancialRow({
                                      csgId: r.csgId,
                                      systemName: r.systemName,
                                      vendorFeePercent: String(r.vendorFeePercent),
                                      additionalCollateralPercent: String(r.additionalCollateralPercent),
                                      notes: "",
                                    })
                                  }
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  disabled={rescanSingleContract.isPending}
                                  onClick={async () => {
                                    try {
                                      const result = await rescanSingleContract.mutateAsync({ csgId: r.csgId });
                                      toast.success(
                                        `Re-scanned CSG ${r.csgId}: vendor fee ${result.vendorFeePercent ?? "N/A"}%, collateral ${result.additionalCollateralPercent ?? "N/A"}%`
                                      );
                                      await contractScanResultsQuery.refetch();
                                    } catch (err) {
                                      toast.error(err instanceof Error ? err.message : "Re-scan failed");
                                    }
                                  }}
                                >
                                  Re-scan
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {filteredFinancialRows.length > 100 && (
                    <p className="text-xs text-muted-foreground text-center">
                      Showing 100 of {formatNumber(filteredFinancialRows.length)} systems. Export CSV for full data.
                    </p>
                  )}

                  {/* Edit override dialog */}
                  {editingFinancialRow && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md space-y-4">
                        <h3 className="font-semibold text-base">
                          Edit Contract — CSG {editingFinancialRow.csgId}
                        </h3>
                        <p className="text-xs text-muted-foreground">{editingFinancialRow.systemName}</p>
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <label className="text-sm font-medium">Vendor Fee %</label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editingFinancialRow.vendorFeePercent}
                              onChange={(e) =>
                                setEditingFinancialRow((prev) =>
                                  prev ? { ...prev, vendorFeePercent: e.target.value } : null
                                )
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-sm font-medium">Additional Collateral %</label>
                            <Input
                              type="number"
                              step="0.01"
                              value={editingFinancialRow.additionalCollateralPercent}
                              onChange={(e) =>
                                setEditingFinancialRow((prev) =>
                                  prev ? { ...prev, additionalCollateralPercent: e.target.value } : null
                                )
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-sm font-medium">Notes (optional)</label>
                            <Input
                              value={editingFinancialRow.notes}
                              onChange={(e) =>
                                setEditingFinancialRow((prev) =>
                                  prev ? { ...prev, notes: e.target.value } : null
                                )
                              }
                              placeholder="Reason for override..."
                            />
                          </div>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingFinancialRow(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={updateContractOverride.isPending}
                            onClick={async () => {
                              if (!editingFinancialRow) return;
                              try {
                                await updateContractOverride.mutateAsync({
                                  csgId: editingFinancialRow.csgId,
                                  vendorFeePercent: editingFinancialRow.vendorFeePercent
                                    ? parseFloat(editingFinancialRow.vendorFeePercent)
                                    : null,
                                  additionalCollateralPercent: editingFinancialRow.additionalCollateralPercent
                                    ? parseFloat(editingFinancialRow.additionalCollateralPercent)
                                    : null,
                                  notes: editingFinancialRow.notes || null,
                                });
                                toast.success(`Override saved for CSG ${editingFinancialRow.csgId}`);
                                setEditingFinancialRow(null);
                                await contractScanResultsQuery.refetch();
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Failed to save override");
                              }
                            }}
                          >
                            {updateContractOverride.isPending ? "Saving..." : "Save Override"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>)}

          {activeTab === "data-quality" && (<div className="space-y-4 mt-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Dataset Freshness</CardTitle><CardDescription>Upload status and age for each required dataset.</CardDescription></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Dataset</TableHead><TableHead>Last Updated</TableHead><TableHead className="text-right">Age (days)</TableHead><TableHead className="text-right">Rows</TableHead><TableHead>Status</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {dataQualityFreshness.map((d) => (
                      <TableRow key={d.key}>
                        <TableCell className="font-medium">{d.label}</TableCell>
                        <TableCell>{d.uploadedAt}</TableCell>
                        <TableCell className="text-right">{d.ageDays !== null ? d.ageDays : "—"}</TableCell>
                        <TableCell className="text-right">{formatNumber(d.rowCount)}</TableCell>
                        <TableCell>
                          <Badge variant={d.status === "Fresh" ? "default" : d.status === "Stale" ? "secondary" : d.status === "Critical" ? "destructive" : "outline"}>{d.status}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">System Reconciliation</CardTitle><CardDescription>Cross-reference between delivery schedules and monitoring data.</CardDescription></CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-center">
                    <p className="text-xs text-slate-500">Match Rate</p>
                    <p className="text-lg font-semibold text-emerald-800">{dataQualityUnmatched.matchedPercent !== null ? `${dataQualityUnmatched.matchedPercent.toFixed(1)}%` : "N/A"}</p>
                  </div>
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-center">
                    <p className="text-xs text-slate-500">In Schedule, No Monitoring</p>
                    <p className="text-lg font-semibold text-amber-800">{dataQualityUnmatched.inScheduleNotMonitoring.length}</p>
                  </div>
                  <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-center">
                    <p className="text-xs text-slate-500">In Monitoring, No Schedule</p>
                    <p className="text-lg font-semibold text-sky-800">{dataQualityUnmatched.inMonitoringNotSchedule.length}</p>
                  </div>
                </div>
                {dataQualityUnmatched.inScheduleNotMonitoring.length > 0 && (
                  <details className="mb-3">
                    <summary className="text-sm font-medium cursor-pointer text-amber-700">Systems in schedule but missing monitoring ({dataQualityUnmatched.inScheduleNotMonitoring.length})</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded border p-2 text-xs font-mono space-y-1">
                      {dataQualityUnmatched.inScheduleNotMonitoring.map((id) => <div key={id}>{id}</div>)}
                    </div>
                  </details>
                )}
                {dataQualityUnmatched.inMonitoringNotSchedule.length > 0 && (
                  <details>
                    <summary className="text-sm font-medium cursor-pointer text-sky-700">Systems in monitoring but not in schedule ({dataQualityUnmatched.inMonitoringNotSchedule.length})</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded border p-2 text-xs font-mono space-y-1">
                      {dataQualityUnmatched.inMonitoringNotSchedule.map((id) => <div key={id}>{id}</div>)}
                    </div>
                  </details>
                )}
              </CardContent>
            </Card>
          </div>)}

          {activeTab === "delivery-tracker" && (<div className="space-y-4 mt-4">
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
                    console.warn(
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card><CardHeader><CardDescription>Systems in Schedule</CardDescription><CardTitle className="text-2xl">{formatNumber(deliveryTrackerData.contracts.reduce((a, c) => a + c.systems, 0))}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Transfers Processed</CardDescription><CardTitle className="text-2xl">{formatNumber(deliveryTrackerData.totalTransfers)}</CardTitle></CardHeader></Card>
              <Card className={deliveryTrackerData.unmatchedTransfers > 0 ? "border-amber-200 bg-amber-50/50" : ""}><CardHeader><CardDescription>Unmatched Transfers</CardDescription><CardTitle className="text-2xl">{formatNumber(deliveryTrackerData.unmatchedTransfers)}</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Schedule Systems Loaded</CardDescription><CardTitle className="text-2xl">{formatNumber(deliveryTrackerData.scheduleCount ?? 0)}</CardTitle></CardHeader></Card>
            </div>
            {deliveryTrackerData.unmatchedTransfers > 0 && ((deliveryTrackerData.scheduleIdSample ?? []).length > 0 || (deliveryTrackerData.transferIdSample ?? []).length > 0) && (
              <Card className="border-amber-200 bg-amber-50/30">
                <CardContent className="pt-3 pb-3">
                  <p className="text-xs font-medium text-amber-800 mb-1">Debug: Sample IDs for matching</p>
                  <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                    <div><p className="text-amber-700 mb-1">Schedule IDs (first 5):</p>{(deliveryTrackerData.scheduleIdSample ?? []).map((id, i) => <div key={i}>{id}</div>)}</div>
                    <div><p className="text-amber-700 mb-1">Transfer Unit IDs (first 5):</p>{(deliveryTrackerData.transferIdSample ?? []).map((id, i) => <div key={i}>{id}</div>)}</div>
                  </div>
                </CardContent>
              </Card>
            )}

            {deliveryTrackerData.transfersMissingObligation.length > 0 && (
              <Card className="border-amber-200 bg-amber-50/40">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-base text-amber-900">
                        Missing Schedule B Coverage ({formatNumber(deliveryTrackerData.transfersMissingObligation.length)})
                      </CardTitle>
                      <CardDescription className="text-amber-800">
                        These tracking IDs have transfers recorded in GATS Transfer History but no matching
                        Schedule B PDF has been scraped yet. Their obligations are therefore unknown and they
                        are not counted in the contract summary below. Upload and scrape the corresponding
                        Schedule B PDFs to restore coverage.
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const csv = buildCsv(
                          ["tracking_system_ref_id"],
                          deliveryTrackerData.transfersMissingObligation.map((id) => ({
                            tracking_system_ref_id: id,
                          }))
                        );
                        triggerCsvDownload(
                          `delivery-tracker-missing-schedule-b-${timestampForCsvFileName()}.csv`,
                          csv
                        );
                      }}
                    >
                      Export CSV
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="max-h-48 overflow-y-auto rounded border border-amber-200 bg-white">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tracking ID</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deliveryTrackerData.transfersMissingObligation.slice(0, 20).map((id) => (
                          <TableRow key={id}>
                            <TableCell className="font-mono text-xs">{id}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {deliveryTrackerData.transfersMissingObligation.length > 20 && (
                    <p className="text-xs text-amber-700 mt-2">
                      Showing first 20 of {formatNumber(deliveryTrackerData.transfersMissingObligation.length)}{" "}
                      missing tracking IDs. Export CSV for the full list.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Contract summary */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Delivery by Contract</CardTitle>
                    <CardDescription>Obligations from Schedule B PDFs, actuals computed from Transfer History uploads.</CardDescription>
                  </div>
                  {deliveryTrackerData.contracts.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(
                        ["contract", "systems", "total_obligated", "total_delivered", "total_gap", "delivery_percent"],
                        deliveryTrackerData.contracts.map(c => ({
                          contract: c.contractId, systems: c.systems, total_obligated: c.totalObligated,
                          total_delivered: c.totalDelivered, total_gap: c.totalGap,
                          delivery_percent: c.deliveryPercent !== null ? c.deliveryPercent.toFixed(1) : "",
                        }))
                      );
                      triggerCsvDownload(`delivery-tracker-contracts-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {deliveryTrackerData.contracts.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">
                    Import Schedule B PDFs above and upload Transfer History (GATS) in Step 1 to see delivery tracking.
                  </p>
                ) : (
                  <>
                    <div className="h-72 rounded-md border border-slate-200 bg-white p-2 mb-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={deliveryTrackerData.contracts} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="contractId" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={60} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="totalObligated" fill="#94a3b8" name="Obligated" />
                          <Bar dataKey="totalDelivered" fill="#16a34a" name="Delivered" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Contract</TableHead>
                        <TableHead className="text-right">Systems</TableHead>
                        <TableHead className="text-right">Obligated</TableHead>
                        <TableHead className="text-right">Delivered</TableHead>
                        <TableHead className="text-right">Gap</TableHead>
                        <TableHead className="text-right">Delivery %</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {deliveryTrackerData.contracts.map((c) => (
                          <TableRow key={c.contractId}>
                            <TableCell className="font-medium">{c.contractId}</TableCell>
                            <TableCell className="text-right">{c.systems}</TableCell>
                            <TableCell className="text-right">{formatNumber(c.totalObligated)}</TableCell>
                            <TableCell className="text-right">{formatNumber(c.totalDelivered)}</TableCell>
                            <TableCell className="text-right">{formatNumber(c.totalGap)}</TableCell>
                            <TableCell className="text-right">{c.deliveryPercent !== null ? `${c.deliveryPercent.toFixed(1)}%` : "N/A"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </CardContent>
            </Card>

            {/* System-level detail (paginated) */}
            {deliveryTrackerData.rows.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">System × Year Detail</CardTitle>
                      <CardDescription>{formatNumber(deliveryTrackerData.rows.length)} system-year rows</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => {
                      const csv = buildCsv(
                        ["system_name", "unit_id", "contract", "year", "start_date", "end_date", "obligated", "delivered", "gap"],
                        deliveryTrackerData.rows.map(r => ({
                          system_name: r.systemName, unit_id: r.unitId, contract: r.contractId,
                          year: r.yearLabel, start_date: r.yearStart?.toISOString().slice(0, 10) ?? "",
                          end_date: r.yearEnd?.toISOString().slice(0, 10) ?? "",
                          obligated: r.obligated, delivered: r.delivered, gap: r.gap,
                        }))
                      );
                      triggerCsvDownload(`delivery-tracker-detail-${timestampForCsvFileName()}.csv`, csv);
                    }}>Export CSV</Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="max-h-[500px] overflow-y-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>System</TableHead>
                        <TableHead>Unit ID</TableHead>
                        <TableHead>Contract</TableHead>
                        <TableHead>Year</TableHead>
                        <TableHead className="text-right">Obligated</TableHead>
                        <TableHead className="text-right">Delivered</TableHead>
                        <TableHead className="text-right">Gap</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {deliveryTrackerData.rows.slice(0, 200).map((r, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-sm">{r.systemName}</TableCell>
                            <TableCell className="text-xs text-slate-500">{r.unitId}</TableCell>
                            <TableCell className="text-sm">{r.contractId}</TableCell>
                            <TableCell className="text-sm">{r.yearLabel}</TableCell>
                            <TableCell className="text-right">{formatNumber(r.obligated)}</TableCell>
                            <TableCell className="text-right">{formatNumber(r.delivered)}</TableCell>
                            <TableCell className={`text-right ${r.gap > 0 ? "text-rose-600" : r.gap < 0 ? "text-emerald-600" : ""}`}>{formatNumber(r.gap)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {deliveryTrackerData.rows.length > 200 && (
                    <p className="text-xs text-slate-500 mt-2 text-center">Showing first 200 of {formatNumber(deliveryTrackerData.rows.length)} rows. Export CSV for full data.</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>)}
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
                const error = uploadErrors[key];
                const isMultiAppend = MULTI_APPEND_DATASET_KEYS.has(key);
                const isScannerManaged = SCANNER_MANAGED_DATASET_KEYS.has(key);
                const hasCloudBackfillMarker = Boolean(
                  dataset &&
                    (dataset.fileName.toLowerCase().includes("cloud-backfill") ||
                      dataset.sources?.some((source) => source.fileName.toLowerCase().includes("cloud-backfill")))
                );
                const cloudStatusForDataset: DatasetCloudSyncStatus | undefined =
                  datasetCloudSyncStatus[key] ??
                  (localOnlyDatasets[key]
                    ? undefined
                    : remoteSourceManifests[key]?.sources?.length
                      ? "synced"
                      : hasCloudBackfillMarker
                        ? "synced"
                      : undefined);

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
                            {dataset.rows.length} rows loaded
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
                    ) : (
                      <Badge variant="outline" className="text-slate-600">
                        Not uploaded
                      </Badge>
                    )}

                    {error ? <p className="text-xs text-rose-700">{error}</p> : null}

                    {isScannerManaged ? (
                      <div className="space-y-2">
                        <p className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                          Populated by the Schedule B PDF scanner on the <strong>Delivery Tracker</strong> tab.
                          Upload Schedule B PDFs there to (re)generate this dataset. Direct CSV upload is not
                          supported.
                        </p>
                        <div className="flex items-center gap-2">
                          {dataset ? (
                            <Button variant="ghost" size="sm" onClick={() => clearDataset(key)}>
                              Clear
                            </Button>
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
                        {dataset ? (
                          <Button variant="ghost" size="sm" onClick={() => clearDataset(key)}>
                            Remove
                          </Button>
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
        <Sheet open={selectedSystemKey !== null} onOpenChange={(open) => { if (!open) setSelectedSystemKey(null); }}>
          <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
            <SheetHeader>
              <SheetTitle className="text-base">System Details</SheetTitle>
              <SheetDescription>Full details for the selected system.</SheetDescription>
            </SheetHeader>
            {(() => {
              const sys = systems.find((s) => s.key === selectedSystemKey);
              if (!sys) return <p className="text-sm text-slate-500 mt-4">System not found.</p>;

              // Find converted reads for this system
              const sysReads = (datasets.convertedReads?.rows ?? []).filter((r) => {
                const rId = (r.monitoring_system_id || "").toLowerCase();
                const rName = (r.monitoring_system_name || "").toLowerCase();
                const sysId = (sys.systemId || "").toLowerCase();
                const sysName = sys.systemName.toLowerCase();
                return (sysId && rId === sysId) || (sysName && rName === sysName);
              }).slice(0, 20);

              return (
                <div className="space-y-4 mt-4">
                  {/* Identifiers */}
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold uppercase text-slate-500">Identifiers</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <span className="text-slate-500">Name</span><span className="font-medium">{sys.systemName}</span>
                      {sys.systemId && <><span className="text-slate-500">System ID</span><span className="font-medium">{sys.systemId}</span></>}
                      {sys.trackingSystemRefId && <><span className="text-slate-500">Tracking ID</span><span className="font-medium">{sys.trackingSystemRefId}</span></>}
                      {sys.stateApplicationRefId && <><span className="text-slate-500">App Ref ID</span><span className="font-medium">{sys.stateApplicationRefId}</span></>}
                    </div>
                  </div>

                  {/* REC Contract */}
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold uppercase text-slate-500">REC Contract</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <span className="text-slate-500">REC Price</span><span className="font-medium">{sys.recPrice !== null ? `$${sys.recPrice}` : "N/A"}</span>
                      <span className="text-slate-500">Contracted RECs</span><span className="font-medium">{formatNumber(sys.contractedRecs)}</span>
                      <span className="text-slate-500">Delivered RECs</span><span className="font-medium">{formatNumber(sys.deliveredRecs)}</span>
                      <span className="text-slate-500">Contracted Value</span><span className="font-medium">{sys.contractedValue !== null ? `$${formatNumber(sys.contractedValue)}` : "N/A"}</span>
                      <span className="text-slate-500">Delivered Value</span><span className="font-medium">{sys.deliveredValue !== null ? `$${formatNumber(sys.deliveredValue)}` : "N/A"}</span>
                      <span className="text-slate-500">Value Gap</span><span className={`font-medium ${(sys.valueGap ?? 0) > 0 ? "text-rose-600" : "text-emerald-600"}`}>{sys.valueGap !== null ? `$${formatNumber(sys.valueGap)}` : "N/A"}</span>
                    </div>
                  </div>

                  {/* Status */}
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold uppercase text-slate-500">Status</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <span className="text-slate-500">Reporting</span><span><Badge variant={sys.isReporting ? "default" : "destructive"}>{sys.isReporting ? "Yes" : "No"}</Badge></span>
                      <span className="text-slate-500">Last Reported</span><span className="font-medium">{sys.latestReportingDate?.toLocaleDateString() ?? "Never"}</span>
                      <span className="text-slate-500">Ownership</span><span><Badge variant="outline">{sys.ownershipStatus}</Badge></span>
                      <span className="text-slate-500">Contract Status</span><span className="font-medium">{sys.contractStatusText || "N/A"}</span>
                    </div>
                  </div>

                  {/* System Details */}
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold uppercase text-slate-500">System</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <span className="text-slate-500">Size (AC)</span><span className="font-medium">{sys.installedKwAc !== null ? `${formatCapacityKw(sys.installedKwAc)} kW` : "N/A"}</span>
                      <span className="text-slate-500">Size (DC)</span><span className="font-medium">{sys.installedKwDc !== null ? `${formatCapacityKw(sys.installedKwDc)} kW` : "N/A"}</span>
                      <span className="text-slate-500">Monitoring</span><span className="font-medium">{sys.monitoringPlatform || "N/A"}</span>
                      <span className="text-slate-500">Type</span><span className="font-medium">{sys.monitoringType || "N/A"}</span>
                      <span className="text-slate-500">Installer</span><span className="font-medium">{sys.installerName || "N/A"}</span>
                    </div>
                  </div>

                  {/* Recent Converted Reads */}
                  {sysReads.length > 0 && (
                    <div className="space-y-1">
                      <h4 className="text-xs font-semibold uppercase text-slate-500">Recent Meter Reads ({sysReads.length})</h4>
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead className="text-xs">Date</TableHead>
                          <TableHead className="text-xs">Platform</TableHead>
                          <TableHead className="text-xs text-right">Lifetime (Wh)</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {sysReads.map((r, i) => (
                            <TableRow key={i}>
                              <TableCell className="text-xs">{r.read_date}</TableCell>
                              <TableCell className="text-xs">{r.monitoring}</TableCell>
                              <TableCell className="text-xs text-right">{formatNumber(parseFloat(r.lifetime_meter_read_wh || "0"))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              );
            })()}
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
