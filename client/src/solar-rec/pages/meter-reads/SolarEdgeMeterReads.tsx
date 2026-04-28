/**
 * SolarEdge meter-reads on solar-rec.
 *
 * Team credential stores `{apiKey, baseUrl}`; the credential row is
 * also populated with the apiKey in the accessToken column so the
 * Settings → Credentials badge reads "Connected" rather than the
 * misleading "No Token". SolarEdge uniquely exposes three snapshot
 * shapes — production, meter inventory, inverter inventory — and the
 * legacy meter-reads page also supported CSV-driven bulk processing
 * across one or all team profiles. This page restores that surface.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { MeterReadConnectionProbe } from "../../components/MeterReadConnectionProbe";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import { useSolarRecPermission } from "../../hooks/useSolarRecPermission";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Download,
  Loader2,
  Play,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { parseCsvMatrix } from "@/lib/csvParsing";
import { clean, downloadTextFile } from "@/lib/helpers";

type SnapshotKind = "production" | "meter" | "inverter";
type ConnectionScope = "active" | "all";

type ProductionRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  siteName: string | null;
  lifetimeKwh: number | null;
  hourlyProductionKwh: number | null;
  monthlyProductionKwh: number | null;
  mtdProductionKwh: number | null;
  previousCalendarMonthProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  weeklyProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string | null;
  error: string | null;
};

type MeterRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  meterCount: number | null;
  productionMeterCount: number | null;
  consumptionMeterCount: number | null;
  meterTypes: string[];
  error: string | null;
};

type InverterRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  inverterCount: number | null;
  invertersWithTelemetry: number | null;
  inverterFailures: number | null;
  inverterLatestPowerKw: number | null;
  inverterLatestEnergyKwh: number | null;
  firstTelemetryAt: string | null;
  lastTelemetryAt: string | null;
  error: string | null;
};

type BulkProgress = {
  total: number;
  processed: number;
  found: number;
  notFound: number;
  errored: number;
};

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
const BULK_BATCH_ACTIVE = 200;
const BULK_BATCH_ALL_PROFILES = 25;
const SITE_ID_HEADER_KEYS = [
  "siteid",
  "site_id",
  "site",
  "site_number",
  "id",
  "csgid",
  "csg_id",
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function extractSiteIdsFromCsv(text: string): string[] {
  const matrix = parseCsvMatrix(text);
  if (matrix.length === 0) return [];
  const headers = matrix[0].map((h) =>
    clean(h).toLowerCase().replace(/\s+/g, "_")
  );
  const headerIndex = headers.findIndex((h) => SITE_ID_HEADER_KEYS.includes(h));

  // Single-column layout — values may include the header cell as a row.
  if (headers.length === 1) {
    const collected = new Set<string>();
    const headerVal = clean(matrix[0][0]);
    if (
      headerVal &&
      !SITE_ID_HEADER_KEYS.includes(headers[0]) &&
      !/[a-zA-Z]/.test(headerVal) === false
        ? false
        : headerVal && /^\d+$/.test(headerVal)
    ) {
      collected.add(headerVal);
    }
    for (let r = 1; r < matrix.length; r += 1) {
      const v = clean(matrix[r][0]);
      if (v) collected.add(v);
    }
    if (collected.size === 0 && headerVal) collected.add(headerVal);
    return Array.from(collected);
  }

  if (headerIndex >= 0) {
    const out = new Set<string>();
    for (let r = 1; r < matrix.length; r += 1) {
      const v = clean(matrix[r][headerIndex]);
      if (v) out.add(v);
    }
    return Array.from(out);
  }

  // Fallback: take column 0 from data rows.
  const out = new Set<string>();
  for (let r = 1; r < matrix.length; r += 1) {
    const v = clean(matrix[r][0]);
    if (v) out.add(v);
  }
  return Array.from(out);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function buildBulkCsv(
  kind: SnapshotKind,
  rows: ProductionRow[] | MeterRow[] | InverterRow[]
): string {
  if (kind === "production") {
    const header = [
      "site_id",
      "status",
      "matched_connection",
      "site_name",
      "anchor_date",
      "lifetime_kwh",
      "mtd_kwh",
      "previous_month_kwh",
      "last_12_months_kwh",
      "monthly_kwh",
      "weekly_kwh",
      "daily_kwh",
      "hourly_kwh",
      "checked_connections",
      "found_in_connections",
      "error",
    ].join(",");
    const body = (rows as ProductionRow[])
      .map((r) =>
        [
          r.siteId,
          r.status,
          r.matchedConnectionName ?? r.matchedConnectionId ?? "",
          r.siteName ?? "",
          r.anchorDate ?? "",
          r.lifetimeKwh ?? "",
          r.mtdProductionKwh ?? "",
          r.previousCalendarMonthProductionKwh ?? "",
          r.last12MonthsProductionKwh ?? "",
          r.monthlyProductionKwh ?? "",
          r.weeklyProductionKwh ?? "",
          r.dailyProductionKwh ?? "",
          r.hourlyProductionKwh ?? "",
          r.checkedConnections,
          r.foundInConnections,
          r.error ?? "",
        ]
          .map(csvEscape)
          .join(",")
      )
      .join("\n");
    return `${header}\n${body}\n`;
  }
  if (kind === "meter") {
    const header = [
      "site_id",
      "status",
      "matched_connection",
      "meter_count",
      "production_meters",
      "consumption_meters",
      "meter_types",
      "checked_connections",
      "found_in_connections",
      "error",
    ].join(",");
    const body = (rows as MeterRow[])
      .map((r) =>
        [
          r.siteId,
          r.status,
          r.matchedConnectionName ?? r.matchedConnectionId ?? "",
          r.meterCount ?? "",
          r.productionMeterCount ?? "",
          r.consumptionMeterCount ?? "",
          r.meterTypes.join("|"),
          r.checkedConnections,
          r.foundInConnections,
          r.error ?? "",
        ]
          .map(csvEscape)
          .join(",")
      )
      .join("\n");
    return `${header}\n${body}\n`;
  }
  const header = [
    "site_id",
    "status",
    "matched_connection",
    "inverter_count",
    "inverters_with_telemetry",
    "inverter_failures",
    "latest_power_kw",
    "latest_energy_kwh",
    "first_telemetry_at",
    "last_telemetry_at",
    "checked_connections",
    "found_in_connections",
    "error",
  ].join(",");
  const body = (rows as InverterRow[])
    .map((r) =>
      [
        r.siteId,
        r.status,
        r.matchedConnectionName ?? r.matchedConnectionId ?? "",
        r.inverterCount ?? "",
        r.invertersWithTelemetry ?? "",
        r.inverterFailures ?? "",
        r.inverterLatestPowerKw ?? "",
        r.inverterLatestEnergyKwh ?? "",
        r.firstTelemetryAt ?? "",
        r.lastTelemetryAt ?? "",
        r.checkedConnections,
        r.foundInConnections,
        r.error ?? "",
      ]
        .map(csvEscape)
        .join(",")
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

export default function SolarEdgeMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.solaredge.getStatus.useQuery(undefined, {
    retry: false,
  });

  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const effectiveConnectionId =
    selectedConnectionId ||
    statusQuery.data?.activeConnectionId ||
    "";

  const listSitesQuery = trpc.solaredge.listSites.useQuery(
    { connectionId: effectiveConnectionId || undefined },
    {
      enabled: statusQuery.data?.connected === true,
      retry: false,
    }
  );
  // Phase E (2026-04-28) — Test Connection probe times the
  // listSitesQuery refetch as a lightweight credential check.
  const probeFn = useCallback(async () => {
    const r = await listSitesQuery.refetch({ throwOnError: true });
    return r.data?.sites?.length ?? 0;
  }, [listSitesQuery]);

  const productionMutation = trpc.solaredge.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const meterMutation = trpc.solaredge.getMeterSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const inverterMutation = trpc.solaredge.getInverterSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const productionBulk = trpc.solaredge.getProductionSnapshots.useMutation();
  const meterBulk = trpc.solaredge.getMeterSnapshots.useMutation();
  const inverterBulk = trpc.solaredge.getInverterSnapshots.useMutation();
  const debugCredential = trpc.solaredge.debugCredential.useMutation();

  // Single-site snapshot state.
  const [siteId, setSiteId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");
  const [snapshotKind, setSnapshotKind] = useState<SnapshotKind>("production");

  // Bulk processing state.
  const [bulkKind, setBulkKind] = useState<SnapshotKind>("production");
  const [bulkAnchorDate, setBulkAnchorDate] = useState(todayIso());
  const [bulkSiteIds, setBulkSiteIds] = useState<string[]>([]);
  const [bulkSourceFile, setBulkSourceFile] = useState<string | null>(null);
  const [bulkScope, setBulkScope] = useState<ConnectionScope>("active");
  const [bulkRows, setBulkRows] = useState<
    ProductionRow[] | MeterRow[] | InverterRow[]
  >([]);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>({
    total: 0,
    processed: 0,
    found: 0,
    notFound: 0,
    errored: 0,
  });
  const [bulkRunning, setBulkRunning] = useState(false);
  const bulkCancelRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const connections = statusQuery.data?.connections ?? [];

  const activeMutation =
    snapshotKind === "production"
      ? productionMutation
      : snapshotKind === "meter"
        ? meterMutation
        : inverterMutation;

  const runSingleSnapshot = () => {
    const trimmed = siteId.trim();
    if (!trimmed) {
      toast.error("Enter a site ID");
      return;
    }
    const connArg = effectiveConnectionId || undefined;
    if (snapshotKind === "production") {
      productionMutation.mutate({
        siteId: trimmed,
        anchorDate: anchorDate || undefined,
        connectionId: connArg,
      });
    } else if (snapshotKind === "meter") {
      meterMutation.mutate({ siteId: trimmed, connectionId: connArg });
    } else {
      inverterMutation.mutate({
        siteId: trimmed,
        anchorDate: anchorDate || undefined,
        connectionId: connArg,
      });
    }
  };

  const handleCsvUpload = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const ids = extractSiteIdsFromCsv(text);
      if (ids.length === 0) {
        toast.error("No site IDs found in CSV.");
        setBulkSourceFile(file.name);
        setBulkSiteIds([]);
        return;
      }
      setBulkSourceFile(file.name);
      setBulkSiteIds(ids);
      setBulkRows([]);
      setBulkProgress({
        total: ids.length,
        processed: 0,
        found: 0,
        notFound: 0,
        errored: 0,
      });
      toast.success(`Imported ${NUMBER_FORMATTER.format(ids.length)} site IDs.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to read CSV file."
      );
    }
  };

  const cancelBulk = () => {
    bulkCancelRef.current = true;
  };

  const runBulk = async () => {
    if (!statusQuery.data?.connected) {
      toast.error("Connect a SolarEdge credential before running bulk.");
      return;
    }
    if (bulkSiteIds.length === 0) {
      toast.error("Upload a CSV with site IDs first.");
      return;
    }
    setBulkRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    setBulkProgress({
      total: bulkSiteIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });

    const batchSize =
      bulkScope === "all" ? BULK_BATCH_ALL_PROFILES : BULK_BATCH_ACTIVE;
    const chunks = chunkArray(bulkSiteIds, batchSize);
    const collected: (ProductionRow | MeterRow | InverterRow)[] = [];
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;

    try {
      for (const chunk of chunks) {
        if (bulkCancelRef.current) break;
        const baseInput = {
          siteIds: chunk,
          connectionScope: bulkScope,
          connectionId: bulkScope === "active"
            ? effectiveConnectionId || undefined
            : undefined,
        } as const;
        let response: {
          total: number;
          found: number;
          notFound: number;
          errored: number;
          rows: unknown[];
        };
        if (bulkKind === "production") {
          response = await productionBulk.mutateAsync({
            ...baseInput,
            anchorDate: bulkAnchorDate || undefined,
          });
        } else if (bulkKind === "meter") {
          response = await meterBulk.mutateAsync(baseInput);
        } else {
          response = await inverterBulk.mutateAsync({
            ...baseInput,
            anchorDate: bulkAnchorDate || undefined,
          });
        }
        const typedRows = response.rows as (
          | ProductionRow
          | MeterRow
          | InverterRow
        )[];
        collected.push(...typedRows);
        processed += response.total;
        found += response.found;
        notFound += response.notFound;
        errored += response.errored;
        setBulkRows([...collected] as
          | ProductionRow[]
          | MeterRow[]
          | InverterRow[]);
        setBulkProgress({
          total: bulkSiteIds.length,
          processed,
          found,
          notFound,
          errored,
        });
      }
      if (bulkCancelRef.current) {
        toast.info(
          `Cancelled. Processed ${NUMBER_FORMATTER.format(processed)}/${NUMBER_FORMATTER.format(bulkSiteIds.length)}.`
        );
      } else {
        toast.success(
          `Done. ${NUMBER_FORMATTER.format(found)} found, ${NUMBER_FORMATTER.format(notFound)} not found, ${NUMBER_FORMATTER.format(errored)} errored.`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk run failed.");
    } finally {
      setBulkRunning(false);
      bulkCancelRef.current = false;
    }
  };

  const downloadResults = () => {
    if (bulkRows.length === 0) {
      toast.error("Nothing to export yet.");
      return;
    }
    const csv = buildBulkCsv(bulkKind, bulkRows);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`solaredge-${bulkKind}-${stamp}.csv`, csv);
  };

  const progressPct = useMemo(() => {
    if (bulkProgress.total === 0) return 0;
    return Math.round((bulkProgress.processed / bulkProgress.total) * 100);
  }, [bulkProgress]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">SolarEdge</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s SolarEdge credentials.
          Manage API keys in Solar REC Settings → Credentials.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Connection</span>
            {statusQuery.data?.connected ? (
              <Badge variant="default">Connected</Badge>
            ) : (
              <Badge variant="outline">Not connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {statusQuery.data?.connected
              ? `${statusQuery.data.connectionCount} team credential${
                  statusQuery.data.connectionCount === 1 ? "" : "s"
                } registered.`
              : "Ask an admin to register a SolarEdge API key in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="sites"
            disabled={!statusQuery.data?.connected}
          />
          {connections.length > 1 && (
            <div className="space-y-1 max-w-md">
              <Label htmlFor="solaredge-connection">
                Active API profile (single-site + active-scope bulk)
              </Label>
              <Select
                value={effectiveConnectionId}
                onValueChange={(v) => setSelectedConnectionId(v)}
              >
                <SelectTrigger id="solaredge-connection">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name ?? c.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Bulk runs can sweep all profiles; see scope selector below.
              </p>
            </div>
          )}
          <div className="flex items-start gap-3 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                debugCredential.mutate({
                  connectionId: effectiveConnectionId || undefined,
                })
              }
              disabled={
                !statusQuery.data?.connected || debugCredential.isPending
              }
            >
              {debugCredential.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : null}
              Diagnose credential
            </Button>
            {debugCredential.data && (
              <DiagnoseResult data={debugCredential.data} />
            )}
            {debugCredential.error && (
              <span className="text-xs text-destructive">
                {debugCredential.error.message}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            If diagnose returns a 403 with a clean key fingerprint, the most
            common cause is that <strong>API access</strong> isn&rsquo;t
            enabled on the SolarEdge account: log into solaredge.com → Admin →
            Site Access → API Access tab → accept the terms and (re)generate
            the API key.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Discover sites on the active SolarEdge profile.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listSitesQuery.refetch()}
              disabled={
                !statusQuery.data?.connected || listSitesQuery.isFetching
              }
            >
              {listSitesQuery.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!statusQuery.data?.connected ? (
            <p className="text-sm text-muted-foreground">
              Connect a credential first.
            </p>
          ) : listSitesQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listSitesQuery.error ? (
            <p className="text-sm text-destructive">
              {listSitesQuery.error.message}
            </p>
          ) : (listSitesQuery.data?.sites ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites returned by SolarEdge.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-72">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listSitesQuery.data?.sites.map((s) => (
                    <TableRow key={s.siteId}>
                      <TableCell className="font-mono text-xs">
                        <button
                          className="hover:underline"
                          onClick={() => setSiteId(s.siteId)}
                        >
                          {s.siteId}
                        </button>
                      </TableCell>
                      <TableCell>{s.siteName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Single-site snapshot</CardTitle>
          <CardDescription>
            Production gives lifetime + period kWh; meter inventory lists
            production/consumption meters; inverter snapshot reports the
            latest inverter telemetry.
            {!canEdit && (
              <span className="ml-1 text-amber-700">
                You have read-only access; running a snapshot requires{" "}
                <code>edit</code> on <code>meter-reads</code>.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="solaredge-site-id">Site ID</Label>
              <Input
                id="solaredge-site-id"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                placeholder="e.g., 1234567"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="solaredge-snapshot-kind">Snapshot type</Label>
              <Select
                value={snapshotKind}
                onValueChange={(v) => setSnapshotKind(v as SnapshotKind)}
              >
                <SelectTrigger id="solaredge-snapshot-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">Production</SelectItem>
                  <SelectItem value="meter">Meter inventory</SelectItem>
                  <SelectItem value="inverter">Inverter snapshot</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="solaredge-anchor-date">
                Anchor date (production / inverter)
              </Label>
              <Input
                id="solaredge-anchor-date"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                disabled={snapshotKind === "meter"}
              />
            </div>
          </div>
          <Button
            onClick={runSingleSnapshot}
            disabled={
              !canEdit ||
              !siteId.trim() ||
              activeMutation.isPending ||
              !statusQuery.data?.connected
            }
          >
            {activeMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run snapshot
          </Button>

          {snapshotKind === "production" && productionMutation.data && (
            <ProductionResultPanel data={productionMutation.data} />
          )}
          {snapshotKind === "meter" && meterMutation.data && (
            <MeterResultPanel data={meterMutation.data} />
          )}
          {snapshotKind === "inverter" && inverterMutation.data && (
            <InverterResultPanel data={inverterMutation.data} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bulk processing</CardTitle>
          <CardDescription>
            Upload a CSV of site IDs and pull production, meter, or inverter
            snapshots for each. Switch the connection scope to sweep every
            registered profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="space-y-1 md:col-span-2">
              <Label>Site IDs CSV</Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={bulkRunning}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Upload CSV
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    handleCsvUpload(f);
                    if (e.target) e.target.value = "";
                  }}
                />
                <span className="text-xs text-muted-foreground truncate">
                  {bulkSourceFile
                    ? `${bulkSourceFile} — ${NUMBER_FORMATTER.format(bulkSiteIds.length)} IDs`
                    : "Header row optional. Recognized columns: site_id, site, csg_id, id."}
                </span>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-kind">Data type</Label>
              <Select
                value={bulkKind}
                onValueChange={(v) => {
                  setBulkKind(v as SnapshotKind);
                  setBulkRows([]);
                  setBulkProgress({
                    total: bulkSiteIds.length,
                    processed: 0,
                    found: 0,
                    notFound: 0,
                    errored: 0,
                  });
                }}
                disabled={bulkRunning}
              >
                <SelectTrigger id="bulk-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">Production</SelectItem>
                  <SelectItem value="meter">Meter inventory</SelectItem>
                  <SelectItem value="inverter">Inverter snapshot</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-scope">Connection scope</Label>
              <Select
                value={bulkScope}
                onValueChange={(v) => setBulkScope(v as ConnectionScope)}
                disabled={bulkRunning}
              >
                <SelectTrigger id="bulk-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active profile only</SelectItem>
                  <SelectItem value="all">All saved profiles</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {bulkKind !== "meter" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="bulk-anchor">Anchor date</Label>
                <Input
                  id="bulk-anchor"
                  type="date"
                  value={bulkAnchorDate}
                  onChange={(e) => setBulkAnchorDate(e.target.value)}
                  disabled={bulkRunning}
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => setBulkAnchorDate(todayIso())}
                >
                  Today
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => {
                    const d = new Date();
                    d.setDate(1);
                    d.setMonth(d.getMonth());
                    setBulkAnchorDate(d.toISOString().slice(0, 10));
                  }}
                >
                  MTD start
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => {
                    const d = new Date();
                    d.setMonth(d.getMonth(), 0);
                    setBulkAnchorDate(d.toISOString().slice(0, 10));
                  }}
                >
                  Last day of prev month
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {!bulkRunning ? (
              <Button
                onClick={runBulk}
                disabled={
                  !canEdit ||
                  bulkSiteIds.length === 0 ||
                  !statusQuery.data?.connected
                }
              >
                <Play className="h-4 w-4 mr-2" />
                Run bulk ({NUMBER_FORMATTER.format(bulkSiteIds.length)})
              </Button>
            ) : (
              <Button variant="destructive" onClick={cancelBulk}>
                <XCircle className="h-4 w-4 mr-2" />
                Cancel
              </Button>
            )}
            <Button
              variant="outline"
              onClick={downloadResults}
              disabled={bulkRows.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Download results CSV
            </Button>
            {bulkProgress.total > 0 && (
              <span className="text-xs text-muted-foreground">
                {NUMBER_FORMATTER.format(bulkProgress.processed)}/
                {NUMBER_FORMATTER.format(bulkProgress.total)} —{" "}
                <span className="text-emerald-700">
                  {NUMBER_FORMATTER.format(bulkProgress.found)} found
                </span>
                ,{" "}
                <span>
                  {NUMBER_FORMATTER.format(bulkProgress.notFound)} not found
                </span>
                ,{" "}
                <span className="text-destructive">
                  {NUMBER_FORMATTER.format(bulkProgress.errored)} errored
                </span>
              </span>
            )}
          </div>
          {bulkRunning && <Progress value={progressPct} className="h-2" />}

          {bulkRows.length > 0 && (
            <BulkResultsTable kind={bulkKind} rows={bulkRows} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type DiagnoseFingerprint = {
  connectionId: string;
  connectionName: string | null;
  apiKeyLength: number;
  apiKeyPreview: string;
  apiKeyHasNonAscii: boolean;
  baseUrlOverride: string | null;
};
type DiagnoseData =
  | { ok: true; fingerprint: DiagnoseFingerprint; effectiveBaseUrl: string; siteCount: number; sample: Array<{ siteId: string; siteName: string | null }> }
  | { ok: false; reason: "no-credential"; message: string; connections: number }
  | { ok: false; reason: "probe-failed"; fingerprint: DiagnoseFingerprint; effectiveBaseUrl: string; message: string };

function DiagnoseResult({ data }: { data: DiagnoseData }) {
  if (data.ok) {
    return (
      <div className="text-xs rounded-md border bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 p-2 space-y-0.5 max-w-xl">
        <p className="font-medium text-emerald-900 dark:text-emerald-200">
          Probe succeeded — {data.siteCount.toLocaleString()} site
          {data.siteCount === 1 ? "" : "s"} returned.
        </p>
        <p>
          Key fingerprint: <code>{data.fingerprint.apiKeyPreview}</code> (length{" "}
          {data.fingerprint.apiKeyLength}
          {data.fingerprint.apiKeyHasNonAscii ? ", non-ASCII present" : ""})
        </p>
        <p>
          Base URL: <code>{data.effectiveBaseUrl}</code>
        </p>
      </div>
    );
  }
  if (data.reason === "no-credential") {
    return (
      <div className="text-xs rounded-md border bg-muted/40 p-2 max-w-xl">
        {data.message}
      </div>
    );
  }
  return (
    <div className="text-xs rounded-md border bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 p-2 space-y-0.5 max-w-xl">
      <p className="font-medium text-amber-900 dark:text-amber-200">
        Probe failed.
      </p>
      <p>
        Key fingerprint: <code>{data.fingerprint.apiKeyPreview}</code> (length{" "}
        {data.fingerprint.apiKeyLength}
        {data.fingerprint.apiKeyHasNonAscii ? ", non-ASCII present" : ""})
      </p>
      <p>
        Base URL: <code>{data.effectiveBaseUrl}</code>
      </p>
      <p className="text-amber-900 dark:text-amber-200 break-all">
        {data.message}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "Found"
          ? "default"
          : status === "Not Found"
            ? "outline"
            : "destructive"
      }
    >
      {status}
    </Badge>
  );
}

function ProductionResultPanel({
  data,
}: {
  data: { status: string; lifetimeKwh?: number | null; error?: string | null };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.lifetimeKwh !== null && data.lifetimeKwh !== undefined && (
        <p>
          <span className="font-medium">Lifetime kWh:</span>{" "}
          {data.lifetimeKwh.toLocaleString()}
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}

function MeterResultPanel({
  data,
}: {
  data: {
    status: string;
    meterCount: number | null;
    productionMeters: number | null;
    consumptionMeters: number | null;
    meterTypes: string[];
    error: string | null;
  };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.meterCount !== null && (
        <p>
          <span className="font-medium">Meters:</span> {data.meterCount}
          {data.productionMeters !== null &&
            ` (${data.productionMeters} production, ${
              data.consumptionMeters ?? 0
            } consumption)`}
        </p>
      )}
      {data.meterTypes && data.meterTypes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Types: {data.meterTypes.join(", ")}
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}

function InverterResultPanel({
  data,
}: {
  data: {
    status: string;
    inverterCount: number | null;
    invertersWithTelemetry: number | null;
    inverterLatestPowerKw: number | null;
    inverterLatestEnergyKwh: number | null;
    error: string | null;
  };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.inverterCount !== null && (
        <p>
          <span className="font-medium">Inverters:</span> {data.inverterCount}
          {data.invertersWithTelemetry !== null &&
            ` (${data.invertersWithTelemetry} reporting telemetry)`}
        </p>
      )}
      {data.inverterLatestPowerKw !== null && (
        <p>
          <span className="font-medium">Latest power:</span>{" "}
          {data.inverterLatestPowerKw.toLocaleString()} kW
        </p>
      )}
      {data.inverterLatestEnergyKwh !== null && (
        <p>
          <span className="font-medium">Latest energy:</span>{" "}
          {data.inverterLatestEnergyKwh.toLocaleString()} kWh
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}

function BulkResultsTable({
  kind,
  rows,
}: {
  kind: SnapshotKind;
  rows: ProductionRow[] | MeterRow[] | InverterRow[];
}) {
  if (kind === "production") {
    return (
      <div className="overflow-x-auto max-h-[500px] border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Lifetime kWh</TableHead>
              <TableHead>MTD kWh</TableHead>
              <TableHead>Prev month kWh</TableHead>
              <TableHead>Last 12 mo kWh</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows as ProductionRow[]).map((r) => (
              <TableRow key={`${r.siteId}-${r.matchedConnectionId ?? "x"}`}>
                <TableCell className="font-mono text-xs">{r.siteId}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-xs">
                  {r.matchedConnectionName ?? r.matchedConnectionId ?? "—"}
                </TableCell>
                <TableCell>
                  {r.lifetimeKwh !== null
                    ? r.lifetimeKwh.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  {r.mtdProductionKwh !== null
                    ? r.mtdProductionKwh.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  {r.previousCalendarMonthProductionKwh !== null
                    ? r.previousCalendarMonthProductionKwh.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  {r.last12MonthsProductionKwh !== null
                    ? r.last12MonthsProductionKwh.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell className="text-xs text-destructive">
                  {r.error ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  if (kind === "meter") {
    return (
      <div className="overflow-x-auto max-h-[500px] border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Meters</TableHead>
              <TableHead>Production</TableHead>
              <TableHead>Consumption</TableHead>
              <TableHead>Types</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows as MeterRow[]).map((r) => (
              <TableRow key={`${r.siteId}-${r.matchedConnectionId ?? "x"}`}>
                <TableCell className="font-mono text-xs">{r.siteId}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-xs">
                  {r.matchedConnectionName ?? r.matchedConnectionId ?? "—"}
                </TableCell>
                <TableCell>{r.meterCount ?? "—"}</TableCell>
                <TableCell>{r.productionMeterCount ?? "—"}</TableCell>
                <TableCell>{r.consumptionMeterCount ?? "—"}</TableCell>
                <TableCell className="text-xs">
                  {r.meterTypes.join(", ")}
                </TableCell>
                <TableCell className="text-xs text-destructive">
                  {r.error ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto max-h-[500px] border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Site ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Profile</TableHead>
            <TableHead>Inverters</TableHead>
            <TableHead>Telemetry</TableHead>
            <TableHead>Failures</TableHead>
            <TableHead>Latest power kW</TableHead>
            <TableHead>Latest energy kWh</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows as InverterRow[]).map((r) => (
            <TableRow key={`${r.siteId}-${r.matchedConnectionId ?? "x"}`}>
              <TableCell className="font-mono text-xs">{r.siteId}</TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-xs">
                {r.matchedConnectionName ?? r.matchedConnectionId ?? "—"}
              </TableCell>
              <TableCell>{r.inverterCount ?? "—"}</TableCell>
              <TableCell>{r.invertersWithTelemetry ?? "—"}</TableCell>
              <TableCell>{r.inverterFailures ?? "—"}</TableCell>
              <TableCell>
                {r.inverterLatestPowerKw !== null
                  ? r.inverterLatestPowerKw.toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell>
                {r.inverterLatestEnergyKwh !== null
                  ? r.inverterLatestEnergyKwh.toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell className="text-xs text-destructive">
                {r.error ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
