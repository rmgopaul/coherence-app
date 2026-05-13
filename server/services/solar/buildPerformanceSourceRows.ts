/**
 * Server-side `performanceSourceRows` aggregator. Mirrors the
 * client's parent useMemo at
 * `client/src/features/solar-rec/SolarRecDashboard.tsx :: performance
 * SourceRows` byte-for-byte (the matching logic was originally
 * extracted into `buildForecastAggregates.ts` as a private helper —
 * this file lifts it to a top-level export so a dedicated tRPC proc
 * can serve it to RecPerformanceEvaluationTab + Snapshot Log +
 * createLogEntry without those callers having to depend on the
 * Forecast aggregator's internals).
 *
 * 2026-04-29 — Phase 5d Salvage C (#273) noted this migration as
 * future work: once `performanceSourceRows` lives server-side, the
 * client `onApply` write in ScheduleBImport's auto-apply hybrid can
 * collapse to server-only and `existingDeliverySchedule` can come
 * from a new `getDashboardDeliverySchedule` query. This file is the
 * server side of that handoff; the client wiring + ScheduleBImport
 * follow-up are separate PRs.
 *
 * Output shape (`PerformanceSourceRow`) lives in
 * `@shared/solarRecPerformanceRatio` and matches the wire shape the
 * client tabs already consume. `years[i].delivered` is the
 * transfer-history-sourced value (NOT the Schedule B's
 * `quantity_delivered` column) — `transferHistory` is always the
 * source of truth for delivered RECs.
 *
 * Cache key bundles:
 *   - abpReport batch ID (drives Part-2 eligibility)
 *   - deliveryScheduleBase batch ID
 *   - transferHistory batch ID
 *   - system snapshot hash
 * Recompute cost is sub-second on prod-scale inputs.
 */

import { createHash } from "node:crypto";
import {
  srDsAbpReport,
  srDsDeliverySchedule,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  buildScheduleYearEntries,
  clean,
  type PerformanceSourceRow,
  type SolarRecCsvRow,
} from "@shared/solarRecPerformanceRatio";
import {
  type CsvRow,
  type SnapshotSystem,
  extractSnapshotSystems,
  getDeliveredForYear,
} from "./aggregatorHelpers";
import {
  buildPart2EligibilityMaps,
} from "./buildContractVintageAggregates";
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
import { startAggregatorProgress } from "./dashboardAggregatorProgress";
import { shouldCacheAggregatorEmptyResult } from "./aggregatorCachePredicates";

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the parent useMemo. Extracted
// here so RecPerformanceEvaluationTab + Snapshot Log + createLogEntry
// can share with the Forecast aggregator. ForecastTab still calls
// this same function internally for its own pre-pass.
// ---------------------------------------------------------------------------

export interface BuildPerformanceSourceRowsInput {
  scheduleRows: CsvRow[];
  eligibleTrackingIds: ReadonlySet<string>;
  /**
   * Map<trackingSystemRefId, SnapshotSystem> — caller is responsible
   * for picking the canonical system per trackingId. The aggregator
   * reads `systemId`, `systemName`, and `recPrice` from each system.
   */
  systemsByTrackingId: ReadonlyMap<string, SnapshotSystem>;
  transferDeliveryLookup: TransferDeliveryLookupPayload;
}

export function buildPerformanceSourceRows(
  input: BuildPerformanceSourceRowsInput
): PerformanceSourceRow[] {
  const {
    scheduleRows,
    eligibleTrackingIds,
    systemsByTrackingId,
    transferDeliveryLookup,
  } = input;

  const out: PerformanceSourceRow[] = [];
  for (let rowIndex = 0; rowIndex < scheduleRows.length; rowIndex += 1) {
    const row = scheduleRows[rowIndex]!;
    const trackingSystemRefId = clean(row.tracking_system_ref_id);
    if (
      !trackingSystemRefId ||
      !eligibleTrackingIds.has(trackingSystemRefId)
    ) {
      continue;
    }
    const system = systemsByTrackingId.get(trackingSystemRefId);
    const years = buildScheduleYearEntries(row as SolarRecCsvRow);
    if (years.length === 0) continue;

    // `getDeliveredForYear` is case-insensitive on trackingId
    // (lowercases internally) since the case-fix in
    // aggregatorHelpers; we still need to lowercase for the
    // direct `byTrackingId[...]` access below because the
    // firstTransferEnergyYear scan iterates the per-system year
    // map directly rather than going through the helper. The
    // server payload uses lowercase keys (see
    // `buildTransferDeliveryLookup.ts:242`).
    const systemTransfersRecord =
      transferDeliveryLookup.byTrackingId[
        trackingSystemRefId.toLowerCase()
      ] ?? null;

    let firstTransferEnergyYear: number | null = null as number | null;
    if (systemTransfersRecord) {
      for (const [yearStr, qty] of Object.entries(systemTransfersRecord)) {
        const ey = Number(yearStr);
        if (!Number.isFinite(ey)) continue;
        if (
          qty > 0 &&
          (firstTransferEnergyYear === null || ey < firstTransferEnergyYear)
        ) {
          firstTransferEnergyYear = ey;
        }
      }
    }

    for (const year of years) {
      if (!year.startDate) {
        year.delivered = 0;
        continue;
      }
      const eyStartYear = year.startDate.getFullYear();
      year.delivered = getDeliveredForYear(
        transferDeliveryLookup,
        trackingSystemRefId,
        eyStartYear
      );
    }

    out.push({
      key: `${trackingSystemRefId}-${rowIndex}`,
      contractId: clean(row.utility_contract_number) || "Unassigned",
      systemId: system?.systemId ?? null,
      trackingSystemRefId,
      systemName:
        clean(row.system_name) ||
        system?.systemName ||
        trackingSystemRefId,
      batchId:
        clean(row.batch_id) ||
        clean(row.state_certification_number) ||
        null,
      recPrice: system?.recPrice ?? null,
      years,
      firstTransferEnergyYear,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cached server entrypoint. Returns the same `PerformanceSourceRow[]`
// the client memo used to build, plus a fromCache flag for telemetry.
//
// superjson cache serde because `ScheduleYearEntry.{startDate,
// endDate}` are `Date | null`. JSON would silently coerce them to
// strings on cache hit and the client's `firstTransferEnergyYear`
// derivation (which calls `.getFullYear()`) would crash.
// ---------------------------------------------------------------------------

const PERFORMANCE_SOURCE_DEPS = ["abpReport", "deliveryScheduleBase"] as const;
const ARTIFACT_TYPE = "performanceSourceRows";

export const PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION =
  // 2026-04-29 (@2): bumped alongside the
  // `getDeliveredForYear` case-fix. The aggregator's behavior
  // doesn't change (it was already lowercasing for the lookup),
  // but its inputs go through the corrected helper now and the
  // cache key bundles the runner version, so we bump for
  // consistency with the sibling aggregators.
  //
  // 2026-05-12 (@3): force-invalidate poisoned cache entries.
  // Prod (2026-05-13) observed `getDashboardPerformanceSourceRows`
  // returning `fromCache: true` with an all-zero diagnostic
  // even though deliveryScheduleBase / abpReport / etc. were all
  // populated with non-empty active batches. Some earlier
  // recompute (likely during one of the v1 → v2 migration
  // auto-heal cycles) cached `rows: []` for the current input
  // hash, and `shouldCachePerformanceSourceRowsResult`'s
  // permissive `eligibleTrackingIdCount === 0 → allow caching`
  // branch let it land. Subsequent calls served the poisoned
  // empty payload forever, breaking REC Performance Eval +
  // Snapshot Log + createLogEntry on this scope. Bumping the
  // version changes the cache key for every scope → next call
  // misses → fresh recompute runs → predicate (tightened below)
  // refuses to cache an empty result whenever schedule rows
  // exist. Same operational pattern as PR #557's forecast bump.
  "phase-5e-pr8-performancesourcerows@3";

async function computePerformanceSourceRowsInputHash(
  scopeId: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  scheduleBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    PERFORMANCE_SOURCE_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;

  // Snapshot hash bundles every input the snapshot reads (which
  // includes our `recPrice`/`systemName` lookups), so any change to
  // any of those upstream inputs invalidates this aggregate.
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  // transferHistory's batch ID feeds the cached
  // `buildTransferDeliveryLookupForScope` separately; we include
  // it here so a transferHistory upload bumps THIS cache too.
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
        `runner:${PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, scheduleBatchId };
}

/**
 * 2026-05-11 — diagnostic counters surfaced by the proc so an
 * operator can answer "why did this aggregate return 0 rows?" without
 * spelunking the recompute path. Pin the shape via an exported
 * interface so the response type stays stable for client consumers.
 *
 * **Cache-hit semantics.** On a warm cache the diagnostic is mostly
 * the zero-default — only `rowsEmitted` is populated (from the
 * cached payload's `rows.length`). Materializing the other counters
 * would require reloading the source datasets and would defeat the
 * cache. Consumers should branch on the proc's `fromCache` flag:
 *   - `fromCache: false` → all counters reflect the cold recompute.
 *   - `fromCache: true` → only `rowsEmitted` is meaningful; the
 *     other fields are zero placeholders.
 */
export interface PerformanceSourceRowsDiagnostic {
  /** Total raw delivery-schedule rows fed into the aggregator. */
  scheduleRowsTotal: number;
  /** Subset whose tracking_system_ref_id is non-empty. */
  scheduleRowsWithTrackingId: number;
  /** Subset whose tracking_system_ref_id is in `eligibleTrackingIds`. */
  scheduleRowsEligible: number;
  /** Size of the `eligibleTrackingIds` set produced by `buildPart2EligibilityMaps`. */
  eligibleTrackingIdCount: number;
  /** Size of the systems-by-tracking-id map (i.e., snapshot systems with a tracking id). */
  systemsByTrackingIdCount: number;
  /**
   * Number of systems in the snapshot — used to detect a degraded
   * snapshot (zero systems despite non-empty solarApplications input)
   * which is the most common "suspicious empty" indicator.
   */
  snapshotSystemCount: number;
  /** Final emitted row count — same as the returned `rows.length`. */
  rowsEmitted: number;
}

/**
 * 2026-05-13 — thin alias for the shared
 * `shouldCacheAggregatorEmptyResult` predicate. The
 * `performanceSourceRows`, `forecast`, and any future aggregator
 * with the same `(scheduleRowsTotal, eligibleTrackingIdCount,
 * rowsEmitted)` shape all share one implementation now — see
 * `aggregatorCachePredicates.ts` for the rationale and incident
 * history (PRs #556 / #557 / #567 / today's fix).
 *
 * Kept as a named export so existing tests + the in-module call
 * site compile unchanged; the name still describes "the
 * performanceSourceRows-shape predicate" at the call site.
 */
export const shouldCachePerformanceSourceRowsResult =
  shouldCacheAggregatorEmptyResult;

export async function getOrBuildPerformanceSourceRows(
  scopeId: string
): Promise<{
  rows: PerformanceSourceRow[];
  fromCache: boolean;
  diagnostic: PerformanceSourceRowsDiagnostic;
}> {
  const { hash, abpReportBatchId, scheduleBatchId } =
    await computePerformanceSourceRowsInputHash(scopeId);

  // No delivery-schedule rows → nothing to aggregate. Mirror the
  // client memo's empty-state behavior. Return a zero-diagnostic so
  // the caller sees the exact reason ("no schedule batch") in the
  // surfaced shape.
  if (!scheduleBatchId) {
    return {
      rows: [],
      fromCache: false,
      diagnostic: {
        scheduleRowsTotal: 0,
        scheduleRowsWithTrackingId: 0,
        scheduleRowsEligible: 0,
        eligibleTrackingIdCount: 0,
        systemsByTrackingIdCount: 0,
        snapshotSystemCount: 0,
        rowsEmitted: 0,
      },
    };
  }

  // No Part-2-verified abpReport → no eligible tracking IDs → empty
  // result. Skip the snapshot build + transfer-lookup load.
  if (!abpReportBatchId) {
    return {
      rows: [],
      fromCache: false,
      diagnostic: {
        scheduleRowsTotal: 0,
        scheduleRowsWithTrackingId: 0,
        scheduleRowsEligible: 0,
        eligibleTrackingIdCount: 0,
        systemsByTrackingIdCount: 0,
        snapshotSystemCount: 0,
        rowsEmitted: 0,
      },
    };
  }

  // 2026-05-11 — the diagnostic counters live in this closure so the
  // recompute can populate them in-flight. The cache miss path
  // surfaces fresh counters; the cache hit path uses zero counters
  // (we don't re-derive them from the cached payload — they're
  // observability for cold-recompute behaviour, not per-call state).
  let diagnostic: PerformanceSourceRowsDiagnostic = {
    scheduleRowsTotal: 0,
    scheduleRowsWithTrackingId: 0,
    scheduleRowsEligible: 0,
    eligibleTrackingIdCount: 0,
    systemsByTrackingIdCount: 0,
    snapshotSystemCount: 0,
    rowsEmitted: 0,
  };

  // 2026-05-12 — B2 progress instrumentation. RecPerformanceEvaluation
  // Tab + Snapshot Log + createLogEntry all gate on this query, and
  // on cold cache the recompute can take 5–15 s (snapshot build is
  // the dominant cost). Mirror the `buildContractVintageAggregates`
  // pattern: emit progress at each stage boundary so the client
  // determinate progress bar advances continuously instead of
  // appearing stuck at 5%.
  const progress = startAggregatorProgress(
    scopeId,
    "performanceSourceRows",
    "Preparing"
  );
  try {
  const { result, fromCache } = await withArtifactCache<PerformanceSourceRow[]>(
    {
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: superjsonSerde<PerformanceSourceRow[]>(),
      rowCount: (rows) => rows.length,
      // 2026-05-11 — see `shouldCachePerformanceSourceRowsResult`
      // docstring. We refuse to poison the cache with a "0 rows
      // despite non-empty inputs" result. Without this gate, a
      // recompute that hit mid-flight heap pressure or a partial
      // snapshot load would write an empty array and every
      // subsequent call would serve it from cache forever (until
      // the user uploads a new abpReport / schedule that bumps the
      // input hash).
      shouldCache: (rows) =>
        shouldCachePerformanceSourceRowsResult({
          rowsEmitted: rows.length,
          scheduleRowsTotal: diagnostic.scheduleRowsTotal,
          eligibleTrackingIdCount: diagnostic.eligibleTrackingIdCount,
        }),
      recompute: async () => {
        // Stage 1 (5 → 80%): four parallel I/O reads. Each input's
        // `.then()` ticks the bar as that promise resolves;
        // weights match cold-cache wall-clock share — snapshot is
        // the slow one (system-snapshot build is its own cache miss).
        const STAGE_1_BASE = 0.05;
        const STAGE_1_CAP = 0.8;
        const STEP_WEIGHTS = {
          snapshot: 0.6,
          schedule: 0.05,
          abpReport: 0.07,
          transfer: 0.03,
        } as const;
        let stage1Fraction = STAGE_1_BASE;
        const tickStage1 = (label: string, delta: number): void => {
          stage1Fraction = Math.min(stage1Fraction + delta, STAGE_1_CAP);
          progress.report({
            stage: "loading",
            stageLabel: label,
            fractionComplete: stage1Fraction,
          });
        };
        progress.report({
          stage: "loading",
          stageLabel: "Loading inputs",
          fractionComplete: STAGE_1_BASE,
        });
        const snapshotPromise = getOrBuildSystemSnapshot(scopeId).then(
          (value) => {
            tickStage1("Loaded system snapshot", STEP_WEIGHTS.snapshot);
            return value;
          }
        );
        const abpReportPromise = loadDatasetRows(
          scopeId,
          abpReportBatchId,
          srDsAbpReport
        ).then((value) => {
          tickStage1("Loaded abpReport", STEP_WEIGHTS.abpReport);
          return value;
        });
        const schedulePromise = loadDatasetRows(
          scopeId,
          scheduleBatchId,
          srDsDeliverySchedule
        ).then((value) => {
          tickStage1("Loaded deliverySchedule", STEP_WEIGHTS.schedule);
          return value;
        });
        const transferPromise = buildTransferDeliveryLookupForScope(
          scopeId
        ).then((value) => {
          tickStage1("Loaded transferHistory", STEP_WEIGHTS.transfer);
          return value;
        });
        const [snapshot, abpReportRows, scheduleRows, transferLookup] =
          await Promise.all([
            snapshotPromise,
            abpReportPromise,
            schedulePromise,
            transferPromise,
          ]);

        // Stage 2 (80 → 88%): eligibility map + per-trackingId index.
        progress.report({
          stage: "computing",
          stageLabel: "Building Part-2 eligibility map",
          fractionComplete: STAGE_1_CAP,
        });
        const systems: SnapshotSystem[] = extractSnapshotSystems(
          snapshot.systems
        );

        // Eligibility filter — Part-2-verified tracking IDs in the
        // `solarApplications ∪ abpReport` cross-reference. Same logic
        // the parent's `part2EligibleSystemsForSizeReporting` uses.
        const { eligibleTrackingIds } = buildPart2EligibilityMaps(
          abpReportRows,
          systems
        );

        // 1:1 trackingId → system map. When duplicates exist (rare),
        // last-write-wins matches the client `Map.set` ordering.
        const systemsByTrackingId = new Map<string, SnapshotSystem>();
        for (const sys of systems) {
          if (!sys.trackingSystemRefId) continue;
          systemsByTrackingId.set(sys.trackingSystemRefId, sys);
        }
        progress.report({
          stage: "computing",
          stageLabel: "Eligibility map ready",
          fractionComplete: 0.88,
          current: eligibleTrackingIds.size,
          total: systems.length,
          unitLabel: "Part-2-eligible systems",
        });

        // Stage 3 (88 → 95%): aggregate build + diagnostic pass.
        progress.report({
          stage: "computing",
          stageLabel: "Aggregating performance source rows",
          fractionComplete: 0.9,
          current: scheduleRows.length,
          total: scheduleRows.length,
          unitLabel: "deliverySchedule rows",
        });
        const rows = buildPerformanceSourceRows({
          scheduleRows,
          eligibleTrackingIds,
          systemsByTrackingId,
          transferDeliveryLookup: transferLookup,
        });

        // 2026-05-11 — populate the diagnostic counters. A second
        // pass over scheduleRows is O(N) on the same array we just
        // iterated; on production-shape data (~25k rows) this adds
        // <50 ms but lets the proc surface "this is why the result
        // is empty" without a follow-up debug roundtrip.
        let scheduleRowsWithTrackingId = 0;
        let scheduleRowsEligible = 0;
        for (const row of scheduleRows) {
          const trackingId = clean(row.tracking_system_ref_id);
          if (!trackingId) continue;
          scheduleRowsWithTrackingId += 1;
          if (eligibleTrackingIds.has(trackingId)) {
            scheduleRowsEligible += 1;
          }
        }
        diagnostic = {
          scheduleRowsTotal: scheduleRows.length,
          scheduleRowsWithTrackingId,
          scheduleRowsEligible,
          eligibleTrackingIdCount: eligibleTrackingIds.size,
          systemsByTrackingIdCount: systemsByTrackingId.size,
          snapshotSystemCount: systems.length,
          rowsEmitted: rows.length,
        };
        progress.report({
          stage: "writing",
          stageLabel: "Persisting cache",
          fractionComplete: 0.95,
          current: rows.length,
          total: rows.length,
          unitLabel: "performance source rows",
        });

        return rows;
      },
    }
  );

  // On cache hit, `diagnostic` is the zero-default declared above;
  // the surfaced shape stays consistent regardless of cold/warm.
  // Override `rowsEmitted` so a warm cache still reports something
  // meaningful.
  if (fromCache) {
    diagnostic = { ...diagnostic, rowsEmitted: result.length };
  }

    progress.finish();
    return { rows: result, fromCache, diagnostic };
  } catch (err) {
    progress.fail(err);
    throw err;
  }
}
