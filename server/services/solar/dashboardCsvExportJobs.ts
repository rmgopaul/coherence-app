/**
 * Dashboard CSV export job registry — TRANSITIONAL.
 *
 * Replaces the synchronous tRPC procs `exportOwnershipTileCsv` and
 * `exportChangeOwnershipTileCsv` (both formerly on
 * DASHBOARD_OVERSIZE_ALLOWLIST). Those procs returned MB-scale CSV
 * strings inline through tRPC, which violated the dashboard response
 * budget and held the whole CSV in browser heap during the response.
 *
 * New flow:
 *   1. Client calls `startDashboardCsvExport` (mutation), gets a
 *      `{ jobId }`.
 *   2. Worker (run on the same process via `setImmediate`) loads the
 *      heavy aggregator artifact, builds the CSV, writes it to
 *      storage via `storagePut`, and resolves the URL via
 *      `storageGet`.
 *   3. Client polls `getDashboardCsvExportJobStatus(jobId)` until the
 *      status is `succeeded` (with `url` + `fileName` + `rowCount`)
 *      or `failed` (with `error`).
 *   4. Client navigates an `<a download>` to the URL.
 *
 * V1 transitional constraints — explicitly NOT the target architecture:
 *   - Single-process in-memory `Map`. A multi-instance deploy would
 *     route a poll to a different process than the worker that
 *     started the job and 404 the lookup. Acceptable for this PR
 *     because the repo runs single-instance today; the next step is
 *     either a `dashboardCsvExportJobs` DB table mirroring the
 *     `datasetUploadJobs` shape, or migrating to background-job
 *     infrastructure (e.g. SQS / a dedicated worker).
 *   - The worker still builds the CSV string in memory (via
 *     `buildOwnershipTileCsv` / `buildChangeOwnershipTileCsv`). True
 *     row-streaming directly to storage is the next hardening step;
 *     this PR moves the MB-scale work OFF the tRPC response path,
 *     which restores the response budget for these two endpoints.
 *   - TTL pruning runs opportunistically on each `getStatus` poll.
 *     A long-idle process accumulates terminal records up to TTL,
 *     bounded by `JOB_TTL_MS`.
 *   - Job IDs are 16 random bytes hex-encoded. Cross-scope safety is
 *     enforced on the status read by comparing the stored
 *     `record.scopeId` to the caller's `ctx.scopeId`.
 */

import { randomBytes } from "node:crypto";
import { storageGet, storagePut } from "../../storage";
import {
  buildChangeOwnershipTileCsv,
  buildOwnershipTileCsv,
  type OwnershipTileKey,
} from "./buildDashboardCsvExport";
import type { ChangeOwnershipStatus } from "./buildChangeOwnershipAggregates";

export const DASHBOARD_CSV_EXPORT_RUNNER_VERSION =
  "dashboard-csv-export-jobs-v1";

const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type DashboardCsvExportInput =
  | { exportType: "ownershipTile"; tile: OwnershipTileKey }
  | { exportType: "changeOwnershipTile"; status: ChangeOwnershipStatus };

export type DashboardCsvExportStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface DashboardCsvExportStatusSnapshot {
  jobId: string;
  status: DashboardCsvExportStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  fileName: string | null;
  url: string | null;
  rowCount: number | null;
  error: string | null;
}

interface JobRecord {
  jobId: string;
  scopeId: string;
  input: DashboardCsvExportInput;
  status: DashboardCsvExportStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  fileName: string | null;
  url: string | null;
  rowCount: number | null;
  error: string | null;
}

const jobs = new Map<string, JobRecord>();

function pruneExpired(now: number = Date.now()): void {
  // Snapshot entries via Array.from to avoid mutating the Map during
  // iteration. Project tsconfig has no explicit `target`, so direct
  // for-of over a Map needs `--downlevelIteration` — Array.from is
  // the cross-target-safe equivalent the rest of the codebase uses.
  const entries = Array.from(jobs.entries());
  for (const [jobId, record] of entries) {
    if (record.completedAt && now - record.completedAt > JOB_TTL_MS) {
      jobs.delete(jobId);
      continue;
    }
    // Defensive: a record that never reached a terminal state but is
    // older than TTL is also pruned. In practice the runner always
    // sets `completedAt`, but a thrown-during-spawn scenario could
    // leave the record in `queued` forever otherwise.
    if (!record.completedAt && now - record.createdAt > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

function snapshot(record: JobRecord): DashboardCsvExportStatusSnapshot {
  return {
    jobId: record.jobId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    fileName: record.fileName,
    url: record.url,
    rowCount: record.rowCount,
    error: record.error,
  };
}

function newJobId(): string {
  return randomBytes(16).toString("hex");
}

function fileNameForInput(input: DashboardCsvExportInput): string {
  if (input.exportType === "ownershipTile") {
    return `ownership-tile-${input.tile}`;
  }
  return `change-ownership-${input.status}`;
}

/**
 * Enqueue an export job. Returns synchronously with the job ID. The
 * actual work runs on `setImmediate` so the mutation response does
 * not block on aggregator load + CSV build.
 *
 * The default `runner` is the production `runCsvExportJob` below;
 * tests can pass a deterministic stub instead.
 */
export function startCsvExportJob(
  scopeId: string,
  input: DashboardCsvExportInput,
  runner: (jobId: string) => Promise<void> = runCsvExportJob,
  scheduler: (cb: () => void) => void = (cb) => setImmediate(cb)
): { jobId: string } {
  const jobId = newJobId();
  const record: JobRecord = {
    jobId,
    scopeId,
    input,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    fileName: null,
    url: null,
    rowCount: null,
    error: null,
  };
  jobs.set(jobId, record);
  scheduler(() => {
    runner(jobId).catch((err) => {
      // The runner already captures errors into the record. A throw
      // surfacing here means the runner itself is broken; log it but
      // also try to mark the job failed so the client poll resolves.
      console.error(
        `[dashboard:csv-export-jobs] runner threw for jobId=${jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      const stuck = jobs.get(jobId);
      if (stuck && stuck.status !== "succeeded" && stuck.status !== "failed") {
        stuck.status = "failed";
        stuck.error =
          err instanceof Error ? err.message : "Runner threw unexpectedly.";
        stuck.completedAt = Date.now();
      }
    });
  });
  return { jobId };
}

/**
 * Read job status for a given scope. Returns `null` if the jobId
 * is unknown OR if the job was started for a different scope —
 * scope-mismatch is reported as "not found" rather than a permission
 * error to avoid leaking the existence of cross-scope jobIds.
 *
 * Calls `pruneExpired` on every read so the registry's footprint is
 * bounded by `JOB_TTL_MS` even on long-idle processes.
 */
export function getCsvExportJobStatus(
  scopeId: string,
  jobId: string
): DashboardCsvExportStatusSnapshot | null {
  pruneExpired();
  const record = jobs.get(jobId);
  if (!record) return null;
  if (record.scopeId !== scopeId) return null;
  return snapshot(record);
}

/**
 * Worker entry point. Loads the heavy aggregator artifact for the
 * job's scope, builds the CSV, writes it to storage, and updates the
 * job record. Errors are captured into the record's `error` field;
 * this function does not throw under any expected control flow.
 */
export async function runCsvExportJob(jobId: string): Promise<void> {
  const record = jobs.get(jobId);
  if (!record) {
    // Another caller (or a TTL prune) removed the record before the
    // runner started. Nothing to do.
    return;
  }
  record.status = "running";
  record.startedAt = Date.now();
  try {
    const built = await buildExport(record.input, record.scopeId);
    if (built.rowCount === 0) {
      // No rows match — skip the storage write entirely. The client
      // surfaces this case with a "no rows match" toast and does not
      // attempt a download.
      record.status = "succeeded";
      record.fileName = built.fileName;
      record.rowCount = 0;
      record.url = null;
      record.completedAt = Date.now();
      return;
    }
    const key = `solar-rec-dashboard/${record.scopeId}/exports/${jobId}-${built.fileName}`;
    await storagePut(key, built.csv, "text/csv; charset=utf-8");
    const { url } = await storageGet(key);
    record.status = "succeeded";
    record.fileName = built.fileName;
    record.rowCount = built.rowCount;
    record.url = url;
    record.completedAt = Date.now();
  } catch (err) {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    record.completedAt = Date.now();
    console.error(
      `[dashboard:csv-export-jobs] failed jobId=${jobId} (${fileNameForInput(record.input)}): ${record.error}`
    );
  }
}

interface BuiltCsvArtifact {
  csv: string;
  fileName: string;
  rowCount: number;
}

async function buildExport(
  input: DashboardCsvExportInput,
  scopeId: string
): Promise<BuiltCsvArtifact> {
  if (input.exportType === "ownershipTile") {
    const { getOrBuildOverviewSummary } = await import(
      "./buildOverviewSummaryAggregates"
    );
    const { result } = await getOrBuildOverviewSummary(scopeId);
    return buildOwnershipTileCsv(result.ownershipRows, input.tile);
  }
  const { getOrBuildChangeOwnership } = await import(
    "./buildChangeOwnershipAggregates"
  );
  const { result } = await getOrBuildChangeOwnership(scopeId);
  return buildChangeOwnershipTileCsv(result.rows, input.status);
}

/**
 * Test-only surface — exposed so unit tests can drive the registry
 * deterministically (clear, peek at internals, drive the runner with
 * a stubbed builder). Never imported by production code.
 */
export const __TEST_ONLY__ = {
  reset: (): void => {
    jobs.clear();
  },
  size: (): number => jobs.size,
  pruneExpired,
  fileNameForInput,
  JOB_TTL_MS,
};
