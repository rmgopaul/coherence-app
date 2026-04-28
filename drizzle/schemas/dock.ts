/**
 * DropDock items — Phase F3.
 *
 * Persistent backing store for the front-page DropDock: anything the
 * user pastes or drags into the dock (Gmail link, Calendar event, Drive
 * sheet, Todoist task, or arbitrary URL) becomes a row here and is
 * rendered as a chip on /dashboard until removed.
 *
 * Migration: drizzle/0023_add_dock_items.sql
 *
 * `urlCanonical` is the deduplication key — a normalized form of `url`
 * (scheme/host lowercased, common tracking params stripped) so pasting
 * the same link twice doesn't double-add. The display still renders
 * `url` so we don't lose the user's exact paste.
 */
import {
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  int,
  smallint,
  uniqueIndex,
  index,
} from "drizzle-orm/mysql-core";

export const dockItems = mysqlTable(
  "dockItems",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    source: mysqlEnum("source", ["gmail", "gcal", "gsheet", "todoist", "url"]).notNull(),
    url: text("url").notNull(),
    // Indexed canonical form — long enough for ~any real URL but short
    // enough that InnoDB's index prefix limit doesn't refuse the unique.
    urlCanonical: varchar("urlCanonical", { length: 512 }).notNull(),
    title: varchar("title", { length: 500 }),
    // Stringified JSON of source-specific metadata (messageId, eid,
    // taskId, etc.) — preserved so future enrichment workers don't have
    // to re-parse the URL.
    meta: text("meta"),
    pinnedAt: timestamp("pinnedAt"),
    // Canvas (Phase F8) — when set, the chip is also rendered on
    // /dashboard/canvas at this absolute position. Null = chip only,
    // not on the canvas board.
    x: int("x"),
    y: int("y"),
    tilt: smallint("tilt"),
    color: varchar("color", { length: 16 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    // Phase E (2026-04-28) — auto-archive sweep: items older than 30
    // days that aren't pinned and aren't on the canvas (x/y null) get
    // their archivedAt stamped, hiding them from the default
    // `listDockItems` query. The data sticks around so a future
    // "Show archived" toggle can resurface or restore them.
    archivedAt: timestamp("archivedAt"),
    // Phase E (2026-04-28) — optional due date so a dock chip can
    // double as a lightweight reminder. Null = the chip is just a
    // bookmark; non-null = surface it on the dashboard "Upcoming"
    // strip and visually escalate as the time approaches.
    dueAt: timestamp("dueAt"),
  },
  (table) => ({
    userCreatedIdx: index("dock_items_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    userUrlUnique: uniqueIndex("dock_items_user_url_unique").on(
      table.userId,
      table.urlCanonical
    ),
    // Phase E (2026-04-28) — index on (archivedAt) so the daily
    // sweep's WHERE archivedAt IS NULL filter stays cheap as the
    // table grows. Per-user filter still hits userCreatedIdx; the
    // archive index is separate so single-user listings benefit
    // from both.
    archivedAtIdx: index("dock_items_archived_at_idx").on(table.archivedAt),
    // Phase E (2026-04-28) — composite index for the "Upcoming"
    // dashboard strip's `WHERE userId = ? AND dueAt IS NOT NULL
    // ORDER BY dueAt ASC LIMIT N`. Listing under (userId, dueAt)
    // keeps the lookup per-user without scanning the table.
    userDueAtIdx: index("dock_items_user_due_idx").on(
      table.userId,
      table.dueAt
    ),
  })
);

export type DockItem = typeof dockItems.$inferSelect;
export type InsertDockItem = typeof dockItems.$inferInsert;
