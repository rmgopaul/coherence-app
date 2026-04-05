import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { buildConvertedReadRow, pushConvertedReadsToRecDashboard } from "@/lib/convertedReads";
import { clean, toErrorMessage, formatKwh, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, Download, Loader2, PlugZap, RefreshCw, Unplug, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const BULK_BATCH_SIZE_ACTIVE = 200;
const BULK_BATCH_SIZE_ALL_PROFILES = 25;
const BULK_ROWS_RENDER_INTERVAL_ACTIVE = 1;
const BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES = 4;
const BULK_PAGE_SIZE = 25;

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

type BulkStatusFilter = "All" | "Found" | "Not Found" | "Error";
type BulkSortKey =
  | "plantId"
  | "status"
  | "lifetime"
  | "hourly"
  | "monthly"
  | "mtd"
  | "previousMonth"
  | "last12Months"
  | "weekly"
  | "daily";
type BulkConnectionScope = "active" | "all";

type SingleOperation = "listPlants" | "getProductionSnapshot";

type BulkSnapshotRow = {
  plantId: string;
  name?: string | null;
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

function extractPlantIdsFromCsv(text: string): string[] {
  const parsed = parseCsv(text);
  const normalizedHeaders = parsed.headers.map((header) => clean(header).toLowerCase().replace(/\s+/g, "_"));

  const preferredIndex = normalizedHeaders.findIndex((header) =>
    ["plantid", "plant_id", "id"].includes(header)
  );

  if (parsed.headers.length === 1 && preferredIndex === -1) {
    const headerValue = clean(parsed.headers[0]);
    const columnValues = parsed.rows.map((row) => clean(row[parsed.headers[0]])).filter(Boolean);
    const combined = headerValue ? [headerValue, ...columnValues] : columnValues;
    return Array.from(new Set(combined));
  }

  if (preferredIndex >= 0) {
    const plantHeader = parsed.headers[preferredIndex];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[plantHeader]))
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

export default function GrowattMeterReads() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);

  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [connectionNameInput, setConnectionNameInput] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedPlantId, setSelectedPlantId] = useState("");
  const [selectedOperation, setSelectedOperation] = useState<SingleOperation>("listPlants");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const [bulkAnchorDate, setBulkAnchorDate] = useState(today);
  const [bulkPlantIds, setBulkPlantIds] = useState<string[]>([]);
  const [bulkSourceFileName, setBulkSourceFileName] = useState<string | null>(null);
  const [bulkImportError, setBulkImportError] = useState<string | null>(null);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
  const [bulkStatusFilter, setBulkStatusFilter] = useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkSort, setBulkSort] = useState<BulkSortKey>("plantId");
  const [bulkConnectionScope, setBulkConnectionScope] = useState<BulkConnectionScope>("active");
  const [bulkPage, setBulkPage] = useState(1);
  const bulkCancelRef = useRef(false);

  const statusQuery = trpc.growatt.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const plantsQuery = trpc.growatt.listPlants.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.growatt.connect.useMutation();
  const setActiveConnectionMutation = trpc.growatt.setActiveConnection.useMutation();
  const removeConnectionMutation = trpc.growatt.removeConnection.useMutation();
  const disconnectMutation = trpc.growatt.disconnect.useMutation();
  const productionSnapshotMutation = trpc.growatt.getProductionSnapshot.useMutation();
  const getRemoteDataset = trpc.solarRecDashboard.getDataset.useMutation();
  const saveRemoteDataset = trpc.solarRecDashboard.saveDataset.useMutation();

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
    const firstPlant = plantsQuery.data?.plants?.[0];
    if (!firstPlant) return;
    if (!selectedPlantId) {
      setSelectedPlantId(firstPlant.plantId);
    }
  }, [plantsQuery.data, selectedPlantId]);

  useEffect(() => {
    setBulkPage(1);
  }, [bulkRows.length, bulkSearch, bulkSort, bulkStatusFilter]);

  useEffect(() => {
    setBulkRows([]);
    setBulkProgress({ total: bulkPlantIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
  }, [bulkPlantIds.length]);

  const handleConnect = async () => {
    const username = usernameInput.trim();
    const password = passwordInput.trim();

    if (!username || !password) {
      toast.error("Enter both Username and Password.");
      return;
    }

    try {
      const response = await connectMutation.mutateAsync({
        username,
        password,
        connectionName: connectionNameInput.trim() || undefined,
      });
      await trpcUtils.growatt.getStatus.invalidate();
      await trpcUtils.growatt.listPlants.invalidate();
      setSelectedConnectionId(response.activeConnectionId);
      setUsernameInput("");
      setPasswordInput("");
      setConnectionNameInput("");
      toast.success(
        `Growatt profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
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
      await trpcUtils.growatt.getStatus.invalidate();
      await trpcUtils.growatt.listPlants.invalidate();
      setSelectedPlantId("");
      toast.success("Active Growatt API profile updated.");
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
      await trpcUtils.growatt.getStatus.invalidate();
      await trpcUtils.growatt.listPlants.invalidate();
      setSelectedPlantId("");
      setSelectedConnectionId(response.activeConnectionId ?? "");
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : "Removed final profile. Growatt is now disconnected."
      );
    } catch (error) {
      toast.error(`Failed to remove profile: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.growatt.getStatus.invalidate();
      await trpcUtils.growatt.listPlants.invalidate();
      setSelectedPlantId("");
      setSelectedConnectionId("");
      toast.success("Growatt disconnected.");
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
      case "listPlants":
        void runAction("List Plants", () =>
          plantsQuery.refetch().then((result) => result.data)
        );
        break;
      case "getProductionSnapshot":
        if (!selectedPlantId) {
          toast.error("Enter a Plant ID first.");
          return;
        }
        void runAction("Production Snapshot", () =>
          productionSnapshotMutation.mutateAsync({
            plantId: selectedPlantId,
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
      const plantIds = extractPlantIdsFromCsv(raw);
      if (plantIds.length === 0) {
        setBulkImportError("No valid Plant IDs found in CSV.");
        setBulkPlantIds([]);
        setBulkSourceFileName(file.name);
        return;
      }

      setBulkSourceFileName(file.name);
      setBulkPlantIds(plantIds);
      setBulkRows([]);
      setBulkProgress({ total: plantIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(`Imported ${NUMBER_FORMATTER.format(plantIds.length)} Plant IDs.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse CSV.";
      setBulkImportError(message);
      setBulkPlantIds([]);
    }
  };

  const handlePullAllPlants = async () => {
    if (!isConnected) {
      toast.error("Connect Growatt before pulling plants.");
      return;
    }
    try {
      const result = await plantsQuery.refetch();
      const plants = result.data?.plants ?? [];
      if (plants.length === 0) {
        toast.error("No plants found for this API profile.");
        return;
      }
      const ids = plants.map((s: { plantId: string }) => s.plantId);
      setBulkPlantIds(ids);
      setBulkSourceFileName(`API — ${ids.length} plants`);
      setBulkRows([]);
      setBulkImportError(null);
      setBulkProgress({ total: ids.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(
        `Loaded ${NUMBER_FORMATTER.format(ids.length)} Plant IDs. Next step: click "Run Production Snapshot" to fetch row data.`
      );
    } catch (error) {
      toast.error(`Failed to list plants: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const runBulkSnapshot = async () => {
    if (!statusQuery.data?.connected) {
      toast.error("Connect Growatt before running bulk processing.");
      return;
    }
    if (bulkPlantIds.length === 0) {
      toast.error("Upload a CSV with Plant IDs first.");
      return;
    }

    setBulkIsRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    const effectiveBatchSize =
      bulkConnectionScope === "all" ? BULK_BATCH_SIZE_ALL_PROFILES : BULK_BATCH_SIZE_ACTIVE;
    const rowRenderInterval =
      bulkConnectionScope === "all" ? BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES : BULK_ROWS_RENDER_INTERVAL_ACTIVE;
    const chunks = chunkArray(bulkPlantIds, effectiveBatchSize);
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;
    const collectedRows: BulkSnapshotRow[] = [];
    setBulkProgress({
      total: bulkPlantIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        if (bulkCancelRef.current) break;

        const fallbackErrorRows = (message: string): BulkSnapshotRow[] =>
          chunk.map((plantId) => ({
            plantId,
            name: null,
            status: "Error",
            found: false,
            error: message,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: bulkConnectionScope === "all" ? statusQuery.data?.connections.length ?? 0 : 1,
            foundInConnections: 0,
            profileStatusSummary: "",
          }));

        for (const id of chunk) {
          if (bulkCancelRef.current) break;
          try {
            const row = await productionSnapshotMutation.mutateAsync({
              plantId: id,
              anchorDate: bulkAnchorDate,
            });
            collectedRows.push(row as BulkSnapshotRow);
            if (row.found) found++;
            else notFound++;
          } catch (idError) {
            collectedRows.push({
              plantId: id,
              name: null,
              status: "Error",
              found: false,
              error: toErrorMessage(idError),
              matchedConnectionId: null,
              matchedConnectionName: null,
              checkedConnections: bulkConnectionScope === "all" ? statusQuery.data?.connections.length ?? 0 : 1,
              foundInConnections: 0,
              profileStatusSummary: "",
            } as BulkSnapshotRow);
            errored++;
          }
          processed++;
          setBulkProgress({
            total: bulkPlantIds.length,
            processed,
            found,
            notFound,
            errored,
          });
        }

        const shouldRenderRows =
          chunkIndex % rowRenderInterval === 0 || chunkIndex === chunks.length - 1 || bulkCancelRef.current;
        if (shouldRenderRows) {
          setBulkRows([...collectedRows]);
        }

        await waitForNextFrame();
      }

      if (bulkCancelRef.current) {
        toast.message(
          `Stopped production snapshots after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkPlantIds.length)} Plant IDs.`
        );
      } else {
        toast.success(
          `Completed production snapshots for ${NUMBER_FORMATTER.format(processed)} Plant IDs using ${bulkConnectionScope === "all" ? "all saved API profiles" : "active API profile"}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );

        try {
          const readRows = collectedRows
            .filter((row) => row.found && row.lifetimeKwh != null && row.anchorDate)
            .map((row) =>
              buildConvertedReadRow("Growatt", row.plantId, row.name ?? "", row.lifetimeKwh!, row.anchorDate!)
            );
          const result = await pushConvertedReadsToRecDashboard(
            (input) => getRemoteDataset.mutateAsync(input),
            (input) => saveRemoteDataset.mutateAsync(input),
            readRows,
            "Growatt"
          );
          if (result.pushed > 0) {
            toast.success(`Pushed ${NUMBER_FORMATTER.format(result.pushed)} Growatt rows to Solar REC Dashboard Converted Reads.${result.skipped > 0 ? ` ${NUMBER_FORMATTER.format(result.skipped)} duplicates skipped.` : ""}`);
          } else if (result.skipped > 0) {
            toast.message(`All ${NUMBER_FORMATTER.format(result.skipped)} Growatt Converted Reads rows already exist. No new rows pushed.`);
          }
        } catch (pushError) {
          toast.error(`Failed to push Converted Reads: ${toErrorMessage(pushError)}`);
        }
      }
    } catch (error) {
      toast.error(`Bulk production snapshots failed: ${toErrorMessage(error)}`);
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
      const haystack = `${row.plantId} ${row.name ?? ""} ${row.status} ${row.error ?? ""}`.toLowerCase();
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
        case "plantId":
        default:
          return a.plantId.localeCompare(b.plantId, undefined, { numeric: true, sensitivity: "base" });
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
  const bulkSortOptions: Array<{ value: BulkSortKey; label: string }> = [
    { value: "plantId", label: "Plant ID (A-Z)" },
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

  const downloadBulkCsv = (rows: BulkSnapshotRow[], fileNamePrefix: string) => {
    if (rows.length === 0) {
      toast.error("No rows available to export.");
      return;
    }

    const headers = [
      "plant_id",
      "plant_name",
      "status",
      "found",
      "error",
      "matched_connection_id",
      "matched_connection_name",
      "checked_connections",
      "found_in_connections",
      "profile_status_summary",
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

    const csvRows = rows.map((row) => ({
      plant_id: row.plantId,
      plant_name: row.name,
      status: row.status,
      found: row.found ? "Yes" : "No",
      error: row.error,
      matched_connection_id: row.matchedConnectionId,
      matched_connection_name: row.matchedConnectionName,
      checked_connections: row.checkedConnections,
      found_in_connections: row.foundInConnections,
      profile_status_summary: row.profileStatusSummary,
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

    const csvText = buildCsv(headers, csvRows);
    const fileName = `${fileNamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csvText, "text/csv;charset=utf-8");
  };

  const downloadConvertedReadsCsv = (rows: BulkSnapshotRow[]) => {
    const readRows = rows.filter((row) => row.found && row.lifetimeKwh != null && row.anchorDate);
    if (readRows.length === 0) {
      toast.error("No rows with lifetime kWh available for Converted Reads export.");
      return;
    }
    const headers = ["monitoring", "monitoring_system_id", "monitoring_system_name", "lifetime_meter_read_wh", "read_date", "status", "alert_severity"];
    const csvRows: Array<Record<string, string | number | boolean | null | undefined>> = [];
    for (const row of readRows) {
      const base = buildConvertedReadRow("Growatt", row.plantId, row.name ?? "", row.lifetimeKwh!, row.anchorDate!);
      // Row 1: system name only (ID blank) — matches by name
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id: "",
        monitoring_system_name: base.monitoring_system_name,
        lifetime_meter_read_wh: base.lifetime_meter_read_wh,
        read_date: base.read_date,
        status: base.status,
        alert_severity: base.alert_severity,
      });
      // Row 2: system ID only (name blank) — matches by ID
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id: base.monitoring_system_id,
        monitoring_system_name: "",
        lifetime_meter_read_wh: base.lifetime_meter_read_wh,
        read_date: base.read_date,
        status: base.status,
        alert_severity: base.alert_severity,
      });
    }
    const csvText = buildCsv(headers, csvRows);
    const fileName = `growatt-converted-reads-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csvText, "text/csv;charset=utf-8");
    toast.success(`Downloaded ${csvRows.length} Converted Reads rows (${readRows.length} systems \u00d7 2 match rows each).`);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return null;

  const plants = plantsQuery.data?.plants ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const connections = statusQuery.data?.connections ?? [];
  const activeConnection = connections.find((connection) => connection.isActive);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const plantsError = plantsQuery.error ? toErrorMessage(plantsQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20">
      <header className="border-b bg-card/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-foreground">Growatt API</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Username/password connection for Growatt monitoring endpoints, including bulk CSV processing for thousands of plants.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Section 1: Connection Management */}
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Growatt</CardTitle>
            <CardDescription>
              Save one or more API profiles, switch active profile, and persist credentials for future sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="growatt-connection-name">Profile Name (optional)</Label>
                <Input
                  id="growatt-connection-name"
                  value={connectionNameInput}
                  onChange={(e) => setConnectionNameInput(e.target.value)}
                  placeholder="Example: Growatt API 1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="growatt-username">Username</Label>
                <Input
                  id="growatt-username"
                  type="text"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="Growatt Username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="growatt-password">Password</Label>
                <Input
                  id="growatt-password"
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Growatt Password"
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
                            {connection.name} ({connection.id.slice(0, 8)}...)
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
                      <p>ID: {connection.id.slice(0, 12)}...</p>
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
                  plantsQuery.refetch();
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

        {/* Section 2: Single Plant API Tester */}
        <Card>
          <CardHeader>
            <CardTitle>2) Single Plant API Tester</CardTitle>
            <CardDescription>
              Pick a plant from the list or paste one manually, then fetch endpoint responses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>Plant</Label>
                <Select value={selectedPlantId} onValueChange={setSelectedPlantId} disabled={!plants.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={plants.length ? "Select a plant" : "No plants loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {plants.map((plant: { plantId: string; name?: string | null }) => (
                      <SelectItem key={plant.plantId} value={plant.plantId}>
                        {plant.name ?? plant.plantId} ({plant.plantId.slice(0, 8)}...)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-plant-id">Manual Plant ID (optional)</Label>
                <Input
                  id="manual-plant-id"
                  value={selectedPlantId}
                  onChange={(e) => setSelectedPlantId(e.target.value.trim())}
                  placeholder="Paste Plant ID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label>Operation</Label>
                <Select value={selectedOperation} onValueChange={(value) => setSelectedOperation(value as SingleOperation)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="listPlants">List Plants</SelectItem>
                    <SelectItem value="getProductionSnapshot">Get Production Snapshot</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

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

            {plantsQuery.isLoading && <div className="text-sm text-muted-foreground">Loading plants...</div>}

            {plantsError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Plants load error: {plantsError}
              </div>
            )}

            {!plantsQuery.isLoading && !plantsError && isConnected && plants.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                No plants were returned for this API profile.
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
              Upload a CSV of Plant IDs and process production snapshots in batches across API profiles.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  Use <span className="font-medium">All Saved API Profiles</span> to check each Plant ID against every connected API.
                </p>
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>Plant IDs</Label>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => void handlePullAllPlants()}
                    disabled={!isConnected || plantsQuery.isFetching}
                    className="whitespace-nowrap"
                  >
                    {plantsQuery.isFetching ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Pull All Plants
                  </Button>
                  <span className="text-xs text-muted-foreground">or</span>
                  <label className="cursor-pointer">
                    <Input
                      id="bulk-csv-upload"
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(event) => {
                        void handleBulkFileUpload(event.target.files?.[0] ?? null);
                        event.currentTarget.value = "";
                      }}
                    />
                    <span className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer">
                      <Upload className="h-4 w-4 mr-2" />
                      Upload CSV
                    </span>
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulkPlantIds.length === 0}
                    onClick={() => {
                      setBulkPlantIds([]);
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
                  Source: {bulkSourceFileName ?? "None"}{bulkPlantIds.length > 0 ? ` — ${NUMBER_FORMATTER.format(bulkPlantIds.length)} IDs` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  "Pull All Plants" imports IDs only. Run the bulk snapshot action to populate result rows.
                </p>
                {bulkImportError ? <p className="text-xs text-destructive">{bulkImportError}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runBulkSnapshot} disabled={bulkIsRunning || bulkPlantIds.length === 0 || !isConnected}>
                {bulkIsRunning ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Run Production Snapshot
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
                onClick={() => downloadBulkCsv(bulkRows, "growatt-production-bulk-all")}
              >
                Download All CSV
              </Button>
              <Button
                variant="outline"
                disabled={filteredBulkRows.length === 0}
                onClick={() => downloadBulkCsv(filteredBulkRows, "growatt-production-bulk-filtered")}
              >
                Download Filtered CSV
              </Button>
              <Button
                variant="outline"
                disabled={bulkRows.filter((r) => r.found && r.lifetimeKwh != null).length === 0}
                onClick={() => downloadConvertedReadsCsv(bulkRows)}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Converted Reads CSV
              </Button>
            </div>

            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Progress: {NUMBER_FORMATTER.format(bulkProgress.processed)} / {NUMBER_FORMATTER.format(bulkProgress.total)} Plant IDs
                </span>
                <span>{bulkProgressPercent.toFixed(1)}%</span>
              </div>
              <Progress value={bulkProgressPercent} />
              <p className="text-xs text-muted-foreground">
                Update cadence:{" "}
                {bulkConnectionScope === "all"
                  ? `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ALL_PROFILES)} plants per request (all API profiles).`
                  : `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ACTIVE)} plants per request (active API profile).`}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Imported Plant IDs</p>
                <p className="text-xl font-semibold text-foreground">{NUMBER_FORMATTER.format(bulkPlantIds.length)}</p>
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
                  placeholder="Filter by Plant ID or error"
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
                  <TableHead>Plant ID</TableHead>
                  <TableHead>Plant Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Matched API Profile</TableHead>
                  <TableHead>Found In APIs</TableHead>
                  <TableHead>Lifetime (kWh)</TableHead>
                  <TableHead>Daily (kWh)</TableHead>
                  <TableHead>Weekly (kWh)</TableHead>
                  <TableHead>MTD (kWh)</TableHead>
                  <TableHead>Monthly 30d (kWh)</TableHead>
                  <TableHead>Prev Month (kWh)</TableHead>
                  <TableHead>Last 12M (kWh)</TableHead>
                  <TableHead>API Check Summary</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkPageRows.map((row) => (
                  <TableRow key={row.plantId}>
                    <TableCell className="font-medium font-mono text-xs">{row.plantId}</TableCell>
                    <TableCell className="text-xs">{row.name ?? ""}</TableCell>
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
                    <TableCell>{formatKwh(row.lifetimeKwh)}</TableCell>
                    <TableCell>{formatKwh(row.dailyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.weeklyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.mtdProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.monthlyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.previousCalendarMonthProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.last12MonthsProductionKwh)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.profileStatusSummary}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.error ?? ""}</TableCell>
                  </TableRow>
                ))}
                {bulkPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={14}
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
