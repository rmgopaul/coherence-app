/**
 * Slim dashboard-mount summary.
 *
 * Phase 3a of the data-plane rebuild. The dashboard mount today
 * eagerly fires `getDashboardOverviewSummary` (which carries
 * `ownershipRows: OwnershipOverviewExportRow[]`, ~5–15 MB on prod
 * data) and `getDashboardOfflineMonitoring` (which carries per-system
 * lookup objects, ~2–5 MB) just to read a handful of headline counts
 * + the Part-II eligibility ID lists.
 *
 * `getDashboardSummary` projects the same upstream aggregates into a
 * <1 MB wire shape: counts, ownership-overview tile values, value
 * totals, and the three eligibility ID lists (capped at ~21k strings
 * each → ~300 KB total uncompressed). The two heavy procs continue
 * to back the Overview and Offline-Monitoring tabs respectively;
 * Phase 3b switches the dashboard mount to consume this endpoint and
 * the heavy procs become tab-only.
 *
 * Caching: this aggregator does NOT add its own cache. The projection
 * is cheap; the upstream `getOrBuildOverviewSummary` /
 * `getOrBuildOfflineMonitoringAggregates` calls already hit
 * `solarRecComputedArtifacts` (and benefit from the in-process
 * single-flight from Phase 2). On a warm dashboard the projection
 * runs in single-digit milliseconds; on cold cache the work has to
 * happen anyway because the same tabs read the same upstream
 * aggregates.
 */

import type { OfflineMonitoringAggregate } from "./buildOfflineMonitoringAggregates";
import { getOrBuildOfflineMonitoringAggregates } from "./buildOfflineMonitoringAggregates";
import type { OverviewSummaryAggregate } from "./buildOverviewSummaryAggregates";
import { getOrBuildOverviewSummary } from "./buildOverviewSummaryAggregates";

export const DASHBOARD_SUMMARY_RUNNER_VERSION = "dashboard-summary-v1" as const;

export interface DashboardSummary {
  // System counts (from OverviewSummaryAggregate).
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;

  // Ownership-overview tile values.
  ownershipOverview: OverviewSummaryAggregate["ownershipOverview"];

  // Value totals.
  withValueDataCount: number;
  totalContractedValue: number;
  totalDeliveredValue: number;
  totalGap: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;
  deliveredValuePercent: number | null;

  // Part-II eligibility (from OfflineMonitoringAggregate). The dashboard
  // mount filters `systems` against these three sets to produce
  // `part2EligibleSystemsForSizeReporting`.
  abpEligibleTotalSystemsCount: number;
  eligiblePart2ApplicationIds: string[];
  eligiblePart2PortalSystemIds: string[];
  eligiblePart2TrackingIds: string[];
}

/**
 * Pure projection: take the two upstream aggregates and produce the
 * slim mount-summary shape. Exposed as a standalone function so tests
 * can exercise the projection logic without standing up the upstream
 * caches.
 */
export function projectDashboardSummary(
  overview: OverviewSummaryAggregate,
  offlineMonitoring: OfflineMonitoringAggregate
): DashboardSummary {
  return {
    totalSystems: overview.totalSystems,
    reportingSystems: overview.reportingSystems,
    reportingPercent: overview.reportingPercent,
    smallSystems: overview.smallSystems,
    largeSystems: overview.largeSystems,
    unknownSizeSystems: overview.unknownSizeSystems,
    ownershipOverview: overview.ownershipOverview,
    withValueDataCount: overview.withValueDataCount,
    totalContractedValue: overview.totalContractedValue,
    totalDeliveredValue: overview.totalDeliveredValue,
    totalGap: overview.totalGap,
    contractedValueReporting: overview.contractedValueReporting,
    contractedValueNotReporting: overview.contractedValueNotReporting,
    contractedValueReportingPercent: overview.contractedValueReportingPercent,
    deliveredValuePercent: overview.deliveredValuePercent,
    abpEligibleTotalSystemsCount:
      offlineMonitoring.abpEligibleTotalSystemsCount,
    eligiblePart2ApplicationIds: offlineMonitoring.eligiblePart2ApplicationIds,
    eligiblePart2PortalSystemIds: offlineMonitoring.eligiblePart2PortalSystemIds,
    eligiblePart2TrackingIds: offlineMonitoring.eligiblePart2TrackingIds,
  };
}

/**
 * Async wrapper: fetch both upstream aggregates (in parallel, behind
 * their own caches + single-flight), then project. Returns
 * `fromCache` true when BOTH upstream calls were cache hits — the
 * mount can use this to surface a "live data" indicator without
 * needing to read the upstream `fromCache` flags itself.
 */
export async function getDashboardSummary(
  scopeId: string
): Promise<{ result: DashboardSummary; fromCache: boolean }> {
  const [overview, offlineMonitoring] = await Promise.all([
    getOrBuildOverviewSummary(scopeId),
    getOrBuildOfflineMonitoringAggregates(scopeId),
  ]);
  return {
    result: projectDashboardSummary(overview.result, offlineMonitoring.result),
    fromCache: overview.fromCache && offlineMonitoring.fromCache,
  };
}
