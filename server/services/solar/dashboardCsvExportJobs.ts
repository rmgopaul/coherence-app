/**
 * Dashboard CSV export job registry — Phase 6 PR-B (DB-backed).
 *
 * Replaces the in-memory `Map` registry shipped in PR #346. The
 * `dashboardCsvExportJobs` table (Phase 6 PR-A, migration 0058)
 * provides durable single-source-of-truth state across process
 * restarts AND across multi-instance deployments. PR #352's
 * `notFound is retryable` workaround is reverted: DB-backed
 * `notFound` genuinely means the row was pruned (TTL elapsed) or
 * never existed.
 *
 * Flow:
 *   1. Client calls `startDashboardCsvExport` (mutation), gets a
 *      `{ jobId }`.
 *   2. Service inserts a `queued` row, then schedules
 *      `runCsvExportJob(jobId)` via `setImmediate`.
 *   3. Worker atomically claims the row (`queued → running` with
 *      `claimedBy` + `claimedAt` set in the same UPDATE), loads
 *      the heavy aggregator artifact, builds the CSV, writes it
 *      to storage, and atomically completes the row
 *      (`running → succeeded` WHERE `claimedBy` still equals
 *      ours).
 *   4. Client polls `getDashboardCsvExportJobStatus(jobId)`. The
 *      proc reads the row's status. Cross-scope reads return
 *      `null` (caller sees `notFound` without leaking existence).
 *   5. A periodic sweep (also fired opportunistically on each
 *      status read) prunes terminal rows older than
 *      `JOB_TTL_MS` and best-effort `storageDelete`s their
 *      artifact URLs. Stale `running` rows (worker died
 *      mid-flight, claim is older than `STALE_CLAIM_MS`) get
 *      flipped to `failed` so the client poll resolves.
 *
 * Cross-process safety:
 *   - `claimedBy` is `pid-${pid}-host-${hostname}-${suffix}`,
 *     unique per claim attempt. Suffix is a 4-byte random hex so
 *     every retry writes to its own artifact key and a stale
 *     attempt can't clean up a later successful retry's file.
 *   - Every UPDATE that mutates a `running` row's terminal
 *     fields predicates on `claimedBy = ourClaimId AND status
 *     = 'running'`. A worker that lost its claim (e.g. its
 *     process restarted, sweeper marked it stale) cannot
 *     overwrite the new claim's state.
 */

import { hostname as osHostname } from "node:os";
import { randomBytes } from "node:crypto";
import {
  storageDelete,
  storageGet,
  storagePut,
  storagePutFile,
} from "../../storage";
import {
  buildChangeOwnershipTileCsvFile,
  buildOwnershipTileCsvFile,
  type OwnershipTileKey,
} from "./buildDashboardCsvExport";
import {
  getOrBuildChangeOwnership,
  type ChangeOwnershipStatus,
} from "./buildChangeOwnershipAggregates";
import {
  buildDatasetCsvExport,
  isDashboardDatasetCsvExportKey,
  type DashboardDatasetCsvExportKey,
} from "./dashboardDatasetCsvExport";
import { getOrBuildOverviewSummary } from "./buildOverviewSummaryAggregates";
import { startDashboardJobMetric } from "./dashboardJobMetrics";
import {
  claimDashboardCsvExportJob,
  completeDashboardCsvExportJobFailure,
  completeDashboardCsvExportJobSuccess,
  failStaleDashboardCsvExportJobs,
  getDashboardCsvExportJob,
  insertDashboardCsvExportJob,
  pruneTerminalDashboardCsvExportJobs,
  refreshDashboardCsvExportJobClaim,
} from "../../db/dashboardCsvExportJobs";
import type { DashboardCsvExportJob } from "../../../drizzle/schema";

const METRIC_PREFIX = "[dashboard:csv-export-jobs]";

export const DASHBOARD_CSV_EXPORT_RUNNER_VERSION =
  "dashboard-csv-export-jobs-v7-file-backed-tile-csv";
const LEGACY_DETERMINISTIC_ARTIFACT_RUNNER_VERSION =
  "dashboard-csv-export-jobs-v3-heartbeat";

/**
 * TTL for terminal rows. After `completedAt + JOB_TTL_MS`, the
 * row is eligible for prune (which also fires `storageDelete` on
 * the artifact URL).
 */
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Stale-claim threshold. A `running` row whose `claimedAt` is
 * older than this is considered abandoned (worker process
 * died / restarted between claim and completion). The next
 * sweep reclassifies it as `failed`. Set generously so a slow
 * but healthy aggregator run never appears stale: cold-cache
 * builds can take 30s+; we give 5 min headroom — but legitimate
 * long-running exports refresh `claimedAt` via heartbeat
 * (`HEARTBEAT_INTERVAL_MS`) so they never cross this threshold
 * while alive.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Heartbeat interval. Codex P1 follow-up (2026-05-04): a healthy
 * long-running worker MUST refresh `claimedAt` faster than
 * `STALE_CLAIM_MS` or the sweeper will flip it to `failed`. 30s
 * gives 10× the safety margin and keeps DB write pressure
 * trivial (one tiny UPDATE per 30s per active export — typically
 * one or two at a time).
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Process-local runner queue. The DB claim is still the source of
 * truth for cross-process ownership, but this queue prevents one
 * process from scheduling unbounded duplicate runner attempts for
 * the same queued row when several status polls arrive before the
 * first setImmediate fires.
 */
const DEFAULT_MAX_LOCAL_RUNNERS = 2;
let maxLocalRunners = DEFAULT_MAX_LOCAL_RUNNERS;
const EXPORT_RUNNER_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes
const TERMINAL_UPDATE_TIMEOUT_MS = 10 * 1000; // 10 seconds

interface PendingRunnerJob {
  jobId: string;
  runner: (jobId: string) => Promise<void>;
}

const pendingRunnerJobs: PendingRunnerJob[] = [];
const pendingRunnerJobIdSet = new Set<string>();
const activeRunnerJobIds = new Set<string>();
let runnerDrainScheduled = false;

class DashboardCsvExportTimeoutError extends Error {
  constructor(jobId: string) {
    super(
      `dashboard CSV export job ${jobId} exceeded hard runtime limit ` +
        `(${EXPORT_RUNNER_TIMEOUT_MS}ms)`
    );
    this.name = "DashboardCsvExportTimeoutError";
  }
}

export type DashboardCsvExportInput =
  | { exportType: "ownershipTile"; tile: OwnershipTileKey }
  | { exportType: "changeOwnershipTile"; status: ChangeOwnershipStatus }
  | { exportType: "datasetCsv"; datasetKey: DashboardDatasetCsvExportKey };

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

// ─────────────────────────────────────────────────────────────────────
// Process identity for cross-process claim safety
// ─────────────────────────────────────────────────────────────────────

function getClaimId(): string {
  const pid = typeof process.pid === "number" ? process.pid : 0;
  const host = (() => {
    try {
      return osHostname();
    } catch {
      return "unknown";
    }
  })();
  const suffix = randomBytes(4).toString("hex");
  return `pid-${pid}-host-${host}-${suffix}`;
}

function newJobId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Reconstruct the storage key the runner used. Mirrored on read
 * so the prune sweep can call `storageDelete` without having
 * persisted the storage key on the row (we only persist the URL,
 * which can be a Forge proxy URL or a local-mode `/_local_uploads/...`
 * path — neither of which is the storage key directly).
 *
 * v4+ keys intentionally do NOT include `fileName`: if a worker
 * crashes after storagePut but before success completion, the
 * terminal failed row may still have `fileName = null`. The key
 * must remain derivable from durable row fields (`id`, `scopeId`,
 * `claimedBy`, `runnerVersion`) so TTL cleanup can delete a
 * crash-after-upload artifact.
 */
function storageKeyForJob(
  jobId: string,
  scopeId: string,
  fileName: string | null,
  claimId: string | null = null,
  runnerVersion: string | null = null
): string | null {
  if (usesClaimScopedArtifactKey(runnerVersion)) {
    if (!claimId) return null;
    const safeClaimId = encodeURIComponent(claimId);
    return `solar-rec-dashboard/${scopeId}/exports/${jobId}-${safeClaimId}.csv`;
  }
  if (!fileName) return null;
  return `solar-rec-dashboard/${scopeId}/exports/${jobId}-${fileName}`;
}

function usesClaimScopedArtifactKey(runnerVersion: string | null): boolean {
  if (!runnerVersion) return false;
  return runnerVersion !== LEGACY_DETERMINISTIC_ARTIFACT_RUNNER_VERSION;
}

function buildSnapshot(
  row: DashboardCsvExportJob
): DashboardCsvExportStatusSnapshot {
  return {
    jobId: row.id,
    status: row.status as DashboardCsvExportStatus,
    createdAt: row.createdAt.getTime(),
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    completedAt: row.completedAt ? row.completedAt.getTime() : null,
    fileName: row.fileName,
    url: row.artifactUrl,
    rowCount: row.rowCount,
    error: row.errorMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public API: start, run, status
// ─────────────────────────────────────────────────────────────────────

/**
 * Enqueue an export job. Inserts a `queued` row and schedules
 * the runner via `setImmediate` (so the mutation returns fast,
 * before the heavy aggregator or row-table export load).
 *
 * `runner` and `scheduler` are dependency-injected for tests; in
 * production they default to `runCsvExportJob` and `setImmediate`
 * respectively.
 */
export async function startCsvExportJob(
  scopeId: string,
  input: DashboardCsvExportInput,
  runner: (jobId: string) => Promise<void> = runCsvExportJob,
  scheduler: (cb: () => void) => void = cb => setImmediate(cb)
): Promise<{ jobId: string }> {
  const jobId = newJobId();
  await insertDashboardCsvExportJob({
    id: jobId,
    scopeId,
    input,
    status: "queued",
    runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
  });
  scheduleCsvExportRunner(jobId, runner, scheduler);
  return { jobId };
}

/**
 * Read job status for a given scope. Returns `null` when:
 *   - the row doesn't exist (genuine `notFound`), OR
 *   - the row exists for a different scope (cross-scope safety).
 *
 * Public proc translates `null` to `status: "notFound"` so
 * cross-scope job IDs cannot be probed.
 *
 * Opportunistically fires the prune + stale-claim sweeps on each
 * read. Both helpers no-op cheaply when there's nothing to
 * sweep, and TiDB latency is low enough that the cost is
 * negligible compared to a missed sweep tick.
 *
 * Codex P1 follow-up (2026-05-04): if the row is `queued`, also
 * schedule the runner here. Pre-fix the runner was scheduled
 * only at insert time via `setImmediate`; if the inserting
 * process restarted before the runner fired (or before it
 * managed to claim), the row sat queued forever — the sweeper
 * only handles `running` and terminal rows. Now any client poll
 * for a queued row will trigger a runner. The claim semantics
 * inside `runCsvExportJob` ensure exactly one of the racing
 * processes (insert-time scheduler vs. status-poll re-scheduler)
 * actually claims and runs; the others see `claimed === false`
 * and noop. Multi-instance safe because the claim UPDATE is
 * race-safe across processes.
 */
export async function getCsvExportJobStatus(
  scopeId: string,
  jobId: string
): Promise<DashboardCsvExportStatusSnapshot | null> {
  await sweepStaleAndPruned();
  const row = await getDashboardCsvExportJob(scopeId, jobId);
  if (!row) return null;
  if (row.status === "queued") {
    scheduleCsvExportRunner(jobId);
  }
  return buildSnapshot(row);
}

/**
 * Worker entry point. Atomically claims the job, runs the heavy
 * aggregator + CSV build, writes to storage, and atomically
 * completes the row.
 *
 * Cross-process safety:
 *   - The claim is an UPDATE that only matches `queued` OR a
 *     `running` row whose claim went stale. If two workers race
 *     for the same `queued` row, only one's UPDATE matches.
 *   - Completion UPDATEs predicate on `claimedBy = ours`. If a
 *     stale-claim sweep flipped our row to `failed` while we
 *     were in flight, our completion UPDATE no-ops and any
 *     uploaded artifact is immediately deleted best-effort.
 *
 * Errors are captured into the row's `errorMessage`; this
 * function does NOT throw under any expected control flow.
 */
export async function runCsvExportJob(jobId: string): Promise<void> {
  const deadline = createRunnerDeadline(jobId);
  // Fetch the row to know which scope to claim under. The claim
  // call needs `scopeId` because every WHERE in this module is
  // scoped — we don't want a runner from one scope to claim a
  // row in another scope (which can't happen given the schema
  // but the predicate cost is essentially zero).
  let row: DashboardCsvExportJob | null = null;
  try {
    row = await Promise.race([
      getDashboardCsvExportJobById(jobId),
      deadline.promise,
    ]);
  } catch (err) {
    console.error(
      `${METRIC_PREFIX} failed before claim for jobId=${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    deadline.clear();
    return;
  }
  if (!row) {
    // Row was pruned between INSERT and the runner firing
    // (extreme edge: TTL would have to elapse in the schedule
    // gap). Nothing to do.
    deadline.clear();
    return;
  }
  const claimId = getClaimId();
  const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const staleClaimToClean =
    row.status === "running" && row.claimedBy ? row.claimedBy : null;
  let claimed = false;
  try {
    claimed = await Promise.race([
      claimDashboardCsvExportJob(
        row.scopeId,
        jobId,
        claimId,
        staleClaimBefore,
        DASHBOARD_CSV_EXPORT_RUNNER_VERSION
      ),
      deadline.promise,
    ]);
  } catch (err) {
    console.error(
      `${METRIC_PREFIX} failed while claiming jobId=${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    deadline.clear();
    return;
  }
  if (!claimed) {
    // Another worker holds a fresh claim, OR the row already
    // reached a terminal state (most likely: the previous run
    // completed and a duplicate `runCsvExportJob` got scheduled).
    // Nothing for us to do.
    deadline.clear();
    return;
  }
  if (staleClaimToClean && staleClaimToClean !== claimId) {
    const staleKey = storageKeyForJob(
      jobId,
      row.scopeId,
      row.fileName,
      staleClaimToClean,
      row.runnerVersion
    );
    if (staleKey) {
      void cleanupUploadedArtifact(jobId, staleKey, "stale-claim-reclaimed");
    }
  }

  const input = parseInputJson(row.input);
  if (!input) {
    await completeFailureBestEffort(
      row.scopeId,
      jobId,
      claimId,
      "input JSON failed to parse — runner version mismatch?",
      "invalid-input"
    );
    deadline.clear();
    return;
  }

  const metric = startDashboardJobMetric({
    prefix: METRIC_PREFIX,
    jobId,
    context: {
      exportType: input.exportType,
      ...(input.exportType === "datasetCsv"
        ? { datasetKey: input.datasetKey }
        : {}),
    },
  });

  // Codex P1 follow-up (2026-05-04): heartbeat keeps healthy
  // long-running exports from being reaped by the stale-claim
  // sweeper. Refreshes `claimedAt` every HEARTBEAT_INTERVAL_MS
  // while we still own the claim. If a refresh comes back false,
  // we lost the claim — the heartbeat clears itself; the worker
  // continues but its eventual `complete*` UPDATE will no-op.
  let claimLost = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const stillOwn = await refreshDashboardCsvExportJobClaim(
          row.scopeId,
          jobId,
          claimId
        );
        if (!stillOwn) {
          claimLost = true;
          clearInterval(heartbeat);
        }
      } catch (err) {
        // Heartbeat refresh is best-effort — a single failed
        // refresh shouldn't kill the worker. The next tick may
        // succeed; if not, the sweeper handles it.
        console.warn(
          `${METRIC_PREFIX} heartbeat refresh failed for jobId=${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  // Make heartbeat unref'd: a Node process should be allowed to
  // exit even if a heartbeat is still ticking (the worker itself
  // is also fire-and-forget).
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  let uploadedKey: string | null = null;
  let completionRecorded = false;
  let uploadedArtifactCleaned = false;
  let successCompletionStarted = false;
  let builtForCleanup: BuiltCsvArtifact | null = null;
  let deferBuiltCleanupUntilUploadSettles = false;

  const cleanupCurrentUploadedArtifact = async (reason: string) => {
    if (!uploadedKey || completionRecorded || uploadedArtifactCleaned) return;
    uploadedArtifactCleaned = true;
    await cleanupUploadedArtifact(jobId, uploadedKey, reason);
  };

  try {
    let buildTimedOut = false;
    const buildPromise = buildExport(input, row.scopeId);
    void buildPromise.then(
      lateBuilt => {
        if (!buildTimedOut) return;
        void lateBuilt.cleanup?.().catch(cleanupErr => {
          console.warn(
            `${METRIC_PREFIX} late temp CSV cleanup failed for jobId=${jobId}: ${
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr)
            }`
          );
        });
      },
      lateErr => {
        if (!buildTimedOut) return;
        console.warn(
          `${METRIC_PREFIX} CSV build rejected after runner timeout ` +
            `for jobId=${jobId}: ${
              lateErr instanceof Error ? lateErr.message : String(lateErr)
            }`
        );
      }
    );
    const built = await Promise.race([
      buildPromise,
      deadline.promise.catch(err => {
        if (err instanceof DashboardCsvExportTimeoutError) {
          buildTimedOut = true;
        }
        throw err;
      }),
    ]);
    builtForCleanup = built;
    deadline.throwIfExpired();
    if (built.rowCount === 0) {
      // No rows match — skip the storage write entirely. The
      // client surfaces this case with a "no rows match" toast
      // and does not attempt a download.
      successCompletionStarted = true;
      const ok = await Promise.race([
        completeDashboardCsvExportJobSuccess(row.scopeId, jobId, claimId, {
          fileName: built.fileName,
          artifactUrl: null,
          rowCount: 0,
          csvBytes: 0,
        }),
        deadline.promise,
      ]);
      successCompletionStarted = false;
      if (!ok) {
        // Lost our claim mid-flight (sweeper flipped us stale, or
        // heartbeat noticed in advance). No artifact was written
        // so there's nothing to clean up.
        metric.fail(
          new Error("lost claim before completion (rowCount=0 path)")
        );
        return;
      }
      metric.finish({ rowCount: 0, csvBytes: 0, storageWrite: false });
      return;
    }

    const key = storageKeyForJob(
      jobId,
      row.scopeId,
      built.fileName,
      claimId,
      DASHBOARD_CSV_EXPORT_RUNNER_VERSION
    );
    if (!key) {
      throw new Error("storageKeyForJob returned null after fileName was set");
    }
    let storagePutTimedOut = false;
    const csvBytes = getBuiltCsvBytes(built);
    const storagePutPromise = uploadBuiltCsvArtifact(key, built);
    void storagePutPromise.then(
      () => {
        if (storagePutTimedOut) {
          void built.cleanup?.().catch(cleanupErr => {
            console.warn(
              `${METRIC_PREFIX} late temp CSV cleanup failed after ` +
                `storagePut timeout for jobId=${jobId}: ${
                  cleanupErr instanceof Error
                    ? cleanupErr.message
                    : String(cleanupErr)
                }`
            );
          });
        }
        if (!storagePutTimedOut || completionRecorded) return;
        void cleanupUploadedArtifact(
          jobId,
          key,
          "late-storage-put-after-timeout"
        );
      },
      lateErr => {
        if (storagePutTimedOut) {
          void built.cleanup?.().catch(cleanupErr => {
            console.warn(
              `${METRIC_PREFIX} late temp CSV cleanup failed after ` +
                `storagePut rejection for jobId=${jobId}: ${
                  cleanupErr instanceof Error
                    ? cleanupErr.message
                    : String(cleanupErr)
                }`
            );
          });
        }
        if (!storagePutTimedOut) return;
        console.warn(
          `${METRIC_PREFIX} storagePut rejected after runner timeout ` +
            `for jobId=${jobId} key=${key}: ${
              lateErr instanceof Error ? lateErr.message : String(lateErr)
            }`
        );
      }
    );
    await Promise.race([
      storagePutPromise,
      deadline.promise.catch(err => {
        if (err instanceof DashboardCsvExportTimeoutError) {
          storagePutTimedOut = true;
          deferBuiltCleanupUntilUploadSettles = Boolean(built.filePath);
        }
        throw err;
      }),
    ]);
    uploadedKey = key;
    deadline.throwIfExpired();
    const { url } = await Promise.race([storageGet(key), deadline.promise]);
    deadline.throwIfExpired();
    successCompletionStarted = true;
    let successCompletionTimedOut = false;
    const successCompletionPromise = completeDashboardCsvExportJobSuccess(
      row.scopeId,
      jobId,
      claimId,
      {
        fileName: built.fileName,
        artifactUrl: url,
        rowCount: built.rowCount,
        csvBytes,
      }
    );
    void successCompletionPromise.then(
      ok => {
        if (!successCompletionTimedOut || ok) return;
        void cleanupCurrentUploadedArtifact(
          "late-success-completion-lost-claim"
        );
      },
      lateErr => {
        if (!successCompletionTimedOut) return;
        void cleanupCurrentUploadedArtifact("late-success-completion-error");
        console.warn(
          `${METRIC_PREFIX} success completion rejected after runner ` +
            `timeout for jobId=${jobId}: ${
              lateErr instanceof Error ? lateErr.message : String(lateErr)
            }`
        );
      }
    );
    const ok = await Promise.race([
      successCompletionPromise,
      deadline.promise.catch(err => {
        if (err instanceof DashboardCsvExportTimeoutError) {
          successCompletionTimedOut = true;
        }
        throw err;
      }),
    ]);
    successCompletionStarted = false;
    if (!ok) {
      // Codex P2 follow-up (2026-05-04): lost claim AFTER
      // storagePut. The completion UPDATE didn't record fileName /
      // artifactUrl on the row, so the TTL prune sweep can't
      // reconstruct the storage key (`storageKeyForJob` returns
      // null for fileName=null). Without immediate cleanup the
      // artifact is genuinely orphaned. Best-effort delete here;
      // log + swallow if it fails.
      await cleanupCurrentUploadedArtifact("lost-claim");
      metric.fail(new Error("lost claim before completion (success path)"));
      return;
    }
    completionRecorded = true;
    metric.finish({
      rowCount: built.rowCount,
      csvBytes,
      storageWrite: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOutDuringSuccessCompletion =
      err instanceof DashboardCsvExportTimeoutError &&
      successCompletionStarted &&
      !completionRecorded;
    if (!timedOutDuringSuccessCompletion) {
      await cleanupCurrentUploadedArtifact(
        err instanceof DashboardCsvExportTimeoutError
          ? "runner-timeout"
          : "post-upload-error"
      );
    } else {
      console.warn(
        `${METRIC_PREFIX} runner timed out while success completion was ` +
          `in flight for jobId=${jobId}; leaving artifact for the in-flight ` +
          `completion to record. If completion never lands, storage lifecycle ` +
          `cleanup must reclaim it.`
      );
    }
    if (!claimLost && !timedOutDuringSuccessCompletion) {
      await completeFailureBestEffort(
        row.scopeId,
        jobId,
        claimId,
        message,
        err instanceof DashboardCsvExportTimeoutError
          ? "runner-timeout"
          : "runner-error"
      );
    }
    metric.fail(err);
  } finally {
    if (builtForCleanup?.cleanup && !deferBuiltCleanupUntilUploadSettles) {
      await builtForCleanup.cleanup().catch(cleanupErr => {
        console.warn(
          `${METRIC_PREFIX} temp CSV cleanup failed for jobId=${jobId}: ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`
        );
      });
    }
    deadline.clear();
    clearInterval(heartbeat);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function scheduleCsvExportRunner(
  jobId: string,
  runner: (jobId: string) => Promise<void> = runCsvExportJob,
  scheduler: (cb: () => void) => void = cb => setImmediate(cb)
): boolean {
  if (pendingRunnerJobIdSet.has(jobId) || activeRunnerJobIds.has(jobId)) {
    return false;
  }
  pendingRunnerJobIdSet.add(jobId);
  pendingRunnerJobs.push({ jobId, runner });
  if (!runnerDrainScheduled) {
    runnerDrainScheduled = true;
    scheduler(() => drainScheduledRunnerQueue(scheduler));
  }
  return true;
}

function drainScheduledRunnerQueue(
  scheduler: (cb: () => void) => void = cb => setImmediate(cb)
): void {
  runnerDrainScheduled = false;
  while (
    activeRunnerJobIds.size < maxLocalRunners &&
    pendingRunnerJobs.length > 0
  ) {
    const next = pendingRunnerJobs.shift();
    if (!next) continue;
    pendingRunnerJobIdSet.delete(next.jobId);
    if (activeRunnerJobIds.has(next.jobId)) continue;
    activeRunnerJobIds.add(next.jobId);
    Promise.resolve()
      .then(() => next.runner(next.jobId))
      .catch(err => {
        console.error(
          `${METRIC_PREFIX} runner threw for jobId=${next.jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      })
      .finally(() => {
        activeRunnerJobIds.delete(next.jobId);
        if (pendingRunnerJobs.length > 0) {
          scheduleRunnerDrain(scheduler);
        }
      });
  }
  if (
    pendingRunnerJobs.length > 0 &&
    activeRunnerJobIds.size < maxLocalRunners
  ) {
    scheduleRunnerDrain(scheduler);
  }
}

function scheduleRunnerDrain(scheduler: (cb: () => void) => void): void {
  if (runnerDrainScheduled) return;
  runnerDrainScheduled = true;
  scheduler(() => drainScheduledRunnerQueue(scheduler));
}

async function cleanupUploadedArtifact(
  jobId: string,
  key: string,
  reason: string
): Promise<void> {
  try {
    await storageDelete(key);
  } catch (deleteErr) {
    console.warn(
      `${METRIC_PREFIX} cleanup storageDelete failed for orphaned ` +
        `${reason} artifact jobId=${jobId} key=${key}: ${
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
        }`
    );
  }
}

async function completeFailureBestEffort(
  scopeId: string,
  jobId: string,
  claimId: string,
  errorMessage: string,
  context: string
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), TERMINAL_UPDATE_TIMEOUT_MS);
    const maybeUnref = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  });
  try {
    const ok = await Promise.race([
      completeDashboardCsvExportJobFailure(
        scopeId,
        jobId,
        claimId,
        errorMessage
      ),
      timeout,
    ]);
    if (!ok) {
      console.warn(
        `${METRIC_PREFIX} failure completion did not record for ` +
          `jobId=${jobId} context=${context}`
      );
    }
    return ok;
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} failure completion threw for jobId=${jobId} ` +
        `context=${context}: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createRunnerDeadline(jobId: string): {
  promise: Promise<never>;
  clear: () => void;
  throwIfExpired: () => void;
} {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutError = new DashboardCsvExportTimeoutError(jobId);
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeoutError);
    }, EXPORT_RUNNER_TIMEOUT_MS);
    const maybeUnref = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  });
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
    throwIfExpired: () => {
      if (expired) throw timeoutError;
    },
  };
}

/**
 * Lookup helper that doesn't require the caller to know the
 * scope. Used by `runCsvExportJob` which is fired with only a
 * jobId from `setImmediate`. Bypass the cross-scope null
 * filtering because the worker is trusted server-side code.
 */
async function getDashboardCsvExportJobById(
  jobId: string
): Promise<DashboardCsvExportJob | null> {
  // The DB helper requires a scope, so we read first by
  // scanning across all scopes — but in practice the unique-id
  // assumption means at most one row matches. We do this with a
  // direct Drizzle query rather than adding a new exported
  // helper just for the worker's narrow needs.
  const { getDb, withDbRetry, eq } = await import("../../db/_core");
  const { dashboardCsvExportJobs } = await import("../../../drizzle/schema");
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry(
    "get dashboard csv export job by id",
    async () =>
      db
        .select()
        .from(dashboardCsvExportJobs)
        .where(eq(dashboardCsvExportJobs.id, jobId))
        .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Defensive parse of the row's `input` JSON column. Drizzle's
 * MySQL JSON column returns parsed objects, but a future runner
 * version change could leave stale-shape rows that the new code
 * can't decode. Return `null` to signal "fail this job" so the
 * runner doesn't hang.
 */
function parseInputJson(rawInput: unknown): DashboardCsvExportInput | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const candidate = rawInput as Record<string, unknown>;
  if (candidate.exportType === "ownershipTile") {
    if (
      candidate.tile === "reporting" ||
      candidate.tile === "notReporting" ||
      candidate.tile === "terminated"
    ) {
      return {
        exportType: "ownershipTile",
        tile: candidate.tile,
      };
    }
    return null;
  }
  if (candidate.exportType === "changeOwnershipTile") {
    // Trust the discriminator; a future addition to the
    // ChangeOwnershipStatus union doesn't break older readers
    // because the worker's only consumer is the tile CSV file
    // builder, which already filters by exact-string equality.
    if (typeof candidate.status === "string") {
      return {
        exportType: "changeOwnershipTile",
        status: candidate.status as ChangeOwnershipStatus,
      };
    }
    return null;
  }
  if (candidate.exportType === "datasetCsv") {
    if (isDashboardDatasetCsvExportKey(candidate.datasetKey)) {
      return {
        exportType: "datasetCsv",
        datasetKey: candidate.datasetKey,
      };
    }
    return null;
  }
  return null;
}

interface BuiltCsvArtifact {
  csv?: string;
  filePath?: string;
  fileName: string;
  rowCount: number;
  csvBytes?: number;
  cleanup?: () => Promise<void>;
}

async function buildExport(
  input: DashboardCsvExportInput,
  scopeId: string
): Promise<BuiltCsvArtifact> {
  if (input.exportType === "ownershipTile") {
    const { result } = await getOrBuildOverviewSummary(scopeId);
    return buildOwnershipTileCsvFile(result.ownershipRows, input.tile);
  }
  if (input.exportType === "datasetCsv") {
    return buildDatasetCsvExport(scopeId, input.datasetKey);
  }
  const { result } = await getOrBuildChangeOwnership(scopeId);
  return buildChangeOwnershipTileCsvFile(result.rows, input.status);
}

function getBuiltCsvBytes(built: BuiltCsvArtifact): number {
  if (typeof built.csvBytes === "number") return built.csvBytes;
  if (typeof built.csv === "string")
    return Buffer.byteLength(built.csv, "utf8");
  throw new Error("CSV export artifact has neither csvBytes nor csv text");
}

async function uploadBuiltCsvArtifact(
  key: string,
  built: BuiltCsvArtifact
): Promise<{ key: string; url: string }> {
  if (built.filePath) {
    return storagePutFile(key, built.filePath, "text/csv; charset=utf-8");
  }
  if (typeof built.csv === "string") {
    return storagePut(key, built.csv, "text/csv; charset=utf-8");
  }
  throw new Error("CSV export artifact has neither filePath nor csv text");
}

/**
 * Combined sweep: stale-claim recovery + TTL prune + best-effort
 * storage cleanup. Fired opportunistically on every status read.
 * Both individual sweeps short-circuit cheaply when there's
 * nothing to do (zero affected rows).
 *
 * The TTL prune deletes the row first then fires `storageDelete`
 * for each artifact URL — the storage cleanup is best-effort
 * (proxy-mode `storageDelete` attempts the Forge delete endpoint
 * and returns false if the proxy rejects it). A failed
 * `storageDelete` doesn't roll back the row delete: the artifact
 * would persist until the storage lifecycle policy reclaims it.
 */
async function sweepStaleAndPruned(): Promise<void> {
  try {
    const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
    const ttlBefore = new Date(Date.now() - JOB_TTL_MS);
    // Fire both sweeps in parallel — they touch disjoint row
    // states (`failStale` only updates `running`, `prune` only
    // deletes terminal rows).
    const [staleCount, prunedRows] = await Promise.all([
      failStaleDashboardCsvExportJobs(staleClaimBefore),
      pruneTerminalDashboardCsvExportJobs(ttlBefore),
    ]);
    if (staleCount > 0) {
      console.warn(
        `${METRIC_PREFIX} marked ${staleCount} stale-claim row(s) failed`
      );
    }
    for (const row of prunedRows) {
      const key = storageKeyForJob(
        row.id,
        row.scopeId,
        row.fileName,
        row.claimedBy,
        row.runnerVersion
      );
      if (!key) continue;
      if (!row.artifactUrl && !usesClaimScopedArtifactKey(row.runnerVersion)) {
        continue;
      }
      // Fire-and-forget; don't block the sweep on storage IO.
      storageDelete(key).catch(err => {
        console.warn(
          `${METRIC_PREFIX} cleanup storageDelete failed for jobId=${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Test-only surface — exposed so unit tests can trigger sweeps
 * deterministically and inspect the configured constants. Never
 * imported by production code.
 */
export const __TEST_ONLY__ = {
  sweepStaleAndPruned,
  getClaimId,
  parseInputJson,
  storageKeyForJob,
  getRunnerSchedulerState: () => ({
    pendingJobIds: pendingRunnerJobs.map(job => job.jobId),
    pendingJobIdSet: Array.from(pendingRunnerJobIdSet),
    activeJobIds: Array.from(activeRunnerJobIds),
    runnerDrainScheduled,
  }),
  resetRunnerSchedulerState: () => {
    pendingRunnerJobs.length = 0;
    pendingRunnerJobIdSet.clear();
    activeRunnerJobIds.clear();
    runnerDrainScheduled = false;
    maxLocalRunners = DEFAULT_MAX_LOCAL_RUNNERS;
  },
  setMaxLocalRunnersForTest: (value: number) => {
    maxLocalRunners = value;
  },
  JOB_TTL_MS,
  STALE_CLAIM_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_LOCAL_RUNNERS: DEFAULT_MAX_LOCAL_RUNNERS,
  EXPORT_RUNNER_TIMEOUT_MS,
};
