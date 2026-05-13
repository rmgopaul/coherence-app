/**
 * Shared `shouldCache` predicates for dashboard aggregators that
 * cache results via `withArtifactCache`.
 *
 * **Why this module exists.** Three sequential production cache-
 * poisoning incidents (PRs #556, #557, #567) all traced back to
 * the same predicate template:
 *
 *     if (scheduleRowsTotal === 0 || eligibleTrackingIdCount === 0)
 *       return true; // cache the empty result
 *     if (rowsEmitted === 0)
 *       return false; // refuse "suspicious empty"
 *     return true;
 *
 * The middle branch is a poison vector. When the recompute hits a
 * transient `eligibleTrackingIdCount=0` (snapshot degraded under
 * heap pressure, a join missed because the snapshot returned 0
 * systems mid-build, etc.), the predicate caches the empty array
 * "as genuinely empty" — and every subsequent call serves the
 * poisoned payload until either a batch upload changes the input
 * hash or an operator bumps the runner version.
 *
 * The tightening that ended the incident in `shouldCachePerformance
 * SourceRowsResult` (PR #567): **only cache an empty result when
 * scheduleRowsTotal === 0** (structurally guaranteed empty —
 * nothing to aggregate over). Any other 0-row result is refused;
 * next call retries and the fresh diagnostic surfaces.
 *
 * Cost of refusing: aggregators with empty eligibility but
 * non-empty schedule recompute every call (returning 0 rows every
 * call). On empty-eligibility inputs the recompute is sub-second
 * (no per-row iteration cost beyond the eligibility filter
 * itself), so the cost is negligible compared to the cache-poison
 * risk it eliminates.
 *
 * This module consolidates the predicate so all four solar-rec
 * dashboard aggregators that share the
 * `(scheduleRowsTotal, eligibleTrackingIdCount, rowsEmitted)`
 * shape call ONE implementation. Future aggregators with the same
 * shape just import this; aggregators with a different shape (e.g.
 * `PerformanceRatio` which already lives on a row-table fact
 * builder, not `withArtifactCache`) don't apply.
 */

export interface AggregatorEmptyResultPredicateInput {
  /** Row count emitted by the recompute. Cache target. */
  rowsEmitted: number;
  /**
   * Size of the primary "rows to iterate" input (typically
   * `srDsDeliverySchedule` rows). When this is 0, the empty
   * output is structurally guaranteed — safe to cache.
   */
  scheduleRowsTotal: number;
  /**
   * Size of the Part-2 eligibility filter applied to those
   * rows. NOT used to allow caching empty results — only
   * surfaced via the diagnostic shape that callers already
   * record for observability. Including it on the input type
   * keeps the call-site shape identical across aggregators
   * (each one already records this counter for its
   * `diagnostic` field) so the call boilerplate stays one-
   * liner clean.
   */
  eligibleTrackingIdCount: number;
}

/**
 * Returns `true` if the aggregator's empty result should be
 * persisted to `solarRecComputedArtifacts`. Returns `false` to
 * refuse caching (next call recomputes; fresh diagnostic surfaces).
 *
 * Rule: only cache when `scheduleRowsTotal === 0`. Any 0-row
 * result with non-empty schedule input is refused.
 */
export function shouldCacheAggregatorEmptyResult(
  input: AggregatorEmptyResultPredicateInput
): boolean {
  // Trivially-empty schedule input → empty output is structurally
  // guaranteed, safe to cache.
  if (input.scheduleRowsTotal === 0) return true;
  // Non-empty schedule + 0 rows out → suspicious. Refuse.
  if (input.rowsEmitted === 0) return false;
  return true;
}
