import { nanoid } from "nanoid";
import { eq, and, asc, desc, gte, sql, getDb, withDbRetry } from "./_core";
import {
  monitoringApiRuns,
  monitoringBatchRuns,
  InsertMonitoringApiRun,
} from "../../drizzle/schema";

// ── Monitoring API Runs ─────────────────────────────────────────────

export async function upsertMonitoringApiRun(data: InsertMonitoringApiRun) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("upsert monitoring api run", async () => {
    // Lookup now matches the updated unique index
    // (provider, connectionId, siteId, dateKey). Previously the upsert
    // ignored connectionId and one run would overwrite another when
    // multiple credentials managed the same provider+site+date.
    //
    // connectionId is nullable in the schema, but legacy rows exist with
    // NULL. We use `IS NULL`-safe matching for that case.
    const connectionIdPredicate =
      data.connectionId === null || data.connectionId === undefined
        ? sql`${monitoringApiRuns.connectionId} IS NULL`
        : eq(monitoringApiRuns.connectionId, data.connectionId);

    const [existing] = await db
      .select({ id: monitoringApiRuns.id })
      .from(monitoringApiRuns)
      .where(
        and(
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

export async function getMonitoringGrid(startDate: string, endDate: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get monitoring grid", async () =>
    db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          gte(monitoringApiRuns.dateKey, startDate),
          sql`${monitoringApiRuns.dateKey} <= ${endDate}`
        )
      )
      .orderBy(asc(monitoringApiRuns.provider), asc(monitoringApiRuns.siteId), asc(monitoringApiRuns.dateKey))
  );
}

export async function getMonitoringRunDetail(provider: string, siteId: string, dateKey: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get monitoring run detail", async () => {
    const [row] = await db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.provider, provider),
          eq(monitoringApiRuns.siteId, siteId),
          eq(monitoringApiRuns.dateKey, dateKey)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

export async function getMonitoringHealthSummary() {
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
      .where(gte(monitoringApiRuns.dateKey, startDate))
      .groupBy(monitoringApiRuns.provider)
  );
}

/**
 * Delete every monitoringApiRuns row older than `olderThanDateKey`.
 * Called nightly with a 365-day cutoff so the table stays bounded.
 * Mirrors the pruneSectionEngagement pattern in server/db/engagement.ts.
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
  dateKey: string;
  triggeredBy: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  await withDbRetry("create monitoring batch run", async () => {
    await db.insert(monitoringBatchRuns).values({
      id,
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

/** Returns the most recently created MonitoringBatchRun (or null). Used by the debug endpoint. */
export async function getLatestMonitoringBatchRun() {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get latest monitoring batch run", async () => {
    const [row] = await db
      .select()
      .from(monitoringBatchRuns)
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
