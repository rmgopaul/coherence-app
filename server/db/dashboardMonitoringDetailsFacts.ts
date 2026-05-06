/**
 * Solar REC dashboard monitoring-details facts — DB helpers
 * (Phase 2 PR-C-1, the first derived fact table).
 *
 * Backs the `solarRecDashboardMonitoringDetailsFacts` table that
 * PR-C-2 will populate via the build runner. PR-C-3 will add the
 * paginated read proc that the OfflineMonitoringTab migrates onto,
 * retiring the per-system map shape from
 * `getDashboardOfflineMonitoring`'s response.
 *
 * PR-C-1 is helpers ONLY — no caller in production wires these in
 * yet. The table is empty until PR-C-2 ships.
 *
 * Three orthogonal usage patterns:
 *
 *   1. **Bulk write** (`upsertMonitoringDetailsFacts`) — PR-C-2's
 *      builder calls this once per build with the N rows it
 *      derived from `srDsSolarApplications` + `srDsAbpReport`.
 *      Each row tagged with the current `buildId`.
 *
 *   2. **Orphan sweep** (`deleteOrphanedMonitoringDetailsFacts`) —
 *      after the bulk write, the builder fires this to remove rows
 *      from PRIOR builds (systems that disappeared from the input).
 *      Together, UPSERT-then-DELETE-by-old-buildId guarantees the
 *      table reflects exactly the systems in the latest build.
 *
 *   3. **Paginated read** (`getMonitoringDetailsFactsPage`) — PR-C-3's
 *      proc returns one page at a time (cursor by `systemKey`),
 *      keeping wire payloads bounded. PR-C-3 also adds an "all-keys
 *      for these systems" lookup for clients that need a specific
 *      subset.
 */

import { and, eq, getDb, sql, withDbRetry } from "./_core";
import { gt, inArray, ne } from "drizzle-orm";
import {
  solarRecDashboardMonitoringDetailsFacts,
  type SolarRecDashboardMonitoringDetailsFact,
  type InsertSolarRecDashboardMonitoringDetailsFact,
} from "../../drizzle/schema";

/**
 * Bulk UPSERT N fact rows. Each row's primary key is
 * `(scopeId, systemKey)`; on conflict the existing row's mutable
 * columns are overwritten and `updatedAt` bumps.
 *
 * **Throws** if the DB is unavailable. The contract makes this
 * write mandatory — silently returning would let the runner mark
 * the build as `succeeded` with NO fact rows actually written.
 *
 * Chunked at 500 rows per INSERT to stay under TiDB's parameter
 * limit (~65k params; with 21 columns per row that's ~3000 rows
 * per statement worst-case, but keeping headroom for future
 * column additions). The orchestration in PR-C-2 will iterate
 * pages as it streams from `srDs*`.
 */
export async function upsertMonitoringDetailsFacts(
  rows: InsertSolarRecDashboardMonitoringDetailsFact[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) {
    throw new Error(
      "dashboardMonitoringDetailsFacts: database unavailable — cannot upsert facts"
    );
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withDbRetry(
      "upsert dashboard monitoring details facts",
      async () => {
        await db
          .insert(solarRecDashboardMonitoringDetailsFacts)
          .values(chunk)
          .onDuplicateKeyUpdate({
            set: {
              onlineMonitoringAccessType: sql`VALUES(\`onlineMonitoringAccessType\`)`,
              onlineMonitoring: sql`VALUES(\`onlineMonitoring\`)`,
              onlineMonitoringGrantedUsername: sql`VALUES(\`onlineMonitoringGrantedUsername\`)`,
              onlineMonitoringUsername: sql`VALUES(\`onlineMonitoringUsername\`)`,
              onlineMonitoringSystemName: sql`VALUES(\`onlineMonitoringSystemName\`)`,
              onlineMonitoringSystemId: sql`VALUES(\`onlineMonitoringSystemId\`)`,
              onlineMonitoringPassword: sql`VALUES(\`onlineMonitoringPassword\`)`,
              onlineMonitoringWebsiteApiLink: sql`VALUES(\`onlineMonitoringWebsiteApiLink\`)`,
              onlineMonitoringEntryMethod: sql`VALUES(\`onlineMonitoringEntryMethod\`)`,
              onlineMonitoringNotes: sql`VALUES(\`onlineMonitoringNotes\`)`,
              onlineMonitoringSelfReport: sql`VALUES(\`onlineMonitoringSelfReport\`)`,
              onlineMonitoringRgmInfo: sql`VALUES(\`onlineMonitoringRgmInfo\`)`,
              onlineMonitoringNoSubmitGeneration: sql`VALUES(\`onlineMonitoringNoSubmitGeneration\`)`,
              systemOnline: sql`VALUES(\`systemOnline\`)`,
              lastReportedOnlineDate: sql`VALUES(\`lastReportedOnlineDate\`)`,
              abpApplicationId: sql`VALUES(\`abpApplicationId\`)`,
              abpAcSizeKw: sql`VALUES(\`abpAcSizeKw\`)`,
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
 * current build — i.e., systems that disappeared from the input
 * between this build and the prior one. Returns the number of
 * deleted rows for observability (the orphan-sweep metric).
 *
 * Called by PR-C-2's orchestrator AFTER `upsertMonitoringDetailsFacts`
 * has written the current build's rows. Together this guarantees
 * the table reflects EXACTLY the systems in the latest successful
 * build — no orphan accumulation across builds.
 */
export async function deleteOrphanedMonitoringDetailsFacts(
  scopeId: string,
  currentBuildId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await withDbRetry(
    "delete orphaned dashboard monitoring details facts",
    async () =>
      db
        .delete(solarRecDashboardMonitoringDetailsFacts)
        .where(
          and(
            eq(solarRecDashboardMonitoringDetailsFacts.scopeId, scopeId),
            ne(solarRecDashboardMonitoringDetailsFacts.buildId, currentBuildId)
          )
        )
  );
  return getAffectedRows(result);
}

/**
 * Fetch a paginated page of fact rows for a scope. Cursor is
 * `systemKey`; rows are sorted by `systemKey ASC` so the page
 * boundary is stable across requests.
 *
 * `limit` is bounded server-side. PR-C-3's proc layer will
 * additionally clamp at the wire-payload contract (typically
 * `<= 1000` rows per page given each row's ~20 columns and free-
 * form text fields).
 *
 * Returns rows for caller-side `nextCursor` derivation: caller
 * picks `rows.at(-1)?.systemKey` as the next cursor IFF
 * `rows.length === limit`.
 */
export async function getMonitoringDetailsFactsPage(
  scopeId: string,
  options: {
    cursorAfter?: string | null;
    limit: number;
  }
): Promise<SolarRecDashboardMonitoringDetailsFact[]> {
  const db = await getDb();
  if (!db) return [];
  const { cursorAfter, limit } = options;
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  return withDbRetry(
    "get dashboard monitoring details facts page",
    async () =>
      db
        .select()
        .from(solarRecDashboardMonitoringDetailsFacts)
        .where(
          cursorAfter
            ? and(
                eq(solarRecDashboardMonitoringDetailsFacts.scopeId, scopeId),
                gt(
                  solarRecDashboardMonitoringDetailsFacts.systemKey,
                  cursorAfter
                )
              )
            : eq(solarRecDashboardMonitoringDetailsFacts.scopeId, scopeId)
        )
        .orderBy(solarRecDashboardMonitoringDetailsFacts.systemKey)
        .limit(safeLimit)
  );
}

/**
 * Fetch fact rows for a specific set of system keys. Used by the
 * "details for these systems" lookup (e.g., a tab that has a
 * filtered subset of systems and needs their monitoring details
 * without paginating the whole scope).
 *
 * `systemKeys` is bounded by the caller; this helper just dispatches
 * the IN-list. PR-C-3's proc layer will cap at e.g. 1000 keys.
 *
 * Returns an empty array on `systemKeys.length === 0` to avoid an
 * empty IN-list query (TiDB rejects `WHERE x IN ()`).
 */
export async function getMonitoringDetailsFactsBySystemKeys(
  scopeId: string,
  systemKeys: string[]
): Promise<SolarRecDashboardMonitoringDetailsFact[]> {
  if (systemKeys.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get dashboard monitoring details facts by keys",
    async () =>
      db
        .select()
        .from(solarRecDashboardMonitoringDetailsFacts)
        .where(
          and(
            eq(solarRecDashboardMonitoringDetailsFacts.scopeId, scopeId),
            inArray(
              solarRecDashboardMonitoringDetailsFacts.systemKey,
              systemKeys
            )
          )
        )
  );
}

/**
 * Count fact rows for a scope. Useful for:
 *   - PR-C-2's orchestrator logging "wrote N facts in this build."
 *   - PR-C-3's proc returning a `totalCount` alongside the first
 *     page so the client can render "N systems" without paginating
 *     to the end.
 *   - The Phase 1 dashboard guardrails / observability surface.
 */
export async function getMonitoringDetailsFactsCount(
  scopeId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await withDbRetry(
    "count dashboard monitoring details facts",
    async () =>
      db
        .select({ n: sql<number>`COUNT(*)`.as("n") })
        .from(solarRecDashboardMonitoringDetailsFacts)
        .where(
          eq(solarRecDashboardMonitoringDetailsFacts.scopeId, scopeId)
        )
  );
  const first = rows[0];
  if (!first) return 0;
  // Drizzle returns COUNT() as a string in some MySQL drivers; coerce.
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
 * an OkPacket-shaped object containing `affectedRows`. The shape
 * isn't exposed in `@drizzle-orm`'s types as a discriminated
 * union, so we narrow defensively. Mirrors the helper in
 * `dashboardCsvExportJobs.ts` + `solarRecDashboardBuilds.ts`.
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
