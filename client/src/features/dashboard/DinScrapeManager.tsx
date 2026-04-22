import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
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
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Bug,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

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
  const variants: Record<
    string,
    "default" | "secondary" | "destructive" | "outline"
  > = {
    queued: "secondary",
    running: "default",
    stopping: "outline",
    stopped: "outline",
    completed: "secondary",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "secondary"}>{status}</Badge>;
}

function sourceBadge(sourceType: string) {
  const variants: Record<
    string,
    "default" | "secondary" | "destructive" | "outline"
  > = {
    inverter: "default",
    meter: "secondary",
    unknown: "outline",
  };
  return (
    <Badge variant={variants[sourceType] ?? "outline"} className="capitalize">
      {sourceType}
    </Badge>
  );
}

export default function DinScrapeManager() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const [csgIdInput, setCsgIdInput] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);
  const [dinsPage, setDinsPage] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  const startMutation = trpc.dinScrape.startJob.useMutation({
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      startTimeRef.current = Date.now();
      toast.success(`Job started — ${data.total} sites queued`);
      setCsgIdInput("");
    },
    onError: (err) => toast.error(err.message),
  });

  const stopMutation = trpc.dinScrape.stopJob.useMutation({
    onSuccess: () => toast.info("Stop signal sent"),
    onError: (err) => toast.error(err.message),
  });

  const resumeMutation = trpc.dinScrape.resumeJob.useMutation({
    onSuccess: (data) => {
      startTimeRef.current = Date.now();
      toast.success(`Resumed — ${data.pendingCount} sites remaining`);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.dinScrape.deleteJob.useMutation({
    onSuccess: () => {
      toast.success("Job deleted");
      setActiveJobId(null);
      setViewingJobId(null);
      jobListQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const jobStatusQuery = trpc.dinScrape.getJobStatus.useQuery(
    { jobId: activeJobId! },
    {
      enabled: !!activeJobId,
      refetchInterval: activeJobId ? 1000 : false,
    }
  );

  const jobListQuery = trpc.dinScrape.listJobs.useQuery(undefined, {
    refetchInterval: activeJobId ? 5000 : 30000,
  });

  const dinsQuery = trpc.dinScrape.getDins.useQuery(
    { jobId: viewingJobId!, limit: 100, offset: dinsPage * 100 },
    { enabled: !!viewingJobId }
  );

  const csvQuery = trpc.dinScrape.exportDinsCsv.useQuery(
    { jobId: viewingJobId! },
    { enabled: false }
  );

  const debugQuery = trpc.dinScrape.debugRaw.useQuery(
    { jobId: activeJobId! },
    { enabled: false }
  );

  const job = jobStatusQuery.data ?? null;
  const isActive =
    job?.status === "queued" ||
    job?.status === "running" ||
    job?.status === "stopping";

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

  const eta = useMemo(() => {
    if (!job || !isActive || !startTimeRef.current) return null;
    const processed = job.processed;
    if (processed <= 0) return null;
    const elapsed = Date.now() - startTimeRef.current;
    const rate = processed / (elapsed / 1000);
    if (rate <= 0) return null;
    const remaining = job.remaining;
    const etaMs = (remaining / rate) * 1000;
    return { etaMs, rate };
  }, [job, isActive]);

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

  const handleDebugRaw = useCallback(async () => {
    if (!activeJobId) return;
    const result = await debugQuery.refetch();
    if (result.data) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `din-scrape-debug-${activeJobId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Raw snapshot downloaded");
    }
  }, [activeJobId, debugQuery]);

  const handleExportCsv = useCallback(async () => {
    const result = await csvQuery.refetch();
    if (result.data) {
      const blob = new Blob([result.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `din-scrape-${viewingJobId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    }
  }, [csvQuery, viewingJobId]);

  if (!user) return null;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">DIN Scraper</h1>
          <p className="text-sm text-muted-foreground">
            Pull inverter & meter photos from the CSG portal and extract every
            DIN Claude can see on the labels.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Start New Job</CardTitle>
            <CardDescription>
              Paste CSG IDs (one per line or comma-separated)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={csgIdInput}
              onChange={(e) => setCsgIdInput(e.target.value)}
              placeholder={"CSG-12345\nCSG-12346\nCSG-12347"}
              rows={6}
              className="font-mono text-xs"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {
                  csgIdInput
                    .split(/[\n,\t]+/)
                    .filter((s) => s.trim()).length
                }{" "}
                IDs detected
              </span>
              <Button
                onClick={handleStart}
                disabled={
                  startMutation.isPending || !csgIdInput.trim() || isActive
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
                  <StatCard label="Total" value={job.totalSites} />
                  <StatCard
                    label="Scanned"
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
                    Rate: {eta.rate.toFixed(2)}/s — ETA:{" "}
                    {formatDuration(eta.etaMs)}
                  </p>
                )}

                {job.error && (
                  <p className="text-xs text-red-600 bg-red-50 p-2 rounded">
                    {job.error}
                  </p>
                )}

                <p className="text-[11px] text-muted-foreground">
                  Runner: <code>{job._runnerVersion}</code>
                </p>

                <div className="flex gap-2">
                  {(job.status === "running" ||
                    job.status === "queued") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => stopMutation.mutate({ jobId: job.id })}
                      disabled={stopMutation.isPending}
                    >
                      <Pause className="h-3 w-3 mr-1" />
                      Stop
                    </Button>
                  )}
                  {(job.status === "stopped" || job.status === "failed") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resumeMutation.mutate({ jobId: job.id })}
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
                      onClick={() => deleteMutation.mutate({ jobId: job.id })}
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
                        setDinsPage(0);
                      }}
                    >
                      View DINs
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDebugRaw}
                    disabled={debugQuery.isFetching}
                    title="Download raw DB state for this job"
                  >
                    {debugQuery.isFetching ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Bug className="h-3 w-3 mr-1" />
                    )}
                    Raw
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
                    <TableCell>{j.totalSites}</TableCell>
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
                              setDinsPage(0);
                            }}
                          >
                            DINs
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

      {viewingJobId && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Extracted DINs</CardTitle>
              <CardDescription>
                {dinsQuery.data?.total ?? 0} DINs found across all sites in
                this job
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
            {dinsQuery.isLoading ? (
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
                        <TableHead>DIN</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Extractor</TableHead>
                        <TableHead>File</TableHead>
                        <TableHead>Photo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(dinsQuery.data?.rows ?? []).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">
                            {r.csgId}
                          </TableCell>
                          <TableCell className="font-mono text-xs font-semibold">
                            {r.dinValue}
                          </TableCell>
                          <TableCell>{sourceBadge(r.sourceType)}</TableCell>
                          <TableCell className="text-xs capitalize">
                            {r.extractedBy}
                          </TableCell>
                          <TableCell className="text-xs max-w-[160px] truncate">
                            {r.sourceFileName ?? "—"}
                          </TableCell>
                          <TableCell>
                            {r.sourceUrl ? (
                              <a
                                href={r.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-blue-600 underline"
                              >
                                open
                              </a>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {(dinsQuery.data?.total ?? 0) > 100 && (
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      Page {dinsPage + 1} of{" "}
                      {Math.ceil((dinsQuery.data?.total ?? 0) / 100)}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dinsPage === 0}
                        onClick={() =>
                          setDinsPage((p) => Math.max(0, p - 1))
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          (dinsPage + 1) * 100 >=
                          (dinsQuery.data?.total ?? 0)
                        }
                        onClick={() => setDinsPage((p) => p + 1)}
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
