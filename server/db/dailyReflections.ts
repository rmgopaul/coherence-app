/**
 * DB helpers for the user's nightly reflection journal.
 *
 * `dailyReflections` is upsert-keyed on (userId, dateKey) so the
 * end-of-day flow can re-save without growing the table — the user
 * can refine "what went well" / "tomorrow's one thing" through the
 * evening and the row updates in place.
 */

import { eq, and, desc, getDb, withDbRetry } from "./_core";
import { nanoid } from "nanoid";
import {
  dailyReflections,
  type DailyReflection,
  type InsertDailyReflection,
} from "../../drizzle/schema";

export async function getReflectionByDate(
  userId: number,
  dateKey: string,
): Promise<DailyReflection | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get reflection by date", async () =>
    db
      .select()
      .from(dailyReflections)
      .where(
        and(
          eq(dailyReflections.userId, userId),
          eq(dailyReflections.dateKey, dateKey),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listRecentReflections(
  userId: number,
  limit = 14,
): Promise<DailyReflection[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list recent reflections", async () =>
    db
      .select()
      .from(dailyReflections)
      .where(eq(dailyReflections.userId, userId))
      .orderBy(desc(dailyReflections.dateKey))
      .limit(limit),
  );
}

export async function upsertReflection(
  args: Pick<
    InsertDailyReflection,
    "userId" | "dateKey" | "energyLevel" | "wentWell" | "didntGo" | "tomorrowOneThing"
  >,
): Promise<DailyReflection | null> {
  const db = await getDb();
  if (!db) return null;
  const existing = await getReflectionByDate(args.userId, args.dateKey);
  const now = new Date();

  if (existing) {
    await withDbRetry("update reflection", async () => {
      await db
        .update(dailyReflections)
        .set({
          energyLevel: args.energyLevel ?? existing.energyLevel,
          wentWell: args.wentWell ?? existing.wentWell,
          didntGo: args.didntGo ?? existing.didntGo,
          tomorrowOneThing: args.tomorrowOneThing ?? existing.tomorrowOneThing,
          capturedAt: now,
          updatedAt: now,
        })
        .where(eq(dailyReflections.id, existing.id));
    });
    return getReflectionByDate(args.userId, args.dateKey);
  }

  const id = nanoid();
  await withDbRetry("insert reflection", async () => {
    await db.insert(dailyReflections).values({
      id,
      userId: args.userId,
      dateKey: args.dateKey,
      energyLevel: args.energyLevel,
      wentWell: args.wentWell,
      didntGo: args.didntGo,
      tomorrowOneThing: args.tomorrowOneThing,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
  return getReflectionByDate(args.userId, args.dateKey);
}
