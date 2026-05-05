/**
 * Tesla Powerhub production jobs — database helpers.
 *
 * Mirrors the `dashboardCsvExportJobs` template (Phase 6 PR-B) per
 * CLAUDE.md Hard Rule #8: dashboard / solar background-job
 * registries must be DB-backed (process restart safe, multi-instance
 * race-safe, no in-memory Map). PR #368 restored Tesla Powerhub
 * production jobs via an in-memory `Map<jobId, snapshot>`; this
 * module is the replacement.
 *
 * Same atomic-claim + heartbeat + stale-claim sweep pattern as
 * dashboardCsvExportJobs:
 *   - claim: UPDATE … WHERE (status='queued' OR (status='running'
 *     AND claimedAt < staleClaimBefore))
 *   - completion writes predicate on `claimedBy = ours` so a
 *     re-claimer cannot have its terminal state overwritten.
 *   - sweep flips stale `running` rows to `failed` and prunes
 *     terminal rows past TTL.
 *
 * Status alphabet differs from dashboardCsvExportJobs:
 *   "queued" | "running" | "completed" | "failed"
 * (Tesla snapshot consumers shipped via PR #368 expect "completed",
 * not "succeeded"; preserving for wire compat.)
 */
import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { lt, or } from "drizzle-orm";
import {
  teslaPowerhubProductionJobs,
  type TeslaPowerhubProductionJobRow,
  type InsertTeslaPowerhubProductionJobRow,
} from "../../drizzle/schema";

/**
 * Insert a freshly-queued production job. Throws if the DB is
 * unavailable — same fail-fast contract as
 * `insertDashboardCsvExportJob`. Silently returning would hand the
 * client a `jobId` for a row that doesn't exist; a subsequent poll
 * would surface `notFound` (terminal) and the user-visible toast
 * would be detached from the actual cause.
 */
export async function insertTeslaPowerhubProductionJob(
  entry: InsertTeslaPowerhubProductionJobRow
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error(
      "teslaPowerhubProductionJobs: database unavailable — cannot insert job"
    );
  }
  await withDbRetry("insert tesla powerhub production job", async () => {
    await db.insert(teslaPowerhubProductionJobs).values(entry);
  });
}

/**
 * Fetch a single job for a scope. Returns `null` when the row
 * doesn't exist OR exists for a different scope (cross-scope
 * safety). Public proc translates to `notFound`.
 */
export async function getTeslaPowerhubProductionJob(
  scopeId: string,
  id: string
): Promise<TeslaPowerhubProductionJobRow | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry(
    "get tesla powerhub production job",
    async () =>
      db
        .select()
        .from(teslaPowerhubProductionJobs)
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id)
          )
        )
        .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Worker-side lookup that bypasses scope filtering. Used by the
 * runner which is fired with only a `jobId`; trusted server-side
 * code reads the row to learn its `scopeId` then issues all
 * subsequent writes scope-aware.
 */
export async function getTeslaPowerhubProductionJobById(
  id: string
): Promise<TeslaPowerhubProductionJobRow | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry(
    "get tesla powerhub production job by id",
    async () =>
      db
        .select()
        .from(teslaPowerhubProductionJobs)
        .where(eq(teslaPowerhubProductionJobs.id, id))
        .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * List recent jobs for a scope. Used by the debug surface that
 * powers the "list my jobs" admin view. Bounded by `limit`; default
 * 50 keeps the response payload small.
 */
export async function listRecentTeslaPowerhubProductionJobs(
  scopeId: string,
  limit = 50
): Promise<TeslaPowerhubProductionJobRow[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "list recent tesla powerhub production jobs",
    async () =>
      db
        .select()
        .from(teslaPowerhubProductionJobs)
        .where(eq(teslaPowerhubProductionJobs.scopeId, scopeId))
        .orderBy(sql`${teslaPowerhubProductionJobs.createdAt} DESC`)
        .limit(limit)
  );
}

/**
 * Atomic claim. Mirrors `claimDashboardCsvExportJob` with one
 * difference: stamps `runnerVersion` on claim so a re-claim by a
 * newer worker version updates the row's version marker (used by
 * the deploy-verification recipe).
 */
export async function claimTeslaPowerhubProductionJob(
  scopeId: string,
  id: string,
  claimedBy: string,
  staleClaimBefore: Date,
  runnerVersion: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "claim tesla powerhub production job",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({
          status: "running",
          claimedBy,
          claimedAt: now,
          startedAt: now,
          runnerVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id),
            or(
              eq(teslaPowerhubProductionJobs.status, "queued"),
              and(
                eq(teslaPowerhubProductionJobs.status, "running"),
                lt(teslaPowerhubProductionJobs.claimedAt, staleClaimBefore)
              )
            )
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Heartbeat — bump `claimedAt` to now while the worker is alive.
 * Returns `false` when the caller's claim was lost (worker should
 * stop issuing further DB writes; the calling site handles the
 * orphaned upload artifact, if any).
 */
export async function refreshTeslaPowerhubProductionJobClaim(
  scopeId: string,
  id: string,
  claimedBy: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "refresh tesla powerhub production job claim",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({ claimedAt: now, updatedAt: now })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id),
            eq(teslaPowerhubProductionJobs.claimedBy, claimedBy),
            eq(teslaPowerhubProductionJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Update progress while running. Caller debounces (writes every
 * ~5 s, not every onProgress tick) to keep the DB write rate
 * bounded. Predicated on `claimedBy` so a stale worker can't
 * overwrite a re-claimer's progress; returns `false` when the
 * predicate misses.
 */
export async function updateTeslaPowerhubProductionJobProgress(
  scopeId: string,
  id: string,
  claimedBy: string,
  progress: unknown
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "update tesla powerhub production job progress",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({ progressJson: progress as never, updatedAt: now })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id),
            eq(teslaPowerhubProductionJobs.claimedBy, claimedBy),
            eq(teslaPowerhubProductionJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running job as `completed`. Writes the result JSON blob,
 * a final progress snapshot, and `finishedAt`. Cross-process
 * safety: only applies when the row's `claimedBy` still equals
 * the caller's. Returns `false` when the predicate misses; caller
 * MUST handle that branch (no retry, no result re-write).
 */
export async function completeTeslaPowerhubProductionJobSuccess(
  scopeId: string,
  id: string,
  claimedBy: string,
  fields: {
    resultJson: string;
    finalProgress: unknown;
  }
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete tesla powerhub production job (success)",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({
          status: "completed",
          finishedAt: now,
          resultJson: fields.resultJson,
          progressJson: fields.finalProgress as never,
          errorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id),
            eq(teslaPowerhubProductionJobs.claimedBy, claimedBy),
            eq(teslaPowerhubProductionJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running job as `failed`. Writes `errorMessage`,
 * `finishedAt`, and a final progress snapshot. Same cross-process
 * safety as `completeTeslaPowerhubProductionJobSuccess`.
 */
export async function completeTeslaPowerhubProductionJobFailure(
  scopeId: string,
  id: string,
  claimedBy: string,
  fields: {
    errorMessage: string;
    finalProgress: unknown;
  }
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete tesla powerhub production job (failure)",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({
          status: "failed",
          finishedAt: now,
          errorMessage: fields.errorMessage,
          progressJson: fields.finalProgress as never,
          updatedAt: now,
        })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.scopeId, scopeId),
            eq(teslaPowerhubProductionJobs.id, id),
            eq(teslaPowerhubProductionJobs.claimedBy, claimedBy),
            eq(teslaPowerhubProductionJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark stale-claim `running` rows as `failed`. Sweeper helper
 * called periodically (and opportunistically on each status
 * read). Identical semantics to the dashboardCsvExportJobs
 * stale-sweep — the only difference is the table and the
 * "failed" error message text.
 */
export async function failStaleTeslaPowerhubProductionJobs(
  staleClaimBefore: Date
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const result = await withDbRetry(
    "fail stale tesla powerhub production jobs",
    async () =>
      db
        .update(teslaPowerhubProductionJobs)
        .set({
          status: "failed",
          finishedAt: now,
          errorMessage:
            "stale claim — Tesla Powerhub production worker did not complete the job",
          updatedAt: now,
        })
        .where(
          and(
            eq(teslaPowerhubProductionJobs.status, "running"),
            lt(teslaPowerhubProductionJobs.claimedAt, staleClaimBefore)
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Delete terminal jobs (`completed` / `failed`) whose
 * `finishedAt` is older than `olderThan`. Returns the deleted rows
 * so the caller can fire `storageDelete` on any artifact URLs (no
 * such URLs exist today — Tesla results are inline JSON — but the
 * shape mirrors dashboardCsvExportJobs in case future result
 * payloads grow large enough to warrant blob storage).
 */
export async function pruneTerminalTeslaPowerhubProductionJobs(
  olderThan: Date
): Promise<TeslaPowerhubProductionJobRow[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "prune terminal tesla powerhub production jobs",
    async () => {
      const doomed = await db
        .select()
        .from(teslaPowerhubProductionJobs)
        .where(
          and(
            or(
              eq(teslaPowerhubProductionJobs.status, "completed"),
              eq(teslaPowerhubProductionJobs.status, "failed")
            ),
            lt(teslaPowerhubProductionJobs.finishedAt, olderThan)
          )
        );
      if (doomed.length === 0) return [];
      const ids = doomed.map((r) => r.id);
      await db
        .delete(teslaPowerhubProductionJobs)
        .where(
          sql`${teslaPowerhubProductionJobs.id} IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `
          )})`
        );
      return doomed;
    }
  );
}

/**
 * Drizzle's MySQL UPDATE returns an array whose first element is
 * an OkPacket-shaped object containing `affectedRows`. The shape
 * isn't exposed in `@drizzle-orm`'s types as a discriminated
 * union, so we narrow defensively: any non-number result counts
 * as zero affected rows. Mirrors the same helper in
 * `server/db/dashboardCsvExportJobs.ts`.
 */
function getAffectedRows(result: unknown): number {
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as { affectedRows?: unknown };
    if (typeof first?.affectedRows === "number") return first.affectedRows;
  }
  if (result && typeof result === "object" && "affectedRows" in result) {
    const affected = (result as { affectedRows?: unknown }).affectedRows;
    if (typeof affected === "number") return affected;
  }
  return 0;
}
