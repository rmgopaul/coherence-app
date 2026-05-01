/**
 * Server-side aggregator for the Change of Ownership tab + Overview
 * tab's stacked chart row.
 *
 * Phase 5e Followup #4 step 4 PR-C3 (2026-04-30) — replaces three
 * client memos that walk `part2VerifiedAbpRows × systems`:
 *   - `changeOwnershipRows` (~140 LOC, in `SolarRecDashboard.tsx`):
 *     per-(part2 project) rows where any matched system has
 *     `hasChangedOwnership === true`. Each row mutates the
 *     representative system with computed `changeOwnershipStatus` /
 *     `ownershipStatus` / `latestReportingDate` (max across matches).
 *   - `changeOwnershipSummary` (~30 LOC, same file): rollup totals
 *     + per-status counts driven by `CHANGE_OWNERSHIP_ORDER`.
 *   - `ownershipStackedChartRows` (in OverviewTab): 2-row × 3-bucket
 *     stacked chart of Reporting × NotTransferred / Transferred /
 *     ChangeOwnership.
 *
 * superjson serde because `rows[i].{contractedDate, zillowSoldDate,
 * latestReportingDate}` are `Date | null`.
 */
import { createHash } from "node:crypto";
import { srDsAbpReport } from "../../../drizzle/schemas/solar";
import type {
  FoundationArtifactPayload,
  FoundationCanonicalSystem,
} from "../../../shared/solarRecFoundation";
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

export type ChangeOwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Terminated"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting"
  | "Change of Ownership - Not Transferred and Reporting"
  | "Change of Ownership - Not Transferred and Not Reporting";

export type OwnershipStatus =
  | "Transferred and Reporting"
  | "Transferred and Not Reporting"
  | "Not Transferred and Reporting"
  | "Not Transferred and Not Reporting"
  | "Terminated and Reporting"
  | "Terminated and Not Reporting";

/**
 * Ordered list driving `changeOwnershipSummary.counts`. Mirrors
 * `client/src/solar-rec-dashboard/lib/constants.ts ::
 * CHANGE_OWNERSHIP_ORDER`. Note "Terminated" is a virtual status —
 * counts include any row whose `changeOwnershipStatus` starts with
 * "Terminated" (handles both "Terminated and Reporting" and
 * "Terminated and Not Reporting" + the bare "Terminated" the
 * aggregator emits when ALL matched systems are terminated).
 */
const CHANGE_OWNERSHIP_ORDER: ChangeOwnershipStatus[] = [
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Terminated",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
];

/**
 * Projected-row shape consumed by ChangeOwnershipTab. Subset of
 * SystemRecord — just the fields the tab reads (filter, sort, table
 * cells, CSV export).
 */
export interface ChangeOwnershipExportRow {
  key: string;
  systemName: string;
  systemId: string | null;
  trackingSystemRefId: string | null;
  installedKwAc: number | null;
  contractType: string | null;
  contractStatusText: string;
  contractedDate: Date | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  latestReportingDate: Date | null;
  changeOwnershipStatus: ChangeOwnershipStatus;
  ownershipStatus: OwnershipStatus;
  isReporting: boolean;
  isTerminated: boolean;
  isTransferred: boolean;
  hasChangedOwnership: boolean;
  /**
   * Captured from the representative system. Used by
   * `changeOwnershipSummary.contractedValueTotal/Reporting`
   * downstream.
   */
  totalContractAmount: number | null;
  contractedValue: number | null;
}

export type ChangeOwnershipSummaryCount = {
  status: ChangeOwnershipStatus;
  count: number;
  percent: number | null;
};

export type ChangeOwnershipSummary = {
  total: number;
  reporting: number;
  notReporting: number;
  reportingPercent: number | null;
  contractedValueTotal: number;
  contractedValueReporting: number;
  contractedValueNotReporting: number;
  counts: ChangeOwnershipSummaryCount[];
};

export type OwnershipStackedChartRow = {
  label: "Reporting" | "Not Reporting";
  notTransferred: number;
  transferred: number;
  changeOwnership: number;
};

export interface ChangeOwnershipAggregate {
  rows: ChangeOwnershipExportRow[];
  summary: ChangeOwnershipSummary;
  cooNotTransferredNotReportingCurrentCount: number;
  ownershipStackedChartRows: [
    OwnershipStackedChartRow,
    OwnershipStackedChartRow,
  ];
}

/**
 * Subset of `SystemRecord` the aggregator reads. Validated at the
 * snapshot boundary by `extractSnapshotSystemsForChangeOwnership`.
 *
 * Adding a field here is a 2-step change: declare it, then extract
 * + default it in the validator below.
 */
export interface SnapshotSystemForChangeOwnership {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: number | null;
  isReporting: boolean;
  isTransferred: boolean;
  isTerminated: boolean;
  ownershipStatus: OwnershipStatus;
  contractType: string | null;
  contractStatusText: string;
  contractedDate: Date | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  latestReportingDate: Date | null;
  hasChangedOwnership: boolean;
  changeOwnershipStatus: ChangeOwnershipStatus | null;
  totalContractAmount: number | null;
  contractedValue: number | null;
}

export interface BuildChangeOwnershipInput {
  part2VerifiedAbpRows: CsvRow[];
  systems: readonly SnapshotSystemForChangeOwnership[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_OWNERSHIP_STATUSES = new Set<OwnershipStatus>([
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Not Transferred and Reporting",
  "Not Transferred and Not Reporting",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
]);

const VALID_CHANGE_OWNERSHIP_STATUSES = new Set<ChangeOwnershipStatus>([
  "Transferred and Reporting",
  "Transferred and Not Reporting",
  "Terminated",
  "Terminated and Reporting",
  "Terminated and Not Reporting",
  "Change of Ownership - Not Transferred and Reporting",
  "Change of Ownership - Not Transferred and Not Reporting",
]);

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function resolveContractValueAmount(
  system: Pick<
    SnapshotSystemForChangeOwnership | ChangeOwnershipExportRow,
    "totalContractAmount" | "contractedValue"
  >
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

export function extractSnapshotSystemsForChangeOwnership(
  rawSystems: readonly unknown[]
): SnapshotSystemForChangeOwnership[] {
  const out: SnapshotSystemForChangeOwnership[] = [];
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
    const ownershipStatusOf = (v: unknown): OwnershipStatus => {
      if (
        typeof v === "string" &&
        VALID_OWNERSHIP_STATUSES.has(v as OwnershipStatus)
      ) {
        return v as OwnershipStatus;
      }
      return "Not Transferred and Not Reporting";
    };
    const changeOwnershipStatusOf = (
      v: unknown
    ): ChangeOwnershipStatus | null => {
      if (
        typeof v === "string" &&
        VALID_CHANGE_OWNERSHIP_STATUSES.has(v as ChangeOwnershipStatus)
      ) {
        return v as ChangeOwnershipStatus;
      }
      return null;
    };

    const key = stringOrNull(r.key);
    if (!key) continue;

    out.push({
      key,
      systemId: stringOrNull(r.systemId),
      stateApplicationRefId: stringOrNull(r.stateApplicationRefId),
      trackingSystemRefId: stringOrNull(r.trackingSystemRefId),
      systemName: stringOrEmpty(r.systemName),
      installedKwAc: numberOrNull(r.installedKwAc),
      isReporting: boolOr(r.isReporting, false),
      isTransferred: boolOr(r.isTransferred, false),
      isTerminated: boolOr(r.isTerminated, false),
      ownershipStatus: ownershipStatusOf(r.ownershipStatus),
      contractType: stringOrNull(r.contractType),
      contractStatusText: stringOrEmpty(r.contractStatusText),
      contractedDate: dateOrNull(r.contractedDate),
      zillowStatus: stringOrNull(r.zillowStatus),
      zillowSoldDate: dateOrNull(r.zillowSoldDate),
      latestReportingDate: dateOrNull(r.latestReportingDate),
      hasChangedOwnership: boolOr(r.hasChangedOwnership, false),
      changeOwnershipStatus: changeOwnershipStatusOf(r.changeOwnershipStatus),
      totalContractAmount: numberOrNull(r.totalContractAmount),
      contractedValue: numberOrNull(r.contractedValue),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

const EMPTY_CHANGE_OWNERSHIP: ChangeOwnershipAggregate = {
  rows: [],
  summary: {
    total: 0,
    reporting: 0,
    notReporting: 0,
    reportingPercent: null,
    contractedValueTotal: 0,
    contractedValueReporting: 0,
    contractedValueNotReporting: 0,
    counts: CHANGE_OWNERSHIP_ORDER.map((status) => ({
      status,
      count: 0,
      percent: null,
    })),
  },
  cooNotTransferredNotReportingCurrentCount: 0,
  ownershipStackedChartRows: [
    { label: "Reporting", notTransferred: 0, transferred: 0, changeOwnership: 0 },
    {
      label: "Not Reporting",
      notTransferred: 0,
      transferred: 0,
      changeOwnership: 0,
    },
  ],
};

export function buildChangeOwnership(
  input: BuildChangeOwnershipInput
): ChangeOwnershipAggregate {
  const { part2VerifiedAbpRows, systems } = input;

  if (part2VerifiedAbpRows.length === 0) {
    return EMPTY_CHANGE_OWNERSHIP;
  }

  // -------------------------------------------------------------------------
  // Step 1: ID Sets + scopedPart2Systems filter (mirrors the start of the
  // client `changeOwnershipRows` and `ownershipStackedChartRows` memos —
  // both walk the same filter). Identical to the OverviewSummary
  // aggregator's setup.
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
  // Step 2: 4 indexed maps from scopedPart2Systems.
  // -------------------------------------------------------------------------
  const systemsById = new Map<string, SnapshotSystemForChangeOwnership[]>();
  const systemsByApplicationId = new Map<
    string,
    SnapshotSystemForChangeOwnership[]
  >();
  const systemsByTrackingId = new Map<
    string,
    SnapshotSystemForChangeOwnership[]
  >();
  const systemsByName = new Map<string, SnapshotSystemForChangeOwnership[]>();

  const addIndexedSystem = (
    map: Map<string, SnapshotSystemForChangeOwnership[]>,
    key: string | null | undefined,
    system: SnapshotSystemForChangeOwnership
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
  // Step 3: walk part2VerifiedAbpRows ONCE, building both
  // `changeOwnershipRows` and the stacked-chart rollup.
  // -------------------------------------------------------------------------
  const uniquePart2Projects = new Set<string>();
  const rows: ChangeOwnershipExportRow[] = [];
  const stacked = {
    reporting: { notTransferred: 0, transferred: 0, changeOwnership: 0 },
    notReporting: { notTransferred: 0, transferred: 0, changeOwnership: 0 },
  };

  part2VerifiedAbpRows.forEach((row, index) => {
    const { applicationId, portalSystemId, trackingId, projectNameKey, dedupeKey } =
      resolvePart2ProjectIdentity(row, index);
    if (uniquePart2Projects.has(dedupeKey)) return;
    uniquePart2Projects.add(dedupeKey);

    const matchedSystems = new Map<string, SnapshotSystemForChangeOwnership>();
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

    // ---- ownershipStackedChartRows (per the OverviewTab memo) --------------
    if (matchedSystems.size === 0) {
      stacked.notReporting.notTransferred += 1;
    } else {
      let chartIsReporting = false;
      let chartIsTransferred = false;
      let chartIsTerminated = false;
      let chartIsChangeOwnershipNotTransferred = false;
      matchedSystems.forEach((system) => {
        if (system.isReporting) chartIsReporting = true;
        if (system.isTransferred) chartIsTransferred = true;
        if (system.isTerminated) chartIsTerminated = true;
        const normalizedChangeOwnershipStatus = clean(
          system.changeOwnershipStatus ?? ""
        );
        if (
          normalizedChangeOwnershipStatus.startsWith(
            "Change of Ownership - Not Transferred"
          )
        ) {
          chartIsChangeOwnershipNotTransferred = true;
        }
      });

      // Terminated systems are excluded from the stacked chart.
      if (!chartIsTerminated) {
        const target = chartIsReporting ? stacked.reporting : stacked.notReporting;
        if (chartIsChangeOwnershipNotTransferred) {
          target.changeOwnership += 1;
        } else if (chartIsTransferred) {
          target.transferred += 1;
        } else {
          target.notTransferred += 1;
        }
      }
    }

    // ---- changeOwnershipRows (per the parent memo) -------------------------
    const allMatched = Array.from(matchedSystems.values());
    const nonTerminatedSystems = allMatched.filter(
      (system) => !system.isTerminated
    );

    if (nonTerminatedSystems.length === 0) {
      const hasChangedOwnership = allMatched.some(
        (system) => system.hasChangedOwnership
      );
      if (hasChangedOwnership) {
        const representative = allMatched[0]!;
        const isReporting = allMatched.some((system) => system.isReporting);
        const latestReportingDate = allMatched.reduce<Date | null>(
          (latest, system) => maxDate(latest, system.latestReportingDate),
          null
        );
        rows.push({
          key: `coo:${dedupeKey}`,
          systemName: representative.systemName,
          systemId: representative.systemId,
          trackingSystemRefId: representative.trackingSystemRefId,
          installedKwAc: representative.installedKwAc,
          contractType: representative.contractType,
          contractStatusText: representative.contractStatusText,
          contractedDate: representative.contractedDate,
          zillowStatus: representative.zillowStatus,
          zillowSoldDate: representative.zillowSoldDate,
          latestReportingDate,
          changeOwnershipStatus: "Terminated",
          ownershipStatus: isReporting
            ? "Terminated and Reporting"
            : "Terminated and Not Reporting",
          isReporting,
          isTerminated: true,
          isTransferred: false,
          hasChangedOwnership: true,
          totalContractAmount: representative.totalContractAmount,
          contractedValue: representative.contractedValue,
        });
      }
      return;
    }

    const hasChangedOwnership = nonTerminatedSystems.some(
      (system) => system.hasChangedOwnership
    );
    if (!hasChangedOwnership) return;

    const isReporting = nonTerminatedSystems.some((system) => system.isReporting);
    const isTransferred = nonTerminatedSystems.some(
      (system) =>
        system.isTransferred ||
        clean(system.changeOwnershipStatus ?? "").startsWith("Transferred")
    );
    const hasChangeOwnershipNotTransferred = nonTerminatedSystems.some(
      (system) =>
        clean(system.changeOwnershipStatus ?? "").startsWith(
          "Change of Ownership - Not Transferred"
        )
    );

    const changeOwnershipStatus: ChangeOwnershipStatus =
      hasChangeOwnershipNotTransferred
        ? isReporting
          ? "Change of Ownership - Not Transferred and Reporting"
          : "Change of Ownership - Not Transferred and Not Reporting"
        : isTransferred
          ? isReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting"
          : isReporting
            ? "Change of Ownership - Not Transferred and Reporting"
            : "Change of Ownership - Not Transferred and Not Reporting";

    const representative =
      nonTerminatedSystems.find(
        (system) => system.changeOwnershipStatus === changeOwnershipStatus
      ) ??
      nonTerminatedSystems.find(
        (system) =>
          system.hasChangedOwnership && system.changeOwnershipStatus !== null
      ) ??
      nonTerminatedSystems[0]!;

    const latestReportingDate = nonTerminatedSystems.reduce<Date | null>(
      (latest, system) => maxDate(latest, system.latestReportingDate),
      null
    );

    rows.push({
      key: `coo:${dedupeKey}`,
      systemName: representative.systemName,
      systemId: representative.systemId,
      trackingSystemRefId: representative.trackingSystemRefId,
      installedKwAc: representative.installedKwAc,
      contractType: representative.contractType,
      contractStatusText: representative.contractStatusText,
      contractedDate: representative.contractedDate,
      zillowStatus: representative.zillowStatus,
      zillowSoldDate: representative.zillowSoldDate,
      latestReportingDate,
      changeOwnershipStatus,
      ownershipStatus: isTransferred
        ? isReporting
          ? "Transferred and Reporting"
          : "Transferred and Not Reporting"
        : isReporting
          ? "Not Transferred and Reporting"
          : "Not Transferred and Not Reporting",
      isReporting,
      isTerminated: false,
      isTransferred,
      hasChangedOwnership: true,
      totalContractAmount: representative.totalContractAmount,
      contractedValue: representative.contractedValue,
    });
  });

  // -------------------------------------------------------------------------
  // Step 4: sort + summary rollup.
  // -------------------------------------------------------------------------
  rows.sort((a, b) =>
    a.systemName.localeCompare(b.systemName, undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );

  const total = rows.length;
  const reporting = rows.filter((row) => row.isReporting).length;
  const notReporting = total - reporting;
  const reportingPercent = toPercentValue(reporting, total);
  const contractedValueTotal = rows.reduce(
    (sum, row) => sum + resolveContractValueAmount(row),
    0
  );
  const contractedValueReporting = rows
    .filter((row) => row.isReporting)
    .reduce((sum, row) => sum + resolveContractValueAmount(row), 0);
  const contractedValueNotReporting =
    contractedValueTotal - contractedValueReporting;
  const counts: ChangeOwnershipSummaryCount[] = CHANGE_OWNERSHIP_ORDER.map(
    (status) => {
      const count =
        status === "Terminated"
          ? rows.filter((r) => r.changeOwnershipStatus.startsWith("Terminated"))
              .length
          : rows.filter((r) => r.changeOwnershipStatus === status).length;
      return { status, count, percent: toPercentValue(count, total) };
    }
  );

  const cooNotTransferredNotReportingCurrentCount = rows.filter(
    (row) =>
      row.changeOwnershipStatus ===
      "Change of Ownership - Not Transferred and Not Reporting"
  ).length;

  return {
    rows,
    summary: {
      total,
      reporting,
      notReporting,
      reportingPercent,
      contractedValueTotal,
      contractedValueReporting,
      contractedValueNotReporting,
      counts,
    },
    cooNotTransferredNotReportingCurrentCount,
    ownershipStackedChartRows: [
      {
        label: "Reporting",
        notTransferred: stacked.reporting.notTransferred,
        transferred: stacked.reporting.transferred,
        changeOwnership: stacked.reporting.changeOwnership,
      },
      {
        label: "Not Reporting",
        notTransferred: stacked.notReporting.notTransferred,
        transferred: stacked.notReporting.transferred,
        changeOwnership: stacked.notReporting.changeOwnership,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Foundation overlay — Phase 3.1 (2026-05-01)
//
// Same overlay pattern as Overview, but with two extra fields the
// Change of Ownership tab cares about:
//   - `hasChangedOwnership`: true for any non-active foundation system.
//   - `changeOwnershipStatus`: legacy 7-state enum derived from
//     `(ownershipStatus, isReporting)`.
//
// Active systems get `null` for `changeOwnershipStatus` (the legacy
// behavior — the tab filters those rows out).
// ---------------------------------------------------------------------------

type ChangeOwnershipFoundationOverlay = {
  hasChangedOwnership: boolean;
  changeOwnershipStatus: ChangeOwnershipStatus | null;
};

function foundationChangeOwnershipOverlay(
  sys: FoundationCanonicalSystem
): ChangeOwnershipFoundationOverlay {
  const status = sys.ownershipStatus;
  const isReporting = sys.isReporting;

  if (status === null || status === "active") {
    return { hasChangedOwnership: false, changeOwnershipStatus: null };
  }

  let changeOwnershipStatus: ChangeOwnershipStatus;
  if (status === "terminated") {
    changeOwnershipStatus = isReporting
      ? "Terminated and Reporting"
      : "Terminated and Not Reporting";
  } else if (status === "transferred") {
    changeOwnershipStatus = isReporting
      ? "Transferred and Reporting"
      : "Transferred and Not Reporting";
  } else {
    // change-of-ownership
    changeOwnershipStatus = isReporting
      ? "Change of Ownership - Not Transferred and Reporting"
      : "Change of Ownership - Not Transferred and Not Reporting";
  }
  return { hasChangedOwnership: true, changeOwnershipStatus };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint
// ---------------------------------------------------------------------------

const CHANGE_OWNERSHIP_DEPS = ["abpReport"] as const;
// Phase 3.1 (2026-05-01) — bumped from `"changeOwnership"` so old
// cache rows under the legacy snapshot-only definition don't leak
// in. The new payload's `hasChangedOwnership` /
// `changeOwnershipStatus` come from the foundation, not the
// snapshot.
const ARTIFACT_TYPE = "changeOwnership-v2";

export const CHANGE_OWNERSHIP_RUNNER_VERSION =
  "phase-3.1-changeownership-foundation@1";

async function computeChangeOwnershipInputHash(
  scopeId: string,
  foundationInputVersionHash: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  snapshotHash: string;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    CHANGE_OWNERSHIP_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  const hash = createHash("sha256")
    .update(
      [
        `runner:${CHANGE_OWNERSHIP_RUNNER_VERSION}`,
        `abp:${abpReportBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
        `foundation:${foundationInputVersionHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, snapshotHash };
}

/**
 * Pure recompute body — extracted so cross-tab parity tests can
 * exercise the full foundation-overlay path without touching the
 * DB. Cached entrypoint passes already-loaded inputs.
 *
 * Two-part overlay: 6-state canonical fields (shared via
 * `buildFoundationOverlayMap`) + COO-specific fields
 * (`hasChangedOwnership`, 7-state `changeOwnershipStatus`). Both
 * come from the foundation so all 3 tabs agree on which systems
 * have changed ownership and how many are reporting.
 */
export function buildChangeOwnershipWithFoundationOverlay(
  foundation: FoundationArtifactPayload,
  rawSnapshotSystems: readonly unknown[],
  abpReportRows: CsvRow[]
): ChangeOwnershipAggregate {
  const part2VerifiedAbpRows = abpReportRows.filter((row) =>
    isPart2VerifiedAbpRow(row)
  );
  const baseSystems = extractSnapshotSystemsForChangeOwnership(
    rawSnapshotSystems
  );

  const overlayMap = buildFoundationOverlayMap(
    foundation.canonicalSystemsByCsgId
  );
  const cooOverlayMap = new Map<string, ChangeOwnershipFoundationOverlay>();
  for (const [csgId, sys] of Object.entries(
    foundation.canonicalSystemsByCsgId
  )) {
    cooOverlayMap.set(csgId, foundationChangeOwnershipOverlay(sys));
  }

  const systems = baseSystems.map((sys) => {
    if (!sys.systemId) return sys;
    const baseOverlay = overlayMap.get(sys.systemId);
    const cooOverlay = cooOverlayMap.get(sys.systemId);
    if (!baseOverlay || !cooOverlay) return sys;
    return { ...sys, ...baseOverlay, ...cooOverlay };
  });

  return buildChangeOwnership({ part2VerifiedAbpRows, systems });
}

export async function getOrBuildChangeOwnership(
  scopeId: string
): Promise<{ result: ChangeOwnershipAggregate; fromCache: boolean }> {
  const { payload: foundation, inputVersionHash: foundationHash } =
    await getOrBuildFoundation(scopeId);

  const { hash, abpReportBatchId } = await computeChangeOwnershipInputHash(
    scopeId,
    foundationHash
  );

  if (!abpReportBatchId) {
    return { result: EMPTY_CHANGE_OWNERSHIP, fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<ChangeOwnershipAggregate>(
    {
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: superjsonSerde<ChangeOwnershipAggregate>(),
      rowCount: (agg) => agg.rows.length,
      recompute: async () => {
        const [snapshot, abpReportRows] = await Promise.all([
          getOrBuildSystemSnapshot(scopeId),
          loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
        ]);
        return buildChangeOwnershipWithFoundationOverlay(
          foundation,
          snapshot.systems,
          abpReportRows
        );
      },
    }
  );

  return { result, fromCache };
}

// Re-export for tests + future callers that want to derive the COO
// overlay independently (e.g. server-side scripts, integration
// fixtures).
export { foundationChangeOwnershipOverlay };
