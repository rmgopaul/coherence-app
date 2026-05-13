/**
 * Pick the newest of a set of candidate timestamps and return its
 * ISO-8601 string. Used by `getDatasetSummariesAll` to derive each
 * dataset's `lastUpdated` field.
 *
 * Why this exists: prior to 2026-05-12 the proc cascaded via
 * `??` — preferring `syncRow.updatedAt`, falling back to
 * `activeBatch.completedAt`, then `activeBatch.createdAt`. That
 * cascade was wrong because:
 *
 *   - v1 uploads (legacy chunked-CSV path) DO update
 *     `solarRecDatasetSyncState.updatedAt`.
 *   - v2 uploads (modern row-table path) write to `srDs*` rows +
 *     `solarRecImportBatches` only, NOT to
 *     `solarRecDatasetSyncState`.
 *
 * Once a dataset that was originally uploaded via v1 gets re-
 * uploaded via v2, the cascade keeps returning the STALE
 * `syncRow.updatedAt` because that row's `updatedAt` is frozen
 * at the last v1 write — even though the import-batches row has
 * a fresh `uploadCompletedAt` from today.
 *
 * Prod (2026-05-12) showed up to **331 hours** of drift across
 * five datasets that had been re-uploaded via v2 since the v1 sweep
 * (e.g. `accountSolarGeneration`: `syncRow.updatedAt=2026-04-28`
 * vs `activeBatch.uploadCompletedAt=2026-05-12`). The Data Quality
 * tab compared `now - lastUpdated` against its age threshold and
 * showed every v2-uploaded dataset as "Stale" forever.
 *
 * Fix: take the MAX of every available timestamp. If all candidates
 * are null/undefined, return null. Otherwise return the most recent
 * valid Date as an ISO string.
 *
 * Inputs are typed as `Date | null | undefined` because that's what
 * the Drizzle column accessors return. Invalid Dates (`NaN`-valued)
 * are treated as null — see the `Number.isFinite` guard.
 */
export function pickNewestTimestamp(
  candidates: ReadonlyArray<Date | null | undefined>
): string | null {
  let newest: Date | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ms = candidate.getTime();
    if (!Number.isFinite(ms)) continue;
    if (newest == null || ms > newest.getTime()) {
      newest = candidate;
    }
  }
  return newest ? newest.toISOString() : null;
}
