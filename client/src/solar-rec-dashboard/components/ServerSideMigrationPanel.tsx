/**
 * Server-side migration panel — the alternative to the browser-based
 * migration for users whose datasets are too large for the tab to
 * hold in memory.
 *
 * Triggers the server to read the 7 core datasets directly from
 * solarRecDashboardStorage, feed them through the typed-row
 * ingestion pipeline, and populate the srDs* tables. The client
 * only polls for status — no CSV rebuilding, no uploads, no OOM.
 *
 * Visible whenever server-side storage is NOT yet enabled (same
 * gate as the existing browser-based migration banner), so the
 * user can choose either path.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CloudUpload,
  Check,
  Loader2,
  X,
  Server,
  AlertTriangle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useServerSideStorage } from "../hooks/useServerSideStorage";

type DatasetStatus =
  | { datasetKey: string; state: "pending" }
  | { datasetKey: string; state: "running"; startedAt: string }
  | {
      datasetKey: string;
      state: "done";
      batchId: string;
      rowCount: number;
      durationMs: number;
    }
  | { datasetKey: string; state: "skipped"; reason: string }
  | { datasetKey: string; state: "failed"; error: string };

type JobState = {
  jobId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  completedAt: string | null;
  datasets: DatasetStatus[];
};

const POLL_INTERVAL_MS = 2500;

export default memo(function ServerSideMigrationPanel() {
  const { needsMigration, enabled, toggle } = useServerSideStorage();
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const trpcUtils = trpc.useUtils();

  // On mount, check if there's already an active job for this scope
  // (e.g. user started a migration then reloaded the tab).
  useEffect(() => {
    let cancelled = false;
    trpcUtils.solarRecDashboard.getActiveServerSideMigration
      .fetch()
      .then((active) => {
        if (cancelled || !active) return;
        setJobId(active.jobId);
        setJob(active as JobState);
      })
      .catch(() => {
        // Silent — nothing to resume.
      });
    return () => {
      cancelled = true;
    };
  }, [trpcUtils]);

  // Poll job status while a job is running.
  useEffect(() => {
    if (!jobId) return;
    if (job?.status === "done" || job?.status === "failed") return;

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await trpcUtils.solarRecDashboard.getServerSideMigrationStatus.fetch(
          { jobId }
        );
        if (cancelled || !next) return;
        setJob(next as JobState);
      } catch {
        // Ignore transient errors; next poll will retry.
      }
    };

    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [jobId, job?.status, trpcUtils]);

  // When a job finishes successfully with at least one non-skipped
  // dataset, flip the feature flag.
  useEffect(() => {
    if (!job || job.status !== "done") return;
    const atLeastOneDone = job.datasets.some((d) => d.state === "done");
    if (atLeastOneDone && !enabled) {
      toggle(true);
    }
  }, [job, enabled, toggle]);

  const onStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const result = await trpcUtils.client.solarRecDashboard.startServerSideMigration.mutate();
      setJobId(result.jobId);
      setJob({
        jobId: result.jobId,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        datasets: [],
      });
    } catch (err) {
      setStartError(
        err instanceof Error ? err.message : "Could not start migration"
      );
    } finally {
      setStarting(false);
    }
  }, [trpcUtils]);

  const summary = useMemo(() => {
    if (!job) return null;
    const done = job.datasets.filter((d) => d.state === "done").length;
    const failed = job.datasets.filter((d) => d.state === "failed").length;
    const skipped = job.datasets.filter((d) => d.state === "skipped").length;
    const running = job.datasets.find((d) => d.state === "running");
    const total = job.datasets.length;
    const totalRows = job.datasets.reduce(
      (sum, d) => (d.state === "done" ? sum + d.rowCount : sum),
      0
    );
    return { done, failed, skipped, running, total, totalRows };
  }, [job]);

  // Show the panel only while a migration is pending or in-flight,
  // or just finished. Once enabled + no active job, hide it
  // (the existing flow takes over with the parity panel).
  if (dismissed) return null;
  if (enabled && !job) return null;
  if (!needsMigration && !job) return null;

  const isRunning = job?.status === "running";
  const isDone = job?.status === "done";
  const isFailed = job?.status === "failed";

  return (
    <div className="mx-4 mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-indigo-900">
          <Server className="h-4 w-4 shrink-0" />
          <div>
            {isDone && summary && summary.failed === 0 ? (
              <span className="font-medium text-emerald-800">
                <Check className="mr-1 inline h-4 w-4" />
                Server-side migration complete — {summary.done} datasets,{" "}
                {summary.totalRows.toLocaleString()} rows.
              </span>
            ) : isDone && summary && summary.failed > 0 ? (
              <span className="font-medium text-amber-800">
                <AlertTriangle className="mr-1 inline h-4 w-4" />
                Server migration finished with {summary.failed} failure(s). See
                details below.
              </span>
            ) : isFailed ? (
              <span className="font-medium text-red-800">
                <X className="mr-1 inline h-4 w-4" />
                Server migration failed — see details below.
              </span>
            ) : isRunning && summary ? (
              <span>
                <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                Server migration running — {summary.done}/{summary.total}{" "}
                datasets complete
                {summary.running ? ` (currently: ${summary.running.datasetKey})` : ""}
              </span>
            ) : starting ? (
              <span>
                <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                Starting server migration...
              </span>
            ) : startError ? (
              <span className="font-medium text-red-800">
                {startError}
              </span>
            ) : (
              <span>
                <strong>Server-side migration available.</strong> Copy datasets
                directly on the server — no tab memory load.
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isRunning && !isDone && (
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs"
              onClick={onStart}
              disabled={starting}
            >
              <CloudUpload className="h-3.5 w-3.5" />
              {startError ? "Retry on Server" : "Migrate on Server"}
            </Button>
          )}
          {!isRunning && (
            <button
              onClick={() => setDismissed(true)}
              className="text-indigo-400 hover:text-indigo-700"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {job && job.datasets.length > 0 && (
        <div className="mt-3 border-t border-indigo-200 pt-2 text-xs text-indigo-900 space-y-1">
          {job.datasets.map((d) => (
            <div key={d.datasetKey} className="flex items-center gap-2">
              <span className="font-mono w-48 shrink-0">{d.datasetKey}</span>
              {d.state === "pending" && (
                <span className="text-slate-500">pending</span>
              )}
              {d.state === "running" && (
                <span className="text-indigo-700">
                  <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                  running...
                </span>
              )}
              {d.state === "done" && (
                <span className="text-emerald-700">
                  <Check className="mr-1 inline h-3 w-3" />
                  {d.rowCount.toLocaleString()} rows in{" "}
                  {(d.durationMs / 1000).toFixed(1)}s
                </span>
              )}
              {d.state === "skipped" && (
                <span className="text-slate-500">skipped — {d.reason}</span>
              )}
              {d.state === "failed" && (
                <span className="text-red-700">
                  <X className="mr-1 inline h-3 w-3" />
                  {d.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
