/**
 * Shared constants for the Solar REC dashboard modules.
 *
 * Phase 0 seeds this file with UTILITY_PATTERNS, the single constant that
 * buildDeliveryTrackerData needs. Phase 1 will move DATASET_DEFINITIONS,
 * the pagesize constants, and the REMOTE_* keys here too.
 */

import type {
  ChangeOwnershipStatus,
  OwnershipStatus,
} from "@/solar-rec-dashboard/state/types";

/**
 * Transferee / transferor name fragments that identify the receiving entity
 * as an Illinois utility (ComEd, Ameren Illinois, MidAmerican). A transfer
 * whose transferee matches one of these is treated as a delivery; a transfer
 * whose transferor matches one of these is treated as a return.
 *
 * Duplicated at SolarRecDashboard.tsx:4419-4420, 6908-6909, and 10120-10121.
 * Phase 1 collapses those callsites to import from here.
 */
export const UTILITY_PATTERNS = ["comed", "ameren", "midamerican"] as const;

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

export const COO_TARGET_STATUS = "Change of Ownership - Not Transferred and Not Reporting";
export const NO_COO_STATUS = "No COO Status";
export const TEN_KW_COMPLIANT_SOURCE = "10kW AC or Less";

export const AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY: Record<string, string> = {
  enphase: "Enphase",
  alsoenergy: "AlsoEnergy",
  "solar log": "Solar-Log",
  "sdsi arraymeter": "SDSI Arraymeter",
  "locus energy": "Locus Energy",
  "vision metering": "Vision Metering",
  sensergm: "SenseRGM",
  "ekm encompass io": "EKM Encompass.io",
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

export const LEGACY_DATASETS_STORAGE_KEY = "solarRecDashboardDatasetsV1";
export const LOGS_STORAGE_KEY = "solarRecDashboardLogsV1";
export const DASHBOARD_DB_NAME = "solarRecDashboardDb";
export const DASHBOARD_DB_VERSION = 2;
export const DASHBOARD_DATASETS_STORE = "datasets";
export const DASHBOARD_DATASETS_RECORD_KEY = "activeDatasets";
export const DASHBOARD_DATASETS_MANIFEST_KEY = "__dataset_manifest_v2__";
export const DASHBOARD_LOGS_RECORD_KEY = "__snapshot_logs_v2__";

// ---------------------------------------------------------------------------
// Formatting & numeric constants
// ---------------------------------------------------------------------------

export const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Page-size constants
// ---------------------------------------------------------------------------

export const SIZE_SITE_LIST_PAGE_SIZE = 10;
export const PERFORMANCE_RATIO_PAGE_SIZE = 10;
export const COMPLIANT_SOURCE_PAGE_SIZE = 10;
export const COMPLIANT_REPORT_PAGE_SIZE = 10;
export const REC_VALUE_PAGE_SIZE = 50;
export const SNAPSHOT_CONTRACT_PAGE_SIZE = 25;
export const CONTRACT_SUMMARY_PAGE_SIZE = 50;
export const CONTRACT_DETAIL_PAGE_SIZE = 50;
export const ANNUAL_CONTRACT_VINTAGE_PAGE_SIZE = 50;
export const ANNUAL_CONTRACT_SUMMARY_PAGE_SIZE = 50;
export const REC_PERFORMANCE_RESULTS_PAGE_SIZE = 50;
export const OFFLINE_DETAIL_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Business-rule constants
// ---------------------------------------------------------------------------

export const SNAPSHOT_REC_PERFORMANCE_DELIVERY_YEAR_LABEL = "2025-2026";
export const IL_ABP_TRANSFERRED_CONTRACT_TYPE = "il abp - transferred";
export const IL_ABP_TERMINATED_CONTRACT_TYPE = "il abp - terminated";

// ---------------------------------------------------------------------------
// Remote sync limits
// ---------------------------------------------------------------------------

export const MAX_REMOTE_STATE_LOG_BYTES = 120_000;
export const MAX_REMOTE_STATE_PAYLOAD_CHARS = 180_000;
export const REMOTE_LOG_ENTRY_LIMIT = 40;
export const REMOTE_DATASET_CHUNK_CHAR_LIMIT = 250_000;
// `MAX_REMOTE_DATASET_SYNC_ESTIMATED_CHARS = 3_000_000` was a 2026-04-
// era pre-flight cap that flipped any dataset whose chunked-CSV
// estimate exceeded 3 MB into a "Local-only sync — too large for
// auto sync" dead-end (e.g. Schedule B at 3.0 MB, the appended
// `convertedReads` blob). The cap was originally set when chunked
// writes were hitting tRPC body-size errors, but the actual save
// path chunks the payload at `REMOTE_DATASET_CHUNK_CHAR_LIMIT`
// (250 KB) into serial `saveDataset` calls — no per-request size
// limit to hit. Removed 2026-04-27 in the same PR that yanked the
// false-positive "too large" notice. Don't reintroduce without a
// concrete request-size failure to point at.
export const REMOTE_LOG_SYNC_MAX_CHUNKS = 120;
export const MAX_LOCAL_LOG_STORAGE_CHARS = 250_000;
export const REMOTE_DATASET_KEY_MANIFEST = "dataset_manifest_v1";
export const REMOTE_SNAPSHOT_LOGS_KEY = "snapshot_logs_v1";

// ---------------------------------------------------------------------------
// Header / column constants
// ---------------------------------------------------------------------------

export const MONTH_HEADERS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const GENERATION_BASELINE_VALUE_HEADERS = [
  "Last Meter Read (kWh)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Most Recent Production (kWh)",
  "Most Recent Production",
  "Generation (kWh)",
  "Production (kWh)",
];

export const GENERATION_BASELINE_DATE_HEADERS = [
  "Last Meter Read Date",
  "Last Month of Gen",
  "Effective Date",
  "Month of Generation",
];

export const GENERATOR_DETAILS_AC_SIZE_HEADERS = [
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

// ---------------------------------------------------------------------------
// Compliant source limits
// ---------------------------------------------------------------------------

export const COMPLIANT_SOURCE_STORAGE_KEY = "solarRecDashboardCompliantSourcesV1";
export const MAX_COMPLIANT_SOURCE_CHARS = 100;
export const MAX_COMPLIANT_FILE_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Upload limits
// ---------------------------------------------------------------------------

export const MAX_SINGLE_CSV_UPLOAD_BYTES = 150 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Stale-upload threshold
// ---------------------------------------------------------------------------

export const STALE_UPLOAD_DAYS = 14;

// ---------------------------------------------------------------------------
// Dashboard tabs
// ---------------------------------------------------------------------------

export const DASHBOARD_TAB_VALUES = [
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

export const DEFAULT_DASHBOARD_TAB = "overview";
export const DASHBOARD_TAB_VALUE_SET = new Set<string>(DASHBOARD_TAB_VALUES);

// ---------------------------------------------------------------------------
// Ownership status orderings (for dropdowns, breakdown tables, and snapshot
// diffs). Used by both the parent dashboard and the extracted Ownership +
// ChangeOwnership tabs.
// ---------------------------------------------------------------------------

export const OWNERSHIP_ORDER: OwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Not Transferred and Reporting",
  "Not Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
];

export const CHANGE_OWNERSHIP_ORDER: ChangeOwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Terminated",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
];
