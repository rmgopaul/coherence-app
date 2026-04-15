import { eq, and, desc, getDb, withDbRetry } from "./_core";
import { dailyHealthMetrics, InsertDailyHealthMetric } from "../../drizzle/schema";

export async function getDailyMetricByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load daily metric", async () =>
    db
      .select()
      .from(dailyHealthMetrics)
      .where(and(eq(dailyHealthMetrics.userId, userId), eq(dailyHealthMetrics.dateKey, dateKey)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function upsertDailyMetric(metric: InsertDailyHealthMetric) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load daily metric before upsert", async () =>
    db
      .select({ id: dailyHealthMetrics.id })
      .from(dailyHealthMetrics)
      .where(
        and(eq(dailyHealthMetrics.userId, metric.userId), eq(dailyHealthMetrics.dateKey, metric.dateKey))
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update daily metric", async () => {
      await db
        .update(dailyHealthMetrics)
        .set({
          whoopRecoveryScore: metric.whoopRecoveryScore,
          whoopDayStrain: metric.whoopDayStrain,
          whoopSleepHours: metric.whoopSleepHours,
          whoopHrvMs: metric.whoopHrvMs,
          whoopRestingHr: metric.whoopRestingHr,
          samsungSteps: metric.samsungSteps,
          samsungSleepHours: metric.samsungSleepHours,
          samsungSpo2AvgPercent: metric.samsungSpo2AvgPercent,
          samsungSleepScore: metric.samsungSleepScore,
          samsungEnergyScore: metric.samsungEnergyScore,
          todoistCompletedCount: metric.todoistCompletedCount,
          updatedAt: now,
        })
        .where(eq(dailyHealthMetrics.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert daily metric", async () => {
    await db.insert(dailyHealthMetrics).values({
      ...metric,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function getDailyMetricsHistory(userId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list daily metrics history", async () =>
    db
      .select()
      .from(dailyHealthMetrics)
      .where(eq(dailyHealthMetrics.userId, userId))
      .orderBy(desc(dailyHealthMetrics.dateKey))
      .limit(limit)
  );
}
