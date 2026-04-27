/**
 * Server-side per-(contract, deliveryStartDate) aggregator. Shared
 * by `ContractsTab` and `AnnualReviewTab`.
 *
 * Task 5.13 PR-3 (2026-04-27) — moves
 *   - `client/src/solar-rec-dashboard/components/ContractsTab.tsx :: contractDeliveryRows`
 *   - `client/src/solar-rec-dashboard/components/AnnualReviewTab.tsx :: annualContractVintageRows`
 * onto the server. Both tabs were duplicating the same row-bucketing
 * pass over `deliveryScheduleBase.rows`. Output shape is the union of
 * what both tabs need (the previously-divergent fields:
 * `pricedProjectCount` for ContractsTab, `reportingProjectCount` +
 * `reportingProjectPercent` for AnnualReviewTab) so a single query
 * serves both tabs unchanged at the field level.
 *
 * Task 5.13 cleanup (2026-04-27) — pure parsing helpers + the
 * cache-state-machine moved to `aggregatorHelpers.ts` +
 * `withArtifactCache.ts`; the unsafe `as readonly SnapshotSystem[]`
 * cast on the snapshot return value is now a runtime-validating
 * `extractSnapshotSystems` call.
 *
 * The aggregator depends on three pieces of derived state that the
 * parent component used to compute and pass as props:
 *   - `eligibleTrackingIds` — Part-2-verified systems in the
 *     `solarApplications` ∪ `abpReport` cross-reference. Server
 *     replicates this filter from `abpReport` rows + the system
 *     snapshot (the same logic the parent runs in
 *     `part2EligibleSystemsForSizeReporting`).
 *   - `recPriceByTrackingId` / `isReportingByTrackingId` — per-tracking
 *     system attributes pulled from the same Part-2-eligible subset of
 *     the system snapshot.
 *   - `transferDeliveryLookup` — already cached server-side via
 *     `buildTransferDeliveryLookupForScope`.
 *
 * Cache is keyed by SHA-256 of (abpReport batch, snapshot hash,
 * deliveryScheduleBase batch, transferHistory batch). Recompute is
 * sub-second on prod-scale inputs.
 *
 * Divergence detector: the unit tests in this file's sibling
 * `.test.ts`. Note there is no matched client-side test for the
 * original `contractDeliveryRows` / `annualContractVintageRows`
 * useMemos — those bodies were never independently tested. The
 * server suite is the only test for the shared logic.
 */

import { createHash } from "node:crypto";
import { toDateKey } from "../../../shared/dateKey";
import {
  srDsAbpReport,
  srDsDeliverySchedule,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  type SnapshotSystem,
  clean,
  extractSnapshotSystems,
  getDeliveredForYear,
  isPart2VerifiedAbpRow,
  parseDate,
  parseNumber,
  toPercentValue,
} from "./aggregatorHelpers";
import {
  computeSystemSnapshotHash,
  getOrBuildSystemSnapshot,
  loadDatasetRows,
} from "./buildSystemSnapshot";
import {
  buildTransferDeliveryLookupForScope,
  type TransferDeliveryLookupPayload,
} from "./buildTransferDeliveryLookup";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Output type — superset of what either tab consumes. Both tabs receive
// the same array (sort orders + downstream roll-ups stay client-side).
// ---------------------------------------------------------------------------

export type ContractVintageAggregate = {
  contractId: string;
  /** Parsed delivery start date (year1_start_date). */
  deliveryStartDate: Date | null;
  /** Original raw string (for grouping by raw date when parse fails). */
  deliveryStartRaw: string;
  required: number;
  delivered: number;
  gap: number;
  deliveredPercent: number | null;
  requiredValue: number;
  deliveredValue: number;
  valueGap: number;
  valueDeliveredPercent: number | null;
  /** Unique tracking IDs in this group. */
  projectCount: number;
  /** Tracking IDs in this group with a known REC price (ContractsTab). */
  pricedProjectCount: number;
  /** Tracking IDs in this group whose system has `isReporting=true` (AnnualReviewTab). */
  reportingProjectCount: number;
  reportingProjectPercent: number | null;
};

// ---------------------------------------------------------------------------
// Pure aggregator — operates on already-derived inputs. Both tabs will
// consume the same return value; per-tab sort + downstream roll-ups stay
// client-side.
// ---------------------------------------------------------------------------

export function buildContractVintageAggregates(input: {
  scheduleRows: CsvRow[];
  eligibleTrackingIds: ReadonlySet<string>;
  recPriceByTrackingId: ReadonlyMap<string, number>;
  isReportingByTrackingId: ReadonlySet<string>;
  transferDeliveryLookup: TransferDeliveryLookupPayload;
}): ContractVintageAggregate[] {
  const {
    scheduleRows,
    eligibleTrackingIds,
    recPriceByTrackingId,
    isReportingByTrackingId,
    transferDeliveryLookup,
  } = input;

  const groups = new Map<
    string,
    {
      contractId: string;
      deliveryStartDate: Date | null;
      deliveryStartRaw: string;
      required: number;
      delivered: number;
      requiredValue: number;
      deliveredValue: number;
      trackingIds: Set<string>;
      pricedTrackingIds: Set<string>;
      reportingTrackingIds: Set<string>;
    }
  >();

  for (const row of scheduleRows) {
    const trackingId = clean(row.tracking_system_ref_id);
    if (!trackingId || !eligibleTrackingIds.has(trackingId)) continue;

    const contractId = clean(row.utility_contract_number) || "Unassigned";
    const deliveryStartRaw = clean(row.year1_start_date);
    if (!deliveryStartRaw) continue;

    const deliveryStartDate = parseDate(deliveryStartRaw);
    const required = parseNumber(row.year1_quantity_required) ?? 0;
    const delivered = deliveryStartDate
      ? getDeliveredForYear(
          transferDeliveryLookup,
          trackingId,
          deliveryStartDate.getFullYear()
        )
      : 0;
    const recPrice = recPriceByTrackingId.get(trackingId) ?? null;

    const dateKey = deliveryStartDate
      ? toDateKey(deliveryStartDate)
      : deliveryStartRaw;
    const key = `${contractId}__${dateKey}`;

    let current = groups.get(key);
    if (!current) {
      current = {
        contractId,
        deliveryStartDate,
        deliveryStartRaw,
        required: 0,
        delivered: 0,
        requiredValue: 0,
        deliveredValue: 0,
        trackingIds: new Set<string>(),
        pricedTrackingIds: new Set<string>(),
        reportingTrackingIds: new Set<string>(),
      };
      groups.set(key, current);
    }

    current.required += required;
    current.delivered += delivered;
    current.trackingIds.add(trackingId);
    if (recPrice !== null) {
      current.requiredValue += required * recPrice;
      current.deliveredValue += delivered * recPrice;
      current.pricedTrackingIds.add(trackingId);
    }
    if (isReportingByTrackingId.has(trackingId)) {
      current.reportingTrackingIds.add(trackingId);
    }
  }

  return Array.from(groups.values()).map((group) => ({
    contractId: group.contractId,
    deliveryStartDate: group.deliveryStartDate,
    deliveryStartRaw: group.deliveryStartRaw,
    required: group.required,
    delivered: group.delivered,
    gap: group.required - group.delivered,
    deliveredPercent: toPercentValue(group.delivered, group.required),
    requiredValue: group.requiredValue,
    deliveredValue: group.deliveredValue,
    valueGap: group.requiredValue - group.deliveredValue,
    valueDeliveredPercent: toPercentValue(
      group.deliveredValue,
      group.requiredValue
    ),
    projectCount: group.trackingIds.size,
    pricedProjectCount: group.pricedTrackingIds.size,
    reportingProjectCount: group.reportingTrackingIds.size,
    reportingProjectPercent: toPercentValue(
      group.reportingTrackingIds.size,
      group.trackingIds.size
    ),
  }));
  // No sort here — both tabs apply their own sort (one prefers
  // contractId-then-date, the other date-then-contractId).
}

// ---------------------------------------------------------------------------
// Server-side replication of the parent's
// `part2EligibleSystemsForSizeReporting` filter. The IDs used to match
// abpReport → systems mirror the client's three-way OR (portalSystemId
// ∨ applicationId ∨ trackingId). `SnapshotSystem` lives in
// `aggregatorHelpers.ts` (the canonical server-side subset of the
// client `SystemRecord` shape; runtime-validated by
// `extractSnapshotSystems`).
// ---------------------------------------------------------------------------

export function buildPart2EligibilityMaps(
  abpReportRows: CsvRow[],
  systems: readonly SnapshotSystem[]
): {
  eligibleTrackingIds: Set<string>;
  recPriceByTrackingId: Map<string, number>;
  isReportingByTrackingId: Set<string>;
} {
  const eligiblePart2ApplicationIds = new Set<string>();
  const eligiblePart2PortalSystemIds = new Set<string>();
  const eligiblePart2TrackingIds = new Set<string>();

  for (const row of abpReportRows) {
    if (!isPart2VerifiedAbpRow(row)) continue;
    const applicationId = clean(row.Application_ID);
    const portalSystemId = clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
      clean(row.tracking_system_ref_id);
    if (applicationId) eligiblePart2ApplicationIds.add(applicationId);
    if (portalSystemId) eligiblePart2PortalSystemIds.add(portalSystemId);
    if (trackingId) eligiblePart2TrackingIds.add(trackingId);
  }

  const eligibleTrackingIds = new Set<string>();
  const recPriceByTrackingId = new Map<string, number>();
  const isReportingByTrackingId = new Set<string>();

  for (const system of systems) {
    const byPortalSystemId = system.systemId
      ? eligiblePart2PortalSystemIds.has(system.systemId)
      : false;
    const byApplicationId = system.stateApplicationRefId
      ? eligiblePart2ApplicationIds.has(system.stateApplicationRefId)
      : false;
    const byTrackingId = system.trackingSystemRefId
      ? eligiblePart2TrackingIds.has(system.trackingSystemRefId)
      : false;

    if (!(byPortalSystemId || byApplicationId || byTrackingId)) continue;
    if (!system.trackingSystemRefId) continue;

    eligibleTrackingIds.add(system.trackingSystemRefId);
    if (system.recPrice !== null) {
      recPriceByTrackingId.set(system.trackingSystemRefId, system.recPrice);
    }
    if (system.isReporting) {
      isReportingByTrackingId.add(system.trackingSystemRefId);
    }
  }

  return {
    eligibleTrackingIds,
    recPriceByTrackingId,
    isReportingByTrackingId,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const CONTRACT_VINTAGE_DEPS = ["abpReport", "deliveryScheduleBase"] as const;
const ARTIFACT_TYPE = "contractVintage";

export const CONTRACT_VINTAGE_RUNNER_VERSION =
  "data-flow-pr5_13_contractvintage@1";

async function computeContractVintageInputHash(
  scopeId: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  scheduleBatchId: string | null;
  snapshotHash: string;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    CONTRACT_VINTAGE_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;

  // Snapshot hash bundles abpReport+other batch IDs already, but we
  // include it explicitly so any change to any input in the snapshot
  // (which our `recPrice`/`isReporting` reads depend on) bumps the
  // cache.
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  // transferHistory is read indirectly through the cached
  // `buildTransferDeliveryLookupForScope`; that helper's own cache
  // key includes the transferHistory batch, so we don't need to
  // separately include it here. (Cache invalidation propagates: a
  // new transferHistory batch invalidates the lookup, which on next
  // call recomputes; since the lookup payload contributes to the
  // aggregate output, we DO want the aggregate cache to invalidate
  // too — so we hash the lookup's `inputVersionHash` after retrieving
  // it.)

  // Lookup hash (cheap — only reads the active transferHistory
  // batch ID, doesn't fetch the full lookup).
  const transferVersions = await getActiveVersionsForKeys(scopeId, [
    "transferHistory",
  ]);
  const transferBatchId =
    transferVersions.find((v) => v.datasetKey === "transferHistory")
      ?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `schedule:${scheduleBatchId ?? ""}`,
        `transfer:${transferBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, scheduleBatchId, snapshotHash };
}

/**
 * Public entrypoint for the tRPC query. Returns the same per-(contract,
 * deliveryStartDate) detail rows that ContractsTab and AnnualReviewTab
 * used to build locally.
 *
 * Cache miss path:
 *   1. Loads system snapshot (already cached on its own).
 *   2. Loads abpReport rows.
 *   3. Computes Part-2 eligibility maps via
 *      `buildPart2EligibilityMaps(abpReport, snapshot)`.
 *   4. Loads deliveryScheduleBase rows.
 *   5. Loads (cached) transfer-delivery lookup.
 *   6. Runs the pure `buildContractVintageAggregates`.
 *
 * Early bails on missing scheduleBatch OR abpReportBatch — without a
 * Part-2 verified abpReport there are no eligible tracking IDs and
 * the aggregator's filter would produce an empty array anyway, just
 * after wasting a snapshot build + transfer-lookup load.
 *
 * superjson cache serde because `deliveryStartDate: Date | null`
 * needs to round-trip cleanly.
 */
export async function getOrBuildContractVintageAggregates(
  scopeId: string
): Promise<{
  rows: ContractVintageAggregate[];
  fromCache: boolean;
}> {
  const { hash, abpReportBatchId, scheduleBatchId } =
    await computeContractVintageInputHash(scopeId);

  // No delivery-schedule data → nothing to aggregate. Mirror the
  // client's empty-state behavior.
  if (!scheduleBatchId) {
    return { rows: [], fromCache: false };
  }

  // No Part-2 verified rows possible without an active abpReport
  // batch → eligibility filter is empty → result is empty. Skip
  // the snapshot build and the transfer-lookup load entirely.
  if (!abpReportBatchId) {
    return { rows: [], fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<
    ContractVintageAggregate[]
  >({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: superjsonSerde<ContractVintageAggregate[]>(),
    rowCount: (rows) => rows.length,
    recompute: async () => {
      const [snapshot, abpReportRows, scheduleRows, transferLookup] =
        await Promise.all([
          getOrBuildSystemSnapshot(scopeId),
          loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
          loadDatasetRows(scopeId, scheduleBatchId, srDsDeliverySchedule),
          buildTransferDeliveryLookupForScope(scopeId),
        ]);

      // Runtime-validated extraction — `snapshot.systems` is
      // declared `unknown[]` because `SystemRecord` is typed in
      // client-land. `extractSnapshotSystems` validates each row
      // and substitutes `null` / `false` defaults for missing or
      // wrong-typed fields, so a future change to the snapshot
      // payload schema can't silently corrupt the aggregate.
      const systems: SnapshotSystem[] = extractSnapshotSystems(
        snapshot.systems
      );
      const eligibilityMaps = buildPart2EligibilityMaps(
        abpReportRows,
        systems
      );

      return buildContractVintageAggregates({
        scheduleRows,
        eligibleTrackingIds: eligibilityMaps.eligibleTrackingIds,
        recPriceByTrackingId: eligibilityMaps.recPriceByTrackingId,
        isReportingByTrackingId: eligibilityMaps.isReportingByTrackingId,
        transferDeliveryLookup: transferLookup,
      });
    },
  });

  return { rows: result, fromCache };
}
