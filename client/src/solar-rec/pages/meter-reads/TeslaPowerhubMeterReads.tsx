/**
 * Tesla Powerhub on solar-rec.
 *
 * The legacy personal-app page was a full production-metrics tool, not
 * just a single-site meter-read form. This page keeps the team-credential
 * model from the Solar REC migration while restoring the old API surface:
 * server egress IP, background production job with progress, group/signal
 * overrides, CSV exports, raw debug, and Converted Reads push.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTodayKey } from "@shared/dateKey";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import { MeterReadConnectionProbe } from "../../components/MeterReadConnectionProbe";
import {
  PersistConfirmation,
  readMeterLifetimeKwh,
  readMeterName,
  readMeterStatus,
} from "../../components/PersistConfirmation";
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
import { Copy, Download, Loader2, Play, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
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

const DEFAULT_SIGNAL = "solar_energy_exported_rgm";
const PAGE_SIZE = 50;
const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

type SiteProductionRow = {
  siteId: string;
  siteExternalId: string | null;
  siteName: string | null;
  dailyKwh: number;
  weeklyKwh: number;
  monthlyKwh: number;
  yearlyKwh: number;
  lifetimeKwh: number;
  dataSource: "rgm" | "inverter" | null;
};

type ProductionPayload = {
  sites: SiteProductionRow[];
  requestedGroupId: string;
  signal: string;
  resolvedSitesEndpointUrl: string | null;
  resolvedTelemetryEndpoints: Record<string, string | null>;
  debug?: unknown;
};

type ProductionJobSnapshot = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    currentStep: number;
    totalSteps: number;
    percent: number;
    message: string;
    windowKey: string | null;
  };
  result: ProductionPayload | null;
  error: string | null;
  _runnerVersion: string;
};

type PushStatus =
  | { state: "idle" }
  | { state: "pushing" }
  | { state: "ok"; pushed: number; skipped: number; message?: string }
  | { state: "error"; message: string };

function normalizeGroupId(raw: string): string {
  const trimmed = clean(raw);
  if (!trimmed) return "";
  const match = trimmed.match(/\/group\/([a-zA-Z0-9-]+)/i);
  return match?.[1]?.trim() || trimmed;
}

function csvEscape(value: unknown): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function buildCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(",")),
  ].join("\n");
}

export default function TeslaPowerhubMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const trpcUtils = trpc.useUtils();

  const statusQuery = trpc.teslaPowerhub.getStatus.useQuery(undefined, {
    retry: false,
  });
  const egressIpv4Query = trpc.teslaPowerhub.getServerEgressIpv4.useQuery(
    { forceRefresh: false },
    {
      enabled: statusQuery.data?.connected === true,
      retry: 1,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    }
  );
  const refreshEgressMutation =
    trpc.teslaPowerhub.refreshServerEgressIpv4.useMutation();
  const listSitesQuery = trpc.teslaPowerhub.listSites.useQuery(undefined, {
    enabled: false,
    retry: false,
  });
  const snapshotMutation = trpc.teslaPowerhub.getSiteSnapshot.useMutation({
    onError: err => toast.error(err.message),
  });
  const startProductionJobMutation =
    trpc.teslaPowerhub.startGroupProductionMetricsJob.useMutation();
  const pushConvertedReads =
    trpc.solarRecDashboard.pushConvertedReadsSource.useMutation();

  const [hasRequestedSites, setHasRequestedSites] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [showPersist, setShowPersist] = useState(false);
  const [groupIdInput, setGroupIdInput] = useState("");
  const [signalInput, setSignalInput] = useState("");
  const [endpointUrlInput, setEndpointUrlInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobPollIntervalMs, setJobPollIntervalMs] = useState<number | false>(
    false
  );
  const [jobStartedAtMs, setJobStartedAtMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [latestPayload, setLatestPayload] = useState<ProductionPayload | null>(
    null
  );
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [pushStatus, setPushStatus] = useState<PushStatus>({ state: "idle" });
  const lastCompletedJobIdRef = useRef<string | null>(null);
  const lastFailedJobIdRef = useRef<string | null>(null);
  const pushConvertedReadsRef = useRef(pushConvertedReads);
  pushConvertedReadsRef.current = pushConvertedReads;

  const productionJobQuery =
    trpc.teslaPowerhub.getGroupProductionMetricsJob.useQuery(
      { jobId: activeJobId ?? "__none__" },
      {
        enabled: Boolean(activeJobId),
        refetchInterval: jobPollIntervalMs,
        retry: 1,
        refetchOnWindowFocus: false,
      }
    );

  useEffect(() => {
    if (!statusQuery.data) return;
    setGroupIdInput(current => current || statusQuery.data.groupId || "");
    setSignalInput(current => current || statusQuery.data.signal || "");
    setEndpointUrlInput(
      current => current || statusQuery.data.endpointUrl || ""
    );
  }, [statusQuery.data]);

  useEffect(() => {
    setPage(1);
  }, [search, latestPayload?.sites.length, activeJobId]);

  useEffect(() => {
    if (!activeJobId || !jobStartedAtMs || jobPollIntervalMs === false) return;
    const intervalId = window.setInterval(() => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - jobStartedAtMs) / 1000))
      );
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [activeJobId, jobPollIntervalMs, jobStartedAtMs]);

  useEffect(() => {
    const snapshot = productionJobQuery.data as
      | ProductionJobSnapshot
      | undefined;
    if (!snapshot) return;
    if (snapshot.status === "completed") {
      setJobPollIntervalMs(false);
      if (snapshot.result) {
        setLatestPayload(snapshot.result);
        setResultTitle(
          `Site Production Metrics (${snapshot.result.sites.length})`
        );
        setResultText(JSON.stringify(snapshot.result.debug ?? {}, null, 2));
      }
      if (lastCompletedJobIdRef.current !== snapshot.id) {
        lastCompletedJobIdRef.current = snapshot.id;
        toast.success("Production metrics loaded.");

        if (snapshot.result?.sites && snapshot.result.sites.length > 0) {
          void autoPushProductionToConvertedReads(snapshot.result.sites);
        } else {
          toast.message("Tesla Powerhub job returned no sites to push.");
        }
      }
    }
    if (snapshot.status === "failed") {
      setJobPollIntervalMs(false);
      if (lastFailedJobIdRef.current !== snapshot.id) {
        lastFailedJobIdRef.current = snapshot.id;
        toast.error(
          `Failed to load production metrics: ${
            snapshot.error ?? "Unknown job error."
          }`
        );
      }
    }
  }, [productionJobQuery.data]);

  const probeFn = useCallback(async () => {
    setHasRequestedSites(true);
    const r = await listSitesQuery.refetch({ throwOnError: true });
    return r.data?.sites?.length ?? 0;
  }, [listSitesQuery]);

  const result = snapshotMutation.data;
  const activeJob = productionJobQuery.data as
    | ProductionJobSnapshot
    | undefined;
  const activeCompletedPayload =
    activeJob?.status === "completed" ? activeJob.result : null;
  const payload = activeCompletedPayload ?? latestPayload;
  const rows = payload?.sites ?? [];

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row => {
      const haystack =
        `${row.siteId} ${row.siteExternalId ?? ""} ${row.siteName ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, search]);

  const totals = useMemo(() => {
    let daily = 0;
    let weekly = 0;
    let monthly = 0;
    let yearly = 0;
    let lifetime = 0;
    for (const row of filteredRows) {
      daily += row.dailyKwh;
      weekly += row.weeklyKwh;
      monthly += row.monthlyKwh;
      yearly += row.yearlyKwh;
      lifetime += row.lifetimeKwh;
    }
    return { daily, weekly, monthly, yearly, lifetime };
  }, [filteredRows]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pagedRows = useMemo(() => {
    const start = (clampedPage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, clampedPage]);

  const isJobRunning =
    startProductionJobMutation.isPending ||
    activeJob?.status === "queued" ||
    activeJob?.status === "running";
  const mutationError = startProductionJobMutation.error
    ? toErrorMessage(startProductionJobMutation.error)
    : productionJobQuery.error && activeJobId
      ? toErrorMessage(productionJobQuery.error)
      : activeJob?.status === "failed"
        ? (activeJob.error ?? "Unknown job error.")
        : null;
  const serverIpData = refreshEgressMutation.data ?? egressIpv4Query.data;
  const serverIpError = refreshEgressMutation.error
    ? toErrorMessage(refreshEgressMutation.error)
    : egressIpv4Query.error
      ? toErrorMessage(egressIpv4Query.error)
      : null;

  function runSnapshot() {
    const trimmed = siteId.trim();
    if (!trimmed) {
      toast.error("Enter a site ID");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({ siteId: trimmed });
  }

  async function handleFetchProduction() {
    if (!canEdit) {
      toast.error("Running production metrics requires edit access.");
      return;
    }
    const groupId =
      normalizeGroupId(groupIdInput || statusQuery.data?.groupId || "") ||
      undefined;

    try {
      const job = await startProductionJobMutation.mutateAsync({
        groupId,
        endpointUrl: clean(endpointUrlInput) || undefined,
        signal: clean(signalInput) || undefined,
      });
      setActiveJobId(job.jobId);
      setJobPollIntervalMs(1200);
      setJobStartedAtMs(Date.now());
      setElapsedSeconds(0);
      setResultTitle("Site Production Metrics (running...)");
      setResultText("{}");
      setPushStatus({ state: "idle" });
      toast.success("Production job started. Progress will update below.");
    } catch (error) {
      toast.error(
        `Failed to load production metrics: ${toErrorMessage(error)}`
      );
    }
  }

  async function handleRefreshServerIp() {
    try {
      await refreshEgressMutation.mutateAsync();
      await trpcUtils.teslaPowerhub.getServerEgressIpv4.invalidate({
        forceRefresh: false,
      });
      await egressIpv4Query.refetch();
      toast.success("Server egress IP refreshed.");
    } catch (error) {
      toast.error(`Failed to refresh server IP: ${toErrorMessage(error)}`);
    }
  }

  async function handleCopyServerCidr() {
    const cidr = refreshEgressMutation.data?.cidr ?? egressIpv4Query.data?.cidr;
    if (!cidr) {
      toast.error("No server CIDR to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(cidr);
      toast.success(`Copied ${cidr}`);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  }

  async function autoPushProductionToConvertedReads(
    sites: SiteProductionRow[]
  ) {
    const eligible = sites.filter(
      site => site.lifetimeKwh > 0 && Number.isFinite(site.lifetimeKwh)
    );
    const filteredOut = sites.length - eligible.length;
    if (eligible.length === 0) {
      setPushStatus({
        state: "ok",
        pushed: 0,
        skipped: 0,
        message: `No rows to push - all ${COUNT_FORMATTER.format(
          sites.length
        )} sites had 0 lifetime kWh.`,
      });
      return;
    }

    const anchorDate = formatTodayKey();
    const convertedRows: ConvertedReadRow[] = eligible.map(site =>
      buildConvertedReadRow(
        MONITORING_CANONICAL_NAMES.teslaPowerhub,
        site.siteId,
        site.siteName ?? "",
        site.lifetimeKwh,
        anchorDate
      )
    );

    setPushStatus({ state: "pushing" });
    try {
      const pushResult = await pushConvertedReadsToRecDashboard(
        input => pushConvertedReadsRef.current.mutateAsync(input),
        convertedRows,
        MONITORING_CANONICAL_NAMES.teslaPowerhub
      );
      setPushStatus({
        state: "ok",
        pushed: pushResult.pushed,
        skipped: pushResult.skipped,
        message:
          filteredOut > 0
            ? `${COUNT_FORMATTER.format(filteredOut)} zero-kWh site${
                filteredOut === 1 ? "" : "s"
              } skipped.`
            : undefined,
      });
      toast.success(
        `Pushed ${COUNT_FORMATTER.format(
          pushResult.pushed
        )} Tesla Powerhub row${
          pushResult.pushed === 1 ? "" : "s"
        } to Converted Reads.`
      );
    } catch (error) {
      const message = toErrorMessage(error);
      setPushStatus({ state: "error", message });
      toast.error(`Failed to push Converted Reads: ${message}`);
    }
  }

  function exportMetricsCsv() {
    if (filteredRows.length === 0) {
      toast.error("No rows to export.");
      return;
    }
    const headers = [
      "site_id",
      "ste_id",
      "site_name",
      "daily_kwh",
      "weekly_kwh",
      "monthly_kwh",
      "yearly_kwh",
      "lifetime_kwh",
      "data_source",
    ];
    const csv = buildCsv(
      headers,
      filteredRows.map(row => ({
        site_id: row.siteId,
        ste_id: row.siteExternalId,
        site_name: row.siteName,
        daily_kwh: row.dailyKwh,
        weekly_kwh: row.weeklyKwh,
        monthly_kwh: row.monthlyKwh,
        yearly_kwh: row.yearlyKwh,
        lifetime_kwh: row.lifetimeKwh,
        data_source: row.dataSource,
      }))
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(`tesla-powerhub-site-production-${stamp}.csv`, csv);
  }

  function downloadConvertedReadsCsv(sites: SiteProductionRow[]) {
    const readRows = sites.filter(site => site.lifetimeKwh > 0);
    if (readRows.length === 0) {
      toast.error(
        "No rows with lifetime kWh available for Converted Reads export."
      );
      return;
    }

    const anchorDate = formatTodayKey();
    const headers = [
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "lifetime_meter_read_wh",
      "status",
      "alert_severity",
      "read_date",
    ];
    const csvRows: Array<Record<string, string | number | null | undefined>> =
      [];
    for (const site of readRows) {
      const base = buildConvertedReadRow(
        MONITORING_CANONICAL_NAMES.teslaPowerhub,
        site.siteId,
        site.siteName ?? "",
        site.lifetimeKwh,
        anchorDate
      );
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id: "",
        monitoring_system_name: base.monitoring_system_name,
        lifetime_meter_read_wh: base.lifetime_meter_read_wh,
        status: base.status,
        alert_severity: base.alert_severity,
        read_date: base.read_date,
      });
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id: base.monitoring_system_id,
        monitoring_system_name: "",
        lifetime_meter_read_wh: base.lifetime_meter_read_wh,
        status: base.status,
        alert_severity: base.alert_severity,
        read_date: base.read_date,
      });
    }

    const csvText = buildCsv(headers, csvRows);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(`tesla-powerhub-converted-reads-${stamp}.csv`, csvText);
    toast.success(
      `Downloaded ${COUNT_FORMATTER.format(
        csvRows.length
      )} Converted Reads rows.`
    );
  }

  const singleSnapshotRows =
    result &&
    readMeterStatus(result) === "Found" &&
    readMeterLifetimeKwh(result) != null
      ? [
          buildConvertedReadRow(
            MONITORING_CANONICAL_NAMES.teslaPowerhub,
            String(result.siteId ?? siteId),
            readMeterName(result) ?? String(result.siteId ?? siteId),
            readMeterLifetimeKwh(result) ?? 0,
            formatTodayKey()
          ),
        ]
      : [];

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Tesla Powerhub</h1>
        <p className="text-sm text-muted-foreground">
          Run production metrics against the team&apos;s Tesla Powerhub
          credential. Manage client ID, client secret, optional default group,
          signal, and base URLs in Solar REC Settings &gt; Credentials.
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
            {statusQuery.data?.connected ? (
              <>
                {statusQuery.data.connectionCount} team credential
                {statusQuery.data.connectionCount === 1 ? "" : "s"} registered.
                {statusQuery.data.groupId && (
                  <>
                    {" "}
                    Group ID:{" "}
                    <code className="font-mono text-xs">
                      {statusQuery.data.groupId}
                    </code>
                  </>
                )}
              </>
            ) : (
              "Ask an admin to register Tesla Powerhub OAuth credentials in Settings > Credentials."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="sites"
            disabled={!statusQuery.data?.connected}
          />

          <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Server Egress IPv4</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleRefreshServerIp}
                  disabled={
                    refreshEgressMutation.isPending ||
                    egressIpv4Query.isFetching
                  }
                >
                  {refreshEgressMutation.isPending ||
                  egressIpv4Query.isFetching ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Refresh IP
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCopyServerCidr}
                  disabled={!serverIpData?.cidr}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy CIDR
                </Button>
              </div>
            </div>

            {serverIpError ? (
              <p className="text-sm text-destructive">{serverIpError}</p>
            ) : serverIpData ? (
              <div className="grid gap-1 text-sm text-muted-foreground md:grid-cols-2">
                <p>
                  IPv4:{" "}
                  <span className="font-medium text-foreground">
                    {serverIpData.ip}
                  </span>
                </p>
                <p>
                  CIDR:{" "}
                  <span className="font-medium text-foreground">
                    {serverIpData.cidr}
                  </span>
                </p>
                <p>Source: {serverIpData.source}</p>
                <p>
                  Fetched: {new Date(serverIpData.fetchedAt).toLocaleString()}
                </p>
              </div>
            ) : statusQuery.data?.connected ? (
              <p className="text-sm text-muted-foreground">
                Checking server egress IP...
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect a credential first.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Discover sites with the lightweight Powerhub inventory path.
                Production metrics still run separately as a background job.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setHasRequestedSites(true);
                void listSitesQuery.refetch();
              }}
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
          ) : !hasRequestedSites ? (
            <p className="text-sm text-muted-foreground">
              Click Refresh or Test Connection to load the site list.
            </p>
          ) : listSitesQuery.isFetching ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listSitesQuery.error ? (
            <p className="text-sm text-destructive">
              {listSitesQuery.error.message}
            </p>
          ) : (listSitesQuery.data?.sites ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites returned by Powerhub.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site ID</TableHead>
                    <TableHead>STE ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listSitesQuery.data?.sites.map(site => (
                    <TableRow key={site.siteId}>
                      <TableCell className="font-mono text-xs">
                        {site.siteId}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {site.siteExternalId ?? ""}
                      </TableCell>
                      <TableCell>{site.siteName ?? ""}</TableCell>
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
          <CardTitle className="text-base">Site Production Metrics</CardTitle>
          <CardDescription>
            Pull daily, weekly, monthly, yearly, and lifetime kWh for every site
            in the group. The server runs this in the background and reports
            progress here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tesla-powerhub-group-id-query">
                Group ID Override
              </Label>
              <Input
                id="tesla-powerhub-group-id-query"
                value={groupIdInput}
                onChange={event => setGroupIdInput(event.target.value)}
                placeholder="Optional Tesla group UUID or /group/... URL"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tesla-powerhub-signal">Signal</Label>
              <Input
                id="tesla-powerhub-signal"
                value={signalInput}
                onChange={event => setSignalInput(event.target.value)}
                placeholder={DEFAULT_SIGNAL}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="tesla-powerhub-endpoint-override">
                Endpoint Override
              </Label>
              <Input
                id="tesla-powerhub-endpoint-override"
                value={endpointUrlInput}
                onChange={event => setEndpointUrlInput(event.target.value)}
                placeholder="Optional Tesla endpoint URL"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Button
              onClick={handleFetchProduction}
              disabled={
                isJobRunning || !canEdit || !statusQuery.data?.connected
              }
            >
              {isJobRunning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Fetch Site Production
            </Button>
            <div className="space-y-1">
              <Label htmlFor="tesla-powerhub-search">
                <span className="inline-flex items-center gap-1">
                  <Search className="h-4 w-4" />
                  Search Sites
                </span>
              </Label>
              <Input
                id="tesla-powerhub-search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="site name, site ID, or STE ID"
              />
            </div>
            <Button
              variant="outline"
              onClick={exportMetricsCsv}
              disabled={filteredRows.length === 0}
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              disabled={
                filteredRows.filter(row => row.lifetimeKwh > 0).length === 0
              }
              onClick={() => downloadConvertedReadsCsv(filteredRows)}
            >
              <Download className="h-4 w-4 mr-2" />
              Converted Reads CSV
            </Button>
          </div>

          {isJobRunning && activeJob ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-emerald-900">
                  Processing: Step {activeJob.progress.currentStep} of{" "}
                  {activeJob.progress.totalSteps}
                </p>
                <p className="text-xs text-emerald-800">
                  {Math.max(0, elapsedSeconds)}s elapsed
                </p>
              </div>
              <Progress value={activeJob.progress.percent} />
              <p className="text-sm text-emerald-900">
                {activeJob.progress.message}
              </p>
              <p className="text-xs text-emerald-800">
                Runner: {activeJob._runnerVersion}
              </p>
            </div>
          ) : null}

          {mutationError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Request error: {mutationError}
            </div>
          ) : null}

          {pushStatus.state === "pushing" ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              Pushing Converted Reads...
            </div>
          ) : pushStatus.state === "ok" ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              Converted Reads: {COUNT_FORMATTER.format(pushStatus.pushed)}{" "}
              pushed, {COUNT_FORMATTER.format(pushStatus.skipped)} skipped.
              {pushStatus.message ? ` ${pushStatus.message}` : ""}
            </div>
          ) : pushStatus.state === "error" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Converted Reads push failed: {pushStatus.message}
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Sites</p>
              <p className="text-xl font-semibold">
                {COUNT_FORMATTER.format(filteredRows.length)}
              </p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Daily</p>
              <p className="text-xl font-semibold">{formatKwh(totals.daily)}</p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Weekly</p>
              <p className="text-xl font-semibold">
                {formatKwh(totals.weekly)}
              </p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Monthly</p>
              <p className="text-xl font-semibold">
                {formatKwh(totals.monthly)}
              </p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Yearly</p>
              <p className="text-xl font-semibold">
                {formatKwh(totals.yearly)}
              </p>
            </div>
            <div className="rounded-md border bg-background p-3">
              <p className="text-xs text-muted-foreground">Lifetime</p>
              <p className="text-xl font-semibold">
                {formatKwh(totals.lifetime)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site ID</TableHead>
                  <TableHead>STE ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Daily</TableHead>
                  <TableHead className="text-right">Weekly</TableHead>
                  <TableHead className="text-right">Monthly</TableHead>
                  <TableHead className="text-right">Yearly</TableHead>
                  <TableHead className="text-right">Lifetime</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRows.map(row => (
                  <TableRow key={row.siteId}>
                    <TableCell className="font-mono text-xs">
                      {row.siteId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.siteExternalId ?? ""}
                    </TableCell>
                    <TableCell>{row.siteName ?? ""}</TableCell>
                    <TableCell className="text-right">
                      {formatKwh(row.dailyKwh)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatKwh(row.weeklyKwh)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatKwh(row.monthlyKwh)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatKwh(row.yearlyKwh)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatKwh(row.lifetimeKwh)}
                    </TableCell>
                    <TableCell>
                      {row.dataSource === "rgm"
                        ? "RGM"
                        : row.dataSource === "inverter"
                          ? "Inverter"
                          : ""}
                    </TableCell>
                  </TableRow>
                ))}
                {pagedRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="py-6 text-center text-muted-foreground"
                    >
                      No sites to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Showing{" "}
              {pagedRows.length === 0 ? 0 : (clampedPage - 1) * PAGE_SIZE + 1}-
              {Math.min(clampedPage * PAGE_SIZE, filteredRows.length)} of{" "}
              {COUNT_FORMATTER.format(filteredRows.length)}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={clampedPage <= 1}
                onClick={() => setPage(previous => Math.max(1, previous - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {clampedPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={clampedPage >= totalPages}
                onClick={() =>
                  setPage(previous => Math.min(totalPages, previous + 1))
                }
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Site Snapshot</CardTitle>
          <CardDescription>
            Pull one site directly and optionally push it to Converted Reads.
            {!canEdit && (
              <span className="ml-1 text-amber-700">
                You have read-only access; running a snapshot requires{" "}
                <code>edit</code> on <code>meter-reads</code>.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="tesla-site-id">Site ID</Label>
            <Input
              id="tesla-site-id"
              value={siteId}
              onChange={event => setSiteId(event.target.value)}
              placeholder="Tesla site ID"
            />
          </div>
          <Button
            onClick={runSnapshot}
            disabled={
              !canEdit ||
              !siteId.trim() ||
              snapshotMutation.isPending ||
              !statusQuery.data?.connected
            }
          >
            {snapshotMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run snapshot
          </Button>
          {result && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              <p>
                <span className="font-medium">Status:</span>{" "}
                <Badge
                  variant={
                    result.status === "Found"
                      ? "default"
                      : result.status === "Not Found"
                        ? "outline"
                        : "destructive"
                  }
                >
                  {result.status}
                </Badge>
              </p>
              {result.siteName && (
                <p>
                  <span className="font-medium">Name:</span> {result.siteName}
                </p>
              )}
              {result.siteExternalId && (
                <p>
                  <span className="font-medium">STE ID:</span>{" "}
                  {result.siteExternalId}
                </p>
              )}
              {result.lifetimeKwh !== null &&
                result.lifetimeKwh !== undefined && (
                  <p>
                    <span className="font-medium">Lifetime:</span>{" "}
                    {formatKwh(result.lifetimeKwh)}
                  </p>
                )}
              {result.yearlyKwh !== null && result.yearlyKwh !== undefined && (
                <p>
                  <span className="font-medium">Year:</span>{" "}
                  {formatKwh(result.yearlyKwh)}
                </p>
              )}
              {result.monthlyKwh !== null &&
                result.monthlyKwh !== undefined && (
                  <p>
                    <span className="font-medium">Month:</span>{" "}
                    {formatKwh(result.monthlyKwh)}
                  </p>
                )}
              {result.weeklyKwh !== null && result.weeklyKwh !== undefined && (
                <p>
                  <span className="font-medium">Week:</span>{" "}
                  {formatKwh(result.weeklyKwh)}
                </p>
              )}
              {result.dailyKwh !== null && result.dailyKwh !== undefined && (
                <p>
                  <span className="font-medium">Day:</span>{" "}
                  {formatKwh(result.dailyKwh)}
                </p>
              )}
              {result.dataSource && (
                <p className="text-xs text-muted-foreground">
                  Data source: <code>{result.dataSource}</code>
                </p>
              )}
              {result.error && (
                <p className="text-destructive">
                  <span className="font-medium">Error:</span> {result.error}
                </p>
              )}
            </div>
          )}

          {result && showPersist && (
            <PersistConfirmation
              providerKey="tesla-powerhub"
              providerLabel="Tesla Powerhub"
              rows={singleSnapshotRows}
              onDiscard={() => setShowPersist(false)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Raw API Debug</CardTitle>
          <CardDescription>{resultTitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-slate-950 text-slate-100 rounded-md p-4 overflow-auto max-h-[480px]">
            {resultText}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
