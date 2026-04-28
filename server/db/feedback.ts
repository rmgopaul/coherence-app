import { nanoid } from "nanoid";
import {
  and,
  eq,
  desc,
  getDb,
  withDbRetry,
  ensureUserFeedbackTable,
} from "./_core";
import { userFeedback, InsertUserFeedback } from "../../drizzle/schema";

// ── User Feedback ──

/**
 * Phase E (2026-04-28) — the recognized feedback statuses now live
 * in `shared/feedback.helpers.ts` so the server's zod enum and the
 * client's filter/sort logic share one source of truth. Re-exported
 * here so existing server-side imports keep working.
 */
export {
  FEEDBACK_STATUSES,
  isFeedbackStatus,
  summarizeFeedbackByStatus,
} from "../../shared/feedback.helpers";
export type { FeedbackStatus } from "../../shared/feedback.helpers";

// Local alias for the type so the function signatures below don't need
// to re-import the same name twice.
import type { FeedbackStatus } from "../../shared/feedback.helpers";

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

/**
 * Phase E (2026-04-28) — admin status update for the feedback
 * review dashboard. Returns `true` when a row was updated, `false`
 * when no row matched the id (so the proc can surface a 404).
 *
 * NOTE: not scoped to a userId — this is admin-only and the
 * dashboard surfaces feedback from every user. The router layer
 * gates with `adminProcedure` which is the only access path.
 */
export async function updateUserFeedbackStatus(
  id: string,
  status: FeedbackStatus
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return false;

  const result = await withDbRetry("update user feedback status", async () =>
    db
      .update(userFeedback)
      .set({ status, updatedAt: new Date() })
      .where(eq(userFeedback.id, id))
  );
  // mysql2 → drizzle returns a header with affectedRows; rowCount
  // covers the postgres-flavored variant. Either > 0 means we hit
  // the row.
  const affected =
    (result as unknown as { affectedRows?: number }).affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

// `and` import retained for future composite-WHERE helpers (e.g.
// scoping by status during admin filtering); keeps the import shape
// consistent with sibling db modules.
void and;
