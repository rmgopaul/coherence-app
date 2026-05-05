/**
 * True-slim dashboard mount summary.
 *
 * Output is fixed-shape, bounded peak heap (5000-row pages), and
 * cached separately under its own artifactType so warm hits return
 * without parsing the full foundation payload. The Solar
 * Applications pass reads typed columns directly — pre-2026-05-05
 * versions carried a `rawRow` fallback for batches whose typed
 * size/value columns were unpopulated by older alias lists. After
 * the active-batch typed-column backfill (PR #386 + operational
 * `backfillSrDsTypedColumnsFromRawRow.ts --batch <id>` run on
 * 2026-05-05), the fallback was retired.
 *
 * Coverage (every aggregate Overview needs on first paint):
 *   - Overview headline system counts over canonical Part-II verified
 *     CSG systems (foundation Part-II summaryCounts).
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
 *     virtual "Terminated" collapsing reporting/non-reporting). Per-
 *     project reporting is tracked independently of status so a
 *     terminated-reporting project still contributes to
 *     `summary.reporting` and `contractedValueReporting`.
 *
 * Change Ownership eligibility — IMPORTANT. Part II eligibility for
 * Change Ownership counts/charts/value totals comes from the
 * FOUNDATION, not from ABP-row date sanity. A row is allowed to
 * contribute only when its matched canonical system has
 * `isPart2Verified === true` AND `csgId ∈ foundation.part2EligibleCsgIds`.
 * The legacy date-only ABP-row counts are kept as diagnostic fields
 * (`part2VerifiedAbpRowsCount`, `abpEligibleTotalSystemsCount`) but
 * do NOT drive any first-paint Change Ownership numbers.
 *
 * Project ↔ system matching is multi-valued. One ABP applicationId can
 * map to multiple CSG systems (foundation surfaces this as
 * `ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS`). The slim builder collects ALL
 * matched canonical systems for a project (deduped by CSG ID) and
 * classifies the project from project-level booleans:
 *   - projectIsReporting       = any matched eligible system reports
 *   - projectHasTransferred    = any matched eligible non-terminated
 *                                 system has ownershipStatus
 *                                 "transferred"
 *   - projectHasChangeOwnership = any matched eligible non-terminated
 *                                 system has ownershipStatus
 *                                 "change-of-ownership"
 *   - projectAllTerminated     = matched eligible length > 0 AND every
 *                                 matched eligible system is terminated
 *
 * Value attribution. `solarContractedValueByCsg` records the first
 * recorded `totalContractAmount` per CSG. Slim attributes a
 * representative amount per project (first recorded amount across
 * matched eligible systems, deterministic by sorted CSG ID). Projects
 * where no matched eligible system has a recorded amount are NOT
 * silently summed as 0 — they are counted on
 * `contractedValueProjectsMissingDataCount`. Consumers that depend on
 * total fidelity must check the missing-data count before treating
 * `contractedValueTotal` as authoritative.
 *
 * Solar Applications duplicate-row handling: production data has
 * occasional duplicate rows for the same CSG. Foundation keeps the
 * first row per CSG (`buildFoundationArtifact.ts:478`). Slim mirrors
 * that exactly — every aggregation over solar rows skips
 * already-seen CSGs so size/value/kW totals do not double-count.
 *
 * Delivered-value fields are NOT in this shape. The slim summary
 * does not return `totalDeliveredValue`, `totalGap`, or
 * `deliveredValuePercent`; computing them requires the per-system
 * `deliveredValue` walk that lives behind the heavy
 * `getDashboardOverviewSummary` (and the SystemSnapshot it depends
 * on). Slim consumers must either render an explicit "—" /
 * "Unavailable" placeholder for those tiles, or wait for the heavy
 * query to load.
 *
 * Percent semantics: every `*Percent` field is in 0–100
 * (percentage points), matching `aggregatorHelpers.toPercentValue`.
 */

import { srDsAbpReport, srDsSolarApplications } from "../../../drizzle/schema";
import type {
  FoundationArtifactPayload,
  FoundationCanonicalSystem,
} from "../../../shared/solarRecFoundation";
import {
  parsePart2VerificationDate,
  toPercentValue,
} from "./aggregatorHelpers";
import {
  computeFoundationHash,
  loadInputVersions,
  streamRowsByPage,
} from "./buildFoundationArtifact";
import { getOrBuildFoundation } from "./foundationRunner";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

/**
 * v9 (2026-05-05) — Retired the rawRow fallback that v7/v8 used to
 * paper over null typed columns on already-ingested
 * `srDsSolarApplications` batches. The active batch's typed
 * columns are now the source of truth: `installedKwAc` /
 * `installedKwDc` / `totalContractAmount` come directly from the
 * row, and rows where those are null after the
 * `backfillSrDsTypedColumnsFromRawRow.ts` repair are genuinely
 * missing data (empty cells in the source CSV). Net code
 * reduction: `pickRawNumber` + 2 helpers + 3 alias arrays + the
 * `rawRow` field on the SELECT projection are all gone.
 *
 * v8 (2026-05-05) — Overview headline `totalSystems` /
 * `reportingSystems` now use canonical Part-II verified CSG counts,
 * matching the user-facing Part II Filter QA denominator. Cached v7
 * rows used whole-portfolio counts and made the Overview Total Systems
 * tile start at the wrong value until a heavier query replaced it.
 */
export const SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION =
  "slim-dashboard-summary-v9" as const;
const ARTIFACT_TYPE = "slim-dashboard-summary-v9";

export type SizeBucket = "<=10 kW AC" | ">10 kW AC" | "Unknown";

/**
 * Ownership tile breakdown over Part-II-eligible systems.
 *
 * Foundation contract (`buildFoundationArtifact.ts:606`): a
 * terminated system is NEVER in `part2EligibleCsgIds` — the builder
 * gates `isPart2Verified` on `!system.isTerminated`. The slim
 * Part-II walk therefore cannot supply Part-II-scoped terminated
 * reporting / not-reporting counts.
 *
 * PR #337 follow-up item 6 (2026-05-04) — the `terminatedReporting`,
 * `terminatedNotReporting`, and `terminatedTotal` fields used to be
 * present here as always-0 placeholders. They were removed. The
 * portfolio-wide terminated count is on
 * `SlimDashboardSummary.terminatedSystems`. The Part-II-scoped
 * breakdown is heavy-only — consumers must narrow on
 * `summary.kind === "heavy"` to read it.
 */
export interface SlimOwnershipOverview {
  reportingOwnershipTotal: number;
  notTransferredReporting: number;
  transferredReporting: number;
  notReportingOwnershipTotal: number;
  notTransferredNotReporting: number;
  transferredNotReporting: number;
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
  /**
   * Number of Change-Ownership projects whose matched-eligible
   * systems contributed at least one recorded `totalContractAmount`
   * to `contractedValueTotal`. Equals `total` when every counted
   * project had value data.
   */
  contractedValueProjectsWithDataCount: number;
  /**
   * Number of Change-Ownership projects with NO recorded
   * `totalContractAmount` across any of their matched-eligible
   * systems. These projects are NOT summed as 0 silently — this
   * count surfaces the gap so consumers can render a partial-data
   * indicator instead of treating `contractedValueTotal` as
   * authoritative. `contractedValueProjectsWithDataCount +
   * contractedValueProjectsMissingDataCount === total`.
   */
  contractedValueProjectsMissingDataCount: number;
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

  // Overview headline counts (canonical Part-II verified CSG systems).
  totalSystems: number;
  reportingSystems: number;
  /** 0–100 (percentage points). */
  reportingPercent: number | null;
  /** Portfolio-wide terminated count retained for the slim-only terminated tile. */
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
};

const EMPTY_SIZE_BREAKDOWN: SlimSizeBreakdownRow[] = [
  {
    bucket: "<=10 kW AC",
    total: 0,
    reporting: 0,
    notReporting: 0,
    reportingPercent: null,
    contractedValue: 0,
  },
  {
    bucket: ">10 kW AC",
    total: 0,
    reporting: 0,
    notReporting: 0,
    reportingPercent: null,
    contractedValue: 0,
  },
  {
    bucket: "Unknown",
    total: 0,
    reporting: 0,
    notReporting: 0,
    reportingPercent: null,
    contractedValue: 0,
  },
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
    contractedValueProjectsWithDataCount: 0,
    contractedValueProjectsMissingDataCount: 0,
    counts: CHANGE_OWNERSHIP_STATUS_ORDER.map(status => ({
      status,
      count: 0,
      percent: null,
    })),
  },
  cooNotTransferredNotReportingCurrentCount: 0,
  ownershipStackedChartRows: [
    {
      label: "Reporting",
      notTransferred: 0,
      transferred: 0,
      changeOwnership: 0,
    },
    {
      label: "Not Reporting",
      notTransferred: 0,
      transferred: 0,
      changeOwnership: 0,
    },
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

  // Reverse lookup: ABP applicationId → canonical CSG system(s). One
  // ABP applicationId can map to MULTIPLE CSGs (foundation surfaces
  // this as `ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS`). Storing a single
  // system per ABP id silently drops one of those mappings on every
  // collision, classifying the project off whichever CSG happened to
  // be processed last. Multi-valued so project classification can
  // see every match.
  const abpAppIdToSystems = new Map<string, FoundationCanonicalSystem[]>();
  for (const sys of Object.values(foundation.canonicalSystemsByCsgId)) {
    for (const abpId of sys.abpIds) {
      const trimmed = abpId.trim();
      if (!trimmed) continue;
      const existing = abpAppIdToSystems.get(trimmed);
      if (existing) existing.push(sys);
      else abpAppIdToSystems.set(trimmed, [sys]);
    }
  }

  // ---- Foundation walk: ownership tile breakdown over Part-II ---------
  //
  // Foundation contract (`buildFoundationArtifact.ts:606`):
  //   `isPart2Verified` is set ONLY on non-terminated systems.
  //   `part2EligibleCsgIds` is the sorted set of those CSG IDs.
  // Therefore every system encountered in this walk satisfies
  // `!sys.isTerminated`. The ownership tile breakdown below is
  // intentionally Part-II-scoped + non-terminated. PR #337
  // follow-up item 6 (2026-05-04) removed the always-0 terminated
  // fields from `SlimOwnershipOverview` so consumers can no longer
  // accidentally read them as if real. The portfolio-wide
  // terminated count is on `summary.terminatedSystems` (from
  // `foundation.summaryCounts.terminated`); Part-II-scoped
  // terminated breakdown is heavy-only.
  let notTransferredReporting = 0;
  let transferredReporting = 0;
  let notTransferredNotReporting = 0;
  let transferredNotReporting = 0;

  for (const csgId of foundation.part2EligibleCsgIds) {
    const sys = foundation.canonicalSystemsByCsgId[csgId];
    if (!sys) continue;
    const reporting = sys.isReporting;
    if (sys.ownershipStatus === "transferred") {
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
      row => {
        const csgId = row.systemId;
        if (!csgId || !part2EligibleSet.has(csgId)) return;
        if (solarSeenCsgIds.has(csgId)) return; // first-row-wins dedupe
        solarSeenCsgIds.add(csgId);

        const sys = foundation.canonicalSystemsByCsgId[csgId];
        if (!sys) return;
        const reporting = sys.isReporting;
        // v9 (2026-05-05): typed columns are now the source of
        // truth — the rawRow fallback was retired after the
        // active-batch backfill in PR #386's operational run.
        const installedKwAc = row.installedKwAc;
        const installedKwDc = row.installedKwDc;
        const totalContractAmount = row.totalContractAmount;
        const hasAmount =
          totalContractAmount !== null && Number.isFinite(totalContractAmount);
        const amount = hasAmount ? (totalContractAmount as number) : 0;
        if (hasAmount) solarContractedValueByCsg.set(csgId, amount);

        // Cumulative kW AC: sum of recorded values; null treated as 0.
        cumulativeKwAcPart2 += installedKwAc ?? 0;

        // Cumulative kW DC: track coverage explicitly so the UI can
        // distinguish "real zero" from "data not available."
        dcEligibleSystemCount++;
        if (installedKwDc !== null && Number.isFinite(installedKwDc)) {
          cumulativeKwDcSum += installedKwDc;
          dcDataAvailableCount++;
        }

        // Size bucket.
        let bucket: SizeBucket;
        if (installedKwAc === null) {
          unknownSizeSystems++;
          bucket = "Unknown";
        } else if (installedKwAc <= 10) {
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
  //   3. Match the project to ALL canonical systems via the ABP
  //      applicationId reverse lookup AND direct `system_id`
  //      = `csgId` lookup. Dedupe matched systems by CSG ID.
  //      If unmatched, the ABP row is a foundation
  //      `UNMATCHED_PART2_ABP_ID` integrity warning; skipped.
  //   4. Filter matched systems to FOUNDATION Part-II eligibility
  //      (`isPart2Verified === true && part2EligibleSet.has(csgId)`).
  //      Date-only ABP filter is NOT enough — a row's ABP status can
  //      be rejected/cancelled/withdrawn while still having a valid
  //      Part II date. Foundation already excludes those.
  //   5. Classify into the 5-status contract from PROJECT-LEVEL
  //      booleans over the eligible matched set (mirrors heavy
  //      `buildChangeOwnershipAggregates`):
  //        projectAllTerminated → "Terminated" (virtual);
  //        projectHasChangeOwnership → "Change of Ownership - Not
  //          Transferred and Reporting/Not Reporting";
  //        projectHasTransferred → "Transferred and Reporting/Not
  //          Reporting";
  //        active-only → not counted in change-ownership totals
  //          (still in stacked chart's notTransferred bucket).
  //   6. Track per-project reporting INDEPENDENTLY of status so
  //      terminated-reporting projects still contribute to
  //      `summary.reporting` and `contractedValueReporting`.
  //   7. Attribute a single representative `totalContractAmount` per
  //      project (first recorded amount across matched-eligible
  //      systems, sorted by csgId for determinism). Projects with no
  //      recorded amount across any matched system are tracked on
  //      `contractedValueProjectsMissingDataCount` rather than
  //      silently summed as 0.
  const abpBatchId = foundation.inputVersions.abpReport.batchId;
  let part2VerifiedAbpRowsCount = 0;
  const abpDedupeKeys = new Set<string>();
  const projectStatusByDedupe = new Map<string, ChangeOwnershipStatus>();
  const projectReportingByDedupe = new Map<string, boolean>();
  const projectAmountByDedupe = new Map<string, number | null>();

  let stackedReportingNotTransferred = 0;
  let stackedReportingTransferred = 0;
  let stackedReportingChangeOwnership = 0;
  let stackedNotReportingNotTransferred = 0;
  let stackedNotReportingTransferred = 0;
  let stackedNotReportingChangeOwnership = 0;
  let cooNotTransferredNotReportingCurrentCount = 0;

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
      row => {
        const idx = rowIndex++;
        // PR #334 follow-up item 3 (2026-05-02) — share the
        // canonical date parser with the foundation builder /
        // heavy aggregators / client. The pre-fix `new Date(raw)`
        // path silently rejected Excel serial dates (5-digit
        // integers) that production CSV ingest sometimes emits;
        // those rows would have been counted by the foundation's
        // `isPart2VerifiedAbpRow` helper but skipped by slim,
        // causing a quiet count drift between slim and foundation
        // eligibility.
        if (
          parsePart2VerificationDate(
            row.part2AppVerificationDate ?? undefined
          ) === null
        ) {
          return;
        }
        part2VerifiedAbpRowsCount++;

        const dedupeKey = part2DedupeKey(row, idx);
        if (abpDedupeKeys.has(dedupeKey)) return;
        abpDedupeKeys.add(dedupeKey);

        // Collect ALL matched canonical systems (multi-map +
        // direct system_id lookup), deduped by CSG ID.
        const matchedByCsgId = new Map<string, FoundationCanonicalSystem>();
        const trimmedAppId = row.applicationId?.trim();
        if (trimmedAppId) {
          const fromAppId = abpAppIdToSystems.get(trimmedAppId);
          if (fromAppId) {
            for (const sys of fromAppId) {
              matchedByCsgId.set(sys.csgId, sys);
            }
          }
        }
        const trimmedSystemId = row.systemId?.trim();
        if (trimmedSystemId) {
          const fromSystemId =
            foundation.canonicalSystemsByCsgId[trimmedSystemId];
          if (fromSystemId) {
            matchedByCsgId.set(fromSystemId.csgId, fromSystemId);
          }
        }
        if (matchedByCsgId.size === 0) return;

        // Foundation Part-II gate. Date-only ABP filter is NOT
        // sufficient: the foundation excludes rejected/cancelled/
        // withdrawn ABP statuses even when the date column is
        // populated. `part2EligibleSet` is the canonical truth.
        const matchedEligible: FoundationCanonicalSystem[] = [];
        Array.from(matchedByCsgId.values()).forEach(sys => {
          if (sys.isPart2Verified && part2EligibleSet.has(sys.csgId)) {
            matchedEligible.push(sys);
          }
        });
        if (matchedEligible.length === 0) return;

        // Project-level booleans over the eligible matched set.
        const projectIsReporting = matchedEligible.some(s => s.isReporting);
        const matchedEligibleNonTerminated = matchedEligible.filter(
          s => !s.isTerminated
        );
        const projectAllTerminated = matchedEligibleNonTerminated.length === 0;
        const projectHasTransferred = matchedEligibleNonTerminated.some(
          s => s.ownershipStatus === "transferred"
        );
        const projectHasChangeOwnership = matchedEligibleNonTerminated.some(
          s => s.ownershipStatus === "change-of-ownership"
        );

        // Status classification — mirrors heavy aggregator's
        // priority order: change-of-ownership outranks transferred
        // when both are present; terminated outranks both when ALL
        // matched eligible systems are terminated.
        let status: ChangeOwnershipStatus | null = null;
        if (projectAllTerminated) {
          status = "Terminated";
        } else if (projectHasChangeOwnership) {
          status = projectIsReporting
            ? "Change of Ownership - Not Transferred and Reporting"
            : "Change of Ownership - Not Transferred and Not Reporting";
          if (!projectIsReporting) cooNotTransferredNotReportingCurrentCount++;
        } else if (projectHasTransferred) {
          status = projectIsReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting";
        }

        if (status !== null) {
          projectStatusByDedupe.set(dedupeKey, status);
          projectReportingByDedupe.set(dedupeKey, projectIsReporting);

          // Representative project amount: first recorded amount
          // across matched eligible systems, sorted by csgId for
          // determinism. `null` means no matched eligible system
          // had a recorded `totalContractAmount` — must NOT be
          // summed as 0 silently.
          const sortedByCsgId = [...matchedEligible].sort((a, b) =>
            a.csgId.localeCompare(b.csgId)
          );
          let representativeAmount: number | null = null;
          for (const sys of sortedByCsgId) {
            const amt = solarContractedValueByCsg.get(sys.csgId);
            if (amt !== undefined) {
              representativeAmount = amt;
              break;
            }
          }
          projectAmountByDedupe.set(dedupeKey, representativeAmount);
        }

        // Stacked chart: project bucketed by reporting ×
        // {notTransferred (active), transferred, changeOwnership}.
        // Project-all-terminated is excluded (mirrors heavy).
        if (!projectAllTerminated) {
          if (projectHasChangeOwnership) {
            if (projectIsReporting) stackedReportingChangeOwnership++;
            else stackedNotReportingChangeOwnership++;
          } else if (projectHasTransferred) {
            if (projectIsReporting) stackedReportingTransferred++;
            else stackedNotReportingTransferred++;
          } else {
            // Active-only matched non-terminated set.
            if (projectIsReporting) stackedReportingNotTransferred++;
            else stackedNotReportingNotTransferred++;
          }
        }
      }
    );
  }

  // ---- Assemble -----------------------------------------------------
  const reportingOwnershipTotal =
    notTransferredReporting + transferredReporting;
  const notReportingOwnershipTotal =
    notTransferredNotReporting + transferredNotReporting;
  // Foundation contract: terminated systems are excluded from the
  // Part-II-eligible set, so slim cannot supply "terminated
  // reporting" / "terminated not reporting" Part-II-scoped counts.
  // The `SlimOwnershipOverview` type no longer declares those
  // fields (PR #337 follow-up item 6) — consumers read the
  // portfolio terminated count from `summary.terminatedSystems` or
  // narrow on `summary.kind === "heavy"` for the Part-II-scoped
  // breakdown. See type docstring + foundation walk above.

  const totalSystems = foundation.summaryCounts.part2Verified;
  const reportingSystems = foundation.summaryCounts.part2VerifiedAndReporting;
  const reportingPercent = toPercentValue(reportingSystems, totalSystems);
  const contractedValueReportingPercent = toPercentValue(
    contractedValueReporting,
    totalContractedValue
  );

  const sizeBreakdownRows: SlimSizeBreakdownRow[] = [
    buildBreakdownRow(
      "<=10 kW AC",
      bucketSmallReporting,
      bucketSmallNotReporting
    ),
    buildBreakdownRow(
      ">10 kW AC",
      bucketLargeReporting,
      bucketLargeNotReporting
    ),
    buildBreakdownRow(
      "Unknown",
      bucketUnknownReporting,
      bucketUnknownNotReporting
    ),
  ];

  // Change-ownership counts using the project-status map.
  const statusCounts = new Map<ChangeOwnershipStatus, number>();
  for (const status of CHANGE_OWNERSHIP_STATUS_ORDER)
    statusCounts.set(status, 0);
  const projectStatuses = Array.from(projectStatusByDedupe.values());
  for (const status of projectStatuses) {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const changeOwnershipTotal = projectStatusByDedupe.size;

  // Reporting count derived from per-project flag, NOT from status
  // text. A terminated project with isReporting=true must
  // contribute to reporting (heavy aggregator does the same — its
  // `summary.reporting = rows.filter(r => r.isReporting).length`
  // counts terminated rows too).
  let changeOwnershipReporting = 0;
  let changeOwnershipContractedValueTotal = 0;
  let changeOwnershipContractedValueReporting = 0;
  let changeOwnershipContractedValueNotReporting = 0;
  let changeOwnershipValueProjectsWithDataCount = 0;
  let changeOwnershipValueProjectsMissingDataCount = 0;
  Array.from(projectStatusByDedupe.keys()).forEach(dedupeKey => {
    const reporting = projectReportingByDedupe.get(dedupeKey) ?? false;
    if (reporting) changeOwnershipReporting++;

    const amount = projectAmountByDedupe.get(dedupeKey) ?? null;
    if (amount === null) {
      changeOwnershipValueProjectsMissingDataCount++;
      return;
    }
    changeOwnershipValueProjectsWithDataCount++;
    changeOwnershipContractedValueTotal += amount;
    if (reporting) changeOwnershipContractedValueReporting += amount;
    else changeOwnershipContractedValueNotReporting += amount;
  });

  const changeOwnershipCounts: SlimChangeOwnershipCount[] =
    CHANGE_OWNERSHIP_STATUS_ORDER.map(status => ({
      status,
      count: statusCounts.get(status) ?? 0,
      percent: toPercentValue(
        statusCounts.get(status) ?? 0,
        changeOwnershipTotal
      ),
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
        contractedValueProjectsWithDataCount:
          changeOwnershipValueProjectsWithDataCount,
        contractedValueProjectsMissingDataCount:
          changeOwnershipValueProjectsMissingDataCount,
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
