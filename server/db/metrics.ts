import { nanoid } from "nanoid";
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

/**
 * Upsert *only* the Samsung Health columns of a daily metric row,
 * preserving any whoop* / todoist* values already present.
 *
 * Called by the Samsung Health webhook ingest so the phone (which
 * reads from `dailyHealthMetrics`) sees the same values the web app
 * reads from the integration metadata, without waiting for the
 * nightly snapshot job. Skipping the WHOOP / Todoist HTTP fetches
 * that `captureDailySnapshotForUser` performs keeps the webhook fast
 * enough for the 31-row batch endpoint.
 *
 * **Field-level merge semantics:**
 * - **Record-derived fields** (`samsungSteps`, `samsungSleepHours`,
 *   `samsungSpo2AvgPercent`) preserve previously-stored values when
 *   the incoming field is null. A flaky Health Connect read or a
 *   historical day without that record type shouldn't clobber real
 *   data we collected on an earlier sync.
 * - **Manual-score fields** (`samsungSleepScore`, `samsungEnergyScore`)
 *   are inherently per-date and ALWAYS overwrite. They reflect the
 *   user's current manual entry for the row's dateKey. The caller
 *   (`ingestSamsungPayload`) only passes non-null values when the
 *   payload's date is the live "today"; for historical backfill it
 *   passes null, and that null MUST land in the row — otherwise
 *   today's score gets propagated back to past days (the 2026-04-25
 *   bug).
 */
export async function upsertSamsungDailyMetric(args: {
  userId: number;
  dateKey: string;
  samsungSteps: number | null;
  samsungSleepHours: number | null;
  samsungSpo2AvgPercent: number | null;
  samsungSleepScore: number | null;
  samsungEnergyScore: number | null;
}) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load daily metric before samsung upsert", async () =>
    db
      .select()
      .from(dailyHealthMetrics)
      .where(and(eq(dailyHealthMetrics.userId, args.userId), eq(dailyHealthMetrics.dateKey, args.dateKey)))
      .limit(1)
  );

  const merged = {
    samsungSteps: args.samsungSteps ?? existing[0]?.samsungSteps ?? null,
    samsungSleepHours: args.samsungSleepHours ?? existing[0]?.samsungSleepHours ?? null,
    samsungSpo2AvgPercent: args.samsungSpo2AvgPercent ?? existing[0]?.samsungSpo2AvgPercent ?? null,
    // Manual scores: always overwrite with the incoming value (incl.
    // null). See the doc comment above for why preservation is wrong
    // here — historical backfill MUST be able to clear stale scores.
    samsungSleepScore: args.samsungSleepScore,
    samsungEnergyScore: args.samsungEnergyScore,
  };

  if (existing.length > 0) {
    await withDbRetry("update samsung daily metric", async () => {
      await db
        .update(dailyHealthMetrics)
        .set({ ...merged, updatedAt: now })
        .where(eq(dailyHealthMetrics.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert samsung daily metric", async () => {
    await db.insert(dailyHealthMetrics).values({
      id: nanoid(),
      userId: args.userId,
      dateKey: args.dateKey,
      whoopRecoveryScore: null,
      whoopDayStrain: null,
      whoopSleepHours: null,
      whoopHrvMs: null,
      whoopRestingHr: null,
      ...merged,
      todoistCompletedCount: null,
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
