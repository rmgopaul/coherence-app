/**
 * Personal contacts — Phase E (2026-04-28).
 *
 * Lightweight CRM table for the front-page contacts overlay.
 * Tracks the people the user wants to stay in touch with: name,
 * optional email/phone/role/company, freeform notes, and a
 * `lastContactedAt` stamp the UI updates whenever the user clicks
 * "Just talked." Stale rows surface in the overlay's "Reach out"
 * group.
 *
 * Personal-side only — single-user, no scopeId. Lives on the
 * personal app router (server/routers.ts → personalData.ts), not
 * the solar-rec router.
 */
import {
  mysqlTable,
  text,
  timestamp,
  varchar,
  int,
  index,
} from "drizzle-orm/mysql-core";

export const personalContacts = mysqlTable(
  "personalContacts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    // Display name. Required — search + sort key.
    name: varchar("name", { length: 200 }).notNull(),
    // Free-form contact metadata. All optional — a contact with
    // just a name and notes is fine for "remember to follow up
    // with this person."
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 64 }),
    role: varchar("role", { length: 200 }),
    company: varchar("company", { length: 200 }),
    notes: text("notes"),
    // Comma-separated free-form tags ("family", "client", "vendor",
    // …). Server validates length but doesn't enforce a vocabulary.
    tags: varchar("tags", { length: 500 }),
    // Stamp updated by the "Just talked" button on the contact
    // card. Null means we've never tracked a contact event for
    // this person — surfaces in the "Never" bucket.
    lastContactedAt: timestamp("lastContactedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    // Soft-delete: archived rows hide from the default overlay
    // listing but stay queryable for export / restore.
    archivedAt: timestamp("archivedAt"),
  },
  (table) => ({
    userCreatedIdx: index("personal_contacts_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    // Composite index for the "Reach out" sort: per-user listings
    // ordered by `lastContactedAt ASC NULLS FIRST` (the row with
    // the oldest contact event surfaces at the top). MySQL puts
    // NULLs first by default in ASC ordering, which is what we
    // want.
    userLastContactedIdx: index(
      "personal_contacts_user_last_contacted_idx"
    ).on(table.userId, table.lastContactedAt),
  })
);

export type PersonalContact = typeof personalContacts.$inferSelect;
export type InsertPersonalContact = typeof personalContacts.$inferInsert;
