/**
 * DropDock storage helpers — Phase F3.
 *
 * Backs the front-page DropDock chips. The dockRouter in
 * server/routers/personalData.ts wraps these with tRPC procedures.
 */
import { and, asc, desc, eq, sql, getDb, withDbRetry } from "./_core";
import { isNotNull, isNull } from "drizzle-orm";
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
 * Phase E (2026-04-28) — set or clear a dock item's optional due
 * date. Pass `null` to clear, a Date to set. Scoped to the calling
 * user (the where clause uses both id + userId so a malicious id
 * for another user's chip is a no-op).
 *
 * Returns true when a row was updated, false when the id wasn't
 * found (so the proc layer can surface a 404). Driver variance is
 * handled the same way as `archiveStaleDockItems` and the feedback
 * helper — read affectedRows, fall back to rowCount, default to 0.
 */
export async function setDockItemDueAt(
  userId: number,
  id: string,
  dueAt: Date | null
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await withDbRetry("set dock item dueAt", async () =>
    db
      .update(dockItems)
      .set({ dueAt })
      .where(and(eq(dockItems.userId, userId), eq(dockItems.id, id)))
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Phase E (2026-04-28) — items the user wants reminded about.
 *
 * Selects rows where `dueAt IS NOT NULL` and `archivedAt IS NULL`,
 * ordered by `dueAt ASC` so overdue items surface first followed
 * by the next-due. The `windowHours` knob filters to "reminders
 * roughly relevant right now" — a 36h window captures everything
 * overdue (no lower bound) plus tomorrow's items but trims a chip
 * with `dueAt = next month` from the dashboard strip. Pass `null`
 * for `windowHours` to return every dated chip.
 *
 * NOTE: the cutoff is computed from the caller's `now` so the
 * server's view of "soon" is deterministic and unit-testable.
 */
export async function listUpcomingDockItems(
  userId: number,
  opts: { windowHours?: number | null; now?: Date; limit?: number } = {}
): Promise<DockItem[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const baseConditions = [
    eq(dockItems.userId, userId),
    isNotNull(dockItems.dueAt),
    isNull(dockItems.archivedAt),
  ];
  if (opts.windowHours != null && opts.windowHours > 0) {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() + opts.windowHours * 3_600_000);
    baseConditions.push(sql`${dockItems.dueAt} <= ${cutoff}`);
  }
  return withDbRetry("list upcoming dock items", async () =>
    db
      .select()
      .from(dockItems)
      .where(and(...baseConditions))
      .orderBy(asc(dockItems.dueAt))
      .limit(limit)
  );
}

/**
 * Look up one dock item by id (scoped to the calling user). Used by
 * the self-heal `refreshTitle` proc — needs the row's source/url/
 * meta to re-run enrichment, plus an ownership check to fail closed
 * when an attacker probes another user's chip id.
 */
export async function getDockItemById(
  userId: number,
  id: string
): Promise<DockItem | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get dock item by id", async () =>
    db
      .select()
      .from(dockItems)
      .where(and(eq(dockItems.userId, userId), eq(dockItems.id, id)))
      .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Persist a freshly resolved title on an existing dock item. Used
 * by the self-heal `refreshTitle` proc to fix chips whose original
 * enrichment failed (e.g. Calendar `htmlLink` URLs that didn't
 * classify as `gcal` before that bug was fixed).
 *
 * Returns true when a row was updated, false otherwise (chip
 * doesn't exist, belongs to another user, or `title` is empty
 * after trimming). The proc layer uses the boolean to decide
 * whether to invalidate `dock.list`.
 *
 * Optional `source` + `meta` parameters cover the case where a
 * chip's original classification was wrong (most commonly:
 * Calendar `htmlLink` URLs stored as `source: "url"` because
 * `classifyUrl` didn't recognize `www.google.com/calendar/...`
 * URLs before that fix landed). When provided, they're updated
 * alongside the title in a single round-trip — so the chip's
 * badge label and color also self-heal, not just the title.
 *
 * Empty/whitespace `title` is rejected up-front so a re-
 * enrichment that returns null doesn't blow away an existing
 * value.
 */
export async function updateDockItemTitle(
  userId: number,
  id: string,
  title: string,
  opts: { source?: DockSource; meta?: string | null } = {}
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  const update: Record<string, unknown> = {
    title: trimmed.slice(0, 500),
  };
  if (opts.source) update.source = opts.source;
  // Only touch `meta` when the caller explicitly provided one — null
  // here means "clear the existing meta" (per the partial-update
  // semantics used elsewhere in this file). `undefined` leaves the
  // existing meta alone.
  if (opts.meta !== undefined) update.meta = opts.meta;
  const result = await withDbRetry("update dock item title", async () =>
    db
      .update(dockItems)
      .set(update)
      .where(and(eq(dockItems.userId, userId), eq(dockItems.id, id)))
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
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
