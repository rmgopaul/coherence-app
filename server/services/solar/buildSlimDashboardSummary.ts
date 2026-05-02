/**
 * True-slim dashboard mount summary.
 *
 * The dashboard parent uses this for first-paint tile/chart data.
 * Output is fixed-shape (no per-system arrays or maps), bounded
 * peak heap (5000-row pages, no `rawRow`), and cached separately
 * under its own artifactType so warm hits return without parsing
 * the full foundation payload.
 *
 * What's covered (every aggregate Overview needs on first paint):
 *   - System counts (foundation summaryCounts).
 *   - Ownership tile breakdown (9-bucket reporting × transferred ×
 *     terminated counts) over Part-II-eligible systems.
 *   - Size buckets + per-bucket reporting/value rollup
 *     (sizeBreakdownRows).
 *   - Cumulative kW AC + kW DC over Part-II-eligible systems.
 *   - `totalContractAmount`-based value totals.
 *   - Change-Ownership counts + stacked chart rows + the
 *     `cooNotTransferredNotReportingCurrentCount` headline number.
 *   - ABP row counts (legacy date-only filter, dedupe semantics).
 *
 * What's intentionally NOT covered (heavy-only, fetched per tab on
 * explicit user interaction):
 *   - `ownershipRows[]` / per-ABP-project rows — large detail
 *     arrays for CSV export.
 *   - `monitoringDetailsBySystemKey` etc. — per-system maps for
 *     Offline Monitoring tab.
 *   - `totalDeliveredValue` / `totalGap` / `deliveredValuePercent`
 *     — derived from delivery-schedule data which the slim path
 *     intentionally skips on mount. Returned as `null` so the UI
 *     can render an explicit placeholder rather than a silent zero.
 *
 * Fidelity caveat: Change-Ownership counts here are SYSTEM-level
 * (one entry per Part-II-eligible CSG) computed from
 * `foundation.canonicalSystemsByCsgId`. The heavy ChangeOwnership
 * aggregator computes PROJECT-level counts (one entry per Part-II-
 * verified ABP project after dedupe). Numbers may differ when one
 * ABP project maps to multiple CSG systems. The Change Ownership
 * tab still loads the project-level heavy aggregator on its own.
 */

import {
  srDsAbpReport,
  srDsSolarApplications,
} from "../../../drizzle/schema";
import type { FoundationArtifactPayload } from "../../../shared/solarRecFoundation";
import {
  computeFoundationHash,
  loadInputVersions,
  streamRowsByPage,
} from "./buildFoundationArtifact";
import { getOrBuildFoundation } from "./foundationRunner";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

export const SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION =
  "slim-dashboard-summary-v2" as const;
const ARTIFACT_TYPE = "slim-dashboard-summary-v2";

export type SizeBucket = "<=10 kW AC" | ">10 kW AC" | "Unknown";

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

export interface SlimSizeBreakdownRow {
  bucket: SizeBucket;
  total: number;
  reporting: number;
  notReporting: number;
  reportingPercent: number | null;
  contractedValue: number;
}

/**
 * 6-bucket Change-Ownership status (mirrors `ChangeOwnershipStatus`
 * in `buildChangeOwnershipAggregates.ts`). Slim derives counts at
 * the SYSTEM level — see fidelity caveat above.
 */
export type ChangeOwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Change of Ownership - Not Transferred and Reporting"
  | "Change of Ownership - Not Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting";

export const CHANGE_OWNERSHIP_STATUS_ORDER: ChangeOwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
];

export interface SlimChangeOwnershipCount {
  status: ChangeOwnershipStatus;
  count: number;
  percent: number | null;
}

export interface SlimChangeOwnershipSummary {
  total: number;
  reporting: number;
  notReporting: number;
  reportingPercent: number | null;
  contractedValueTotal: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  counts: SlimChangeOwnershipCount[];
}

export interface SlimOwnershipStackedChartRow {
  label: "Reporting" | "Not Reporting";
  notTransferred: number;
  transferred: number;
  changeOwnership: number;
}

export interface SlimChangeOwnership {
  summary: SlimChangeOwnershipSummary;
  cooNotTransferredNotReportingCurrentCount: number;
  ownershipStackedChartRows: [
    SlimOwnershipStackedChartRow,
    SlimOwnershipStackedChartRow,
  ];
}

export interface SlimDashboardSummary {
  /** Discriminator so consumers can branch on slim vs heavy explicitly. */
  kind: "slim";

  // Core foundation counts (whole-portfolio, not Part-II-scoped).
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  terminatedSystems: number;
  part2VerifiedSystems: number;
  part2VerifiedAndReportingSystems: number;

  // Size buckets + per-bucket rollup (Part-II-eligible only).
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;
  sizeBreakdownRows: SlimSizeBreakdownRow[];

  // Cumulative installed kW (Part-II-eligible only).
  cumulativeKwAcPart2: number;
  cumulativeKwDcPart2: number;

  // Ownership tile breakdown (Part-II-eligible only).
  ownershipOverview: SlimOwnershipOverview;

  // Value totals (Part-II-eligible only, totalContractAmount-based).
  withValueDataCount: number;
  totalContractedValue: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;

  // Change-Ownership rollups (Part-II-eligible, system-level).
  changeOwnership: SlimChangeOwnership;

  // ABP row counts (legacy date-only Part-II definition).
  abpEligibleTotalSystemsCount: number;
  part2VerifiedAbpRowsCount: number;

  reportingAnchorDateIso: string | null;
}

const EMPTY_OWNERSHIP_OVERVIEW: SlimOwnershipOverview = {
  reportingOwnershipTotal: 0,
  notTransferredReporting: 0,
  transferredReporting: 0,
  notReportingOwnershipTotal: 0,
  notTransferredNotReporting: 0,
  transferredNotReporting: 0,
  terminatedReporting: 0,
  terminatedNotReporting: 0,
  terminatedTotal: 0,
};

const EMPTY_SIZE_BREAKDOWN: SlimSizeBreakdownRow[] = [
  { bucket: "<=10 kW AC", total: 0, reporting: 0, notReporting: 0, reportingPercent: null, contractedValue: 0 },
  { bucket: ">10 kW AC", total: 0, reporting: 0, notReporting: 0, reportingPercent: null, contractedValue: 0 },
  { bucket: "Unknown", total: 0, reporting: 0, notReporting: 0, reportingPercent: null, contractedValue: 0 },
];

const EMPTY_CHANGE_OWNERSHIP: SlimChangeOwnership = {
  summary: {
    total: 0,
    reporting: 0,
    notReporting: 0,
    reportingPercent: null,
    contractedValueTotal: 0,
    contractedValueReporting: 0,
    contractedValueNotReporting: 0,
    counts: CHANGE_OWNERSHIP_STATUS_ORDER.map((status) => ({
      status,
      count: 0,
      percent: null,
    })),
  },
  cooNotTransferredNotReportingCurrentCount: 0,
  ownershipStackedChartRows: [
    { label: "Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
    { label: "Not Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
  ],
};

export const EMPTY_SLIM_DASHBOARD_SUMMARY: SlimDashboardSummary = {
  kind: "slim",
  totalSystems: 0,
  reportingSystems: 0,
  reportingPercent: null,
  terminatedSystems: 0,
  part2VerifiedSystems: 0,
  part2VerifiedAndReportingSystems: 0,
  smallSystems: 0,
  largeSystems: 0,
  unknownSizeSystems: 0,
  sizeBreakdownRows: EMPTY_SIZE_BREAKDOWN,
  cumulativeKwAcPart2: 0,
  cumulativeKwDcPart2: 0,
  ownershipOverview: EMPTY_OWNERSHIP_OVERVIEW,
  withValueDataCount: 0,
  totalContractedValue: 0,
  contractedValueReporting: 0,
  contractedValueNotReporting: 0,
  contractedValueReportingPercent: null,
  changeOwnership: EMPTY_CHANGE_OWNERSHIP,
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

async function computeSlimDashboardSummary(
  scopeId: string,
  foundation: FoundationArtifactPayload
): Promise<SlimDashboardSummary> {
  const part2EligibleSet = new Set(foundation.part2EligibleCsgIds);

  // ---- Foundation walk: ownership tile + change-ownership breakdown ---
  let notTransferredReporting = 0;
  let transferredReporting = 0;
  let notTransferredNotReporting = 0;
  let transferredNotReporting = 0;
  let terminatedReporting = 0;
  let terminatedNotReporting = 0;

  const changeCounts = new Map<ChangeOwnershipStatus, number>();
  for (const status of CHANGE_OWNERSHIP_STATUS_ORDER) changeCounts.set(status, 0);

  let stackedReportingNotTransferred = 0;
  let stackedReportingTransferred = 0;
  let stackedReportingChangeOwnership = 0;
  let stackedNotReportingNotTransferred = 0;
  let stackedNotReportingTransferred = 0;
  let stackedNotReportingChangeOwnership = 0;
  let cooNotTransferredNotReportingCurrentCount = 0;

  for (const csgId of foundation.part2EligibleCsgIds) {
    const sys = foundation.canonicalSystemsByCsgId[csgId];
    if (!sys) continue;
    const reporting = sys.isReporting;

    // 9-bucket ownership tile
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

    // Change-ownership 6-bucket counts (only systems whose status
    // indicates an ownership change). Foundation's "active" status
    // means no change → not counted in change-ownership totals.
    let coStatus: ChangeOwnershipStatus | null = null;
    if (sys.isTerminated) {
      coStatus = reporting ? "Terminated and Reporting" : "Terminated and Not Reporting";
    } else if (sys.ownershipStatus === "transferred") {
      coStatus = reporting ? "Transferred and Reporting" : "Transferred and Not Reporting";
    } else if (sys.ownershipStatus === "change-of-ownership") {
      coStatus = reporting
        ? "Change of Ownership - Not Transferred and Reporting"
        : "Change of Ownership - Not Transferred and Not Reporting";
      if (!reporting) cooNotTransferredNotReportingCurrentCount++;
    }
    if (coStatus !== null) {
      changeCounts.set(coStatus, (changeCounts.get(coStatus) ?? 0) + 1);
    }

    // Stacked chart (excludes terminated, per the Overview chart
    // semantics in the heavy aggregator).
    if (!sys.isTerminated) {
      if (sys.ownershipStatus === "change-of-ownership") {
        if (reporting) stackedReportingChangeOwnership++;
        else stackedNotReportingChangeOwnership++;
      } else if (sys.ownershipStatus === "transferred") {
        if (reporting) stackedReportingTransferred++;
        else stackedNotReportingTransferred++;
      } else {
        if (reporting) stackedReportingNotTransferred++;
        else stackedNotReportingNotTransferred++;
      }
    }
  }

  // ---- solarApplications stream-fold: size, kw, value -----------------
  let smallSystems = 0;
  let largeSystems = 0;
  let unknownSizeSystems = 0;
  let withValueDataCount = 0;
  let totalContractedValue = 0;
  let contractedValueReporting = 0;
  let contractedValueNotReporting = 0;
  let cumulativeKwAcPart2 = 0;
  let cumulativeKwDcPart2 = 0;

  // Per-bucket size rollup
  const bucketSmallReporting = { count: 0, value: 0 };
  const bucketSmallNotReporting = { count: 0, value: 0 };
  const bucketLargeReporting = { count: 0, value: 0 };
  const bucketLargeNotReporting = { count: 0, value: 0 };
  const bucketUnknownReporting = { count: 0, value: 0 };
  const bucketUnknownNotReporting = { count: 0, value: 0 };

  // Per-system change-ownership value totals (system-level).
  let changeOwnershipContractedValueTotal = 0;
  let changeOwnershipContractedValueReporting = 0;
  let changeOwnershipContractedValueNotReporting = 0;
  let changeOwnershipTotal = 0;
  let changeOwnershipReporting = 0;

  // Pre-tally change-ownership system counts from foundation walk
  // results (we want value totals from solar stream).
  for (const status of CHANGE_OWNERSHIP_STATUS_ORDER) {
    const c = changeCounts.get(status) ?? 0;
    changeOwnershipTotal += c;
    if (status.includes("and Reporting")) {
      changeOwnershipReporting += c;
    }
  }

  const solarBatchId = foundation.inputVersions.solarApplications.batchId;
  if (solarBatchId) {
    type SolarRow = {
      id: string;
      systemId: string | null;
      installedKwAc: number | null;
      installedKwDc: number | null;
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
        installedKwDc: srDsSolarApplications.installedKwDc,
        totalContractAmount: srDsSolarApplications.totalContractAmount,
      },
      (row) => {
        const csgId = row.systemId;
        if (!csgId || !part2EligibleSet.has(csgId)) return;
        const sys = foundation.canonicalSystemsByCsgId[csgId];
        if (!sys) return;
        const reporting = sys.isReporting;
        const amount =
          row.totalContractAmount !== null && Number.isFinite(row.totalContractAmount)
            ? row.totalContractAmount
            : 0;

        // Cumulative kW (sum even when null → 0).
        cumulativeKwAcPart2 += row.installedKwAc ?? 0;
        cumulativeKwDcPart2 += row.installedKwDc ?? 0;

        // Size bucket.
        let bucket: SizeBucket;
        if (row.installedKwAc === null) {
          unknownSizeSystems++;
          bucket = "Unknown";
        } else if (row.installedKwAc <= 10) {
          smallSystems++;
          bucket = "<=10 kW AC";
        } else {
          largeSystems++;
          bucket = ">10 kW AC";
        }

        // Per-bucket rollup.
        if (bucket === "<=10 kW AC") {
          if (reporting) {
            bucketSmallReporting.count++;
            bucketSmallReporting.value += amount;
          } else {
            bucketSmallNotReporting.count++;
            bucketSmallNotReporting.value += amount;
          }
        } else if (bucket === ">10 kW AC") {
          if (reporting) {
            bucketLargeReporting.count++;
            bucketLargeReporting.value += amount;
          } else {
            bucketLargeNotReporting.count++;
            bucketLargeNotReporting.value += amount;
          }
        } else {
          if (reporting) {
            bucketUnknownReporting.count++;
            bucketUnknownReporting.value += amount;
          } else {
            bucketUnknownNotReporting.count++;
            bucketUnknownNotReporting.value += amount;
          }
        }

        // Value totals.
        if (row.totalContractAmount !== null && Number.isFinite(row.totalContractAmount)) {
          withValueDataCount++;
          totalContractedValue += amount;
          if (reporting) contractedValueReporting += amount;
          else contractedValueNotReporting += amount;

          // Change-ownership scoped value totals.
          const isChangeOwnership =
            sys.isTerminated ||
            sys.ownershipStatus === "transferred" ||
            sys.ownershipStatus === "change-of-ownership";
          if (isChangeOwnership) {
            changeOwnershipContractedValueTotal += amount;
            if (reporting) changeOwnershipContractedValueReporting += amount;
            else changeOwnershipContractedValueNotReporting += amount;
          }
        }
      }
    );
  }

  // ---- abpReport stream-fold: ABP counts -----------------------------
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
        if (!isValidPart2VerificationDate(row.part2AppVerificationDate)) return;
        part2VerifiedAbpRowsCount++;
        abpDedupeKeys.add(part2DedupeKey(row, idx));
      }
    );
  }

  // ---- Assemble -----------------------------------------------------
  const reportingOwnershipTotal = notTransferredReporting + transferredReporting;
  const notReportingOwnershipTotal = notTransferredNotReporting + transferredNotReporting;
  const terminatedTotal = terminatedReporting + terminatedNotReporting;

  const totalSystems = foundation.summaryCounts.totalSystems;
  const reportingSystems = foundation.summaryCounts.reporting;
  const reportingPercent = totalSystems > 0 ? reportingSystems / totalSystems : null;
  const contractedValueReportingPercent =
    totalContractedValue > 0 ? contractedValueReporting / totalContractedValue : null;

  // Size breakdown rows.
  const sizeBreakdownRows: SlimSizeBreakdownRow[] = [
    buildBreakdownRow("<=10 kW AC", bucketSmallReporting, bucketSmallNotReporting),
    buildBreakdownRow(">10 kW AC", bucketLargeReporting, bucketLargeNotReporting),
    buildBreakdownRow("Unknown", bucketUnknownReporting, bucketUnknownNotReporting),
  ];

  // Change-ownership counts list with percentages.
  const changeOwnershipCounts: SlimChangeOwnershipCount[] =
    CHANGE_OWNERSHIP_STATUS_ORDER.map((status) => {
      const count = changeCounts.get(status) ?? 0;
      const percent =
        changeOwnershipTotal > 0 ? count / changeOwnershipTotal : null;
      return { status, count, percent };
    });
  const changeOwnershipReportingPercent =
    changeOwnershipTotal > 0
      ? changeOwnershipReporting / changeOwnershipTotal
      : null;

  return {
    kind: "slim",
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
    sizeBreakdownRows,
    cumulativeKwAcPart2,
    cumulativeKwDcPart2,
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
    changeOwnership: {
      summary: {
        total: changeOwnershipTotal,
        reporting: changeOwnershipReporting,
        notReporting: changeOwnershipTotal - changeOwnershipReporting,
        reportingPercent: changeOwnershipReportingPercent,
        contractedValueTotal: changeOwnershipContractedValueTotal,
        contractedValueReporting: changeOwnershipContractedValueReporting,
        contractedValueNotReporting: changeOwnershipContractedValueNotReporting,
        counts: changeOwnershipCounts,
      },
      cooNotTransferredNotReportingCurrentCount,
      ownershipStackedChartRows: [
        {
          label: "Reporting",
          notTransferred: stackedReportingNotTransferred,
          transferred: stackedReportingTransferred,
          changeOwnership: stackedReportingChangeOwnership,
        },
        {
          label: "Not Reporting",
          notTransferred: stackedNotReportingNotTransferred,
          transferred: stackedNotReportingTransferred,
          changeOwnership: stackedNotReportingChangeOwnership,
        },
      ],
    },
    abpEligibleTotalSystemsCount: abpDedupeKeys.size,
    part2VerifiedAbpRowsCount,
    reportingAnchorDateIso: foundation.reportingAnchorDateIso,
  };
}

function buildBreakdownRow(
  bucket: SizeBucket,
  reporting: { count: number; value: number },
  notReporting: { count: number; value: number }
): SlimSizeBreakdownRow {
  const total = reporting.count + notReporting.count;
  return {
    bucket,
    total,
    reporting: reporting.count,
    notReporting: notReporting.count,
    reportingPercent: total > 0 ? reporting.count / total : null,
    contractedValue: reporting.value + notReporting.value,
  };
}

function isValidPart2VerificationDate(raw: string | null): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return false;
  const year = parsed.getFullYear();
  return year >= 2009 && year <= 2100;
}

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
