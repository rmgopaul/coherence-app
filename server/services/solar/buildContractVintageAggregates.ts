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
import { computeSystemSnapshotHash } from "./buildSystemSnapshot";
import type { TransferDeliveryLookupPayload } from "./buildTransferDeliveryLookup";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";
import { startAggregatorProgress } from "./dashboardAggregatorProgress";
import {
  loadCommonAggregatorInputs,
  AGGREGATOR_STAGE_1_CAP,
} from "./aggregatorInputs";
import { shouldCacheAggregatorEmptyResult } from "./aggregatorCachePredicates";

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

// 2026-05-13 (@3): bump after adding shouldCache gate (HIGH-2
// follow-up). The sibling `shouldCachePerformanceSourceRowsResult`
// (PR #567) + `shouldCacheForecastResult` (PR #568) refuse to cache
// empty results when the schedule input is non-empty; this aggregator
// carried the SAME poison vector (transient `eligibleTrackingIdCount=0`
// recompute under heap pressure → empty cache → every subsequent
// call serves the poisoned payload forever). Bumping forces every
// scope's existing cache entry under @2 to miss → fresh recompute
// runs → new `shouldCache:` predicate gates the write. This bump
// also requires `runner:${RUNNER_VERSION}` to be included in the
// cache hash; the previous version was NOT in the hash, so a future
// bump would have been a no-op. That defect is fixed inline below.
// 2026-04-29 (@2): bumped after `getDeliveredForYear`
// case-sensitivity fix in aggregatorHelpers. Existing cache
// entries silently returned 0 deliveries on every match in
// production (lookup keys are lowercase, callers passed raw
// mixed-case `tracking_system_ref_id`). Cache invalidation
// forces a recompute against the corrected helper.
export const CONTRACT_VINTAGE_RUNNER_VERSION =
  "data-flow-pr5_13_contractvintage@3";

/**
 * 2026-05-13 — thin alias for the shared
 * `shouldCacheAggregatorEmptyResult` predicate. The
 * `contractVintage` aggregator carries the same
 * `(scheduleRowsTotal, eligibleTrackingIdCount, rowsEmitted)`
 * shape as forecast / performance-source-rows; this re-export
 * keeps the call-site naming consistent with the sibling builders
 * and gives unit tests a stable handle. See
 * `aggregatorCachePredicates.ts` for the incident history.
 */
export const shouldCacheContractVintageResult =
  shouldCacheAggregatorEmptyResult;

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
        // 2026-05-13 — runner version was previously NOT included in
        // the cache hash. Bumping the constant did nothing. Adding
        // it now makes future cache-invalidation bumps actually
        // invalidate. The HIGH-2 follow-up bump from @2 → @3 is what
        // first surfaced this defect.
        `runner:${CONTRACT_VINTAGE_RUNNER_VERSION}`,
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

  // 2026-05-12 — emit real-time progress to the in-memory
  // `dashboardAggregatorProgress` channel so the ContractsTab /
  // AnnualReviewTab can render a determinate progress bar while
  // a cold-cache recompute runs (5–15s on prod-scale inputs).
  // The reporter is a no-op when the entry isn't being polled by
  // any client.
  //
  // Per-input weights for the 4 parallel reads in Stage 1 are
  // tuned to actual cold-cache timing share: snapshot dominates
  // (~80% of cold-cache wall-clock when the system snapshot's
  // own cache is also cold), the three smaller reads are
  // negligible-but-non-zero so the bar visibly ticks as they
  // resolve. The first revision of this PR had a single
  // 5% → 70% jump after Promise.all completed; the bar appeared
  // stuck at 5% for ~60% of the total wait because every input's
  // completion was hidden inside Promise.all. Now each `.then()`
  // ticks the bar as that input lands.
  const progress = startAggregatorProgress(
    scopeId,
    "contractVintage",
    "Preparing"
  );
  // 2026-05-13 — populated in-flight by the recompute closure so the
  // `shouldCache:` predicate can refuse to poison the cache with a
  // 0-row result when the inputs that drove it were non-empty. Same
  // shape as the forecast + performance-source-rows builders. See
  // `aggregatorCachePredicates.ts` for the incident history.
  let scheduleRowsTotal = 0;
  let eligibleTrackingIdCount = 0;
  try {
    const { result, fromCache } = await withArtifactCache<
      ContractVintageAggregate[]
    >({
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: superjsonSerde<ContractVintageAggregate[]>(),
      rowCount: (rows) => rows.length,
      // 2026-05-13 — refuse to poison the cache with a 0-row result
      // when the schedule input was non-empty. Without this gate, a
      // recompute that hit mid-flight heap pressure or a degraded
      // snapshot (returning 0 systems → empty eligibility map →
      // empty filter output) would write `[]` and every subsequent
      // call would serve it from cache forever. See PR #567 (perf-
      // source-rows) + PR #568 (forecast) for the incident pattern.
      shouldCache: (rows) =>
        shouldCacheAggregatorEmptyResult({
          rowsEmitted: rows.length,
          scheduleRowsTotal,
          eligibleTrackingIdCount,
        }),
      recompute: async () => {
        // Stage 1 (5 → 80%): four parallel I/O reads, ticking
        // progress as each resolves. See
        // `aggregatorInputs.ts :: loadCommonAggregatorInputs` for
        // the shared loader contract + the per-input weight tuning.
        const { snapshot, abpReportRows, scheduleRows, transferLookup } =
          await loadCommonAggregatorInputs(
            scopeId,
            abpReportBatchId,
            scheduleBatchId,
            progress
          );
        scheduleRowsTotal = scheduleRows.length;

        // Stage 2 (80 → 90%): eligibility filter.
        progress.report({
          stage: "computing",
          stageLabel: "Building Part-2 eligibility map",
          fractionComplete: AGGREGATOR_STAGE_1_CAP,
        });
        const systems: SnapshotSystem[] = extractSnapshotSystems(
          snapshot.systems
        );
        const eligibilityMaps = buildPart2EligibilityMaps(
          abpReportRows,
          systems
        );
        eligibleTrackingIdCount = eligibilityMaps.eligibleTrackingIds.size;
        progress.report({
          stage: "computing",
          stageLabel: "Eligibility map ready",
          fractionComplete: 0.9,
          current: eligibilityMaps.eligibleTrackingIds.size,
          total: systems.length,
          unitLabel: "Part-2-eligible systems",
        });

        // Stage 3 (90 → 95%): aggregate build. Cap at 95% from
        // inside `recompute` — the outer `finish()` snaps to 100%
        // after `withArtifactCache` actually persists the cache.
        progress.report({
          stage: "computing",
          stageLabel: "Aggregating contract vintage rows",
          fractionComplete: 0.92,
          current: scheduleRows.length,
          total: scheduleRows.length,
          unitLabel: "deliverySchedule rows",
        });
        const rows = buildContractVintageAggregates({
          scheduleRows,
          eligibleTrackingIds: eligibilityMaps.eligibleTrackingIds,
          recPriceByTrackingId: eligibilityMaps.recPriceByTrackingId,
          isReportingByTrackingId: eligibilityMaps.isReportingByTrackingId,
          transferDeliveryLookup: transferLookup,
        });
        progress.report({
          stage: "writing",
          stageLabel: "Persisting cache",
          fractionComplete: 0.95,
          current: rows.length,
          total: rows.length,
          unitLabel: "aggregate rows",
        });
        return rows;
      },
    });
    progress.finish();
    return { rows: result, fromCache };
  } catch (err) {
    progress.fail(err);
    throw err;
  }
}
