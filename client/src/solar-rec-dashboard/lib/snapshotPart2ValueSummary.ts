/**
 * Snapshot Log / RecValue Part-II value-summary derivation.
 *
 * 2026-05-09 — Extracted out of `SolarRecDashboard.tsx` (Bug #4 +
 * Bug #7 fix from the prod QA walk) so the slim-vs-page-walk
 * preference logic can be unit-tested without mounting the full
 * dashboard.
 *
 * **The bugs.**
 *
 * - **Bug #4 (FOWD).** Pre-fix the value summary was a row-walk
 *   over `part2EligibleSystemsForSizeReporting`, which is itself
 *   accumulated by a `useInfiniteQuery` walk of
 *   `getDashboardSystemsPage`. Each new page incrementally
 *   recomputed the totals; the user saw `Total Contracted Value
 *   (Part II Verified)` cycle from $67M → $253M → $478M as 24
 *   pages streamed in over ~20s.
 *
 * - **Bug #7 (cross-tab drift).** Overview's `overviewPart2Totals`
 *   memo preferred the slim summary only when the page-walk was
 *   empty; once any page landed it switched to a row-walk. The
 *   row-walk and the slim aggregator diverged by ~$90K on $478M of
 *   prod data (canonical Part-II foundation vs. live row dedup
 *   edge cases), so the same headline tile read different values
 *   depending on whether a heavy tab had already fired the walk.
 *
 * **The fix.** Prefer the slim summary's pre-aggregated values
 * unconditionally. The slim mount summary
 * (`buildSlimDashboardSummary.ts`) is the canonical source: it
 * runs on every cold mount, ships in <5 KB, and uses the same
 * Part-II foundation that drives Overview's other counts. The
 * row-walk is the fallback used only for the narrow window
 * before `dashboardSummaryQuery` resolves on the very first
 * render.
 *
 * Slim does NOT expose `totalDeliveredValue` (the per-system
 * `deliveredValue` field is only available via the page-walk or
 * the heavy `getDashboardOverviewSummary`), so the row-walk is
 * still required for that specific field. The remaining 5 fields
 * (`totalContractedValue`, `totalGap`, `contractedValueReporting`,
 * `contractedValueNotReporting`, `contractedValueReportingPercent`)
 * come from slim when available.
 */
export type SnapshotPart2ValueSummary = {
  totalContractedValue: number;
  totalDeliveredValue: number;
  totalGap: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  /** 0–100 (percentage points) — null when total is 0. */
  contractedValueReportingPercent: number | null;
};

/**
 * Slim summary projection consumed by this helper. Fields mirror
 * `buildSlimDashboardSummary.ts:269–278` 1:1.
 */
export type SlimPart2ValueProjection = {
  totalContractedValue: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;
};

/**
 * Derive the value summary from the slim summary if present, else
 * from the per-system row-walk values. `totalDeliveredValue` is
 * always supplied by the caller (it's a row-walk-only field).
 */
export function deriveSnapshotPart2ValueSummary(args: {
  slim: SlimPart2ValueProjection | null;
  rowWalk: {
    totalContractedValue: number;
    contractedValueReporting: number;
    contractedValueNotReporting: number;
    contractedValueReportingPercent: number | null;
  };
  totalDeliveredValue: number;
}): SnapshotPart2ValueSummary {
  const { slim, rowWalk, totalDeliveredValue } = args;
  const source = slim ?? rowWalk;
  const totalContractedValue = source.totalContractedValue;
  const totalGap = totalContractedValue - totalDeliveredValue;
  return {
    totalContractedValue,
    totalDeliveredValue,
    totalGap,
    contractedValueReporting: source.contractedValueReporting,
    contractedValueNotReporting: source.contractedValueNotReporting,
    contractedValueReportingPercent: source.contractedValueReportingPercent,
  };
}
