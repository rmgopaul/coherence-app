/**
 * Stale-job sweeper for the v2 dataset upload pipeline.
 *
 * Background — when a dataset-upload job runner crashes mid-flight
 * (server OOM, container restart, deploy cutover), its
 * `datasetUploadJobs` row stays in a non-terminal status (`queued`,
 * `uploading`, `parsing`, `preparing`, or `writing`) forever. The dashboard's
 * cloud-sync indicator polls `listDatasetUploadJobs`, sees the
 * stuck row, and reports "Syncing N datasets…" indefinitely.
 *
 * This module runs a sweep at server boot + on a recurring timer
 * to auto-fail stuck rows. The DB-level UPDATE is in
 * `server/db/datasetUploadJobs.ts :: sweepStaleDatasetUploadJobs`.
 *
 * The boot sweep handles the deploy case (a fresh process inheriting
 * stuck rows from the previous instance). The timer handles the
 * runtime-crash case (a runner crash without a deploy / restart).
 *
 * Configuration via env vars (all optional):
 *   DATASET_UPLOAD_STALE_AFTER_MS    Threshold for "stuck since last update" jobs.
 *                                    Default: 10 minutes.
 *   DATASET_UPLOAD_SWEEP_INTERVAL_MS How often to sweep after boot.
 *                                    Default: 5 minutes.
 *                                    Set to 0 to disable the timer
 *                                    (boot sweep still runs).
 */
import {
  pruneOldTerminalDatasetUploadJobs,
  sweepStaleDatasetUploadJobs,
} from "../../db/datasetUploadJobs";
import { schedulerTickAllowed } from "../../_core/runtimeTarget";

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// 2026-05-08 (Phase 7 fragment) — TTL retention for terminal-status
// upload jobs. Default 7 days: long enough for a user to find a
// recent failed upload by scrolling the history list, short enough
// to keep the table from accumulating multi-thousand rows.
// Tunable via `DATASET_UPLOAD_TERMINAL_RETENTION_MS`.
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function runSweep(
  staleAfterMs: number,
  terminalRetentionMs: number
): Promise<void> {
  // Concern #4 PR-3 in-tick safety net — see monitoringScheduler.ts
  // for rationale. The sweeper is the chattiest of the three
  // (every 5 min by default), so the once-per-process log inside
  // `schedulerTickAllowed` is especially important here to avoid
  // 288 log lines/day if the gate is hit.
  if (!schedulerTickAllowed("dataset-upload-stale-sweeper")) return;
  // Re-entrancy guard: if a previous sweep is still in flight when
  // the timer fires (e.g. DB is slow), skip the new tick rather
  // than stack mutations.
  if (sweeping) return;
  sweeping = true;
  try {
    const swept = await sweepStaleDatasetUploadJobs(staleAfterMs);
    if (swept > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[datasetUploadStaleJobSweeper] auto-failed ${swept} stale upload ` +
          `job${swept === 1 ? "" : "s"} (older than ${Math.round(
            staleAfterMs / 1000
          )}s).`
      );
    }

    // 2026-05-08 (Phase 7 fragment) — TTL prune terminal rows older
    // than `terminalRetentionMs`. Runs on every sweep tick; bounded
    // by the per-row delete (children first), best-effort on
    // failures. Idempotent: a row that already raced to deletion
    // returns 0 from `deleteDatasetUploadJob` and isn't counted.
    let pruned = 0;
    try {
      pruned = await pruneOldTerminalDatasetUploadJobs(terminalRetentionMs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[datasetUploadStaleJobSweeper] terminal-prune failed:",
        err instanceof Error ? err.message : err
      );
    }
    if (pruned > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[datasetUploadStaleJobSweeper] pruned ${pruned} terminal upload ` +
          `job${pruned === 1 ? "" : "s"} (older than ${Math.round(
            terminalRetentionMs / 1000
          )}s).`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[datasetUploadStaleJobSweeper] sweep failed:",
      err instanceof Error ? err.message : err
    );
  } finally {
    sweeping = false;
  }
}

/**
 * Start the sweeper. Runs an immediate boot sweep and (if the
 * timer interval is non-zero) schedules recurring sweeps. Safe to
 * call multiple times; subsequent calls reset the timer.
 *
 * Returns a function that stops the timer (idempotent). The
 * Express server doesn't currently install a shutdown hook, but
 * exposing the stopper keeps things clean for future use + tests.
 */
export function startDatasetUploadStaleJobSweeper(): () => void {
  const staleAfterMs = readEnvNumber(
    "DATASET_UPLOAD_STALE_AFTER_MS",
    DEFAULT_STALE_AFTER_MS
  );
  const intervalMs = readEnvNumber(
    "DATASET_UPLOAD_SWEEP_INTERVAL_MS",
    DEFAULT_SWEEP_INTERVAL_MS
  );
  // 2026-05-08 (Phase 7 fragment) — terminal-row TTL retention.
  // Default 7 days; tunable via the env var of the same name.
  const terminalRetentionMs = readEnvNumber(
    "DATASET_UPLOAD_TERMINAL_RETENTION_MS",
    DEFAULT_TERMINAL_RETENTION_MS
  );

  // Boot sweep — fire-and-forget; don't block server start.
  void runSweep(staleAfterMs, terminalRetentionMs);

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void runSweep(staleAfterMs, terminalRetentionMs);
    }, intervalMs);
    // Don't keep the Node process alive just for this timer.
    if (typeof timer.unref === "function") timer.unref();
  }

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
