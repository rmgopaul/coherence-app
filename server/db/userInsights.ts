/**
 * User insights — AI-generated cross-domain correlations stored as
 * JSON. One row per (userId, dateKey) so we cache once per day and
 * regenerate cheaply on demand.
 */
import { eq, and, desc, sql, getDb, withDbRetry } from "./_core";
import {
  userInsights,
  type UserInsight,
  type InsertUserInsight,
} from "../../drizzle/schemas/core";

export async function getLatestUserInsight(
  userId: number
): Promise<UserInsight | null> {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get latest user insight", async () => {
    const rows = await db
      .select()
      .from(userInsights)
      .where(eq(userInsights.userId, userId))
      .orderBy(desc(userInsights.generatedAt))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function getUserInsightForDate(
  userId: number,
  dateKey: string
): Promise<UserInsight | null> {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get user insight for date", async () => {
    const rows = await db
      .select()
      .from(userInsights)
      .where(
        and(eq(userInsights.userId, userId), eq(userInsights.dateKey, dateKey))
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listRecentUserInsights(
  userId: number,
  limit = 14
): Promise<UserInsight[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(limit, 60));
  return withDbRetry("list recent user insights", async () =>
    db
      .select()
      .from(userInsights)
      .where(eq(userInsights.userId, userId))
      .orderBy(desc(userInsights.generatedAt))
      .limit(safeLimit)
  );
}

/**
 * Upsert today's insight. We only keep one row per (userId, dateKey),
 * so a regenerate replaces in place rather than appending. The
 * `daily_reflections`-style upsert semantics keep the table small
 * for users who hit "Refresh insights" repeatedly.
 */
export async function upsertUserInsight(row: InsertUserInsight): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date();
  await withDbRetry("upsert user insight", async () => {
    await db
      .insert(userInsights)
      .values({
        ...row,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          generatedAt: row.generatedAt ?? now,
          rangeStartKey: row.rangeStartKey,
          rangeEndKey: row.rangeEndKey,
          model: row.model,
          daysAnalyzed: row.daysAnalyzed,
          insightsJson: row.insightsJson,
          promptVersion: row.promptVersion,
          status: row.status,
          errorMessage: row.errorMessage ?? null,
          updatedAt: now,
        },
      });
  });
}

/**
 * Aggregated daily record fed to Anthropic. The raw row tables don't
 * line up by dateKey, so we project everything onto a single
 * dateKey-keyed shape here.
 */
export interface DailyAggregate {
  dateKey: string;
  supplements: string[]; // names taken that day, deduped
  habits: string[]; // habit names completed that day
  whoopRecovery: number | null;
  whoopHrv: number | null;
  whoopSleepPerf: number | null;
  whoopSleepHours: number | null;
  whoopStrain: number | null;
  samsungEnergy: number | null;
  samsungSleepScore: number | null;
  samsungSleepHours: number | null;
  reflectionEnergy: number | null;
  reflectionWentWell: string | null;
  reflectionDidntGo: string | null;
  todoistCompleted: number | null;
}
