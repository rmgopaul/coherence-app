/**
 * 2026-05-10 — per-job detail view for the unified `/solar-rec/jobs`
 * index.
 *
 * Background. The index page (`JobsIndex.tsx`) lists every long-
 * running job in one normalized table. Pre-PR a row click navigated
 * straight to a "manager" — for the 3 batch runners (contract-scan,
 * din-scrape, schedule-b-import) that landed on a real per-runner
 * manager page with full per-job details; for the 3 newer kinds
 * (`dashboard-build`, `dashboard-csv-export`, `dataset-upload`) it
 * just landed on `/solar-rec/dashboard`, which shows CURRENT state,
 * not the specific historical job. There was no way to ask "why did
 * build X fail at 14:30" or "what was the artifact URL for export
 * Y" without spelunking the DB.
 *
 * This page is the detail view for the 3 newer kinds. The 3 batch
 * runners keep their existing manager-page deep-link unchanged
 * (their managers already do this job).
 *
 * URL: `/solar-rec/jobs/:kind/:id`
 *   - `kind` ∈ {dashboard-build, dashboard-csv-export, dataset-upload}
 *   - `id` is the job's primary key
 *
 * Each `<kind>Detail>` sub-component owns its own `useQuery` against
 * the existing per-job status proc (`getDashboardBuildStatus`,
 * `getDashboardCsvExportJobStatus`, `getDatasetUploadStatus`). No
 * new server procs needed.
 *
 * Live jobs poll on a 3s cadence (matches the index). Terminal jobs
 * fetch once.
 */
import { useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { PermissionGate } from "../components/PermissionGate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ExternalLink,
  Download,
  RefreshCcw,
} from "lucide-react";

type RunnerKind =
  | "dashboard-build"
  | "dashboard-csv-export"
  | "dataset-upload";

const KIND_LABEL: Record<RunnerKind, string> = {
  "dashboard-build": "Dashboard Rebuild",
  "dashboard-csv-export": "Dashboard CSV Export",
  "dataset-upload": "Dataset Upload",
};

function isLivePollStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (
    status === "queued" ||
    status === "running" ||
    status === "uploading" ||
    status === "parsing" ||
    status === "preparing" ||
    status === "writing"
  );
}

function statusVariant(
  status: string | null | undefined
): "default" | "secondary" | "destructive" | "outline" {
  if (!status) return "outline";
  if (
    status === "running" ||
    status === "uploading" ||
    status === "parsing" ||
    status === "preparing" ||
    status === "writing"
  )
    return "default";
  if (status === "queued") return "secondary";
  if (status === "succeeded" || status === "done") return "outline";
  if (status === "failed") return "destructive";
  return "outline";
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatDuration(
  startedAt: Date | string | null | undefined,
  completedAt: Date | string | null | undefined
): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "—";
  const end = completedAt
    ? new Date(completedAt).getTime()
    : Date.now();
  if (!Number.isFinite(end)) return "—";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function JobDetail() {
  return (
    <PermissionGate moduleKey="jobs">
      <JobDetailImpl />
    </PermissionGate>
  );
}

function JobDetailImpl() {
  const params = useParams<{ kind?: string; id?: string }>();
  const [, setLocation] = useLocation();
  const kind = params.kind as RunnerKind | undefined;
  const id = params.id;

  if (
    !id ||
    !kind ||
    !["dashboard-build", "dashboard-csv-export", "dataset-upload"].includes(kind)
  ) {
    return (
      <UnknownKind kind={kind ?? null} id={id ?? null} setLocation={setLocation} />
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/solar-rec/jobs")}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="ml-1.5">Back to Jobs</span>
        </Button>
      </div>
      {kind === "dashboard-build" ? (
        <BuildDetail buildId={id} setLocation={setLocation} />
      ) : kind === "dashboard-csv-export" ? (
        <CsvExportDetail jobId={id} setLocation={setLocation} />
      ) : (
        <UploadDetail jobId={id} setLocation={setLocation} />
      )}
    </div>
  );
}

function UnknownKind({
  kind,
  id,
  setLocation,
}: {
  kind: string | null;
  id: string | null;
  setLocation: (path: string) => void;
}) {
  return (
    <div className="container mx-auto p-6 space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setLocation("/solar-rec/jobs")}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="ml-1.5">Back to Jobs</span>
      </Button>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unknown job</CardTitle>
          <CardDescription>
            {kind ? (
              <>
                The runner kind <code className="font-mono">{kind}</code> isn't
                recognised by this detail page. Detail views exist for
                dashboard rebuilds, CSV exports, and dataset uploads. The
                three batch runners (contract scrape, DIN scrape,
                Schedule B import) have their own manager pages — return to
                Jobs and click the row to navigate there.
              </>
            ) : (
              "Job kind not specified."
            )}
            {id && (
              <>
                {" "}
                Job ID: <code className="font-mono">{id}</code>.
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Dashboard build detail
// ─────────────────────────────────────────────────────────────────

interface BuildDetailProgress {
  currentStep?: number;
  totalSteps?: number;
  percent?: number;
  message?: string;
  factTable?: string;
}

function BuildDetail({
  buildId,
  setLocation,
}: {
  buildId: string;
  setLocation: (path: string) => void;
}) {
  const query =
    trpc.solarRecDashboard.getDashboardBuildStatus.useQuery(
      { buildId },
      {
        refetchInterval: (q) => {
          const status = (q.state.data as { status?: string } | undefined)?.status;
          return isLivePollStatus(status) ? 3000 : false;
        },
      }
    );

  // No `data` until the first fetch resolves — render a skeleton.
  if (query.isLoading) {
    return <DetailSkeleton kind="dashboard-build" id={buildId} />;
  }
  if (query.error) {
    return <DetailError kind="dashboard-build" id={buildId} message={query.error.message} />;
  }
  const data = query.data as
    | {
        buildId?: string;
        status?: string;
        progress?: BuildDetailProgress | null;
        errorMessage?: string | null;
        startedAt?: string | Date | null;
        completedAt?: string | Date | null;
        createdAt?: string | Date | null;
        updatedAt?: string | Date | null;
        runnerVersion?: string;
        _runnerVersion?: string;
      }
    | undefined;
  if (!data) {
    return <DetailError kind="dashboard-build" id={buildId} message="Empty response" />;
  }

  const progress = data.progress ?? null;
  const status = data.status ?? "unknown";

  return (
    <DetailShell
      kind="dashboard-build"
      id={buildId}
      status={status}
      onRefresh={() => query.refetch()}
      isFetching={query.isFetching}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow
            label="Step"
            value={
              progress?.currentStep != null && progress?.totalSteps != null
                ? `${progress.currentStep} of ${progress.totalSteps}`
                : "—"
            }
          />
          <DetailRow label="Percent" value={progress?.percent != null ? `${progress.percent}%` : "—"} />
          <DetailRow label="Fact table" value={progress?.factTable ?? "—"} />
          <DetailRow label="Message" value={progress?.message ?? "—"} />
        </CardContent>
      </Card>

      <TimingCard
        createdAt={data.createdAt}
        startedAt={data.startedAt}
        completedAt={data.completedAt}
        updatedAt={data.updatedAt}
        status={status}
      />

      {data.errorMessage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap break-words bg-destructive/10 text-destructive p-3 rounded">
              {data.errorMessage}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow label="Runner version" value={data.runnerVersion ?? "—"} mono />
          <DetailRow label="Proc version" value={data._runnerVersion ?? "—"} mono />
        </CardContent>
      </Card>

      <ManagerLink
        href="/solar-rec/dashboard"
        label="Open dashboard"
        setLocation={setLocation}
      />
    </DetailShell>
  );
}

// ─────────────────────────────────────────────────────────────────
// CSV export detail
// ─────────────────────────────────────────────────────────────────

function CsvExportDetail({
  jobId,
  setLocation,
}: {
  jobId: string;
  setLocation: (path: string) => void;
}) {
  const query =
    trpc.solarRecDashboard.getDashboardCsvExportJobStatus.useQuery(
      { jobId },
      {
        refetchInterval: (q) => {
          const status = (q.state.data as { status?: string } | undefined)?.status;
          return isLivePollStatus(status) ? 3000 : false;
        },
      }
    );

  if (query.isLoading) {
    return <DetailSkeleton kind="dashboard-csv-export" id={jobId} />;
  }
  if (query.error) {
    return <DetailError kind="dashboard-csv-export" id={jobId} message={query.error.message} />;
  }
  const data = query.data as
    | {
        status?: string;
        fileName?: string | null;
        url?: string | null;
        rowCount?: number | null;
        csvBytes?: number | null;
        error?: string | null;
        startedAt?: string | Date | null;
        completedAt?: string | Date | null;
        createdAt?: string | Date | null;
        _runnerVersion?: string;
      }
    | undefined;
  if (!data) {
    return <DetailError kind="dashboard-csv-export" id={jobId} message="Empty response" />;
  }

  const status = data.status ?? "unknown";

  return (
    <DetailShell
      kind="dashboard-csv-export"
      id={jobId}
      status={status}
      onRefresh={() => query.refetch()}
      isFetching={query.isFetching}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Result</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow label="File name" value={data.fileName ?? "—"} mono />
          <DetailRow label="Row count" value={data.rowCount != null ? data.rowCount.toLocaleString() : "—"} />
          <DetailRow label="CSV size" value={formatBytes(data.csvBytes)} />
          {data.url && (
            <div className="pt-2">
              <Button asChild size="sm" variant="outline">
                <a href={data.url} target="_blank" rel="noopener noreferrer">
                  <Download className="h-3.5 w-3.5" />
                  <span className="ml-1.5">Download</span>
                </a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <TimingCard
        createdAt={data.createdAt}
        startedAt={data.startedAt}
        completedAt={data.completedAt}
        updatedAt={null}
        status={status}
      />

      {data.error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap break-words bg-destructive/10 text-destructive p-3 rounded">
              {data.error}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow label="Proc version" value={data._runnerVersion ?? "—"} mono />
        </CardContent>
      </Card>

      <ManagerLink
        href="/solar-rec/dashboard"
        label="Open dashboard"
        setLocation={setLocation}
      />
    </DetailShell>
  );
}

// ─────────────────────────────────────────────────────────────────
// Dataset upload detail
// ─────────────────────────────────────────────────────────────────

function UploadDetail({
  jobId,
  setLocation,
}: {
  jobId: string;
  setLocation: (path: string) => void;
}) {
  const query =
    trpc.solarRecDashboard.getDatasetUploadStatus.useQuery(
      { jobId },
      {
        refetchInterval: (q) => {
          const status = (q.state.data as { job?: { status?: string } } | undefined)?.job?.status;
          return isLivePollStatus(status) ? 3000 : false;
        },
      }
    );

  if (query.isLoading) {
    return <DetailSkeleton kind="dataset-upload" id={jobId} />;
  }
  if (query.error) {
    return <DetailError kind="dataset-upload" id={jobId} message={query.error.message} />;
  }
  const data = query.data as
    | {
        job?: {
          id?: string;
          datasetKey?: string;
          fileName?: string;
          fileSizeBytes?: number | null;
          status?: string;
          totalChunks?: number | null;
          uploadedChunks?: number | null;
          totalRows?: number | null;
          rowsParsed?: number | null;
          rowsWritten?: number | null;
          errorMessage?: string | null;
          batchId?: string | null;
          startedAt?: string | Date | null;
          completedAt?: string | Date | null;
          createdAt?: string | Date | null;
          updatedAt?: string | Date | null;
        };
        errors?: Array<{ id: string; rowIndex: number | null; errorMessage: string }>;
        _runnerVersion?: string;
      }
    | undefined;
  if (!data?.job) {
    return <DetailError kind="dataset-upload" id={jobId} message="Empty response" />;
  }

  const job = data.job;
  const status = job.status ?? "unknown";
  const dedupedRows =
    job.rowsParsed != null && job.rowsWritten != null
      ? Math.max(0, job.rowsParsed - job.rowsWritten)
      : null;

  return (
    <DetailShell
      kind="dataset-upload"
      id={jobId}
      status={status}
      onRefresh={() => query.refetch()}
      isFetching={query.isFetching}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow label="Dataset" value={job.datasetKey ?? "—"} mono />
          <DetailRow label="File name" value={job.fileName ?? "—"} mono />
          <DetailRow label="File size" value={formatBytes(job.fileSizeBytes)} />
          <DetailRow
            label="Chunks"
            value={
              job.totalChunks != null
                ? `${job.uploadedChunks ?? 0} of ${job.totalChunks}`
                : "—"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow
            label="Total"
            value={job.totalRows != null ? job.totalRows.toLocaleString() : "—"}
          />
          <DetailRow
            label="Parsed"
            value={job.rowsParsed != null ? job.rowsParsed.toLocaleString() : "—"}
          />
          <DetailRow
            label="Written"
            value={job.rowsWritten != null ? job.rowsWritten.toLocaleString() : "—"}
          />
          <DetailRow
            label="Deduped"
            value={
              dedupedRows != null
                ? `${dedupedRows.toLocaleString()} (parsed but already in active batch)`
                : "—"
            }
          />
          <DetailRow label="Batch ID" value={job.batchId ?? "—"} mono />
        </CardContent>
      </Card>

      <TimingCard
        createdAt={job.createdAt}
        startedAt={job.startedAt}
        completedAt={job.completedAt}
        updatedAt={job.updatedAt}
        status={status}
      />

      {job.errorMessage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs whitespace-pre-wrap break-words bg-destructive/10 text-destructive p-3 rounded">
              {job.errorMessage}
            </pre>
          </CardContent>
        </Card>
      )}

      {data.errors && data.errors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-row errors</CardTitle>
            <CardDescription>
              First {data.errors.length} row-level parse errors. Full list is in
              `datasetUploadJobErrors` keyed on the job id.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {data.errors.slice(0, 20).map((err) => (
                <div key={err.id} className="text-xs border-l-2 border-destructive pl-2">
                  <span className="font-mono text-muted-foreground">
                    row {err.rowIndex ?? "—"}:
                  </span>{" "}
                  {err.errorMessage}
                </div>
              ))}
              {data.errors.length > 20 && (
                <div className="text-xs text-muted-foreground italic">
                  {data.errors.length - 20} more …
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Diagnostics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DetailRow label="Proc version" value={data._runnerVersion ?? "—"} mono />
        </CardContent>
      </Card>

      <ManagerLink
        href="/solar-rec/dashboard"
        label="Open dashboard"
        setLocation={setLocation}
      />
    </DetailShell>
  );
}

// ─────────────────────────────────────────────────────────────────
// Shared building blocks
// ─────────────────────────────────────────────────────────────────

function DetailShell({
  kind,
  id,
  status,
  onRefresh,
  isFetching,
  children,
}: {
  kind: RunnerKind;
  id: string;
  status: string;
  onRefresh: () => void;
  isFetching: boolean;
  children: React.ReactNode;
}) {
  // Update document title for tab tracking — useful when polling a
  // live build across many tabs.
  useEffect(() => {
    const prev = document.title;
    document.title = `${KIND_LABEL[kind]} · ${status} · ${id.slice(0, 8)}`;
    return () => {
      document.title = prev;
    };
  }, [kind, id, status]);

  return (
    <>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{KIND_LABEL[kind]}</h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            {id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(status)} className="text-xs">
            {status}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
            />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </>
  );
}

function TimingCard({
  createdAt,
  startedAt,
  completedAt,
  updatedAt,
  status,
}: {
  createdAt: Date | string | null | undefined;
  startedAt: Date | string | null | undefined;
  completedAt: Date | string | null | undefined;
  updatedAt: Date | string | null | undefined;
  status: string;
}) {
  const durationLabel = useMemo(() => {
    const live = isLivePollStatus(status);
    return live ? "Running for" : "Duration";
  }, [status]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <DetailRow label="Created" value={formatDate(createdAt)} />
        <DetailRow label="Started" value={formatDate(startedAt)} />
        <DetailRow label="Completed" value={formatDate(completedAt)} />
        {updatedAt && (
          <DetailRow label="Last update" value={formatDate(updatedAt)} />
        )}
        <DetailRow label={durationLabel} value={formatDuration(startedAt, completedAt)} />
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-xs text-right break-all ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ManagerLink({
  href,
  label,
  setLocation,
}: {
  href: string;
  label: string;
  setLocation: (path: string) => void;
}) {
  return (
    <Card className="md:col-span-2">
      <CardContent className="pt-6">
        <Button variant="default" size="sm" onClick={() => setLocation(href)}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="ml-1.5">{label}</span>
        </Button>
      </CardContent>
    </Card>
  );
}

function DetailSkeleton({ kind, id }: { kind: RunnerKind; id: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{KIND_LABEL[kind]}</h1>
      <p className="text-xs font-mono text-muted-foreground">{id}</p>
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  );
}

function DetailError({
  kind,
  id,
  message,
}: {
  kind: RunnerKind;
  id: string;
  message: string;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{KIND_LABEL[kind]}</h1>
      <p className="text-xs font-mono text-muted-foreground">{id}</p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            Could not load
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs whitespace-pre-wrap break-words">{message}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
