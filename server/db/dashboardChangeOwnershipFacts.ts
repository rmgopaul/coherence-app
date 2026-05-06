/**
 * Solar REC dashboard change-of-ownership facts — DB helpers
 * (Phase 2 PR-D-1, the second derived fact table).
 *
 * Backs the `solarRecDashboardChangeOwnershipFacts` table that
 * PR-D-2 will populate via the build runner. PR-D-3 will add the
 * paginated read proc that the ChangeOwnershipTab migrates onto,
 * retiring the per-row `ChangeOwnershipExportRow[]` payload from
 * `getDashboardChangeOwnership`'s response (~19 MB on prod, the
 * largest of the three remaining oversize-allowlist entries).
 *
 * PR-D-1 is helpers ONLY — no caller in production wires these in
 * yet. The table is empty until PR-D-2 ships.
 *
 * Three orthogonal usage patterns mirror `dashboardMonitoringDetailsFacts.ts`:
 *   1. **Bulk write** (`upsertChangeOwnershipFacts`) — PR-D-2's
 *      builder calls this once per build with the N rows it
 *      derived from the system snapshot.
 *   2. **Orphan sweep** (`deleteOrphanedChangeOwnershipFacts`) —
 *      after the bulk write, removes rows from PRIOR builds.
 *   3. **Filter + paginated read** (`getChangeOwnershipFactsPage`) —
 *      PR-D-3's proc returns one page at a time, optionally
 *      filtered by `changeOwnershipStatus`. Cursor by `systemKey`.
 *
 * Key difference from monitoringDetails: this fact table has a
 * `changeOwnershipStatus` filter axis (the tab's primary control
 * is "show me X status"), so the paginated read accepts an
 * optional status argument and the schema includes a covering
 * index on `(scopeId, changeOwnershipStatus)`.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { gt, inArray, ne } from "drizzle-orm";
import {
  solarRecDashboardChangeOwnershipFacts,
  type SolarRecDashboardChangeOwnershipFact,
  type InsertSolarRecDashboardChangeOwnershipFact,
} from "../../drizzle/schema";

/**
 * Bulk UPSERT N fact rows. Each row's PK is
 * `(scopeId, systemKey)`; on conflict the existing row's mutable
 * columns are overwritten and `updatedAt` bumps.
 *
 * **Throws** if the DB is unavailable. Same rationale as
 * `upsertMonitoringDetailsFacts` — the runner mark a build
 * `succeeded` while no rows were written would silently corrupt
 * the data plane.
 *
 * Chunked at 500 rows / INSERT for TiDB parameter-limit headroom
 * (changeOwnership rows have ~22 columns; 500 × 22 = 11k params,
 * well under the ~65k cap).
 */
export async function upsertChangeOwnershipFacts(
  rows: InsertSolarRecDashboardChangeOwnershipFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardChangeOwnershipFacts: database unavailable — cannot upsert facts"
    );
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withDbRetry(
      "upsert dashboard change-ownership facts",
      async () => {
        await db
          .insert(solarRecDashboardChangeOwnershipFacts)
          .values(chunk)
          .onDuplicateKeyUpdate({
            set: {
              systemName: sql`VALUES(\`systemName\`)`,
              systemId: sql`VALUES(\`systemId\`)`,
              trackingSystemRefId: sql`VALUES(\`trackingSystemRefId\`)`,
              installedKwAc: sql`VALUES(\`installedKwAc\`)`,
              contractType: sql`VALUES(\`contractType\`)`,
              contractStatusText: sql`VALUES(\`contractStatusText\`)`,
              contractedDate: sql`VALUES(\`contractedDate\`)`,
              zillowStatus: sql`VALUES(\`zillowStatus\`)`,
              zillowSoldDate: sql`VALUES(\`zillowSoldDate\`)`,
              latestReportingDate: sql`VALUES(\`latestReportingDate\`)`,
              changeOwnershipStatus: sql`VALUES(\`changeOwnershipStatus\`)`,
              ownershipStatus: sql`VALUES(\`ownershipStatus\`)`,
              isReporting: sql`VALUES(\`isReporting\`)`,
              isTerminated: sql`VALUES(\`isTerminated\`)`,
              isTransferred: sql`VALUES(\`isTransferred\`)`,
              hasChangedOwnership: sql`VALUES(\`hasChangedOwnership\`)`,
              totalContractAmount: sql`VALUES(\`totalContractAmount\`)`,
              contractedValue: sql`VALUES(\`contractedValue\`)`,
              buildId: sql`VALUES(\`buildId\`)`,
              // updatedAt auto-bumps via the schema's onUpdateNow.
            },
          });
      }
    );
  }
}

/**
 * Delete fact rows for a scope whose `buildId` doesn't match the
 * current build — orphan sweep. Returns affected-row count for
 * observability.
 */
export async function deleteOrphanedChangeOwnershipFacts(
  scopeId: string,
  currentBuildId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "delete orphaned dashboard change-ownership facts",
    async () =>
      db
        .delete(solarRecDashboardChangeOwnershipFacts)
        .where(
          and(
            eq(solarRecDashboardChangeOwnershipFacts.scopeId, scopeId),
            ne(
              solarRecDashboardChangeOwnershipFacts.buildId,
              currentBuildId
            )
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Fetch a paginated page of fact rows for a scope, optionally
 * filtered by `changeOwnershipStatus`. Cursor is `systemKey`;
 * rows are sorted by `systemKey ASC` so the page boundary is
 * stable across requests.
 *
 * `status` is the primary filter axis the ChangeOwnershipTab
 * uses; the covering index `(scopeId, changeOwnershipStatus)`
 * makes status-filtered reads efficient. Without a status filter,
 * the PK index `(scopeId, systemKey)` covers the unfiltered scan.
 *
 * `limit` is bounded server-side. PR-D-3's proc layer will
 * additionally clamp at the wire-payload contract.
 */
export async function getChangeOwnershipFactsPage(
  scopeId: string,
  options: {
    cursorAfter?: string | null;
    limit: number;
    status?: string | null;
  }
): Promise<SolarRecDashboardChangeOwnershipFact[]> {
  const db = await getDb();
  if (!db) return [];
  const { cursorAfter, limit, status } = options;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));

  const conditions = [
    eq(solarRecDashboardChangeOwnershipFacts.scopeId, scopeId),
  ];
  if (cursorAfter) {
    conditions.push(
      gt(solarRecDashboardChangeOwnershipFacts.systemKey, cursorAfter)
    );
  }
  if (status) {
    conditions.push(
      eq(
        solarRecDashboardChangeOwnershipFacts.changeOwnershipStatus,
        status
      )
    );
  }

  return withDbRetry(
    "get dashboard change-ownership facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardChangeOwnershipFacts)
        .where(and(...conditions))
        .orderBy(solarRecDashboardChangeOwnershipFacts.systemKey)
        .limit(safeLimit)
  );
}

/**
 * Fetch fact rows for a specific set of system keys. Used by the
 * "details for these systems" lookup pattern — e.g., a tab that
 * has a filtered subset of systems and needs their change-of-
 * ownership state without paginating the whole scope.
 *
 * `systemKeys` is bounded by the caller; this helper just
 * dispatches the IN-list. PR-D-3's proc layer will cap at e.g.
 * 1000 keys.
 *
 * Returns an empty array on `systemKeys.length === 0` to avoid
 * an empty IN-list query (TiDB rejects `WHERE x IN ()`).
 */
export async function getChangeOwnershipFactsBySystemKeys(
  scopeId: string,
  systemKeys: string[]
): Promise<SolarRecDashboardChangeOwnershipFact[]> {
  if (systemKeys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard change-ownership facts by keys",
    async () =>
      db
        .select()
        .from(solarRecDashboardChangeOwnershipFacts)
        .where(
          and(
            eq(solarRecDashboardChangeOwnershipFacts.scopeId, scopeId),
            inArray(
              solarRecDashboardChangeOwnershipFacts.systemKey,
              systemKeys
            )
          )
        )
  );
}

/**
 * Count fact rows for a scope, optionally narrowed to a single
 * `changeOwnershipStatus`. Useful for:
 *   - PR-D-2's orchestrator logging "wrote N facts in this build."
 *   - PR-D-3's proc returning a `totalCount` alongside the first
 *     page so the client can render "N systems in status X" without
 *     paginating to the end.
 *   - The Phase 1 dashboard guardrails / observability surface.
 */
export async function getChangeOwnershipFactsCount(
  scopeId: string,
  options?: { status?: string | null }
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [
    eq(solarRecDashboardChangeOwnershipFacts.scopeId, scopeId),
  ];
  if (options?.status) {
    conditions.push(
      eq(
        solarRecDashboardChangeOwnershipFacts.changeOwnershipStatus,
        options.status
      )
    );
  }
  const rows = await withDbRetry(
    "count dashboard change-ownership facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardChangeOwnershipFacts)
        .where(and(...conditions))
  );
  const first = rows[0];
  if (!first) return 0;
  const n = first.n;
  if (typeof n === "number") return n;
  if (typeof n === "string") {
    const parsed = Number(n);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Drizzle's MySQL DELETE returns an array whose first element is
 * an OkPacket-shaped object containing `affectedRows`. Mirrors
 * the helper in companion modules.
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
