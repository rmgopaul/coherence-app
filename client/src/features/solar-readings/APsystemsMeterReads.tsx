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
  | "systemId"
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

type SingleOperation = "getSystemDetails" | "getProductionSnapshot";

type BulkSnapshotRow = {
  systemId: string;
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

function extractSystemIdsFromCsv(text: string): string[] {
  const parsed = parseCsv(text);
  const normalizedHeaders = parsed.headers.map((header) => clean(header).toLowerCase().replace(/\s+/g, "_"));

  const preferredIndex = normalizedHeaders.findIndex((header) =>
    ["systemid", "system_id", "ecu_id", "id"].includes(header)
  );

  if (parsed.headers.length === 1 && preferredIndex === -1) {
    const headerValue = clean(parsed.headers[0]);
    const columnValues = parsed.rows.map((row) => clean(row[parsed.headers[0]])).filter(Boolean);
    const combined = headerValue ? [headerValue, ...columnValues] : columnValues;
    return Array.from(new Set(combined));
  }

  if (preferredIndex >= 0) {
    const systemHeader = parsed.headers[preferredIndex];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[systemHeader]))
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

export default function APsystemsMeterReads() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);

  const [appIdInput, setAppIdInput] = useState("");
  const [appSecretInput, setAppSecretInput] = useState("");
  const [connectionNameInput, setConnectionNameInput] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [selectedOperation, setSelectedOperation] = useState<SingleOperation>("getProductionSnapshot");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const [bulkAnchorDate, setBulkAnchorDate] = useState(today);
  const [bulkSystemIds, setBulkSystemIds] = useState<string[]>([]);
  const [bulkSourceFileName, setBulkSourceFileName] = useState<string | null>(null);
  const [bulkImportError, setBulkImportError] = useState<string | null>(null);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
  const [bulkStatusFilter, setBulkStatusFilter] = useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkSort, setBulkSort] = useState<BulkSortKey>("systemId");
  const [bulkConnectionScope, setBulkConnectionScope] = useState<BulkConnectionScope>("active");
  const [bulkPage, setBulkPage] = useState(1);
  const bulkCancelRef = useRef(false);

  const statusQuery = trpc.apsystems.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const systemsQuery = trpc.apsystems.listSystems.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.apsystems.connect.useMutation();
  const setActiveConnectionMutation = trpc.apsystems.setActiveConnection.useMutation();
  const removeConnectionMutation = trpc.apsystems.removeConnection.useMutation();
  const disconnectMutation = trpc.apsystems.disconnect.useMutation();
  const productionSnapshotMutation = trpc.apsystems.getProductionSnapshot.useMutation();
  const listAllSidsMutation = trpc.apsystems.listAllSids.useMutation();
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
    const firstSystem = systemsQuery.data?.systems?.[0];
    if (!firstSystem) return;
    if (!selectedSystemId) {
      setSelectedSystemId(firstSystem.systemId);
    }
  }, [systemsQuery.data, selectedSystemId]);

  useEffect(() => {
    setBulkPage(1);
  }, [bulkRows.length, bulkSearch, bulkSort, bulkStatusFilter]);

  useEffect(() => {
    setBulkRows([]);
    setBulkProgress({ total: bulkSystemIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
  }, [bulkSystemIds.length]);

  const handleConnect = async () => {
    const appId = appIdInput.trim();
    const appSecret = appSecretInput.trim();

    if (!appId || !appSecret) {
      toast.error("Enter both App ID and App Secret.");
      return;
    }

    try {
      const response = await connectMutation.mutateAsync({
        appId,
        appSecret,
        connectionName: connectionNameInput.trim() || undefined,
      });
      await trpcUtils.apsystems.getStatus.invalidate();
      await trpcUtils.apsystems.listSystems.invalidate();
      setSelectedConnectionId(response.activeConnectionId);
      setAppIdInput("");
      setAppSecretInput("");
      setConnectionNameInput("");
      toast.success(
        `APsystems profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
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
      await trpcUtils.apsystems.getStatus.invalidate();
      await trpcUtils.apsystems.listSystems.invalidate();
      setSelectedSystemId("");
      toast.success("Active APsystems API profile updated.");
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
      await trpcUtils.apsystems.getStatus.invalidate();
      await trpcUtils.apsystems.listSystems.invalidate();
      setSelectedSystemId("");
      setSelectedConnectionId(response.activeConnectionId ?? "");
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : "Removed final profile. APsystems is now disconnected."
      );
    } catch (error) {
      toast.error(`Failed to remove profile: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.apsystems.getStatus.invalidate();
      await trpcUtils.apsystems.listSystems.invalidate();
      setSelectedSystemId("");
      setSelectedConnectionId("");
      toast.success("APsystems disconnected.");
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
    if (!selectedSystemId) {
      toast.error("Enter a System ID first.");
      return;
    }
    switch (selectedOperation) {
      case "getSystemDetails":
        void runAction("System Details", () =>
          productionSnapshotMutation.mutateAsync({
            systemId: selectedSystemId,
            anchorDate: bulkAnchorDate || undefined,
          })
        );
        break;
      case "getProductionSnapshot":
        void runAction("Production Snapshot", () =>
          productionSnapshotMutation.mutateAsync({
            systemId: selectedSystemId,
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
      const systemIds = extractSystemIdsFromCsv(raw);
      if (systemIds.length === 0) {
        setBulkImportError("No valid System IDs found in CSV.");
        setBulkSystemIds([]);
        setBulkSourceFileName(file.name);
        return;
      }

      setBulkSourceFileName(file.name);
      setBulkSystemIds(systemIds);
      setBulkRows([]);
      setBulkProgress({ total: systemIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(`Imported ${NUMBER_FORMATTER.format(systemIds.length)} System IDs.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse CSV.";
      setBulkImportError(message);
      setBulkSystemIds([]);
    }
  };

  const handlePullAllSystems = async (allProfiles = false) => {
    if (!isConnected) {
      toast.error("Connect APsystems before pulling systems.");
      return;
    }
    try {
      let ids: string[];
      let label: string;

      if (allProfiles) {
        const result = await listAllSidsMutation.mutateAsync();
        const systems = result.systems ?? [];
        if (systems.length === 0) {
          toast.error("No SIDs returned from any profile. Upload a CSV instead.");
          return;
        }
        ids = systems.map((s) => s.systemId);
        const profileSummary = result.perProfile
          .map((p) => `${p.connectionName}: ${p.systemCount}${p.error ? ` (error: ${p.error})` : ""}`)
          .join(", ");
        label = `All Profiles (${result.totalProfiles}) — ${ids.length} SIDs [${profileSummary}]`;
      } else {
        const result = await systemsQuery.refetch();
        const systems = result.data?.systems ?? [];
        if (systems.length === 0) {
          toast.error("No SIDs returned. The API may not support listing for this account. Upload a CSV instead.");
          return;
        }
        ids = systems.map((s: { systemId: string }) => s.systemId);
        label = `API — ${ids.length} SIDs`;
      }

      setBulkSystemIds(ids);
      setBulkSourceFileName(label);
      setBulkRows([]);
      setBulkImportError(null);
      setBulkProgress({ total: ids.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(
        `Loaded ${NUMBER_FORMATTER.format(ids.length)} SIDs. Next step: click "Run Production Snapshot" to fetch row data.`
      );
    } catch (error) {
      toast.error(`Failed to list systems: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const runBulkSnapshot = async () => {
    if (!statusQuery.data?.connected) {
      toast.error("Connect APsystems before running bulk processing.");
      return;
    }
    if (bulkSystemIds.length === 0) {
      toast.error("Upload a CSV with System IDs first.");
      return;
    }

    setBulkIsRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    const effectiveBatchSize =
      bulkConnectionScope === "all" ? BULK_BATCH_SIZE_ALL_PROFILES : BULK_BATCH_SIZE_ACTIVE;
    const rowRenderInterval =
      bulkConnectionScope === "all" ? BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES : BULK_ROWS_RENDER_INTERVAL_ACTIVE;
    const chunks = chunkArray(bulkSystemIds, effectiveBatchSize);
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;
    const collectedRows: BulkSnapshotRow[] = [];
    setBulkProgress({
      total: bulkSystemIds.length,
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
          chunk.map((systemId) => ({
            systemId,
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
              systemId: id,
              anchorDate: bulkAnchorDate,
            });
            collectedRows.push(row as BulkSnapshotRow);
            if (row.found) found++;
            else notFound++;
          } catch (idError) {
            collectedRows.push({
              systemId: id,
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
            total: bulkSystemIds.length,
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
          `Stopped production snapshots after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkSystemIds.length)} System IDs.`
        );
      } else {
        toast.success(
          `Completed production snapshots for ${NUMBER_FORMATTER.format(processed)} System IDs using ${bulkConnectionScope === "all" ? "all saved API profiles" : "active API profile"}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );

        try {
          const readRows = collectedRows
            .filter((row) => row.found && row.lifetimeKwh != null && row.anchorDate)
            .map((row) =>
              buildConvertedReadRow("APsystems", row.systemId, row.name ?? "", row.lifetimeKwh!, row.anchorDate!)
            );
          const result = await pushConvertedReadsToRecDashboard(
            (input) => getRemoteDataset.mutateAsync(input),
            (input) => saveRemoteDataset.mutateAsync(input),
            readRows,
            "APsystems"
          );
          if (result.pushed > 0) {
            toast.success(`Pushed ${NUMBER_FORMATTER.format(result.pushed)} APsystems rows to Solar REC Dashboard Converted Reads.${result.skipped > 0 ? ` ${NUMBER_FORMATTER.format(result.skipped)} duplicates skipped.` : ""}`);
          } else if (result.skipped > 0) {
            toast.message(`All ${NUMBER_FORMATTER.format(result.skipped)} APsystems Converted Reads rows already exist. No new rows pushed.`);
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
      const haystack = `${row.systemId} ${row.name ?? ""} ${row.status} ${row.error ?? ""}`.toLowerCase();
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
        case "systemId":
        default:
          return a.systemId.localeCompare(b.systemId, undefined, { numeric: true, sensitivity: "base" });
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
    { value: "systemId", label: "System ID (A-Z)" },
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
      "system_id",
      "system_name",
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
      system_id: row.systemId,
      system_name: row.name,
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
    const headers = ["monitoring", "monitoring_system_id", "monitoring_system_name", "lifetime_meter_read_wh", "status", "alert_severity", "read_date"];
    const csvRows: Array<Record<string, string | number | boolean | null | undefined>> = [];
    for (const row of readRows) {
      const base = buildConvertedReadRow("APSystems", row.systemId, row.name ?? "", row.lifetimeKwh!, row.anchorDate!);
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
    const fileName = `apsystems-converted-reads-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
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

  const systems = systemsQuery.data?.systems ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const connections = statusQuery.data?.connections ?? [];
  const activeConnection = connections.find((connection) => connection.isActive);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const systemsError = systemsQuery.error ? toErrorMessage(systemsQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20">
      <header className="border-b bg-card/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-foreground">APsystems API</h1>
          <p className="text-sm text-muted-foreground mt-1">
            API Key connection for APsystems monitoring endpoints, including bulk CSV processing for thousands of systems.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Section 1: Connection Management */}
        <Card>
          <CardHeader>
            <CardTitle>1) Connect APsystems</CardTitle>
            <CardDescription>
              Save one or more API profiles, switch active profile, and persist API keys for future sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="apsystems-connection-name">Profile Name (optional)</Label>
                <Input
                  id="apsystems-connection-name"
                  value={connectionNameInput}
                  onChange={(e) => setConnectionNameInput(e.target.value)}
                  placeholder="Example: APsystems API 1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="apsystems-app-id">App ID</Label>
                <Input
                  id="apsystems-app-id"
                  type="password"
                  value={appIdInput}
                  onChange={(e) => setAppIdInput(e.target.value)}
                  placeholder="APsystems App ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="apsystems-app-secret">App Secret</Label>
                <Input
                  id="apsystems-app-secret"
                  type="password"
                  value={appSecretInput}
                  onChange={(e) => setAppSecretInput(e.target.value)}
                  placeholder="APsystems App Secret"
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
                  systemsQuery.refetch();
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

        {/* Section 2: Single System API Tester */}
        <Card>
          <CardHeader>
            <CardTitle>2) Single System API Tester</CardTitle>
            <CardDescription>
              Pick a system from the list or paste one manually, then fetch endpoint responses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>System</Label>
                <Select value={selectedSystemId} onValueChange={setSelectedSystemId} disabled={!systems.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={systems.length ? "Select a system" : "No systems loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {systems.map((system: { systemId: string; name?: string | null }) => (
                      <SelectItem key={system.systemId} value={system.systemId}>
                        {system.name ?? system.systemId} ({system.systemId.slice(0, 8)}...)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-system-id">Manual System ID (optional)</Label>
                <Input
                  id="manual-system-id"
                  value={selectedSystemId}
                  onChange={(e) => setSelectedSystemId(e.target.value.trim())}
                  placeholder="Paste System ID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label>Operation</Label>
                <Select value={selectedOperation} onValueChange={(value) => setSelectedOperation(value as SingleOperation)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="getSystemDetails">Get System Details</SelectItem>
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

            {systemsQuery.isLoading && <div className="text-sm text-muted-foreground">Loading systems...</div>}

            {systemsError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Systems load error: {systemsError}
              </div>
            )}

            {!systemsQuery.isLoading && !systemsError && isConnected && systems.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                APsystems API requires System IDs. Enter a SID above or upload a CSV with IDs for bulk operations.
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
              Upload a CSV of System IDs and process production snapshots in batches across API profiles.
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
                  Use <span className="font-medium">All Saved API Profiles</span> to check each System ID against every connected API.
                </p>
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>System IDs</Label>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => void handlePullAllSystems(false)}
                    disabled={!isConnected || systemsQuery.isFetching || listAllSidsMutation.isPending}
                    className="whitespace-nowrap"
                  >
                    {systemsQuery.isFetching ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Pull SIDs
                  </Button>
                  {connections.length > 1 && (
                    <Button
                      variant="outline"
                      onClick={() => void handlePullAllSystems(true)}
                      disabled={!isConnected || systemsQuery.isFetching || listAllSidsMutation.isPending}
                      className="whitespace-nowrap"
                    >
                      {listAllSidsMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Pull SIDs (All Profiles)
                    </Button>
                  )}
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
                    disabled={bulkSystemIds.length === 0}
                    onClick={() => {
                      setBulkSystemIds([]);
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
                  Source: {bulkSourceFileName ?? "None"}{bulkSystemIds.length > 0 ? ` — ${NUMBER_FORMATTER.format(bulkSystemIds.length)} IDs` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  "Pull SIDs" imports System IDs only. Run the bulk snapshot action to populate result rows.
                </p>
                {bulkImportError ? <p className="text-xs text-destructive">{bulkImportError}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runBulkSnapshot} disabled={bulkIsRunning || bulkSystemIds.length === 0 || !isConnected}>
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
                onClick={() => downloadBulkCsv(bulkRows, "apsystems-production-bulk-all")}
              >
                Download All CSV
              </Button>
              <Button
                variant="outline"
                disabled={filteredBulkRows.length === 0}
                onClick={() => downloadBulkCsv(filteredBulkRows, "apsystems-production-bulk-filtered")}
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
                  Progress: {NUMBER_FORMATTER.format(bulkProgress.processed)} / {NUMBER_FORMATTER.format(bulkProgress.total)} System IDs
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
                <p className="text-xs text-muted-foreground">Imported System IDs</p>
                <p className="text-xl font-semibold text-foreground">{NUMBER_FORMATTER.format(bulkSystemIds.length)}</p>
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
                  placeholder="Filter by System ID or error"
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
                  <TableHead>System ID</TableHead>
                  <TableHead>System Name</TableHead>
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
                  <TableRow key={row.systemId}>
                    <TableCell className="font-medium font-mono text-xs">{row.systemId}</TableCell>
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
