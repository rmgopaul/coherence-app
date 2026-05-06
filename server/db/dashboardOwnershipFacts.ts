/**
 * Solar REC dashboard ownership facts — DB helpers
 * (Phase 2 PR-E-1, the third derived fact table).
 *
 * Backs the `solarRecDashboardOwnershipFacts` table that PR-E-2
 * will populate via the build runner. PR-E-3 will add the
 * paginated read proc the OverviewTab migrates onto, retiring the
 * per-row `OwnershipOverviewExportRow[]` payload from
 * `getDashboardOverviewSummary`'s response (~5-15 MB on prod).
 *
 * PR-E-1 is helpers ONLY — no caller wires these in yet.
 *
 * Matches the proven pattern from PR-C-1 (monitoringDetails) +
 * PR-D-1 (changeOwnership) with two filter axes for the OverviewTab:
 *   - `ownershipStatus` — primary filter (Transferred / Not
 *     Transferred / Terminated × Reporting / Not Reporting)
 *   - `source` — Matched System vs Part II Unmatched toggle
 *
 * Both filter axes can be combined; reads filtering on neither
 * fall back to the PK index `(scopeId, systemKey)` for an
 * unfiltered scoped scan.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { gt, inArray, ne } from "drizzle-orm";
import {
  solarRecDashboardOwnershipFacts,
  type SolarRecDashboardOwnershipFact,
  type InsertSolarRecDashboardOwnershipFact,
} from "../../drizzle/schema";

/**
 * Bulk UPSERT N fact rows. Each row's PK is `(scopeId, systemKey)`;
 * on conflict the existing row's mutable columns are overwritten
 * and `updatedAt` bumps.
 *
 * **Throws** if the DB is unavailable. Same rationale as the
 * companion modules — silently returning would let the runner
 * mark a build `succeeded` while no rows were written.
 *
 * Chunked at 500 rows / INSERT for TiDB parameter-limit headroom
 * (ownership rows have ~22 columns; 500 × 22 = 11k params).
 */
export async function upsertOwnershipFacts(
  rows: InsertSolarRecDashboardOwnershipFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardOwnershipFacts: database unavailable — cannot upsert facts"
    );
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withDbRetry(
      "upsert dashboard ownership facts",
      async () => {
        await db
          .insert(solarRecDashboardOwnershipFacts)
          .values(chunk)
          .onDuplicateKeyUpdate({
            set: {
              part2ProjectName: sql`VALUES(\`part2ProjectName\`)`,
              part2ApplicationId: sql`VALUES(\`part2ApplicationId\`)`,
              part2SystemId: sql`VALUES(\`part2SystemId\`)`,
              part2TrackingId: sql`VALUES(\`part2TrackingId\`)`,
              source: sql`VALUES(\`source\`)`,
              systemName: sql`VALUES(\`systemName\`)`,
              systemId: sql`VALUES(\`systemId\`)`,
              stateApplicationRefId: sql`VALUES(\`stateApplicationRefId\`)`,
              trackingSystemRefId: sql`VALUES(\`trackingSystemRefId\`)`,
              ownershipStatus: sql`VALUES(\`ownershipStatus\`)`,
              isReporting: sql`VALUES(\`isReporting\`)`,
              isTransferred: sql`VALUES(\`isTransferred\`)`,
              isTerminated: sql`VALUES(\`isTerminated\`)`,
              contractType: sql`VALUES(\`contractType\`)`,
              contractStatusText: sql`VALUES(\`contractStatusText\`)`,
              latestReportingDate: sql`VALUES(\`latestReportingDate\`)`,
              contractedDate: sql`VALUES(\`contractedDate\`)`,
              zillowStatus: sql`VALUES(\`zillowStatus\`)`,
              zillowSoldDate: sql`VALUES(\`zillowSoldDate\`)`,
              buildId: sql`VALUES(\`buildId\`)`,
              // updatedAt auto-bumps via onUpdateNow.
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
export async function deleteOrphanedOwnershipFacts(
  scopeId: string,
  currentBuildId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "delete orphaned dashboard ownership facts",
    async () =>
      db
        .delete(solarRecDashboardOwnershipFacts)
        .where(
          and(
            eq(solarRecDashboardOwnershipFacts.scopeId, scopeId),
            ne(
              solarRecDashboardOwnershipFacts.buildId,
              currentBuildId
            )
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Fetch a paginated page of fact rows for a scope, optionally
 * filtered by `ownershipStatus` AND/OR `source`. Cursor is
 * `systemKey`; rows are sorted by `systemKey ASC` for stable
 * pagination across requests.
 *
 * Both filter axes can be applied independently or together. The
 * covering indexes `(scopeId, ownershipStatus)` and
 * `(scopeId, source)` make either single-axis filter efficient;
 * combined filters fall back to one of the two indexes + a
 * post-index filter on the other column.
 *
 * `limit` is bounded server-side. PR-E-3's proc layer will
 * additionally clamp at the wire-payload contract.
 */
export async function getOwnershipFactsPage(
  scopeId: string,
  options: {
    cursorAfter?: string | null;
    limit: number;
    status?: string | null;
    source?: string | null;
  }
): Promise<SolarRecDashboardOwnershipFact[]> {
  const db = await getDb();
  if (!db) return [];
  const { cursorAfter, limit, status, source } = options;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));

  const conditions = [
    eq(solarRecDashboardOwnershipFacts.scopeId, scopeId),
  ];
  if (cursorAfter) {
    conditions.push(
      gt(solarRecDashboardOwnershipFacts.systemKey, cursorAfter)
    );
  }
  if (status) {
    conditions.push(
      eq(solarRecDashboardOwnershipFacts.ownershipStatus, status)
    );
  }
  if (source) {
    conditions.push(eq(solarRecDashboardOwnershipFacts.source, source));
  }

  return withDbRetry(
    "get dashboard ownership facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardOwnershipFacts)
        .where(and(...conditions))
        .orderBy(solarRecDashboardOwnershipFacts.systemKey)
        .limit(safeLimit)
  );
}

/**
 * Fetch fact rows for a specific set of system keys. Used by the
 * "details for these systems" lookup pattern. Empty keys array →
 * empty result without DB call.
 */
export async function getOwnershipFactsBySystemKeys(
  scopeId: string,
  systemKeys: string[]
): Promise<SolarRecDashboardOwnershipFact[]> {
  if (systemKeys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard ownership facts by keys",
    async () =>
      db
        .select()
        .from(solarRecDashboardOwnershipFacts)
        .where(
          and(
            eq(solarRecDashboardOwnershipFacts.scopeId, scopeId),
            inArray(
              solarRecDashboardOwnershipFacts.systemKey,
              systemKeys
            )
          )
        )
  );
}

/**
 * Count fact rows for a scope, optionally narrowed by status
 * AND/OR source. Useful for first-page totalCount + per-status
 * counts.
 */
export async function getOwnershipFactsCount(
  scopeId: string,
  options?: { status?: string | null; source?: string | null }
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [
    eq(solarRecDashboardOwnershipFacts.scopeId, scopeId),
  ];
  if (options?.status) {
    conditions.push(
      eq(
        solarRecDashboardOwnershipFacts.ownershipStatus,
        options.status
      )
    );
  }
  if (options?.source) {
    conditions.push(
      eq(solarRecDashboardOwnershipFacts.source, options.source)
    );
  }
  const rows = await withDbRetry(
    "count dashboard ownership facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardOwnershipFacts)
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
 * the companion modules.
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
