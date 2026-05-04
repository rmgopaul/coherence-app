/**
 * Dashboard CSV export jobs — database helpers (Phase 6 PR-B).
 *
 * Backs the DB-backed registry that replaces the in-memory `Map`
 * shipped in PR #346. The service layer
 * (`server/services/solar/dashboardCsvExportJobs.ts`) consumes
 * these helpers; the dashboard router's tRPC procs
 * (`startDashboardCsvExport`, `getDashboardCsvExportJobStatus`)
 * consume the service layer.
 *
 * Every read + write here is scope-aware: callers pass `scopeId`
 * and the WHERE clause filters by it, so a malicious id-from-
 * elsewhere reads as "not found" rather than touching another
 * scope's row. Writes also sanity-check the claim on update
 * (`claimedBy = ?` predicate) so a worker that lost its claim
 * (e.g. process restarted, another worker re-claimed) cannot
 * silently overwrite the new claim's progress.
 */
import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { lt, or } from "drizzle-orm";
import {
  dashboardCsvExportJobs,
  type DashboardCsvExportJob,
  type InsertDashboardCsvExportJob,
} from "../../drizzle/schema";

/**
 * Insert a freshly-queued export job. Caller provides `id` and the
 * runtime metadata; status defaults to "queued".
 *
 * **Throws** if the DB is unavailable. The Phase 6 PR-B contract
 * makes this registry mandatory — silently returning would let
 * `startCsvExportJob` hand the client a `jobId` for a row that
 * doesn't exist, and a subsequent poll would surface `notFound`
 * (which is terminal in the new contract). The user-visible
 * symptom would be a generic "failed" toast detached from the
 * actual cause. Throwing surfaces the real cause through the
 * mutation rejection path.
 */
export async function insertDashboardCsvExportJob(
  entry: InsertDashboardCsvExportJob
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardCsvExportJobs: database unavailable — cannot insert export job"
    );
  }
  await withDbRetry("insert dashboard csv export job", async () => {
    await db.insert(dashboardCsvExportJobs).values(entry);
  });
}

/**
 * Heartbeat refresh: bump `claimedAt` to now while the worker is
 * still alive and running. Codex P1 finding (Phase 6 PR-B
 * follow-up): without a heartbeat, a healthy long export that
 * exceeds the stale-claim window (5 min) would be flipped to
 * `failed` by the sweeper while still running. Cold-cache
 * aggregator runs on the change-of-ownership tile can legitimately
 * exceed 5 min on a busy multi-tenant scope.
 *
 * Returns `true` iff this caller still owns the claim AND the row
 * is still `running`. Worker should treat `false` as "abort
 * gracefully — another owner is responsible for this row now"
 * and STOP issuing further DB writes (storage put may have
 * already happened; the calling site handles that artifact
 * separately).
 */
export async function refreshDashboardCsvExportJobClaim(
  scopeId: string,
  id: string,
  claimedBy: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "refresh dashboard csv export job claim",
    async () =>
      db
        .update(dashboardCsvExportJobs)
        .set({
          claimedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dashboardCsvExportJobs.scopeId, scopeId),
            eq(dashboardCsvExportJobs.id, id),
            eq(dashboardCsvExportJobs.claimedBy, claimedBy),
            eq(dashboardCsvExportJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Fetch a single export job for a scope. Returns `null` when:
 *   - the row doesn't exist, OR
 *   - the row exists for a different scope (cross-scope safety).
 * Callers should treat `null` as 404 — the public proc reports
 * "notFound" without leaking whether the id-elsewhere exists.
 */
export async function getDashboardCsvExportJob(
  scopeId: string,
  id: string
): Promise<DashboardCsvExportJob | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get dashboard csv export job", async () =>
    db
      .select()
      .from(dashboardCsvExportJobs)
      .where(
        and(
          eq(dashboardCsvExportJobs.scopeId, scopeId),
          eq(dashboardCsvExportJobs.id, id)
        )
      )
      .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Atomic claim. Transitions a job from `queued → running` (or
 * re-claims a `running` row whose `claimedAt` is older than
 * `staleClaimBefore` — process restart / OOM recovery). Sets
 * `claimedBy` + `claimedAt` + `startedAt` in the same UPDATE so
 * two workers racing for the same job both succeed only on
 * exactly one of them.
 *
 * Returns `true` iff this caller now owns the claim. The caller
 * should re-fetch the row via `getDashboardCsvExportJob` to read
 * the canonical state (the UPDATE may have been issued without
 * an existing-row guard if scope/id mismatched).
 *
 * The atomicity of UPDATE ... WHERE on a single row gives us the
 * mutual exclusion: TiDB applies row locks during the WHERE
 * scan + SET, so concurrent claim attempts serialize and only
 * one passes the predicate.
 */
export async function claimDashboardCsvExportJob(
  scopeId: string,
  id: string,
  claimedBy: string,
  staleClaimBefore: Date
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "claim dashboard csv export job",
    async () =>
      db
        .update(dashboardCsvExportJobs)
        .set({
          status: "running",
          claimedBy,
          claimedAt: now,
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dashboardCsvExportJobs.scopeId, scopeId),
            eq(dashboardCsvExportJobs.id, id),
            or(
              eq(dashboardCsvExportJobs.status, "queued"),
              and(
                eq(dashboardCsvExportJobs.status, "running"),
                lt(dashboardCsvExportJobs.claimedAt, staleClaimBefore)
              )
            )
          )
        )
  );
  // Drizzle's MySQL UPDATE returns a result whose first element is
  // an OkPacket-shaped object with `affectedRows`. We only care
  // whether any row matched the predicate.
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running job as `succeeded`. Cross-process safety: only
 * applies when the row's `claimedBy` still equals the caller's
 * — if another worker re-claimed (because our claim went stale),
 * this UPDATE no-ops and we return `false`. Caller MUST handle
 * the `false` case by NOT writing the artifact again (storage put
 * already happened) but ALSO not retrying.
 */
export async function completeDashboardCsvExportJobSuccess(
  scopeId: string,
  id: string,
  claimedBy: string,
  fields: {
    fileName: string | null;
    artifactUrl: string | null;
    rowCount: number;
    csvBytes: number;
  }
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete dashboard csv export job (success)",
    async () =>
      db
        .update(dashboardCsvExportJobs)
        .set({
          status: "succeeded",
          completedAt: now,
          fileName: fields.fileName,
          artifactUrl: fields.artifactUrl,
          rowCount: fields.rowCount,
          csvBytes: fields.csvBytes,
          updatedAt: now,
        })
        .where(
          and(
            eq(dashboardCsvExportJobs.scopeId, scopeId),
            eq(dashboardCsvExportJobs.id, id),
            eq(dashboardCsvExportJobs.claimedBy, claimedBy),
            eq(dashboardCsvExportJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running job as `failed`. Same cross-process safety as
 * `completeDashboardCsvExportJobSuccess`.
 */
export async function completeDashboardCsvExportJobFailure(
  scopeId: string,
  id: string,
  claimedBy: string,
  errorMessage: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete dashboard csv export job (failure)",
    async () =>
      db
        .update(dashboardCsvExportJobs)
        .set({
          status: "failed",
          completedAt: now,
          errorMessage,
          updatedAt: now,
        })
        .where(
          and(
            eq(dashboardCsvExportJobs.scopeId, scopeId),
            eq(dashboardCsvExportJobs.id, id),
            eq(dashboardCsvExportJobs.claimedBy, claimedBy),
            eq(dashboardCsvExportJobs.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Delete terminal jobs (`succeeded` / `failed`) whose
 * `completedAt` is older than `olderThan`. Returns the deleted
 * rows so the caller can fire `storageDelete` on each artifact
 * URL (artifacts outlive the row by design — DB cleanup is
 * cheaper than storage cleanup, and we don't want a slow
 * storage delete to block the prune sweep).
 *
 * Returns rows BEFORE the DELETE so callers don't need a
 * separate read. Defensive: a TTL prune that ran but lost the
 * row list would leak orphan storage. Two-step (SELECT then
 * DELETE) is cheap because the index `(completedAt)` makes both
 * narrow.
 */
export async function pruneTerminalDashboardCsvExportJobs(
  olderThan: Date
): Promise<DashboardCsvExportJob[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "prune terminal dashboard csv export jobs",
    async () => {
      const doomed = await db
        .select()
        .from(dashboardCsvExportJobs)
        .where(
          and(
            or(
              eq(dashboardCsvExportJobs.status, "succeeded"),
              eq(dashboardCsvExportJobs.status, "failed")
            ),
            lt(dashboardCsvExportJobs.completedAt, olderThan)
          )
        );
      if (doomed.length === 0) return [];
      const ids = doomed.map((r) => r.id);
      // Delete by primary-key-set rather than re-running the
      // predicate to avoid TOCTOU between SELECT and DELETE.
      await db
        .delete(dashboardCsvExportJobs)
        .where(sql`${dashboardCsvExportJobs.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      return doomed;
    }
  );
}

/**
 * Mark stale-claim `running` rows as `failed`. A "stale claim"
 * is a `running` row whose `claimedAt` predates
 * `staleClaimBefore` — typically because the worker process
 * died / restarted between claim and completion. Without this
 * sweep, those rows would block forever and fail at TTL.
 *
 * Returns the count for observability; the rows themselves are
 * not returned because the caller (the periodic sweeper) doesn't
 * need to do anything with them — the artifact (if any) was
 * never written successfully and there's nothing to clean up.
 */
export async function failStaleDashboardCsvExportJobs(
  staleClaimBefore: Date
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const result = await withDbRetry(
    "fail stale dashboard csv export jobs",
    async () =>
      db
        .update(dashboardCsvExportJobs)
        .set({
          status: "failed",
          completedAt: now,
          errorMessage:
            "stale claim — worker process did not complete the job",
          updatedAt: now,
        })
        .where(
          and(
            eq(dashboardCsvExportJobs.status, "running"),
            lt(dashboardCsvExportJobs.claimedAt, staleClaimBefore)
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Drizzle's MySQL UPDATE returns an array whose first element is
 * an OkPacket-shaped object containing `affectedRows`. The shape
 * isn't exposed in `@drizzle-orm`'s types as a discriminated
 * union, so we narrow defensively: any non-number result counts
 * as zero affected rows.
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
