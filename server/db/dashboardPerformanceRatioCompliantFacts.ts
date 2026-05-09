/**
 * Solar REC dashboard performance-ratio COMPLIANT facts — DB helpers
 * (PR-CB-1 — the structural fix to the 21k-row truncation wedge).
 *
 * Backs `solarRecDashboardPerformanceRatioCompliantFacts`. This is
 * the dedicated table for the pre-reduced "best per system" rows
 * that the build runner previously serialized into a single artifact
 * JSON (`performanceRatioCompliantBestPerSystem`). The artifact path
 * survives PR-CB-1 unchanged (dual-write in PR-CB-2 keeps the
 * existing tab functional); the migration of the read path lands in
 * PR-CB-3.
 *
 * Architectural shape mirrors `dashboardPerformanceRatioFacts.ts`
 * (the parent fact-table helpers):
 *   1. **Bulk write** (`upsertPerformanceRatioCompliantFacts`) — runner
 *      step calls per build. Per-build PK
 *      `(scopeId, buildId, systemKey)` means writes never collide
 *      with another build's rows.
 *   2. **Build sweep** (`pruneSupersededPerformanceRatioCompliantFacts`)
 *      — after a build's summary write succeeds, deletes rows whose
 *      `buildId` is not the latest visible build. Best-effort: stale
 *      rows persist until the next sweep; they're invisible via the
 *      summary-pointer filter so they cause no harm.
 *   3. **Filter + paginated read**
 *      (`getPerformanceRatioCompliantFactsPage`) — accepts
 *      `(compliantSource, monitoring, search, sortBy, sortDir,
 *      offset, limit)`. The proc layer always passes the summary's
 *      `buildId` as the visibility pointer; rows from other builds
 *      are never returned.
 *   4. **Counts + aggregates**
 *      (`getPerformanceRatioCompliantFactsCount`,
 *      `getPerformanceRatioCompliantFactsAggregates`) — same filter
 *      args. The aggregates mirror the historical client memo
 *      `compliantPerformanceRatioSummary` (count + withCompliantSource).
 *      `withEvidence` stays client-side because evidence comes from
 *      localStorage manual overlays.
 *
 * Sortable columns: `performanceRatioPercent`, `readDate`,
 * `systemName`, `compliantSource`. The covering indexes added in
 * migration 0069 keep `WHERE scopeId=? AND buildId=? ORDER BY <col>`
 * off a filesort for the most-common columns; less-common columns
 * accept a per-build-set filesort.
 *
 * Searchable columns: `systemName`, `systemId`, `trackingSystemRefId`,
 * `monitoring`, `monitoringSystemId`, `monitoringSystemName`,
 * `installerName`. Implementation is per-row LOWER(...) LIKE %term%.
 * Per-build subset is small (≤ ~25k rows in practice) so the scan
 * cost is acceptable. Mirrors the parent helper.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { inArray, asc, desc, or, like } from "drizzle-orm";
import {
  solarRecDashboardPerformanceRatioCompliantFacts,
  type SolarRecDashboardPerformanceRatioCompliantFact,
  type InsertSolarRecDashboardPerformanceRatioCompliantFact,
} from "../../drizzle/schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PerformanceRatioCompliantSortBy =
  | "performanceRatioPercent"
  | "readDate"
  | "systemName"
  | "compliantSource";

export type PerformanceRatioCompliantSortDir = "asc" | "desc";

/**
 * Filter inputs for read helpers. `compliantSource` matches the
 * exact value (e.g. "10kW AC or Less" / "Explicit Platform"); the
 * special sentinel `"__none__"` filters to rows where
 * `compliantSource IS NULL` (i.e. unclassified — the user wants to
 * see what's missing). `null` / undefined means "no filter".
 */
export interface PerformanceRatioCompliantFiltersInput {
  scopeId: string;
  buildId: string;
  compliantSource?: string | null;
  monitoring?: string | null;
  search?: string | null;
}

/**
 * Sentinel value for the `compliantSource` filter that matches rows
 * where `compliantSource IS NULL`. The string is namespaced so it
 * cannot collide with a real auto-source label.
 */
export const COMPLIANT_SOURCE_NONE_SENTINEL = "__none__";

export interface PerformanceRatioCompliantFactsAggregates {
  count: number;
  withCompliantSource: number;
}

// ---------------------------------------------------------------------------
// Bulk writes (called by the build runner step)
// ---------------------------------------------------------------------------

/**
 * Bulk UPSERT N compliant fact rows. Each row's PK is
 * `(scopeId, buildId, systemKey)`; on conflict the existing row's
 * mutable columns are overwritten and `updatedAt` bumps. Rows from a
 * different build never collide on this PK, so a concurrent build
 * cannot corrupt our writes mid-flight.
 *
 * **Throws** if the DB is unavailable. Same rationale as the sibling
 * fact-table helpers — the runner marking a build `succeeded` while
 * no rows were written would silently corrupt the data plane.
 *
 * Chunked at 200 rows / INSERT for TiDB parameter-limit headroom
 * (mirrors the parent helper).
 */
export async function upsertPerformanceRatioCompliantFacts(
  rows: InsertSolarRecDashboardPerformanceRatioCompliantFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error("upsertPerformanceRatioCompliantFacts: DB unavailable");
  }
  const CHUNK_SIZE = 200;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    await withDbRetry(
      "upsert dashboard performance-ratio compliant facts (chunk)",
      async () =>
        db
          .insert(solarRecDashboardPerformanceRatioCompliantFacts)
          .values(slice)
          .onDuplicateKeyUpdate({
            set: {
              key: sql`VALUES(\`key\`)`,
              systemId: sql`VALUES(\`systemId\`)`,
              stateApplicationRefId: sql`VALUES(\`stateApplicationRefId\`)`,
              trackingSystemRefId: sql`VALUES(\`trackingSystemRefId\`)`,
              systemName: sql`VALUES(\`systemName\`)`,
              matchType: sql`VALUES(\`matchType\`)`,
              monitoring: sql`VALUES(\`monitoring\`)`,
              monitoringSystemId: sql`VALUES(\`monitoringSystemId\`)`,
              monitoringSystemName: sql`VALUES(\`monitoringSystemName\`)`,
              monitoringPlatform: sql`VALUES(\`monitoringPlatform\`)`,
              installerName: sql`VALUES(\`installerName\`)`,
              portalAcSizeKw: sql`VALUES(\`portalAcSizeKw\`)`,
              abpAcSizeKw: sql`VALUES(\`abpAcSizeKw\`)`,
              part2VerificationDate: sql`VALUES(\`part2VerificationDate\`)`,
              readDate: sql`VALUES(\`readDate\`)`,
              readDateRaw: sql`VALUES(\`readDateRaw\`)`,
              performanceRatioPercent: sql`VALUES(\`performanceRatioPercent\`)`,
              productionDeltaWh: sql`VALUES(\`productionDeltaWh\`)`,
              expectedProductionWh: sql`VALUES(\`expectedProductionWh\`)`,
              contractValue: sql`VALUES(\`contractValue\`)`,
              baselineReadWh: sql`VALUES(\`baselineReadWh\`)`,
              baselineDate: sql`VALUES(\`baselineDate\`)`,
              baselineSource: sql`VALUES(\`baselineSource\`)`,
              lifetimeReadWh: sql`VALUES(\`lifetimeReadWh\`)`,
              compliantSource: sql`VALUES(\`compliantSource\`)`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })
    );
  }
}

/**
 * Delete compliant fact rows whose `buildId` is not in `keepBuildIds`.
 * Used after a successful summary write to reclaim stale rows from
 * superseded / failed builds without affecting the now-visible build.
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
export async function pruneSupersededPerformanceRatioCompliantFacts(
  scopeId: string,
  keepBuildIds: readonly string[]
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "prune superseded dashboard performance-ratio compliant facts",
    async () => {
      if (keepBuildIds.length === 0) {
        return db
          .delete(solarRecDashboardPerformanceRatioCompliantFacts)
          .where(
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.scopeId,
              scopeId
            )
          );
      }
      return db
        .delete(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(
          and(
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.scopeId,
              scopeId
            ),
            sql`${solarRecDashboardPerformanceRatioCompliantFacts.buildId} NOT IN (${sql.join(
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
 * `search` is matched LIKE %term% across the same haystack as the
 * parent fact table so behavior stays consistent across the two
 * paginated reads. MySQL LIKE wildcards (`%` and `_`) and the
 * escape character are escaped before pattern construction so a
 * user typing `_5kW` doesn't match `15kW` / `25kW` accidentally.
 */
function buildPerformanceRatioCompliantFilterConditions(
  filters: PerformanceRatioCompliantFiltersInput
): unknown[] {
  const { scopeId, buildId, compliantSource, monitoring, search } = filters;
  const conditions: unknown[] = [
    eq(solarRecDashboardPerformanceRatioCompliantFacts.scopeId, scopeId),
    eq(solarRecDashboardPerformanceRatioCompliantFacts.buildId, buildId),
  ];
  if (compliantSource !== null && compliantSource !== undefined) {
    if (compliantSource === COMPLIANT_SOURCE_NONE_SENTINEL) {
      conditions.push(
        sql`${solarRecDashboardPerformanceRatioCompliantFacts.compliantSource} IS NULL`
      );
    } else {
      conditions.push(
        eq(
          solarRecDashboardPerformanceRatioCompliantFacts.compliantSource,
          compliantSource
        )
      );
    }
  }
  if (monitoring) {
    conditions.push(
      eq(
        solarRecDashboardPerformanceRatioCompliantFacts.monitoring,
        monitoring
      )
    );
  }
  const trimmed = (search ?? "").trim().toLowerCase();
  if (trimmed.length > 0) {
    const escaped = trimmed
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;
    conditions.push(
      or(
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.systemName})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.systemId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.trackingSystemRefId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.monitoring})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.monitoringSystemId})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.monitoringSystemName})`,
          pattern
        ),
        like(
          sql`LOWER(${solarRecDashboardPerformanceRatioCompliantFacts.installerName})`,
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
 * Fetch a paginated page of compliant fact rows under the given
 * filters, ordered by `(sortBy, sortDir)` with `systemKey` as a
 * stable tie-breaker. Returns rows from EXACTLY one build (the
 * caller-supplied `buildId`); other builds' rows are never visible
 * through this path.
 *
 * `limit` clamps to 1..1000 server-side. Wire payload at
 * `limit=100` is ~50–80 KB depending on column nullability — well
 * under the 1 MB dashboard guardrail.
 */
export async function getPerformanceRatioCompliantFactsPage(
  filters: PerformanceRatioCompliantFiltersInput,
  pagination: {
    limit: number;
    offset: number;
    sortBy: PerformanceRatioCompliantSortBy;
    sortDir: PerformanceRatioCompliantSortDir;
  }
): Promise<SolarRecDashboardPerformanceRatioCompliantFact[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(pagination.limit)));
  const safeOffset = Math.max(0, Math.floor(pagination.offset));
  const conditions = buildPerformanceRatioCompliantFilterConditions(filters);
  const sortCol = resolveSortColumn(pagination.sortBy);
  const sortFn = pagination.sortDir === "asc" ? asc : desc;

  return withDbRetry(
    "get dashboard performance-ratio compliant facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(
          sortFn(sortCol),
          // `systemKey` is the stable tie-breaker — the PK already
          // enforces 1-row-per-systemKey-per-build so this is
          // sufficient for deterministic pagination.
          asc(solarRecDashboardPerformanceRatioCompliantFacts.systemKey)
        )
        .limit(safeLimit)
        .offset(safeOffset)
  );
}

function resolveSortColumn(sortBy: PerformanceRatioCompliantSortBy) {
  switch (sortBy) {
    case "performanceRatioPercent":
      return solarRecDashboardPerformanceRatioCompliantFacts.performanceRatioPercent;
    case "readDate":
      return solarRecDashboardPerformanceRatioCompliantFacts.readDate;
    case "systemName":
      return solarRecDashboardPerformanceRatioCompliantFacts.systemName;
    case "compliantSource":
      return solarRecDashboardPerformanceRatioCompliantFacts.compliantSource;
  }
}

/**
 * Count compliant fact rows under the given filters. Used by the
 * page proc to return `totalCount` so the client can render
 * `Page X of Y` without fetching every page.
 */
export async function getPerformanceRatioCompliantFactsCount(
  filters: PerformanceRatioCompliantFiltersInput
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = buildPerformanceRatioCompliantFilterConditions(filters);
  const rows = await withDbRetry(
    "count dashboard performance-ratio compliant facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
  );
  const first = rows[0];
  if (!first) return 0;
  return coerceCount(first.n);
}

/**
 * Aggregate counts under the given filters. Mirrors the historical
 * client memo `compliantPerformanceRatioSummary` so the headline
 * tile values can re-render under filter changes without the
 * client having to load every row.
 *
 * `withEvidence` is intentionally NOT computed server-side because
 * evidence is per-user localStorage manual overlay state — the
 * tab combines this server aggregate with a client-side count of
 * `evidenceCount > 0` rows.
 */
export async function getPerformanceRatioCompliantFactsAggregates(
  filters: PerformanceRatioCompliantFiltersInput
): Promise<PerformanceRatioCompliantFactsAggregates> {
  const db = await getDb();
  if (!db) return emptyAggregates();
  const conditions = buildPerformanceRatioCompliantFilterConditions(filters);
  const rows = await withDbRetry(
    "aggregate dashboard performance-ratio compliant facts",
    async () =>
      db
        .select({
          count: sql<number>`COUNT(*)`.as("count"),
          withCompliantSource:
            sql<number>`SUM(CASE WHEN ${solarRecDashboardPerformanceRatioCompliantFacts.compliantSource} IS NOT NULL THEN 1 ELSE 0 END)`.as(
              "withCompliantSource"
            ),
        })
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(and(...(conditions as Parameters<typeof and>)))
  );
  const first = rows[0];
  if (!first) return emptyAggregates();
  return {
    count: coerceCount(first.count),
    withCompliantSource: coerceCount(first.withCompliantSource),
  };
}

function emptyAggregates(): PerformanceRatioCompliantFactsAggregates {
  return { count: 0, withCompliantSource: 0 };
}

/**
 * Distinct `compliantSource` values for the visible build. Powers
 * the compliant-source-filter dropdown. NULL values are excluded
 * from the returned list — the UI shows them via the
 * `COMPLIANT_SOURCE_NONE_SENTINEL` filter option that the dropdown
 * adds explicitly.
 */
export async function getPerformanceRatioCompliantSourceOptions(args: {
  scopeId: string;
  buildId: string;
}): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await withDbRetry(
    "list dashboard performance-ratio compliant source options",
    async () =>
      db
        .selectDistinct({
          compliantSource:
            solarRecDashboardPerformanceRatioCompliantFacts.compliantSource,
        })
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(
          and(
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.scopeId,
              args.scopeId
            ),
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.buildId,
              args.buildId
            )
          )
        )
  );
  const values: string[] = [];
  for (const row of rows) {
    if (
      typeof row.compliantSource === "string" &&
      row.compliantSource.length > 0
    ) {
      values.push(row.compliantSource);
    }
  }
  values.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
  return values;
}

/**
 * Distinct `monitoring` values for the visible build. Powers the
 * monitoring-filter dropdown. Mirrors the parent fact-table helper.
 */
export async function getPerformanceRatioCompliantMonitoringOptions(args: {
  scopeId: string;
  buildId: string;
}): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await withDbRetry(
    "list dashboard performance-ratio compliant monitoring options",
    async () =>
      db
        .selectDistinct({
          monitoring:
            solarRecDashboardPerformanceRatioCompliantFacts.monitoring,
        })
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(
          and(
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.scopeId,
              args.scopeId
            ),
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.buildId,
              args.buildId
            )
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
 * Fetch compliant fact rows for a specific set of `systemKey`
 * values. Caller supplies the visible `buildId` so cross-build
 * keys never leak. Used by the (future) snapshot-log creation
 * flow that needs the full row data for a selected subset.
 */
export async function getPerformanceRatioCompliantFactsBySystemKeys(args: {
  scopeId: string;
  buildId: string;
  systemKeys: string[];
}): Promise<SolarRecDashboardPerformanceRatioCompliantFact[]> {
  if (args.systemKeys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard performance-ratio compliant facts by systemKeys",
    async () =>
      db
        .select()
        .from(solarRecDashboardPerformanceRatioCompliantFacts)
        .where(
          and(
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.scopeId,
              args.scopeId
            ),
            eq(
              solarRecDashboardPerformanceRatioCompliantFacts.buildId,
              args.buildId
            ),
            inArray(
              solarRecDashboardPerformanceRatioCompliantFacts.systemKey,
              args.systemKeys
            )
          )
        )
  );
}

// ---------------------------------------------------------------------------
// Coercion helpers (mirror the parent fact-table helpers)
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
