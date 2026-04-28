/**
 * Task 8.2 (2026-04-27) — unified `/solar-rec/jobs` index.
 *
 * One table for all four runners (contract scan, DIN scrape,
 * Schedule B import, CSG Schedule B import — the latter two share a
 * table so they appear as one runnerKind). Polls every 3 seconds
 * while any row is live, otherwise every 30 seconds. Row click
 * navigates to the corresponding manager surface.
 */
import { useMemo } from "react";
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

type RunnerKind = "contract-scan" | "din-scrape" | "schedule-b-import";
type JobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

const RUNNER_LABEL: Record<RunnerKind, string> = {
  "contract-scan": "Contract Scrape",
  "din-scrape": "DIN Scrape",
  "schedule-b-import": "Schedule B Import",
};

/**
 * Where a row click should land. Schedule B doesn't have a standalone
 * manager page yet — it lives inside the dashboard's Delivery Tracker
 * tab — so we navigate to that tab via the existing `?tab=` query
 * param the dashboard already honors.
 */
const RUNNER_HREF: Record<RunnerKind, string> = {
  "contract-scan": "/solar-rec/contract-scrape-manager",
  "din-scrape": "/solar-rec/din-scrape-manager",
  "schedule-b-import": "/solar-rec/dashboard?tab=delivery-tracker",
};

function isLive(status: JobStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
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
      return "default";
    case "queued":
      return "secondary";
    case "completed":
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

function JobsIndexImpl() {
  const [, setLocation] = useLocation();

  // We set the polling cadence based on the *previous* response —
  // if any row was live last time, poll fast; otherwise slow. React
  // Query re-evaluates `refetchInterval` after every fetch, so a
  // job transitioning to live causes the next interval to drop to
  // 3s on its own. The callback receives the Query (not the data)
  // in TanStack Query v5; pull data off `query.state.data`.
  const indexQuery = trpc.jobs.getJobsIndex.useQuery(
    { limitPerRunner: 25 },
    {
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs ?? [];
        const anyLive = jobs.some((j) => isLive(j.status as JobStatus));
        return anyLive ? 3000 : 30000;
      },
      // Refetch when window regains focus to keep the table fresh
      // when the user comes back from another tab.
      refetchOnWindowFocus: true,
    }
  );

  const jobs = indexQuery.data?.jobs ?? [];

  const liveCount = useMemo(
    () => jobs.filter((j) => isLive(j.status as JobStatus)).length,
    [jobs]
  );

  function handleRowClick(runnerKind: RunnerKind) {
    setLocation(RUNNER_HREF[runnerKind]);
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Live + recent runs across contract scrape, DIN scrape, and
            Schedule B import. Click a row to open the manager.
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent jobs</CardTitle>
          <CardDescription>
            Up to 25 most recent jobs per runner. Polls every 3 seconds
            while any job is live.
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
              No jobs yet. Start one from the Tools sidebar.
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
                        onClick={() => handleRowClick(runnerKind)}
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
