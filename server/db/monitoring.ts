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
