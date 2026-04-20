/**
 * DropDock storage helpers — Phase F3.
 *
 * Backs the front-page DropDock chips. The dockRouter in
 * server/routers/personalData.ts wraps these with tRPC procedures.
 */
import { and, desc, eq, getDb, withDbRetry } from "./_core";
import { dockItems, type DockItem, type InsertDockItem } from "../../drizzle/schema";

export type DockSource = "gmail" | "gcal" | "gsheet" | "todoist" | "url";

export async function listDockItems(
  userId: number,
  limit = 100
): Promise<DockItem[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list dock items", async () =>
    db
      .select()
      .from(dockItems)
      .where(eq(dockItems.userId, userId))
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
