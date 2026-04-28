import { eq, and, desc, inArray, getDb, withDbRetry } from "./_core";
import { notes, noteLinks, InsertNote, InsertNoteLink } from "../../drizzle/schema";

export type NoteUpdateInput = {
  notebook?: string;
  title?: string;
  content?: string;
  pinned?: boolean;
};

export async function listNotes(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list notes", async () =>
    db
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(desc(notes.pinned), desc(notes.updatedAt))
      .limit(limit)
  );
}

export async function getNoteById(userId: number, noteId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load note", async () =>
    db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function createNote(entry: InsertNote) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert note", async () => {
    await db.insert(notes).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function updateNote(userId: number, noteId: string, updates: NoteUpdateInput) {
  const db = await getDb();
  if (!db) return;

  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (updates.notebook !== undefined) updatePayload.notebook = updates.notebook;
  if (updates.title !== undefined) updatePayload.title = updates.title;
  if (updates.content !== undefined) updatePayload.content = updates.content;
  if (updates.pinned !== undefined) updatePayload.pinned = updates.pinned;

  await withDbRetry("update note", async () => {
    await db
      .update(notes)
      .set(updatePayload)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)));
  });
}

export async function deleteNote(userId: number, noteId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete note links", async () => {
    await db
      .delete(noteLinks)
      .where(and(eq(noteLinks.userId, userId), eq(noteLinks.noteId, noteId)));
  });

  await withDbRetry("delete note", async () => {
    await db
      .delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)));
  });
}

export async function listNoteLinks(userId: number, noteId?: string, limit = 500) {
  const db = await getDb();
  if (!db) return [];

  if (noteId) {
    return withDbRetry("list note links by note", async () =>
      db
        .select()
        .from(noteLinks)
        .where(and(eq(noteLinks.userId, userId), eq(noteLinks.noteId, noteId)))
        .orderBy(desc(noteLinks.createdAt))
        .limit(limit)
    );
  }

  return withDbRetry("list note links", async () =>
    db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.userId, userId))
      .orderBy(desc(noteLinks.createdAt))
      .limit(limit)
  );
}

export async function findNoteLinkByUnique(
  userId: number,
  noteId: string,
  linkType: string,
  externalId: string,
  seriesId = "",
  occurrenceStartIso = ""
) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("find note link", async () =>
    db
      .select()
      .from(noteLinks)
      .where(
        and(
          eq(noteLinks.userId, userId),
          eq(noteLinks.noteId, noteId),
          eq(noteLinks.linkType, linkType),
          eq(noteLinks.externalId, externalId),
          eq(noteLinks.seriesId, seriesId),
          eq(noteLinks.occurrenceStartIso, occurrenceStartIso)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function addNoteLink(entry: InsertNoteLink) {
  const db = await getDb();
  if (!db) return { created: false as const, existingId: null as string | null };

  const normalizedSeriesId = entry.seriesId ?? "";
  const normalizedOccurrence = entry.occurrenceStartIso ?? "";

  const existing = await findNoteLinkByUnique(
    entry.userId,
    entry.noteId,
    entry.linkType,
    entry.externalId,
    normalizedSeriesId,
    normalizedOccurrence
  );
  if (existing) {
    return { created: false as const, existingId: existing.id };
  }

  await withDbRetry("insert note link", async () => {
    await db.insert(noteLinks).values({
      ...entry,
      seriesId: normalizedSeriesId,
      occurrenceStartIso: normalizedOccurrence,
      createdAt: new Date(),
    });
  });

  return { created: true as const, existingId: null as string | null };
}

/**
 * Task 10.3 (2026-04-28) — reverse-link lookup: given an external
 * productivity object (Todoist task / Calendar event), return the
 * notes that link TO it.
 *
 * The forward direction (note → external) is created by the
 * Notebook→Todoist / Notebook→Calendar features (Task 4.6 and
 * earlier). This helper closes the loop so the dashboard's
 * row-based feeds can show "📎 N linked notes" badges next to
 * tasks and events that have notes attached.
 *
 * Result includes the note's `id`, `title`, `notebook`, and
 * `updatedAt` so the badge popover can list them without a
 * follow-up query. Capped at `limit` (default 50) — typical UX
 * has a handful of notes per task; the cap is defense against
 * pathological data.
 *
 * `seriesId` and `occurrenceStartIso` are optional. When omitted,
 * the query matches any link with the supplied (linkType,
 * externalId), which is the correct behavior for Todoist tasks
 * (no series concept) and "any occurrence of this calendar event"
 * for the dashboard's calendar feed.
 */
export interface NoteForExternal {
  id: string;
  title: string | null;
  notebook: string;
  updatedAt: Date | null;
  /** The link's seriesId — useful when the caller wants to
   *  distinguish notes attached to a specific occurrence. */
  seriesId: string;
  /** The link's occurrenceStartIso. */
  occurrenceStartIso: string;
}

export async function listNotesForExternal(
  userId: number,
  linkType: string,
  externalId: string,
  opts: {
    limit?: number;
    seriesId?: string;
    occurrenceStartIso?: string;
  } = {}
): Promise<NoteForExternal[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  // Two-step query:
  //   1. Find matching noteLinks by (userId, linkType, externalId).
  //   2. Hydrate notes by id.
  // A JOIN would be faster but `notes` and `noteLinks` are both small
  // per user; two queries keeps the helper composable and avoids the
  // need for `selectFrom().leftJoin().fields(...)` boilerplate.
  const linkConditions = [
    eq(noteLinks.userId, userId),
    eq(noteLinks.linkType, linkType),
    eq(noteLinks.externalId, externalId),
  ];
  if (opts.seriesId !== undefined) {
    linkConditions.push(eq(noteLinks.seriesId, opts.seriesId));
  }
  if (opts.occurrenceStartIso !== undefined) {
    linkConditions.push(
      eq(noteLinks.occurrenceStartIso, opts.occurrenceStartIso)
    );
  }

  const linkRows = await withDbRetry("notes-for-external — links", () =>
    db
      .select({
        noteId: noteLinks.noteId,
        seriesId: noteLinks.seriesId,
        occurrenceStartIso: noteLinks.occurrenceStartIso,
      })
      .from(noteLinks)
      .where(and(...linkConditions))
      .orderBy(desc(noteLinks.createdAt))
      .limit(limit)
  );

  if (linkRows.length === 0) return [];

  const noteIds = Array.from(new Set(linkRows.map((r) => r.noteId)));
  const noteRows = await withDbRetry("notes-for-external — notes", () =>
    db
      .select({
        id: notes.id,
        title: notes.title,
        notebook: notes.notebook,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.userId, userId), inArray(notes.id, noteIds)))
  );

  // Preserve the link order (newest link first), and attach the
  // link's seriesId/occurrence so the UI can disambiguate a note
  // that's linked to multiple occurrences of the same event.
  const noteById = new Map<string, (typeof noteRows)[number]>();
  for (const note of noteRows) noteById.set(note.id, note);

  const out: NoteForExternal[] = [];
  for (const link of linkRows) {
    const note = noteById.get(link.noteId);
    if (!note) continue;
    out.push({
      id: note.id,
      title: note.title,
      notebook: note.notebook,
      updatedAt: note.updatedAt,
      seriesId: link.seriesId,
      occurrenceStartIso: link.occurrenceStartIso,
    });
  }
  return out;
}

/**
 * Task 10.3 (2026-04-28) — batch variant of `listNotesForExternal`
 * for dashboard feeds that need counts across many rows at once.
 * Returns `Record<externalId, count>` so the caller can render
 * "📎 N linked notes" badges in O(1) per row after one round-trip.
 *
 * Empty input → empty result. `linkType` is required because
 * different external systems can collide on ID (a Todoist task
 * ID and a Google event ID could in theory match).
 */
export async function countNoteLinksByExternalIds(
  userId: number,
  linkType: string,
  externalIds: readonly string[]
): Promise<Record<string, number>> {
  if (externalIds.length === 0) return {};
  const db = await getDb();
  if (!db) return {};

  // Dedupe + bound to a sane batch size. The UI calls this with
  // ~30-50 row IDs per render; cap higher to leave headroom for
  // future bulk surfaces.
  const unique = Array.from(new Set(externalIds)).slice(0, 500);

  const rows = await withDbRetry("count notes by external ids", () =>
    db
      .select({
        externalId: noteLinks.externalId,
        noteId: noteLinks.noteId,
      })
      .from(noteLinks)
      .where(
        and(
          eq(noteLinks.userId, userId),
          eq(noteLinks.linkType, linkType),
          inArray(noteLinks.externalId, unique)
        )
      )
  );

  // Dedupe by (externalId, noteId) — the same note can have
  // multiple links to the same external (e.g. one for the series
  // root and one for a specific occurrence); we want the
  // "N notes" count to reflect distinct notes per external.
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.externalId}::${row.noteId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[row.externalId] = (counts[row.externalId] ?? 0) + 1;
  }
  return counts;
}

export async function deleteNoteLink(userId: number, linkId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete note link", async () => {
    await db
      .delete(noteLinks)
      .where(and(eq(noteLinks.userId, userId), eq(noteLinks.id, linkId)));
  });
}
