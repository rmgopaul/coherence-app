import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { clean, toErrorMessage, formatKwh, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, Loader2, PlugZap, RefreshCw, Unplug, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const PERIOD_OPTIONS = ["Total", "Years", "Months", "Days"] as const;
const BULK_BATCH_SIZE_ACTIVE = 200;
const BULK_BATCH_SIZE_ALL_PROFILES = 25;
const BULK_ROWS_RENDER_INTERVAL_ACTIVE = 1;
const BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES = 4;
const BULK_PAGE_SIZE = 25;

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

type Period = (typeof PERIOD_OPTIONS)[number];
type BulkStatusFilter = "All" | "Found" | "Not Found" | "Error";
type BulkDataType = "production" | "devices";
type BulkSortKey =
  | "pvSystemId"
  | "status"
  | "lifetime"
  | "hourly"
  | "monthly"
  | "mtd"
  | "previousMonth"
  | "last12Months"
  | "weekly"
  | "daily"
  | "deviceCount"
  | "inverterCount"
  | "currentPower"
  | "isOnline";
type BulkConnectionScope = "active" | "all";
type DatePreset = "mtd" | "prevMonth" | "last12Months";

type SingleOperation =
  | "listPvSystems"
  | "getDetails"
  | "getDevices"
  | "getAggData"
  | "getFlowData"
  | "getProductionSnapshot";

type BulkSnapshotRow = {
  pvSystemId: string;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh?: number | null;
  hourlyProductionKwh?: number | null;
  monthlyProductionKwh?: number | null;
  mtdProductionKwh?: number | null;
  previousCalendarMonthProductionKwh?: number | null;
  last12MonthsProductionKwh?: number | null;
  weeklyProductionKwh?: number | null;
  dailyProductionKwh?: number | null;
  anchorDate?: string;
  monthlyStartDate?: string;
  weeklyStartDate?: string;
  mtdStartDate?: string;
  previousCalendarMonthStartDate?: string;
  previousCalendarMonthEndDate?: string;
  last12MonthsStartDate?: string;
  deviceCount?: number | null;
  inverterCount?: number | null;
  currentPowerW?: number | null;
  isOnline?: boolean | null;
  error?: string | null;
  matchedConnectionId?: string | null;
  matchedConnectionName?: string | null;
  checkedConnections?: number;
  foundInConnections?: number;
  profileStatusSummary?: string;
};

type CsvRow = Record<string, string>;

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateOnly(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function getPresetRange(preset: DatePreset, now: Date = new Date()): { startDate: string; endDate: string } {
  const today = normalizeDateOnly(now);

  if (preset === "mtd") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return {
      startDate: formatDateInput(start),
      endDate: formatDateInput(today),
    };
  }

  if (preset === "prevMonth") {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return {
      startDate: formatDateInput(start),
      endDate: formatDateInput(end),
    };
  }

  const start = new Date(today);
  start.setFullYear(start.getFullYear() - 1);
  return {
    startDate: formatDateInput(start),
    endDate: formatDateInput(today),
  };
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"') {
      const next = source[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
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
      if (char === "\r" && source[index + 1] === "\n") index += 1;
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

  const headers = matrix[0].map((header, columnIndex) => clean(header) || `column_${columnIndex + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, columnIndex) => {
      record[header] = clean(values[columnIndex]);
    });
    return record;
  });

  return { headers, rows };
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function buildCsv(headers: string[], rows: Array<Record<string, string | number | boolean | null | undefined>>): string {
  const headerLine = headers.map((header) => csvEscape(header)).join(",");
  const bodyLines = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return [headerLine, ...bodyLines].join("\n");
}

function extractPvSystemIdsFromCsv(text: string): string[] {
  const parsed = parseCsv(text);
  const normalizedHeaders = parsed.headers.map((header) => clean(header).toLowerCase().replace(/\s+/g, "_"));

  const preferredIndex = normalizedHeaders.findIndex((header) =>
    ["pvsystemid", "pv_system_id", "system_id", "systemid", "id"].includes(header)
  );

  if (parsed.headers.length === 1 && preferredIndex === -1) {
    const headerValue = clean(parsed.headers[0]);
    const columnValues = parsed.rows.map((row) => clean(row[parsed.headers[0]])).filter(Boolean);
    const combined = headerValue ? [headerValue, ...columnValues] : columnValues;
    return Array.from(new Set(combined));
  }

  if (preferredIndex >= 0) {
    const pvSystemHeader = parsed.headers[preferredIndex];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[pvSystemHeader]))
          .filter((value) => value.length > 0)
      )
    );
  }

  if (parsed.headers.length > 0 && parsed.rows.length > 0) {
    const fallbackHeader = parsed.headers[0];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[fallbackHeader]))
          .filter((value) => value.length > 0)
      )
    );
  }

  if (parsed.headers.length > 0 && parsed.rows.length === 0) {
    return Array.from(new Set(parsed.headers.map((value) => clean(value)).filter(Boolean)));
  }

  return [];
}

function toComparableNumber(value: number | null | undefined): number {
  return value === null || value === undefined ? Number.NEGATIVE_INFINITY : value;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [values];
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    output.push(values.slice(index, index + chunkSize));
  }
  return output;
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export default function FroniusMeterReads() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultFromDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return formatDateInput(date);
  }, []);

  const [accessKeyIdInput, setAccessKeyIdInput] = useState("");
  const [accessKeyValueInput, setAccessKeyValueInput] = useState("");
  const [connectionNameInput, setConnectionNameInput] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedPvSystemId, setSelectedPvSystemId] = useState("");
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(today);
  const [period, setPeriod] = useState<Period>("Days");
  const [selectedOperation, setSelectedOperation] = useState<SingleOperation>("listPvSystems");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const [bulkAnchorDate, setBulkAnchorDate] = useState(today);
  const [bulkPvSystemIds, setBulkPvSystemIds] = useState<string[]>([]);
  const [bulkSourceFileName, setBulkSourceFileName] = useState<string | null>(null);
  const [bulkImportError, setBulkImportError] = useState<string | null>(null);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkDataType, setBulkDataType] = useState<BulkDataType>("production");
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
  const [bulkStatusFilter, setBulkStatusFilter] = useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkSort, setBulkSort] = useState<BulkSortKey>("pvSystemId");
  const [bulkConnectionScope, setBulkConnectionScope] = useState<BulkConnectionScope>("active");
  const [bulkPage, setBulkPage] = useState(1);
  const bulkCancelRef = useRef(false);

  const applyDatePreset = (preset: DatePreset) => {
    const range = getPresetRange(preset);
    setFromDate(range.startDate);
    setToDate(range.endDate);
  };

  const statusQuery = trpc.fronius.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const pvSystemsQuery = trpc.fronius.listPvSystems.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.fronius.connect.useMutation();
  const setActiveConnectionMutation = trpc.fronius.setActiveConnection.useMutation();
  const removeConnectionMutation = trpc.fronius.removeConnection.useMutation();
  const disconnectMutation = trpc.fronius.disconnect.useMutation();
  const pvSystemDetailsMutation = trpc.fronius.getPvSystemDetails.useMutation();
  const devicesMutation = trpc.fronius.getDevices.useMutation();
  const aggDataMutation = trpc.fronius.getAggData.useMutation();
  const flowDataMutation = trpc.fronius.getFlowData.useMutation();
  const productionSnapshotMutation = trpc.fronius.getProductionSnapshot.useMutation();
  const bulkProductionSnapshotsMutation = trpc.fronius.getProductionSnapshots.useMutation();
  const bulkDeviceSnapshotsMutation = trpc.fronius.getDeviceSnapshots.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;

    const availableIds = new Set(statusQuery.data.connections.map((connection) => connection.id));
    if (availableIds.size === 0) {
      setSelectedConnectionId("");
      return;
    }

    setSelectedConnectionId((current) => {
      if (current && availableIds.has(current)) return current;
      return statusQuery.data?.activeConnectionId ?? statusQuery.data.connections[0]?.id ?? "";
    });
  }, [statusQuery.data]);

  useEffect(() => {
    const firstSystem = pvSystemsQuery.data?.pvSystems?.[0];
    if (!firstSystem) return;
    if (!selectedPvSystemId) {
      setSelectedPvSystemId(firstSystem.pvSystemId);
    }
  }, [pvSystemsQuery.data, selectedPvSystemId]);

  useEffect(() => {
    setBulkPage(1);
  }, [bulkRows.length, bulkSearch, bulkSort, bulkStatusFilter, bulkDataType]);

  useEffect(() => {
    setBulkSort("pvSystemId");
  }, [bulkDataType]);

  useEffect(() => {
    setBulkRows([]);
    setBulkProgress({ total: bulkPvSystemIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
  }, [bulkDataType, bulkPvSystemIds.length]);

  const handleConnect = async () => {
    const accessKeyId = accessKeyIdInput.trim();
    const accessKeyValue = accessKeyValueInput.trim();

    if (!accessKeyId || !accessKeyValue) {
      toast.error("Enter both Access Key ID and Access Key Value.");
      return;
    }

    try {
      const response = await connectMutation.mutateAsync({
        accessKeyId,
        accessKeyValue,
        connectionName: connectionNameInput.trim() || undefined,
      });
      await trpcUtils.fronius.getStatus.invalidate();
      await trpcUtils.fronius.listPvSystems.invalidate();
      setSelectedConnectionId(response.activeConnectionId);
      setAccessKeyIdInput("");
      setAccessKeyValueInput("");
      setConnectionNameInput("");
      toast.success(
        `Fronius profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
      );
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleSetActiveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select an API profile first.");
      return;
    }

    try {
      await setActiveConnectionMutation.mutateAsync({ connectionId });
      await trpcUtils.fronius.getStatus.invalidate();
      await trpcUtils.fronius.listPvSystems.invalidate();
      setSelectedPvSystemId("");
      toast.success("Active Fronius API profile updated.");
    } catch (error) {
      toast.error(`Failed to switch profile: ${toErrorMessage(error)}`);
    }
  };

  const handleRemoveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select an API profile first.");
      return;
    }

    try {
      const response = await removeConnectionMutation.mutateAsync({ connectionId });
      await trpcUtils.fronius.getStatus.invalidate();
      await trpcUtils.fronius.listPvSystems.invalidate();
      setSelectedPvSystemId("");
      setSelectedConnectionId(response.activeConnectionId ?? "");
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : "Removed final profile. Fronius is now disconnected."
      );
    } catch (error) {
      toast.error(`Failed to remove profile: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.fronius.getStatus.invalidate();
      await trpcUtils.fronius.listPvSystems.invalidate();
      setSelectedPvSystemId("");
      setSelectedConnectionId("");
      toast.success("Fronius disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${toErrorMessage(error)}`);
    }
  };

  const runAction = async (title: string, action: () => Promise<unknown>) => {
    setIsRunningAction(true);
    try {
      const payload = await action();
      setResultTitle(title);
      setResultText(JSON.stringify(payload, null, 2));
      toast.success(`${title} loaded.`);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsRunningAction(false);
    }
  };

  const handleRunSingleOperation = () => {
    switch (selectedOperation) {
      case "listPvSystems":
        void runAction("List PV Systems", () =>
          pvSystemsQuery.refetch().then((result) => result.data)
        );
        break;
      case "getDetails":
        if (!selectedPvSystemId) {
          toast.error("Enter a PV System ID first.");
          return;
        }
        void runAction("PV System Details", () =>
          pvSystemDetailsMutation.mutateAsync({ pvSystemId: selectedPvSystemId })
        );
        break;
      case "getDevices":
        if (!selectedPvSystemId) {
          toast.error("Enter a PV System ID first.");
          return;
        }
        void runAction("Devices", () =>
          devicesMutation.mutateAsync({ pvSystemId: selectedPvSystemId })
        );
        break;
      case "getAggData":
        if (!selectedPvSystemId) {
          toast.error("Enter a PV System ID first.");
          return;
        }
        void runAction("Aggregated Data", () =>
          aggDataMutation.mutateAsync({
            pvSystemId: selectedPvSystemId,
            from: fromDate,
            to: toDate,
            period,
          })
        );
        break;
      case "getFlowData":
        if (!selectedPvSystemId) {
          toast.error("Enter a PV System ID first.");
          return;
        }
        void runAction("Flow Data", () =>
          flowDataMutation.mutateAsync({ pvSystemId: selectedPvSystemId })
        );
        break;
      case "getProductionSnapshot":
        if (!selectedPvSystemId) {
          toast.error("Enter a PV System ID first.");
          return;
        }
        void runAction("Production Snapshot", () =>
          productionSnapshotMutation.mutateAsync({
            pvSystemId: selectedPvSystemId,
            anchorDate: bulkAnchorDate || undefined,
          })
        );
        break;
    }
  };

  const handleBulkFileUpload = async (file: File | null) => {
    if (!file) return;
    setBulkImportError(null);

    try {
      const raw = await file.text();
      const pvSystemIds = extractPvSystemIdsFromCsv(raw);
      if (pvSystemIds.length === 0) {
        setBulkImportError("No valid PV System IDs found in CSV.");
        setBulkPvSystemIds([]);
        setBulkSourceFileName(file.name);
        return;
      }

      setBulkSourceFileName(file.name);
      setBulkPvSystemIds(pvSystemIds);
      setBulkRows([]);
      setBulkProgress({ total: pvSystemIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(`Imported ${NUMBER_FORMATTER.format(pvSystemIds.length)} PV System IDs.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse CSV.";
      setBulkImportError(message);
      setBulkPvSystemIds([]);
    }
  };

  const runBulkSnapshot = async () => {
    if (!statusQuery.data?.connected) {
      toast.error("Connect Fronius before running bulk processing.");
      return;
    }
    if (bulkPvSystemIds.length === 0) {
      toast.error("Upload a CSV with PV System IDs first.");
      return;
    }

    setBulkIsRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    const effectiveBatchSize =
      bulkConnectionScope === "all" ? BULK_BATCH_SIZE_ALL_PROFILES : BULK_BATCH_SIZE_ACTIVE;
    const rowRenderInterval =
      bulkConnectionScope === "all" ? BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES : BULK_ROWS_RENDER_INTERVAL_ACTIVE;
    const chunks = chunkArray(bulkPvSystemIds, effectiveBatchSize);
    const modeLabel =
      bulkDataType === "production" ? "production snapshots" : "device snapshots";
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;
    const collectedRows: BulkSnapshotRow[] = [];
    setBulkProgress({
      total: bulkPvSystemIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        if (bulkCancelRef.current) break;

        let response: {
          total: number;
          found: number;
          notFound: number;
          errored: number;
          rows: BulkSnapshotRow[];
        };

        if (bulkDataType === "production") {
          const raw = await bulkProductionSnapshotsMutation.mutateAsync({
            pvSystemIds: chunk,
            anchorDate: bulkAnchorDate,
            connectionScope: bulkConnectionScope,
          });
          response = {
            ...raw,
            rows: raw.rows as BulkSnapshotRow[],
          };
        } else {
          const raw = await bulkDeviceSnapshotsMutation.mutateAsync({
            pvSystemIds: chunk,
            connectionScope: bulkConnectionScope,
          });
          response = {
            ...raw,
            rows: raw.rows as BulkSnapshotRow[],
          };
        }

        collectedRows.push(...response.rows);
        processed += response.total;
        found += response.found;
        notFound += response.notFound;
        errored += response.errored;

        setBulkProgress({
          total: bulkPvSystemIds.length,
          processed,
          found,
          notFound,
          errored,
        });

        const shouldRenderRows =
          chunkIndex % rowRenderInterval === 0 || chunkIndex === chunks.length - 1 || bulkCancelRef.current;
        if (shouldRenderRows) {
          setBulkRows([...collectedRows]);
        }

        // Yield back to the browser so progress UI can paint between batch requests.
        await waitForNextFrame();
      }

      if (bulkCancelRef.current) {
        toast.message(
          `Stopped ${modeLabel} after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkPvSystemIds.length)} PV System IDs.`
        );
      } else {
        toast.success(
          `Completed ${modeLabel} for ${NUMBER_FORMATTER.format(processed)} PV System IDs using ${bulkConnectionScope === "all" ? "all saved API profiles" : "active API profile"}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );
      }
    } catch (error) {
      toast.error(`Bulk ${modeLabel} failed: ${toErrorMessage(error)}`);
    } finally {
      setBulkIsRunning(false);
    }
  };

  const filteredBulkRows = useMemo(() => {
    const normalizedSearch = bulkSearch.trim().toLowerCase();
    const filtered = bulkRows.filter((row) => {
      const matchesStatus = bulkStatusFilter === "All" ? true : row.status === bulkStatusFilter;
      if (!matchesStatus) return false;
      if (!normalizedSearch) return true;
      const haystack = `${row.pvSystemId} ${row.status} ${row.error ?? ""}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });

    filtered.sort((a, b) => {
      switch (bulkSort) {
        case "status":
          return a.status.localeCompare(b.status);
        case "lifetime":
          return toComparableNumber(b.lifetimeKwh) - toComparableNumber(a.lifetimeKwh);
        case "hourly":
          return toComparableNumber(b.hourlyProductionKwh) - toComparableNumber(a.hourlyProductionKwh);
        case "monthly":
          return toComparableNumber(b.monthlyProductionKwh) - toComparableNumber(a.monthlyProductionKwh);
        case "mtd":
          return toComparableNumber(b.mtdProductionKwh) - toComparableNumber(a.mtdProductionKwh);
        case "previousMonth":
          return (
            toComparableNumber(b.previousCalendarMonthProductionKwh) -
            toComparableNumber(a.previousCalendarMonthProductionKwh)
          );
        case "last12Months":
          return toComparableNumber(b.last12MonthsProductionKwh) - toComparableNumber(a.last12MonthsProductionKwh);
        case "weekly":
          return toComparableNumber(b.weeklyProductionKwh) - toComparableNumber(a.weeklyProductionKwh);
        case "daily":
          return toComparableNumber(b.dailyProductionKwh) - toComparableNumber(a.dailyProductionKwh);
        case "deviceCount":
          return toComparableNumber(b.deviceCount) - toComparableNumber(a.deviceCount);
        case "inverterCount":
          return toComparableNumber(b.inverterCount) - toComparableNumber(a.inverterCount);
        case "currentPower":
          return toComparableNumber(b.currentPowerW) - toComparableNumber(a.currentPowerW);
        case "isOnline": {
          const aVal = a.isOnline === true ? 1 : a.isOnline === false ? 0 : -1;
          const bVal = b.isOnline === true ? 1 : b.isOnline === false ? 0 : -1;
          return bVal - aVal;
        }
        case "pvSystemId":
        default:
          return a.pvSystemId.localeCompare(b.pvSystemId, undefined, { numeric: true, sensitivity: "base" });
      }
    });

    return filtered;
  }, [bulkRows, bulkSearch, bulkSort, bulkStatusFilter]);

  const bulkTotalPages = Math.max(1, Math.ceil(filteredBulkRows.length / BULK_PAGE_SIZE));
  const bulkCurrentPage = Math.min(bulkPage, bulkTotalPages);
  const bulkPageStartIndex = (bulkCurrentPage - 1) * BULK_PAGE_SIZE;
  const bulkPageRows = filteredBulkRows.slice(bulkPageStartIndex, bulkPageStartIndex + BULK_PAGE_SIZE);
  const bulkProgressPercent =
    bulkProgress.total > 0 ? Math.min(100, (bulkProgress.processed / bulkProgress.total) * 100) : 0;
  const bulkDataTypeLabel =
    bulkDataType === "production" ? "Production Snapshot" : "Device Snapshot";
  const bulkSortOptions: Array<{ value: BulkSortKey; label: string }> =
    bulkDataType === "devices"
      ? [
          { value: "pvSystemId", label: "PV System ID (A-Z)" },
          { value: "status", label: "Status" },
          { value: "deviceCount", label: "Device Count (High-Low)" },
          { value: "inverterCount", label: "Inverter Count (High-Low)" },
          { value: "currentPower", label: "Current Power (High-Low)" },
          { value: "isOnline", label: "Is Online" },
        ]
      : [
          { value: "pvSystemId", label: "PV System ID (A-Z)" },
          { value: "status", label: "Status" },
          { value: "lifetime", label: "Lifetime (High-Low)" },
          { value: "hourly", label: "Hourly (High-Low)" },
          { value: "monthly", label: "Monthly (High-Low)" },
          { value: "mtd", label: "MTD (High-Low)" },
          { value: "previousMonth", label: "Previous Month (High-Low)" },
          { value: "last12Months", label: "Last 12 Months (High-Low)" },
          { value: "weekly", label: "Weekly (High-Low)" },
          { value: "daily", label: "Daily (High-Low)" },
        ];
  const bulkCsvPrefix =
    bulkDataType === "production" ? "fronius-production-bulk" : "fronius-devices-bulk";

  const downloadBulkCsv = (rows: BulkSnapshotRow[], fileNamePrefix: string) => {
    if (rows.length === 0) {
      toast.error("No rows available to export.");
      return;
    }

    const commonHeaders = [
      "pv_system_id",
      "status",
      "found",
      "error",
      "matched_connection_id",
      "matched_connection_name",
      "checked_connections",
      "found_in_connections",
      "profile_status_summary",
    ];

    const commonCells = (row: BulkSnapshotRow) => ({
      pv_system_id: row.pvSystemId,
      status: row.status,
      found: row.found ? "Yes" : "No",
      error: row.error,
      matched_connection_id: row.matchedConnectionId,
      matched_connection_name: row.matchedConnectionName,
      checked_connections: row.checkedConnections,
      found_in_connections: row.foundInConnections,
      profile_status_summary: row.profileStatusSummary,
    });

    let headers: string[] = [];
    let csvRows: Array<Record<string, string | number | boolean | null | undefined>> = [];

    if (bulkDataType === "devices") {
      headers = [
        ...commonHeaders,
        "device_count",
        "inverter_count",
        "current_power_w",
        "is_online",
      ];
      csvRows = rows.map((row) => ({
        ...commonCells(row),
        device_count: row.deviceCount,
        inverter_count: row.inverterCount,
        current_power_w: row.currentPowerW,
        is_online: row.isOnline === true ? "Yes" : row.isOnline === false ? "No" : "",
      }));
    } else {
      headers = [
        ...commonHeaders,
        "lifetime_kwh",
        "hourly_production_kwh",
        "monthly_production_kwh",
        "mtd_production_kwh",
        "previous_calendar_month_production_kwh",
        "last_12_months_production_kwh",
        "weekly_production_kwh",
        "daily_production_kwh",
        "anchor_date",
        "monthly_start_date",
        "weekly_start_date",
        "mtd_start_date",
        "previous_calendar_month_start_date",
        "previous_calendar_month_end_date",
        "last_12_months_start_date",
      ];
      csvRows = rows.map((row) => ({
        ...commonCells(row),
        lifetime_kwh: row.lifetimeKwh,
        hourly_production_kwh: row.hourlyProductionKwh,
        monthly_production_kwh: row.monthlyProductionKwh,
        mtd_production_kwh: row.mtdProductionKwh,
        previous_calendar_month_production_kwh: row.previousCalendarMonthProductionKwh,
        last_12_months_production_kwh: row.last12MonthsProductionKwh,
        weekly_production_kwh: row.weeklyProductionKwh,
        daily_production_kwh: row.dailyProductionKwh,
        anchor_date: row.anchorDate,
        monthly_start_date: row.monthlyStartDate,
        weekly_start_date: row.weeklyStartDate,
        mtd_start_date: row.mtdStartDate,
        previous_calendar_month_start_date: row.previousCalendarMonthStartDate,
        previous_calendar_month_end_date: row.previousCalendarMonthEndDate,
        last_12_months_start_date: row.last12MonthsStartDate,
      }));
    }

    const csvText = buildCsv(headers, csvRows);
    const fileName = `${fileNamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csvText, "text/csv;charset=utf-8");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return null;

  const pvSystems = pvSystemsQuery.data?.pvSystems ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const connections = statusQuery.data?.connections ?? [];
  const activeConnection = connections.find((connection) => connection.isActive);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const pvSystemsError = pvSystemsQuery.error ? toErrorMessage(pvSystemsQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20">
      <header className="border-b bg-card/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-foreground">Fronius Solar.web API</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Access Key connection for Fronius Solar.web monitoring endpoints, including bulk CSV processing for thousands of PV systems.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Section 1: Connection Management */}
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Fronius Solar.web</CardTitle>
            <CardDescription>
              Save one or more API profiles, switch active profile, and persist access keys for future sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fronius-connection-name">Profile Name (optional)</Label>
                <Input
                  id="fronius-connection-name"
                  value={connectionNameInput}
                  onChange={(e) => setConnectionNameInput(e.target.value)}
                  placeholder="Example: Fronius API 1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fronius-access-key-id">Access Key ID</Label>
                <Input
                  id="fronius-access-key-id"
                  type="password"
                  value={accessKeyIdInput}
                  onChange={(e) => setAccessKeyIdInput(e.target.value)}
                  placeholder="Fronius Solar.web Access Key ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fronius-access-key-value">Access Key Value</Label>
                <Input
                  id="fronius-access-key-value"
                  type="password"
                  value={accessKeyValueInput}
                  onChange={(e) => setAccessKeyValueInput(e.target.value)}
                  placeholder="Fronius Solar.web Access Key Value"
                />
              </div>
            </div>

            {connections.length > 0 ? (
              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Saved API Profiles</Label>
                    <Select value={selectedConnectionId} onValueChange={setSelectedConnectionId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select saved profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.name} ({connection.accessKeyIdMasked})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={handleSetActiveConnection}
                      disabled={!selectedConnectionId || setActiveConnectionMutation.isPending}
                    >
                      {setActiveConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Set Active
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleRemoveConnection}
                      disabled={!selectedConnectionId || removeConnectionMutation.isPending}
                    >
                      {removeConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Remove Profile
                    </Button>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  {NUMBER_FORMATTER.format(connections.length)} profile(s) saved. Active profile:{" "}
                  <span className="font-medium text-foreground">{activeConnection?.name ?? "N/A"}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className={`rounded-md border px-3 py-2 text-xs ${
                        connection.isActive
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "border-border bg-card text-muted-foreground"
                      }`}
                    >
                      <p className="font-medium">{connection.name}</p>
                      <p>Key: {connection.accessKeyIdMasked}</p>
                      <p>Updated: {new Date(connection.updatedAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {statusError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Status error: {statusError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleConnect} disabled={connectMutation.isPending}>
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4 mr-2" />
                )}
                Connect
              </Button>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending || !isConnected}
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  statusQuery.refetch();
                  pvSystemsQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-muted-foreground">
                Status: {isConnected ? `Connected (${connections.length} profile${connections.length === 1 ? "" : "s"})` : "Not connected"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Single PV System API Tester */}
        <Card>
          <CardHeader>
            <CardTitle>2) Single PV System API Tester</CardTitle>
            <CardDescription>
              Pick a PV system from the list or paste one manually, then fetch endpoint responses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>PV System</Label>
                <Select value={selectedPvSystemId} onValueChange={setSelectedPvSystemId} disabled={!pvSystems.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={pvSystems.length ? "Select a PV system" : "No PV systems loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {pvSystems.map((system) => (
                      <SelectItem key={system.pvSystemId} value={system.pvSystemId}>
                        {system.name ?? system.pvSystemId} ({system.pvSystemId.slice(0, 8)}...)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-pvsystem-id">Manual PV System ID (optional)</Label>
                <Input
                  id="manual-pvsystem-id"
                  value={selectedPvSystemId}
                  onChange={(e) => setSelectedPvSystemId(e.target.value.trim())}
                  placeholder="Paste PV System UUID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label>Operation</Label>
                <Select value={selectedOperation} onValueChange={(value) => setSelectedOperation(value as SingleOperation)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="listPvSystems">List PV Systems</SelectItem>
                    <SelectItem value="getDetails">Get PV System Details</SelectItem>
                    <SelectItem value="getDevices">Get Devices</SelectItem>
                    <SelectItem value="getAggData">Get Aggregated Data</SelectItem>
                    <SelectItem value="getFlowData">Get Flow Data</SelectItem>
                    <SelectItem value="getProductionSnapshot">Get Production Snapshot</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedOperation === "getAggData" && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="from-date">From</Label>
                    <Input
                      id="from-date"
                      type="date"
                      value={fromDate}
                      onChange={(e) => setFromDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="to-date">To</Label>
                    <Input
                      id="to-date"
                      type="date"
                      value={toDate}
                      onChange={(e) => setToDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fronius-period">Period</Label>
                    <Select value={period} onValueChange={(value) => setPeriod(value as Period)}>
                      <SelectTrigger id="fronius-period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Quick Date Presets</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => applyDatePreset("mtd")}>
                      MTD
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => applyDatePreset("prevMonth")}>
                      Previous Calendar Month
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => applyDatePreset("last12Months")}>
                      Last 12 Months
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    MTD = first day of current month through today. Previous Calendar Month = prior month start to end. Last 12
                    Months = same day last year through today.
                  </p>
                </div>
              </>
            )}

            {selectedOperation === "getProductionSnapshot" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="single-anchor-date">Anchor Date (optional)</Label>
                  <Input
                    id="single-anchor-date"
                    type="date"
                    value={bulkAnchorDate}
                    onChange={(e) => setBulkAnchorDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Defaults to today if left empty. Used to anchor production windows.
                  </p>
                </div>
              </div>
            )}

            {pvSystemsQuery.isLoading && <div className="text-sm text-muted-foreground">Loading PV systems...</div>}

            {pvSystemsError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                PV systems load error: {pvSystemsError}
              </div>
            )}

            {!pvSystemsQuery.isLoading && !pvSystemsError && isConnected && pvSystems.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                No PV systems were returned for this access key.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={isRunningAction || !isConnected}
                onClick={handleRunSingleOperation}
              >
                {isRunningAction ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Run Operation
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Bulk CSV Processing */}
        <Card>
          <CardHeader>
            <CardTitle>3) Bulk CSV Processing</CardTitle>
            <CardDescription>
              Upload a CSV of PV System IDs, choose bulk data type, and process in batches across API profiles.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>Bulk Data Type</Label>
                <Select value={bulkDataType} onValueChange={(value) => setBulkDataType(value as BulkDataType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="production">Production Snapshot</SelectItem>
                    <SelectItem value="devices">Device Snapshot</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select what to pull per PV System ID in bulk.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bulk-anchor-date">Anchor Date</Label>
                <Input
                  id="bulk-anchor-date"
                  type="date"
                  value={bulkAnchorDate}
                  onChange={(e) => setBulkAnchorDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Used for production snapshots. Production windows: Monthly = last 30 days, MTD = first of current month through anchor day, Previous Month = prior calendar month, Last 12 Months = trailing 12 months ending on anchor day.
                </p>
              </div>
              <div className="space-y-2">
                <Label>API Scope</Label>
                <Select
                  value={bulkConnectionScope}
                  onValueChange={(value) => setBulkConnectionScope(value as BulkConnectionScope)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active API Profile Only</SelectItem>
                    <SelectItem value="all">All Saved API Profiles</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Use <span className="font-medium">All Saved API Profiles</span> to check each PV System ID against every connected API.
                </p>
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label htmlFor="bulk-csv-upload">PV System IDs CSV</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="bulk-csv-upload"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => {
                      void handleBulkFileUpload(event.target.files?.[0] ?? null);
                      event.currentTarget.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      setBulkPvSystemIds([]);
                      setBulkRows([]);
                      setBulkSourceFileName(null);
                      setBulkImportError(null);
                      setBulkProgress({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Expected column: <code>pvSystemId</code> (or first column). File: {bulkSourceFileName ?? "None"}
                </p>
                {bulkImportError ? <p className="text-xs text-destructive">{bulkImportError}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runBulkSnapshot} disabled={bulkIsRunning || bulkPvSystemIds.length === 0 || !isConnected}>
                {bulkIsRunning ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Run {bulkDataTypeLabel}
              </Button>
              <Button
                variant="outline"
                disabled={!bulkIsRunning}
                onClick={() => {
                  bulkCancelRef.current = true;
                }}
              >
                Stop
              </Button>
              <Button
                variant="outline"
                disabled={bulkRows.length === 0}
                onClick={() => downloadBulkCsv(bulkRows, `${bulkCsvPrefix}-all`)}
              >
                Download All CSV
              </Button>
              <Button
                variant="outline"
                disabled={filteredBulkRows.length === 0}
                onClick={() => downloadBulkCsv(filteredBulkRows, `${bulkCsvPrefix}-filtered`)}
              >
                Download Filtered CSV
              </Button>
            </div>

            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Progress: {NUMBER_FORMATTER.format(bulkProgress.processed)} / {NUMBER_FORMATTER.format(bulkProgress.total)} PV System IDs
                </span>
                <span>{bulkProgressPercent.toFixed(1)}%</span>
              </div>
              <Progress value={bulkProgressPercent} />
              <p className="text-xs text-muted-foreground">
                Update cadence:{" "}
                {bulkConnectionScope === "all"
                  ? `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ALL_PROFILES)} systems per request (all API profiles).`
                  : `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ACTIVE)} systems per request (active API profile).`}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Imported PV System IDs</p>
                <p className="text-xl font-semibold text-foreground">{NUMBER_FORMATTER.format(bulkPvSystemIds.length)}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Processed</p>
                <p className="text-xl font-semibold text-foreground">{NUMBER_FORMATTER.format(bulkProgress.processed)}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Found</p>
                <p className="text-xl font-semibold text-emerald-700 dark:text-emerald-400">{NUMBER_FORMATTER.format(bulkProgress.found)}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Not Found</p>
                <p className="text-xl font-semibold text-amber-700 dark:text-amber-400">{NUMBER_FORMATTER.format(bulkProgress.notFound)}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Errors</p>
                <p className="text-xl font-semibold text-rose-700 dark:text-rose-400">{NUMBER_FORMATTER.format(bulkProgress.errored)}</p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="bulk-search">Search</Label>
                <Input
                  id="bulk-search"
                  value={bulkSearch}
                  onChange={(event) => setBulkSearch(event.target.value)}
                  placeholder="Filter by PV System ID or error"
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={bulkStatusFilter} onValueChange={(value) => setBulkStatusFilter(value as BulkStatusFilter)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All</SelectItem>
                    <SelectItem value="Found">Found</SelectItem>
                    <SelectItem value="Not Found">Not Found</SelectItem>
                    <SelectItem value="Error">Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sort</Label>
                <Select value={bulkSort} onValueChange={(value) => setBulkSort(value as BulkSortKey)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {bulkSortOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {NUMBER_FORMATTER.format(bulkPageRows.length)} of {NUMBER_FORMATTER.format(filteredBulkRows.length)} rows
              </span>
              <span>
                Page {NUMBER_FORMATTER.format(bulkCurrentPage)} of {NUMBER_FORMATTER.format(bulkTotalPages)}
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PV System ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Matched API Profile</TableHead>
                  <TableHead>Found In APIs</TableHead>
                  {bulkDataType === "production" ? (
                    <>
                      <TableHead>Lifetime (kWh)</TableHead>
                      <TableHead>Daily (kWh)</TableHead>
                      <TableHead>Weekly (kWh)</TableHead>
                      <TableHead>MTD (kWh)</TableHead>
                      <TableHead>Monthly 30d (kWh)</TableHead>
                      <TableHead>Prev Month (kWh)</TableHead>
                      <TableHead>Last 12M (kWh)</TableHead>
                    </>
                  ) : null}
                  {bulkDataType === "devices" ? (
                    <>
                      <TableHead>Device Count</TableHead>
                      <TableHead>Inverter Count</TableHead>
                      <TableHead>Current Power (W)</TableHead>
                      <TableHead>Is Online</TableHead>
                    </>
                  ) : null}
                  <TableHead>API Check Summary</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkPageRows.map((row) => (
                  <TableRow key={row.pvSystemId}>
                    <TableCell className="font-medium font-mono text-xs">{row.pvSystemId}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          row.status === "Found"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
                            : row.status === "Not Found"
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300"
                              : "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300"
                        }`}
                      >
                        {row.status}
                      </span>
                    </TableCell>
                    <TableCell>{row.matchedConnectionName ?? "N/A"}</TableCell>
                    <TableCell>
                      {NUMBER_FORMATTER.format(row.foundInConnections ?? 0)} / {NUMBER_FORMATTER.format(row.checkedConnections ?? 0)}
                    </TableCell>
                    {bulkDataType === "production" ? (
                      <>
                        <TableCell>{formatKwh(row.lifetimeKwh)}</TableCell>
                        <TableCell>{formatKwh(row.dailyProductionKwh)}</TableCell>
                        <TableCell>{formatKwh(row.weeklyProductionKwh)}</TableCell>
                        <TableCell>{formatKwh(row.mtdProductionKwh)}</TableCell>
                        <TableCell>{formatKwh(row.monthlyProductionKwh)}</TableCell>
                        <TableCell>{formatKwh(row.previousCalendarMonthProductionKwh)}</TableCell>
                        <TableCell>{formatKwh(row.last12MonthsProductionKwh)}</TableCell>
                      </>
                    ) : null}
                    {bulkDataType === "devices" ? (
                      <>
                        <TableCell>{row.deviceCount ?? "N/A"}</TableCell>
                        <TableCell>{row.inverterCount ?? "N/A"}</TableCell>
                        <TableCell>{row.currentPowerW != null ? NUMBER_FORMATTER.format(row.currentPowerW) : "N/A"}</TableCell>
                        <TableCell>
                          {row.isOnline === true ? (
                            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
                              Online
                            </span>
                          ) : row.isOnline === false ? (
                            <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-900 dark:text-rose-300">
                              Offline
                            </span>
                          ) : (
                            "N/A"
                          )}
                        </TableCell>
                      </>
                    ) : null}
                    <TableCell className="text-xs text-muted-foreground">{row.profileStatusSummary}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.error ?? ""}</TableCell>
                  </TableRow>
                ))}
                {bulkPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={bulkDataType === "production" ? 13 : 10}
                      className="py-6 text-center text-muted-foreground"
                    >
                      No bulk rows to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkPage((page) => Math.max(1, page - 1))}
                disabled={bulkCurrentPage <= 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkPage((page) => Math.min(bulkTotalPages, page + 1))}
                disabled={bulkCurrentPage >= bulkTotalPages}
              >
                Next
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 4: Raw API Response */}
        <Card>
          <CardHeader>
            <CardTitle>4) Raw API Response</CardTitle>
            <CardDescription>{resultTitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-foreground/5 text-foreground rounded-md p-4 overflow-auto max-h-[480px] border">
              {resultText}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
