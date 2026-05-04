/**
 * Snapshot-log recovery primitives — read-only.
 *
 * Background. The Solar REC dashboard's "Snapshot Log" feature was
 * historically persisted to:
 *   - browser localStorage `solarRecDashboardLogsV1`, and
 *   - cloud storage via `solarRecDashboardStorage` rows under
 *     `storageKey = "snapshot_logs_v1"`.
 *
 * The cloud-fallback hydration path was removed during a Phase 5
 * cleanup, leaving the UI reading only localStorage. In production
 * the main cloud row currently contains a single-entry JSON array
 * (a one-shot save by the only currently-active dashboard), but
 * orphaned chunk rows from a prior chunked write
 * (`storageKey LIKE "snapshot_logs_v1_chunk_%"`) still exist in the
 * DB and contain the larger historical snapshot history.
 *
 * This module provides PURE helpers (no DB / no IO) that:
 *   - parse a JSON-encoded snapshot-log array defensively;
 *   - reassemble orphaned chunk rows in chunkIndex order;
 *   - dedupe entries by id;
 *   - sort newest-first by createdAt;
 *   - merge the main payload with an orphan-recovered candidate and
 *     surface a `source` tag indicating provenance.
 *
 * The module never writes or deletes anything. The corresponding
 * tRPC procedure (`solarRecDashboard.getSnapshotLogs`) is also
 * read-only and exists only as a recovery/diagnostic surface until
 * the snapshot-log feature gets a proper server-owned data plane.
 */

export const SNAPSHOT_LOG_RECOVERY_RUNNER_VERSION =
  "snapshot-logs-recovery-v1";

/**
 * The shape we expect each snapshot-log entry to carry. Defensive:
 * we only require `id` and `createdAt` — the client will still
 * tolerate missing other fields per its existing serde.
 */
export interface SnapshotLogEntryLike {
  id: string;
  createdAt: string;
  // Free-form rest — the client deserializer recovers Dates and
  // arrays from this shape; we just round-trip it.
  [key: string]: unknown;
}

export type SnapshotLogSource =
  | "main"
  | "main-plus-orphaned-chunks"
  | "orphaned-chunks"
  | "none";

export interface SnapshotLogRecoveryResult {
  source: SnapshotLogSource;
  /**
   * Unique snapshot-log entries, deduped by id, sorted newest-first
   * by createdAt. `entries.length` is the canonical "how many
   * unique entries did we recover" count — use it directly. The
   * separate `rawEntryCount` field below is for diagnostics
   * (how many raw entries we saw before dedupe).
   */
  entries: SnapshotLogEntryLike[];
  /**
   * Pre-dedupe count of raw entries observed across the main
   * payload + orphan-chunk reassembly. May exceed
   * `entries.length` when entries collide by id; the difference
   * is reported as `duplicateCount`.
   */
  rawEntryCount: number;
  /** Number of entries dropped during dedupe-by-id. */
  duplicateCount: number;
  newestCreatedAt: string | null;
  oldestCreatedAt: string | null;
  mainPayloadEntries: number | null;
  orphanedChunkEntries: number | null;
  warnings: string[];
}

/**
 * Defensive JSON parse of a snapshot-log array payload. Returns
 * the entries it could recognize (rejecting items that lack `id`
 * or `createdAt`) and accumulates warnings for anything skipped.
 * Never throws.
 */
export function parseSnapshotLogPayload(
  payload: string | null | undefined
): { entries: SnapshotLogEntryLike[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!payload || payload.trim().length === 0) {
    return { entries: [], warnings };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    warnings.push(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { entries: [], warnings };
  }
  if (!Array.isArray(parsed)) {
    warnings.push(
      `payload root was ${typeof parsed}, expected array — skipping`
    );
    return { entries: [], warnings };
  }
  const entries: SnapshotLogEntryLike[] = [];
  let skipped = 0;
  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).createdAt === "string"
    ) {
      entries.push(item as SnapshotLogEntryLike);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    warnings.push(
      `${skipped} entr${skipped === 1 ? "y" : "ies"} skipped (missing id/createdAt)`
    );
  }
  return { entries, warnings };
}

/**
 * Reassemble orphaned chunk rows. The snapshot-log chunked-storage
 * format uses storageKeys of the form
 * `snapshot_logs_v1_chunk_NNNN` — today the writer zero-pads to 4
 * digits, but the regex below accepts any digit width (1+) so a
 * future writer that drops or widens padding still works as long
 * as the suffix is purely numeric. Order is by parsed integer, not
 * lexicographic, so "_chunk_2" sorts before "_chunk_10" correctly.
 *
 * Each row contains a fragment of the JSON-encoded array. We sort
 * by chunk-suffix integer, then concatenate `payload` fragments in
 * that order.
 *
 * Rows with non-conforming storageKeys are dropped with a warning
 * — this preserves the read-only, defensive contract.
 */
export function reassembleOrphanChunks(
  rows: ReadonlyArray<{ storageKey: string; payload: string | null }>
): { payload: string | null; warnings: string[]; chunkCount: number } {
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { payload: null, warnings, chunkCount: 0 };
  }
  const chunkPattern = /_chunk_(\d+)$/;
  const valid: { storageKey: string; payload: string }[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (!chunkPattern.test(row.storageKey)) {
      dropped++;
      continue;
    }
    valid.push({ storageKey: row.storageKey, payload: row.payload ?? "" });
  }
  if (dropped > 0) {
    warnings.push(
      `${dropped} chunk row${dropped === 1 ? "" : "s"} dropped (storageKey did not match _chunk_NNNN pattern)`
    );
  }
  if (valid.length === 0) {
    return { payload: null, warnings, chunkCount: 0 };
  }
  // Sort by chunk-suffix integer to be safe even if a future
  // generator uses a different zero-padding width.
  valid.sort((a, b) => {
    const ai = Number(a.storageKey.match(chunkPattern)![1]);
    const bi = Number(b.storageKey.match(chunkPattern)![1]);
    return ai - bi;
  });
  return {
    payload: valid.map((row) => row.payload).join(""),
    warnings,
    chunkCount: valid.length,
  };
}

/**
 * Dedupe by `id`, keeping the entry with the latest `createdAt`
 * (lexicographic ISO-8601 comparison). Returns the unique set and a
 * count of dropped duplicates. Sort order is preserved as
 * newest-first via the post-merge sort.
 */
export function dedupeById(
  entries: ReadonlyArray<SnapshotLogEntryLike>
): { unique: SnapshotLogEntryLike[]; duplicates: number } {
  const byId = new Map<string, SnapshotLogEntryLike>();
  let duplicates = 0;
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    duplicates++;
    if (entry.createdAt > existing.createdAt) {
      byId.set(entry.id, entry);
    }
  }
  return { unique: Array.from(byId.values()), duplicates };
}

/**
 * Sort entries newest-first by `createdAt` (ISO-8601 lexicographic).
 */
export function sortNewestFirst(
  entries: ReadonlyArray<SnapshotLogEntryLike>
): SnapshotLogEntryLike[] {
  return [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Compose the recovery result from raw main payload + raw orphan
 * chunk rows. The discriminator for whether to surface orphans is
 * **id-set semantics**, not raw entry count:
 *
 *   - If the orphan candidate contributes at least one id NOT
 *     present in main, the union is surfaced
 *     (`main-plus-orphaned-chunks`). Pre-fix this was a
 *     "more entries than main" comparison, which dropped legitimate
 *     orphan content whenever the counts happened to match — e.g.
 *     main `[{id: a}]` + orphan `[{id: b}]` gave 1 entry only.
 *   - If only orphans are present, use them (`orphaned-chunks`).
 *   - Otherwise prefer main (`main` or `none`).
 *
 * The id-set discriminator preserves the safety property — orphans
 * whose ids are a subset of main contribute nothing, so a
 * legitimately-cleared user history won't be silently un-cleared
 * by stale orphan rows that just hold the same single entry — and
 * also doesn't drop NEW orphan content based on accidental count
 * collisions.
 *
 * Never writes anything. Never throws.
 */
export function composeSnapshotLogRecovery(input: {
  mainPayload: string | null;
  orphanRows: ReadonlyArray<{ storageKey: string; payload: string | null }>;
}): SnapshotLogRecoveryResult {
  const warnings: string[] = [];

  const mainParsed = parseSnapshotLogPayload(input.mainPayload);
  warnings.push(...mainParsed.warnings.map((w) => `main: ${w}`));

  const orphanReassembly = reassembleOrphanChunks(input.orphanRows);
  warnings.push(
    ...orphanReassembly.warnings.map((w) => `orphan-chunks: ${w}`)
  );
  const orphanParsed = parseSnapshotLogPayload(orphanReassembly.payload);
  warnings.push(...orphanParsed.warnings.map((w) => `orphan-chunks: ${w}`));

  const mainEntries = mainParsed.entries;
  const orphanEntries = orphanParsed.entries;

  const mainPayloadEntries =
    input.mainPayload === null || input.mainPayload === undefined
      ? null
      : mainEntries.length;
  const orphanedChunkEntries =
    orphanReassembly.chunkCount === 0 ? null : orphanEntries.length;

  let combined: SnapshotLogEntryLike[];
  let source: SnapshotLogSource;
  if (mainEntries.length === 0 && orphanEntries.length === 0) {
    combined = [];
    source = "none";
  } else if (mainEntries.length === 0) {
    combined = orphanEntries;
    source = "orphaned-chunks";
  } else {
    // id-set discriminator: do orphans contribute any new ids?
    const mainIds = new Set(mainEntries.map((entry) => entry.id));
    const orphansContributeNewIds = orphanEntries.some(
      (entry) => !mainIds.has(entry.id)
    );
    if (orphansContributeNewIds) {
      combined = [...mainEntries, ...orphanEntries];
      source = "main-plus-orphaned-chunks";
    } else {
      combined = mainEntries;
      source = "main";
    }
  }

  const { unique, duplicates } = dedupeById(combined);
  const sorted = sortNewestFirst(unique);
  const newest = sorted[0]?.createdAt ?? null;
  const oldest = sorted[sorted.length - 1]?.createdAt ?? null;

  return {
    source,
    entries: sorted,
    rawEntryCount: combined.length,
    duplicateCount: duplicates,
    newestCreatedAt: newest,
    oldestCreatedAt: oldest,
    mainPayloadEntries,
    orphanedChunkEntries,
    warnings,
  };
}

/**
 * Apply pagination + bounded-response cap to a recovery result.
 * Used by the tRPC proc to ensure no single response exceeds the
 * dashboard response budget. Cursor is the `createdAt` of the last
 * entry in the previous page; entries strictly older than the
 * cursor are returned, capped at `limit`.
 */
export function paginateSnapshotLogRecovery(
  result: SnapshotLogRecoveryResult,
  options: { limit: number; cursorCreatedAt?: string }
): {
  entries: SnapshotLogEntryLike[];
  nextCursorCreatedAt: string | null;
} {
  const { limit, cursorCreatedAt } = options;
  // Defensive guard: a non-positive limit collapses to "empty page,
  // no next cursor." Without this, the `page.length === limit`
  // check below would be `0 === 0 → true` and the cursor lookup
  // would dereference `page[-1].createdAt`. The Zod schema on the
  // proc's `.input(...)` constrains limit to 1..100 so the guard
  // never fires from the live API path, but the helper is exported
  // and a future caller could pass 0.
  if (limit <= 0) return { entries: [], nextCursorCreatedAt: null };
  const filtered = cursorCreatedAt
    ? result.entries.filter((entry) => entry.createdAt < cursorCreatedAt)
    : result.entries;
  const page = filtered.slice(0, limit);
  const next =
    page.length === limit && filtered.length > limit
      ? page[page.length - 1].createdAt
      : null;
  return { entries: page, nextCursorCreatedAt: next };
}
