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
  })
);

export type DockItem = typeof dockItems.$inferSelect;
export type InsertDockItem = typeof dockItems.$inferInsert;
