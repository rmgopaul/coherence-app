/**
 * True-slim dashboard mount summary.
 *
 * Computes only the headline values the dashboard parent needs on
 * first paint: counts, ownership tile breakdown, size buckets,
 * `totalContractAmount`-based value totals, and a couple of ABP
 * counts. Nothing more.
 *
 * Design constraints (the previous projection-from-heavy-aggregates
 * approach failed each of these):
 *
 *   1. **Warm hits do not parse heavy artifacts.** The slim summary
 *      is cached separately under its own artifactType. On a slim
 *      cache hit we return the ~1 KB JSON immediately; the foundation
 *      payload is not loaded. Only on a slim cache MISS do we touch
 *      the foundation, because we need its canonical per-system
 *      classification to compute the ownership tile breakdown
 *      without re-deriving it from raw rows.
 *
 *   2. **No high-cardinality fields on the wire.** Output omits the
 *      eligibility ID arrays (`eligiblePart2*`), the per-system
 *      lookup maps, and the `ownershipRows[]` projection. Those move
 *      into tab-only paths.
 *
 *   3. **No upstream call to `getOrBuildOverviewSummary` /
 *      `getOrBuildOfflineMonitoringAggregates`.** Those aggregators
 *      build full row arrays and per-system maps just to drop most
 *      of them on the floor — they are tab-tier shapes, not mount-
 *      tier. The slim path stream-folds the typed source columns
 *      directly.
 *
 *   4. **Bounded peak heap.** Source-row scans use
 *      `streamRowsByPage` (5000-row pages, typed-column projection
 *      only — `rawRow` is intentionally NOT selected). Peak heap is
 *      ~one page worth of typed-column rows, regardless of total
 *      row count.
 *
 * Field caveats:
 *   - `totalContractedValue` and the reporting/not-reporting splits
 *     come from `srDsSolarApplications.totalContractAmount`. The
 *     legacy heavy aggregator falls back to a derived contracted-
 *     value (`recPrice × contractedRecs`) when the typed column is
 *     null. The slim path treats those systems as $0 to avoid loading
 *     `srDsDeliverySchedule` + `srDsAbpReport` value fields at mount
 *     time. Tabs that need exact delivered-value totals continue to
 *     read the heavy `getDashboardOverviewSummary` aggregator.
 *   - `totalDeliveredValue`, `totalGap`, `deliveredValuePercent` are
 *     intentionally absent for the same reason.
 *
 * Caching: the slim summary is keyed by `foundationHash`. When the
 * foundation invalidates (any input dataset version changes), the
 * slim cache invalidates with it.
 */

import { srDsAbpReport, srDsSolarApplications } from "../../../drizzle/schema";
import type { FoundationArtifactPayload } from "../../../shared/solarRecFoundation";
import {
  computeFoundationHash,
  loadInputVersions,
  streamRowsByPage,
} from "./buildFoundationArtifact";
import { getOrBuildFoundation } from "./foundationRunner";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

export const SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION =
  "slim-dashboard-summary-v1" as const;
const ARTIFACT_TYPE = "slim-dashboard-summary-v1";

export interface SlimOwnershipOverview {
  reportingOwnershipTotal: number;
  notTransferredReporting: number;
  transferredReporting: number;
  notReportingOwnershipTotal: number;
  notTransferredNotReporting: number;
  transferredNotReporting: number;
  terminatedReporting: number;
  terminatedNotReporting: number;
  terminatedTotal: number;
}

export interface SlimDashboardSummary {
  // Core foundation counts (whole-portfolio, not Part-II-scoped).
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  terminatedSystems: number;
  part2VerifiedSystems: number;
  part2VerifiedAndReportingSystems: number;

  // Size buckets (Part-II-eligible only).
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;

  // Ownership tile breakdown (Part-II-eligible only).
  ownershipOverview: SlimOwnershipOverview;

  // Value totals (Part-II-eligible only, totalContractAmount-based).
  withValueDataCount: number;
  totalContractedValue: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;

  // ABP row counts (legacy date-only Part-II definition).
  abpEligibleTotalSystemsCount: number;
  part2VerifiedAbpRowsCount: number;

  reportingAnchorDateIso: string | null;
}

export const EMPTY_SLIM_DASHBOARD_SUMMARY: SlimDashboardSummary = {
  totalSystems: 0,
  reportingSystems: 0,
  reportingPercent: null,
  terminatedSystems: 0,
  part2VerifiedSystems: 0,
  part2VerifiedAndReportingSystems: 0,
  smallSystems: 0,
  largeSystems: 0,
  unknownSizeSystems: 0,
  ownershipOverview: {
    reportingOwnershipTotal: 0,
    notTransferredReporting: 0,
    transferredReporting: 0,
    notReportingOwnershipTotal: 0,
    notTransferredNotReporting: 0,
    transferredNotReporting: 0,
    terminatedReporting: 0,
    terminatedNotReporting: 0,
    terminatedTotal: 0,
  },
  withValueDataCount: 0,
  totalContractedValue: 0,
  contractedValueReporting: 0,
  contractedValueNotReporting: 0,
  contractedValueReportingPercent: null,
  abpEligibleTotalSystemsCount: 0,
  part2VerifiedAbpRowsCount: 0,
  reportingAnchorDateIso: null,
};

/**
 * Cache-or-compute. Cache key is the foundation hash so a foundation
 * invalidation invalidates the slim summary too.
 *
 * On warm slim-cache hit: returns the cached slim shape. The
 * foundation payload is NOT loaded.
 *
 * On slim-cache miss: loads foundation (cached + single-flighted
 * upstream), stream-folds source rows, writes the slim cache.
 */
export async function getOrBuildSlimDashboardSummary(
  scopeId: string
): Promise<{ result: SlimDashboardSummary; fromCache: boolean }> {
  const inputVersions = await loadInputVersions(scopeId);
  const foundationHash = computeFoundationHash(inputVersions);

  return withArtifactCache<SlimDashboardSummary>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: foundationHash,
    serde: jsonSerde<SlimDashboardSummary>(),
    rowCount: () => 0,
    recompute: async () => {
      const { payload: foundation } = await getOrBuildFoundation(scopeId);
      return computeSlimDashboardSummary(scopeId, foundation);
    },
  });
}

/**
 * Pure-ish builder. Walks `foundation.canonicalSystemsByCsgId`
 * for ownership categorization, then stream-folds typed columns
 * from `srDsSolarApplications` (size + value) and `srDsAbpReport`
 * (ABP counts).
 */
async function computeSlimDashboardSummary(
  scopeId: string,
  foundation: FoundationArtifactPayload
): Promise<SlimDashboardSummary> {
  const part2EligibleSet = new Set(foundation.part2EligibleCsgIds);

  // ---- Foundation walk: ownership tile breakdown ----------------------
  let notTransferredReporting = 0;
  let transferredReporting = 0;
  let notTransferredNotReporting = 0;
  let transferredNotReporting = 0;
  let terminatedReporting = 0;
  let terminatedNotReporting = 0;

  for (const csgId of foundation.part2EligibleCsgIds) {
    const sys = foundation.canonicalSystemsByCsgId[csgId];
    if (!sys) continue;
    const reporting = sys.isReporting;
    if (sys.isTerminated) {
      if (reporting) terminatedReporting++;
      else terminatedNotReporting++;
    } else if (sys.ownershipStatus === "transferred") {
      if (reporting) transferredReporting++;
      else transferredNotReporting++;
    } else {
      if (reporting) notTransferredReporting++;
      else notTransferredNotReporting++;
    }
  }

  // ---- solarApplications stream-fold: size + value -------------------
  let smallSystems = 0;
  let largeSystems = 0;
  let unknownSizeSystems = 0;
  let withValueDataCount = 0;
  let totalContractedValue = 0;
  let contractedValueReporting = 0;
  let contractedValueNotReporting = 0;

  const solarBatchId = foundation.inputVersions.solarApplications.batchId;
  if (solarBatchId) {
    type SolarRow = {
      id: string;
      systemId: string | null;
      installedKwAc: number | null;
      totalContractAmount: number | null;
    };
    await streamRowsByPage<SolarRow>(
      scopeId,
      solarBatchId,
      srDsSolarApplications,
      {
        id: srDsSolarApplications.id,
        systemId: srDsSolarApplications.systemId,
        installedKwAc: srDsSolarApplications.installedKwAc,
        totalContractAmount: srDsSolarApplications.totalContractAmount,
      },
      (row) => {
        const csgId = row.systemId;
        if (!csgId || !part2EligibleSet.has(csgId)) return;

        // Size bucket — same thresholds as the legacy aggregator.
        if (row.installedKwAc === null) {
          unknownSizeSystems++;
        } else if (row.installedKwAc <= 10) {
          smallSystems++;
        } else {
          largeSystems++;
        }

        // Value — totalContractAmount only. Foundation tells us the
        // reporting bucket; isReporting=false includes terminated.
        const amount = row.totalContractAmount;
        if (amount !== null && Number.isFinite(amount)) {
          withValueDataCount++;
          totalContractedValue += amount;
          const sys = foundation.canonicalSystemsByCsgId[csgId];
          if (sys?.isReporting) contractedValueReporting += amount;
          else contractedValueNotReporting += amount;
        }
      }
    );
  }

  // ---- abpReport stream-fold: ABP counts -----------------------------
  // Mirrors the legacy `isPart2VerifiedAbpRow` (date-only) +
  // `resolvePart2ProjectIdentity` dedupe semantics, but using the
  // typed columns instead of parsing rawRow on every row. Avoiding
  // rawRow saves ~64 MB peak heap on prod-shape (~28k rows × ~2 KB
  // per rawRow JSON string).
  const abpBatchId = foundation.inputVersions.abpReport.batchId;
  let part2VerifiedAbpRowsCount = 0;
  const abpDedupeKeys = new Set<string>();
  if (abpBatchId) {
    type AbpRow = {
      id: string;
      applicationId: string | null;
      systemId: string | null;
      trackingSystemRefId: string | null;
      projectName: string | null;
      part2AppVerificationDate: string | null;
    };
    let rowIndex = 0;
    await streamRowsByPage<AbpRow>(
      scopeId,
      abpBatchId,
      srDsAbpReport,
      {
        id: srDsAbpReport.id,
        applicationId: srDsAbpReport.applicationId,
        systemId: srDsAbpReport.systemId,
        trackingSystemRefId: srDsAbpReport.trackingSystemRefId,
        projectName: srDsAbpReport.projectName,
        part2AppVerificationDate: srDsAbpReport.part2AppVerificationDate,
      },
      (row) => {
        const idx = rowIndex++;
        if (!isValidPart2VerificationDate(row.part2AppVerificationDate)) {
          return;
        }
        part2VerifiedAbpRowsCount++;
        abpDedupeKeys.add(part2DedupeKey(row, idx));
      }
    );
  }

  // ---- Assemble -----------------------------------------------------
  const reportingOwnershipTotal =
    notTransferredReporting + transferredReporting;
  const notReportingOwnershipTotal =
    notTransferredNotReporting + transferredNotReporting;
  const terminatedTotal = terminatedReporting + terminatedNotReporting;

  const totalSystems = foundation.summaryCounts.totalSystems;
  const reportingSystems = foundation.summaryCounts.reporting;
  const reportingPercent =
    totalSystems > 0 ? reportingSystems / totalSystems : null;
  const contractedValueReportingPercent =
    totalContractedValue > 0
      ? contractedValueReporting / totalContractedValue
      : null;

  return {
    totalSystems,
    reportingSystems,
    reportingPercent,
    terminatedSystems: foundation.summaryCounts.terminated,
    part2VerifiedSystems: foundation.summaryCounts.part2Verified,
    part2VerifiedAndReportingSystems:
      foundation.summaryCounts.part2VerifiedAndReporting,
    smallSystems,
    largeSystems,
    unknownSizeSystems,
    ownershipOverview: {
      reportingOwnershipTotal,
      notTransferredReporting,
      transferredReporting,
      notReportingOwnershipTotal,
      notTransferredNotReporting,
      transferredNotReporting,
      terminatedReporting,
      terminatedNotReporting,
      terminatedTotal,
    },
    withValueDataCount,
    totalContractedValue,
    contractedValueReporting,
    contractedValueNotReporting,
    contractedValueReportingPercent,
    abpEligibleTotalSystemsCount: abpDedupeKeys.size,
    part2VerifiedAbpRowsCount,
    reportingAnchorDateIso: foundation.reportingAnchorDateIso,
  };
}

/**
 * Same date semantics as `aggregatorHelpers.isPart2VerifiedAbpRow`
 * but using the typed column directly. The full helper requires a
 * `CsvRow` and reaches into `parsePart2VerificationDate`; replicating
 * just the date-validity check here lets us avoid loading rawRow.
 */
function isValidPart2VerificationDate(raw: string | null): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return false;
  const year = parsed.getFullYear();
  return year >= 2009 && year <= 2100;
}

/**
 * Mirrors `aggregatorHelpers.resolvePart2ProjectIdentity`'s dedupe
 * key fallback chain (system → tracking → application → name →
 * row). Uses typed columns so we don't need rawRow.
 */
function part2DedupeKey(
  row: {
    systemId: string | null;
    trackingSystemRefId: string | null;
    applicationId: string | null;
    projectName: string | null;
  },
  index: number
): string {
  const systemId = (row.systemId ?? "").trim();
  if (systemId) return `system:${systemId}`;
  const trackingId = (row.trackingSystemRefId ?? "").trim();
  if (trackingId) return `tracking:${trackingId}`;
  const applicationId = (row.applicationId ?? "").trim();
  if (applicationId) return `application:${applicationId}`;
  const projectName = (row.projectName ?? "").trim();
  if (projectName) return `name:${projectName.toLowerCase()}`;
  return `row:${index}`;
}
