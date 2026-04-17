/**
 * In-process registry for background core-dataset sync jobs.
 *
 * The previous sync contract ran the entire ingest inside the tRPC
 * request-response cycle, which meant Render's ~100s proxy timeout
 * would 502 the client for large (multi-million-row) uploads — even
 * though the ingest itself kept running server-side and committing
 * rows. That's exactly the failure mode that left 19 orphaned
 * `processing` batches in production on 2026-04-17.
 *
 * This module moves the ingest to a fire-and-forget background
 * task. The tRPC mutation returns a `jobId` immediately; the client
 * polls a status endpoint for progress until the job reaches a
 * terminal state. No single HTTP request ever spans the long
 * ingest, so there is no proxy timeout to hit.
 *
 * The registry lives in the Node process's memory. When the
 * process restarts (deploy, OOM, dyno recycle), the job state is
 * lost, but:
 *   - The underlying `solarRecImportBatches` row stays in
 *     `processing` status until the startup hook sweeps it (see
 *     clearOrphanedImportBatchesOnStartup).
 *   - The client's active-jobs endpoint returns an empty list
 *     after a restart, so polling timers naturally stop.
 *   - The user can re-trigger the sync; dedupe-append skips rows
 *     already persisted by the killed job.
 *
 * Multi-dyno scale would need a DB-backed job table (similar to
 * solarRecComputeRuns). Acceptable for the current single-dyno
 * Render setup.
 */

import { nanoid } from "nanoid";
import type { DatasetMigrationStatus } from "./serverSideMigration";

export type CoreDatasetSyncJobState =
  | {
      jobId: string;
      datasetKey: string;
      scopeId: string;
      state: "pending";
      startedAt: string;
      updatedAt: string;
      error: null;
    }
  | {
      jobId: string;
      datasetKey: string;
      scopeId: string;
      state: "running";
      startedAt: string;
      updatedAt: string;
      error: null;
    }
  | {
      jobId: string;
      datasetKey: string;
      scopeId: string;
      state: "done";
      startedAt: string;
      updatedAt: string;
      completedAt: string;
      result: DatasetMigrationStatus;
      error: null;
    }
  | {
      jobId: string;
      datasetKey: string;
      scopeId: string;
      state: "failed";
      startedAt: string;
      updatedAt: string;
      completedAt: string;
      result: DatasetMigrationStatus | null;
      error: string;
    };

/**
 * All known jobs, keyed by jobId. Entries live at most
 * JOB_TTL_MS after completion so the map doesn't grow unbounded;
 * active jobs stay forever.
 */
const jobs = new Map<string, CoreDatasetSyncJobState>();

/**
 * Secondary index so we can find the currently-active job for a
 * (scope, dataset) pair without scanning the full map. Used by
 * the single-flight logic and the "resume polling on tab reload"
 * path.
 */
const activeJobByFlightKey = new Map<string, string>();

const JOB_TTL_MS = 30 * 60 * 1000; // keep terminal job state 30 min for late pollers

function flightKey(scopeId: string, datasetKey: string): string {
  return `${scopeId}:${datasetKey}`;
}

function pruneTerminalJobs(now: number = Date.now()): void {
  const entries = Array.from(jobs.entries());
  for (const [jobId, job] of entries) {
    if (job.state !== "done" && job.state !== "failed") continue;
    const completedAtMs = new Date(job.completedAt).getTime();
    if (now - completedAtMs > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

export function getSyncJob(jobId: string): CoreDatasetSyncJobState | null {
  pruneTerminalJobs();
  return jobs.get(jobId) ?? null;
}

export function getActiveJobFor(
  scopeId: string,
  datasetKey: string
): CoreDatasetSyncJobState | null {
  const jobId = activeJobByFlightKey.get(flightKey(scopeId, datasetKey));
  if (!jobId) return null;
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.state === "done" || job.state === "failed") return null;
  return job;
}

export type ListActiveJobsInput = { scopeId: string };

export function listActiveJobsForScope(
  scopeId: string
): CoreDatasetSyncJobState[] {
  pruneTerminalJobs();
  const results: CoreDatasetSyncJobState[] = [];
  const activeIds = Array.from(activeJobByFlightKey.values());
  for (const jobId of activeIds) {
    const job = jobs.get(jobId);
    if (!job) continue;
    if (job.scopeId !== scopeId) continue;
    if (job.state === "done" || job.state === "failed") continue;
    results.push(job);
  }
  return results;
}

/**
 * Start a new background sync job or return the already-running
 * one for the same (scope, datasetKey). Returns the jobId
 * synchronously; the heavy work happens on the event loop.
 *
 * Single-flight guarantee: if a job for (scope, datasetKey) is
 * already in `pending` or `running` state, this returns that
 * job's id without launching another. The caller can treat "same
 * jobId returned twice" as idempotent from the user's perspective.
 */
export function startSyncJob(
  scopeId: string,
  datasetKey: string,
  runIngest: () => Promise<DatasetMigrationStatus>
): string {
  const key = flightKey(scopeId, datasetKey);
  const existingId = activeJobByFlightKey.get(key);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (
      existing &&
      (existing.state === "pending" || existing.state === "running")
    ) {
      return existingId;
    }
  }

  const jobId = nanoid();
  const now = new Date().toISOString();
  const initial: CoreDatasetSyncJobState = {
    jobId,
    scopeId,
    datasetKey,
    state: "pending",
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  jobs.set(jobId, initial);
  activeJobByFlightKey.set(key, jobId);

  // Fire and forget. Kick to the next tick so the caller's
  // response goes out first.
  queueMicrotask(() => {
    void runJobInBackground(jobId, key, runIngest);
  });

  return jobId;
}

async function runJobInBackground(
  jobId: string,
  key: string,
  runIngest: () => Promise<DatasetMigrationStatus>
): Promise<void> {
  const initial = jobs.get(jobId);
  if (!initial) return;

  // Transition pending → running. Rebuild explicitly rather than
  // spreading so TS narrows the discriminated union cleanly.
  const baseIdentity = {
    jobId: initial.jobId,
    scopeId: initial.scopeId,
    datasetKey: initial.datasetKey,
    startedAt: initial.startedAt,
  };

  jobs.set(jobId, {
    ...baseIdentity,
    state: "running",
    updatedAt: new Date().toISOString(),
    error: null,
  });

  try {
    const result = await runIngest();
    const completedAt = new Date().toISOString();
    if (result.state === "failed") {
      jobs.set(jobId, {
        ...baseIdentity,
        state: "failed",
        updatedAt: completedAt,
        completedAt,
        result,
        error:
          result.error ??
          "ingest returned failed state without a message",
      });
    } else {
      jobs.set(jobId, {
        ...baseIdentity,
        state: "done",
        updatedAt: completedAt,
        completedAt,
        result,
        error: null,
      });
    }
  } catch (err) {
    const completedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `[coreDatasetSyncJobs] job ${jobId} (${key}) threw:`,
      message
    );
    jobs.set(jobId, {
      ...baseIdentity,
      state: "failed",
      updatedAt: completedAt,
      completedAt,
      result: null,
      error: message,
    });
  } finally {
    if (activeJobByFlightKey.get(key) === jobId) {
      activeJobByFlightKey.delete(key);
    }
  }
}
