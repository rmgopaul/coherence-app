import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronUp, Database, Trash2, Upload } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import {
  buildMeterReadDownloadFileName,
  convertMeterReadWorkbook,
  type MeterReadsConversionResult,
} from "@/lib/meterReads";

type DatasetKey =
  | "solarApplications"
  | "abpReport"
  | "recDeliverySchedules"
  | "generationEntry"
  | "accountSolarGeneration"
  | "contractedDate"
  | "convertedReads"
  | "annualProductionEstimates"
  | "generatorDetails";

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

type CsvRow = Record<string, string>;

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
  recDeliverySchedules: {
    label: "REC Delivery Schedules",
    description: "Contracted and delivered RECs by contract year.",
    requiredHeaderSets: [["tracking_system_ref_id", "year1_quantity_required", "year1_quantity_delivered"]],
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

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

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
const REMOTE_DATASET_CHUNK_CHAR_LIMIT = 1_000_000;
const MAX_LOCAL_LOG_STORAGE_CHARS = 250_000;
const REMOTE_DATASET_KEY_MANIFEST = "dataset_manifest_v1";
const REMOTE_SNAPSHOT_LOGS_KEY = "snapshot_logs_v1";
const MONTH_HEADERS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const COMPLIANT_SOURCE_STORAGE_KEY = "solarRecDashboardCompliantSourcesV1";
const MAX_COMPLIANT_SOURCE_CHARS = 100;
const MAX_COMPLIANT_FILE_BYTES = 12 * 1024 * 1024;
const MAX_SINGLE_CSV_UPLOAD_BYTES = 60 * 1024 * 1024;
const MULTI_APPEND_DATASET_KEYS = new Set<DatasetKey>(["accountSolarGeneration", "convertedReads"]);
const CORE_REQUIRED_DATASET_KEYS: DatasetKey[] = [
  "solarApplications",
  "abpReport",
  "recDeliverySchedules",
  "generationEntry",
  "accountSolarGeneration",
];
const STALE_UPLOAD_DAYS = 14;

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

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
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

function formatCurrency(value: number | null): string {
  if (value === null) return "N/A";
  return CURRENCY_FORMATTER.format(value);
}

function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return "N/A";
  if (digits > 0) return value.toFixed(digits);
  return NUMBER_FORMATTER.format(value);
}

function formatCapacityKw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function toPercentValue(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(1)}%`;
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

function formatTransitionBreakdown(breakdown: Map<TransitionStatus, number>): string {
  const orderedStatuses: TransitionStatus[] = [...CHANGE_OWNERSHIP_ORDER, NO_COO_STATUS];
  const parts = orderedStatuses
    .map((status) => ({ status, count: breakdown.get(status) ?? 0 }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.status}: ${NUMBER_FORMATTER.format(item.count)}`);
  return parts.length > 0 ? parts.join(" | ") : "None";
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (char === "\"") {
      const next = source[i + 1];
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
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
      if (char === "\r" && source[i + 1] === "\n") i += 1;
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

  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((header, index) => clean(header) || `column_${index + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(values[index]);
    });
    return record;
  });

  return { headers, rows };
}

type CsvParserWorkerRequest = {
  id: number;
  text: string;
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

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll("\"", "\"\"")}"`;
  }
  return normalized;
}

function buildCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  const headerLine = headers.map((header) => csvEscape(header)).join(",");
  const bodyLines = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return [headerLine, ...bodyLines].join("\n");
}

function matchesExpectedHeaders(headers: string[], expected: string[]): boolean {
  const available = new Set(headers.map((header) => clean(header).toLowerCase()));
  return expected.every((header) => available.has(header.toLowerCase()));
}

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

function datasetAppendRowKey(key: DatasetKey, row: CsvRow): string {
  if (key === "accountSolarGeneration") return accountSolarGenerationRowKey(row);
  if (key === "convertedReads") return convertedReadsRowKey(row);
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
  const [, setLocation] = useLocation();
  const [datasets, setDatasets] = useState<Partial<Record<DatasetKey, CsvDataset>>>({});
  const [datasetsHydrated, setDatasetsHydrated] = useState(false);
  const [logEntries, setLogEntries] = useState<DashboardLogEntry[]>(() => loadPersistedLogs());
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DatasetKey, string>>>({});
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [remoteStateHydrated, setRemoteStateHydrated] = useState(false);
  const remoteDashboardStateQuery = trpc.solarRecDashboard.getState.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: false,
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
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipStatus | "All">("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [changeOwnershipFilter, setChangeOwnershipFilter] = useState<ChangeOwnershipStatus | "All">("All");
  const [changeOwnershipSearch, setChangeOwnershipSearch] = useState("");
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
  const [activeTab, setActiveTab] = useState("overview");
  const isContractsTabActive = activeTab === "contracts";
  const isAnnualReviewTabActive = activeTab === "annual-review";
  const isPerformanceEvalTabActive = activeTab === "performance-eval" || activeTab === "snapshot-log";
  const isOfflineTabActive = activeTab === "offline-monitoring";
  const isPerformanceRatioTabActive = activeTab === "performance-ratio";
  const isContractsComputationActive =
    isContractsTabActive || isAnnualReviewTabActive || isPerformanceEvalTabActive;
  const datasetsRef = useRef(datasets);
  datasetsRef.current = datasets;
  const logEntriesRef = useRef(logEntries);
  logEntriesRef.current = logEntries;
  const datasetsHydratedRef = useRef(false);
  const remoteStateHydratedRef = useRef(false);
  const remoteStatusRef = useRef(remoteDashboardStateQuery.status);
  const remoteLogsSignatureRef = useRef<string>("0");
  const remoteLogsChunkKeysRef = useRef<string[]>([]);
  const localDatasetSignatureRef = useRef<string>("");
  const localLogsSignatureRef = useRef<string>("0");
  const csvParserWorkerRef = useRef<Worker | null>(null);
  const csvParserRequestSeqRef = useRef(1);
  const csvParserPendingRef = useRef(
    new Map<number, { resolve: (value: { headers: string[]; rows: CsvRow[] }) => void; reject: (error: Error) => void }>()
  );

  const ensureCsvParserWorker = useCallback(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    if (csvParserWorkerRef.current) return csvParserWorkerRef.current;

    const worker = new Worker(new URL("../workers/csvParser.worker.ts", import.meta.url), {
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

  const parseCsvAsync = useCallback(
    async (text: string): Promise<{ headers: string[]; rows: CsvRow[] }> => {
      const worker = ensureCsvParserWorker();
      if (!worker) return parseCsv(text);

      return new Promise((resolve, reject) => {
        const id = csvParserRequestSeqRef.current++;
        csvParserPendingRef.current.set(id, { resolve, reject });
        const message: CsvParserWorkerRequest = { id, text };
        worker.postMessage(message);
      });
    },
    [ensureCsvParserWorker]
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
      const raw = await file.text();
      const parsed = await parseCsvAsync(raw);
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
      const raw = await file.text();
      const parsed = await parseCsvAsync(raw);
      const isValid = config.requiredHeaderSets.some((set) => matchesExpectedHeaders(parsed.headers, set));

      if (!isValid) {
        setUploadErrors((previous) => ({
          ...previous,
          [key]: `This file does not match the expected ${config.label} format.`,
        }));
        return;
      }

      setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
      setDatasets((previous) => ({
        ...previous,
        [key]: (() => {
          const uploadedAt = new Date();
          const shouldAppend = MULTI_APPEND_DATASET_KEYS.has(key) && mode === "append";
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
    const parsedFiles: Array<{ fileName: string; uploadedAt: Date; headers: string[]; rows: CsvRow[] }> = [];

    try {
      for (const file of files) {
        if (file.size > MAX_SINGLE_CSV_UPLOAD_BYTES) {
          setUploadErrors((previous) => ({
            ...previous,
            [key]: `${file.name} is too large (${formatNumber(file.size / 1024 / 1024, 1)} MB). Please split files larger than ${formatNumber(MAX_SINGLE_CSV_UPLOAD_BYTES / 1024 / 1024)} MB.`,
          }));
          return;
        }
        const raw = await file.text();
        const parsed = await parseCsvAsync(raw);
        const isValid = config.requiredHeaderSets.some((set) => matchesExpectedHeaders(parsed.headers, set));
        if (!isValid) {
          setUploadErrors((previous) => ({
            ...previous,
            [key]: `${file.name} does not match the expected ${config.label} format.`,
          }));
          return;
        }

        parsedFiles.push({
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error while reading CSV files.";
      setUploadErrors((previous) => ({ ...previous, [key]: message }));
    }
  };

  const clearDataset = (key: DatasetKey) => {
    setDatasets((previous) => ({ ...previous, [key]: undefined }));
    setUploadErrors((previous) => ({ ...previous, [key]: undefined }));
  };

  const clearAll = () => {
    setDatasets({});
    setUploadErrors({});
    setMeterReadsResult(null);
    setMeterReadsError(null);
    setMeterReadsBusy(false);
  };

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
      const systemId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const name = clean(row.Project_Name) || clean(row.system_name);

      const key = systemId
        ? `id:${systemId}`
        : trackingId
          ? `tracking:${trackingId}`
          : name
            ? `name:${name.toLowerCase()}`
            : `row:${index}`;
      uniqueEligibleKeys.add(key);
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
      };

      builders.set(key, created);
      if (trackingSystemRefId) keyByTracking.set(trackingSystemRefId, key);
      if (systemId) keyBySystemId.set(systemId, key);
      return created;
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

    (datasets.recDeliverySchedules?.rows ?? []).forEach((row) => {
      const trackingSystemRefId = clean(row.tracking_system_ref_id) || null;
      if (!trackingSystemRefId) return;
      const builder = ensureBuilder(trackingSystemRefId, null);

      const systemName = clean(row.system_name);
      if (systemName) {
        builder.names.add(systemName);
        if (!builder.primaryName) builder.primaryName = systemName;
      }

      const required = sumSchedule(row, "_quantity_required");
      const delivered = sumSchedule(row, "_quantity_delivered");
      if (required !== null) builder.scheduleRequired = required;
      if (delivered !== null) builder.scheduleDelivered = delivered;
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

      builder.latestGenerationDate = maxDate(builder.latestGenerationDate, parseDate(row["Month of Generation"]));
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

      builder.latestGenerationDate = maxDate(builder.latestGenerationDate, parseDate(row["Last Month of Gen"]));
    });

    const threshold = new Date();
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

    part2VerifiedAbpRows.forEach((row, index) => {
      const applicationId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const projectName = clean(row.Project_Name) || clean(row.system_name);
      const part2ProjectKey = applicationId
        ? `id:${applicationId}`
        : trackingId
          ? `tracking:${trackingId}`
          : projectName
            ? `name:${projectName.toLowerCase()}`
            : `row:${index}`;
      if (uniquePart2Projects.has(part2ProjectKey)) return;
      uniquePart2Projects.add(part2ProjectKey);

      const matchedSystems = new Map<string, SystemRecord>();
      (systemsById.get(applicationId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByTrackingId.get(trackingId) ?? []).forEach((system) => matchedSystems.set(system.key, system));
      (systemsByName.get(projectName.toLowerCase()) ?? []).forEach((system) => matchedSystems.set(system.key, system));

      if (matchedSystems.size === 0) {
        notTransferredNotReporting += 1;
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

  const changeOwnershipRows = useMemo(
    () =>
      part2EligibleSystemsForSizeReporting.filter(
        (system) => system.hasChangedOwnership && system.changeOwnershipStatus !== null
      ),
    [part2EligibleSystemsForSizeReporting]
  );

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
    return changeOwnershipRows.filter((system) => {
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
  }, [changeOwnershipFilter, changeOwnershipRows, changeOwnershipSearch]);

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
    if (!isPerformanceRatioTabActive) return new Map<string, AnnualProductionProfile>();
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
  }, [datasets.annualProductionEstimates, isPerformanceRatioTabActive]);

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
    if (!isPerformanceRatioTabActive) return new Map<string, GenerationBaseline>();
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
  }, [datasets.accountSolarGeneration, datasets.generationEntry, isPerformanceRatioTabActive]);

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

  const performanceSourceRows = useMemo<PerformanceSourceRow[]>(() => {
    if (!isPerformanceEvalTabActive) return [];
    return (datasets.recDeliverySchedules?.rows ?? [])
      .map((row, rowIndex) => {
        const trackingSystemRefId = clean(row.tracking_system_ref_id);
        if (!trackingSystemRefId || !eligibleTrackingIds.has(trackingSystemRefId)) return null;
        const system = systemsByTrackingId.get(trackingSystemRefId);
        const years = buildScheduleYearEntries(row);
        if (years.length === 0) return null;

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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, isPerformanceEvalTabActive, systemsByTrackingId]);

  const performanceContractOptions = useMemo(
    () =>
      Array.from(new Set(performanceSourceRows.map((row) => row.contractId))).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
      ),
    [performanceSourceRows]
  );

  const effectivePerformanceContractId =
    performanceContractOptions.includes(performanceContractId)
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
      .filter((row) => row.contractId === effectivePerformanceContractId)
      .forEach((row) => {
        row.years.forEach((year) => {
          const existing = byKey.get(year.key);
          const label = buildDeliveryYearLabel(year.startDate, year.endDate, year.startRaw, year.endRaw);
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

  const effectivePerformanceDeliveryYearKey =
    performanceDeliveryYearOptions.some((option) => option.key === performanceDeliveryYearKey)
      ? performanceDeliveryYearKey
      : (performanceDeliveryYearOptions[performanceDeliveryYearOptions.length - 1]?.key ?? "");

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
      .filter((row) => row.contractId === effectivePerformanceContractId)
      .map((row) => {
        const targetYearIndex = row.years.findIndex((year) => year.key === effectivePerformanceDeliveryYearKey);
        if (targetYearIndex === -1) return null;
        // Do not include projects that are not in their 3rd delivery year or later.
        if (targetYearIndex < 2) return null;

        const dyOneYear = row.years[targetYearIndex - 2];
        const dyTwoYear = row.years[targetYearIndex - 1];
        const dyThreeYear = row.years[targetYearIndex];
        if (!dyOneYear || !dyTwoYear || !dyThreeYear) return null;

        const isThirdDeliveryYear = targetYearIndex === 2;
        const isFourthOrLaterDeliveryYear = targetYearIndex >= 3;

        const values: Array<{ value: number; source: "Actual" | "Expected" }> = isThirdDeliveryYear
          ? [
              { value: dyOneYear.delivered, source: "Actual" },
              { value: dyTwoYear.delivered, source: "Actual" },
              { value: dyThreeYear.delivered, source: "Actual" },
            ]
          : isFourthOrLaterDeliveryYear
            ? [
                { value: dyOneYear.required, source: "Expected" },
                { value: dyTwoYear.required, source: "Expected" },
                { value: dyThreeYear.delivered, source: "Actual" },
              ]
            : [
                { value: dyOneYear.required, source: "Expected" },
                { value: dyTwoYear.required, source: "Expected" },
                { value: dyThreeYear.required, source: "Expected" },
              ];

        const rollingAverage = Math.floor((values[0].value + values[1].value + values[2].value) / 3);
        const expectedRecs = dyThreeYear.required;
        const surplusShortfall = rollingAverage - expectedRecs;

        return {
          key: row.key,
          applicationId: row.systemId ?? "N/A",
          unitId: row.trackingSystemRefId,
          batchId: row.batchId ?? "N/A",
          systemName: row.systemName,
          contractId: row.contractId,
          deliveryYearOne: values[0]?.value ?? 0,
          deliveryYearTwo: values[1]?.value ?? 0,
          deliveryYearThree: values[2]?.value ?? 0,
          deliveryYearOneSource: values[0]?.source ?? "Expected",
          deliveryYearTwoSource: values[1]?.source ?? "Expected",
          deliveryYearThreeSource: values[2]?.source ?? "Expected",
          rollingAverage,
          contractPrice: row.recPrice,
          expectedRecs,
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

    (datasets.recDeliverySchedules?.rows ?? []).forEach((row) => {
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const deliveryStartRaw = clean(row.year1_start_date);
      if (!deliveryStartRaw) return;

      const deliveryStartDate = parseDate(deliveryStartRaw);
      const required = parseNumber(row.year1_quantity_required) ?? 0;
      const delivered = parseNumber(row.year1_quantity_delivered) ?? 0;
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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, isAnnualReviewTabActive, recPriceByTrackingId, systemsByTrackingId]);

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

    (datasets.recDeliverySchedules?.rows ?? []).forEach((row) => {
      const contractId = clean(row.utility_contract_number) || "Unassigned";
      const trackingId = clean(row.tracking_system_ref_id);
      if (!trackingId || !eligibleTrackingIds.has(trackingId)) return;

      const deliveryStartRaw = clean(row.year1_start_date);
      if (!deliveryStartRaw) return;

      const deliveryStartDate = parseDate(deliveryStartRaw);
      const required = parseNumber(row.year1_quantity_required) ?? 0;
      const delivered = parseNumber(row.year1_quantity_delivered) ?? 0;
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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, isContractsTabActive, recPriceByTrackingId]);

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
    remoteStatusRef.current = remoteDashboardStateQuery.status;
  }, [remoteDashboardStateQuery.status]);

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
      if (remoteDashboardStateQuery.status === "error") {
        if (!cancelled) setRemoteStateHydrated(true);
        return;
      }

      const loadRemoteDatasets = async (keys: DatasetKey[]) => {
        const loadedDatasets: Partial<Record<DatasetKey, CsvDataset>> = {};
        const loadedSignatures: Partial<Record<DatasetKey, string>> = {};
        const loadedChunkKeys: Partial<Record<DatasetKey, string[]>> = {};
        const loadChunkedPayload = async (chunkKeys: string[]): Promise<string | null> => {
          let combined = "";
          for (const chunkKey of chunkKeys) {
            if (cancelled) return null;
            const chunkResponse = await getRemoteDatasetRef.current
              .mutateAsync({ key: chunkKey })
              .catch(() => null);
            if (!chunkResponse?.payload) return null;
            combined += chunkResponse.payload;
          }
          return combined;
        };

        for (const rawKey of keys) {
          if (cancelled) break;
          try {
            const response = await getRemoteDatasetRef.current.mutateAsync({ key: rawKey });
            if (!response?.payload) continue;
            let datasetPayload = response.payload;
            const chunkKeys = parseChunkPointerPayload(response.payload);

            if (chunkKeys) {
              loadedChunkKeys[rawKey] = chunkKeys;
              const chunkedPayload = await loadChunkedPayload(chunkKeys);
              if (!chunkedPayload) continue;
              datasetPayload = chunkedPayload;
            }

            const deserializedDataset = deserializeRemoteDatasetPayload(datasetPayload);
            if (!deserializedDataset) continue;
            loadedDatasets[rawKey] = deserializedDataset;
            loadedSignatures[rawKey] = `${deserializedDataset.fileName}|${deserializedDataset.uploadedAt.toISOString()}|${deserializedDataset.rows.length}|${deserializedDataset.sources?.length ?? 0}`;
          } catch {
            // Keep going; partial data is better than none.
          }
        }

        return { loadedDatasets, loadedSignatures, loadedChunkKeys };
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

        if (keysToLoad.size === 0) {
          try {
            const manifestResponse = await getRemoteDatasetRef.current.mutateAsync({ key: REMOTE_DATASET_KEY_MANIFEST });
            if (manifestResponse?.payload) {
              parseDatasetKeyManifestPayload(manifestResponse.payload).forEach((key) => keysToLoad.add(key));
            }
          } catch {
            // Optional fallback key; ignore errors.
          }
        }

        const { loadedDatasets, loadedSignatures, loadedChunkKeys } = await loadRemoteDatasets(Array.from(keysToLoad));

        let loadedCloudLogs: DashboardLogEntry[] = [];
        try {
          const logsResponse = await getRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY });
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
                const chunkResponse = await getRemoteDatasetRef.current
                  .mutateAsync({ key: chunkKey })
                  .catch(() => null);
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
          }
          remoteDatasetSignatureRef.current = loadedSignatures;
          remoteDatasetChunkKeysRef.current = loadedChunkKeys;
          if (loadedCloudLogs.length > 0) {
            setLogEntries(loadedCloudLogs);
          } else if (stateLogs.length > 0) {
            setLogEntries((current) => (current.length >= stateLogs.length ? current : stateLogs));
          }
          setStorageNotice(null);
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
    remoteDashboardStateQuery.data,
    remoteDashboardStateQuery.status,
  ]);

  useEffect(() => {
    const flushLocalPersistence = () => {
      if (remoteStatusRef.current === "pending") return;
      if (!datasetsHydratedRef.current || !remoteStateHydratedRef.current) return;

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
    if (remoteDashboardStateQuery.status === "pending") return;
    if (!datasetsHydrated || !remoteStateHydrated) return;

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

        for (const key of Object.keys(DATASET_DEFINITIONS) as DatasetKey[]) {
          const dataset = datasets[key];
          if (!dataset) {
            if (!remoteDatasetSignatureRef.current[key]) continue;
            const previousChunkKeys = remoteDatasetChunkKeysRef.current[key] ?? [];
            try {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key, payload: "" }));
              for (const chunkKey of previousChunkKeys) {
                await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
              }
              delete remoteDatasetSignatureRef.current[key];
              delete remoteDatasetChunkKeysRef.current[key];
            } catch {
              setStorageNotice(`Could not clear ${DATASET_DEFINITIONS[key].label} dataset from cloud storage.`);
              return;
            }
            continue;
          }
          const signature = `${dataset.fileName}|${dataset.uploadedAt.toISOString()}|${dataset.rows.length}|${dataset.sources?.length ?? 0}`;
          nextSignatures[key] = signature;

          if (remoteDatasetSignatureRef.current[key] === signature) continue;

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

            remoteDatasetSignatureRef.current[key] = signature;
          } catch {
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
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    datasets,
    datasetsHydrated,
    remoteDashboardStateQuery.status,
    remoteStateHydrated,
  ]);

  useEffect(() => {
    if (!datasetsHydrated || !remoteStateHydrated) return;
    if (remoteDashboardStateQuery.status !== "success") return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSignature = buildLogSyncSignature(logEntries);
        if (remoteLogsSignatureRef.current === nextSignature) return;

        const previousChunkKeys = remoteLogsChunkKeysRef.current ?? [];
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
        const chunks = splitTextIntoChunks(payload, REMOTE_DATASET_CHUNK_CHAR_LIMIT);

        try {
          if (chunks.length === 1) {
            await withRetry(() =>
              saveRemoteDatasetRef.current.mutateAsync({ key: REMOTE_SNAPSHOT_LOGS_KEY, payload })
            );
            for (const chunkKey of previousChunkKeys) {
              await withRetry(() => saveRemoteDatasetRef.current.mutateAsync({ key: chunkKey, payload: "" }));
            }
            remoteLogsChunkKeysRef.current = [];
          } else {
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
            remoteLogsChunkKeysRef.current = chunkKeys;
          }
          remoteLogsSignatureRef.current = nextSignature;
        } catch {
          setStorageNotice("Could not sync snapshot logs to cloud storage.");
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

  const ownershipStackedChartRows = useMemo(
    () => [
      {
        label: "Reporting",
        notTransferred: summary.ownershipOverview.notTransferredReporting,
        transferred: summary.ownershipOverview.transferredReporting,
      },
      {
        label: "Not Reporting",
        notTransferred: summary.ownershipOverview.notTransferredNotReporting,
        transferred: summary.ownershipOverview.transferredNotReporting,
      },
      {
        label: "Terminated",
        notTransferred: summary.ownershipOverview.terminatedTotal,
        transferred: 0,
      },
    ],
    [summary.ownershipOverview]
  );

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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-emerald-50/40">
      <div className="container py-6 space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
              <Database className="h-3.5 w-3.5" />
              Solar REC Analytics
            </div>
            <h1 className="text-2xl font-semibold text-slate-900">CSV-Updatable Portfolio Dashboard</h1>
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
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Datasets Loaded</p>
                <p className="text-lg font-semibold text-slate-900">
                  {formatNumber(dataHealthSummary.loadedDatasetCount)} / {formatNumber(dataHealthSummary.totalDatasetCount)}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Rows Loaded</p>
                <p className="text-lg font-semibold text-slate-900">{formatNumber(dataHealthSummary.totalRowsLoaded)}</p>
              </div>
              <div
                className={`rounded-md border px-3 py-2 ${
                  dataHealthSummary.missingRequiredCount > 0
                    ? "border-amber-300 bg-amber-50"
                    : "border-emerald-300 bg-emerald-50"
                }`}
              >
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Missing Required</p>
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
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Stale Uploads (&gt;14d)</p>
                <p
                  className={`text-lg font-semibold ${
                    dataHealthSummary.staleDatasetCount > 0 ? "text-amber-900" : "text-emerald-800"
                  }`}
                >
                  {formatNumber(dataHealthSummary.staleDatasetCount)}
                </p>
              </div>
              <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Part II Filter QA</p>
                <p className="text-sm font-semibold text-slate-900">
                  {formatNumber(part2FilterAudit.scopedSystems)} / {formatNumber(part2FilterAudit.part2UniqueSystems)} systems mapped
                </p>
                <p className="mt-1 text-[11px] text-slate-700">
                  Coverage: {formatPercent(part2FilterAudit.scopedCoveragePercent)}
                </p>
                <p className="text-[11px] text-slate-700">
                  Rows: {formatNumber(part2FilterAudit.part2Rows)} Part II, {formatNumber(part2FilterAudit.excludedRows)} excluded
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 xl:col-span-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Cloud Sync</p>
                <p className="text-sm font-semibold text-slate-900">{dataHealthSummary.syncStatus}</p>
                {dataHealthSummary.staleDatasetLabels.length > 0 ? (
                  <p className="mt-1 text-[11px] text-amber-800">
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

        <Tabs value={activeTab} onValueChange={setActiveTab}>
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
          </TabsList>

          <TabsContent value="overview" className="space-y-4 mt-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
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
                  <CardDescription>Distribution of transferred vs not transferred systems.</CardDescription>
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
                  Part II verified systems only.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-xs font-semibold text-emerald-800">Reporting</p>
                    <p className="text-2xl font-semibold text-emerald-900">
                      {formatNumber(summary.ownershipOverview.reportingOwnershipTotal)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-semibold text-amber-800">Not Reporting</p>
                    <p className="text-2xl font-semibold text-amber-900">
                      {formatNumber(summary.ownershipOverview.notReportingOwnershipTotal)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold text-slate-700">Terminated</p>
                    <p className="text-2xl font-semibold text-slate-900">
                      {formatNumber(summary.ownershipOverview.terminatedTotal)}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Change of Ownership</p>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-emerald-300 bg-emerald-100 p-3">
                    <p className="text-xs font-semibold text-emerald-900">Ownership Changed, Transferred and Reporting</p>
                    <p className="text-2xl font-semibold text-emerald-950">
                      {formatNumber(
                        changeOwnershipSummary.counts.find((item) => item.status === "Transferred and Reporting")
                          ?.count ?? 0
                      )}
                    </p>
                  </div>
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3">
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
                  </div>
                  <div className="rounded-lg border border-amber-300 bg-amber-100 p-3">
                    <p className="text-xs font-semibold text-amber-800">Ownership Changed, Transferred but not Reporting</p>
                    <p className="text-2xl font-semibold text-amber-900">
                      {formatNumber(
                        changeOwnershipSummary.counts.find((item) => item.status === "Transferred and Not Reporting")
                          ?.count ?? 0
                      )}
                    </p>
                  </div>
                  <div className="rounded-lg border border-rose-300 bg-rose-100 p-3">
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
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="size" className="space-y-4 mt-4">
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
          </TabsContent>

		          <TabsContent value="value" className="space-y-4 mt-4">
		            <div className="grid gap-4 md:grid-cols-4">
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
          </TabsContent>

	          <TabsContent value="contracts" className="space-y-4 mt-4">
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
          </TabsContent>

          <TabsContent value="annual-review" className="space-y-4 mt-4">
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
          </TabsContent>

          <TabsContent value="performance-eval" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">3-Year Rolling Average Annual Report Logic</CardTitle>
                <CardDescription>
                  Mirrors the REC Performance Evaluation model: rolling average by system, expected delivery, surplus
                  allocation, and drawdown payments.
                </CardDescription>
              </CardHeader>
            </Card>

            {performanceContractOptions.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">No Performance Data Available</CardTitle>
                  <CardDescription>
                    Upload ABP Report, Solar Applications, and REC Delivery Schedules to calculate performance
                    evaluation metrics.
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
                      <CardTitle className="text-2xl">{effectivePerformanceContractId || "N/A"}</CardTitle>
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
                    <CardTitle className="text-base">Results by System</CardTitle>
                    <CardDescription>
                      Columns follow the REC Performance Evaluation workbook structure.
                    </CardDescription>
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
                          <TableHead>Batch ID</TableHead>
                          <TableHead>System</TableHead>
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
                            <TableCell>{row.batchId}</TableCell>
                            <TableCell className="font-medium">{row.systemName}</TableCell>
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
          </TabsContent>

          <TabsContent value="change-ownership" className="space-y-4 mt-4">
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
                <CardTitle className="text-base">Flagged Systems Detail</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
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
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ownership" className="space-y-4 mt-4">
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
          </TabsContent>

          <TabsContent value="offline-monitoring" className="space-y-4 mt-4">
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
                <CardTitle className="text-base">Offline Systems Detail</CardTitle>
                <CardDescription>Filterable and sortable list of non-reporting systems.</CardDescription>
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
                      placeholder="System, IDs, method, platform, installer..."
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
                      <TableHead>Installer</TableHead>
                      <TableHead>Last Reporting Date</TableHead>
                      <TableHead>Contract Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleOfflineDetailRows.map((system) => (
                      <TableRow key={system.key}>
                        <TableCell className="font-medium">{system.systemName}</TableCell>
                        <TableCell>{system.systemId ?? "N/A"}</TableCell>
                        <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                        <TableCell>{system.monitoringType}</TableCell>
                        <TableCell>{system.monitoringPlatform}</TableCell>
                        <TableCell>{system.installerName}</TableCell>
                        <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                        <TableCell>{formatCurrency(system.contractedValue)}</TableCell>
                      </TableRow>
                    ))}
                    {visibleOfflineDetailRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-6 text-center text-slate-500">
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
          </TabsContent>

          <TabsContent value="meter-reads" className="space-y-4 mt-4">
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
          </TabsContent>

          <TabsContent value="performance-ratio" className="space-y-4 mt-4">
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
          </TabsContent>

          <TabsContent value="snapshot-log" className="space-y-4 mt-4">
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
          </TabsContent>
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
            </div>
          </CardHeader>
          {uploadsExpanded ? (
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).map((key) => {
                const config = DATASET_DEFINITIONS[key];
                const dataset = datasets[key];
                const error = uploadErrors[key];
                const isMultiAppend = MULTI_APPEND_DATASET_KEYS.has(key);

                return (
                  <div key={key} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-slate-900">{config.label}</p>
                      <p className="text-xs text-slate-600">{config.description}</p>
                    </div>

                    {dataset ? (
                      <div className="space-y-2">
                        <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800">
                          {dataset.rows.length} rows loaded
                        </Badge>
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
                                  className="text-[11px] text-slate-600"
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

                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        <Upload className="h-4 w-4" />
                        {isMultiAppend ? "Add CSV(s)" : "Choose CSV"}
                        <input
                          type="file"
                          accept=".csv,text/csv"
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
                    </div>
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
      </div>
    </div>
  );
}
