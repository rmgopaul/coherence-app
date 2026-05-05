import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Database,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { MeterReadConnectionProbe } from "../../components/MeterReadConnectionProbe";
import {
  PersistConfirmation,
  readMeterLifetimeKwh,
  readMeterName,
  readMeterStatus,
} from "../../components/PersistConfirmation";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import { useSolarRecPermission } from "../../hooks/useSolarRecPermission";
import {
  clean,
  downloadTextFile,
  formatKwh,
  toErrorMessage,
} from "@/lib/helpers";
import {
  buildConvertedReadRow,
  pushConvertedReadsToRecDashboard,
  type ConvertedReadRow,
} from "@/lib/convertedReads";

type HoymilesProfile = {
  id: string;
  credentialId: string | null;
  sourceConnectionId: string | null;
  name: string;
  usernameMasked: string;
  hasPassword: boolean;
  baseUrl: string | null;
  updatedAt: string | null;
  isActive?: boolean;
};

type StationRow = {
  stationId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
  connectionId?: string;
  connectionName?: string;
};

type SnapshotRow = {
  stationId: string;
  name: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh: number | null;
  monthlyProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string;
  error: string | null;
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  profileStatusSummary: string;
};

type PushStatus =
  | { state: "idle" }
  | { state: "pushing" }
  | { state: "ok"; pushed: number; skipped: number; message?: string }
  | { state: "error"; message: string };

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
const STATION_TABLE_LIMIT = 250;
const BULK_TABLE_LIMIT = 500;
const BULK_BATCH_SIZE_ACTIVE = 100;
const BULK_BATCH_SIZE_ALL_PROFILES = 25;

type BulkStatusFilter = "All" | "Found" | "Not Found" | "Error";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStation(raw: unknown): StationRow {
  const row = readRecord(raw);
  const stationId = readString(row.stationId) ?? readString(row.id) ?? "";
  return {
    stationId,
    name: readString(row.name) ?? `Station ${stationId}`,
    capacity: readNumber(row.capacity),
    address: readString(row.address),
    status: readString(row.status),
    connectionId: readString(row.connectionId) ?? undefined,
    connectionName: readString(row.connectionName) ?? undefined,
  };
}

function normalizeSnapshotRow(
  raw: unknown,
  fallbackStationId = ""
): SnapshotRow {
  const row = readRecord(raw);
  const stationId =
    readString(row.stationId) ?? readString(row.siteId) ?? fallbackStationId;
  const statusRaw = readString(row.status);
  const status =
    statusRaw === "Not Found" || statusRaw === "Error" ? statusRaw : "Found";
  return {
    stationId,
    name: readString(row.name) ?? readString(row.siteName),
    status,
    found: row.found === false ? false : status === "Found",
    lifetimeKwh: readNumber(row.lifetimeKwh),
    monthlyProductionKwh: readNumber(row.monthlyProductionKwh),
    last12MonthsProductionKwh: readNumber(row.last12MonthsProductionKwh),
    dailyProductionKwh: readNumber(row.dailyProductionKwh),
    anchorDate: readString(row.anchorDate) ?? todayIso(),
    error: readString(row.error) ?? readString(row.errorMessage),
    matchedConnectionId: readString(row.matchedConnectionId),
    matchedConnectionName: readString(row.matchedConnectionName),
    checkedConnections: readNumber(row.checkedConnections) ?? 1,
    foundInConnections: readNumber(row.foundInConnections) ?? 0,
    profileStatusSummary: readString(row.profileStatusSummary) ?? "",
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const normalized = String(value);
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function buildCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>
): string {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') {
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
      if (row.some(entry => clean(entry))) matrix.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some(entry => clean(entry))) matrix.push(row);
  return { headers: matrix[0] ?? [], rows: matrix.slice(1) };
}

function parseStationIds(value: string): string[] {
  const byKey = new Map<string, string>();
  value
    .split(/[\n,;\t ]+/)
    .map(clean)
    .filter(Boolean)
    .forEach(stationId => {
      const key = stationId.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, stationId);
    });
  return Array.from(byKey.values());
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [values];
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    output.push(values.slice(index, index + chunkSize));
  }
  return output;
}

function extractStationIdsFromCsv(text: string): string[] {
  const preferredHeaders = new Set(["stationid", "station_id", "id"]);
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) return parseStationIds(text);

  const normalizedHeaders = parsed.headers.map(header =>
    clean(header).toLowerCase().replace(/\s+/g, "_")
  );
  const matchedIndex = normalizedHeaders.findIndex(header =>
    preferredHeaders.has(header)
  );
  const targetIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const values = parsed.rows
    .map(row => clean(row[targetIndex]))
    .filter(Boolean);

  if (parsed.rows.length === 0 && parsed.headers.length === 1) {
    values.unshift(clean(parsed.headers[0]));
  }

  return parseStationIds(values.join("\n"));
}

function buildSnapshotCsv(rows: SnapshotRow[]): string {
  const headers = [
    "station_id",
    "name",
    "status",
    "lifetime_kwh",
    "daily_production_kwh",
    "monthly_production_kwh",
    "last_12_months_production_kwh",
    "anchor_date",
    "matched_connection_id",
    "matched_connection_name",
    "checked_connections",
    "profile_status_summary",
    "error",
  ];
  return `${buildCsv(
    headers,
    rows.map(row => ({
      station_id: row.stationId,
      name: row.name,
      status: row.status,
      lifetime_kwh: row.lifetimeKwh,
      daily_production_kwh: row.dailyProductionKwh,
      monthly_production_kwh: row.monthlyProductionKwh,
      last_12_months_production_kwh: row.last12MonthsProductionKwh,
      anchor_date: row.anchorDate,
      matched_connection_id: row.matchedConnectionId,
      matched_connection_name: row.matchedConnectionName,
      checked_connections: row.checkedConnections,
      profile_status_summary: row.profileStatusSummary,
      error: row.error,
    }))
  )}\n`;
}

function rowsToConvertedReads(rows: SnapshotRow[]): ConvertedReadRow[] {
  return rows
    .filter(row => row.found && row.lifetimeKwh !== null && row.stationId)
    .map(row =>
      buildConvertedReadRow(
        MONITORING_CANONICAL_NAMES.hoymiles,
        row.stationId,
        row.name ?? "",
        row.lifetimeKwh as number,
        row.anchorDate
      )
    );
}

function buildConvertedReadsCsv(rows: SnapshotRow[]): string {
  const headers = [
    "monitoring",
    "monitoring_system_id",
    "monitoring_system_name",
    "lifetime_meter_read_wh",
    "status",
    "alert_severity",
    "read_date",
  ];
  const csvRows: Array<Record<string, string>> = [];
  for (const base of rowsToConvertedReads(rows)) {
    csvRows.push({
      ...base,
      monitoring_system_id: "",
    });
    csvRows.push({
      ...base,
      monitoring_system_name: "",
    });
  }
  return `${buildCsv(headers, csvRows)}\n`;
}

function statusVariant(status: string) {
  if (status === "Found") return "default" as const;
  if (status === "Error") return "destructive" as const;
  return "outline" as const;
}

export default function HoymilesMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.hoymiles.getStatus.useQuery(undefined, {
    retry: false,
  });
  const pushConvertedReads =
    trpc.solarRecDashboard.pushConvertedReadsSource.useMutation();
  const listAllStationsMutation = trpc.hoymiles.listAllStations.useMutation();
  const singleSnapshotMutation =
    trpc.hoymiles.getProductionSnapshot.useMutation();
  const bulkSnapshotMutation =
    trpc.hoymiles.getProductionSnapshots.useMutation();

  const profiles = (statusQuery.data?.profiles ??
    statusQuery.data?.connections ??
    []) as HoymilesProfile[];

  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [stations, setStations] = useState<StationRow[]>([]);
  const [stationId, setStationId] = useState("");
  const [singleAnchorDate, setSingleAnchorDate] = useState(todayIso);
  const [singleScope, setSingleScope] = useState<"active" | "all">("active");
  const [singleResult, setSingleResult] = useState<SnapshotRow | null>(null);
  const [showPersist, setShowPersist] = useState(false);
  const [bulkStationIds, setBulkStationIds] = useState("");
  const [bulkAnchorDate, setBulkAnchorDate] = useState(todayIso);
  const [bulkScope, setBulkScope] = useState<"active" | "all">("active");
  const [bulkRows, setBulkRows] = useState<SnapshotRow[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({
    total: 0,
    processed: 0,
    found: 0,
    notFound: 0,
    errored: 0,
  });
  const [bulkStatusFilter, setBulkStatusFilter] =
    useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [pushStatus, setPushStatus] = useState<PushStatus>({ state: "idle" });
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const bulkCancelRef = useRef(false);
  const listStationsQuery = trpc.hoymiles.listStations.useQuery(
    { connectionId: selectedConnectionId || undefined },
    { enabled: false, retry: false }
  );

  useEffect(() => {
    if (!selectedConnectionId && profiles.length > 0) {
      setSelectedConnectionId(
        statusQuery.data?.activeConnectionId ?? profiles[0].id
      );
    }
  }, [profiles, selectedConnectionId, statusQuery.data?.activeConnectionId]);

  const selectedProfile =
    profiles.find(profile => profile.id === selectedConnectionId) ??
    profiles[0] ??
    null;

  const bulkSummary = useMemo(
    () => ({
      total: bulkRows.length,
      found: bulkRows.filter(row => row.status === "Found").length,
      notFound: bulkRows.filter(row => row.status === "Not Found").length,
      errored: bulkRows.filter(row => row.status === "Error").length,
      eligible: rowsToConvertedReads(bulkRows).length,
    }),
    [bulkRows]
  );

  const filteredBulkRows = useMemo(() => {
    const query = bulkSearch.trim().toLowerCase();
    return bulkRows.filter(row => {
      if (bulkStatusFilter !== "All" && row.status !== bulkStatusFilter) {
        return false;
      }
      if (!query) return true;
      return [
        row.stationId,
        row.name,
        row.matchedConnectionName,
        row.error,
        row.profileStatusSummary,
      ]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(query));
    });
  }, [bulkRows, bulkSearch, bulkStatusFilter]);

  const probeFn = useCallback(async () => {
    if (!selectedProfile) return 0;
    const result = await listStationsQuery.refetch({ throwOnError: true });
    return (result.data?.stations ?? []).length;
  }, [listStationsQuery, selectedProfile]);

  const refreshSelectedStations = async () => {
    if (!selectedProfile) {
      toast.error("Select a Hoymiles profile first.");
      return;
    }
    try {
      const result = await listStationsQuery.refetch({ throwOnError: true });
      const data = result.data;
      const rows = ((data?.stations ?? []) as unknown[]).map(normalizeStation);
      setStations(rows);
      setResultTitle("Selected Profile Stations");
      setResultText(JSON.stringify(data, null, 2));
      toast.success(
        `Loaded ${NUMBER_FORMATTER.format(rows.length)} Hoymiles stations.`
      );
    } catch (error) {
      toast.error(`Station discovery failed: ${toErrorMessage(error)}`);
    }
  };

  const refreshAllStations = async () => {
    try {
      const result = await listAllStationsMutation.mutateAsync();
      const rows = ((result.stations ?? []) as unknown[]).map(normalizeStation);
      setStations(rows);
      if (rows.length > 0) {
        setBulkStationIds(rows.map(row => row.stationId).join("\n"));
      }
      setResultTitle("All Profile Stations");
      setResultText(JSON.stringify(result, null, 2));
      toast.success(
        `Loaded ${NUMBER_FORMATTER.format(rows.length)} unique Hoymiles stations.`
      );
    } catch (error) {
      toast.error(`All-profile discovery failed: ${toErrorMessage(error)}`);
    }
  };

  const runSingleSnapshot = async () => {
    const trimmed = stationId.trim();
    if (!trimmed) {
      toast.error("Enter a station ID.");
      return;
    }
    if (singleScope === "active" && !selectedProfile) {
      toast.error("Select a Hoymiles profile first.");
      return;
    }

    try {
      const result = await singleSnapshotMutation.mutateAsync({
        stationId: trimmed,
        connectionId:
          singleScope === "active" ? selectedProfile?.id : undefined,
        connectionScope: singleScope,
        anchorDate: singleAnchorDate || undefined,
      });
      const row = normalizeSnapshotRow(result, trimmed);
      setSingleResult(row);
      setBulkRows([row]);
      setShowPersist(true);
      setPushStatus({ state: "idle" });
      setResultTitle("Production Snapshot");
      setResultText(JSON.stringify(result, null, 2));
      toast.success(`Loaded Hoymiles snapshot for ${trimmed}.`);
    } catch (error) {
      toast.error(`Snapshot failed: ${toErrorMessage(error)}`);
    }
  };

  const runBulkSnapshots = async () => {
    const stationIds = parseStationIds(bulkStationIds);
    if (stationIds.length === 0) {
      toast.error(
        "Enter station IDs, upload a CSV, or pull stations from API."
      );
      return;
    }
    if (bulkScope === "active" && !selectedProfile) {
      toast.error("Select a Hoymiles profile first.");
      return;
    }

    setBulkRows([]);
    setBulkRunning(true);
    bulkCancelRef.current = false;
    setBulkProgress({
      total: stationIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });
    setPushStatus({ state: "idle" });

    const chunks = chunkArray(
      stationIds,
      bulkScope === "all"
        ? BULK_BATCH_SIZE_ALL_PROFILES
        : BULK_BATCH_SIZE_ACTIVE
    );
    const collectedRows: SnapshotRow[] = [];
    let found = 0;
    let notFound = 0;
    let errored = 0;

    try {
      for (const chunk of chunks) {
        if (bulkCancelRef.current) break;
        const result = await bulkSnapshotMutation.mutateAsync({
          stationIds: chunk,
          connectionId:
            bulkScope === "active" ? selectedProfile?.id : undefined,
          connectionScope: bulkScope,
          anchorDate: bulkAnchorDate || undefined,
        });
        const rows = ((result.rows ?? []) as unknown[]).map(row =>
          normalizeSnapshotRow(row)
        );
        collectedRows.push(...rows);
        found += rows.filter(row => row.status === "Found").length;
        notFound += rows.filter(row => row.status === "Not Found").length;
        errored += rows.filter(row => row.status === "Error").length;
        setBulkRows([...collectedRows]);
        setBulkProgress({
          total: stationIds.length,
          processed: collectedRows.length,
          found,
          notFound,
          errored,
        });
      }

      setBulkStationIds(collectedRows.map(row => row.stationId).join("\n"));
      setResultTitle("Bulk Production Snapshots");
      setResultText(
        JSON.stringify(
          {
            total: collectedRows.length,
            found,
            notFound,
            errored,
            stopped: bulkCancelRef.current,
            rows: collectedRows,
          },
          null,
          2
        )
      );

      if (bulkCancelRef.current) {
        toast.message(
          `Stopped Hoymiles bulk snapshots after ${NUMBER_FORMATTER.format(
            collectedRows.length
          )} of ${NUMBER_FORMATTER.format(stationIds.length)} stations.`
        );
      } else {
        toast.success(
          `Completed Hoymiles bulk snapshots: ${found} found, ${notFound} not found, ${errored} errors.`
        );
        await pushRowsToConvertedReads(collectedRows);
      }
    } catch (error) {
      toast.error(`Bulk snapshots failed: ${toErrorMessage(error)}`);
    } finally {
      setBulkRunning(false);
    }
  };

  const pushRowsToConvertedReads = async (rows: SnapshotRow[]) => {
    const convertedRows = rowsToConvertedReads(rows);
    if (convertedRows.length === 0) {
      setPushStatus({
        state: "ok",
        pushed: 0,
        skipped: 0,
        message: "No Found rows with lifetime kWh to push.",
      });
      return;
    }
    setPushStatus({ state: "pushing" });
    try {
      const result = await pushConvertedReadsToRecDashboard(
        input => pushConvertedReads.mutateAsync(input),
        convertedRows,
        MONITORING_CANONICAL_NAMES.hoymiles
      );
      setPushStatus({
        state: "ok",
        pushed: result.pushed,
        skipped: result.skipped,
      });
      toast.success(
        `Pushed ${NUMBER_FORMATTER.format(result.pushed)} Hoymiles row${
          result.pushed === 1 ? "" : "s"
        } to Converted Reads.`
      );
    } catch (error) {
      setPushStatus({ state: "error", message: toErrorMessage(error) });
      toast.error(`Converted Reads push failed: ${toErrorMessage(error)}`);
    }
  };

  const handleCsvUpload = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const ids = extractStationIdsFromCsv(text);
      if (ids.length === 0) {
        toast.error("No station IDs found in that CSV.");
        return;
      }
      setBulkStationIds(ids.join("\n"));
      toast.success(
        `Imported ${NUMBER_FORMATTER.format(ids.length)} station IDs.`
      );
    } catch (error) {
      toast.error(`CSV import failed: ${toErrorMessage(error)}`);
    }
  };

  const handleDownloadSnapshots = () => {
    if (bulkRows.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(
      `hoymiles-snapshots-${stamp}.csv`,
      buildSnapshotCsv(bulkRows)
    );
  };

  const handleDownloadConvertedReads = () => {
    const rows = rowsToConvertedReads(bulkRows);
    if (rows.length === 0) {
      toast.error("No Converted Reads rows are available to download.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(
      `hoymiles-converted-reads-${stamp}.csv`,
      buildConvertedReadsCsv(bulkRows)
    );
    toast.success(
      `Downloaded ${NUMBER_FORMATTER.format(rows.length * 2)} Converted Reads rows.`
    );
  };

  const visibleStations = stations.slice(0, STATION_TABLE_LIMIT);
  const visibleBulkRows = filteredBulkRows.slice(0, BULK_TABLE_LIMIT);
  const canRun =
    statusQuery.data?.connected === true && Boolean(selectedProfile);
  const isStationLoading =
    listAllStationsMutation.isPending || listStationsQuery.isFetching;
  const isSnapshotRunning = singleSnapshotMutation.isPending || bulkRunning;
  const bulkProgressPercent =
    bulkProgress.total > 0
      ? Math.round((bulkProgress.processed / bulkProgress.total) * 100)
      : 0;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Hoymiles S-Miles Cloud</h1>
          <p className="text-sm text-muted-foreground">
            Run station reads from one saved profile or search across every
            Hoymiles profile in Solar REC team credentials.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          {statusQuery.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between gap-3">
            <span>Connection</span>
            {statusQuery.data?.connected ? (
              <Badge>Connected</Badge>
            ) : (
              <Badge variant="outline">Not connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {statusQuery.data?.connected
              ? `${statusQuery.data.connectionCount} Hoymiles profile${
                  statusQuery.data.connectionCount === 1 ? "" : "s"
                } available.`
              : "Add a Hoymiles username and password in Solar REC Settings > API Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="space-y-1">
              <Label htmlFor="hoymiles-profile">API profile</Label>
              <Select
                value={selectedProfile?.id ?? ""}
                onValueChange={value => {
                  setSelectedConnectionId(value);
                  setStations([]);
                  setSingleResult(null);
                }}
                disabled={profiles.length === 0}
              >
                <SelectTrigger id="hoymiles-profile">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map(profile => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <MeterReadConnectionProbe
              runProbe={probeFn}
              sampleNoun="stations"
              disabled={!canRun || listStationsQuery.isFetching}
            />
          </div>
          {selectedProfile && (
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Profile</div>
                <div className="font-medium">{selectedProfile.name}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Username</div>
                <div className="font-mono text-xs">
                  {selectedProfile.usernameMasked}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Base URL</div>
                <div className="truncate">
                  {selectedProfile.baseUrl ?? "Hoymiles default"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Updated</div>
                <div>
                  {selectedProfile.updatedAt
                    ? new Date(selectedProfile.updatedAt).toLocaleString()
                    : ""}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Stations</CardTitle>
              <CardDescription>
                Discover station IDs from the selected profile or all saved
                profiles.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshSelectedStations()}
                disabled={!canRun || isStationLoading}
              >
                {isStationLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Fetch selected
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshAllStations()}
                disabled={!statusQuery.data?.connected || isStationLoading}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Fetch all profiles
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {stations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No stations loaded yet.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {NUMBER_FORMATTER.format(stations.length)} station
                  {stations.length === 1 ? "" : "s"} loaded
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setBulkStationIds(
                      stations.map(row => row.stationId).join("\n")
                    )
                  }
                >
                  Use for bulk
                </Button>
              </div>
              <div className="max-h-[380px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Station ID</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Profile</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleStations.map(station => (
                      <TableRow
                        key={`${station.connectionId ?? "active"}:${station.stationId}`}
                      >
                        <TableCell className="font-mono text-xs">
                          {station.stationId}
                        </TableCell>
                        <TableCell>{station.name}</TableCell>
                        <TableCell>{station.connectionName ?? ""}</TableCell>
                        <TableCell>{station.status ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {stations.length > STATION_TABLE_LIMIT && (
                <p className="text-xs text-muted-foreground">
                  Showing first {STATION_TABLE_LIMIT.toLocaleString()} stations.
                  Use bulk input or CSV export for the full set.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Production Snapshot</CardTitle>
          <CardDescription>
            Pull one station from the selected profile or search every saved
            profile for a match.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px]">
            <div className="space-y-1">
              <Label htmlFor="hoymiles-station-id">Station ID</Label>
              <Input
                id="hoymiles-station-id"
                value={stationId}
                onChange={event => setStationId(event.target.value)}
                placeholder="e.g. 1234567"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hoymiles-single-date">Anchor date</Label>
              <Input
                id="hoymiles-single-date"
                type="date"
                value={singleAnchorDate}
                onChange={event => setSingleAnchorDate(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hoymiles-single-scope">Scope</Label>
              <Select
                value={singleScope}
                onValueChange={value =>
                  setSingleScope(value as "active" | "all")
                }
              >
                <SelectTrigger id="hoymiles-single-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Selected profile</SelectItem>
                  <SelectItem value="all">All profiles</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            onClick={() => void runSingleSnapshot()}
            disabled={
              !canEdit ||
              !statusQuery.data?.connected ||
              !stationId.trim() ||
              isSnapshotRunning
            }
          >
            {singleSnapshotMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run snapshot
          </Button>
          {singleResult && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(singleResult.status)}>
                  {singleResult.status}
                </Badge>
                <span className="font-medium">
                  {singleResult.name ?? singleResult.stationId}
                </span>
                {singleResult.matchedConnectionName && (
                  <span className="text-muted-foreground">
                    {singleResult.matchedConnectionName}
                  </span>
                )}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-muted-foreground">Lifetime</div>
                  <div>{formatKwh(singleResult.lifetimeKwh)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Today</div>
                  <div>{formatKwh(singleResult.dailyProductionKwh)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Month</div>
                  <div>{formatKwh(singleResult.monthlyProductionKwh)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Last 12 mo.
                  </div>
                  <div>{formatKwh(singleResult.last12MonthsProductionKwh)}</div>
                </div>
              </div>
              {singleResult.error && (
                <p className="mt-2 text-destructive">{singleResult.error}</p>
              )}
            </div>
          )}
          {singleResult && showPersist && (
            <PersistConfirmation
              providerKey="hoymiles"
              providerLabel={MONITORING_CANONICAL_NAMES.hoymiles}
              rows={
                readMeterStatus(singleResult) === "Found" &&
                readMeterLifetimeKwh(singleResult) !== null
                  ? [
                      {
                        monitoring: MONITORING_CANONICAL_NAMES.hoymiles,
                        monitoring_system_id: singleResult.stationId,
                        monitoring_system_name:
                          readMeterName(singleResult) ?? singleResult.stationId,
                        lifetime_meter_read_wh: String(
                          Math.round(
                            (readMeterLifetimeKwh(singleResult) ?? 0) * 1000
                          )
                        ),
                        read_date: singleResult.anchorDate,
                        status: "",
                        alert_severity: "",
                      },
                    ]
                  : []
              }
              onDiscard={() => setShowPersist(false)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bulk Station Reads</CardTitle>
          <CardDescription>
            Paste station IDs, upload a CSV, or use discovered stations, then
            save Found rows into Converted Reads.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px]">
            <div className="space-y-1">
              <Label htmlFor="hoymiles-bulk-ids">Station IDs</Label>
              <Textarea
                id="hoymiles-bulk-ids"
                value={bulkStationIds}
                onChange={event => setBulkStationIds(event.target.value)}
                className="min-h-[160px] font-mono text-xs"
                placeholder="One station ID per line"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hoymiles-bulk-date">Anchor date</Label>
              <Input
                id="hoymiles-bulk-date"
                type="date"
                value={bulkAnchorDate}
                onChange={event => setBulkAnchorDate(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hoymiles-bulk-scope">Scope</Label>
              <Select
                value={bulkScope}
                onValueChange={value => setBulkScope(value as "active" | "all")}
              >
                <SelectTrigger id="hoymiles-bulk-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Selected profile</SelectItem>
                  <SelectItem value="all">All profiles</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById("hoymiles-csv")?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              Upload CSV
            </Button>
            <input
              id="hoymiles-csv"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={event => {
                void handleCsvUpload(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const ids = stations.map(row => row.stationId);
                if (ids.length === 0) {
                  toast.error("Fetch stations first.");
                  return;
                }
                setBulkStationIds(ids.join("\n"));
              }}
              disabled={stations.length === 0}
            >
              Use loaded stations
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshAllStations()}
              disabled={!statusQuery.data?.connected || isStationLoading}
            >
              Pull all from API
            </Button>
            <Button
              size="sm"
              onClick={() => void runBulkSnapshots()}
              disabled={
                !canEdit ||
                !statusQuery.data?.connected ||
                parseStationIds(bulkStationIds).length === 0 ||
                bulkRunning
              }
            >
              {bulkRunning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run bulk snapshots
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                bulkCancelRef.current = true;
              }}
              disabled={!bulkRunning}
            >
              Stop
            </Button>
          </div>

          {bulkRunning && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {NUMBER_FORMATTER.format(bulkProgress.processed)} /{" "}
                  {NUMBER_FORMATTER.format(bulkProgress.total)} stations
                  processed
                </span>
                <span>
                  {NUMBER_FORMATTER.format(bulkProgress.found)} found,{" "}
                  {NUMBER_FORMATTER.format(bulkProgress.notFound)} not found,{" "}
                  {NUMBER_FORMATTER.format(bulkProgress.errored)} errors
                </span>
              </div>
              <Progress value={bulkProgressPercent} />
            </div>
          )}

          {bulkRows.length > 0 && (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-5">
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Total</div>
                  <div className="text-lg font-semibold">
                    {NUMBER_FORMATTER.format(bulkSummary.total)}
                  </div>
                </div>
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Found</div>
                  <div className="text-lg font-semibold">
                    {NUMBER_FORMATTER.format(bulkSummary.found)}
                  </div>
                </div>
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Not Found</div>
                  <div className="text-lg font-semibold">
                    {NUMBER_FORMATTER.format(bulkSummary.notFound)}
                  </div>
                </div>
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Errors</div>
                  <div className="text-lg font-semibold">
                    {NUMBER_FORMATTER.format(bulkSummary.errored)}
                  </div>
                </div>
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">
                    Converted Reads
                  </div>
                  <div className="text-lg font-semibold">
                    {NUMBER_FORMATTER.format(bulkSummary.eligible)}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadSnapshots}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download snapshots
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadConvertedReads}
                  disabled={bulkSummary.eligible === 0}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download Converted Reads
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void pushRowsToConvertedReads(bulkRows)}
                  disabled={
                    bulkSummary.eligible === 0 || pushStatus.state === "pushing"
                  }
                >
                  {pushStatus.state === "pushing" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Database className="mr-2 h-4 w-4" />
                  )}
                  Push Converted Reads
                </Button>
              </div>
              {pushStatus.state === "ok" && (
                <p className="text-sm text-emerald-700">
                  Converted Reads: {NUMBER_FORMATTER.format(pushStatus.pushed)}{" "}
                  pushed, {NUMBER_FORMATTER.format(pushStatus.skipped)} skipped.
                  {pushStatus.message ? ` ${pushStatus.message}` : ""}
                </p>
              )}
              {pushStatus.state === "error" && (
                <p className="text-sm text-destructive">
                  Converted Reads push failed: {pushStatus.message}
                </p>
              )}

              <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="space-y-1">
                  <Label htmlFor="hoymiles-bulk-status">Status filter</Label>
                  <Select
                    value={bulkStatusFilter}
                    onValueChange={value =>
                      setBulkStatusFilter(value as BulkStatusFilter)
                    }
                  >
                    <SelectTrigger id="hoymiles-bulk-status">
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
                <div className="space-y-1">
                  <Label htmlFor="hoymiles-bulk-search">Search results</Label>
                  <Input
                    id="hoymiles-bulk-search"
                    value={bulkSearch}
                    onChange={event => setBulkSearch(event.target.value)}
                    placeholder="Station, name, profile, or error"
                  />
                </div>
              </div>

              <div className="max-h-[460px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Station ID</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Lifetime</TableHead>
                      <TableHead>Profile</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleBulkRows.map(row => (
                      <TableRow
                        key={`${row.stationId}:${row.matchedConnectionId ?? ""}`}
                      >
                        <TableCell className="font-mono text-xs">
                          {row.stationId}
                        </TableCell>
                        <TableCell>{row.name ?? ""}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(row.status)}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatKwh(row.lifetimeKwh)}</TableCell>
                        <TableCell>{row.matchedConnectionName ?? ""}</TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {row.error ?? ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {filteredBulkRows.length > BULK_TABLE_LIMIT && (
                <p className="text-xs text-muted-foreground">
                  Showing first {BULK_TABLE_LIMIT.toLocaleString()} of{" "}
                  {filteredBulkRows.length.toLocaleString()} matching rows.
                  Download the snapshots CSV for the full result set.
                </p>
              )}
            </div>
          )}
          {!canEdit && (
            <p className="text-sm text-amber-700">
              Running snapshots and saving Converted Reads requires edit access
              on meter reads.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Raw Result</CardTitle>
          <CardDescription>{resultTitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-3 text-xs">
            {resultText}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
