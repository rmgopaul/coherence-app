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
  const [viewingTab, setViewingTab] = useState<"dins" | "sites">("dins");
  const [dinsPage, setDinsPage] = useState(0);
  const [sitesPage, setSitesPage] = useState(0);
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
    { enabled: !!viewingJobId && viewingTab === "dins" }
  );

  const resultsQuery = trpc.dinScrape.getResults.useQuery(
    { jobId: viewingJobId!, limit: 100, offset: sitesPage * 100 },
    { enabled: !!viewingJobId && viewingTab === "sites" }
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
                        setViewingTab("dins");
                        setDinsPage(0);
                        setSitesPage(0);
                      }}
                    >
                      View Results
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
                  <TableHead>DINs</TableHead>
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
                    <TableCell className="font-semibold">
                      {j.totalDins.toLocaleString()}
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
                              setViewingTab("dins");
                              setDinsPage(0);
                              setSitesPage(0);
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

      {viewingJobId && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Results</CardTitle>
              <CardDescription>
                {viewingTab === "dins"
                  ? `${dinsQuery.data?.total ?? 0} DINs extracted across all sites`
                  : `${resultsQuery.data?.total ?? 0} sites scanned`}
              </CardDescription>
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex rounded-md border">
                <Button
                  variant={viewingTab === "dins" ? "secondary" : "ghost"}
                  size="sm"
                  className="rounded-r-none"
                  onClick={() => setViewingTab("dins")}
                >
                  DINs
                </Button>
                <Button
                  variant={viewingTab === "sites" ? "secondary" : "ghost"}
                  size="sm"
                  className="rounded-l-none"
                  onClick={() => setViewingTab("sites")}
                >
                  Sites
                </Button>
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
                Export DINs CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {viewingTab === "dins" ? (
              <DinsTable
                data={dinsQuery.data}
                isLoading={dinsQuery.isLoading}
                page={dinsPage}
                onPageChange={setDinsPage}
              />
            ) : (
              <SitesTable
                data={resultsQuery.data}
                isLoading={resultsQuery.isLoading}
                page={sitesPage}
                onPageChange={setSitesPage}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type PaginatedRows<T> = { rows: T[]; total: number } | undefined;

type DinRow = {
  id: string;
  csgId: string;
  dinValue: string;
  sourceType: string;
  extractedBy: string;
  sourceFileName: string | null;
  sourceUrl: string | null;
};

function DinsTable({
  data,
  isLoading,
  page,
  onPageChange,
}: {
  data: PaginatedRows<DinRow>;
  isLoading: boolean;
  page: number;
  onPageChange: (updater: (p: number) => number) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  return (
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
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.csgId}</TableCell>
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
      <Pagination page={page} total={total} pageSize={100} onPageChange={onPageChange} />
    </>
  );
}

type SiteRow = {
  id: string;
  csgId: string;
  inverterPhotoCount: number;
  meterPhotoCount: number;
  dinCount: number;
  steId: string | null;
  error: string | null;
  systemPageUrl: string | null;
  extractorLog: string | null;
};

type PhotoLog = {
  photoFileName?: string;
  photoUrl?: string;
  finalExtractor?: "claude" | "tesseract" | "pdfjs" | "qr" | "none";
  qr?: { payloads?: string[]; matchedDins?: string[]; error?: string };
  claude?: Array<{
    rotation: number;
    dinsFound: number;
    rawTextSnippet?: string;
    error?: string;
  }>;
  tesseract?: {
    rotation: number;
    dinsFound: number;
    rawTextSnippet?: string;
    error?: string;
  };
  error?: string;
};

function summarizeExtractorLog(raw: string | null): string {
  if (!raw) return "—";
  try {
    const parsed = JSON.parse(raw) as { photos?: PhotoLog[] };
    const photos = parsed.photos ?? [];
    if (photos.length === 0) return "no photos";
    const parts: string[] = [];
    for (const p of photos) {
      const hits = p.finalExtractor ?? "none";
      if (hits !== "none") {
        parts.push(`${hits}`);
      } else if (p.claude && p.claude.length > 0) {
        const lastReason = p.claude[p.claude.length - 1].rawTextSnippet;
        const excerpt =
          typeof lastReason === "string"
            ? lastReason
                .replace(/\s+/g, " ")
                .slice(0, 80)
            : "";
        parts.push(`miss${excerpt ? ` (${excerpt}…)` : ""}`);
      } else {
        parts.push("miss");
      }
    }
    return parts.join(", ");
  } catch {
    return "unparseable";
  }
}

function downloadExtractorLog(csgId: string, raw: string | null) {
  if (!raw) return;
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // keep raw
  }
  const blob = new Blob([pretty], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `din-scrape-log-${csgId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function SitesTable({
  data,
  isLoading,
  page,
  onPageChange,
}: {
  data: PaginatedRows<SiteRow>;
  isLoading: boolean;
  page: number;
  onPageChange: (updater: (p: number) => number) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>CSG ID</TableHead>
              <TableHead>STE ID</TableHead>
              <TableHead>Inv photos</TableHead>
              <TableHead>Meter photos</TableHead>
              <TableHead>DINs</TableHead>
              <TableHead>Extractor outcome</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Links</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.id}
                className={r.error ? "bg-red-50/50" : undefined}
              >
                <TableCell className="font-mono text-xs">{r.csgId}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.steId ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>{r.inverterPhotoCount}</TableCell>
                <TableCell>{r.meterPhotoCount}</TableCell>
                <TableCell
                  className={r.dinCount === 0 ? "text-muted-foreground" : "font-semibold"}
                >
                  {r.dinCount}
                </TableCell>
                <TableCell
                  className="text-xs max-w-[320px] truncate"
                  title={r.extractorLog ?? ""}
                >
                  {summarizeExtractorLog(r.extractorLog)}
                </TableCell>
                <TableCell className="text-xs text-red-600 max-w-[200px] truncate">
                  {r.error ?? ""}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {r.systemPageUrl ? (
                    <a
                      href={r.systemPageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline mr-2"
                    >
                      page
                    </a>
                  ) : null}
                  {r.extractorLog ? (
                    <button
                      type="button"
                      className="text-blue-600 underline"
                      onClick={() =>
                        downloadExtractorLog(r.csgId, r.extractorLog)
                      }
                    >
                      log
                    </button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={page} total={total} pageSize={100} onPageChange={onPageChange} />
    </>
  );
}

function Pagination({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (updater: (p: number) => number) => void;
}) {
  if (total <= pageSize) return null;
  const lastPage = Math.ceil(total / pageSize);
  return (
    <div className="flex items-center justify-between mt-4">
      <span className="text-xs text-muted-foreground">
        Page {page + 1} of {lastPage}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => onPageChange((p) => Math.max(0, p - 1))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={(page + 1) * pageSize >= total}
          onClick={() => onPageChange((p) => p + 1)}
        >
          Next
        </Button>
      </div>
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
