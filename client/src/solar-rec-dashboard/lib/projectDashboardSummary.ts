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
 * `smallSystems`, `largeSystems`) — but compute them via different
 * paths (slim streams `srDsSolarApplications` rows with first-CSG
 * dedup; heavy reads from the system snapshot's pre-derived
 * fields). On prod data the two diverge by 25–60 per tile.
 *
 * Pre-fix the user observed: first Overview visit (slim) showed
 * `<=10 kW AC: 17,645`; after activating Performance Ratio (which
 * trips the interaction flag) and returning to Overview, the same
 * tile showed `17,705`. The values shift mid-session — small in
 * absolute terms but visibly inconsistent.
 *
 * Fix: when both aggregators are loaded, pin the shared count
 * fields to slim's values (the deterministic, foundation-keyed
 * source) and layer the heavy-only fields on top. Slim is the
 * canonical Part-II count source; heavy contributes only the
 * fields slim doesn't expose (e.g. Part-II-scoped ownership
 * terminated counts).
 *
 * The two aggregators may still produce divergent slim values
 * (the underlying-data question of which is "right"), but the
 * USER-VISIBLE tile is now stable across navigation. Picking ONE
 * source resolves the bug; investigating the underlying ~25–60
 * count drift is a separate diagnostic pass.
 */

/**
 * Shared count projection — fields present on BOTH slim and heavy
 * `OverviewSummary` shapes. Structural; does not import either
 * aggregator's full type so this helper is independent of the
 * server's evolving shape.
 */
export type CommonOverviewCountProjection = {
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  smallSystems: number;
  largeSystems: number;
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
  };
}
