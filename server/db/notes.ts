import { eq, and, desc, getDb, withDbRetry } from "./_core";
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

export async function deleteNoteLink(userId: number, linkId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete note link", async () => {
    await db
      .delete(noteLinks)
      .where(and(eq(noteLinks.userId, userId), eq(noteLinks.id, linkId)));
  });
}
