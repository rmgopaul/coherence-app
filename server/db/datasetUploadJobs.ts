/**
 * Dataset upload jobs — database helpers (Phase 1).
 *
 * Backs the server-side dashboard refactor — see
 * `docs/server-side-dashboard-refactor.md`. The upload runner in
 * `server/services/core/datasetUploadJobRunner.ts` and the tRPC
 * procs on `solarRecDashboardRouter` consume these helpers.
 *
 * Every read + write here is scope-aware: callers pass `scopeId`
 * and the WHERE clause filters by it, so a malicious id-from-
 * elsewhere noops rather than touching another team's row. Writes
 * also sanity-check the scope on lookup before mutating.
 */
import { and, desc, eq, getDb, withDbRetry } from "./_core";
import { inArray, lt, sql } from "drizzle-orm";
import {
  datasetUploadJobs,
  datasetUploadJobErrors,
  solarRecImportBatches,
  type DatasetUploadJob,
  type DatasetUploadJobError,
  type InsertDatasetUploadJob,
  type InsertDatasetUploadJobError,
} from "../../drizzle/schema";

/** Allowed counter columns for `incrementDatasetUploadJobCounter`. */
type CounterField = "uploadedChunks" | "rowsParsed" | "rowsWritten";

const STALE_UPLOAD_JOB_MESSAGE =
  "Job timed out — runner did not complete within the stale-job " +
  "threshold. The most likely cause is a server restart or OOM " +
  "while the runner was processing this upload. Re-upload to retry.";

const IN_FLIGHT_UPLOAD_STATUSES = [
  "queued",
  "uploading",
  "parsing",
  "preparing",
  "writing",
] as const;

const REPAIRABLE_ACTIVE_BATCH_JOB_STATUSES = [
  ...IN_FLIGHT_UPLOAD_STATUSES,
  "failed",
] as const;

function affectedRows(result: unknown): number {
  return (
    (result as { affectedRows?: number; rowCount?: number }).affectedRows ??
    (result as { rowCount?: number }).rowCount ??
    0
  );
}

/**
 * Insert a freshly-queued upload job. Caller provides `id` (nanoid)
 * and the upload session metadata; runner state defaults to zero.
 */
export async function insertDatasetUploadJob(
  entry: InsertDatasetUploadJob
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("insert dataset upload job", async () => {
    await db.insert(datasetUploadJobs).values(entry);
  });
}

/**
 * Fetch a single job for a scope. Returns null when the id doesn't
 * match the scope (so a malicious id from another scope reads as
 * "not found" rather than leaking that the row exists). Callers
 * should treat null as 404.
 */
export async function getDatasetUploadJob(
  scopeId: string,
  id: string
): Promise<DatasetUploadJob | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get dataset upload job", async () =>
    db
      .select()
      .from(datasetUploadJobs)
      .where(
        and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.id, id)
        )
      )
      .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * List recent upload jobs for a scope, newest-first by createdAt.
 * Optional `datasetKey` filter; optional `limit` clamped to
 * [1, 200] (default 50). Used by the "Recent uploads" UI.
 */
export async function listDatasetUploadJobs(
  scopeId: string,
  opts: { datasetKey?: string; limit?: number } = {}
): Promise<DatasetUploadJob[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const where =
    opts.datasetKey != null
      ? and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.datasetKey, opts.datasetKey)
        )
      : eq(datasetUploadJobs.scopeId, scopeId);
  return withDbRetry("list dataset upload jobs", async () =>
    db
      .select()
      .from(datasetUploadJobs)
      .where(where)
      .orderBy(desc(datasetUploadJobs.createdAt))
      .limit(limit)
  );
}

/**
 * Patch a job's mutable fields. Returns true when a row was
 * updated, false when the (scopeId, id) pair didn't match — so the
 * caller can distinguish "no-op for an unknown id" from "actually
 * patched."
 *
 * Status transitions are NOT validated here — that's the caller's
 * responsibility (`shared/datasetUpload.helpers.ts`'s
 * `isValidUploadStatusTransition`). This helper just writes.
 *
 * `updatedAt` is bumped regardless of which fields the patch
 * touches, matching the pattern in the rest of `server/db/`.
 */
export async function updateDatasetUploadJob(
  scopeId: string,
  id: string,
  patch: {
    status?: string;
    uploadedChunks?: number;
    totalChunks?: number | null;
    storageKey?: string | null;
    totalRows?: number | null;
    rowsParsed?: number;
    rowsWritten?: number;
    errorMessage?: string | null;
    batchId?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  }
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const update: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  if (Object.keys(update).length === 0) return false;
  update.updatedAt = new Date();
  const result = await withDbRetry("update dataset upload job", async () =>
    db
      .update(datasetUploadJobs)
      .set(update)
      .where(
        and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.id, id)
        )
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Heartbeat an in-flight job without changing user-visible counters.
 * Long append uploads can spend several minutes copying prior rows
 * or loading dedupe keys before CSV row counters move; this keeps
 * `updatedAt` fresh so the stale-job sweeper only fails genuinely
 * quiet jobs.
 */
export async function touchDatasetUploadJob(
  scopeId: string,
  id: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await withDbRetry("touch dataset upload job", async () =>
    db
      .update(datasetUploadJobs)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.id, id)
        )
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Atomic counter increment via SQL `field = field + delta`. Avoids
 * the read-modify-write race when the parser writes per-batch and
 * a concurrent status-update is also touching the row.
 *
 * Only allows known counter columns (`uploadedChunks`,
 * `rowsParsed`, `rowsWritten`) — `field` is constrained at the
 * type level so a typo can't write to an arbitrary column.
 *
 * Returns true when the row was updated, false when it wasn't
 * found (or wasn't in the caller's scope).
 */
export async function incrementDatasetUploadJobCounter(
  scopeId: string,
  id: string,
  field: CounterField,
  delta: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (!Number.isFinite(delta) || delta === 0) return false;
  const column = COUNTER_COLUMN[field];
  const result = await withDbRetry(
    "increment dataset upload job counter",
    async () =>
      db
        .update(datasetUploadJobs)
        .set({
          [field]: sql`${column} + ${delta}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(datasetUploadJobs.scopeId, scopeId),
            eq(datasetUploadJobs.id, id)
          )
        )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

const COUNTER_COLUMN: Record<CounterField, ReturnType<typeof sql.raw>> = {
  uploadedChunks: sql.raw("uploadedChunks"),
  rowsParsed: sql.raw("rowsParsed"),
  rowsWritten: sql.raw("rowsWritten"),
};

/**
 * Persist a per-row error so a parser failure on one row of a
 * 32k-row file doesn't lose the diagnostic. Best-effort:
 * `withDbRetry` retries transient failures, but a hard failure
 * here is logged via the runner's error handler — not raised back
 * to the caller, since errors-of-errors don't help anyone.
 */
export async function recordDatasetUploadJobError(
  entry: InsertDatasetUploadJobError
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("record dataset upload job error", async () => {
    await db.insert(datasetUploadJobErrors).values(entry);
  });
}

/**
 * Fetch the per-row error rows for a job, oldest-first by
 * createdAt. Used by the UI to surface "X rows failed: …" after
 * a partial-success run.
 */
export async function listDatasetUploadJobErrors(
  jobId: string,
  opts: { limit?: number } = {}
): Promise<DatasetUploadJobError[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  return withDbRetry("list dataset upload job errors", async () =>
    db
      .select()
      .from(datasetUploadJobErrors)
      .where(eq(datasetUploadJobErrors.jobId, jobId))
      .orderBy(datasetUploadJobErrors.createdAt)
      .limit(limit)
  );
}

/**
 * 2026-05-08 (Phase 7 fragment) — TTL prune for terminal-status
 * (`done` or `failed`) `datasetUploadJobs` rows older than
 * `maxAgeMs`. Removes the rows AND the per-row
 * `datasetUploadJobErrors` they own (FK-less but logically
 * dependent), via the existing `deleteDatasetUploadJob` helper
 * which handles both deletes in the right order.
 *
 * Without this prune, every successful or failed upload accumulates
 * a row indefinitely. Production scope-user-1 has ≥100 historic
 * upload jobs (Phase H-1 storage audit, see
 * `docs/h1-prod-baseline-attribution.md`); each holds ~50-200 KB of
 * fileName + statusMessage + per-row error payloads. The total
 * isn't headline-grabbing today (~10-20 MB) but the table grows
 * unboundedly, which slows the in-flight job queries used by the
 * dashboard's cloud-sync indicator.
 *
 * Caller-provided `maxAgeMs` should be at least the longest cache
 * window any user might care about — 7 days is a reasonable default
 * (`DATASET_UPLOAD_TERMINAL_RETENTION_DEFAULT` in the sweeper).
 *
 * Returns the count of rows actually deleted. Rows that
 * `deleteDatasetUploadJob` reports as already-gone (e.g. raced with
 * a manual delete) are not counted.
 */
export async function pruneOldTerminalDatasetUploadJobs(
  maxAgeMs: number
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - maxAgeMs);
  const oldRows = await withDbRetry(
    "load old terminal dataset upload jobs",
    async () =>
      db
        .select({
          id: datasetUploadJobs.id,
          scopeId: datasetUploadJobs.scopeId,
        })
        .from(datasetUploadJobs)
        .where(
          and(
            inArray(datasetUploadJobs.status, ["done", "failed"]),
            lt(datasetUploadJobs.updatedAt, cutoff)
          )
        )
  );

  let pruned = 0;
  for (const row of oldRows) {
    try {
      const deleted = await deleteDatasetUploadJob(row.scopeId, row.id);
      if (deleted) pruned += 1;
    } catch (err) {
      // Per-row failures don't fail the sweep; log and continue.
      // The next sweep tick re-attempts; idempotent.
      // eslint-disable-next-line no-console
      console.warn(
        `[pruneOldTerminalDatasetUploadJobs] failed to prune ` +
          `scope=${row.scopeId} id=${row.id}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  return pruned;
}

/**
 * Hard delete a job and every error row attached to it. Reserved
 * for the cleanup cron (Phase 7) that prunes finished jobs older
 * than N days; no UI calls this today.
 *
 * 2026-05-08 — `pruneOldTerminalDatasetUploadJobs` is the cron
 * caller this docstring referenced. The two helpers compose:
 * `pruneOld...` finds the IDs to drop, `deleteDatasetUploadJob`
 * does the per-row delete (children first).
 */
export async function deleteDatasetUploadJob(
  scopeId: string,
  id: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  // Order matters: delete errors first (FK-less, but logically
  // child) then the job. A scope-mismatched job won't be
  // deleted, and the error rows remain orphaned — safe because
  // the listErrors query joins by jobId and the job is gone.
  await withDbRetry("delete dataset upload job errors", async () =>
    db
      .delete(datasetUploadJobErrors)
      .where(eq(datasetUploadJobErrors.jobId, id))
  );
  const result = await withDbRetry("delete dataset upload job", async () =>
    db
      .delete(datasetUploadJobs)
      .where(
        and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.id, id)
        )
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Sweep stale upload jobs — auto-fail rows in non-terminal status
 * (`queued`, `uploading`, `parsing`, `preparing`, `writing`) whose
 * `updatedAt` is older than `staleAfterMs`. Used to clean up jobs whose
 * runner crashed mid-flight (e.g. the OOM that crashed the Render
 * instance before PRs #302 + #303 landed). Without the sweep,
 * those job rows live forever and the dashboard's cloud-sync
 * indicator never clears.
 *
 * Returns the count of rows terminalized. Idempotent — already-failed
 * or already-done rows are not touched. Scope-agnostic; intended
 * for a process-level sweep timer (see
 * `server/services/core/datasetUploadStaleJobSweeper.ts`).
 */
export async function sweepStaleDatasetUploadJobs(
  staleAfterMs: number
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - staleAfterMs);
  const staleJobs = await withDbRetry(
    "load stale dataset upload jobs",
    async () =>
      db
        .select({
          id: datasetUploadJobs.id,
          scopeId: datasetUploadJobs.scopeId,
          datasetKey: datasetUploadJobs.datasetKey,
          batchId: datasetUploadJobs.batchId,
        })
        .from(datasetUploadJobs)
        .where(
          and(
            inArray(datasetUploadJobs.status, IN_FLIGHT_UPLOAD_STATUSES),
            lt(datasetUploadJobs.updatedAt, cutoff)
          )
        )
  );

  let terminalizedJobs = 0;
  for (const job of staleJobs) {
    const completedAt = new Date();
    if (job.batchId) {
      const batch = await loadStaleUploadBatch(job.batchId);
      if (batch?.status === "active") {
        const repaired = await markUploadJobDoneForActiveBatch(
          job.scopeId,
          job.id,
          job.batchId,
          coerceDate(batch.completedAt, completedAt)
        );
        if (repaired) terminalizedJobs += 1;
        continue;
      }
    }

    const failed = await failStaleUploadJob(
      job.scopeId,
      job.id,
      cutoff,
      completedAt
    );
    if (!failed) continue;

    terminalizedJobs += 1;
    if (job.batchId) {
      const cleanupResult = await cleanupStaleUploadBatch(
        job.datasetKey,
        job.batchId,
        STALE_UPLOAD_JOB_MESSAGE,
        completedAt
      );
      if (cleanupResult === "active") {
        await markUploadJobDoneForActiveBatch(
          job.scopeId,
          job.id,
          job.batchId,
          completedAt
        );
      }
    }
  }

  return terminalizedJobs;
}

type StaleUploadBatchSnapshot = {
  status: string | null;
  completedAt: Date | string | null;
};

async function loadStaleUploadBatch(
  batchId: string
): Promise<StaleUploadBatchSnapshot | null> {
  const db = await getDb();
  if (!db) return null;

  const batchRows = await withDbRetry("load stale upload import batch", () =>
    db
      .select({
        status: solarRecImportBatches.status,
        completedAt: solarRecImportBatches.completedAt,
      })
      .from(solarRecImportBatches)
      .where(eq(solarRecImportBatches.id, batchId))
      .limit(1)
  );
  return batchRows[0] ?? null;
}

function coerceDate(value: Date | string | null, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return fallback;
}

async function markUploadJobDoneForActiveBatch(
  scopeId: string,
  jobId: string,
  batchId: string,
  completedAt: Date
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const result = await withDbRetry(
    "repair activated stale dataset upload job",
    async () =>
      db
        .update(datasetUploadJobs)
        .set({
          status: "done",
          errorMessage: null,
          completedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(datasetUploadJobs.scopeId, scopeId),
            eq(datasetUploadJobs.id, jobId),
            eq(datasetUploadJobs.batchId, batchId),
            inArray(
              datasetUploadJobs.status,
              REPAIRABLE_ACTIVE_BATCH_JOB_STATUSES
            )
          )
        )
  );

  return affectedRows(result) > 0;
}

async function failStaleUploadJob(
  scopeId: string,
  jobId: string,
  cutoff: Date,
  completedAt: Date
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const result = await withDbRetry("fail stale dataset upload job", async () =>
    db
      .update(datasetUploadJobs)
      .set({
        status: "failed",
        errorMessage: STALE_UPLOAD_JOB_MESSAGE,
        completedAt,
      })
      .where(
        and(
          eq(datasetUploadJobs.scopeId, scopeId),
          eq(datasetUploadJobs.id, jobId),
          inArray(datasetUploadJobs.status, IN_FLIGHT_UPLOAD_STATUSES),
          lt(datasetUploadJobs.updatedAt, cutoff)
        )
      )
  );

  return affectedRows(result) > 0;
}

type StaleUploadBatchCleanupResult = "active" | "failed" | "skipped";

async function cleanupStaleUploadBatch(
  datasetKey: string,
  batchId: string,
  message: string,
  completedAt: Date
): Promise<StaleUploadBatchCleanupResult> {
  const db = await getDb();
  if (!db) return "skipped";

  const batch = await loadStaleUploadBatch(batchId);
  if (!batch) return "skipped";
  if (batch.status === "active") return "active";
  if (!["uploading", "processing", "failed"].includes(String(batch.status))) {
    return "skipped";
  }

  const result = await withDbRetry(
    "mark stale upload import batch failed",
    () =>
      db
        .update(solarRecImportBatches)
        .set({
          status: "failed",
          error: message,
          completedAt,
        })
        .where(
          and(
            eq(solarRecImportBatches.id, batchId),
            sql`${solarRecImportBatches.status} IN ('uploading', 'processing', 'failed')`
          )
        )
  );
  if (affectedRows(result) <= 0) {
    const latestBatch = await loadStaleUploadBatch(batchId);
    if (latestBatch?.status === "active") return "active";
    return "skipped";
  }

  try {
    const { deleteDatasetBatchRows } =
      await import("../services/solar/datasetRowPersistence");
    await deleteDatasetBatchRows(datasetKey, batchId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[sweepStaleDatasetUploadJobs] failed to purge rows for stale ${datasetKey} batch ${batchId}`,
      err
    );
  }
  return "failed";
}
