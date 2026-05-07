/**
 * Snapshot-log cloud-sync write-side guard (Task 5.15 PR-A).
 *
 * The cloud-sync useEffect in `SolarRecDashboard.tsx` writes the
 * local `logEntries` array to `REMOTE_SNAPSHOT_LOGS_KEY` whenever
 * the local signature changes. Without a guard, a fresh browser
 * holding a one-entry localStorage copy can silently overwrite a
 * larger cloud history (the exact 2026-05 production incident:
 * one main row + ~21 unique entries pinned in orphan chunk rows).
 *
 * This helper is the count-based shrink guard CLAUDE.md's
 * "Snapshot Log — transitional state" section flags as a hard rule
 * but never wired. Pure function, testable in isolation, called
 * once per sync attempt before the write fires.
 *
 * Returns `true` when the sync MUST be skipped because the local
 * count is strictly less than the server's deduped unique-id
 * count. Returns `false` for "safe to write" (equal, larger, or
 * unknown server count).
 *
 * Why a count check (not an id-set diff): keeps the wire payload
 * a single integer, keeps the helper trivially testable, and is
 * sufficient for the documented failure mode — a fresh browser's
 * localStorage holds a strict subset of cloud history. A future
 * row-table migration (Phase 2+) replaces this guard entirely
 * with server-of-truth pagination.
 */
export function shouldSkipSnapshotLogSyncForUnsafeShrink(input: {
  localCount: number;
  serverUniqueIdCount: number | null;
}): boolean {
  const { localCount, serverUniqueIdCount } = input;
  if (serverUniqueIdCount === null) return false;
  if (!Number.isFinite(localCount) || !Number.isFinite(serverUniqueIdCount)) {
    return false;
  }
  if (localCount < 0 || serverUniqueIdCount < 0) return false;
  return localCount < serverUniqueIdCount;
}

export const SNAPSHOT_LOG_UNSAFE_SHRINK_NOTICE =
  "Local snapshot log has fewer entries than cloud — sync paused. Open the Snapshot Log tab to recover.";
