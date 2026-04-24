import { nanoid } from "nanoid";
import { eq, and, sql, getDb, withDbRetry } from "./_core";
import { dailyJobClaims } from "../../drizzle/schema";

/**
 * Attempt to claim today's slot for the given runKey. Returns the claim
 * row on success, or null if another instance already claimed it.
 *
 * The unique (dateKey, runKey) index is what serializes callers — the
 * losing INSERT surfaces a duplicate-key error which we catch and
 * translate into a null return.
 */
export async function claimDailyJob(params: {
  dateKey: string;
  runKey: string;
}): Promise<{ id: string } | null> {
  const db = await getDb();
  if (!db) return null;

  return withDbRetry("claim daily job", async () => {
    const id = nanoid();
    try {
      await db.insert(dailyJobClaims).values({
        id,
        dateKey: params.dateKey,
        runKey: params.runKey,
        status: "running",
      });
      return { id };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ER_DUP_ENTRY") {
        return null;
      }
      throw error;
    }
  });
}

export async function completeDailyJob(params: {
  dateKey: string;
  runKey: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("complete daily job", async () => {
    await db
      .update(dailyJobClaims)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(dailyJobClaims.dateKey, params.dateKey),
          eq(dailyJobClaims.runKey, params.runKey),
        ),
      );
  });
}

export async function failDailyJob(params: {
  dateKey: string;
  runKey: string;
  error: unknown;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const message =
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === "string"
        ? params.error
        : "Unknown error";
  await withDbRetry("fail daily job", async () => {
    await db
      .update(dailyJobClaims)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message.slice(0, 8000),
      })
      .where(
        and(
          eq(dailyJobClaims.dateKey, params.dateKey),
          eq(dailyJobClaims.runKey, params.runKey),
        ),
      );
  });
}

export async function hasDailyJobClaim(params: {
  dateKey: string;
  runKey: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  return withDbRetry("check daily job claim", async () => {
    const [row] = await db
      .select({ id: dailyJobClaims.id })
      .from(dailyJobClaims)
      .where(
        and(
          eq(dailyJobClaims.dateKey, params.dateKey),
          eq(dailyJobClaims.runKey, params.runKey),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

/**
 * Delete claim rows older than `olderThanDateKey`. One row per job per
 * day: small absolute volume, but still prune to keep the table bounded.
 * Mirrors pruneMonitoringApiRuns / pruneSectionEngagement.
 */
export async function pruneDailyJobClaims(
  olderThanDateKey: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("prune daily job claims", async () => {
    await db
      .delete(dailyJobClaims)
      .where(sql`${dailyJobClaims.dateKey} < ${olderThanDateKey}`);
  });
}
