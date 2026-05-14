/**
 * Solar REC dashboard performance-ratio facts — DB helpers.
 *
 * Backs `solarRecDashboardPerformanceRatioFacts`. The 2026-05-09
 * Option C refactor changed the PK from `(scopeId, key)` to
 * `(scopeId, buildId, key)` so multiple builds can coexist in the
 * table — a failed or in-flight build's rows are simply invisible
 * until that build completes its summary write. The summary
 * artifact's `buildId` is the canonical "visible build pointer"; the
 * page reader filters `WHERE scopeId=? AND buildId=summary_buildId`.
 *
 * Architectural shape:
 *   1. **Bulk write** (`upsertPerformanceRatioFacts`) — runner
 *      step calls per page during streaming. Per-build PK means
 *      writes never collide with another build's rows.
 *   2. **Build sweep** (`pruneSupersededPerformanceRatioFacts`) —
 *      after a build's summary write succeeds, deletes rows whose
 *      `buildId` is not the latest visible build. Best-effort:
 *      stale rows persist until the next sweep; they're invisible
 *      via the summary-pointer filter so they cause no harm.
 *   3. **Filter + paginated read** (`getPerformanceRatioFactsPage`)
 *      — accepts `(matchType, monitoring, search, sortBy, sortDir,
 *      offset, limit)`. The proc layer always passes
 *      `summary_buildId` as the visibility pointer; rows from
 *      other builds are never returned.
 *   4. **Counts + aggregates** (`getPerformanceRatioFactsCount`,
 *      `getPerformanceRatioFactsAggregates`) — same filter args.
 *      The aggregates are accumulated during streaming AND can be
 *      re-derived from the table for diagnostic purposes.
 *
 * Sortable columns: `performanceRatioPercent`, `productionDeltaWh`,
 * `expectedProductionWh`, `systemName`, `readDate`. The covering
 * indexes added in migration 0067 keep `WHERE scopeId=? AND
 * buildId=? ORDER BY <col>` off a filesort for the most-common
 * columns; less-common columns accept a per-build-set filesort.
 *
 * Searchable columns: `systemName`, `systemId`, `trackingSystemRefId`,
 * `monitoring`, `monitoringSystemId`, `monitoringSystemName`,
 * `installerName`. Implementation is per-row LOWER(...) LIKE %term%.
 * Per-build subset is small enough to scan; if/when this becomes a
 * bottleneck, promote to a covering FTS index.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { inArray, asc, desc, or, like } from "drizzle-orm";
import {
  solarRecDashboardPerformanceRatioFacts,
  type SolarRecDashboardPerformanceRatioFact,
  type InsertSolarRecDashboardPerformanceRatioFact,
} from "../../drizzle/schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Sortable columns for `getPerformanceRatioFactsPage`. The set is
 * limited to columns the PerformanceRatioTab UI exposes as a sort
 * control — other columns aren't reachable through the proc input
 * type-narrowing.
 */
export type PerformanceRatioSortBy =
  | "performanceRatioPercent"
  | "productionDeltaWh"
  | "expectedProductionWh"
  | "systemName"
  | "readDate";

export type PerformanceRatioSortDir = "asc" | "desc";

/**
 * Common filter shape used by every read helper. The `buildId` is
 * REQUIRED — callers must look it up via the summary artifact's
 * `buildId` first. A missing `buildId` (no completed build for the
 * scope) means there's no visible data and the helpers return
 * empty.
 *
 * `search` is normalized server-side (trimmed, lowercased) before
 * the LIKE comparison; pass the raw user input.
 */
export interface PerformanceRatioFiltersInput {
  scopeId: string;
  buildId: string;
  matchType?: string | null;
  monitoring?: string | null;
  search?: string | null;
}

export interface PerformanceRatioFactsAggregates {
  allocationCount: number;
  withBaseline: number;
  withExpected: number;
  withRatio: number;
  totalDeltaWh: number;
  totalExpectedWh: number;
  totalContractValue: number;
}

// ---------------------------------------------------------------------------
// Bulk writes (called by the build runner step)
// ---------------------------------------------------------------------------

/**
 * Bulk UPSERT N fact rows. Each row's PK is
 * `(scopeId, buildId, key)`; on conflict the existing row's mutable
 * columns are overwritten and `updatedAt` bumps. Rows from a
 * different build never collide on this PK, so a concurrent build
 * cannot corrupt our writes mid-flight.
 *
 * **Throws** if the DB is unavailable. Same rationale as the
 * sibling fact-table helpers — the runner marking a build
 * `succeeded` while no rows were written would silently corrupt
 * the data plane.
 *
 * Chunked at 500 rows / INSERT for TiDB parameter-limit headroom.
 *
 * 2026-05-13 — bumped from 200 → 500 as part of the throughput
 * tuning that motivated the 5_000-row streaming page size in
 * `loadPerformanceRatioInput.ts`. The prior 200 was conservative;
 * 500 still leaves ~5× headroom relative to typical TiDB limits
 * (each fact row carries ~25 columns → 500 × 25 = 12,500 bind
 * parameters per INSERT, well under TiDB's `max_allowed_packet`
 * budget, which is sized in millions of params). At 500 rows /
 * chunk a typical 300-540-row per-page drain becomes a single
 * roundtrip instead of 2-3 — ~2.5× write-roundtrip reduction for
 * the build runner. See the page-size constant comment for the
 * `bld-2ebd9c6cdcdd3e41495edb6725e80238` timeout failure that
 * motivated this combined change.
 */
export async function upsertPerformanceRatioFacts(
  rows: InsertSolarRecDashboardPerformanceRatioFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error("upsertPerformanceRatioFacts: DB unavailable");
  }
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    await withDbRetry(
      "upsert dashboard performance-ratio facts (chunk)",
      async () =>
        db
          .insert(solarRecDashboardPerformanceRatioFacts)
          .values(slice)
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
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })
    );
  }
}

/**
 * Delete fact rows whose `buildId` is not in `keepBuildIds`. Used
 * after a successful summary write to reclaim stale rows from
 * superseded / failed builds without affecting the now-visible
 * build.
 *
 * Best-effort: if deletion fails, stale rows persist; they remain
 * invisible because the page reader filters by the summary's
 * `buildId`. The next successful build's prune sweep will reclaim
 * them.
 *
 * `keepBuildIds` MUST include the now-visible build's `buildId`.
 * Pass an empty array only for full-table cleanup (e.g. test
 * teardown).
 */
export async function pruneSupersededPerformanceRatioFacts(
  scopeId: string,
  keepBuildIds: readonly string[]
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "prune superseded dashboard performance-ratio facts",
    async () => {
      if (keepBuildIds.length === 0) {
        return db
          .delete(solarRecDashboardPerformanceRatioFacts)
          .where(
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId)
          );
      }
      return db
        .delete(solarRecDashboardPerformanceRatioFacts)
        .where(
          and(
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
            sql`${solarRecDashboardPerformanceRatioFacts.buildId} NOT IN (${sql.join(
              keepBuildIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );
    }
  );
  return getAffectedRows(result);
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Build the WHERE conditions common to every read helper. Caller
 * passes the resolved `(scopeId, buildId)` plus the user-supplied
 * filter args.
 *
 * `search` is matched LIKE %term% across these columns:
 *   `systemName`, `systemId`, `trackingSystemRefId`, `monitoring`,
 *   `monitoringSystemId`, `monitoringSystemName`, `installerName`.
 * Mirror of the client-side `haystack` array in PerformanceRatioTab
 * (Option C cutover) — keeping these in sync prevents the page
 * search from drifting from a hypothetical future client memo.
 */
function buildPerformanceRatioFilterConditions(
  filters: PerformanceRatioFiltersInput
): unknown[] {
  const { scopeId, buildId, matchType, monitoring, search } = filters;
  const conditions: unknown[] = [
    eq(solarRecDashboardPerformanceRatioFacts.scopeId, scopeId),
    eq(solarRecDashboardPerformanceRatioFacts.buildId, buildId),
  ];
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
  const trimmed = (search ?? "").trim().toLowerCase();
  if (trimmed.length > 0) {
    // Escape MySQL LIKE wildcards (`%` and `_`) and the escape
    // character itself before constructing the pattern. Without
    // this, a user typing `_5kW` matches `15kW` / `25kW` / etc.
    // because `_` is the LIKE single-char wildcard. ESCAPE clause
    // is omitted because the default escape (`\`) is the one we
    // double up below.
    const escaped = trimmed
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;
    conditions.push(
      or(
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.systemName})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.systemId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.trackingSystemRefId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.monitoring})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.monitoringSystemId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.monitoringSystemName})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioFacts.installerName})`,
          pattern
        )
      )
    );
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a paginated page of fact rows under the given filters,
 * ordered by `(sortBy, sortDir)` with `key` as a tie-breaker for
 * stable pagination. Returns rows from EXACTLY one build (the
 * caller-supplied `buildId`); other builds' rows are never visible
 * through this path.
 *
 * `limit` clamps to 1..1000 server-side. Wire payload at
 * `limit=100` is ~50–80 KB depending on column nullability — well
 * under the 1 MB dashboard guardrail.
 */
export async function getPerformanceRatioFactsPage(
  filters: PerformanceRatioFiltersInput,
  pagination: {
    limit: number;
    offset: number;
    sortBy: PerformanceRatioSortBy;
    sortDir: PerformanceRatioSortDir;
  }
): Promise<SolarRecDashboardPerformanceRatioFact[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(pagination.limit)));
  const safeOffset = Math.max(0, Math.floor(pagination.offset));
  const conditions = buildPerformanceRatioFilterConditions(filters);
  const sortCol = resolveSortColumn(pagination.sortBy);
  const sortFn = pagination.sortDir === "asc" ? asc : desc;

  return withDbRetry(
    "get dashboard performance-ratio facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(
          sortFn(sortCol),
          // `key` is the stable tie-breaker — same value on the
          // sort column otherwise produces non-deterministic
          // pagination across page boundaries.
          asc(solarRecDashboardPerformanceRatioFacts.key)
        )
        .limit(safeLimit)
        .offset(safeOffset)
  );
}

function resolveSortColumn(sortBy: PerformanceRatioSortBy) {
  switch (sortBy) {
    case "performanceRatioPercent":
      return solarRecDashboardPerformanceRatioFacts.performanceRatioPercent;
    case "productionDeltaWh":
      return solarRecDashboardPerformanceRatioFacts.productionDeltaWh;
    case "expectedProductionWh":
      return solarRecDashboardPerformanceRatioFacts.expectedProductionWh;
    case "systemName":
      return solarRecDashboardPerformanceRatioFacts.systemName;
    case "readDate":
      return solarRecDashboardPerformanceRatioFacts.readDate;
  }
}

/**
 * Count fact rows under the given filters. Used by the page proc
 * to return `totalCount` so the client can render `Page X of Y`
 * without fetching every page.
 */
export async function getPerformanceRatioFactsCount(
  filters: PerformanceRatioFiltersInput
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = buildPerformanceRatioFilterConditions(filters);
  const rows = await withDbRetry(
    "count dashboard performance-ratio facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
  );
  const first = rows[0];
  if (!first) return 0;
  return coerceCount(first.n);
}

/**
 * Aggregate counts + sums under the given filters. Mirrors the
 * client's `performanceRatioSummary` memo (pre-Option-C) so the
 * headline tile values can re-render under filter changes without
 * the client having to load every row.
 *
 * Single round-trip; one `SELECT … COUNT(...) … SUM(...) …` query.
 * The per-build covering indexes mean the WHERE filters use the
 * index but the SUMs still scan the matching rows — for the worst-
 * case unfiltered query that's ~225k rows on prod, a few hundred
 * milliseconds. Aggregates ARE pre-computed in the build runner
 * and stored on the summary artifact, so this helper is the
 * fallback path: only invoked when filters differ from "everything".
 */
export async function getPerformanceRatioFactsAggregates(
  filters: PerformanceRatioFiltersInput
): Promise<PerformanceRatioFactsAggregates> {
  const db = await getDb();
  if (!db) return emptyAggregates();
  const conditions = buildPerformanceRatioFilterConditions(filters);
  const rows = await withDbRetry(
    "aggregate dashboard performance-ratio facts",
    async () =>
      db
        .select({
          allocationCount: sql<number>`COUNT(*)`.as("allocationCount"),
          withBaseline:
            sql<number>`SUM(CASE WHEN ${solarRecDashboardPerformanceRatioFacts.baselineReadWh} IS NOT NULL THEN 1 ELSE 0 END)`.as(
              "withBaseline"
            ),
          withExpected:
            sql<number>`SUM(CASE WHEN ${solarRecDashboardPerformanceRatioFacts.expectedProductionWh} IS NOT NULL AND ${solarRecDashboardPerformanceRatioFacts.expectedProductionWh} > 0 THEN 1 ELSE 0 END)`.as(
              "withExpected"
            ),
          withRatio:
            sql<number>`SUM(CASE WHEN ${solarRecDashboardPerformanceRatioFacts.performanceRatioPercent} IS NOT NULL THEN 1 ELSE 0 END)`.as(
              "withRatio"
            ),
          totalDeltaWh:
            sql<string>`COALESCE(SUM(${solarRecDashboardPerformanceRatioFacts.productionDeltaWh}), 0)`.as(
              "totalDeltaWh"
            ),
          totalExpectedWh:
            sql<string>`COALESCE(SUM(${solarRecDashboardPerformanceRatioFacts.expectedProductionWh}), 0)`.as(
              "totalExpectedWh"
            ),
          totalContractValue:
            sql<string>`COALESCE(SUM(${solarRecDashboardPerformanceRatioFacts.contractValue}), 0)`.as(
              "totalContractValue"
            ),
        })
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
  );
  const first = rows[0];
  if (!first) return emptyAggregates();
  return {
    allocationCount: coerceCount(first.allocationCount),
    withBaseline: coerceCount(first.withBaseline),
    withExpected: coerceCount(first.withExpected),
    withRatio: coerceCount(first.withRatio),
    totalDeltaWh: coerceDecimalSum(first.totalDeltaWh),
    totalExpectedWh: coerceDecimalSum(first.totalExpectedWh),
    totalContractValue: coerceDecimalSum(first.totalContractValue),
  };
}

function emptyAggregates(): PerformanceRatioFactsAggregates {
  return {
    allocationCount: 0,
    withBaseline: 0,
    withExpected: 0,
    withRatio: 0,
    totalDeltaWh: 0,
    totalExpectedWh: 0,
    totalContractValue: 0,
  };
}

/**
 * Distinct `monitoring` values for the visible build. Powers the
 * monitoring-filter dropdown.
 */
export async function getPerformanceRatioMonitoringOptions(args: {
  scopeId: string;
  buildId: string;
}): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await withDbRetry(
    "list dashboard performance-ratio monitoring options",
    async () =>
      db
        .selectDistinct({
          monitoring: solarRecDashboardPerformanceRatioFacts.monitoring,
        })
        .from(solarRecDashboardPerformanceRatioFacts)
        .where(
          and(
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, args.scopeId),
            eq(solarRecDashboardPerformanceRatioFacts.buildId, args.buildId)
          )
        )
  );
  const values: string[] = [];
  for (const row of rows) {
    if (typeof row.monitoring === "string" && row.monitoring.length > 0) {
      values.push(row.monitoring);
    }
  }
  values.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
  return values;
}

/**
 * Fetch fact rows for a specific set of `key` values. Caller
 * supplies the visible `buildId` so cross-build keys never leak.
 */
export async function getPerformanceRatioFactsByKeys(
  args: {
    scopeId: string;
    buildId: string;
    keys: string[];
  }
): Promise<SolarRecDashboardPerformanceRatioFact[]> {
  if (args.keys.length === 0) return [];
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
            eq(solarRecDashboardPerformanceRatioFacts.scopeId, args.scopeId),
            eq(solarRecDashboardPerformanceRatioFacts.buildId, args.buildId),
            inArray(
              solarRecDashboardPerformanceRatioFacts.key,
              args.keys
            )
          )
        )
  );
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceCount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * MySQL DECIMAL aggregates come back as strings (driver preserves
 * precision). The dashboard tiles operate in JS doubles; coerce
 * here. The values are sums of `decimal(20, 4)` columns — well
 * within JS double's mantissa for any realistic dashboard scope.
 */
function coerceDecimalSum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
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
