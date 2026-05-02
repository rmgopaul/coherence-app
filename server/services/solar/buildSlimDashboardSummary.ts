/**
 * True-slim dashboard mount summary.
 *
 * Output is fixed-shape, bounded peak heap (5000-row pages, no
 * `rawRow`), and cached separately under its own artifactType so
 * warm hits return without parsing the full foundation payload.
 *
 * Coverage (every aggregate Overview needs on first paint):
 *   - System counts (foundation summaryCounts).
 *   - Ownership tile breakdown (9-bucket reporting × transferred ×
 *     terminated counts) over Part-II-eligible systems.
 *   - Size buckets + per-bucket reporting/value rollup
 *     (sizeBreakdownRows).
 *   - Cumulative kW AC + kW DC over Part-II-eligible systems with
 *     null-aware coverage so partial DC data does not silently zero.
 *   - `totalContractAmount`-based value totals.
 *   - PROJECT-LEVEL Change-Ownership counts + stacked chart rows +
 *     `cooNotTransferredNotReportingCurrentCount`. Status order
 *     matches the heavy aggregator's 5-status contract (with the
 *     virtual "Terminated" collapsing reporting/non-reporting).
 *   - ABP row counts (legacy date-only filter, dedupe semantics).
 *
 * Solar Applications duplicate-row handling: production data has
 * occasional duplicate rows for the same CSG. Foundation keeps the
 * first row per CSG (`buildFoundationArtifact.ts:478`). Slim mirrors
 * that exactly — every aggregation over solar rows skips
 * already-seen CSGs so size/value/kW totals do not double-count.
 *
 * Percent semantics: every `*Percent` field is in 0–100
 * (percentage points), matching `aggregatorHelpers.toPercentValue`.
 */

import {
  srDsAbpReport,
  srDsSolarApplications,
} from "../../../drizzle/schema";
import type {
  FoundationArtifactPayload,
  FoundationCanonicalSystem,
} from "../../../shared/solarRecFoundation";
import { toPercentValue } from "./aggregatorHelpers";
import {
  computeFoundationHash,
  loadInputVersions,
  streamRowsByPage,
} from "./buildFoundationArtifact";
import { getOrBuildFoundation } from "./foundationRunner";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

export const SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION =
  "slim-dashboard-summary-v3" as const;
const ARTIFACT_TYPE = "slim-dashboard-summary-v3";

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
  /** 0–100 (percentage points) — null when total = 0. */
  reportingPercent: number | null;
  contractedValue: number;
}

/**
 * Project-level Change-Ownership status with the virtual
 * "Terminated" collapse used by the heavy aggregator and the
 * client `CHANGE_OWNERSHIP_ORDER` constant.
 */
export type ChangeOwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Terminated"
  | "Change of Ownership - Not Transferred and Reporting"
  | "Change of Ownership - Not Transferred and Not Reporting";

export const CHANGE_OWNERSHIP_STATUS_ORDER: ChangeOwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Terminated",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
];

export interface SlimChangeOwnershipCount {
  status: ChangeOwnershipStatus;
  count: number;
  /** 0–100 (percentage points) — null when total = 0. */
  percent: number | null;
}

export interface SlimChangeOwnershipSummary {
  total: number;
  reporting: number;
  notReporting: number;
  /** 0–100 (percentage points) — null when total = 0. */
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
  /** Discriminator so client consumers can branch on slim vs heavy explicitly. */
  kind: "slim";

  // Core foundation counts (whole-portfolio, not Part-II-scoped).
  totalSystems: number;
  reportingSystems: number;
  /** 0–100 (percentage points). */
  reportingPercent: number | null;
  terminatedSystems: number;
  part2VerifiedSystems: number;
  part2VerifiedAndReportingSystems: number;

  // Size buckets + per-bucket rollup (Part-II-eligible only).
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;
  sizeBreakdownRows: SlimSizeBreakdownRow[];

  /** Cumulative installed kW AC over Part-II-eligible systems. */
  cumulativeKwAcPart2: number;
  /**
   * Cumulative installed kW DC over Part-II-eligible systems where
   * DC is recorded. `null` when DC data is fully absent for the
   * Part-II eligible set; UI renders an explicit partial-data
   * indicator (e.g. "—") rather than a misleading 0.
   */
  cumulativeKwDcPart2: number | null;
  /** Number of Part-II-eligible CSGs with a non-null `installedKwDc`. */
  dcDataAvailableCount: number;
  /** Number of Part-II-eligible CSGs we attempted to read DC for. */
  dcEligibleSystemCount: number;

  // Ownership tile breakdown (Part-II-eligible only).
  ownershipOverview: SlimOwnershipOverview;

  // Value totals (Part-II-eligible only, totalContractAmount-based).
  withValueDataCount: number;
  totalContractedValue: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  /** 0–100 (percentage points). */
  contractedValueReportingPercent: number | null;

  // Change-Ownership rollups (Part-II-eligible, project-level).
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
  cumulativeKwDcPart2: null,
  dcDataAvailableCount: 0,
  dcEligibleSystemCount: 0,
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

  // Build reverse lookup: ABP applicationId → canonical CSG system.
  // Used by project-level Change-Ownership matching. Foundation
  // already wrote `abpIds[]` per canonical system, so this is a
  // free walk.
  const abpAppIdToSystem = new Map<string, FoundationCanonicalSystem>();
  for (const sys of Object.values(foundation.canonicalSystemsByCsgId)) {
    for (const abpId of sys.abpIds) {
      abpAppIdToSystem.set(abpId, sys);
    }
  }

  // ---- Foundation walk: ownership tile breakdown over Part-II ---------
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

  // ---- solarApplications stream-fold: size, kw, value -----------------
  // CRITICAL: dedupe by CSG ID. Production has duplicate rows for the
  // same canonical CSG; foundation keeps the first row
  // (`buildFoundationArtifact.ts:478`). Slim mirrors that — first
  // solarApplications row per CSG wins.
  //
  // Also stash per-CSG `totalContractAmount` so the ABP walk can
  // attribute project-level Change-Ownership value totals without a
  // second source-table pass.
  const solarSeenCsgIds = new Set<string>();
  const solarContractedValueByCsg = new Map<string, number>();
  let smallSystems = 0;
  let largeSystems = 0;
  let unknownSizeSystems = 0;
  let withValueDataCount = 0;
  let totalContractedValue = 0;
  let contractedValueReporting = 0;
  let contractedValueNotReporting = 0;
  let cumulativeKwAcPart2 = 0;
  let cumulativeKwDcSum = 0;
  let dcDataAvailableCount = 0;
  let dcEligibleSystemCount = 0;

  const bucketSmallReporting = { count: 0, value: 0 };
  const bucketSmallNotReporting = { count: 0, value: 0 };
  const bucketLargeReporting = { count: 0, value: 0 };
  const bucketLargeNotReporting = { count: 0, value: 0 };
  const bucketUnknownReporting = { count: 0, value: 0 };
  const bucketUnknownNotReporting = { count: 0, value: 0 };

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
        if (solarSeenCsgIds.has(csgId)) return; // first-row-wins dedupe
        solarSeenCsgIds.add(csgId);

        const sys = foundation.canonicalSystemsByCsgId[csgId];
        if (!sys) return;
        const reporting = sys.isReporting;
        const hasAmount =
          row.totalContractAmount !== null &&
          Number.isFinite(row.totalContractAmount);
        const amount = hasAmount ? (row.totalContractAmount as number) : 0;
        if (hasAmount) solarContractedValueByCsg.set(csgId, amount);

        // Cumulative kW AC: sum of recorded values; null treated as 0.
        cumulativeKwAcPart2 += row.installedKwAc ?? 0;

        // Cumulative kW DC: track coverage explicitly so the UI can
        // distinguish "real zero" from "data not available."
        dcEligibleSystemCount++;
        if (
          row.installedKwDc !== null &&
          Number.isFinite(row.installedKwDc)
        ) {
          cumulativeKwDcSum += row.installedKwDc;
          dcDataAvailableCount++;
        }

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
        const bucketReporting =
          bucket === "<=10 kW AC"
            ? bucketSmallReporting
            : bucket === ">10 kW AC"
              ? bucketLargeReporting
              : bucketUnknownReporting;
        const bucketNotReporting =
          bucket === "<=10 kW AC"
            ? bucketSmallNotReporting
            : bucket === ">10 kW AC"
              ? bucketLargeNotReporting
              : bucketUnknownNotReporting;
        if (reporting) {
          bucketReporting.count++;
          bucketReporting.value += amount;
        } else {
          bucketNotReporting.count++;
          bucketNotReporting.value += amount;
        }

        // Value totals.
        if (hasAmount) {
          withValueDataCount++;
          totalContractedValue += amount;
          if (reporting) contractedValueReporting += amount;
          else contractedValueNotReporting += amount;
        }
      }
    );
  }

  // ---- abpReport stream-fold: project-level Change-Ownership +
  // ABP counts.
  //
  // For each Part-II-verified ABP row (date-only filter, legacy):
  //   1. Compute dedupe key per `resolvePart2ProjectIdentity`
  //      (system → tracking → application → name → row-index).
  //   2. First row per dedupe key wins.
  //   3. Match the project to a canonical system via the ABP
  //      applicationId reverse lookup, then by direct `system_id`
  //      = `csgId`. If unmatched, the ABP row is a foundation
  //      `UNMATCHED_PART2_ABP_ID` integrity warning; skipped.
  //   4. Classify into the 5-status contract:
  //      terminated → "Terminated" (virtual single bucket);
  //      transferred → "Transferred and Reporting/Not Reporting";
  //      change-of-ownership → "Change of Ownership - Not
  //      Transferred and Reporting/Not Reporting"; active → not
  //      counted in change-ownership totals (still appears in the
  //      stacked chart's `notTransferred` bucket if matched and
  //      non-terminated).
  //   5. Sum value totals from the per-CSG amount map populated
  //      during the solar walk.
  const abpBatchId = foundation.inputVersions.abpReport.batchId;
  let part2VerifiedAbpRowsCount = 0;
  const abpDedupeKeys = new Set<string>();
  const projectStatusByDedupe = new Map<string, ChangeOwnershipStatus>();

  let stackedReportingNotTransferred = 0;
  let stackedReportingTransferred = 0;
  let stackedReportingChangeOwnership = 0;
  let stackedNotReportingNotTransferred = 0;
  let stackedNotReportingTransferred = 0;
  let stackedNotReportingChangeOwnership = 0;
  let cooNotTransferredNotReportingCurrentCount = 0;

  let changeOwnershipContractedValueTotal = 0;
  let changeOwnershipContractedValueReporting = 0;
  let changeOwnershipContractedValueNotReporting = 0;

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

        const dedupeKey = part2DedupeKey(row, idx);
        if (abpDedupeKeys.has(dedupeKey)) return;
        abpDedupeKeys.add(dedupeKey);

        // Project-level matching.
        const matched =
          (row.applicationId
            ? abpAppIdToSystem.get(row.applicationId.trim())
            : undefined) ??
          (row.systemId
            ? foundation.canonicalSystemsByCsgId[row.systemId.trim()]
            : undefined);
        if (!matched) return;

        const reporting = matched.isReporting;
        const amount = solarContractedValueByCsg.get(matched.csgId) ?? 0;

        // Classify into the 5-status contract.
        let status: ChangeOwnershipStatus | null = null;
        if (matched.isTerminated) {
          status = "Terminated";
        } else if (matched.ownershipStatus === "transferred") {
          status = reporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting";
        } else if (matched.ownershipStatus === "change-of-ownership") {
          status = reporting
            ? "Change of Ownership - Not Transferred and Reporting"
            : "Change of Ownership - Not Transferred and Not Reporting";
          if (!reporting) cooNotTransferredNotReportingCurrentCount++;
        }
        if (status !== null) {
          projectStatusByDedupe.set(dedupeKey, status);
          changeOwnershipContractedValueTotal += amount;
          if (reporting) changeOwnershipContractedValueReporting += amount;
          else changeOwnershipContractedValueNotReporting += amount;
        }

        // Stacked chart: matched non-terminated project bucketed by
        // reporting × {notTransferred (active), transferred,
        // changeOwnership}.
        if (!matched.isTerminated) {
          if (matched.ownershipStatus === "change-of-ownership") {
            if (reporting) stackedReportingChangeOwnership++;
            else stackedNotReportingChangeOwnership++;
          } else if (matched.ownershipStatus === "transferred") {
            if (reporting) stackedReportingTransferred++;
            else stackedNotReportingTransferred++;
          } else {
            // Active or null — counted in notTransferred bucket.
            if (reporting) stackedReportingNotTransferred++;
            else stackedNotReportingNotTransferred++;
          }
        }
      }
    );
  }

  // ---- Assemble -----------------------------------------------------
  const reportingOwnershipTotal = notTransferredReporting + transferredReporting;
  const notReportingOwnershipTotal =
    notTransferredNotReporting + transferredNotReporting;
  const terminatedTotal = terminatedReporting + terminatedNotReporting;

  const totalSystems = foundation.summaryCounts.totalSystems;
  const reportingSystems = foundation.summaryCounts.reporting;
  const reportingPercent = toPercentValue(reportingSystems, totalSystems);
  const contractedValueReportingPercent = toPercentValue(
    contractedValueReporting,
    totalContractedValue
  );

  const sizeBreakdownRows: SlimSizeBreakdownRow[] = [
    buildBreakdownRow("<=10 kW AC", bucketSmallReporting, bucketSmallNotReporting),
    buildBreakdownRow(">10 kW AC", bucketLargeReporting, bucketLargeNotReporting),
    buildBreakdownRow("Unknown", bucketUnknownReporting, bucketUnknownNotReporting),
  ];

  // Change-ownership counts using the project-status map.
  const statusCounts = new Map<ChangeOwnershipStatus, number>();
  for (const status of CHANGE_OWNERSHIP_STATUS_ORDER) statusCounts.set(status, 0);
  const projectStatuses = Array.from(projectStatusByDedupe.values());
  for (const status of projectStatuses) {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const changeOwnershipTotal = projectStatusByDedupe.size;
  let changeOwnershipReporting = 0;
  for (const status of projectStatuses) {
    if (status === "Transferred and Reporting") changeOwnershipReporting++;
    else if (status === "Change of Ownership - Not Transferred and Reporting") {
      changeOwnershipReporting++;
    }
    // "Terminated" is virtual and not split by reporting.
  }

  const changeOwnershipCounts: SlimChangeOwnershipCount[] =
    CHANGE_OWNERSHIP_STATUS_ORDER.map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
      percent: toPercentValue(statusCounts.get(status) ?? 0, changeOwnershipTotal),
    }));

  // DC null semantics: report null when no Part-II-eligible system
  // had recorded DC at all. Otherwise return the cumulative sum
  // alongside the coverage counts so the UI can label partial data.
  const cumulativeKwDcPart2 =
    dcDataAvailableCount > 0 ? cumulativeKwDcSum : null;

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
    dcDataAvailableCount,
    dcEligibleSystemCount,
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
        reportingPercent: toPercentValue(
          changeOwnershipReporting,
          changeOwnershipTotal
        ),
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
    reportingPercent: toPercentValue(reporting.count, total),
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
