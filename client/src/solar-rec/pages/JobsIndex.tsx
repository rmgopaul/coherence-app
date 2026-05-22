/**
 * Task 8.2 (2026-04-27) — unified `/solar-rec/jobs` index.
 *
 * One table for all four runners (contract scan, DIN scrape,
 * Schedule B import, CSG Schedule B import — the latter two share a
 * table so they appear as one runnerKind). Polls every 3 seconds
 * while any row is live, otherwise every 30 seconds. Row click
 * navigates to the corresponding manager surface.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RefreshCcw, ArrowRight } from "lucide-react";

type RunnerKind =
  | "contract-scan"
  | "din-scrape"
  | "schedule-b-import"
  | "dashboard-build"
  | "dashboard-csv-export"
  | "dataset-upload";
type JobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "succeeded"
  | "failed"
  | "preparing"
  | "uploading"
  | "parsing"
  | "writing"
  | "done";

const RUNNER_LABEL: Record<RunnerKind, string> = {
  "contract-scan": "Contract Scrape",
  "din-scrape": "DIN Scrape",
  "schedule-b-import": "Schedule B Import",
  "dashboard-build": "Dashboard Rebuild",
  "dashboard-csv-export": "Dashboard CSV Export",
  "dataset-upload": "Dataset Upload",
};

/**
 * Where a row click should land for the 3 batch runners. Schedule B
 * doesn't have a standalone manager page yet — it lives inside the
 * dashboard's Delivery Tracker tab — so we navigate to that tab via
 * the existing `?tab=` query param the dashboard already honors.
 *
 * The 3 newer kinds (dashboard-build / csv-export / dataset-upload)
 * route to a generic detail page at `/solar-rec/jobs/<kind>/<id>`
 * — see `routeForRow` below for the per-row URL construction. They
 * are NOT in this map because they need the per-job id, not a
 * static href.
 */
const RUNNER_HREF: Record<
  "contract-scan" | "din-scrape" | "schedule-b-import",
  string
> = {
  "contract-scan": "/solar-rec/contract-scrape-manager",
  "din-scrape": "/solar-rec/din-scrape-manager",
  "schedule-b-import": "/solar-rec/dashboard?tab=delivery-tracker",
};

/**
 * Compute the navigation target for a row click. Batch-runner rows
 * (contract-scan / din-scrape / schedule-b-import) navigate to
 * their existing manager pages — those already show per-job
 * details and have rich controls (start / stop / view results).
 * Dashboard-build / csv-export / dataset-upload rows route to the
 * generic detail page at `/solar-rec/jobs/<kind>/<id>` since their
 * "managers" (the dashboard + per-card dialogs) only show CURRENT
 * state, not specific historical jobs.
 */
function routeForRow(runnerKind: RunnerKind, id: string): string {
  if (
    runnerKind === "contract-scan" ||
    runnerKind === "din-scrape" ||
    runnerKind === "schedule-b-import"
  ) {
    return RUNNER_HREF[runnerKind];
  }
  return `/solar-rec/jobs/${runnerKind}/${encodeURIComponent(id)}`;
}

function isLive(status: JobStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "stopping" ||
    status === "uploading" ||
    status === "parsing" ||
    status === "preparing" ||
    status === "writing"
  );
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return "—";
  const ms = Date.now() - date.getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function statusVariant(
  status: JobStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
    case "stopping":
    case "uploading":
    case "parsing":
    case "preparing":
    case "writing":
      return "default";
    case "queued":
      return "secondary";
    case "completed":
    case "succeeded":
    case "done":
      return "outline";
    case "failed":
      return "destructive";
    case "stopped":
      return "secondary";
    default:
      return "outline";
  }
}

function progressLabel(
  total: number,
  successCount: number,
  failureCount: number
): string {
  const processed = successCount + failureCount;
  if (total === 0) {
    return processed === 0 ? "—" : `${processed} processed`;
  }
  const pct = Math.min(100, Math.round((processed / total) * 100));
  return `${processed} / ${total} (${pct}%)`;
}

export default function JobsIndex() {
  return (
    <PermissionGate moduleKey="jobs">
      <JobsIndexImpl />
    </PermissionGate>
  );
}

/**
 * Display order for the filter chips. Mirrors the table's read
 * priority — long-batch runners first, then the dashboard-side
 * jobs that are newer additions. The "all" chip is always first.
 */
const RUNNER_KIND_ORDER: RunnerKind[] = [
  "contract-scan",
  "din-scrape",
  "schedule-b-import",
  "dashboard-build",
  "dashboard-csv-export",
  "dataset-upload",
];

type RunnerFilter = RunnerKind | "all";

function JobsIndexImpl() {
  const [, setLocation] = useLocation();

  // 2026-05-10 — filter state. `"all"` (default) shows every kind;
  // selecting a chip narrows the table to one runner kind. Stored
  // in component state — no URL persistence yet because the chips
  // are quick toggles, not deep-linkable views.
  const [filter, setFilter] = useState<RunnerFilter>("all");

  // We set the polling cadence based on the *previous* response —
  // if any row was live last time, poll fast; otherwise slow. React
  // Query re-evaluates `refetchInterval` after every fetch, so a
  // job transitioning to live causes the next interval to drop to
  // 3s on its own. The callback receives the Query (not the data)
  // in TanStack Query v5; pull data off `query.state.data`.
  //
  // NB: the live check ignores the filter — if ANY runner kind is
  // live, we poll fast even when the user has scoped the view. Two
  // reasons: (a) a chip change should never silently slow the poll,
  // and (b) the live-count badge always reflects the unfiltered
  // total so the user knows there's activity off-screen.
  const indexQuery = trpc.jobs.getJobsIndex.useQuery(
    { limitPerRunner: 25 },
    {
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs ?? [];
        const anyLive = jobs.some((j) => isLive(j.status as JobStatus));
        // Live jobs poll fast; idle cadence relaxed to 60s (window
        // focus still refetches) to cut DB request-unit cost.
        return anyLive ? 3000 : 60000;
      },
      // Refetch when window regains focus to keep the table fresh
      // when the user comes back from another tab.
      refetchOnWindowFocus: true,
    }
  );

  const allJobs = indexQuery.data?.jobs ?? [];

  // Per-kind counts feed the chip badges so the user can see "5
  // builds, 2 uploads, 0 exports" at a glance without expanding
  // each filter.
  const countsByKind = useMemo(() => {
    const counts: Record<RunnerKind, number> = {
      "contract-scan": 0,
      "din-scrape": 0,
      "schedule-b-import": 0,
      "dashboard-build": 0,
      "dashboard-csv-export": 0,
      "dataset-upload": 0,
    };
    for (const job of allJobs) {
      const kind = job.runnerKind as RunnerKind;
      if (kind in counts) counts[kind] += 1;
    }
    return counts;
  }, [allJobs]);

  const jobs = useMemo(() => {
    if (filter === "all") return allJobs;
    return allJobs.filter((j) => j.runnerKind === filter);
  }, [allJobs, filter]);

  const liveCount = useMemo(
    () => allJobs.filter((j) => isLive(j.status as JobStatus)).length,
    [allJobs]
  );

  function handleRowClick(runnerKind: RunnerKind, id: string) {
    setLocation(routeForRow(runnerKind, id));
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Live + recent runs across contract scrape, DIN scrape,
            Schedule B import, dashboard rebuilds, CSV exports, and
            dataset uploads. Click a row to open the manager or job
            detail page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {liveCount > 0 && (
            <Badge variant="default" className="text-xs">
              {liveCount} live
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => indexQuery.refetch()}
            disabled={indexQuery.isFetching}
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${
                indexQuery.isFetching ? "animate-spin" : ""
              }`}
            />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="jobs-filter-chips"
      >
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            filter === "all"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-muted-foreground hover:bg-muted"
          }`}
        >
          All
          <span className="ml-1.5 opacity-70">({allJobs.length})</span>
        </button>
        {RUNNER_KIND_ORDER.map((kind) => {
          const count = countsByKind[kind];
          const active = filter === kind;
          // Hide chips for runner kinds with 0 jobs to keep the row
          // tight on a quiet day. The "All" chip always renders so the
          // user can clear the filter even when their currently
          // selected kind has zero rows in this fetch.
          if (count === 0 && !active) return null;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => setFilter(kind)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {RUNNER_LABEL[kind]}
              <span className="ml-1.5 opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {filter === "all" ? "Recent jobs" : RUNNER_LABEL[filter]}
          </CardTitle>
          <CardDescription>
            Up to 25 most recent jobs per runner. Polls every 3 seconds
            while any job is live.
            {filter !== "all" && (
              <>
                {" "}Filtered to <strong>{RUNNER_LABEL[filter]}</strong>;
                use the chips above to switch.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {indexQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : indexQuery.error ? (
            <p className="text-sm text-destructive">
              {indexQuery.error.message}
            </p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter === "all"
                ? "No jobs yet. Start one from the Tools sidebar."
                : `No ${RUNNER_LABEL[filter]} jobs in the recent window. Try the "All" chip to see other runners.`}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Runner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Current</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => {
                    const status = job.status as JobStatus;
                    const runnerKind = job.runnerKind as RunnerKind;
                    const live = isLive(status);
                    return (
                      <TableRow
                        key={`${runnerKind}-${job.id}`}
                        className="cursor-pointer"
                        onClick={() => handleRowClick(runnerKind, job.id)}
                      >
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {RUNNER_LABEL[runnerKind]}
                            {live && job.liveOnThisProcess && (
                              <span
                                title="Runner active on this server instance"
                                className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse"
                              />
                            )}
                          </div>
                          <div
                            className="text-[10px] text-muted-foreground font-mono"
                            title={job.id}
                          >
                            {job.id.slice(0, 8)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={statusVariant(status)}
                            className="text-xs"
                          >
                            {status}
                          </Badge>
                          {job.error && (
                            <div
                              className="text-[10px] text-destructive mt-1 truncate max-w-[200px]"
                              title={job.error}
                            >
                              {job.error}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {progressLabel(
                            job.total,
                            job.successCount,
                            job.failureCount
                          )}
                          {job.failureCount > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              {job.failureCount} failed
                            </div>
                          )}
                        </TableCell>
                        <TableCell
                          className="text-xs font-mono truncate max-w-[180px]"
                          title={job.currentItem ?? ""}
                        >
                          {job.currentItem ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeTime(job.startedAt)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeTime(job.updatedAt)}
                        </TableCell>
                        <TableCell>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground text-right font-mono">
        runner: {indexQuery.data?._runnerVersion ?? "—"}
      </p>
    </div>
  );
}
