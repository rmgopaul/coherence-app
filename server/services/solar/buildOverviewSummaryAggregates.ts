/**
 * Server-side aggregator for the Overview tab `summary` shape.
 *
 * Phase 5e Followup #4 step 4 PR-C2 (2026-04-30) — replaces the
 * client `summary` useMemo at
 * `client/src/features/solar-rec/SolarRecDashboard.tsx ~L2987`,
 * a 208-line walk over `part2VerifiedAbpRows × systems` that
 * produces both numeric tile values (totalSystems, reportingPercent,
 * ownershipOverview counts, contracted/delivered value totals) and
 * a per-project `ownershipRows` array used for CSV export.
 *
 * The aggregator runs over abpReport rows + the system snapshot.
 * superjson serde because `ownershipRows[i].{latestReportingDate,
 * contractedDate, zillowSoldDate}` are `Date | null`.
 *
 * Cache key bundles abpReport batch + system snapshot hash. Recompute
 * is sub-second on prod-scale inputs.
 */
import { createHash } from "node:crypto";
import { srDsAbpReport } from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  buildFoundationOverlayMap,
  clean,
  isPart2VerifiedAbpRow,
  resolvePart2ProjectIdentity,
  toPercentValue,
} from "./aggregatorHelpers";
import {
  computeSystemSnapshotHash,
  getOrBuildSystemSnapshot,
  loadDatasetRows,
} from "./buildSystemSnapshot";
import { getOrBuildFoundation } from "./foundationRunner";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SizeBucket = "<=10 kW AC" | ">10 kW AC" | "Unknown";

export type OwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Not Transferred and Reporting"
  | "Not Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting";

/**
 * Mirrors `client/src/features/solar-rec/SolarRecDashboard.tsx ::
 * OwnershipOverviewExportRow` exactly. Kept here (not in `shared/`)
 * to avoid the broader hoist; if a third consumer appears, lift to
 * `@shared/`.
 */
export interface OwnershipOverviewExportRow {
  key: string;
  part2ProjectName: string;
  part2ApplicationId: string | null;
  part2SystemId: string | null;
  part2TrackingId: string | null;
  source: "Matched System" | "Part II Unmatched";
  systemName: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  ownershipStatus: OwnershipStatus;
  isReporting: boolean;
  isTransferred: boolean;
  isTerminated: boolean;
  contractType: string | null;
  contractStatusText: string;
  latestReportingDate: Date | null;
  contractedDate: Date | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
}

/**
 * Subset of `SystemRecord` the summary aggregator reads. Validated
 * at the snapshot boundary by `extractSnapshotSystemsForSummary`.
 * Adding a field here is a 2-step change: (a) declare it in this
 * type, (b) extract + default it in the validator below.
 */
export interface SnapshotSystemForSummary {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  sizeBucket: SizeBucket;
  isReporting: boolean;
  isTransferred: boolean;
  isTerminated: boolean;
  ownershipStatus: OwnershipStatus;
  contractType: string | null;
  contractStatusText: string;
  latestReportingDate: Date | null;
  contractedDate: Date | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  totalContractAmount: number | null;
  contractedValue: number | null;
  deliveredValue: number | null;
}

export interface BuildOverviewSummaryInput {
  part2VerifiedAbpRows: CsvRow[];
  systems: readonly SnapshotSystemForSummary[];
}

export interface OverviewSummaryAggregate {
  totalSystems: number;
  reportingSystems: number;
  reportingPercent: number | null;
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;
  ownershipOverview: {
    reportingOwnershipTotal: number;
    notTransferredReporting: number;
    transferredReporting: number;
    notReportingOwnershipTotal: number;
    notTransferredNotReporting: number;
    transferredNotReporting: number;
    terminatedReporting: number;
    terminatedNotReporting: number;
    terminatedTotal: number;
  };
  ownershipRows: OwnershipOverviewExportRow[];
  withValueDataCount: number;
  totalContractedValue: number;
  totalDeliveredValue: number;
  totalGap: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  contractedValueReportingPercent: number | null;
  deliveredValuePercent: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SIZE_BUCKETS = new Set<SizeBucket>([
  "<=10 kW AC",
  ">10 kW AC",
  "Unknown",
]);

const VALID_OWNERSHIP_STATUSES = new Set<OwnershipStatus>([
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Not Transferred and Reporting",
  "Not Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
]);

/**
 * Mirrors `resolveContractValueAmount` in
 * `client/src/solar-rec-dashboard/lib/helpers/system.ts:33` —
 * `firstNonNull(system.totalContractAmount, system.contractedValue) ?? 0`.
 */
function resolveContractValueAmount(
  system: Pick<SnapshotSystemForSummary, "totalContractAmount" | "contractedValue">
): number {
  if (
    typeof system.totalContractAmount === "number" &&
    Number.isFinite(system.totalContractAmount)
  ) {
    return system.totalContractAmount;
  }
  if (
    typeof system.contractedValue === "number" &&
    Number.isFinite(system.contractedValue)
  ) {
    return system.contractedValue;
  }
  return 0;
}

/**
 * Validates + extracts the SnapshotSystemForSummary subset from
 * `snapshot.systems` (typed `unknown[]` because `SystemRecord` lives
 * client-side). Mirrors `extractSnapshotSystems` in `aggregatorHelpers
 * .ts`. Missing or wrong-typed fields fall back to safe defaults.
 */
export function extractSnapshotSystemsForSummary(
  rawSystems: readonly unknown[]
): SnapshotSystemForSummary[] {
  const out: SnapshotSystemForSummary[] = [];
  for (const raw of rawSystems) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;

    const stringOrEmpty = (v: unknown): string =>
      typeof v === "string" ? v : "";
    const stringOrNull = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    const numberOrNull = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const boolOr = (v: unknown, fallback: boolean): boolean =>
      typeof v === "boolean" ? v : fallback;
    const dateOrNull = (v: unknown): Date | null => {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
      if (typeof v === "string" && v.length > 0) {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    };
    const sizeBucketOf = (v: unknown): SizeBucket => {
      if (typeof v === "string" && VALID_SIZE_BUCKETS.has(v as SizeBucket)) {
        return v as SizeBucket;
      }
      return "Unknown";
    };
    const ownershipStatusOf = (v: unknown): OwnershipStatus => {
      if (
        typeof v === "string" &&
        VALID_OWNERSHIP_STATUSES.has(v as OwnershipStatus)
      ) {
        return v as OwnershipStatus;
      }
      // Default — matches the "fallthrough" branch in the client memo
      // (no isTerminated/isTransferred/isReporting → "Not Transferred
      // and Not Reporting").
      return "Not Transferred and Not Reporting";
    };

    const key = stringOrNull(r.key);
    if (!key) continue;

    out.push({
      key,
      systemId: stringOrNull(r.systemId),
      stateApplicationRefId: stringOrNull(r.stateApplicationRefId),
      trackingSystemRefId: stringOrNull(r.trackingSystemRefId),
      systemName: stringOrEmpty(r.systemName),
      sizeBucket: sizeBucketOf(r.sizeBucket),
      isReporting: boolOr(r.isReporting, false),
      isTransferred: boolOr(r.isTransferred, false),
      isTerminated: boolOr(r.isTerminated, false),
      ownershipStatus: ownershipStatusOf(r.ownershipStatus),
      contractType: stringOrNull(r.contractType),
      contractStatusText: stringOrEmpty(r.contractStatusText),
      latestReportingDate: dateOrNull(r.latestReportingDate),
      contractedDate: dateOrNull(r.contractedDate),
      zillowStatus: stringOrNull(r.zillowStatus),
      zillowSoldDate: dateOrNull(r.zillowSoldDate),
      totalContractAmount: numberOrNull(r.totalContractAmount),
      contractedValue: numberOrNull(r.contractedValue),
      deliveredValue: numberOrNull(r.deliveredValue),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

const EMPTY_SUMMARY: OverviewSummaryAggregate = {
  totalSystems: 0,
  reportingSystems: 0,
  reportingPercent: null,
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
  ownershipRows: [],
  withValueDataCount: 0,
  totalContractedValue: 0,
  totalDeliveredValue: 0,
  totalGap: 0,
  contractedValueReporting: 0,
  contractedValueNotReporting: 0,
  contractedValueReportingPercent: null,
  deliveredValuePercent: null,
};

export function buildOverviewSummary(
  input: BuildOverviewSummaryInput
): OverviewSummaryAggregate {
  const { part2VerifiedAbpRows, systems } = input;

  // -------------------------------------------------------------------------
  // Step 1: ID Sets from part-2-verified rows + scoped-systems filter
  // (mirrors the leading block of the client memo).
  // -------------------------------------------------------------------------
  const eligiblePart2ApplicationIds = new Set<string>();
  const eligiblePart2PortalSystemIds = new Set<string>();
  const eligiblePart2TrackingIds = new Set<string>();
  for (const row of part2VerifiedAbpRows) {
    const applicationId = clean(row.Application_ID);
    const portalSystemId = clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
      clean(row.tracking_system_ref_id);
    if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
    if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
    if (trackingId) eligiblePart2TrackingIds.add(trackingId);
  }

  const scopedPart2Systems = systems.filter((system) => {
    const byPortalSystemId = system.systemId
      ? eligiblePart2PortalSystemIds.has(system.systemId)
      : false;
    const byApplicationId = system.stateApplicationRefId
      ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
      : false;
    const byTrackingId = system.trackingSystemRefId
      ? eligiblePart2TrackingIds.has(system.trackingSystemRefId)
      : false;
    return byPortalSystemId || byApplicationId || byTrackingId;
  });

  // -------------------------------------------------------------------------
  // Step 2: 4 indexed maps from scopedPart2Systems for the matching loop.
  // -------------------------------------------------------------------------
  const systemsById = new Map<string, SnapshotSystemForSummary[]>();
  const systemsByApplicationId = new Map<string, SnapshotSystemForSummary[]>();
  const systemsByTrackingId = new Map<string, SnapshotSystemForSummary[]>();
  const systemsByName = new Map<string, SnapshotSystemForSummary[]>();

  const addIndexedSystem = (
    map: Map<string, SnapshotSystemForSummary[]>,
    key: string | null | undefined,
    system: SnapshotSystemForSummary
  ) => {
    const normalized = clean(key);
    if (!normalized) return;
    const existing = map.get(normalized) ?? [];
    existing.push(system);
    map.set(normalized, existing);
  };

  for (const system of scopedPart2Systems) {
    addIndexedSystem(systemsById, system.systemId, system);
    addIndexedSystem(
      systemsByApplicationId,
      system.stateApplicationRefId,
      system
    );
    addIndexedSystem(systemsByTrackingId, system.trackingSystemRefId, system);
    addIndexedSystem(systemsByName, system.systemName.toLowerCase(), system);
  }

  // -------------------------------------------------------------------------
  // Step 3: walk part2VerifiedAbpRows, dedupe, match, classify, count.
  // -------------------------------------------------------------------------
  let notTransferredReporting = 0;
  let transferredReporting = 0;
  let notTransferredNotReporting = 0;
  let transferredNotReporting = 0;
  let terminatedReporting = 0;
  let terminatedNotReporting = 0;
  const uniquePart2Projects = new Set<string>();
  const ownershipRows: OwnershipOverviewExportRow[] = [];

  part2VerifiedAbpRows.forEach((row, index) => {
    const {
      applicationId,
      portalSystemId,
      trackingId,
      projectName,
      projectNameKey,
      dedupeKey,
    } = resolvePart2ProjectIdentity(row, index);
    if (uniquePart2Projects.has(dedupeKey)) return;
    uniquePart2Projects.add(dedupeKey);

    const matchedSystems = new Map<string, SnapshotSystemForSummary>();
    (systemsById.get(portalSystemId) ?? []).forEach((system) =>
      matchedSystems.set(system.key, system)
    );
    (systemsByApplicationId.get(applicationId) ?? []).forEach((system) =>
      matchedSystems.set(system.key, system)
    );
    (systemsByTrackingId.get(trackingId) ?? []).forEach((system) =>
      matchedSystems.set(system.key, system)
    );
    (systemsByName.get(projectNameKey) ?? []).forEach((system) =>
      matchedSystems.set(system.key, system)
    );

    if (matchedSystems.size === 0) {
      notTransferredNotReporting += 1;
      ownershipRows.push({
        key: `part2:${dedupeKey}`,
        part2ProjectName: projectName || "(Unmatched Part II Row)",
        part2ApplicationId: applicationId || null,
        part2SystemId: portalSystemId || null,
        part2TrackingId: trackingId || null,
        source: "Part II Unmatched",
        systemName: projectName || "(Unmatched Part II Row)",
        systemId: portalSystemId || null,
        stateApplicationRefId: applicationId || null,
        trackingSystemRefId: trackingId || null,
        ownershipStatus: "Not Transferred and Not Reporting",
        isReporting: false,
        isTransferred: false,
        isTerminated: false,
        contractType: null,
        contractStatusText: "N/A",
        latestReportingDate: null,
        contractedDate: null,
        zillowStatus: null,
        zillowSoldDate: null,
      });
      return;
    }

    let isReporting = false;
    let isTransferred = false;
    let isTerminated = false;
    matchedSystems.forEach((system) => {
      if (system.isReporting) isReporting = true;
      if (system.isTransferred) isTransferred = true;
      if (system.isTerminated) isTerminated = true;
    });

    const ownershipStatus: OwnershipStatus = isTerminated
      ? isReporting
        ? "Terminated and Reporting"
        : "Terminated and Not Reporting"
      : isTransferred
        ? isReporting
          ? "Transferred and Reporting"
          : "Transferred and Not Reporting"
        : isReporting
          ? "Not Transferred and Reporting"
          : "Not Transferred and Not Reporting";

    const matchedSystemList = Array.from(matchedSystems.values());
    const representative =
      matchedSystemList.find(
        (system) => system.ownershipStatus === ownershipStatus
      ) ?? matchedSystemList[0]!;

    ownershipRows.push({
      key: `part2:${dedupeKey}`,
      part2ProjectName: projectName || representative.systemName,
      part2ApplicationId: applicationId || null,
      part2SystemId: portalSystemId || null,
      part2TrackingId: trackingId || null,
      source: "Matched System",
      systemName: representative.systemName,
      systemId: representative.systemId,
      stateApplicationRefId: representative.stateApplicationRefId,
      trackingSystemRefId: representative.trackingSystemRefId,
      ownershipStatus,
      isReporting,
      isTransferred,
      isTerminated,
      contractType: representative.contractType,
      contractStatusText: representative.contractStatusText,
      latestReportingDate: representative.latestReportingDate,
      contractedDate: representative.contractedDate,
      zillowStatus: representative.zillowStatus,
      zillowSoldDate: representative.zillowSoldDate,
    });

    if (isTerminated) {
      if (isReporting) terminatedReporting += 1;
      else terminatedNotReporting += 1;
      return;
    }
    if (isTransferred) {
      if (isReporting) transferredReporting += 1;
      else transferredNotReporting += 1;
      return;
    }
    if (isReporting) notTransferredReporting += 1;
    else notTransferredNotReporting += 1;
  });

  // -------------------------------------------------------------------------
  // Step 4: roll up totals + value sums.
  // -------------------------------------------------------------------------
  const totalSystems = uniquePart2Projects.size;
  const reportingSystems =
    notTransferredReporting + transferredReporting + terminatedReporting;
  const reportingPercent = toPercentValue(reportingSystems, totalSystems);
  const smallSystems = scopedPart2Systems.filter(
    (system) => system.sizeBucket === "<=10 kW AC"
  ).length;
  const largeSystems = scopedPart2Systems.filter(
    (system) => system.sizeBucket === ">10 kW AC"
  ).length;
  const unknownSizeSystems = scopedPart2Systems.filter(
    (system) => system.sizeBucket === "Unknown"
  ).length;

  const terminatedTotal = terminatedReporting + terminatedNotReporting;
  const reportingOwnershipTotal =
    notTransferredReporting + transferredReporting;
  const notReportingOwnershipTotal =
    notTransferredNotReporting + transferredNotReporting;

  const withValueData = scopedPart2Systems.filter(
    (system) =>
      resolveContractValueAmount(system) > 0 ||
      (system.deliveredValue ?? 0) > 0
  );
  const totalContractedValue = withValueData.reduce(
    (sum, system) => sum + resolveContractValueAmount(system),
    0
  );
  const totalDeliveredValue = withValueData.reduce(
    (sum, system) => sum + (system.deliveredValue ?? 0),
    0
  );
  const contractedValueReporting = withValueData
    .filter((system) => system.isReporting)
    .reduce((sum, system) => sum + resolveContractValueAmount(system), 0);
  const contractedValueNotReporting =
    totalContractedValue - contractedValueReporting;
  const contractedValueReportingPercent = toPercentValue(
    contractedValueReporting,
    totalContractedValue
  );
  const deliveredValuePercent = toPercentValue(
    totalDeliveredValue,
    totalContractedValue
  );

  return {
    totalSystems,
    reportingSystems,
    reportingPercent,
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
    ownershipRows,
    withValueDataCount: withValueData.length,
    totalContractedValue,
    totalDeliveredValue,
    totalGap: totalContractedValue - totalDeliveredValue,
    contractedValueReporting,
    contractedValueNotReporting,
    contractedValueReportingPercent,
    deliveredValuePercent,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint
// ---------------------------------------------------------------------------

const OVERVIEW_SUMMARY_DEPS = ["abpReport"] as const;
// Phase 3.1 (2026-05-01) — bumped from `"overviewSummary"` so old
// cache rows under the legacy snapshot-only definition don't leak
// in. The new payload's `isReporting` / `isTerminated` /
// `ownershipStatus` come from the foundation, not the snapshot's
// legacy `today − 3 months` reporting math.
const ARTIFACT_TYPE = "overviewSummary-v2";

export const OVERVIEW_SUMMARY_RUNNER_VERSION =
  "phase-3.1-overview-foundation@1";

async function computeOverviewSummaryInputHash(
  scopeId: string,
  foundationInputVersionHash: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  snapshotHash: string;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    OVERVIEW_SUMMARY_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  const hash = createHash("sha256")
    .update(
      [
        `runner:${OVERVIEW_SUMMARY_RUNNER_VERSION}`,
        `abp:${abpReportBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
        `foundation:${foundationInputVersionHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, snapshotHash };
}

export async function getOrBuildOverviewSummary(
  scopeId: string
): Promise<{ result: OverviewSummaryAggregate; fromCache: boolean }> {
  // Foundation drives canonical reporting/ownership state for every
  // tab in Phase 3.1. We compute the hash up-front so the cache key
  // changes when the foundation invalidates (new dataset upload).
  const { payload: foundation, inputVersionHash: foundationHash } =
    await getOrBuildFoundation(scopeId);

  const { hash, abpReportBatchId } = await computeOverviewSummaryInputHash(
    scopeId,
    foundationHash
  );

  // No abpReport → no part-2 verified rows possible → empty summary.
  // Skip both the snapshot build and the cache.
  if (!abpReportBatchId) {
    return { result: EMPTY_SUMMARY, fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<OverviewSummaryAggregate>(
    {
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: superjsonSerde<OverviewSummaryAggregate>(),
      rowCount: (agg) => agg.ownershipRows.length,
      recompute: async () => {
        const [snapshot, abpReportRows] = await Promise.all([
          getOrBuildSystemSnapshot(scopeId),
          loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
        ]);
        const part2VerifiedAbpRows = abpReportRows.filter((row) =>
          isPart2VerifiedAbpRow(row)
        );
        const baseSystems = extractSnapshotSystemsForSummary(snapshot.systems);
        // Overlay the canonical state from the foundation. Display
        // fields (systemName, contractedDate, zillowStatus, etc.) and
        // value math (totalContractAmount, deliveredValue) keep
        // snapshot values; isReporting / isTerminated / isTransferred /
        // ownershipStatus come from the foundation so all Phase 3.1
        // tabs agree on the headline counts.
        const overlayMap = buildFoundationOverlayMap(
          foundation.canonicalSystemsByCsgId
        );
        const systems = baseSystems.map((sys) => {
          if (!sys.systemId) return sys;
          const overlay = overlayMap.get(sys.systemId);
          if (!overlay) return sys;
          return { ...sys, ...overlay };
        });
        return buildOverviewSummary({ part2VerifiedAbpRows, systems });
      },
    }
  );

  return { result, fromCache };
}
