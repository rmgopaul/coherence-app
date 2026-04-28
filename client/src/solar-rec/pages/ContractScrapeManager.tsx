import { useAuth } from "@/_core/hooks/useAuth";
// Task 5.7 PR-B (2026-04-26): contract-scrape procs migrated from
// the main `abpSettlementRouter` to the standalone Solar REC
// `contractScan` sub-router. Aliased import keeps every
// `trpc.contractScan.*` call site routable through the standalone
// tRPC client (which targets /solar-rec/api/trpc).
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
// Task 9.3 (2026-04-28): textarea replaced by `<WorksetSelector />`.
// Same parsing semantics; adds Load-workset + Save-as-workset.
import { WorksetSelector } from "@/solar-rec/components/WorksetSelector";
import {
  ArrowLeft,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

// ── Helpers ─────────────────────────────────────────────────────────

function formatTimestamp(val: string | Date | null | undefined): string {
  if (!val) return "—";
  const d = typeof val === "string" ? new Date(val) : val;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function statusBadge(status: string) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "secondary",
    running: "default",
    stopping: "outline",
    stopped: "outline",
    completed: "secondary",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "secondary"}>{status}</Badge>;
}

// ── Component ───────────────────────────────────────────────────────

export default function ContractScrapeManager() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  // ── State ─────────────────────────────────────────────────────────
  const [csgIdInput, setCsgIdInput] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [resultsPage, setResultsPage] = useState(0);
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // ── Mutations ─────────────────────────────────────────────────────
  const startMutation = trpc.contractScan.startDbContractScanJob.useMutation({
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      startTimeRef.current = Date.now();
      toast.success(`Job started — ${data.total} contracts queued`);
      setCsgIdInput("");
    },
    onError: (err) => toast.error(err.message),
  });

  const stopMutation = trpc.contractScan.stopDbContractScanJob.useMutation({
    onSuccess: () => toast.info("Stop signal sent"),
    onError: (err) => toast.error(err.message),
  });

  const resumeMutation = trpc.contractScan.resumeDbContractScanJob.useMutation({
    onSuccess: (data) => {
      startTimeRef.current = Date.now();
      toast.success(`Resumed — ${data.pendingCount} contracts remaining`);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.contractScan.deleteDbContractScanJob.useMutation({
    onSuccess: () => {
      toast.success("Job deleted");
      setActiveJobId(null);
      setViewingJobId(null);
      jobListQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  // ── Queries ───────────────────────────────────────────────────────
  const jobStatusQuery = trpc.contractScan.getDbJobStatus.useQuery(
    { jobId: activeJobId! },
    {
      enabled: !!activeJobId,
      refetchInterval: activeJobId ? 1000 : false,
    }
  );

  const jobListQuery = trpc.contractScan.listDbContractScanJobs.useQuery(
    undefined,
    { refetchInterval: activeJobId ? 5000 : 30000 }
  );

  const resultsQuery = trpc.contractScan.getDbContractScanResults.useQuery(
    { jobId: viewingJobId!, limit: 50, offset: resultsPage * 50 },
    { enabled: !!viewingJobId }
  );

  const csvQuery = trpc.contractScan.exportDbContractScanResultsCsv.useQuery(
    { jobId: viewingJobId! },
    { enabled: false }
  );

  // ── Derived data ──────────────────────────────────────────────────
  const job = jobStatusQuery.data ?? null;

  const isActive =
    job?.status === "queued" ||
    job?.status === "running" ||
    job?.status === "stopping";

  // Stop polling once terminal
  useEffect(() => {
    if (job && !isActive) {
      // No need to keep polling
    }
  }, [job, isActive]);

  // Auto-load latest active job on mount
  useEffect(() => {
    if (!activeJobId && jobListQuery.data && jobListQuery.data.length > 0) {
      const latestActive = jobListQuery.data.find(
        (j) =>
          j.status === "running" ||
          j.status === "queued" ||
          j.status === "stopping"
      );
      if (latestActive) {
        setActiveJobId(latestActive.id);
        startTimeRef.current = latestActive.startedAt
          ? new Date(latestActive.startedAt).getTime()
          : Date.now();
      }
    }
  }, [activeJobId, jobListQuery.data]);

  // ETA calculation
  const eta = useMemo(() => {
    if (!job || !isActive || !startTimeRef.current) return null;
    const processed = job.processed;
    if (processed <= 0) return null;
    const elapsed = Date.now() - startTimeRef.current;
    const rate = processed / (elapsed / 1000); // per second
    if (rate <= 0) return null;
    const remaining = job.remaining;
    const etaMs = (remaining / rate) * 1000;
    return { etaMs, rate };
  }, [job, isActive]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleStart = useCallback(() => {
    const ids = csgIdInput
      .split(/[\n,\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      toast.error("Paste at least one CSG ID");
      return;
    }
    startMutation.mutate({ csgIds: ids });
  }, [csgIdInput, startMutation]);

  const handleExportCsv = useCallback(async () => {
    const result = await csvQuery.refetch();
    if (result.data) {
      const blob = new Blob([result.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contract-scan-results-${viewingJobId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    }
  }, [csvQuery, viewingJobId]);

  if (!user) return null;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Contract Scrape Manager</h1>
          <p className="text-sm text-muted-foreground">
            Scrape ABP contracts from the CSG portal at scale
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Job Launcher ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Start New Job</CardTitle>
            <CardDescription>
              Paste CSG IDs (one per line or comma-separated) or load
              a saved workset.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <WorksetSelector
              value={csgIdInput}
              onChange={setCsgIdInput}
              disabled={isActive}
              placeholder={"CSG-12345\nCSG-12346\nCSG-12347"}
            />
            <div className="flex justify-end">
              <Button
                onClick={handleStart}
                disabled={
                  startMutation.isPending ||
                  !csgIdInput.trim() ||
                  isActive
                }
              >
                {startMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Job
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Active Job Progress ───────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Active Job
              {job ? (
                <span className="ml-2">{statusBadge(job.status)}</span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!job ? (
              <p className="text-sm text-muted-foreground">
                No active job. Start one to begin scraping.
              </p>
            ) : (
              <div className="space-y-4">
                <Progress value={job.percent} className="h-3" />

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Total" value={job.totalContracts} />
                  <StatCard
                    label="Scraped"
                    value={job.successCount}
                    className="text-green-700"
                  />
                  <StatCard
                    label="Failed"
                    value={job.failureCount}
                    className="text-red-600"
                  />
                  <StatCard label="Remaining" value={job.remaining} />
                </div>

                {job.currentCsgId && isActive && (
                  <p className="text-xs text-muted-foreground">
                    Current: <code>{job.currentCsgId}</code>
                  </p>
                )}

                {eta && (
                  <p className="text-xs text-muted-foreground">
                    Rate: {eta.rate.toFixed(1)}/s — ETA:{" "}
                    {formatDuration(eta.etaMs)}
                  </p>
                )}

                {job.error && (
                  <p className="text-xs text-red-600 bg-red-50 p-2 rounded">
                    {job.error}
                  </p>
                )}

                <div className="flex gap-2">
                  {(job.status === "running" ||
                    job.status === "queued") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        stopMutation.mutate({ jobId: job.id })
                      }
                      disabled={stopMutation.isPending}
                    >
                      <Pause className="h-3 w-3 mr-1" />
                      Stop
                    </Button>
                  )}
                  {(job.status === "stopped" ||
                    job.status === "failed") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        resumeMutation.mutate({ jobId: job.id })
                      }
                      disabled={resumeMutation.isPending}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Resume
                    </Button>
                  )}
                  {(job.status === "stopped" ||
                    job.status === "failed" ||
                    job.status === "completed") && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() =>
                        deleteMutation.mutate({ jobId: job.id })
                      }
                      disabled={deleteMutation.isPending}
                    >
                      Delete Job
                    </Button>
                  )}
                  {job.successCount > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setViewingJobId(job.id);
                        setResultsPage(0);
                      }}
                    >
                      View Results
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Job History ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Job History</CardTitle>
        </CardHeader>
        <CardContent>
          {!jobListQuery.data || jobListQuery.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jobs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Success</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobListQuery.data.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>{statusBadge(j.status)}</TableCell>
                    <TableCell>{j.totalContracts}</TableCell>
                    <TableCell className="text-green-700">
                      {j.successCount}
                    </TableCell>
                    <TableCell className="text-red-600">
                      {j.failureCount}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTimestamp(j.startedAt)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTimestamp(j.completedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setActiveJobId(j.id);
                            startTimeRef.current = j.startedAt
                              ? new Date(j.startedAt).getTime()
                              : Date.now();
                          }}
                        >
                          Monitor
                        </Button>
                        {j.successCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setViewingJobId(j.id);
                              setResultsPage(0);
                            }}
                          >
                            Results
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Results Table ─────────────────────────────────────────── */}
      {viewingJobId && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">
                Scan Results
              </CardTitle>
              <CardDescription>
                {resultsQuery.data?.total ?? 0} total results
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={csvQuery.isFetching}
            >
              {csvQuery.isFetching ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Download className="h-3 w-3 mr-1" />
              )}
              Export CSV
            </Button>
          </CardHeader>
          <CardContent>
            {resultsQuery.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>CSG ID</TableHead>
                        <TableHead>System Name</TableHead>
                        <TableHead>Vendor Fee %</TableHead>
                        <TableHead>Add. Collateral %</TableHead>
                        <TableHead>CC Auth</TableHead>
                        <TableHead>5% Selected</TableHead>
                        <TableHead>AC kW</TableHead>
                        <TableHead>REC Qty</TableHead>
                        <TableHead>REC Price</TableHead>
                        <TableHead>Payment</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(resultsQuery.data?.rows ?? []).map((r) => (
                        <TableRow
                          key={r.id}
                          className={r.error ? "bg-red-50/50" : ""}
                        >
                          <TableCell className="font-mono text-xs">
                            {r.csgId}
                          </TableCell>
                          <TableCell className="text-xs max-w-[180px] truncate">
                            {r.systemName ?? "—"}
                          </TableCell>
                          <TableCell>
                            {r.vendorFeePercent != null
                              ? `${r.vendorFeePercent}%`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {r.additionalCollateralPercent != null
                              ? `${r.additionalCollateralPercent}%`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {r.ccAuthorizationCompleted === true
                              ? "Yes"
                              : r.ccAuthorizationCompleted === false
                                ? "No"
                                : "—"}
                          </TableCell>
                          <TableCell>
                            {r.additionalFivePercentSelected === true
                              ? "Yes"
                              : r.additionalFivePercentSelected === false
                                ? "No"
                                : "—"}
                          </TableCell>
                          <TableCell>
                            {r.acSizeKw != null ? r.acSizeKw : "—"}
                          </TableCell>
                          <TableCell>
                            {r.recQuantity != null ? r.recQuantity : "—"}
                          </TableCell>
                          <TableCell>
                            {r.recPrice != null
                              ? `$${r.recPrice.toFixed(2)}`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.paymentMethod ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs text-red-600 max-w-[200px] truncate">
                            {r.error ?? ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {(resultsQuery.data?.total ?? 0) > 50 && (
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      Page {resultsPage + 1} of{" "}
                      {Math.ceil((resultsQuery.data?.total ?? 0) / 50)}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={resultsPage === 0}
                        onClick={() =>
                          setResultsPage((p) => Math.max(0, p - 1))
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          (resultsPage + 1) * 50 >=
                          (resultsQuery.data?.total ?? 0)
                        }
                        onClick={() => setResultsPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold ${className ?? ""}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
