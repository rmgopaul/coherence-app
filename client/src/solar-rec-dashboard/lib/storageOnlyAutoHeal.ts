/**
 * Helpers for the "storage-only auto-heal" UX shipped 2026-05-12.
 *
 * Background: when a dataset is uploaded via the v1 chunked-CSV path
 * but the server-side migration into `srDs*` row tables never
 * completes (PR #559 fixed one such failure mode — the JSON-envelope
 * unwrap bug), the dataset ends up in a split state:
 *
 *   - `cloudStatus === "synced"` — the blob is in
 *     `solarRecDashboardStorage` and `solarRecDatasetSyncState.
 *     dbPersisted` is true (the v1 sync state reached consistency)
 *   - `populationStatus === "missing"` — no active batch in
 *     `solarRecActiveDatasetVersions`, so no rows in `srDs*`
 *
 * In that state the upload slot UI showed "Saved in cloud" (because
 * `recoverable === true`) but no tab aggregator could read the
 * dataset (they query `srDs*`). The populated counter showed
 * 14 / 18 while the upload slots showed only 1 marked "Not uploaded".
 *
 * Prod (2026-05-12) had 3 datasets stuck in this state for ~2 weeks:
 * `abpQuickBooksRows`, `abpProjectApplicationRows`,
 * `abpUtilityInvoiceRows`. The fix has two parts:
 *
 *   1. PR #559 — fix the migration so it can unwrap the v1 envelope
 *      (separate PR, already merged).
 *   2. This PR — detect the storage-only state from the dashboard's
 *      existing `getDatasetSummariesAll` payload, auto-trigger
 *      `syncCoreDatasetFromStorage` once per (datasetKey, session),
 *      and render a distinct "Re-syncing to row table…" badge
 *      so the user understands what's happening.
 */

export type DatasetSummary = {
  datasetKey: string;
  cloudStatus: "synced" | "failed" | "missing";
  populationStatus: "populated" | "empty" | "missing" | "failed";
  byteCount: number | null;
};

/**
 * A summary is in "storage-only" state when the cloud blob is
 * present and persisted but no `srDs*` rows back it. Returns false
 * for: populated (everything's fine), genuinely-missing (no blob),
 * failed sync (different repair path), and empty (active batch but
 * zero rows — that's a legitimate empty dataset).
 *
 * Also returns false for byteCount <= 0 — the server's
 * `getDatasetSummariesAll` should already mark a 0-byte sync row as
 * `cloudStatus: "missing"`, but the extra guard here means a stale
 * cached client response that predates the server fix can't trigger
 * a no-op sync.
 */
export function isStorageOnlySummary(summary: DatasetSummary): boolean {
  return (
    summary.cloudStatus === "synced" &&
    summary.populationStatus === "missing" &&
    (summary.byteCount ?? 0) > 0
  );
}

/**
 * Given the full list of summaries, return the dataset keys that
 * should be auto-healed. Sorted by `datasetKey` so the order is
 * stable across renders (important: an auto-fire effect that
 * iterates this list shouldn't churn the ref tracking which
 * datasets have already been kicked off).
 */
export function pickStorageOnlyDatasetKeys(
  summaries: ReadonlyArray<DatasetSummary>
): string[] {
  return summaries
    .filter(isStorageOnlySummary)
    .map((s) => s.datasetKey)
    .sort();
}
