/**
 * DB helpers for the `sleepNotes` table — per-night freeform journal.
 *
 * Kept in its own domain module (not habits.ts) because the sleep feature
 * spans the Habits and Health pages and will likely grow (quality scoring,
 * auto-tags). One (userId, dateKey) row; upsert semantics.
 */

import { nanoid } from "nanoid";
import { eq, and, desc, gte, sql, getDb, withDbRetry } from "./_core";
import {
  sleepNotes,
  type InsertSleepNote,
  type SleepNote,
} from "../../drizzle/schema";

export async function getSleepNoteByDate(
  userId: number,
  dateKey: string
): Promise<SleepNote | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("load sleep note", async () =>
    db
      .select()
      .from(sleepNotes)
      .where(and(eq(sleepNotes.userId, userId), eq(sleepNotes.dateKey, dateKey)))
      .limit(1)
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Insert or overwrite the note for a given (userId, dateKey). Pass `null`
 * for `tags` or `notes` to clear them; omit the field to leave unchanged
 * (only applied on update path).
 */
export async function upsertSleepNote(input: {
  userId: number;
  dateKey: string;
  tags?: string | null;
  notes?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const existing = await getSleepNoteByDate(input.userId, input.dateKey);
  const now = new Date();

  if (!existing) {
    const row: InsertSleepNote = {
      id: nanoid(),
      userId: input.userId,
      dateKey: input.dateKey,
      tags: input.tags ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await withDbRetry("insert sleep note", async () => {
      await db.insert(sleepNotes).values(row);
    });
    return;
  }

  const payload: Record<string, unknown> = { updatedAt: now };
  if (input.tags !== undefined) payload.tags = input.tags;
  if (input.notes !== undefined) payload.notes = input.notes;

  await withDbRetry("update sleep note", async () => {
    await db.update(sleepNotes).set(payload).where(eq(sleepNotes.id, existing.id));
  });
}

/**
 * All notes for `userId` within the inclusive [start, end] window,
 * ordered most-recent first.
 */
export async function listSleepNotesRange(
  userId: number,
  startDateKey: string,
  endDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list sleep notes in range", async () =>
    db
      .select()
      .from(sleepNotes)
      .where(
        and(
          eq(sleepNotes.userId, userId),
          gte(sleepNotes.dateKey, startDateKey),
          sql`${sleepNotes.dateKey} <= ${endDateKey}`
        )
      )
      .orderBy(desc(sleepNotes.dateKey))
  );
}
