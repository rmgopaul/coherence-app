/**
 * Task 9.2 (2026-04-28) — Saved CSG-ID worksets (Phase 9 MVP).
 *
 * A workset is a named bag of CSG IDs scoped to a team. Used by the
 * Phase 9 detail page and the future "Load workset" picker every job
 * page (Task 9.3) replaces its paste-IDs textarea with.
 *
 * Storage: rows in `idWorksets` keyed by id; csgIds live in a JSON
 * `string[]` column (`csgIdsJson`). The proc layer parses on read
 * and serializes on write — callers never see the JSON form. We
 * also keep a `csgIdCount` counter column so list views can show
 * "47 IDs" without parsing the JSON for every row.
 *
 * Invariants enforced here:
 *
 *   1. `name` is unique per scope (DB unique index `(scopeId, name)`).
 *      `createWorkset` surfaces collisions as a typed error so the
 *      proc can return a clean `CONFLICT` to the client.
 *
 *   2. CSG IDs are deduped + trimmed on write. The dedupe is
 *      order-preserving — first occurrence wins. Empty strings are
 *      dropped after trimming.
 *
 *   3. `csgIdCount` is always equal to `JSON.parse(csgIdsJson).length`.
 *      Helpers maintain this in writes; readers can rely on it.
 *
 *   4. `lastEditedByUserId` is set on every mutation EXCEPT create
 *      (where `createdByUserId` already records the author). Append
 *      is treated as an edit.
 *
 * No "scopeId in body" parameters — every helper takes scopeId as
 * its first arg so cross-scope leakage is impossible at compile
 * time. The proc layer pulls scopeId from `ctx.scopeId`.
 */

import { nanoid } from "nanoid";
import { eq, and, desc, getDb, withDbRetry } from "./_core";
import { idWorksets } from "../../drizzle/schema";

export interface IdWorksetSummary {
  id: string;
  scopeId: string;
  name: string;
  description: string | null;
  csgIdCount: number;
  createdByUserId: number;
  lastEditedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdWorksetDetail extends IdWorksetSummary {
  csgIds: string[];
}

export class IdWorksetNameConflictError extends Error {
  constructor(name: string) {
    super(`A workset named "${name}" already exists in this scope`);
    this.name = "IdWorksetNameConflictError";
  }
}

export class IdWorksetNotFoundError extends Error {
  constructor(id: string) {
    super(`Workset "${id}" not found in this scope`);
    this.name = "IdWorksetNotFoundError";
  }
}

const MAX_NAME_LENGTH = 255;
const MAX_CSG_IDS = 10_000;

/** Trim, drop empties, dedupe (first occurrence wins). Exposed for
 *  testability — every write path runs through this. */
export function normalizeCsgIds(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function rowToSummary(row: typeof idWorksets.$inferSelect): IdWorksetSummary {
  return {
    id: row.id,
    scopeId: row.scopeId,
    name: row.name,
    description: row.description,
    csgIdCount: row.csgIdCount,
    createdByUserId: row.createdByUserId,
    lastEditedByUserId: row.lastEditedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDetail(row: typeof idWorksets.$inferSelect): IdWorksetDetail {
  let parsed: string[] = [];
  try {
    const raw = JSON.parse(row.csgIdsJson);
    if (Array.isArray(raw)) {
      parsed = raw.filter((v): v is string => typeof v === "string");
    }
  } catch {
    parsed = [];
  }
  return { ...rowToSummary(row), csgIds: parsed };
}

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; errno?: number };
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}

function ensureName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Workset name is required");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Workset name exceeds ${MAX_NAME_LENGTH} characters`
    );
  }
  return trimmed;
}

function ensureCsgIdsLength(csgIds: readonly string[]): void {
  if (csgIds.length > MAX_CSG_IDS) {
    throw new Error(
      `Workset exceeds the maximum of ${MAX_CSG_IDS} CSG IDs`
    );
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export async function createIdWorkset(
  scopeId: string,
  data: {
    name: string;
    description?: string | null;
    csgIds: readonly string[];
    createdByUserId: number;
  }
): Promise<IdWorksetDetail> {
  // Validate inputs before touching the DB so misuse surfaces a clean
  // error regardless of connection state. Cheap, deterministic.
  const trimmedName = ensureName(data.name);
  const normalized = normalizeCsgIds(data.csgIds);
  ensureCsgIdsLength(normalized);

  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const id = nanoid();
  const now = new Date();
  try {
    await withDbRetry("create id workset", async () => {
      await db.insert(idWorksets).values({
        id,
        scopeId,
        createdByUserId: data.createdByUserId,
        lastEditedByUserId: null,
        name: trimmedName,
        description: data.description?.trim() || null,
        csgIdsJson: JSON.stringify(normalized),
        csgIdCount: normalized.length,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new IdWorksetNameConflictError(trimmedName);
    }
    throw err;
  }

  const row = await getIdWorksetRow(scopeId, id);
  if (!row) {
    // Insert succeeded but row missing — shouldn't happen on a healthy
    // connection, but surfacing it is better than returning a half-
    // built record.
    throw new Error("Failed to read back created workset");
  }
  return rowToDetail(row);
}

async function getIdWorksetRow(
  scopeId: string,
  id: string
): Promise<typeof idWorksets.$inferSelect | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("get id workset", () =>
    db
      .select()
      .from(idWorksets)
      .where(and(eq(idWorksets.scopeId, scopeId), eq(idWorksets.id, id)))
      .limit(1)
  );
  return rows[0] ?? null;
}

export async function getIdWorkset(
  scopeId: string,
  id: string
): Promise<IdWorksetDetail | null> {
  const row = await getIdWorksetRow(scopeId, id);
  return row ? rowToDetail(row) : null;
}

/** List worksets in a scope. Returns summaries (no csgIds) so the
 *  picker UI can show 100+ entries without paying the JSON parse
 *  cost; callers fetch detail via `getIdWorkset` on click. */
export async function listIdWorksets(
  scopeId: string
): Promise<IdWorksetSummary[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await withDbRetry("list id worksets", () =>
    db
      .select({
        id: idWorksets.id,
        scopeId: idWorksets.scopeId,
        name: idWorksets.name,
        description: idWorksets.description,
        csgIdCount: idWorksets.csgIdCount,
        createdByUserId: idWorksets.createdByUserId,
        lastEditedByUserId: idWorksets.lastEditedByUserId,
        createdAt: idWorksets.createdAt,
        updatedAt: idWorksets.updatedAt,
      })
      .from(idWorksets)
      .where(eq(idWorksets.scopeId, scopeId))
      .orderBy(desc(idWorksets.updatedAt))
  );
  // Re-build the typed summary to align with the rowToSummary shape.
  return rows.map((r) => ({
    id: r.id,
    scopeId: r.scopeId,
    name: r.name,
    description: r.description,
    csgIdCount: r.csgIdCount,
    createdByUserId: r.createdByUserId,
    lastEditedByUserId: r.lastEditedByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Replace any of `name`, `description`, `csgIds`. Fields not
 *  provided keep their existing values. Returns the updated detail.
 *  Throws `IdWorksetNotFoundError` if the (scopeId, id) pair has no
 *  matching row. */
export async function updateIdWorkset(
  scopeId: string,
  id: string,
  data: {
    name?: string;
    description?: string | null;
    csgIds?: readonly string[];
    editedByUserId: number;
  }
): Promise<IdWorksetDetail> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const existing = await getIdWorksetRow(scopeId, id);
  if (!existing) throw new IdWorksetNotFoundError(id);

  const updates: Partial<typeof idWorksets.$inferInsert> = {
    lastEditedByUserId: data.editedByUserId,
  };
  if (data.name !== undefined) {
    updates.name = ensureName(data.name);
  }
  if (data.description !== undefined) {
    updates.description = data.description?.trim() || null;
  }
  if (data.csgIds !== undefined) {
    const normalized = normalizeCsgIds(data.csgIds);
    ensureCsgIdsLength(normalized);
    updates.csgIdsJson = JSON.stringify(normalized);
    updates.csgIdCount = normalized.length;
  }

  try {
    await withDbRetry("update id workset", () =>
      db
        .update(idWorksets)
        .set(updates)
        .where(and(eq(idWorksets.scopeId, scopeId), eq(idWorksets.id, id)))
    );
  } catch (err) {
    if (isDuplicateKeyError(err) && updates.name) {
      throw new IdWorksetNameConflictError(updates.name);
    }
    throw err;
  }

  const updated = await getIdWorksetRow(scopeId, id);
  if (!updated) throw new IdWorksetNotFoundError(id);
  return rowToDetail(updated);
}

export async function deleteIdWorkset(
  scopeId: string,
  id: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const existing = await getIdWorksetRow(scopeId, id);
  if (!existing) return false;
  await withDbRetry("delete id workset", () =>
    db
      .delete(idWorksets)
      .where(and(eq(idWorksets.scopeId, scopeId), eq(idWorksets.id, id)))
  );
  return true;
}

/**
 * Append CSG IDs to a workset. Order-preserving: existing IDs keep
 * their position, new IDs append in input order. Duplicates in
 * either bag are dropped; existing IDs in the input are no-ops.
 * Returns the updated detail with the post-append `csgIds` so the
 * caller doesn't need a follow-up read.
 */
export async function appendCsgIdsToWorkset(
  scopeId: string,
  id: string,
  data: {
    csgIds: readonly string[];
    editedByUserId: number;
  }
): Promise<IdWorksetDetail> {
  const existing = await getIdWorksetRow(scopeId, id);
  if (!existing) throw new IdWorksetNotFoundError(id);

  const detail = rowToDetail(existing);
  const merged = normalizeCsgIds([...detail.csgIds, ...data.csgIds]);
  ensureCsgIdsLength(merged);

  return updateIdWorkset(scopeId, id, {
    csgIds: merged,
    editedByUserId: data.editedByUserId,
  });
}
