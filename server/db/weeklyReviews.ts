/**
 * Phase E (2026-04-28) — DB helpers for AI Weekly Review.
 *
 * Three concerns:
 *   1. Read 7 days of `dailySnapshots` for the summarizer.
 *   2. Upsert `weeklyReviews` (idempotent on (userId, weekKey)) so
 *      the cron can re-run without growing the table.
 *   3. Read for the dashboard surface (getLatest, list).
 */

import { eq, and, desc, gte, lte, getDb, withDbRetry } from "./_core";
import {
  dailySnapshots,
  weeklyReviews,
  type DailySnapshot,
  type InsertWeeklyReview,
  type WeeklyReview,
} from "../../drizzle/schema";

export async function listDailySnapshotsForRange(
  userId: number,
  startDateKey: string,
  endDateKey: string
): Promise<DailySnapshot[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list daily snapshots in range", async () =>
    db
      .select()
      .from(dailySnapshots)
      .where(
        and(
          eq(dailySnapshots.userId, userId),
          gte(dailySnapshots.dateKey, startDateKey),
          lte(dailySnapshots.dateKey, endDateKey)
        )
      )
      .orderBy(dailySnapshots.dateKey)
  );
}

export async function upsertWeeklyReview(
  row: InsertWeeklyReview
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("upsert weekly review", async () => {
    await db
      .insert(weeklyReviews)
      .values(row)
      .onDuplicateKeyUpdate({
        set: {
          // Preserve `id` and `createdAt` on the original row; update
          // every other field with the new values. The unique key is
          // (userId, weekKey) so this matches naturally.
          status: row.status,
          headline: row.headline ?? null,
          contentMarkdown: row.contentMarkdown ?? null,
          metricsJson: row.metricsJson ?? null,
          model: row.model ?? null,
          daysWithData: row.daysWithData,
          weekStartDateKey: row.weekStartDateKey,
          weekEndDateKey: row.weekEndDateKey,
          generatedAt: row.generatedAt ?? null,
          errorMessage: row.errorMessage ?? null,
          updatedAt: row.updatedAt ?? new Date(),
        },
      });
  });
}

export async function getLatestWeeklyReview(
  userId: number
): Promise<WeeklyReview | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get latest weekly review", async () =>
    db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.userId, userId))
      .orderBy(desc(weeklyReviews.weekKey))
      .limit(1)
  );
  return rows[0] ?? null;
}

export async function getWeeklyReview(
  userId: number,
  weekKey: string
): Promise<WeeklyReview | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get weekly review", async () =>
    db
      .select()
      .from(weeklyReviews)
      .where(
        and(
          eq(weeklyReviews.userId, userId),
          eq(weeklyReviews.weekKey, weekKey)
        )
      )
      .limit(1)
  );
  return rows[0] ?? null;
}

export async function listWeeklyReviewsForUser(
  userId: number,
  limit = 12
): Promise<WeeklyReview[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list weekly reviews", async () =>
    db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.userId, userId))
      .orderBy(desc(weeklyReviews.weekKey))
      .limit(Math.min(Math.max(limit, 1), 100))
  );
}
