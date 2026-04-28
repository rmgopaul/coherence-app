/**
 * DropDock storage helpers — Phase F3.
 *
 * Backs the front-page DropDock chips. The dockRouter in
 * server/routers/personalData.ts wraps these with tRPC procedures.
 */
import { and, desc, eq, sql, getDb, withDbRetry } from "./_core";
import { isNull } from "drizzle-orm";
import { dockItems, type DockItem, type InsertDockItem } from "../../drizzle/schema";

export type DockSource = "gmail" | "gcal" | "gsheet" | "todoist" | "url";

/**
 * List active dock items for a user. By default excludes archived
 * rows (those auto-archived by the daily sweep — see
 * `archiveStaleDockItems`); pass `includeArchived: true` for the
 * future "Show archived" toggle / data-export use cases.
 */
export async function listDockItems(
  userId: number,
  limit = 100,
  opts: { includeArchived?: boolean } = {}
): Promise<DockItem[]> {
  const db = await getDb();
  if (!db) return [];
  const baseFilter = eq(dockItems.userId, userId);
  const where = opts.includeArchived
    ? baseFilter
    : and(baseFilter, isNull(dockItems.archivedAt));
  return withDbRetry("list dock items", async () =>
    db
      .select()
      .from(dockItems)
      .where(where)
      // Pinned chips float to the top; ties broken by recency.
      .orderBy(desc(dockItems.pinnedAt), desc(dockItems.createdAt))
      .limit(limit)
  );
}

export async function findDockItemByCanonicalUrl(
  userId: number,
  urlCanonical: string
): Promise<DockItem | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("find dock item by canonical url", async () =>
    db
      .select()
      .from(dockItems)
      .where(
        and(eq(dockItems.userId, userId), eq(dockItems.urlCanonical, urlCanonical))
      )
      .limit(1)
  );
  return rows[0] ?? null;
}

export async function insertDockItem(entry: InsertDockItem): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("insert dock item", async () => {
    await db.insert(dockItems).values(entry);
  });
}

export async function deleteDockItem(
  userId: number,
  id: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete dock item", async () => {
    await db.delete(dockItems).where(
      and(eq(dockItems.userId, userId), eq(dockItems.id, id))
    );
  });
}

export async function clearDockItemsForUser(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("clear dock items", async () => {
    await db.delete(dockItems).where(eq(dockItems.userId, userId));
  });
}

/**
 * Phase E (2026-04-28) — auto-archive stale dock items.
 *
 * Stamps `archivedAt = NOW()` on rows where ALL of the following
 * are true:
 *
 *   - `archivedAt IS NULL` (idempotent — already-archived rows are
 *     left alone)
 *   - `pinnedAt IS NULL` (pinning is an explicit "keep this" signal)
 *   - `x IS NULL AND y IS NULL` (item is not on the canvas board)
 *   - `createdAt < (now - ageDays)` (item is older than the cutoff)
 *
 * Returns the count of rows affected — useful for the cron's log
 * line. Default age threshold is 30 days, matching the Phase E
 * backlog entry's "Auto-archive dock items >30d not on canvas."
 *
 * Affects the WHOLE table when `userId` is omitted (cron path);
 * pass a userId to scope to a single user (admin / test path).
 */
export async function archiveStaleDockItems(
  opts: { userId?: number; ageDays?: number; now?: Date } = {}
): Promise<{ affected: number }> {
  const db = await getDb();
  if (!db) return { affected: 0 };
  const ageDays = Math.max(1, opts.ageDays ?? 30);
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - ageDays * 86_400_000);

  const baseConditions = [
    isNull(dockItems.archivedAt),
    isNull(dockItems.pinnedAt),
    isNull(dockItems.x),
    isNull(dockItems.y),
    sql`${dockItems.createdAt} < ${cutoff}`,
  ];
  if (opts.userId !== undefined) {
    baseConditions.unshift(eq(dockItems.userId, opts.userId));
  }

  const result = await withDbRetry("archive stale dock items", async () =>
    db
      .update(dockItems)
      .set({ archivedAt: now })
      .where(and(...baseConditions))
  );
  // mysql2 returns `{ affectedRows }` on the result header; drizzle
  // wraps that so the shape varies by driver. Cast through unknown
  // to read the field defensively without typing the whole driver
  // surface here.
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return { affected };
}

/**
 * Update a dock item's canvas position. Pass `null` for any field to
 * clear it (e.g. `{ x: null, y: null, tilt: null }` removes the chip
 * from the canvas board entirely).
 */
export async function updateDockItemCanvas(
  userId: number,
  id: string,
  patch: {
    x?: number | null;
    y?: number | null;
    tilt?: number | null;
    color?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Only include fields the caller named so we don't blast existing
  // values back to null on a partial move.
  const update: Record<string, unknown> = {};
  if ("x" in patch) update.x = patch.x;
  if ("y" in patch) update.y = patch.y;
  if ("tilt" in patch) update.tilt = patch.tilt;
  if ("color" in patch) update.color = patch.color;
  if (Object.keys(update).length === 0) return;
  await withDbRetry("update dock item canvas", async () => {
    await db
      .update(dockItems)
      .set(update)
      .where(and(eq(dockItems.userId, userId), eq(dockItems.id, id)));
  });
}
