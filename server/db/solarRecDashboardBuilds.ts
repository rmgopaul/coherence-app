/**
 * Solar REC dashboard build jobs — database helpers (Phase 2 PR-A,
 * the OOM-rebuild keystone).
 *
 * Backs the DB-backed registry that PR-B onwards will use to drive
 * the per-scope dashboard fact-table builds (replacements for the
 * 5 oversize-allowlist procedures listed in
 * `docs/execution-plan.md`). PR-A is **schema + helpers only** —
 * no runner, no tRPC procs. The table is unwritten and unread at
 * runtime until PR-B lands.
 *
 * Mirrors `server/db/dashboardCsvExportJobs.ts` 1:1 for
 * cross-process safety semantics:
 *   - Every read is scope-aware: callers pass `scopeId` and the
 *     WHERE clause filters by it, so a malicious id-from-elsewhere
 *     reads as "not found" rather than touching another scope's
 *     row.
 *   - Atomic queued → running claim via `UPDATE … WHERE`-predicated
 *     transition; mutual exclusion is provided by row locks during
 *     the WHERE scan + SET, so concurrent claim attempts serialize
 *     and only one passes the predicate.
 *   - Heartbeat (`refreshClaim`) prevents the stale-claim sweeper
 *     from killing legitimately-long builds.
 *   - Stale-claim re-claim (`claimBuild` includes `or(running AND
 *     claimedAt < staleClaimBefore)` in the predicate) lets a new
 *     worker pick up a row whose original claimer died between
 *     claim and completion.
 *   - Completion writes are predicated on `claimedBy = ours` so a
 *     worker that lost its claim cannot silently overwrite the new
 *     claimer's terminal state.
 *
 * Error shape on `failed`: `errorMessage` carries whatever
 * exception bubbled out of the per-fact-table builder. The runner
 * (PR-B+) records the message; this module just stores it.
 */
import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { lt, or } from "drizzle-orm";
import {
  solarRecDashboardBuilds,
  type SolarRecDashboardBuild,
  type InsertSolarRecDashboardBuild,
} from "../../drizzle/schema";

/**
 * Insert a freshly-queued build job. Caller provides `id` and the
 * runtime metadata (scopeId, createdBy, inputVersionsJson,
 * runnerVersion); status defaults to "queued".
 *
 * **Throws** if the DB is unavailable. The contract makes this
 * registry mandatory — silently returning would let the build
 * runner hand the client a `buildId` for a row that doesn't
 * exist, and a subsequent poll would surface `notFound` (which is
 * terminal). Throwing surfaces the real cause through the
 * mutation rejection path. Mirrors the
 * `insertDashboardCsvExportJob` rationale.
 */
export async function insertSolarRecDashboardBuild(
  entry: InsertSolarRecDashboardBuild
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error(
      "solarRecDashboardBuilds: database unavailable — cannot insert build job"
    );
  }
  await withDbRetry("insert solar rec dashboard build", async () => {
    await db.insert(solarRecDashboardBuilds).values(entry);
  });
}

/**
 * Heartbeat refresh: bump `claimedAt` to now while the worker is
 * still alive and running. Without a heartbeat, a healthy long
 * build that exceeds the stale-claim window (5 min in the
 * companion sweeper) would be flipped to `failed` by the sweeper
 * while still running. Cold-cache fact-table builds against a
 * busy multi-tenant scope can legitimately exceed 5 min when 4
 * fact tables build in sequence.
 *
 * Returns `true` iff this caller still owns the claim AND the row
 * is still `running`. Worker should treat `false` as "abort
 * gracefully — another owner is responsible for this row now"
 * and STOP issuing further DB writes.
 */
export async function refreshSolarRecDashboardBuildClaim(
  scopeId: string,
  id: string,
  claimedBy: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "refresh solar rec dashboard build claim",
    async () =>
      db
        .update(solarRecDashboardBuilds)
        .set({
          claimedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(solarRecDashboardBuilds.scopeId, scopeId),
            eq(solarRecDashboardBuilds.id, id),
            eq(solarRecDashboardBuilds.claimedBy, claimedBy),
            eq(solarRecDashboardBuilds.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Fetch a single build job for a scope. Returns `null` when:
 *   - the row doesn't exist, OR
 *   - the row exists for a different scope (cross-scope safety).
 * Callers should treat `null` as 404 — the public proc reports
 * "notFound" without leaking whether the id-elsewhere exists.
 */
export async function getSolarRecDashboardBuild(
  scopeId: string,
  id: string
): Promise<SolarRecDashboardBuild | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get solar rec dashboard build", async () =>
    db
      .select()
      .from(solarRecDashboardBuilds)
      .where(
        and(
          eq(solarRecDashboardBuilds.scopeId, scopeId),
          eq(solarRecDashboardBuilds.id, id)
        )
      )
      .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Atomic claim. Transitions a build from `queued → running` (or
 * re-claims a `running` row whose `claimedAt` is older than
 * `staleClaimBefore` — process restart / OOM recovery). Sets
 * `claimedBy` + `claimedAt` + `startedAt` + `runnerVersion` in the
 * same UPDATE so two workers racing for the same job both succeed
 * only on exactly one of them.
 *
 * Returns `true` iff this caller now owns the claim. The caller
 * should re-fetch the row via `getSolarRecDashboardBuild` to read
 * the canonical state.
 */
export async function claimSolarRecDashboardBuild(
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
    "claim solar rec dashboard build",
    async () =>
      db
        .update(solarRecDashboardBuilds)
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
            eq(solarRecDashboardBuilds.scopeId, scopeId),
            eq(solarRecDashboardBuilds.id, id),
            or(
              eq(solarRecDashboardBuilds.status, "queued"),
              and(
                eq(solarRecDashboardBuilds.status, "running"),
                lt(solarRecDashboardBuilds.claimedAt, staleClaimBefore)
              )
            )
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running build as `succeeded`. Cross-process safety: only
 * applies when the row's `claimedBy` still equals the caller's —
 * if another worker re-claimed (because our claim went stale),
 * this UPDATE no-ops and returns `false`. Caller MUST handle the
 * `false` case by NOT writing derived rows again (those went into
 * the fact tables already) but ALSO not retrying.
 */
export async function completeSolarRecDashboardBuildSuccess(
  scopeId: string,
  id: string,
  claimedBy: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete solar rec dashboard build (success)",
    async () =>
      db
        .update(solarRecDashboardBuilds)
        .set({
          status: "succeeded",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(solarRecDashboardBuilds.scopeId, scopeId),
            eq(solarRecDashboardBuilds.id, id),
            eq(solarRecDashboardBuilds.claimedBy, claimedBy),
            eq(solarRecDashboardBuilds.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Mark a running build as `failed`. Same cross-process safety as
 * `completeSolarRecDashboardBuildSuccess`.
 */
export async function completeSolarRecDashboardBuildFailure(
  scopeId: string,
  id: string,
  claimedBy: string,
  errorMessage: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "complete solar rec dashboard build (failure)",
    async () =>
      db
        .update(solarRecDashboardBuilds)
        .set({
          status: "failed",
          completedAt: now,
          errorMessage,
          updatedAt: now,
        })
        .where(
          and(
            eq(solarRecDashboardBuilds.scopeId, scopeId),
            eq(solarRecDashboardBuilds.id, id),
            eq(solarRecDashboardBuilds.claimedBy, claimedBy),
            eq(solarRecDashboardBuilds.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Update progress on a running build. Cross-process safety: only
 * applies when the row's `claimedBy` still equals the caller's.
 * `progressJson` is a free-form snapshot the worker writes
 * periodically (debounced, e.g. every ~5 s, so the DB row update
 * rate stays bounded). On stale claim → no-op + returns false.
 *
 * Mirrors the `teslaPowerhubProductionJobs` progress-update
 * pattern.
 */
export async function updateSolarRecDashboardBuildProgress(
  scopeId: string,
  id: string,
  claimedBy: string,
  progressJson: unknown
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await withDbRetry(
    "update solar rec dashboard build progress",
    async () =>
      db
        .update(solarRecDashboardBuilds)
        .set({
          progressJson,
          updatedAt: now,
        })
        .where(
          and(
            eq(solarRecDashboardBuilds.scopeId, scopeId),
            eq(solarRecDashboardBuilds.id, id),
            eq(solarRecDashboardBuilds.claimedBy, claimedBy),
            eq(solarRecDashboardBuilds.status, "running")
          )
        )
  );
  return getAffectedRows(result) === 1;
}

/**
 * Delete terminal builds (`succeeded` / `failed`) whose
 * `completedAt` is older than `olderThan`. Returns the deleted
 * rows for observability — the caller (the periodic sweeper)
 * doesn't need to do anything with them, but logging the deleted
 * count + scope distribution is useful for tracking churn.
 *
 * Two-step (SELECT then DELETE by primary-key-set) avoids TOCTOU
 * between SELECT and DELETE.
 */
export async function pruneTerminalSolarRecDashboardBuilds(
  olderThan: Date
): Promise<SolarRecDashboardBuild[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "prune terminal solar rec dashboard builds",
    async () => {
      const doomed = await db
        .select()
        .from(solarRecDashboardBuilds)
        .where(
          and(
            or(
              eq(solarRecDashboardBuilds.status, "succeeded"),
              eq(solarRecDashboardBuilds.status, "failed")
            ),
            lt(solarRecDashboardBuilds.completedAt, olderThan)
          )
        );
      if (doomed.length === 0) return [];
      const ids = doomed.map((r) => r.id);
      await db
        .delete(solarRecDashboardBuilds)
        .where(
          sql`${solarRecDashboardBuilds.id} IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `
          )})`
        );
      return doomed;
    }
  );
}

/**
 * Mark stale-claim `running` rows as `failed`. A "stale claim" is
 * a `running` row whose `claimedAt` predates `staleClaimBefore` —
 * typically because the worker process died / restarted between
 * claim and completion. Without this sweep, those rows would
 * block forever and fail at TTL.
 *
 * Returns the count for observability. The rows themselves are
 * not returned because the caller (the periodic sweeper) doesn't
 * need to do anything with them — derived fact rows the worker
 * may have partially written are scope-keyed and a successful
 * re-build will overwrite them.
 */
export async function failStaleSolarRecDashboardBuilds(
  staleClaimBefore: Date
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const result = await withDbRetry(
    "fail stale solar rec dashboard builds",
    async () =>
      db
        .update(solarRecDashboardBuilds)
        .set({
          status: "failed",
          completedAt: now,
          errorMessage:
            "stale claim — worker process did not complete the build",
          updatedAt: now,
        })
        .where(
          and(
            eq(solarRecDashboardBuilds.status, "running"),
            lt(solarRecDashboardBuilds.claimedAt, staleClaimBefore)
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
