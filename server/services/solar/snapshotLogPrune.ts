/**
 * Snapshot-log orphan-chunk prune helper (Task 5.15 PR-D).
 *
 * Pure set-difference helper for the
 * `pruneSnapshotLogChunksOutsideSet` tRPC mutation. The mutation
 * itself owns the DB I/O AND the bare-key → full-storageKey
 * translation (mirrors `saveDataset`'s `dataset:` prefix
 * convention); this module owns the decision math so the logic is
 * unit-testable without spinning up a database.
 *
 * Contract:
 *   - `onDiskKeys` — every storageKey currently on disk under the
 *     snapshot-log chunk prefix (queried via
 *     `listSolarRecDashboardStorageByPrefix`). FULL keys including
 *     the `dataset:` prefix.
 *   - `keepKeysFull` — FULL storageKeys the caller wants preserved.
 *     The proc layer is responsible for translating client-side
 *     bare keys (e.g. `"snapshot_logs_v1_chunk_0000"`) into the
 *     full on-disk shape (`"dataset:snapshot_logs_v1_chunk_0000"`)
 *     before invoking this helper.
 *   - `requireOnDiskPrefix` — scope guard. Any `onDiskKey` that
 *     doesn't start with this prefix is skipped, so even a buggy
 *     listing helper can't lead to deleting unrelated rows.
 *
 * Returns the FULL storageKeys to delete with input-listing order
 * preserved (makes log lines reproducible and tests pinnable).
 */

export const SNAPSHOT_LOG_PRUNE_RUNNER_VERSION =
  "snapshot-logs-prune-v1";

export function computeSnapshotLogChunkKeysToPrune(input: {
  onDiskKeys: ReadonlyArray<string>;
  keepKeysFull: ReadonlyArray<string>;
  requireOnDiskPrefix: string;
}): string[] {
  const { onDiskKeys, keepKeysFull, requireOnDiskPrefix } = input;
  if (requireOnDiskPrefix.length === 0) return [];
  const keepSet = new Set(keepKeysFull);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of onDiskKeys) {
    if (!key.startsWith(requireOnDiskPrefix)) continue;
    if (keepSet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}
