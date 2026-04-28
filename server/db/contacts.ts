/**
 * Personal contacts storage helpers — Phase E (2026-04-28).
 *
 * Backs the front-page Contacts overlay. The contactsRouter in
 * server/routers/personalData.ts wraps these with tRPC procedures.
 */
import { and, asc, desc, eq, getDb, withDbRetry } from "./_core";
import { isNull } from "drizzle-orm";
import {
  personalContacts,
  type PersonalContact,
  type InsertPersonalContact,
} from "../../drizzle/schema";

/**
 * List active contacts for a user. By default excludes archived
 * rows; pass `includeArchived: true` for the future "Archived"
 * toggle and the data-export path.
 *
 * Order: most-recently-updated first when `sort = "recent"`
 * (default), oldest-contacted-first (NULLS first) when
 * `sort = "stale"` — that's the "Reach out" view's sort key, so
 * the row with the longest gap surfaces at the top.
 */
export async function listPersonalContacts(
  userId: number,
  opts: {
    limit?: number;
    includeArchived?: boolean;
    sort?: "recent" | "stale";
  } = {}
): Promise<PersonalContact[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const baseFilter = eq(personalContacts.userId, userId);
  const where = opts.includeArchived
    ? baseFilter
    : and(baseFilter, isNull(personalContacts.archivedAt));
  const orderBy =
    opts.sort === "stale"
      ? // ASC puts NULLs (never-contacted) first in MySQL — exactly
        // what the "Reach out" view wants. Tie-break by name so the
        // ordering is deterministic across requests.
        [asc(personalContacts.lastContactedAt), asc(personalContacts.name)]
      : [desc(personalContacts.updatedAt)];
  return withDbRetry("list personal contacts", async () =>
    db
      .select()
      .from(personalContacts)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
  );
}

/**
 * Insert a new contact. The id and timestamps are caller-provided
 * (the proc layer generates the id with nanoid + sets the dates)
 * so this helper stays focused on the database concern.
 */
export async function insertPersonalContact(
  entry: InsertPersonalContact
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("insert personal contact", async () => {
    await db.insert(personalContacts).values(entry);
  });
}

/**
 * Patch an existing contact's mutable fields. Returns true when a
 * row was updated, false when the id wasn't found OR belonged to
 * another user (the where clause scopes by userId so a malicious
 * id-from-elsewhere is a no-op rather than leaking the row).
 *
 * Pass `null` to clear an optional field; pass `undefined` to
 * leave it unchanged. The patch is filtered to remove undefined
 * fields before the UPDATE so a no-op patch is a no-op SQL.
 */
export async function updatePersonalContact(
  userId: number,
  id: string,
  patch: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    role?: string | null;
    company?: string | null;
    notes?: string | null;
    tags?: string | null;
  }
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const update: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  if (Object.keys(update).length === 0) return false;
  update.updatedAt = new Date();
  const result = await withDbRetry("update personal contact", async () =>
    db
      .update(personalContacts)
      .set(update)
      .where(
        and(eq(personalContacts.userId, userId), eq(personalContacts.id, id))
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Stamp `lastContactedAt` to the supplied `now` (or `Date.now()`).
 * Used by the "Just talked" button on the contact card.
 *
 * Returns true when a row was updated. When `now` is null we clear
 * the stamp — useful for "I marked the wrong person, undo this."
 */
export async function recordPersonalContactEvent(
  userId: number,
  id: string,
  now: Date | null = new Date()
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await withDbRetry(
    "record personal contact event",
    async () =>
      db
        .update(personalContacts)
        .set({ lastContactedAt: now, updatedAt: new Date() })
        .where(
          and(
            eq(personalContacts.userId, userId),
            eq(personalContacts.id, id)
          )
        )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Soft-delete: stamp `archivedAt`. Pass `null` to restore.
 * Returns true when a row was updated.
 */
export async function archivePersonalContact(
  userId: number,
  id: string,
  archived: boolean
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const archivedAt = archived ? new Date() : null;
  const result = await withDbRetry("archive personal contact", async () =>
    db
      .update(personalContacts)
      .set({ archivedAt, updatedAt: new Date() })
      .where(
        and(
          eq(personalContacts.userId, userId),
          eq(personalContacts.id, id)
        )
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}

/**
 * Hard delete: removes the row entirely. Used by the contact card's
 * "Delete forever" action after the user confirms — archive is
 * the default soft-delete path.
 */
export async function deletePersonalContact(
  userId: number,
  id: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await withDbRetry("delete personal contact", async () =>
    db
      .delete(personalContacts)
      .where(
        and(
          eq(personalContacts.userId, userId),
          eq(personalContacts.id, id)
        )
      )
  );
  const affected =
    (result as unknown as { affectedRows?: number; rowCount?: number })
      .affectedRows ??
    (result as unknown as { rowCount?: number }).rowCount ??
    0;
  return affected > 0;
}
