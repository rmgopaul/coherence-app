/**
 * Shared loader for the four parallel inputs every "REC performance
 * spine" aggregator needs:
 *
 *   1. System snapshot (slow cold-cache — dominates wall-clock cost)
 *   2. `srDsAbpReport` rows (Part-2 eligibility input)
 *   3. `srDsDeliverySchedule` rows (the per-row iteration target)
 *   4. `transferDeliveryLookup` (delivered-RECs lookup)
 *
 * **Why this module exists.** PR #562 (B2 progress instrumentation,
 * ContractVintage canonical) and PR #566 (same pattern, applied to
 * `getOrBuildPerformanceSourceRows`) both grew the same ~80 LOC
 * block — same `STAGE_1_BASE/CAP` thresholds, same `STEP_WEIGHTS`
 * (snapshot 0.6 / schedule 0.05 / abpReport 0.07 / transfer 0.03),
 * same four `.then(value => { tickStage1(label, weight); return
 * value; })` lambdas, same `Promise.all` shape. PR #562 promised
 * follow-ups for 9 more aggregators; each would copy this block
 * again. The code-review pass on today's 10-PR series flagged
 * extraction-before-aggregator-3 as the right time to lift it.
 *
 * Calling shape:
 *
 *     const { snapshot, abpReportRows, scheduleRows, transferLookup } =
 *       await loadCommonAggregatorInputs(
 *         scopeId,
 *         abpReportBatchId,
 *         scheduleBatchId,
 *         progress
 *       );
 *
 * The caller already opened a `startAggregatorProgress` reporter
 * before entering `withArtifactCache.recompute`; this helper drives
 * progress ticks for stage 1 only (loading), leaving stages 2 + 3
 * (eligibility map, aggregate build, persist) to the caller.
 *
 * Progress contract:
 *   - On entry: emits "Loading inputs" at 5% (`STAGE_1_BASE`).
 *   - As each input resolves: ticks to the per-step weight (snapshot
 *     +60%, abpReport +7%, schedule +5%, transfer +3%).
 *   - Caps at 80% (`STAGE_1_CAP`) — the caller's stage 2/3 reports
 *     pick up from there.
 *   - The ticks are advisory; the caller's stage-2 entry report
 *     (typically "Building Part-2 eligibility map" at 80%) re-anchors
 *     the absolute percent.
 */

import { srDsAbpReport, srDsDeliverySchedule } from "../../../drizzle/schemas/solar";
import {
  loadDatasetRows,
  getOrBuildSystemSnapshot,
} from "./buildSystemSnapshot";
import {
  buildTransferDeliveryLookupForScope,
  type TransferDeliveryLookupPayload,
} from "./buildTransferDeliveryLookup";
import type { AggregatorProgressReporter } from "./dashboardAggregatorProgress";
import type { CsvRow } from "./aggregatorHelpers";

/** First progress percent emitted before any input has resolved. */
export const AGGREGATOR_STAGE_1_BASE = 0.05;
/** Maximum progress percent stage 1 can reach. Caller picks up at this point. */
export const AGGREGATOR_STAGE_1_CAP = 0.8;

/**
 * Per-input wall-clock share on a cold cache. Empirical: the system
 * snapshot build dominates (~80% of stage-1 time when the snapshot's
 * own cache is also cold; the other three reads are fast indexed
 * `srDs*` scans). Weights sum to 0.75 = `CAP - BASE`.
 *
 * If a future profile shows the snapshot dominance is significantly
 * different, retune here — the per-aggregator call sites no longer
 * carry their own copies.
 */
export const AGGREGATOR_STEP_WEIGHTS = {
  snapshot: 0.6,
  schedule: 0.05,
  abpReport: 0.07,
  transfer: 0.03,
} as const;

export interface LoadCommonAggregatorInputsResult {
  /** System snapshot — caller passes `.systems` through `extractSnapshotSystems`. */
  snapshot: Awaited<ReturnType<typeof getOrBuildSystemSnapshot>>;
  /** Raw `srDsAbpReport` rows for the active batch. */
  abpReportRows: CsvRow[];
  /** Raw `srDsDeliverySchedule` rows for the active batch. */
  scheduleRows: CsvRow[];
  /** Cached transfer-delivery lookup (by lowercased tracking id). */
  transferLookup: TransferDeliveryLookupPayload;
}

/**
 * Load the four parallel inputs every spine aggregator needs, with
 * progress ticks emitted to `progress` as each input resolves.
 *
 * Callers don't need to await each promise individually or thread
 * the `.then(value => { tick(); return value; })` boilerplate —
 * that's all in here. The result is the same four-value
 * destructure shape both ContractVintage and PerformanceSourceRows
 * were writing inline.
 */
export async function loadCommonAggregatorInputs(
  scopeId: string,
  abpReportBatchId: string,
  scheduleBatchId: string,
  progress: AggregatorProgressReporter
): Promise<LoadCommonAggregatorInputsResult> {
  let stage1Fraction = AGGREGATOR_STAGE_1_BASE;
  const tickStage1 = (label: string, delta: number): void => {
    stage1Fraction = Math.min(
      stage1Fraction + delta,
      AGGREGATOR_STAGE_1_CAP
    );
    progress.report({
      stage: "loading",
      stageLabel: label,
      fractionComplete: stage1Fraction,
    });
  };

  progress.report({
    stage: "loading",
    stageLabel: "Loading inputs",
    fractionComplete: AGGREGATOR_STAGE_1_BASE,
  });

  const snapshotPromise = getOrBuildSystemSnapshot(scopeId).then((value) => {
    tickStage1("Loaded system snapshot", AGGREGATOR_STEP_WEIGHTS.snapshot);
    return value;
  });
  const abpReportPromise = loadDatasetRows(
    scopeId,
    abpReportBatchId,
    srDsAbpReport
  ).then((value) => {
    tickStage1("Loaded abpReport", AGGREGATOR_STEP_WEIGHTS.abpReport);
    return value;
  });
  const schedulePromise = loadDatasetRows(
    scopeId,
    scheduleBatchId,
    srDsDeliverySchedule
  ).then((value) => {
    tickStage1("Loaded deliverySchedule", AGGREGATOR_STEP_WEIGHTS.schedule);
    return value;
  });
  const transferPromise = buildTransferDeliveryLookupForScope(scopeId).then(
    (value) => {
      tickStage1("Loaded transferHistory", AGGREGATOR_STEP_WEIGHTS.transfer);
      return value;
    }
  );

  const [snapshot, abpReportRows, scheduleRows, transferLookup] =
    await Promise.all([
      snapshotPromise,
      abpReportPromise,
      schedulePromise,
      transferPromise,
    ]);

  return { snapshot, abpReportRows, scheduleRows, transferLookup };
}
