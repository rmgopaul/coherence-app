/**
 * Dashboard summary projection helper.
 *
 * 2026-05-09 — Bug #8 from the prod QA walk. Pre-fix the parent's
 * `summary` memo in `SolarRecDashboard.tsx` swapped wholesale
 * between two aggregators:
 *
 *   - Slim (`getDashboardSummary`): server-aggregated, ships in
 *     ~5 KB on cold mount. The Overview tab's first paint reads
 *     from this.
 *   - Heavy (`getDashboardOverviewSummary`): heavier server
 *     aggregator that loads the system snapshot + ABP rollups.
 *     Gated on `isOverviewTabActive && hasUserInteracted-
 *     WithDashboard`, so it doesn't fire on cold mount.
 *
 * Both aggregators expose the same shared count fields
 * (`totalSystems`, `reportingSystems`, `reportingPercent`,
 * `smallSystems`, `largeSystems`, `unknownSizeSystems`) — but
 * compute them via different paths (slim streams
 * `srDsSolarApplications` rows with first-CSG dedup; heavy reads
 * from the system snapshot's pre-derived fields). On prod data the
 * two diverge by 25–60 per tile.
 *
 * Pre-fix the user observed: first Overview visit (slim) showed
 * `<=10 kW AC: 17,645`; after activating Performance Ratio (which
 * trips the interaction flag) and returning to Overview, the same
 * tile showed `17,705`. The values shift mid-session — small in
 * absolute terms but visibly inconsistent.
 *
 * Fix: when both aggregators are loaded, pin the shared count
 * fields to slim's values and layer the heavy-only fields on top.
 * Slim becomes the **stable** source for shared counts (heavy
 * still contributes its heavy-only fields, e.g. Part-II-scoped
 * ownership terminated counts). "Stable" — not "canonical" or
 * "correct": the two aggregators still produce divergent values,
 * and which one is "right" is an underlying-data question this PR
 * does NOT settle. Picking ONE source resolves the user-visible
 * shift between navigation events; investigating the underlying
 * ~25–60 count drift is tracked as a follow-up in
 * `docs/qa-walk-2026-05-09.md` (Bug #8 follow-up section).
 */

/**
 * Shared count projection — fields present on BOTH slim
 * (`buildSlimDashboardSummary.ts`) and heavy
 * (`buildOverviewSummaryAggregates.ts`) `OverviewSummary` shapes.
 * Structural; does not import either aggregator's full type so this
 * helper is independent of the server's evolving shape.
 *
 * **Maintenance note** (post-merge review of PR-7, 2026-05-09):
 * adding a new field to BOTH aggregators that should be pinned
 * means adding it BOTH here AND to the override block in
 * `pinSharedCountsToSlim`. The 2026-05-09 audit confirmed
 * `unknownSizeSystems` is also a shared field — pinning it here
 * forecloses the same drift on that tile. If a future shared field
 * is added without a matching pin, the unpinned tile silently
 * regresses to swap-between-aggregators behavior.
 */
export type CommonOverviewCountProjection = {
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;
};

/**
 * Layer the slim summary's deterministic count fields on top of the
 * heavy aggregator's full output. Caller passes the heavy result as
 * the base (so heavy-only fields like
 * `ownershipOverview.terminatedTotal` survive); the projection
 * overrides the shared fields with slim's values.
 *
 * Generic so this helper can be reused for the actual `summary`
 * memo without restating the shape — TypeScript inference picks up
 * the heavy summary type at the call site.
 */
export function pinSharedCountsToSlim<T extends CommonOverviewCountProjection>(
  heavy: T,
  slim: CommonOverviewCountProjection
): T {
  return {
    ...heavy,
    totalSystems: slim.totalSystems,
    reportingSystems: slim.reportingSystems,
    reportingPercent: slim.reportingPercent,
    smallSystems: slim.smallSystems,
    largeSystems: slim.largeSystems,
    unknownSizeSystems: slim.unknownSizeSystems,
  };
}
