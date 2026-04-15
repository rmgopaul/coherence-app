import { nanoid } from "nanoid";
import {
  eq,
  desc,
  getDb,
  withDbRetry,
  ensureUserFeedbackTable,
} from "./_core";
import { userFeedback, InsertUserFeedback } from "../../drizzle/schema";

// ── User Feedback ──

export async function submitUserFeedback(
  input: Omit<InsertUserFeedback, "id" | "createdAt" | "updatedAt">
) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return null;

  const row: InsertUserFeedback = {
    id: nanoid(),
    userId: input.userId,
    pagePath: input.pagePath,
    sectionId: input.sectionId ?? null,
    category: input.category ?? "improvement",
    note: input.note,
    status: input.status ?? "open",
    contextJson: input.contextJson ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withDbRetry("submit user feedback", async () => {
    await db.insert(userFeedback).values(row);
  });

  return row;
}

export async function listUserFeedback(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return [];

  return withDbRetry("list user feedback", async () =>
    db
      .select()
      .from(userFeedback)
      .where(eq(userFeedback.userId, userId))
      .orderBy(desc(userFeedback.createdAt))
      .limit(Math.max(1, Math.min(500, limit)))
  );
}

export async function listRecentUserFeedback(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return [];

  return withDbRetry("list recent user feedback", async () =>
    db
      .select()
      .from(userFeedback)
      .orderBy(desc(userFeedback.createdAt))
      .limit(Math.max(1, Math.min(500, limit)))
  );
}
