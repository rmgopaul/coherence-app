import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  Play,
  Search,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Minus,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { useSolarRecAuth } from "../hooks/useSolarRecAuth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiRun = {
  id: string;
  provider: string;
  siteId: string;
  siteName: string | null;
  dateKey: string;
  status: "success" | "error" | "no_data" | "skipped";
  readingsCount: number;
  lifetimeKwh: number | null;
  errorMessage: string | null;
  durationMs: number | null;
};

type HealthSummary = {
  provider: string;
  totalRuns: number;
  successCount: number;
  errorCount: number;
  noDataCount: number;
  uniqueSites: number;
  lastSuccess: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDateRange(daysBack: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates.reverse(); // newest first
}

function formatDate(dateKey: string): string {
  const d = new Date(dateKey + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Status cell component
// ---------------------------------------------------------------------------

function StatusCell({
  run,
  onClick,
}: {
  run: ApiRun | undefined;
  onClick: () => void;
}) {
  if (!run) {
    return (
      <td className="px-1 py-1 text-center">
        <div className="w-8 h-6 rounded bg-muted flex items-center justify-center mx-auto">
          <Minus className="h-3 w-3 text-muted-foreground/40" />
        </div>
      </td>
    );
  }

  const colors = {
    success: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200",
    error: "bg-red-100 text-red-700 hover:bg-red-200",
    no_data: "bg-amber-100 text-amber-700 hover:bg-amber-200",
    skipped: "bg-muted text-muted-foreground",
  };

  return (
    <td className="px-1 py-1 text-center">
      <button
        onClick={onClick}
        className={`w-8 h-6 rounded text-[10px] font-medium ${colors[run.status]} cursor-pointer transition-colors flex items-center justify-center mx-auto`}
        title={`${run.status}: ${run.readingsCount} readings`}
      >
        {run.status === "success"
          ? run.readingsCount
          : run.status === "error"
            ? "!"
            : run.status === "no_data"
              ? "0"
              : "-"}
      </button>
    </td>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({
  health,
  gridData,
  today,
}: {
  health: HealthSummary[];
  gridData: ApiRun[];
  today: string;
}) {
  const totalSites = health.reduce((acc, h) => acc + h.uniqueSites, 0);
  const todayRuns = gridData.filter((r) => r.dateKey === today);
  const todaySuccess = todayRuns.filter((r) => r.status === "success").length;
  const todayErrors = todayRuns.filter((r) => r.status === "error").length;

  const healthyProviders = health.filter(
    (h) => h.errorCount === 0 && h.successCount > 0
  ).length;
  const totalProviders = health.length;

  // Sites missing 3+ consecutive days
  const sitesWithGaps = useMemo(() => {
    const siteLastSuccess = new Map<string, string>();
    for (const run of gridData) {
      if (run.status === "success") {
        const key = `${run.provider}:${run.siteId}`;
        const existing = siteLastSuccess.get(key);
        if (!existing || run.dateKey > existing) {
          siteLastSuccess.set(key, run.dateKey);
        }
      }
    }
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threshold = threeDaysAgo.toISOString().slice(0, 10);
    let count = 0;
    siteLastSuccess.forEach((lastDate) => {
      if (lastDate < threshold) count++;
    });
    return count;
  }, [gridData]);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Total Sites</p>
          <p className="text-2xl font-bold">{totalSites}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Reporting Today</p>
          <p className="text-2xl font-bold">
            {todaySuccess}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              / {todaySuccess + todayErrors || totalSites}
            </span>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">API Health</p>
          <p className="text-2xl font-bold">
            {healthyProviders}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              / {totalProviders}
            </span>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Alerts</p>
          <p className="text-2xl font-bold">
            {sitesWithGaps}
            {sitesWithGaps > 0 && (
              <AlertTriangle className="inline h-4 w-4 ml-1 text-amber-500" />
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type BatchStatus = {
  id: string;
  status: "running" | "completed" | "failed";
  currentProvider: string | null;
  currentCredentialName: string | null;
  providersTotal: number;
  providersCompleted: number;
  totalSites: number;
  successCount: number;
  errorCount: number;
  noDataCount: number;
};

export default function MonitoringDashboard() {
  const [daysBack] = useState(30);
  const { startDate, endDate } = useMemo(() => getDateRange(daysBack), [daysBack]);
  const today = new Date().toISOString().slice(0, 10);
  const [search, setSearch] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [selectedRun, setSelectedRun] = useState<ApiRun | null>(null);
  const { isOperator } = useSolarRecAuth();
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const gridQuery = trpc.monitoring.getGrid.useQuery({ startDate, endDate });
  const healthQuery = trpc.monitoring.getHealthSummary.useQuery();
  const providersQuery = trpc.monitoring.getConfiguredProviders.useQuery();
  const batchStatusQuery = trpc.monitoring.getBatchStatus.useQuery(
    { batchId: activeBatchId! },
    { enabled: !!activeBatchId, refetchInterval: 2000 }
  );

  // Track batch progress via polling
  useEffect(() => {
    if (!batchStatusQuery.data) return;
    const data = batchStatusQuery.data as BatchStatus;
    setBatchStatus(data);
    if (data.status === "completed" || data.status === "failed") {
      // Batch finished - stop polling, refresh grid
      setActiveBatchId(null);
      gridQuery.refetch();
      healthQuery.refetch();
    }
  }, [batchStatusQuery.data]);

  const runAllMutation = trpc.monitoring.runAll.useMutation({
    onSuccess: (data) => {
      setActiveBatchId(data.batchId);
      setBatchStatus({
        id: data.batchId,
        status: "running",
        currentProvider: null,
        currentCredentialName: null,
        providersTotal: 0,
        providersCompleted: 0,
        totalSites: 0,
        successCount: 0,
        errorCount: 0,
        noDataCount: 0,
      });
    },
  });

  const isRunning = !!activeBatchId || runAllMutation.isPending;

  const dates = useMemo(() => getDatesInRange(startDate, endDate), [startDate, endDate]);
  const providerOptions = useMemo(() => {
    const fromConfigured = providersQuery.data ?? [];
    const fromHealth = (healthQuery.data ?? []).map((item) => item.provider);
    const fromGrid = (gridQuery.data ?? []).map((item) => item.provider);
    return Array.from(new Set([...fromConfigured, ...fromHealth, ...fromGrid]))
      .filter((provider) => provider.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  }, [providersQuery.data, healthQuery.data, gridQuery.data]);

  useEffect(() => {
    setSelectedProviders((prev) => prev.filter((provider) => providerOptions.includes(provider)));
  }, [providerOptions]);

  // Build grid: group runs by provider+siteId
  const gridRows = useMemo(() => {
    const data = gridQuery.data ?? [];
    const rowMap = new Map<
      string,
      { provider: string; siteId: string; siteName: string; runs: Map<string, ApiRun> }
    >();

    for (const run of data) {
      const key = `${run.provider}::${run.siteId}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          provider: run.provider,
          siteId: run.siteId,
          siteName: run.siteName ?? run.siteId,
          runs: new Map(),
        });
      }
      rowMap.get(key)!.runs.set(run.dateKey, run);
    }

    let rows = Array.from(rowMap.values());

    // Filter by search
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.provider.toLowerCase().includes(q) ||
          r.siteId.toLowerCase().includes(q) ||
          r.siteName.toLowerCase().includes(q)
      );
    }

    // Sort by provider, then site
    rows.sort((a, b) =>
      a.provider === b.provider
        ? a.siteName.localeCompare(b.siteName)
        : a.provider.localeCompare(b.provider)
    );

    return rows;
  }, [gridQuery.data, search]);

  const handleRunAll = () => {
    runAllMutation.mutate({ providers: [] });
  };

  const handleRunSelected = () => {
    if (selectedProviders.length === 0) return;
    runAllMutation.mutate({ providers: selectedProviders });
  };

  const toggleProvider = (provider: string, checked: boolean) => {
    setSelectedProviders((prev) => {
      if (checked) {
        if (prev.includes(provider)) return prev;
        return [...prev, provider].sort((a, b) => a.localeCompare(b));
      }
      return prev.filter((entry) => entry !== provider);
    });
  };

  const handleExportCsv = () => {
    const headers = ["Provider", "Site ID", "Site Name", ...dates.map(formatDate)];
    const csvRows = gridRows.map((row) => [
      row.provider,
      row.siteId,
      row.siteName,
      ...dates.map((d) => {
        const run = row.runs.get(d);
        if (!run) return "";
        if (run.status === "success") return String(run.readingsCount);
        if (run.status === "error") return "ERROR";
        return "NO_DATA";
      }),
    ]);

    const csv = [headers, ...csvRows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monitoring-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Monitoring Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Track API calls and meter readings across all monitoring systems.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={gridRows.length === 0}
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            CSV
          </Button>
          {isOperator && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRunSelected}
                disabled={isRunning || selectedProviders.length === 0}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                {isRunning ? "Running..." : `Run Selected (${selectedProviders.length})`}
              </Button>
              <Button
                size="sm"
                onClick={handleRunAll}
                disabled={isRunning}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                {isRunning ? "Running..." : "Run All"}
              </Button>
            </>
          )}
        </div>
      </div>

      {isOperator && providerOptions.length > 0 && (
        <Card className="border-dashed">
          <CardContent className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Select one or more monitoring modules, then click <span className="font-medium text-foreground">Run Selected</span>.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={isRunning || selectedProviders.length === providerOptions.length}
                  onClick={() => setSelectedProviders(providerOptions)}
                >
                  Select All
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={isRunning || selectedProviders.length === 0}
                  onClick={() => setSelectedProviders([])}
                >
                  Clear
                </Button>
                <Badge variant="outline" className="text-[11px]">
                  {selectedProviders.length} selected
                </Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {providerOptions.map((provider) => {
                const checked = selectedProviders.includes(provider);
                return (
                  <label
                    key={provider}
                    className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs cursor-pointer ${
                      checked ? "border-blue-300 bg-blue-50 text-blue-900" : "border-border bg-background"
                    } ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isRunning}
                      onChange={(event) => toggleProvider(provider, event.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>{provider}</span>
                  </label>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Progress panel */}
      {isRunning && batchStatus && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 mb-2">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="text-sm font-medium text-blue-900">
                Running monitoring batch...
              </span>
            </div>

            {/* Progress bar */}
            {batchStatus.providersTotal > 0 && (
              <div className="mb-2">
                <div className="flex justify-between text-xs text-blue-700 mb-1">
                  <span>
                    Provider {batchStatus.providersCompleted + (batchStatus.currentProvider ? 1 : 0)} of {batchStatus.providersTotal}
                  </span>
                  <span>
                    {Math.round((batchStatus.providersCompleted / batchStatus.providersTotal) * 100)}%
                  </span>
                </div>
                <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-500"
                    style={{
                      width: `${(batchStatus.providersCompleted / batchStatus.providersTotal) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Current provider */}
            {batchStatus.currentProvider && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-blue-600 font-medium">
                  Now: {batchStatus.currentProvider}
                </span>
                {batchStatus.currentCredentialName && (
                  <span className="text-blue-500">
                    ({batchStatus.currentCredentialName})
                  </span>
                )}
              </div>
            )}

            {/* Running totals */}
            <div className="flex items-center gap-4 mt-2 text-xs text-blue-700">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                {batchStatus.successCount} success
              </span>
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3 text-red-500" />
                {batchStatus.errorCount} errors
              </span>
              <span>
                {batchStatus.totalSites} total sites
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Batch completed notification */}
      {!isRunning && batchStatus && batchStatus.status !== "running" && (
        <Card className={batchStatus.status === "completed" ? "border-emerald-200 bg-emerald-50/50" : "border-red-200 bg-red-50/50"}>
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                {batchStatus.status === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-600" />
                )}
                <span className="font-medium">
                  Batch {batchStatus.status}
                </span>
                <span className="text-muted-foreground">
                  {batchStatus.successCount} success, {batchStatus.errorCount} errors, {batchStatus.totalSites} total sites
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setBatchStatus(null)}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <SummaryCards
        health={healthQuery.data ?? []}
        gridData={gridQuery.data ?? []}
        today={today}
      />

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter by provider or site..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-9 text-sm"
        />
      </div>

      {/* Grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {gridQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : gridRows.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-muted-foreground">
                No monitoring data yet. Connect API credentials in Settings, then click "Run All" or "Run Selected".
              </p>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium sticky left-0 bg-muted/30 z-10 min-w-[100px]">
                    Provider
                  </th>
                  <th className="text-left px-2 py-2 font-medium min-w-[80px]">
                    Site ID
                  </th>
                  <th className="text-left px-2 py-2 font-medium min-w-[120px]">
                    Site Name
                  </th>
                  {dates.slice(0, 30).map((d) => (
                    <th
                      key={d}
                      className="px-1 py-2 font-medium text-center min-w-[36px]"
                    >
                      {formatDate(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row) => (
                  <tr
                    key={`${row.provider}::${row.siteId}`}
                    className="border-b hover:bg-muted/20"
                  >
                    <td className="px-3 py-1 sticky left-0 bg-background z-10">
                      <span className="font-medium">{row.provider}</span>
                    </td>
                    <td className="px-2 py-1 text-muted-foreground truncate max-w-[100px]">
                      {row.siteId}
                    </td>
                    <td className="px-2 py-1 truncate max-w-[150px]">
                      {row.siteName}
                    </td>
                    {dates.slice(0, 30).map((d) => (
                      <StatusCell
                        key={d}
                        run={row.runs.get(d)}
                        onClick={() => {
                          const run = row.runs.get(d);
                          if (run) setSelectedRun(run);
                        }}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-emerald-100" />
          Success
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-100" />
          Error
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-amber-100" />
          No Data
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-muted" />
          Not Run
        </div>
      </div>

      {/* Run detail dialog */}
      <Dialog
        open={selectedRun !== null}
        onOpenChange={(open) => !open && setSelectedRun(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Details</DialogTitle>
          </DialogHeader>
          {selectedRun && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">Provider</p>
                  <p className="font-medium">{selectedRun.provider}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="font-medium">{selectedRun.dateKey}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Site ID</p>
                  <p className="font-medium">{selectedRun.siteId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Site Name</p>
                  <p className="font-medium">
                    {selectedRun.siteName ?? "N/A"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge
                    variant={
                      selectedRun.status === "success"
                        ? "default"
                        : selectedRun.status === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {selectedRun.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Readings</p>
                  <p className="font-medium">{selectedRun.readingsCount}</p>
                </div>
                {selectedRun.lifetimeKwh != null && (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Lifetime kWh
                    </p>
                    <p className="font-medium">
                      {selectedRun.lifetimeKwh.toLocaleString()}
                    </p>
                  </div>
                )}
                {selectedRun.durationMs != null && (
                  <div>
                    <p className="text-xs text-muted-foreground">Duration</p>
                    <p className="font-medium">{selectedRun.durationMs}ms</p>
                  </div>
                )}
              </div>
              {selectedRun.errorMessage && (
                <div className="rounded border border-destructive/20 bg-destructive/5 p-3">
                  <p className="text-xs text-destructive font-mono whitespace-pre-wrap">
                    {selectedRun.errorMessage}
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
