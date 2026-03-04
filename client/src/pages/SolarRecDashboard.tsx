import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Database, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  | "contractedDate";

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
    systemName: string;
    status: ChangeOwnershipStatus;
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
  trackingSystemRefId: string | null;
  primaryName: string | null;
  names: Set<string>;
  installedKwAc: number | null;
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
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: number | null;
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
    description: "Monthly generation ledger used for reporting recency.",
    requiredHeaderSets: [["Month of Generation", "GATS Gen ID", "Facility Name"]],
  },
  contractedDate: {
    label: "Contracted Date",
    description: "Optional mapping from `system_id` to contracted date.",
    requiredHeaderSets: [["id", "contracted"]],
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

const LEGACY_DATASETS_STORAGE_KEY = "solarRecDashboardDatasetsV1";
const LOGS_STORAGE_KEY = "solarRecDashboardLogsV1";
const DASHBOARD_DB_NAME = "solarRecDashboardDb";
const DASHBOARD_DB_VERSION = 1;
const DASHBOARD_DATASETS_STORE = "datasets";
const DASHBOARD_DATASETS_RECORD_KEY = "activeDatasets";

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

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

function formatCurrency(value: number | null): string {
  if (value === null) return "N/A";
  return CURRENCY_FORMATTER.format(value);
}

function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return "N/A";
  if (digits > 0) return value.toFixed(digits);
  return NUMBER_FORMATTER.format(value);
}

function toPercentValue(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(1)}%`;
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

function deserializeDatasets(
  parsed: Record<string, { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined>
): Partial<Record<DatasetKey, CsvDataset>> {
  const loaded: Partial<Record<DatasetKey, CsvDataset>> = {};
  (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
    const dataset = parsed[key];
    if (!dataset) return;
    const uploadedAt = new Date(dataset.uploadedAt);
    if (Number.isNaN(uploadedAt.getTime())) return;
    loaded[key] = {
      fileName: dataset.fileName,
      uploadedAt,
      headers: Array.isArray(dataset.headers) ? dataset.headers : [],
      rows: Array.isArray(dataset.rows) ? dataset.rows : [],
    };
  });
  return loaded;
}

function serializeDatasets(
  datasets: Partial<Record<DatasetKey, CsvDataset>>
): Record<string, { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined> {
  const serialized: Record<
    string,
    { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined
  > = {};
  (Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).forEach((key) => {
    const dataset = datasets[key];
    if (!dataset) return;
    serialized[key] = {
      fileName: dataset.fileName,
      uploadedAt: dataset.uploadedAt.toISOString(),
      headers: dataset.headers,
      rows: dataset.rows,
    };
  });
  return serialized;
}

function loadLegacyDatasetsFromLocalStorage(): Partial<Record<DatasetKey, CsvDataset>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LEGACY_DATASETS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<
      string,
      { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined
    >;
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

async function loadDatasetsFromStorage(): Promise<Partial<Record<DatasetKey, CsvDataset>>> {
  if (typeof window === "undefined") return {};

  if (!("indexedDB" in window)) {
    return loadLegacyDatasetsFromLocalStorage();
  }

  try {
    const db = await openDashboardDatabase();
    const stored = await new Promise<
      Record<string, { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined> | undefined
    >((resolve, reject) => {
      const transaction = db.transaction(DASHBOARD_DATASETS_STORE, "readonly");
      const store = transaction.objectStore(DASHBOARD_DATASETS_STORE);
      const request = store.get(DASHBOARD_DATASETS_RECORD_KEY);

      request.onsuccess = () => {
        const result = request.result as
          | Record<string, { fileName: string; uploadedAt: string; headers: string[]; rows: CsvRow[] } | undefined>
          | undefined;
        resolve(result);
      };
      request.onerror = () => reject(request.error ?? new Error("Failed reading datasets from IndexedDB."));
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => db.close();
      transaction.onerror = () => db.close();
    });

    if (stored) return deserializeDatasets(stored);

    const legacy = loadLegacyDatasetsFromLocalStorage();
    if (Object.keys(legacy).length > 0) {
      await saveDatasetsToStorage(legacy);
      globalThis.localStorage.removeItem(LEGACY_DATASETS_STORAGE_KEY);
      return legacy;
    }

    return {};
  } catch {
    return loadLegacyDatasetsFromLocalStorage();
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
    const payload = serializeDatasets(datasets);
    const request = store.put(payload, DASHBOARD_DATASETS_RECORD_KEY);

    request.onerror = () => reject(request.error ?? new Error("Failed saving datasets to IndexedDB."));
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

function loadPersistedLogs(): DashboardLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOGS_STORAGE_KEY);
    if (!raw) return [];
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
      cooStatuses?: Array<{ key: string; systemName: string; status: ChangeOwnershipStatus }>;
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
        const cooStatuses = (entry.cooStatuses ?? []).filter((item): item is {
          key: string;
          systemName: string;
          status: ChangeOwnershipStatus;
        } => {
          if (!item || typeof item.key !== "string") return false;
          if (typeof item.systemName !== "string") return false;
          if (typeof item.status !== "string") return false;
          return CHANGE_OWNERSHIP_ORDER.includes(item.status as ChangeOwnershipStatus);
        });
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
        };
      })
      .filter((entry): entry is DashboardLogEntry => entry !== null);
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

  const handleUpload = async (key: DatasetKey, file: File | null) => {
    if (!file) return;

    const config = DATASET_DEFINITIONS[key];

    try {
      const raw = await file.text();
      const parsed = parseCsv(raw);
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
        [key]: {
          fileName: file.name,
          uploadedAt: new Date(),
          headers: parsed.headers,
          rows: parsed.rows,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error while reading CSV.";
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

  const abpEligibleTotalSystems = useMemo(() => {
    const abpReportRows = datasets.abpReport?.rows ?? [];
    const uniqueEligibleKeys = new Set<string>();

    abpReportRows.forEach((row, index) => {
      const part2VerifiedDateRaw =
        clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      if (!part2VerifiedDateRaw || part2VerifiedDateRaw.toLowerCase() === "null") return;
      if (!parseDate(part2VerifiedDateRaw)) return;

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
  }, [datasets.abpReport]);

  const abpEligibleTrackingIdsStrict = useMemo(() => {
    const ids = new Set<string>();
    (datasets.abpReport?.rows ?? []).forEach((row) => {
      const part2VerifiedDateRaw =
        clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      if (!part2VerifiedDateRaw || part2VerifiedDateRaw.toLowerCase() === "null") return;
      if (!parseDate(part2VerifiedDateRaw)) return;
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      if (trackingId) ids.add(trackingId);
    });
    return ids;
  }, [datasets.abpReport]);

  const systems = useMemo<SystemRecord[]>(() => {
    const abpReportRows = datasets.abpReport?.rows ?? [];
    const eligibleAbpSystemIds = new Set<string>();
    const eligibleAbpTrackingIds = new Set<string>();
    const eligibleAbpNames = new Set<string>();

    abpReportRows.forEach((row) => {
      const part2VerifiedDateRaw =
        clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      if (!part2VerifiedDateRaw || part2VerifiedDateRaw.toLowerCase() === "null") return;
      if (!parseDate(part2VerifiedDateRaw)) return;

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
        trackingSystemRefId: trackingSystemRefId || null,
        primaryName: null,
        names: new Set<string>(),
        installedKwAc: null,
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
      const trackingSystemRefId =
        clean(row.tracking_system_ref_id) ||
        clean(row.reporting_entity_ref_id) ||
        clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
        null;
      const builder = ensureBuilder(trackingSystemRefId, systemId);

      if (systemId) builder.systemId = systemId;
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
        const normalizedContractType = contractType.toLowerCase();
        if (normalizedContractType.includes("il abp - transferred")) {
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

        const contractTypeNormalized = clean(builder.contractType).toLowerCase();
        const isContractTransferred = contractTypeNormalized.includes("il abp - transferred");
        const isContractTerminated = contractTypeNormalized.includes("il abp - terminated");
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
          if (contractTypeNormalized.includes("il abp - transferred")) {
            changeOwnershipStatus = isReporting ? "Transferred and Reporting" : "Transferred and Not Reporting";
          } else if (contractTypeNormalized.includes("il abp - terminated")) {
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
          trackingSystemRefId: builder.trackingSystemRefId,
          systemName,
          installedKwAc: builder.installedKwAc,
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
  }, [datasets]);

  const summary = useMemo(() => {
    const totalSystems = abpEligibleTotalSystems;
    const reportingSystems = systems.filter((system) => system.isReporting).length;
    const reportingPercent = toPercentValue(reportingSystems, totalSystems);
    const smallSystems = systems.filter((system) => system.sizeBucket === "<=10 kW AC").length;
    const largeSystems = systems.filter((system) => system.sizeBucket === ">10 kW AC").length;
    const unknownSizeSystems = systems.filter((system) => system.sizeBucket === "Unknown").length;

    const ownershipCounts = OWNERSHIP_ORDER.map((status) => ({
      status,
      count: systems.filter((system) => system.ownershipStatus === status).length,
      percent: toPercentValue(
        systems.filter((system) => system.ownershipStatus === status).length,
        totalSystems
      ),
    }));

    const withValueData = systems.filter(
      (system) => system.contractedValue !== null && system.deliveredValue !== null
    );
    const totalContractedValue = withValueData.reduce((sum, system) => sum + (system.contractedValue ?? 0), 0);
    const totalDeliveredValue = withValueData.reduce((sum, system) => sum + (system.deliveredValue ?? 0), 0);
    const contractedValueReporting = withValueData
      .filter((system) => system.isReporting)
      .reduce((sum, system) => sum + (system.contractedValue ?? 0), 0);
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
      ownershipCounts,
      withValueDataCount: withValueData.length,
      totalContractedValue,
      totalDeliveredValue,
      totalGap: totalContractedValue - totalDeliveredValue,
      contractedValueReporting,
      contractedValueNotReporting,
      contractedValueReportingPercent,
      deliveredValuePercent,
    };
  }, [abpEligibleTotalSystems, systems]);

  const sizeBreakdownRows = useMemo(() => {
    const breakdown = ["<=10 kW AC", ">10 kW AC", "Unknown"] as SizeBucket[];
    return breakdown.map((bucket) => {
      const scoped = systems.filter((system) => system.sizeBucket === bucket);
      const reporting = scoped.filter((system) => system.isReporting).length;
      const notReporting = scoped.length - reporting;
      const reportingPercent = toPercentValue(reporting, scoped.length);
      const contractedValue = scoped.reduce((sum, system) => sum + (system.contractedValue ?? 0), 0);
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
  }, [systems]);

  const recValueRows = useMemo(
    () =>
      systems
        .filter((system) => system.contractedValue !== null || system.deliveredValue !== null)
        .sort((a, b) => Math.abs((b.valueGap ?? 0) - (a.valueGap ?? 0))),
    [systems]
  );

  const filteredOwnershipRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return systems.filter((system) => {
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
  }, [ownershipFilter, searchTerm, systems]);

  const changeOwnershipRows = useMemo(
    () => systems.filter((system) => system.hasChangedOwnership && system.changeOwnershipStatus !== null),
    [systems]
  );

  const changeOwnershipSummary = useMemo(() => {
    const total = changeOwnershipRows.length;
    const reporting = changeOwnershipRows.filter((system) => system.isReporting).length;
    const notReporting = total - reporting;
    const reportingPercent = toPercentValue(reporting, total);
    const contractedValueTotal = changeOwnershipRows.reduce(
      (sum, system) => sum + (system.contractedValue ?? 0),
      0
    );
    const contractedValueReporting = changeOwnershipRows
      .filter((system) => system.isReporting)
      .reduce((sum, system) => sum + (system.contractedValue ?? 0), 0);
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
    () =>
      systems.filter(
        (system) =>
          !!system.trackingSystemRefId &&
          abpEligibleTrackingIdsStrict.has(system.trackingSystemRefId)
      ),
    [abpEligibleTrackingIdsStrict, systems]
  );

  const offlineSystems = useMemo(
    () => offlineBaseSystems.filter((system) => !system.isReporting),
    [offlineBaseSystems]
  );

  const offlineMonitoringOptions = useMemo(
    () =>
      Array.from(new Set(offlineBaseSystems.map((system) => system.monitoringType || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      ),
    [offlineBaseSystems]
  );

  const offlinePlatformOptions = useMemo(
    () =>
      Array.from(new Set(offlineBaseSystems.map((system) => system.monitoringPlatform || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      ),
    [offlineBaseSystems]
  );

  const offlineInstallerOptions = useMemo(
    () =>
      Array.from(new Set(offlineBaseSystems.map((system) => system.installerName || "Unknown"))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
      ),
    [offlineBaseSystems]
  );

  const offlineMonitoringBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
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
  }, [offlineMonitoringSortBy, offlineMonitoringSortDir, offlineBaseSystems]);

  const offlineInstallerBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
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
  }, [offlineInstallerSortBy, offlineInstallerSortDir, offlineBaseSystems]);

  const offlinePlatformBreakdownRows = useMemo<OfflineBreakdownRow[]>(() => {
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
  }, [offlinePlatformSortBy, offlinePlatformSortDir, offlineBaseSystems]);

  const filteredOfflineSystems = useMemo(() => {
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
    offlineDetailSortBy,
    offlineDetailSortDir,
    offlineInstallerFilter,
    offlineMonitoringFilter,
    offlinePlatformFilter,
    offlineSearch,
    offlineSystems,
  ]);

  const offlineSummary = useMemo(() => {
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
    offlineInstallerBreakdownRows.length,
    offlineMonitoringBreakdownRows.length,
    offlinePlatformBreakdownRows.length,
    offlineBaseSystems,
    offlineSystems,
  ]);

  const abpApplicationIdBySystemKey = useMemo(() => {
    const mapping = new Map<string, string>();
    (datasets.abpReport?.rows ?? []).forEach((row) => {
      const part2VerifiedDateRaw =
        clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
      if (!part2VerifiedDateRaw || part2VerifiedDateRaw.toLowerCase() === "null") return;
      if (!parseDate(part2VerifiedDateRaw)) return;

      const abpApplicationId = clean(row.Application_ID) || clean(row.system_id);
      const trackingId = clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
      const projectName = clean(row.Project_Name) || clean(row.system_name);

      if (abpApplicationId) mapping.set(`id:${abpApplicationId}`, abpApplicationId);
      if (trackingId && abpApplicationId) mapping.set(`tracking:${trackingId}`, abpApplicationId);
      if (projectName && abpApplicationId) mapping.set(`name:${projectName.toLowerCase()}`, abpApplicationId);
    });
    return mapping;
  }, [datasets.abpReport]);

  const monitoringDetailsBySystemKey = useMemo(() => {
    const mapping = new Map<
      string,
      {
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
      }
    >();

    const mergeDetails = (
      key: string,
      detail: {
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
      }
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
        const monitoringDetails =
          (keyById ? monitoringDetailsBySystemKey.get(keyById) : undefined) ??
          (keyByTracking ? monitoringDetailsBySystemKey.get(keyByTracking) : undefined) ??
          monitoringDetailsBySystemKey.get(keyByName);

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

  const recPriceByTrackingId = useMemo(() => {
    const mapping = new Map<string, number>();
    systems.forEach((system) => {
      if (!system.trackingSystemRefId || system.recPrice === null) return;
      mapping.set(system.trackingSystemRefId, system.recPrice);
    });
    return mapping;
  }, [systems]);

  const eligibleTrackingIds = useMemo(() => {
    const ids = new Set<string>();
    systems.forEach((system) => {
      if (!system.trackingSystemRefId) return;
      ids.add(system.trackingSystemRefId);
    });
    return ids;
  }, [systems]);

  const systemsByTrackingId = useMemo(() => {
    const mapping = new Map<string, SystemRecord>();
    systems.forEach((system) => {
      if (!system.trackingSystemRefId) return;
      mapping.set(system.trackingSystemRefId, system);
    });
    return mapping;
  }, [systems]);

  const performanceSourceRows = useMemo<PerformanceSourceRow[]>(() => {
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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, systemsByTrackingId]);

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
  }, [effectivePerformanceContractId, performanceSourceRows]);

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
    performancePreviousDrawdown,
    performancePreviousSurplus,
    performanceSourceRows,
  ]);

  const annualContractVintageRows = useMemo<AnnualContractVintageAggregate[]>(() => {
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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, recPriceByTrackingId, systemsByTrackingId]);

  const annualVintageRows = useMemo<AnnualVintageAggregate[]>(() => {
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
  }, [annualContractVintageRows]);

  const annualContractSummaryRows = useMemo(() => {
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
  }, [annualContractVintageRows]);

  const annualPortfolioSummary = useMemo(() => {
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
  }, [annualVintageRows]);

  const contractDeliveryRows = useMemo<ContractDeliveryAggregate[]>(() => {
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
  }, [datasets.recDeliverySchedules, eligibleTrackingIds, recPriceByTrackingId]);

  const contractSummaryRows = useMemo(() => {
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
  }, [contractDeliveryRows]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadDatasetsFromStorage();
        if (cancelled) return;
        setDatasets((current) => (Object.keys(current).length > 0 ? current : loaded));
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
    if (!datasetsHydrated) return;
    let cancelled = false;
    void (async () => {
      try {
        await saveDatasetsToStorage(datasets);
        if (cancelled) return;
        setStorageNotice(null);
      } catch {
        if (cancelled) return;
        setStorageNotice("Could not save uploaded file data in browser storage.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [datasets, datasetsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const serialized = logEntries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
        datasets: entry.datasets.map((dataset) => ({
          ...dataset,
          updatedAt: dataset.updatedAt.toISOString(),
        })),
      }));
      window.localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(serialized));
      setStorageNotice(null);
    } catch {
      setStorageNotice("Could not save dashboard log history in browser storage (storage may be full).");
    }
  }, [logEntries]);

  const createLogEntry = () => {
    const statusCount = (status: ChangeOwnershipStatus) =>
      changeOwnershipRows.filter((system) => system.changeOwnershipStatus === status).length;
    const snapshotCooStatuses = changeOwnershipRows
      .map((system) => {
        if (!system.changeOwnershipStatus) return null;
        return {
          key: buildSystemSnapshotKey(system),
          systemName: system.systemName,
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
      terminatedReporting: statusCount("Terminated and Reporting"),
      terminatedNotReporting: statusCount("Terminated and Not Reporting"),
      changedNotTransferredReporting: statusCount("Change of Ownership - Not Transferred and Reporting"),
      changedNotTransferredNotReporting: statusCount("Change of Ownership - Not Transferred and Not Reporting"),
      totalContractedValue: summary.totalContractedValue,
      totalDeliveredValue: summary.totalDeliveredValue,
      totalGap: summary.totalGap,
      contractedValueReporting: summary.contractedValueReporting,
      contractedValueNotReporting: summary.contractedValueNotReporting,
      contractedValueReportingPercent: summary.contractedValueReportingPercent,
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
    };

    setLogEntries((previous) => [entry, ...previous].slice(0, 500));
  };

  const clearLogs = () => {
    setLogEntries([]);
  };

  const monthlySnapshotTransitions = useMemo(() => {
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

      previous.entry.cooStatuses.forEach((item) => {
        previousMap.set(item.key, item.status);
      });
      current.entry.cooStatuses.forEach((item) => {
        currentMap.set(item.key, item.status);
      });

      const allKeys = new Set<string>([
        ...Array.from(previousMap.keys()),
        ...Array.from(currentMap.keys()),
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

    return transitions.reverse();
  }, [logEntries]);

  const snapshotLogColumns = useMemo(() => logEntries.slice(0, 12), [logEntries]);

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
    ? ([
        "solarApplications",
        "abpReport",
        "recDeliverySchedules",
        "generationEntry",
        "accountSolarGeneration",
      ] as DatasetKey[]).filter((key) => !datasets[key])
    : [];

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
            <Button variant="outline" onClick={clearAll}>
              Clear All Files
            </Button>
          </div>
        </div>

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle className="text-base">Step 1: Import Your CSV Files</CardTitle>
            <CardDescription>
              Upload each export into its matching slot. Files can be replaced later with newer exports.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {(Object.keys(DATASET_DEFINITIONS) as DatasetKey[]).map((key) => {
              const config = DATASET_DEFINITIONS[key];
              const dataset = datasets[key];
              const error = uploadErrors[key];

              return (
                <div key={key} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                  <div className="space-y-1">
                    <p className="font-medium text-sm text-slate-900">{config.label}</p>
                    <p className="text-xs text-slate-600">{config.description}</p>
                  </div>

                  {dataset ? (
                    <div className="space-y-2">
                      <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">
                        {dataset.rows.length} rows loaded
                      </Badge>
                      <p className="text-xs text-slate-600 truncate">{dataset.fileName}</p>
                      <p className="text-xs text-slate-500">Last updated {dataset.uploadedAt.toLocaleString()}</p>
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
                      Choose CSV
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          void handleUpload(key, file);
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
        </Card>

        {missingCoreDatasets.length > 0 ? (
          <Card className="border-amber-200 bg-amber-50/60">
            <CardHeader>
              <CardTitle className="text-base text-amber-900">Missing Required Files</CardTitle>
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

        <Tabs defaultValue="overview">
          <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto whitespace-nowrap">
            <TabsTrigger className="shrink-0" value="overview">Overview</TabsTrigger>
            <TabsTrigger className="shrink-0" value="size">Size + Reporting</TabsTrigger>
            <TabsTrigger className="shrink-0" value="value">REC Value</TabsTrigger>
            <TabsTrigger className="shrink-0" value="contracts">Utility Contracts</TabsTrigger>
            <TabsTrigger className="shrink-0" value="annual-review">Annual REC Review</TabsTrigger>
            <TabsTrigger className="shrink-0" value="performance-eval">REC Performance Eval</TabsTrigger>
            <TabsTrigger className="shrink-0" value="change-ownership">Change of Ownership</TabsTrigger>
            <TabsTrigger className="shrink-0" value="ownership">Ownership Status</TabsTrigger>
            <TabsTrigger className="shrink-0" value="offline-monitoring">Offline by Monitoring</TabsTrigger>
            <TabsTrigger className="shrink-0" value="meter-reads">Meter Reads</TabsTrigger>
            <TabsTrigger className="shrink-0" value="snapshot-log">Snapshot Log</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 mt-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
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
                  <CardDescription>Unknown Size</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.unknownSizeSystems)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Delivered Value %</CardDescription>
                  <CardTitle className="text-2xl">{formatPercent(summary.deliveredValuePercent)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ownership and Reporting Status Counts</CardTitle>
                <CardDescription>
                  These counts map directly to your six required categories.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {summary.ownershipCounts.map((item) => (
                  <div key={item.status} className="rounded-lg border border-slate-200 p-3 bg-white">
                    <p className="text-xs text-slate-500">{item.status}</p>
                    <p className="text-2xl font-semibold text-slate-900">{formatNumber(item.count)}</p>
                    <p className="text-xs text-slate-500">{formatPercent(item.percent)}</p>
                  </div>
                ))}
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
                <CardTitle className="text-base">Systems Not Reporting in Last 3 Months</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>System</TableHead>
                      <TableHead>Tracking ID</TableHead>
                      <TableHead>Size Bucket</TableHead>
                      <TableHead>Last Reporting Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {systems
                      .filter((system) => !system.isReporting)
                      .slice(0, 200)
                      .map((system) => (
                        <TableRow key={system.key}>
                          <TableCell className="font-medium">{system.systemName}</TableCell>
                          <TableCell>{system.trackingSystemRefId ?? "N/A"}</TableCell>
                          <TableCell>{system.sizeBucket}</TableCell>
                          <TableCell>{formatDate(system.latestReportingDate)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="value" className="space-y-4 mt-4">
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader>
                  <CardDescription>Systems with Value Data</CardDescription>
                  <CardTitle className="text-2xl">{formatNumber(summary.withValueDataCount)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Total Contracted Value</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(summary.totalContractedValue)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Value Gap (Contracted - Delivered)</CardDescription>
                  <CardTitle className="text-2xl">{formatCurrency(summary.totalGap)}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader>
                  <CardDescription>Contract Value Reporting %</CardDescription>
                  <CardTitle className="text-2xl">{formatPercent(summary.contractedValueReportingPercent)}</CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">REC Value by System</CardTitle>
                <CardDescription>
                  Compares delivered value vs contracted value at system REC price.
                </CardDescription>
              </CardHeader>
              <CardContent>
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
                    {recValueRows.slice(0, 300).map((system) => (
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
                            toPercentValue(system.deliveredValue ?? 0, system.contractedValue ?? 0)
                          )}
                        </TableCell>
                        <TableCell className={system.valueGap !== null && system.valueGap > 0 ? "text-amber-700" : ""}>
                          {formatCurrency(system.valueGap)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
                <CardTitle className="text-base">Contract Summary</CardTitle>
                <CardDescription>Total required vs delivered by Utility Contract ID.</CardDescription>
              </CardHeader>
              <CardContent>
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
                    {contractSummaryRows.map((row) => (
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
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contract + Delivery Start Date Detail</CardTitle>
                <CardDescription>
                  For matching contract ID and start date, required and delivered values are aggregated.
                </CardDescription>
              </CardHeader>
              <CardContent>
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
                    {contractDeliveryRows.map((row) => (
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
                  </TableBody>
                </Table>
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
              <CardContent>
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
                    {annualContractVintageRows.map((row) => (
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
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Annual Contract Totals</CardTitle>
                <CardDescription>
                  Contract-level annual totals across all start dates.
                </CardDescription>
              </CardHeader>
              <CardContent>
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
                    {annualContractSummaryRows.map((row) => (
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
                  </TableBody>
                </Table>
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
                  <CardContent>
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
                        {recPerformanceEvaluation.rows.map((row) => (
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
                      </TableBody>
                    </Table>
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
            <Card>
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

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
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
              <Card>
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

              <Card>
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

            <Card>
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

            <Card>
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

            <Card>
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
                    {filteredOfflineSystems.slice(0, 1000).map((system) => (
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
                  </TableBody>
                </Table>
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
                          <TableHead key={entry.id}>{entry.createdAt.toLocaleDateString()} {entry.createdAt.toLocaleTimeString()}</TableHead>
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
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
