import { nanoid } from "nanoid";
import { eq, and, asc, desc, gte, sql, getDb, withDbRetry } from "./_core";
import {
  monitoringApiRuns,
  monitoringBatchRuns,
  InsertMonitoringApiRun,
} from "../../drizzle/schema";

// ── Monitoring API Runs ─────────────────────────────────────────────

type MonitoringApiRunRow = typeof monitoringApiRuns.$inferSelect;

function resultRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}

function resultNumber(result: unknown, key: string): number {
  const [row] = resultRows<Record<string, unknown>>(result);
  const value = row?.[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function getDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates.reverse();
}

function formatDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
  });
}

export async function upsertMonitoringApiRun(data: InsertMonitoringApiRun) {
  const db = await getDb();
  if (!db) return;
  if (!data.scopeId) {
    throw new Error("upsertMonitoringApiRun: scopeId is required");
  }
  await withDbRetry("upsert monitoring api run", async () => {
    // Lookup matches the scope-aware unique index
    // (scopeId, provider, connectionId, siteId, dateKey). connectionId is
    // nullable in the schema; legacy rows exist with NULL, so we use
    // `IS NULL`-safe matching for that case.
    const connectionIdPredicate =
      data.connectionId === null || data.connectionId === undefined
        ? sql`${monitoringApiRuns.connectionId} IS NULL`
        : eq(monitoringApiRuns.connectionId, data.connectionId);

    const [existing] = await db
      .select({ id: monitoringApiRuns.id })
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.scopeId, data.scopeId),
          eq(monitoringApiRuns.provider, data.provider),
          connectionIdPredicate,
          eq(monitoringApiRuns.siteId, data.siteId),
          eq(monitoringApiRuns.dateKey, data.dateKey)
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(monitoringApiRuns)
        .set({
          status: data.status,
          readingsCount: data.readingsCount,
          lifetimeKwh: data.lifetimeKwh,
          errorMessage: data.errorMessage,
          durationMs: data.durationMs,
          triggeredBy: data.triggeredBy,
          triggeredAt: data.triggeredAt,
          siteName: data.siteName,
          connectionId: data.connectionId,
        })
        .where(eq(monitoringApiRuns.id, existing.id));
    } else {
      await db.insert(monitoringApiRuns).values({ ...data, id: data.id ?? nanoid() });
    }
  });
}

export async function upsertMonitoringApiRuns(rows: InsertMonitoringApiRun[]) {
  const db = await getDb();
  if (!db || rows.length === 0) return;

  const values = rows.map((row) => {
    if (!row.scopeId) {
      throw new Error("upsertMonitoringApiRuns: scopeId is required");
    }
    return { ...row, id: row.id ?? nanoid() };
  });

  const chunkSize = 500;
  for (let index = 0; index < values.length; index += chunkSize) {
    const chunk = values.slice(index, index + chunkSize);
    await withDbRetry("bulk upsert monitoring api runs", async () => {
      await db
        .insert(monitoringApiRuns)
        .values(chunk)
        .onDuplicateKeyUpdate({
          set: {
            status: sql`VALUES(${monitoringApiRuns.status})`,
            readingsCount: sql`VALUES(${monitoringApiRuns.readingsCount})`,
            lifetimeKwh: sql`VALUES(${monitoringApiRuns.lifetimeKwh})`,
            errorMessage: sql`VALUES(${monitoringApiRuns.errorMessage})`,
            durationMs: sql`VALUES(${monitoringApiRuns.durationMs})`,
            triggeredBy: sql`VALUES(${monitoringApiRuns.triggeredBy})`,
            triggeredAt: sql`VALUES(${monitoringApiRuns.triggeredAt})`,
            siteName: sql`VALUES(${monitoringApiRuns.siteName})`,
            connectionId: sql`VALUES(${monitoringApiRuns.connectionId})`,
          },
        });
    });
  }
}

export async function getMonitoringGrid(
  scopeId: string,
  startDate: string,
  endDate: string
) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get monitoring grid", async () =>
    db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.scopeId, scopeId),
          gte(monitoringApiRuns.dateKey, startDate),
          sql`${monitoringApiRuns.dateKey} <= ${endDate}`
        )
      )
      .orderBy(
        asc(monitoringApiRuns.provider),
        asc(monitoringApiRuns.siteId),
        asc(monitoringApiRuns.dateKey)
      )
  );
}

export async function getMonitoringGridPage(
  scopeId: string,
  startDate: string,
  endDate: string,
  options?: {
    search?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{
  rows: MonitoringApiRunRow[];
  totalSites: number;
  limit: number;
  offset: number;
}> {
  const db = await getDb();
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  const offset = Math.max(options?.offset ?? 0, 0);
  if (!db) return { rows: [], totalSites: 0, limit, offset };

  const search = options?.search?.trim() ?? "";
  const searchClause = search
    ? sql`AND (
        ${monitoringApiRuns.provider} LIKE ${`%${search}%`} OR
        ${monitoringApiRuns.siteId} LIKE ${`%${search}%`} OR
        ${monitoringApiRuns.siteName} LIKE ${`%${search}%`}
      )`
    : sql``;

  return withDbRetry("get monitoring grid page", async () => {
    const totalResult = await db.execute(sql`
      SELECT COUNT(*) AS totalSites
      FROM (
        SELECT ${monitoringApiRuns.provider}, ${monitoringApiRuns.siteId}
        FROM ${monitoringApiRuns}
        WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
          AND ${monitoringApiRuns.dateKey} >= ${startDate}
          AND ${monitoringApiRuns.dateKey} <= ${endDate}
          ${searchClause}
        GROUP BY ${monitoringApiRuns.provider}, ${monitoringApiRuns.siteId}
      ) grouped
    `);
    const totalSites = resultNumber(totalResult, "totalSites");

    const keyResult = await db.execute(sql`
      SELECT
        ${monitoringApiRuns.provider} AS provider,
        ${monitoringApiRuns.siteId} AS siteId,
        COALESCE(MAX(${monitoringApiRuns.siteName}), ${monitoringApiRuns.siteId}) AS siteName
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} >= ${startDate}
        AND ${monitoringApiRuns.dateKey} <= ${endDate}
        ${searchClause}
      GROUP BY ${monitoringApiRuns.provider}, ${monitoringApiRuns.siteId}
      ORDER BY ${monitoringApiRuns.provider} ASC, siteName ASC, ${monitoringApiRuns.siteId} ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    const siteKeys = resultRows<{ provider: string; siteId: string }>(keyResult);
    if (siteKeys.length === 0) return { rows: [], totalSites, limit, offset };

    const sitePredicate = sql.join(
      siteKeys.map(
        (site) =>
          sql`(${monitoringApiRuns.provider} = ${site.provider} AND ${monitoringApiRuns.siteId} = ${site.siteId})`
      ),
      sql` OR `
    );

    const rows = await db
      .select()
      .from(monitoringApiRuns)
      .where(
        sql`${monitoringApiRuns.scopeId} = ${scopeId}
          AND ${monitoringApiRuns.dateKey} >= ${startDate}
          AND ${monitoringApiRuns.dateKey} <= ${endDate}
          AND (${sitePredicate})`
      )
      .orderBy(
        asc(monitoringApiRuns.provider),
        asc(monitoringApiRuns.siteId),
        asc(monitoringApiRuns.dateKey)
      );

    return { rows, totalSites, limit, offset };
  });
}

export async function exportMonitoringGridCsv(
  scopeId: string,
  startDate: string,
  endDate: string
): Promise<string> {
  const runs = await getMonitoringGrid(scopeId, startDate, endDate);
  const dates = getDatesInRange(startDate, endDate);
  const rowMap = new Map<
    string,
    {
      provider: string;
      siteId: string;
      siteName: string;
      runs: Map<string, MonitoringApiRunRow>;
    }
  >();

  for (const run of runs) {
    const key = `${run.provider}::${run.siteId}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        provider: run.provider,
        siteId: run.siteId,
        siteName: run.siteName ?? run.siteId,
        runs: new Map(),
      });
    }
    rowMap.get(key)!.runs.set(run.dateKey, run);
  }

  const gridRows = Array.from(rowMap.values()).sort((a, b) =>
    a.provider === b.provider
      ? a.siteName.localeCompare(b.siteName)
      : a.provider.localeCompare(b.provider)
  );

  const headers = ["Provider", "Site ID", "Site Name", ...dates.map(formatDate)];
  const csvRows = gridRows.map((row) => [
    row.provider,
    row.siteId,
    row.siteName,
    ...dates.map((dateKey) => {
      const run = row.runs.get(dateKey);
      if (!run) return "";
      if (run.status === "success") return String(run.readingsCount);
      if (run.status === "error") return "ERROR";
      return "NO_DATA";
    }),
  ]);

  return [headers, ...csvRows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

export async function getMonitoringRunDetail(
  scopeId: string,
  provider: string,
  siteId: string,
  dateKey: string
) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get monitoring run detail", async () => {
    const [row] = await db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.scopeId, scopeId),
          eq(monitoringApiRuns.provider, provider),
          eq(monitoringApiRuns.siteId, siteId),
          eq(monitoringApiRuns.dateKey, dateKey)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

export async function getMonitoringHealthSummary(scopeId: string) {
  const db = await getDb();
  if (!db) return [];
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const startDate = sevenDaysAgo.toISOString().slice(0, 10);

  return withDbRetry("get monitoring health summary", async () =>
    db
      .select({
        provider: monitoringApiRuns.provider,
        totalRuns: sql<number>`COUNT(*)`,
        successCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN 1 ELSE 0 END)`,
        errorCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'error' THEN 1 ELSE 0 END)`,
        noDataCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'no_data' THEN 1 ELSE 0 END)`,
        uniqueSites: sql<number>`COUNT(DISTINCT ${monitoringApiRuns.siteId})`,
        lastSuccess: sql<string>`MAX(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN ${monitoringApiRuns.dateKey} END)`,
      })
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.scopeId, scopeId),
          gte(monitoringApiRuns.dateKey, startDate)
        )
      )
      .groupBy(monitoringApiRuns.provider)
  );
}

export async function getMonitoringOverviewStats(
  scopeId: string,
  todayDateKey: string,
  staleThresholdDateKey: string,
  startDateKey: string
) {
  const db = await getDb();
  if (!db) {
    return { todaySuccess: 0, todayErrors: 0, sitesWithGaps: 0 };
  }

  return withDbRetry("get monitoring overview stats", async () => {
    const todayResult = await db.execute(sql`
      SELECT
        SUM(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN 1 ELSE 0 END) AS todaySuccess,
        SUM(CASE WHEN ${monitoringApiRuns.status} = 'error' THEN 1 ELSE 0 END) AS todayErrors
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} = ${todayDateKey}
    `);

    const staleResult = await db.execute(sql`
      SELECT COUNT(*) AS sitesWithGaps
      FROM (
        SELECT
          ${monitoringApiRuns.provider},
          ${monitoringApiRuns.siteId},
          MAX(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN ${monitoringApiRuns.dateKey} ELSE NULL END) AS lastSuccess
        FROM ${monitoringApiRuns}
        WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
          AND ${monitoringApiRuns.dateKey} >= ${startDateKey}
        GROUP BY ${monitoringApiRuns.provider}, ${monitoringApiRuns.siteId}
        HAVING lastSuccess IS NULL OR lastSuccess < ${staleThresholdDateKey}
      ) grouped
    `);

    return {
      todaySuccess: resultNumber(todayResult, "todaySuccess"),
      todayErrors: resultNumber(todayResult, "todayErrors"),
      sitesWithGaps: resultNumber(staleResult, "sitesWithGaps"),
    };
  });
}

export async function getMonitoringOverview(
  scopeId: string,
  startDate: string,
  endDate: string
): Promise<{
  daily: Array<{
    provider: string;
    connectionId: string;
    dateKey: string;
    attempts: number;
    successes: number;
  }>;
  providerSiteCounts: Array<{ provider: string; siteCount: number }>;
  connectionSiteCounts: Array<{
    provider: string;
    connectionId: string;
    siteCount: number;
  }>;
}> {
  const db = await getDb();
  if (!db) {
    return { daily: [], providerSiteCounts: [], connectionSiteCounts: [] };
  }

  return withDbRetry("get monitoring overview", async () => {
    const dailyResult = await db.execute(sql`
      SELECT
        ${monitoringApiRuns.provider} AS provider,
        COALESCE(${monitoringApiRuns.connectionId}, 'unknown') AS connectionId,
        ${monitoringApiRuns.dateKey} AS dateKey,
        COUNT(*) AS attempts,
        SUM(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN 1 ELSE 0 END) AS successes
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} >= ${startDate}
        AND ${monitoringApiRuns.dateKey} <= ${endDate}
      GROUP BY
        ${monitoringApiRuns.provider},
        COALESCE(${monitoringApiRuns.connectionId}, 'unknown'),
        ${monitoringApiRuns.dateKey}
    `);

    const providerCountResult = await db.execute(sql`
      SELECT
        ${monitoringApiRuns.provider} AS provider,
        COUNT(DISTINCT ${monitoringApiRuns.siteId}) AS siteCount
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} >= ${startDate}
        AND ${monitoringApiRuns.dateKey} <= ${endDate}
      GROUP BY ${monitoringApiRuns.provider}
    `);

    const connectionCountResult = await db.execute(sql`
      SELECT
        ${monitoringApiRuns.provider} AS provider,
        COALESCE(${monitoringApiRuns.connectionId}, 'unknown') AS connectionId,
        COUNT(DISTINCT ${monitoringApiRuns.siteId}) AS siteCount
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} >= ${startDate}
        AND ${monitoringApiRuns.dateKey} <= ${endDate}
      GROUP BY
        ${monitoringApiRuns.provider},
        COALESCE(${monitoringApiRuns.connectionId}, 'unknown')
    `);

    return {
      daily: resultRows<Record<string, unknown>>(dailyResult).map((row) => ({
        provider: String(row.provider ?? ""),
        connectionId: String(row.connectionId ?? "unknown"),
        dateKey: String(row.dateKey ?? ""),
        attempts: Number(row.attempts ?? 0),
        successes: Number(row.successes ?? 0),
      })),
      providerSiteCounts: resultRows<Record<string, unknown>>(providerCountResult).map((row) => ({
        provider: String(row.provider ?? ""),
        siteCount: Number(row.siteCount ?? 0),
      })),
      connectionSiteCounts: resultRows<Record<string, unknown>>(connectionCountResult).map((row) => ({
        provider: String(row.provider ?? ""),
        connectionId: String(row.connectionId ?? "unknown"),
        siteCount: Number(row.siteCount ?? 0),
      })),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Per-site daily overview (Task 7.1)
// ─────────────────────────────────────────────────────────────────────

export type MonitoringDailyOverviewSite = {
  provider: string;
  connectionId: string | null;
  siteId: string;
  siteName: string | null;
  yesterdayStatus: "success" | "error" | "no_data" | "skipped" | null;
  last7Attempts: number;
  last7Successes: number;
  last30Attempts: number;
  last30Successes: number;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | "no_data" | "skipped" | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
};

const MONITORING_DAILY_OVERVIEW_VERSION = "monitoring-daily-overview@1";

/**
 * Per-site daily overview anchored at `anchorDateKey`. Returns one row
 * per (provider, connectionId, siteId) triple that has been seen in
 * the last 30 days, with:
 *
 *   - yesterdayStatus: most recent run status on `anchorDateKey - 1`
 *     (null if no run on that day — which is itself a useful signal)
 *   - last7Attempts / last7Successes: rollup over the last 7 days
 *     ending at `anchorDateKey` inclusive
 *   - last30Attempts / last30Successes: same shape over the last 30
 *   - lastRunAt + lastRunStatus: most recent run regardless of status,
 *     with the dateKey + status of that run
 *   - lastErrorMessage + lastErrorAt: most recent non-success run's
 *     errorMessage and dateKey, so the user can see the most recent
 *     failure context without drilling into a separate detail view.
 *
 * Implemented as two SQL passes: the aggregate (per-site sum/max) and
 * the most-recent-row-per-site (window function). Both queries are
 * indexed on (scopeId, provider, siteId, dateKey) so a 50-site, 30-day
 * scope is well under the < 1s DoD even on a cold buffer pool.
 *
 * Sites that exist in credential metadata but have NEVER run in the
 * last 30 days won't appear here — that's a deliberate choice to keep
 * the list focused on actionable rows. The "Re-run failed" workflow
 * targets visibility-not-coverage: bulk-running every site is the job
 * of the existing `runAll` mutation.
 */
export async function getMonitoringDailyOverview(
  scopeId: string,
  anchorDateKey: string
): Promise<MonitoringDailyOverviewSite[]> {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get monitoring daily overview", async () => {
    // Compute the dateKey thresholds in JS so the SQL is timezone-
    // agnostic. Using the project's "America/Chicago dateKey"
    // semantics is the caller's responsibility (`anchorDateKey` is
    // expected to be a YYYY-MM-DD string in CT).
    const anchor = new Date(`${anchorDateKey}T00:00:00`);
    const yesterday = new Date(anchor);
    yesterday.setDate(yesterday.getDate() - 1);
    const last7Start = new Date(anchor);
    last7Start.setDate(last7Start.getDate() - 6);
    const last30Start = new Date(anchor);
    last30Start.setDate(last30Start.getDate() - 29);

    const yesterdayDateKey = yesterday.toISOString().slice(0, 10);
    const last7StartDateKey = last7Start.toISOString().slice(0, 10);
    const last30StartDateKey = last30Start.toISOString().slice(0, 10);

    // Aggregate pass — one row per (provider, connectionId, siteId).
    const aggregateResult = await db.execute(sql`
      SELECT
        ${monitoringApiRuns.provider} AS provider,
        ${monitoringApiRuns.connectionId} AS connectionId,
        ${monitoringApiRuns.siteId} AS siteId,
        MAX(${monitoringApiRuns.siteName}) AS siteName,
        MAX(CASE WHEN ${monitoringApiRuns.dateKey} = ${yesterdayDateKey}
                 THEN ${monitoringApiRuns.status} END) AS yesterdayStatus,
        SUM(CASE WHEN ${monitoringApiRuns.dateKey} >= ${last7StartDateKey}
                 THEN 1 ELSE 0 END) AS last7Attempts,
        SUM(CASE WHEN ${monitoringApiRuns.dateKey} >= ${last7StartDateKey}
                  AND ${monitoringApiRuns.status} = 'success'
                 THEN 1 ELSE 0 END) AS last7Successes,
        COUNT(*) AS last30Attempts,
        SUM(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN 1 ELSE 0 END)
          AS last30Successes
      FROM ${monitoringApiRuns}
      WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
        AND ${monitoringApiRuns.dateKey} >= ${last30StartDateKey}
        AND ${monitoringApiRuns.dateKey} <= ${anchorDateKey}
      GROUP BY
        ${monitoringApiRuns.provider},
        ${monitoringApiRuns.connectionId},
        ${monitoringApiRuns.siteId}
    `);

    // Most-recent-run pass — window function picks the latest row per
    // (provider, connectionId, siteId) within the 30-day window.
    const lastRunResult = await db.execute(sql`
      SELECT provider, connectionId, siteId, dateKey, status, errorMessage
      FROM (
        SELECT
          ${monitoringApiRuns.provider} AS provider,
          ${monitoringApiRuns.connectionId} AS connectionId,
          ${monitoringApiRuns.siteId} AS siteId,
          ${monitoringApiRuns.dateKey} AS dateKey,
          ${monitoringApiRuns.status} AS status,
          ${monitoringApiRuns.errorMessage} AS errorMessage,
          ROW_NUMBER() OVER (
            PARTITION BY
              ${monitoringApiRuns.provider},
              ${monitoringApiRuns.connectionId},
              ${monitoringApiRuns.siteId}
            ORDER BY ${monitoringApiRuns.dateKey} DESC
          ) AS rn
        FROM ${monitoringApiRuns}
        WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
          AND ${monitoringApiRuns.dateKey} >= ${last30StartDateKey}
          AND ${monitoringApiRuns.dateKey} <= ${anchorDateKey}
      ) ranked
      WHERE rn = 1
    `);

    // Most-recent-error pass — window function picks the latest non-
    // success row per group. Joined into the result so the surfaced
    // error reflects the actual failure context, not just "the last
    // run was an error" (which the lastRun pass already covers).
    const lastErrorResult = await db.execute(sql`
      SELECT provider, connectionId, siteId, dateKey, errorMessage
      FROM (
        SELECT
          ${monitoringApiRuns.provider} AS provider,
          ${monitoringApiRuns.connectionId} AS connectionId,
          ${monitoringApiRuns.siteId} AS siteId,
          ${monitoringApiRuns.dateKey} AS dateKey,
          ${monitoringApiRuns.errorMessage} AS errorMessage,
          ROW_NUMBER() OVER (
            PARTITION BY
              ${monitoringApiRuns.provider},
              ${monitoringApiRuns.connectionId},
              ${monitoringApiRuns.siteId}
            ORDER BY ${monitoringApiRuns.dateKey} DESC
          ) AS rn
        FROM ${monitoringApiRuns}
        WHERE ${monitoringApiRuns.scopeId} = ${scopeId}
          AND ${monitoringApiRuns.dateKey} >= ${last30StartDateKey}
          AND ${monitoringApiRuns.dateKey} <= ${anchorDateKey}
          AND ${monitoringApiRuns.status} != 'success'
          AND ${monitoringApiRuns.errorMessage} IS NOT NULL
      ) ranked
      WHERE rn = 1
    `);

    // Stitch the three result sets into the public shape. Key by a
    // composite "provider|connectionId|siteId" string so null
    // connectionIds participate in lookups consistently.
    const compositeKey = (
      provider: string,
      connectionId: string | null,
      siteId: string
    ) => `${provider}|${connectionId ?? ""}|${siteId}`;

    const lastRunByKey = new Map<
      string,
      { dateKey: string; status: string }
    >();
    for (const row of resultRows<Record<string, unknown>>(lastRunResult)) {
      lastRunByKey.set(
        compositeKey(
          String(row.provider ?? ""),
          row.connectionId == null ? null : String(row.connectionId),
          String(row.siteId ?? "")
        ),
        {
          dateKey: String(row.dateKey ?? ""),
          status: String(row.status ?? ""),
        }
      );
    }

    const lastErrorByKey = new Map<
      string,
      { dateKey: string; errorMessage: string | null }
    >();
    for (const row of resultRows<Record<string, unknown>>(lastErrorResult)) {
      lastErrorByKey.set(
        compositeKey(
          String(row.provider ?? ""),
          row.connectionId == null ? null : String(row.connectionId),
          String(row.siteId ?? "")
        ),
        {
          dateKey: String(row.dateKey ?? ""),
          errorMessage:
            row.errorMessage == null ? null : String(row.errorMessage),
        }
      );
    }

    return resultRows<Record<string, unknown>>(aggregateResult).map((row) => {
      const provider = String(row.provider ?? "");
      const connectionId =
        row.connectionId == null ? null : String(row.connectionId);
      const siteId = String(row.siteId ?? "");
      const key = compositeKey(provider, connectionId, siteId);
      const lastRun = lastRunByKey.get(key);
      const lastError = lastErrorByKey.get(key);

      const yesterdayStatusRaw = row.yesterdayStatus;
      const yesterdayStatus =
        typeof yesterdayStatusRaw === "string" &&
        ["success", "error", "no_data", "skipped"].includes(yesterdayStatusRaw)
          ? (yesterdayStatusRaw as MonitoringDailyOverviewSite["yesterdayStatus"])
          : null;
      const lastRunStatus =
        lastRun && ["success", "error", "no_data", "skipped"].includes(
          lastRun.status
        )
          ? (lastRun.status as MonitoringDailyOverviewSite["lastRunStatus"])
          : null;

      return {
        provider,
        connectionId,
        siteId,
        siteName: row.siteName == null ? null : String(row.siteName),
        yesterdayStatus,
        last7Attempts: Number(row.last7Attempts ?? 0),
        last7Successes: Number(row.last7Successes ?? 0),
        last30Attempts: Number(row.last30Attempts ?? 0),
        last30Successes: Number(row.last30Successes ?? 0),
        lastRunAt: lastRun?.dateKey ?? null,
        lastRunStatus,
        lastErrorMessage: lastError?.errorMessage ?? null,
        lastErrorAt: lastError?.dateKey ?? null,
      };
    });
  });
}

export const MONITORING_DAILY_OVERVIEW_RUNNER_VERSION =
  MONITORING_DAILY_OVERVIEW_VERSION;

/**
 * Delete every monitoringApiRuns row older than `olderThanDateKey`.
 * Called nightly with a 365-day cutoff so the table stays bounded.
 * Deliberately scope-agnostic: the nightly prune runs across every
 * scope's rows at once. Mirrors the pruneSectionEngagement pattern in
 * server/db/engagement.ts.
 */
export async function pruneMonitoringApiRuns(olderThanDateKey: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("prune monitoring api runs", async () => {
    await db
      .delete(monitoringApiRuns)
      .where(sql`${monitoringApiRuns.dateKey} < ${olderThanDateKey}`);
  });
}

// ── Monitoring Batch Runs ───────────────────────────────────────────

export async function createMonitoringBatchRun(data: {
  scopeId: string;
  dateKey: string;
  triggeredBy: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  await withDbRetry("create monitoring batch run", async () => {
    await db.insert(monitoringBatchRuns).values({
      id,
      scopeId: data.scopeId,
      dateKey: data.dateKey,
      status: "running",
      triggeredBy: data.triggeredBy,
      startedAt: new Date(),
    });
  });
  return id;
}

export async function updateMonitoringBatchRun(
  id: string,
  data: Partial<{
    status: "running" | "completed" | "failed";
    totalSites: number;
    successCount: number;
    errorCount: number;
    noDataCount: number;
    currentProvider: string | null;
    currentCredentialName: string | null;
    providersTotal: number;
    providersCompleted: number;
    completedAt: Date;
  }>
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update monitoring batch run", async () => {
    await db.update(monitoringBatchRuns).set(data).where(eq(monitoringBatchRuns.id, id));
  });
}

export async function getMonitoringBatchRun(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get monitoring batch run", async () => {
    const [row] = await db.select().from(monitoringBatchRuns).where(eq(monitoringBatchRuns.id, id)).limit(1);
    return row ?? null;
  });
}

/**
 * Returns the most recently created MonitoringBatchRun for a scope
 * (or null). Used by the debug endpoint.
 */
export async function getLatestMonitoringBatchRun(scopeId: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get latest monitoring batch run", async () => {
    const [row] = await db
      .select()
      .from(monitoringBatchRuns)
      .where(eq(monitoringBatchRuns.scopeId, scopeId))
      .orderBy(desc(monitoringBatchRuns.createdAt))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Mark all MonitoringBatchRun rows that are still in `running` status as
 * `failed`. Called on server startup to clean up orphaned batches from
 * the prior Node process (killed by deploy, crash, OOM, etc.) — without
 * this, the dashboard's UI polls these rows forever.
 *
 * Deliberately scope-agnostic: a startup sweep across every scope's
 * orphans is correct because no process survived to own them.
 *
 * Returns the number of rows updated.
 */
export async function failOrphanedRunningBatches(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  return withDbRetry("fail orphaned running batches", async () => {
    const runningRows = await db
      .select({ id: monitoringBatchRuns.id })
      .from(monitoringBatchRuns)
      .where(eq(monitoringBatchRuns.status, "running"));

    if (runningRows.length === 0) return 0;

    await db
      .update(monitoringBatchRuns)
      .set({
        status: "failed",
        currentProvider: null,
        currentCredentialName: null,
        completedAt: new Date(),
      })
      .where(eq(monitoringBatchRuns.status, "running"));

    return runningRows.length;
  });
}
