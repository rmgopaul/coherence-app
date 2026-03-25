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

const DEFAULT_BASE_URL = "https://monitoringapi.solaredge.com/v2";
const TIME_UNIT_OPTIONS = ["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;
const BULK_BATCH_SIZE_ACTIVE = 200;
const BULK_BATCH_SIZE_ALL_PROFILES = 25;
const BULK_ROWS_RENDER_INTERVAL_ACTIVE = 1;
const BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES = 4;
const BULK_PAGE_SIZE = 25;

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

type TimeUnit = (typeof TIME_UNIT_OPTIONS)[number];
type BulkStatusFilter = "All" | "Found" | "Not Found" | "Error";
type BulkSortKey =
  | "siteId"
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
type DatePreset = "mtd" | "prevMonth" | "last12Months";

type BulkSnapshotRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh: number | null;
  hourlyProductionKwh: number | null;
  monthlyProductionKwh: number | null;
  mtdProductionKwh: number | null;
  previousCalendarMonthProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  weeklyProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string;
  monthlyStartDate: string;
  weeklyStartDate: string;
  mtdStartDate: string;
  previousCalendarMonthStartDate: string;
  previousCalendarMonthEndDate: string;
  last12MonthsStartDate: string;
  error: string | null;
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  profileStatusSummary: string;
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

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function buildCsv(headers: string[], rows: Array<Record<string, string | number | null | undefined>>): string {
  const headerLine = headers.map((header) => csvEscape(header)).join(",");
  const bodyLines = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return [headerLine, ...bodyLines].join("\n");
}

function extractSiteIdsFromCsv(text: string): string[] {
  const parsed = parseCsv(text);
  const normalizedHeaders = parsed.headers.map((header) => clean(header).toLowerCase().replace(/\s+/g, "_"));

  const preferredIndex = normalizedHeaders.findIndex((header) =>
    ["site_id", "siteid", "site", "site_number", "site_number_id", "id"].includes(header)
  );

  if (parsed.headers.length === 1 && preferredIndex === -1) {
    const headerValue = clean(parsed.headers[0]);
    const columnValues = parsed.rows.map((row) => clean(row[parsed.headers[0]])).filter(Boolean);
    const combined = headerValue ? [headerValue, ...columnValues] : columnValues;
    return Array.from(new Set(combined));
  }

  if (preferredIndex >= 0) {
    const siteHeader = parsed.headers[preferredIndex];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[siteHeader]))
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

function toComparableNumber(value: number | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value;
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

export default function SolarEdgeMeterReads() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultStartDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return formatDateInput(date);
  }, []);

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [connectionNameInput, setConnectionNameInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("DAY");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const [bulkAnchorDate, setBulkAnchorDate] = useState(today);
  const [bulkSiteIds, setBulkSiteIds] = useState<string[]>([]);
  const [bulkSourceFileName, setBulkSourceFileName] = useState<string | null>(null);
  const [bulkImportError, setBulkImportError] = useState<string | null>(null);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
  const [bulkStatusFilter, setBulkStatusFilter] = useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkSort, setBulkSort] = useState<BulkSortKey>("siteId");
  const [bulkConnectionScope, setBulkConnectionScope] = useState<BulkConnectionScope>("active");
  const [bulkPage, setBulkPage] = useState(1);
  const bulkCancelRef = useRef(false);

  const applyDatePreset = (preset: DatePreset) => {
    const range = getPresetRange(preset);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  };

  const statusQuery = trpc.solarEdge.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const sitesQuery = trpc.solarEdge.listSites.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.solarEdge.connect.useMutation();
  const setActiveConnectionMutation = trpc.solarEdge.setActiveConnection.useMutation();
  const removeConnectionMutation = trpc.solarEdge.removeConnection.useMutation();
  const disconnectMutation = trpc.solarEdge.disconnect.useMutation();
  const overviewMutation = trpc.solarEdge.getOverview.useMutation();
  const detailsMutation = trpc.solarEdge.getDetails.useMutation();
  const energyMutation = trpc.solarEdge.getEnergy.useMutation();
  const productionReadsMutation = trpc.solarEdge.getProductionMeterReadings.useMutation();
  const metersMutation = trpc.solarEdge.getMeters.useMutation();
  const bulkSnapshotsMutation = trpc.solarEdge.getProductionSnapshots.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.baseUrl) setBaseUrlInput(statusQuery.data.baseUrl);

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
    const firstSite = sitesQuery.data?.sites?.[0];
    if (!firstSite) return;
    if (!selectedSiteId) {
      setSelectedSiteId(firstSite.siteId);
    }
  }, [sitesQuery.data, selectedSiteId]);

  useEffect(() => {
    setBulkPage(1);
  }, [bulkRows.length, bulkSearch, bulkSort, bulkStatusFilter]);

  const handleConnect = async () => {
    const apiKey = apiKeyInput.trim();

    if (!apiKey) {
      toast.error("Enter your SolarEdge API key.");
      return;
    }

    try {
      const response = await connectMutation.mutateAsync({
        apiKey,
        connectionName: connectionNameInput.trim() || undefined,
        baseUrl: baseUrlInput.trim(),
      });
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      setSelectedConnectionId(response.activeConnectionId);
      setApiKeyInput("");
      setConnectionNameInput("");
      toast.success(
        `SolarEdge profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
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
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      setSelectedSiteId("");
      toast.success("Active SolarEdge API profile updated.");
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
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      setSelectedSiteId("");
      setSelectedConnectionId(response.activeConnectionId ?? "");
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : "Removed final profile. SolarEdge is now disconnected."
      );
    } catch (error) {
      toast.error(`Failed to remove profile: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      setSelectedSiteId("");
      setSelectedConnectionId("");
      toast.success("SolarEdge disconnected.");
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

  const handleBulkFileUpload = async (file: File | null) => {
    if (!file) return;
    setBulkImportError(null);

    try {
      const raw = await file.text();
      const siteIds = extractSiteIdsFromCsv(raw);
      if (siteIds.length === 0) {
        setBulkImportError("No valid site IDs found in CSV.");
        setBulkSiteIds([]);
        setBulkSourceFileName(file.name);
        return;
      }

      setBulkSourceFileName(file.name);
      setBulkSiteIds(siteIds);
      setBulkRows([]);
      setBulkProgress({ total: siteIds.length, processed: 0, found: 0, notFound: 0, errored: 0 });
      toast.success(`Imported ${NUMBER_FORMATTER.format(siteIds.length)} site IDs.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse CSV.";
      setBulkImportError(message);
      setBulkSiteIds([]);
    }
  };

  const runBulkSnapshot = async () => {
    if (!statusQuery.data?.connected) {
      toast.error("Connect SolarEdge before running bulk processing.");
      return;
    }
    if (bulkSiteIds.length === 0) {
      toast.error("Upload a CSV with site IDs first.");
      return;
    }

    setBulkIsRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    const effectiveBatchSize =
      bulkConnectionScope === "all" ? BULK_BATCH_SIZE_ALL_PROFILES : BULK_BATCH_SIZE_ACTIVE;
    const rowRenderInterval =
      bulkConnectionScope === "all" ? BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES : BULK_ROWS_RENDER_INTERVAL_ACTIVE;
    const chunks = chunkArray(bulkSiteIds, effectiveBatchSize);
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;
    const collectedRows: BulkSnapshotRow[] = [];
    setBulkProgress({
      total: bulkSiteIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        if (bulkCancelRef.current) break;

        const response = await bulkSnapshotsMutation.mutateAsync({
          siteIds: chunk,
          anchorDate: bulkAnchorDate,
          connectionScope: bulkConnectionScope,
        });

        collectedRows.push(...response.rows);
        processed += response.total;
        found += response.found;
        notFound += response.notFound;
        errored += response.errored;

        setBulkProgress({
          total: bulkSiteIds.length,
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
          `Stopped after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkSiteIds.length)} site IDs.`
        );
      } else {
        toast.success(
          `Completed ${NUMBER_FORMATTER.format(processed)} site IDs using ${bulkConnectionScope === "all" ? "all saved API profiles" : "active API profile"}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );
      }
    } catch (error) {
      toast.error(`Bulk processing failed: ${toErrorMessage(error)}`);
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
      const haystack = `${row.siteId} ${row.status} ${row.error ?? ""}`.toLowerCase();
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
        case "siteId":
        default:
          return a.siteId.localeCompare(b.siteId, undefined, { numeric: true, sensitivity: "base" });
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

  const downloadBulkCsv = (rows: BulkSnapshotRow[], fileNamePrefix: string) => {
    if (rows.length === 0) {
      toast.error("No rows available to export.");
      return;
    }

    const headers = [
      "site_id",
      "status",
      "found",
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
      "error",
      "matched_connection_id",
      "matched_connection_name",
      "checked_connections",
      "found_in_connections",
      "profile_status_summary",
    ];

    const csvRows = rows.map((row) => ({
      site_id: row.siteId,
      status: row.status,
      found: row.found ? "Yes" : "No",
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
      error: row.error,
      matched_connection_id: row.matchedConnectionId,
      matched_connection_name: row.matchedConnectionName,
      checked_connections: row.checkedConnections,
      found_in_connections: row.foundInConnections,
      profile_status_summary: row.profileStatusSummary,
    }));

    const csvText = buildCsv(headers, csvRows);
    const fileName = `${fileNamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csvText, "text/csv;charset=utf-8");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  const sites = sitesQuery.data?.sites ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const connections = statusQuery.data?.connections ?? [];
  const activeConnection = connections.find((connection) => connection.isActive);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const sitesError = sitesQuery.error ? toErrorMessage(sitesQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">SolarEdge Monitoring API</h1>
          <p className="text-sm text-slate-600 mt-1">
            API key connection for current SolarEdge monitoring endpoints, including bulk CSV processing for thousands of sites.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect SolarEdge</CardTitle>
            <CardDescription>
              Save one or more API profiles, switch active profile, and persist keys for future sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="solaredge-connection-name">Profile Name (optional)</Label>
                <Input
                  id="solaredge-connection-name"
                  value={connectionNameInput}
                  onChange={(e) => setConnectionNameInput(e.target.value)}
                  placeholder="Example: Utility Batch A"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="solaredge-api-key">API Key</Label>
                <Input
                  id="solaredge-api-key"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="SolarEdge monitoring API key"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="solaredge-base-url">Base API URL (advanced)</Label>
                <Input
                  id="solaredge-base-url"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                />
              </div>
            </div>

            {connections.length > 0 ? (
              <div className="rounded-lg border bg-slate-50/70 p-4 space-y-3">
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
                            {connection.name} ({connection.apiKeyMasked})
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

                <div className="text-xs text-slate-600">
                  {NUMBER_FORMATTER.format(connections.length)} profile(s) saved. Active profile:{" "}
                  <span className="font-medium text-slate-900">{activeConnection?.name ?? "N/A"}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className={`rounded-md border px-3 py-2 text-xs ${
                        connection.isActive
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-white text-slate-700"
                      }`}
                    >
                      <p className="font-medium">{connection.name}</p>
                      <p>Key: {connection.apiKeyMasked}</p>
                      <p>Base URL: {connection.baseUrl || DEFAULT_BASE_URL}</p>
                      <p>Updated: {new Date(connection.updatedAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {statusError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
                  sitesQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">
                Status: {isConnected ? `Connected (${connections.length} profile${connections.length === 1 ? "" : "s"})` : "Not connected"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Single Site API Tester</CardTitle>
            <CardDescription>
              Pick a site from `/sites/list` or paste one manually, then fetch endpoint responses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>Site</Label>
                <Select value={selectedSiteId} onValueChange={setSelectedSiteId} disabled={!sites.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={sites.length ? "Select a site" : "No sites loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.siteId} value={site.siteId}>
                        {site.siteName} ({site.siteId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-site-id">Manual Site ID (optional)</Label>
                <Input
                  id="manual-site-id"
                  value={selectedSiteId}
                  onChange={(e) => setSelectedSiteId(e.target.value.trim())}
                  placeholder="Paste site ID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="solaredge-time-unit">Time Unit</Label>
                <Select value={timeUnit} onValueChange={(value) => setTimeUnit(value as TimeUnit)}>
                  <SelectTrigger id="solaredge-time-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_UNIT_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
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
              <p className="text-xs text-slate-500">
                MTD = first day of current month through today. Previous Calendar Month = prior month start to end. Last 12
                Months = same day last year through today.
              </p>
            </div>

            {sitesQuery.isLoading && <div className="text-sm text-slate-600">Loading sites...</div>}

            {sitesError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Sites load error: {sitesError}
              </div>
            )}

            {!sitesQuery.isLoading && !sitesError && isConnected && sites.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                No sites were returned for this API key.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Overview", () =>
                    overviewMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Site Overview
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Details", () =>
                    detailsMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Site Details
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Energy", () =>
                    energyMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                      timeUnit,
                    })
                  )
                }
              >
                Fetch Site Energy
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Production Meter Readings", () =>
                    productionReadsMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                      timeUnit,
                    })
                  )
                }
              >
                Fetch Production Meter Readings
              </Button>
              <Button
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Meters", () =>
                    metersMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch Site Meters
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) Bulk CSV Processing</CardTitle>
            <CardDescription>
              Upload a CSV of site IDs, process in batches, and review/export found/not-found status with lifetime plus hourly, monthly, MTD, previous month, last 12 months, weekly, and daily production.
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
                <p className="text-xs text-slate-500">
                  Monthly = last 30 days, MTD = first of current month through anchor day, Previous Month = prior calendar month, Last 12 Months = trailing 12 months ending on anchor day, Weekly = last 7 days, Daily = anchor day.
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
                <p className="text-xs text-slate-500">
                  Use <span className="font-medium">All Saved API Profiles</span> to check each site ID against every connected API.
                </p>
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label htmlFor="bulk-csv-upload">Site IDs CSV</Label>
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
                      setBulkSiteIds([]);
                      setBulkRows([]);
                      setBulkSourceFileName(null);
                      setBulkImportError(null);
                      setBulkProgress({ total: 0, processed: 0, found: 0, notFound: 0, errored: 0 });
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <p className="text-xs text-slate-600">
                  Expected column: <code>site_id</code> (or first column). File: {bulkSourceFileName ?? "None"}
                </p>
                {bulkImportError ? <p className="text-xs text-red-600">{bulkImportError}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runBulkSnapshot} disabled={bulkIsRunning || bulkSiteIds.length === 0 || !isConnected}>
                {bulkIsRunning ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Run Bulk Processing
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
                onClick={() => downloadBulkCsv(bulkRows, "solaredge-production-bulk-all")}
              >
                Download All CSV
              </Button>
              <Button
                variant="outline"
                disabled={filteredBulkRows.length === 0}
                onClick={() => downloadBulkCsv(filteredBulkRows, "solaredge-production-bulk-filtered")}
              >
                Download Filtered CSV
              </Button>
            </div>

            <div className="rounded-lg border bg-white p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>
                  Progress: {NUMBER_FORMATTER.format(bulkProgress.processed)} / {NUMBER_FORMATTER.format(bulkProgress.total)} site IDs
                </span>
                <span>{bulkProgressPercent.toFixed(1)}%</span>
              </div>
              <Progress value={bulkProgressPercent} />
              <p className="text-xs text-slate-500">
                Update cadence:{" "}
                {bulkConnectionScope === "all"
                  ? `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ALL_PROFILES)} sites per request (all API profiles).`
                  : `${NUMBER_FORMATTER.format(BULK_BATCH_SIZE_ACTIVE)} sites per request (active API profile).`}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Imported Site IDs</p>
                <p className="text-xl font-semibold text-slate-900">{NUMBER_FORMATTER.format(bulkSiteIds.length)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Processed</p>
                <p className="text-xl font-semibold text-slate-900">{NUMBER_FORMATTER.format(bulkProgress.processed)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Found</p>
                <p className="text-xl font-semibold text-emerald-700">{NUMBER_FORMATTER.format(bulkProgress.found)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Not Found</p>
                <p className="text-xl font-semibold text-amber-700">{NUMBER_FORMATTER.format(bulkProgress.notFound)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Errors</p>
                <p className="text-xl font-semibold text-rose-700">{NUMBER_FORMATTER.format(bulkProgress.errored)}</p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="bulk-search">Search</Label>
                <Input
                  id="bulk-search"
                  value={bulkSearch}
                  onChange={(event) => setBulkSearch(event.target.value)}
                  placeholder="Filter by site ID or error"
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
                    <SelectItem value="siteId">Site ID (A-Z)</SelectItem>
                    <SelectItem value="status">Status</SelectItem>
                    <SelectItem value="lifetime">Lifetime (High-Low)</SelectItem>
                    <SelectItem value="hourly">Hourly (High-Low)</SelectItem>
                    <SelectItem value="monthly">Monthly (High-Low)</SelectItem>
                    <SelectItem value="mtd">MTD (High-Low)</SelectItem>
                    <SelectItem value="previousMonth">Previous Month (High-Low)</SelectItem>
                    <SelectItem value="last12Months">Last 12 Months (High-Low)</SelectItem>
                    <SelectItem value="weekly">Weekly (High-Low)</SelectItem>
                    <SelectItem value="daily">Daily (High-Low)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-600">
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
                  <TableHead>Site ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Matched API Profile</TableHead>
                  <TableHead>Found In APIs</TableHead>
                  <TableHead>Lifetime (kWh)</TableHead>
                  <TableHead>Hourly (kWh)</TableHead>
                  <TableHead>Monthly (kWh)</TableHead>
                  <TableHead>MTD (kWh)</TableHead>
                  <TableHead>Previous Month (kWh)</TableHead>
                  <TableHead>Last 12 Months (kWh)</TableHead>
                  <TableHead>Weekly (kWh)</TableHead>
                  <TableHead>Daily (kWh)</TableHead>
                  <TableHead>API Check Summary</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkPageRows.map((row) => (
                  <TableRow key={row.siteId}>
                    <TableCell className="font-medium">{row.siteId}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>{row.matchedConnectionName ?? "N/A"}</TableCell>
                    <TableCell>
                      {NUMBER_FORMATTER.format(row.foundInConnections)} / {NUMBER_FORMATTER.format(row.checkedConnections)}
                    </TableCell>
                    <TableCell>{formatKwh(row.lifetimeKwh)}</TableCell>
                    <TableCell>{formatKwh(row.hourlyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.monthlyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.mtdProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.previousCalendarMonthProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.last12MonthsProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.weeklyProductionKwh)}</TableCell>
                    <TableCell>{formatKwh(row.dailyProductionKwh)}</TableCell>
                    <TableCell className="text-xs text-slate-600">{row.profileStatusSummary}</TableCell>
                    <TableCell className="text-xs text-slate-600">{row.error ?? ""}</TableCell>
                  </TableRow>
                ))}
                {bulkPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={14} className="py-6 text-center text-slate-500">
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

        <Card>
          <CardHeader>
            <CardTitle>4) Raw API Response</CardTitle>
            <CardDescription>{resultTitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-slate-950 text-slate-100 rounded-md p-4 overflow-auto max-h-[480px]">
              {resultText}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
