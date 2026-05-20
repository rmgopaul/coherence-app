/**
 * Pure derivation of the `populationStatus` reported by
 * `getDatasetSummariesAll` on the solar-rec dashboard router.
 *
 * Extracted to a colocated helper (PR #629 follow-up B1) so the
 * derivation can be unit-tested without spinning up DB integration
 * tests, and so the contract — especially the post-clear case —
 * lives in one place with a regression rail.
 *
 * The classifier upstream (`isStorageOnlySummary` in
 * `client/src/solar-rec-dashboard/lib/storageOnlyAutoHeal.ts`)
 * triggers the storage-only auto-heal on
 * `cloudStatus === "synced" && populationStatus === "missing" &&
 * byteCount > 0`. The original PR #629 surfaced `"failed"` whenever
 * the latest `solarRecImportBatches` row for the dataset had
 * `status === "failed"` and there was no active version — but it
 * forgot to gate on cloud-blob presence. After a successful
 * `clearDatasetCloudStorage` mutation, the blob is gone
 * (`cloudStatus: "missing"`) yet the historical failed batches are
 * intentionally retained (audit trail). Without the cloudStatus
 * gate the slot would stay stuck at `"failed"` forever after a
 * clear — which is exactly the workflow this whole change exists
 * to enable.
 */

export type CloudStatus = "synced" | "failed" | "missing";

export type PopulationStatus = "populated" | "empty" | "missing" | "failed";

export interface DerivePopulationStatusInput {
  /** Resolved by the caller from sync-state + active batch. */
  cloudStatus: CloudStatus;
  /** True iff a row exists in `solarRecActiveDatasetVersions`. */
  hasActiveBatch: boolean;
  /** From the active batch's `solarRecImportBatches.rowCount`. */
  activeBatchRowCount: number | null;
  /**
   * True iff the MOST RECENT `solarRecImportBatches` row for this
   * (scopeId, datasetKey) has `status === "failed"`. Resolved by the
   * caller from a bounded per-dataset query (NOT a scope-wide scan).
   */
  latestBatchFailed: boolean;
}

export function derivePopulationStatus(
  input: DerivePopulationStatusInput
): PopulationStatus {
  // Terminal cloud-side failure — separate repair path; the auto-
  // heal correctly stays out of it.
  if (input.cloudStatus === "failed") return "failed";

  // No active batch: either nothing's been ingested OR the ingest
  // attempt(s) failed. Surface "failed" ONLY when the blob is still
  // present (`cloudStatus === "synced"`); a cleared dataset has no
  // blob and historical failed batches must NOT keep the slot
  // stuck — the post-clear workflow requires "missing" so the
  // dataset card returns to "not uploaded".
  if (!input.hasActiveBatch) {
    return input.cloudStatus === "synced" && input.latestBatchFailed
      ? "failed"
      : "missing";
  }

  // Active batch present — row count decides.
  return (input.activeBatchRowCount ?? 0) > 0 ? "populated" : "empty";
}
