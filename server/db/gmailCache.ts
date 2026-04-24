import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { eq, and, sql, getDb, withDbRetry } from "./_core";
import { gmailWaitingOnCache } from "../../drizzle/schema";

/**
 * Stable hash for caching by query params. Normalizing the input here
 * (rather than JSON.stringify of the raw input) means "same request"
 * is defined by what actually changes Gmail's response — not by key
 * order or undefined vs. missing fields.
 */
export function hashGmailWaitingOnQuery(params: {
  maxResults: number;
}): string {
  const canonical = `maxResults=${params.maxResults}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Returns the cached payload if a non-expired row exists for this
 * (userId, queryHash). Does NOT lazy-delete expired rows; the nightly
 * sweep handles that. Expired rows are simply ignored here.
 */
export async function getCachedGmailWaitingOn(params: {
  userId: number;
  queryHash: string;
}): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get cached gmail waiting-on", async () => {
    const [row] = await db
      .select({
        payload: gmailWaitingOnCache.payload,
        expiresAt: gmailWaitingOnCache.expiresAt,
      })
      .from(gmailWaitingOnCache)
      .where(
        and(
          eq(gmailWaitingOnCache.userId, params.userId),
          eq(gmailWaitingOnCache.queryHash, params.queryHash),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return row.payload;
  });
}

/**
 * Upsert a cache row. If an entry already exists for (userId,
 * queryHash), overwrite it with the new payload and expiresAt — the
 * unique index guarantees there's only ever one.
 */
export async function setCachedGmailWaitingOn(params: {
  userId: number;
  queryHash: string;
  payload: string;
  expiresAt: Date;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("set cached gmail waiting-on", async () => {
    await db
      .insert(gmailWaitingOnCache)
      .values({
        id: nanoid(),
        userId: params.userId,
        queryHash: params.queryHash,
        payload: params.payload,
        expiresAt: params.expiresAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          payload: params.payload,
          expiresAt: params.expiresAt,
        },
      });
  });
}

/**
 * Delete rows whose expiresAt is in the past. Called by the nightly
 * scheduler so the table stays bounded; lazy-deletion on read would
 * leave stale rows when a (userId, queryHash) stops being queried.
 */
export async function pruneExpiredGmailWaitingOn(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("prune expired gmail waiting-on cache", async () => {
    await db
      .delete(gmailWaitingOnCache)
      .where(sql`${gmailWaitingOnCache.expiresAt} < NOW()`);
  });
}
