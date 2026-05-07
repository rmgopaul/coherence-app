/**
 * Snapshot-log restore service (Task 5.15 PR-B).
 *
 * Companion to `snapshotLogRecovery.ts` (read-only helpers, shipped
 * in PRs #353/#354/#356). The recovery surface composes a deduped
 * candidate from the main `snapshot_logs_v1` row plus orphaned
 * `snapshot_logs_v1_chunk_NNNN` rows that survived a 2026-05
 * partial overwrite. This module performs the WRITE half:
 *
 *   1. Re-run `composeSnapshotLogRecovery` server-side.
 *   2. If `source === "main"` or `"none"`, no-op (idempotent).
 *   3. Else: serialize the deduped entry list to JSON, write it
 *      back to `snapshot_logs_v1` via `saveSolarRecDashboardPayload`.
 *   4. **Verify** the new row deserializes cleanly into the
 *      expected unique-id set. Only then proceed.
 *   5. Delete the orphaned `snapshot_logs_v1_chunk_NNNN` rows.
 *
 * Verify-then-delete (not transactional): chunk rows are
 * independently keyed, and a half-completed restore that wrote new
 * content but failed to prune orphans is recoverable on retry —
 * the next call sees the same orphans and re-runs the verify gate
 * before deleting. Idempotent across crashes / network errors.
 *
 * The verify gate is the safety property. If the round-trip
 * (write → read-back) doesn't reproduce the expected id set, we
 * abort BEFORE deleting orphans — the orphan rows are the only
 * remaining historical artifact, and losing them while the new
 * main row is broken would be unrecoverable.
 */

import {
  composeSnapshotLogRecovery,
  SnapshotLogEntryLike,
} from "./snapshotLogRecovery";

export const SNAPSHOT_LOG_RESTORE_RUNNER_VERSION =
  "snapshot-logs-restore-v1";

// IMPORTANT: cloud writes go through `saveDataset` which prepends
// `dataset:` to the caller-supplied key (see solarRecDashboardRouter.ts
// `saveDataset` proc — `dbStorageKey = \`dataset:${input.key}\``).
// The actual rows in `solarRecDashboardStorage` therefore live under
// `dataset:snapshot_logs_v1` (and `dataset:snapshot_logs_v1_chunk_*`
// for chunk-pointer overflow). The original recovery prefix
// (`snapshot_logs_v1` with no leading `dataset:`) never matched
// anything on disk — it shipped that way in PR #353 and was carried
// forward through PR-A/PR-B, so the recovery surface has been a
// no-op since it landed. This constant fixes that.
const SNAPSHOT_LOG_KEY = "dataset:snapshot_logs_v1";
const SNAPSHOT_LOG_CHUNK_PREFIX = "dataset:snapshot_logs_v1_chunk_";

export type SnapshotLogRestoreOutcome = {
  alreadyConsolidated: boolean;
  entriesRestored: number;
  chunksConsolidated: number;
  orphanRowsPruned: number;
  warnings: string[];
  _runnerVersion: typeof SNAPSHOT_LOG_RESTORE_RUNNER_VERSION;
};

/**
 * Runtime dependencies are passed in so the service is testable
 * without mocking module imports. Production wiring lives in the
 * tRPC procedure.
 */
export interface SnapshotLogRestoreDeps {
  readMainPayload: () => Promise<string | null>;
  readOrphanRows: () => Promise<
    Array<{ storageKey: string; payload: string | null }>
  >;
  writeMainPayload: (payload: string) => Promise<boolean>;
  deleteStorageKeys: (storageKeys: string[]) => Promise<number>;
}

/** Pure: serialize a deduped entry list back to a JSON array string. */
export function serializeSnapshotLogEntries(
  entries: ReadonlyArray<SnapshotLogEntryLike>
): string {
  return JSON.stringify(entries);
}

/** Pure: extract id set from a payload via the existing parser. */
export function extractIdSetFromPayload(payload: string | null): Set<string> {
  if (!payload || payload.trim().length === 0) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const ids = new Set<string>();
  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).id === "string"
    ) {
      ids.add((item as { id: string }).id);
    }
  }
  return ids;
}

/**
 * Run the restore. Idempotent: a second call after a successful
 * restore observes `source === "main"` and returns
 * `alreadyConsolidated: true` with zero side effects.
 */
export async function runSnapshotLogRestore(
  deps: SnapshotLogRestoreDeps
): Promise<SnapshotLogRestoreOutcome> {
  const warnings: string[] = [];
  const [mainPayload, orphanRows] = await Promise.all([
    deps.readMainPayload(),
    deps.readOrphanRows(),
  ]);

  const recovery = composeSnapshotLogRecovery({ mainPayload, orphanRows });
  warnings.push(...recovery.warnings.map((w) => `recovery: ${w}`));

  if (recovery.source === "main" || recovery.source === "none") {
    return {
      alreadyConsolidated: true,
      entriesRestored: recovery.entries.length,
      chunksConsolidated: 0,
      orphanRowsPruned: 0,
      warnings,
      _runnerVersion: SNAPSHOT_LOG_RESTORE_RUNNER_VERSION,
    };
  }

  // source ∈ { "orphaned-chunks", "main-plus-orphaned-chunks" }
  const consolidatedPayload = serializeSnapshotLogEntries(recovery.entries);
  const expectedIds = new Set(recovery.entries.map((entry) => entry.id));

  const writeOk = await deps.writeMainPayload(consolidatedPayload);
  if (!writeOk) {
    throw new Error(
      "snapshot-log-restore: writeMainPayload returned false; aborting BEFORE orphan delete"
    );
  }

  // Verify round-trip. If the read-back doesn't reproduce the
  // expected id set, abort BEFORE deleting orphans — the orphan
  // rows are the only remaining historical artifact, and losing
  // them while the new main row is broken would be unrecoverable.
  const verifyPayload = await deps.readMainPayload();
  const verifyIds = extractIdSetFromPayload(verifyPayload);
  if (verifyIds.size !== expectedIds.size) {
    throw new Error(
      `snapshot-log-restore: verify failed — wrote ${expectedIds.size} ids, read back ${verifyIds.size}; aborting BEFORE orphan delete`
    );
  }
  expectedIds.forEach((id) => {
    if (!verifyIds.has(id)) {
      throw new Error(
        `snapshot-log-restore: verify failed — expected id "${id}" missing from read-back; aborting BEFORE orphan delete`
      );
    }
  });

  const orphanKeysToDelete = orphanRows
    .map((row) => row.storageKey)
    .filter((key) => key.startsWith(SNAPSHOT_LOG_CHUNK_PREFIX));
  const deletedCount =
    orphanKeysToDelete.length === 0
      ? 0
      : await deps.deleteStorageKeys(orphanKeysToDelete);

  if (deletedCount !== orphanKeysToDelete.length) {
    warnings.push(
      `orphan delete returned ${deletedCount}; expected ${orphanKeysToDelete.length}`
    );
  }

  return {
    alreadyConsolidated: false,
    entriesRestored: recovery.entries.length,
    chunksConsolidated: orphanRows.length,
    orphanRowsPruned: deletedCount,
    warnings,
    _runnerVersion: SNAPSHOT_LOG_RESTORE_RUNNER_VERSION,
  };
}

/** Constant exports for the tRPC procedure to reuse. */
export const SNAPSHOT_LOG_RESTORE_KEYS = {
  mainKey: SNAPSHOT_LOG_KEY,
  chunkPrefix: SNAPSHOT_LOG_CHUNK_PREFIX,
};
