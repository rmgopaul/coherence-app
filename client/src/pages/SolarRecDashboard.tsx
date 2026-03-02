import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Database, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
};

type SystemBuilder = {
  key: string;
  systemId: string | null;
  trackingSystemRefId: string | null;
  primaryName: string | null;
  names: Set<string>;
  installedKwAc: number | null;
  recPrice: number | null;
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
};

type SystemRecord = {
  key: string;
  systemId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: number | null;
  sizeBucket: SizeBucket;
  recPrice: number | null;
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
        } satisfies SystemRecord;
      })
      .filter((system) => {
        const bySystemId = system.systemId ? eligibleAbpSystemIds.has(system.systemId) : false;
        const byTrackingId = system.trackingSystemRefId
          ? eligibleAbpTrackingIds.has(system.trackingSystemRefId)
          : false;
        const byName = eligibleAbpNames.has(system.systemName.toLowerCase());
        return bySystemId || byTrackingId || byName;
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
    };

    setLogEntries((previous) => [entry, ...previous].slice(0, 500));
  };

  const clearLogs = () => {
    setLogEntries([]);
  };

  const snapshotLogColumns = useMemo(() => logEntries.slice(0, 12), [logEntries]);

  const snapshotMetricRows = useMemo(
    () => [
      { label: "Part II Verified ABP Customers", value: (entry: DashboardLogEntry) => formatNumber(entry.totalSystems) },
      {
        label: "Quantity Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatNumber(entry.reportingSystems),
      },
      {
        label: "Percentage Reporting to GATS",
        value: (entry: DashboardLogEntry) => formatPercent(entry.reportingPercent),
      },
      {
        label: "Quantity Change of Ownership",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changeOwnershipSystems),
      },
      {
        label: "Percentage Change of Ownership",
        value: (entry: DashboardLogEntry) => formatPercent(entry.changeOwnershipPercent),
      },
      {
        label: "IL ABP - Terminated",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.terminatedReporting + entry.terminatedNotReporting),
      },
      {
        label: "IL ABP - Transferred",
        value: (entry: DashboardLogEntry) =>
          formatNumber(entry.transferredReporting + entry.transferredNotReporting),
      },
      {
        label: "Transferred and Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.transferredReporting),
      },
      {
        label: "Transferred and Not Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.transferredNotReporting),
      },
      {
        label: "Terminated and Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.terminatedReporting),
      },
      {
        label: "Terminated and Not Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.terminatedNotReporting),
      },
      {
        label: "COO - Not Transferred and Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changedNotTransferredReporting),
      },
      {
        label: "COO - Not Transferred and Not Reporting",
        value: (entry: DashboardLogEntry) => formatNumber(entry.changedNotTransferredNotReporting),
      },
      {
        label: "Total Contract Value",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalContractedValue),
      },
      {
        label: "Total Contract Value Reporting",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.contractedValueReporting),
      },
      {
        label: "Total Contract Value Not Reporting",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.contractedValueNotReporting),
      },
      {
        label: "Percent Contract Value Reporting",
        value: (entry: DashboardLogEntry) => formatPercent(entry.contractedValueReportingPercent),
      },
      {
        label: "Total Delivered Value",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalDeliveredValue),
      },
      {
        label: "Total Value Gap",
        value: (entry: DashboardLogEntry) => formatCurrency(entry.totalGap),
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
          <TabsList className="grid w-full grid-cols-7 h-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="size">Size + Reporting</TabsTrigger>
            <TabsTrigger value="value">REC Value</TabsTrigger>
            <TabsTrigger value="contracts">Utility Contracts</TabsTrigger>
            <TabsTrigger value="change-ownership">Change of Ownership</TabsTrigger>
            <TabsTrigger value="ownership">Ownership Status</TabsTrigger>
            <TabsTrigger value="snapshot-log">Snapshot Log</TabsTrigger>
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
                        <TableCell>{formatCurrency(system.contractedValue)}</TableCell>
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

          <TabsContent value="snapshot-log" className="space-y-4 mt-4">
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
                      {snapshotMetricRows.map((metric) => (
                        <TableRow key={metric.label}>
                          <TableCell className="font-medium">{metric.label}</TableCell>
                          {snapshotLogColumns.map((entry) => (
                            <TableCell key={`${entry.id}-${metric.label}`}>{metric.value(entry)}</TableCell>
                          ))}
                        </TableRow>
                      ))}
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
