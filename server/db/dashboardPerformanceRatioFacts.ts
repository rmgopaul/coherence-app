/**
 * Solar REC dashboard performance-ratio facts — DB helpers
 * (Phase 2 PR-G-1, the fifth derived fact table).
 *
 * Backs the `solarRecDashboardPerformanceRatioFacts` table that
 * PR-G-2 will populate via the build runner. PR-G-3 will add the
 * paginated read proc that the PerformanceRatioTab migrates onto,
 * retiring the per-row `PerformanceRatioRow[]` payload from
 * `getDashboardPerformanceRatio`'s response (the legacy aggregator
 * still computes the rows on the user's request hot path, holding
 * the snapshot + 6 srDs* tables in memory; PR-G-2 moves that
 * compute into the build runner so a tab read becomes a paginated
 * query against pre-built rows).
 *
 * PR-G-1 is helpers ONLY — no caller in production wires these in
 * yet. The table is empty until PR-G-2 ships.
 *
 * Architectural shape mirrors `dashboardChangeOwnershipFacts.ts`
 * 1:1:
 *   1. **Bulk write** (`upsertPerformanceRatioFacts`) — PR-G-2's
 *      builder calls this once per build with the N rows it derived
 *      from the existing `getOrBuildPerformanceRatio` aggregator.
 *   2. **Orphan sweep** (`deleteOrphanedPerformanceRatioFacts`) —
 *      after the bulk write, removes rows from PRIOR builds.
 *   3. **Filter + paginated read** (`getPerformanceRatioFactsPage`)
 *      — PR-G-3's proc returns one page at a time, optionally
 *      filtered by `matchType` or `monitoring`. Cursor by `key`.
 *   4. **Total counts** (`getPerformanceRatioFactsCount`) — for
 *      the slim summary's `convertedReadCount`-style headline tile.
 *
 * Filter axes mirror the PerformanceRatioTab's two primary
 * controls (`matchType` and `monitoring`), each backed by a
 * covering index from PR-G-1's schema. Combining both filters
 * falls back to one of the two indexes plus an in-memory filter
 * on the other column — same pattern PR-D-3 / PR-E-3 use.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { gt, inArray, ne } from "drizzle-orm";
import {
  solarRecDashboardPerformanceRatioFacts,
  type SolarRecDashboardPerformanceRatioFact,
  type InsertSolarRecDashboardPerformanceRatioFact,
} from "../../drizzle/schema";

/**
 * Bulk UPSERT N fact rows. Each row's PK is `(scopeId, key)`; on
 * conflict the existing row's mutable columns are overwritten and
 * `updatedAt` bumps.
 *
 * **Throws** if the DB is unavailable. Same rationale as the
 * sibling fact-table helpers — the runner marking a build
 * `succeeded` while no rows were written would silently corrupt
 * the data plane.
 *
 * Chunked at 200 rows / INSERT for TiDB parameter-limit headroom
 * (performance-ratio rows have ~28 columns; 200 × 28 = 5.6k params,
 * well under the ~65k cap). Lower than the 500-row chunk the
 * change-ownership builder uses because each row carries 6 extra
 * decimal columns AND because step-4's hot path runs under tight
 * heap pressure on prod (build `bld-18271f3b…` died at pr=178,821
 * mid-stream). 200 was 400; halving the chunk halves the prepared-
 * statement parameter peak per upsert call, which is the largest
 * synchronous JS allocation inside the streaming loop.
 */
export async function upsertPerformanceRatioFacts(
  rows: InsertSolarRecDashboardPerformanceRatioFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardPerformanceRatioFacts: database unavailable — cannot upsert facts"
    );
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withDbRetry(
      "upsert dashboard performance-ratio facts",
      async () => {
        await db
          .insert(solarRecDashboardPerformanceRatioFacts)
          .values(chunk)
          .onDuplicateKeyUpdate({
            set: {
              convertedReadKey: sql`VALUES(\`convertedReadKey\`)`,
              matchType: sql`VALUES(\`matchType\`)`,
              monitoring: sql`VALUES(\`monitoring\`)`,
              monitoringSystemId: sql`VALUES(\`monitoringSystemId\`)`,
              monitoringSystemName: sql`VALUES(\`monitoringSystemName\`)`,
              readDate: sql`VALUES(\`readDate\`)`,
              readDateRaw: sql`VALUES(\`readDateRaw\`)`,
              lifetimeReadWh: sql`VALUES(\`lifetimeReadWh\`)`,
              trackingSystemRefId: sql`VALUES(\`trackingSystemRefId\`)`,
              systemId: sql`VALUES(\`systemId\`)`,
              stateApplicationRefId: sql`VALUES(\`stateApplicationRefId\`)`,
              systemName: sql`VALUES(\`systemName\`)`,
              installerName: sql`VALUES(\`installerName\`)`,
              monitoringPlatform: sql`VALUES(\`monitoringPlatform\`)`,
              portalAcSizeKw: sql`VALUES(\`portalAcSizeKw\`)`,
              abpAcSizeKw: sql`VALUES(\`abpAcSizeKw\`)`,
              part2VerificationDate: sql`VALUES(\`part2VerificationDate\`)`,
              baselineReadWh: sql`VALUES(\`baselineReadWh\`)`,
              baselineDate: sql`VALUES(\`baselineDate\`)`,
              baselineSource: sql`VALUES(\`baselineSource\`)`,
              productionDeltaWh: sql`VALUES(\`productionDeltaWh\`)`,
              expectedProductionWh: sql`VALUES(\`expectedProductionWh\`)`,
              performanceRatioPercent: sql`VALUES(\`performanceRatioPercent\`)`,
              contractValue: sql`VALUES(\`contractValue\`)`,
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
export async function deleteOrphanedPerformanceRatioFacts(
  scopeId: string,
  currentBuildId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "delete orphaned dashboard performance-ratio facts",
    async () =>
      db
        .delete(solarRecDashboardPerformanceRatioFacts)
        .where(
          and(
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
            ne(
              solarRecDashboardPerformanceRatioFacts.buildId,
              currentBuildId
            )
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Fetch a paginated page of fact rows for a scope, optionally
 * filtered by `matchType` and/or `monitoring`. Cursor is `key`;
 * rows are sorted by `key ASC` so the page boundary is stable
 * across requests.
 *
 * `matchType` and `monitoring` are the two primary filter axes
 * the PerformanceRatioTab uses. Each is backed by a covering
 * index added in PR-G-1's schema; combining both falls back to
 * one of the two indexes plus an in-memory filter on the other
 * column.
 *
 * `limit` is bounded server-side (1..1000). PR-G-3's proc layer
 * will additionally clamp at the wire-payload contract.
 */
export async function getPerformanceRatioFactsPage(
  scopeId: string,
  options: {
    cursorAfter?: string | null;
    limit: number;
    matchType?: string | null;
    monitoring?: string | null;
  }
): Promise<SolarRecDashboardPerformanceRatioFact[]> {
  const db = await getDb();
  if (!db) return [];
  const { cursorAfter, limit, matchType, monitoring } = options;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));

  const conditions = [
    eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
  ];
  if (cursorAfter) {
    conditions.push(
      gt(solarRecDashboardPerformanceRatioFacts.key, cursorAfter)
    );
  }
  if (matchType) {
    conditions.push(
      eq(solarRecDashboardPerformanceRatioFacts.matchType, matchType)
    );
  }
  if (monitoring) {
    conditions.push(
      eq(solarRecDashboardPerformanceRatioFacts.monitoring, monitoring)
    );
  }

  return withDbRetry(
    "get dashboard performance-ratio facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(and(...conditions))
        .orderBy(solarRecDashboardPerformanceRatioFacts.key)
        .limit(safeLimit)
  );
}

/**
 * Fetch fact rows for a specific set of `key` values (per-row
 * primary keys, not system keys). Used by drill-in flows that
 * already hold a filtered subset of row keys and need their full
 * fact rows without paginating the whole scope.
 *
 * `keys` is bounded by the caller; this helper just dispatches the
 * IN-list. PR-G-3's proc layer will cap at e.g. 1000 keys.
 *
 * Returns an empty array on `keys.length === 0` to avoid an empty
 * IN-list query (TiDB rejects `WHERE x IN ()`).
 */
export async function getPerformanceRatioFactsByKeys(
  scopeId: string,
  keys: string[]
): Promise<SolarRecDashboardPerformanceRatioFact[]> {
  if (keys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard performance-ratio facts by keys",
    async () =>
      db
        .select()
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(
          and(
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
            inArray(solarRecDashboardPerformanceRatioFacts.key, keys)
          )
        )
  );
}

/**
 * Count fact rows for a scope, optionally narrowed by `matchType`
 * or `monitoring`. Useful for:
 *   - PR-G-2's orchestrator logging "wrote N facts in this build."
 *   - PR-G-3's slim summary returning per-filter totals so the
 *     client can render `N rows in match-type X` without paginating
 *     to the end.
 *   - The Phase 1 dashboard guardrails / observability surface.
 */
export async function getPerformanceRatioFactsCount(
  scopeId: string,
  options?: { matchType?: string | null; monitoring?: string | null }
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [
    eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
  ];
  if (options?.matchType) {
    conditions.push(
      eq(solarRecDashboardPerformanceRatioFacts.matchType, options.matchType)
    );
  }
  if (options?.monitoring) {
    conditions.push(
      eq(
        solarRecDashboardPerformanceRatioFacts.monitoring,
        options.monitoring
      )
    );
  }
  const rows = await withDbRetry(
    "count dashboard performance-ratio facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardPerformanceRatioFacts)
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
