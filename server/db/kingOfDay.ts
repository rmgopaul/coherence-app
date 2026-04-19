/**
 * Database helpers for the `userKingOfDay` table.
 *
 * One row per (userId, dateKey). `selectKingOfDay` in the router
 * inserts an `auto` row when none exists; `pin` upserts a `manual`
 * row; `unpin` deletes.
 */
import { nanoid } from "nanoid";
import { and, eq, getDb, withDbRetry } from "./_core";
import {
  userKingOfDay,
  type InsertUserKingOfDay,
  type UserKingOfDay,
} from "../../drizzle/schema";

export async function getKingOfDay(
  userId: number,
  dateKey: string
): Promise<UserKingOfDay | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("load king of day", async () =>
    db
      .select()
      .from(userKingOfDay)
      .where(
        and(
          eq(userKingOfDay.userId, userId),
          eq(userKingOfDay.dateKey, dateKey)
        )
      )
      .limit(1)
  );

  return rows[0] ?? null;
}

export interface KingOfDayInput {
  userId: number;
  dateKey: string;
  source: "auto" | "manual" | "ai";
  title: string;
  reason?: string | null;
  taskId?: string | null;
  eventId?: string | null;
  pinned?: boolean;
}

export async function upsertKingOfDay(
  input: KingOfDayInput
): Promise<UserKingOfDay | null> {
  const db = await getDb();
  if (!db) return null;

  const now = new Date();
  const existing = await getKingOfDay(input.userId, input.dateKey);

  if (existing) {
    await withDbRetry("update king of day", async () => {
      await db
        .update(userKingOfDay)
        .set({
          source: input.source,
          title: input.title,
          reason: input.reason ?? null,
          taskId: input.taskId ?? null,
          eventId: input.eventId ?? null,
          pinnedAt: input.pinned ? now : existing.pinnedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(userKingOfDay.userId, input.userId),
            eq(userKingOfDay.dateKey, input.dateKey)
          )
        );
    });
    return getKingOfDay(input.userId, input.dateKey);
  }

  const id = nanoid();
  const payload: InsertUserKingOfDay = {
    id,
    userId: input.userId,
    dateKey: input.dateKey,
    source: input.source,
    title: input.title,
    reason: input.reason ?? null,
    taskId: input.taskId ?? null,
    eventId: input.eventId ?? null,
    pinnedAt: input.pinned ? now : null,
  };

  await withDbRetry("insert king of day", async () => {
    await db.insert(userKingOfDay).values(payload);
  });

  return getKingOfDay(input.userId, input.dateKey);
}

export async function deleteKingOfDay(
  userId: number,
  dateKey: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete king of day", async () => {
    await db
      .delete(userKingOfDay)
      .where(
        and(
          eq(userKingOfDay.userId, userId),
          eq(userKingOfDay.dateKey, dateKey)
        )
      );
  });
}
