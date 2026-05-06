/**
 * Solar REC dashboard per-system facts — DB helpers
 * (Phase 2 PR-F-1, the fourth derived fact table).
 *
 * Backs the `solarRecDashboardSystemFacts` table that PR-F-2
 * will populate via the build runner. PR-F-3 will add the
 * paginated read proc that retires the legacy
 * `getSystemSnapshot` payload (~26 MB on prod, the largest of
 * the remaining `DASHBOARD_OVERSIZE_ALLOWLIST` entries).
 *
 * PR-F-1 is helpers ONLY — no caller wires these in yet.
 *
 * Matches the proven pattern from PR-C-1 / PR-D-1 / PR-E-1 with
 * three filter axes for the tabs that will consume this table:
 *   - `ownershipStatus` — primary filter on Overview / Change
 *     Ownership tabs.
 *   - `sizeBucket` — SizeReportingTab + Overview tile filter.
 *   - `isReporting` — used by the "currently reporting" splits
 *     on multiple tabs.
 *
 * All three filter axes can be combined; the read helper falls
 * back to the most-selective covering index + post-index
 * filtering on the remaining columns. Reads filtering on none of
 * the axes scan from the PK index `(scopeId, systemKey)` for an
 * unfiltered scoped scan.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { gt, inArray, ne } from "drizzle-orm";
import {
  solarRecDashboardSystemFacts,
  type SolarRecDashboardSystemFact,
  type InsertSolarRecDashboardSystemFact,
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
 * Chunked at 250 rows / INSERT. System fact rows have ~33 columns
 * (the widest fact table in this series); 250 × 33 ≈ 8.25k params,
 * well inside TiDB's per-statement parameter limit.
 */
export async function upsertSystemFacts(
  rows: InsertSolarRecDashboardSystemFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardSystemFacts: database unavailable — cannot upsert facts"
    );
  }

  const CHUNK = 250;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withDbRetry(
      "upsert dashboard system facts",
      async () => {
        await db
          .insert(solarRecDashboardSystemFacts)
          .values(chunk)
          .onDuplicateKeyUpdate({
            set: {
              systemId: sql`VALUES(\`systemId\`)`,
              stateApplicationRefId: sql`VALUES(\`stateApplicationRefId\`)`,
              trackingSystemRefId: sql`VALUES(\`trackingSystemRefId\`)`,
              systemName: sql`VALUES(\`systemName\`)`,
              installedKwAc: sql`VALUES(\`installedKwAc\`)`,
              installedKwDc: sql`VALUES(\`installedKwDc\`)`,
              sizeBucket: sql`VALUES(\`sizeBucket\`)`,
              recPrice: sql`VALUES(\`recPrice\`)`,
              totalContractAmount: sql`VALUES(\`totalContractAmount\`)`,
              contractedRecs: sql`VALUES(\`contractedRecs\`)`,
              deliveredRecs: sql`VALUES(\`deliveredRecs\`)`,
              contractedValue: sql`VALUES(\`contractedValue\`)`,
              deliveredValue: sql`VALUES(\`deliveredValue\`)`,
              valueGap: sql`VALUES(\`valueGap\`)`,
              latestReportingDate: sql`VALUES(\`latestReportingDate\`)`,
              latestReportingKwh: sql`VALUES(\`latestReportingKwh\`)`,
              isReporting: sql`VALUES(\`isReporting\`)`,
              isTerminated: sql`VALUES(\`isTerminated\`)`,
              isTransferred: sql`VALUES(\`isTransferred\`)`,
              ownershipStatus: sql`VALUES(\`ownershipStatus\`)`,
              hasChangedOwnership: sql`VALUES(\`hasChangedOwnership\`)`,
              changeOwnershipStatus: sql`VALUES(\`changeOwnershipStatus\`)`,
              contractStatusText: sql`VALUES(\`contractStatusText\`)`,
              contractType: sql`VALUES(\`contractType\`)`,
              zillowStatus: sql`VALUES(\`zillowStatus\`)`,
              zillowSoldDate: sql`VALUES(\`zillowSoldDate\`)`,
              contractedDate: sql`VALUES(\`contractedDate\`)`,
              monitoringType: sql`VALUES(\`monitoringType\`)`,
              monitoringPlatform: sql`VALUES(\`monitoringPlatform\`)`,
              installerName: sql`VALUES(\`installerName\`)`,
              part2VerificationDate: sql`VALUES(\`part2VerificationDate\`)`,
              isPart2Eligible: sql`VALUES(\`isPart2Eligible\`)`,
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
export async function deleteOrphanedSystemFacts(
  scopeId: string,
  currentBuildId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "delete orphaned dashboard system facts",
    async () =>
      db
        .delete(solarRecDashboardSystemFacts)
        .where(
          and(
            eq(solarRecDashboardSystemFacts.scopeId, scopeId),
            ne(solarRecDashboardSystemFacts.buildId, currentBuildId)
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Fetch a paginated page of fact rows for a scope, optionally
 * filtered by `ownershipStatus`, `sizeBucket`, `isReporting`,
 * and/or `isPart2Eligible`. Cursor is `systemKey`; rows are
 * sorted by `systemKey ASC` for stable pagination across requests.
 *
 * All four filter axes can be applied independently or together.
 * The covering indexes `(scopeId, ownershipStatus)`,
 * `(scopeId, sizeBucket)`, `(scopeId, isReporting)`,
 * `(scopeId, isPart2Eligible)` make any single-axis filter
 * efficient; combined filters fall back to one of the indexes +
 * a post-index filter on the remaining column(s).
 *
 * `limit` is bounded server-side. The proc layer additionally
 * clamps at the wire-payload contract.
 */
export async function getSystemFactsPage(
  scopeId: string,
  options: {
    cursorAfter?: string | null;
    limit: number;
    status?: string | null;
    sizeBucket?: string | null;
    isReporting?: boolean | null;
    isPart2Eligible?: boolean | null;
  }
): Promise<SolarRecDashboardSystemFact[]> {
  const db = await getDb();
  if (!db) return [];
  const {
    cursorAfter,
    limit,
    status,
    sizeBucket,
    isReporting,
    isPart2Eligible,
  } = options;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));

  const conditions = [eq(solarRecDashboardSystemFacts.scopeId, scopeId)];
  if (cursorAfter) {
    conditions.push(
      gt(solarRecDashboardSystemFacts.systemKey, cursorAfter)
    );
  }
  if (status) {
    conditions.push(
      eq(solarRecDashboardSystemFacts.ownershipStatus, status)
    );
  }
  if (sizeBucket) {
    conditions.push(eq(solarRecDashboardSystemFacts.sizeBucket, sizeBucket));
  }
  if (typeof isReporting === "boolean") {
    conditions.push(
      eq(solarRecDashboardSystemFacts.isReporting, isReporting)
    );
  }
  if (typeof isPart2Eligible === "boolean") {
    conditions.push(
      eq(solarRecDashboardSystemFacts.isPart2Eligible, isPart2Eligible)
    );
  }

  return withDbRetry(
    "get dashboard system facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardSystemFacts)
        .where(and(...conditions))
        .orderBy(solarRecDashboardSystemFacts.systemKey)
        .limit(safeLimit)
  );
}

/**
 * Fetch fact rows for a specific set of system keys. Used by the
 * "details for these systems" lookup pattern. Empty keys array →
 * empty result without DB call.
 */
export async function getSystemFactsBySystemKeys(
  scopeId: string,
  systemKeys: string[]
): Promise<SolarRecDashboardSystemFact[]> {
  if (systemKeys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard system facts by keys",
    async () =>
      db
        .select()
        .from(solarRecDashboardSystemFacts)
        .where(
          and(
            eq(solarRecDashboardSystemFacts.scopeId, scopeId),
            inArray(solarRecDashboardSystemFacts.systemKey, systemKeys)
          )
        )
  );
}

/**
 * Count fact rows for a scope, optionally narrowed by
 * `ownershipStatus`, `sizeBucket`, `isReporting`, and/or
 * `isPart2Eligible`. Useful for first-page totalCount + per-axis
 * counts.
 */
export async function getSystemFactsCount(
  scopeId: string,
  options?: {
    status?: string | null;
    sizeBucket?: string | null;
    isReporting?: boolean | null;
    isPart2Eligible?: boolean | null;
  }
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [eq(solarRecDashboardSystemFacts.scopeId, scopeId)];
  if (options?.status) {
    conditions.push(
      eq(solarRecDashboardSystemFacts.ownershipStatus, options.status)
    );
  }
  if (options?.sizeBucket) {
    conditions.push(
      eq(solarRecDashboardSystemFacts.sizeBucket, options.sizeBucket)
    );
  }
  if (typeof options?.isReporting === "boolean") {
    conditions.push(
      eq(solarRecDashboardSystemFacts.isReporting, options.isReporting)
    );
  }
  if (typeof options?.isPart2Eligible === "boolean") {
    conditions.push(
      eq(
        solarRecDashboardSystemFacts.isPart2Eligible,
        options.isPart2Eligible
      )
    );
  }
  const rows = await withDbRetry(
    "count dashboard system facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardSystemFacts)
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
