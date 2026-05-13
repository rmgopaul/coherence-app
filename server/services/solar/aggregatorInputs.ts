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

  // Once any load rejects, suppress further progress ticks. The
  // ticks themselves are idempotent against the stage-1 cap, but
  // emitting "Loaded deliverySchedule" *after* we've already
  // decided to throw is noise on the progress channel that the
  // client UI will then have to debounce.
  let firstRejection: unknown = undefined;
  const tickIfStillRunning = (label: string, weight: number): void => {
    if (firstRejection !== undefined) return;
    tickStage1(label, weight);
  };
  const captureRejection = (err: unknown): void => {
    if (firstRejection === undefined) firstRejection = err;
  };

  const snapshotPromise = getOrBuildSystemSnapshot(scopeId).then(
    (value) => {
      tickIfStillRunning(
        "Loaded system snapshot",
        AGGREGATOR_STEP_WEIGHTS.snapshot
      );
      return value;
    },
    (err) => {
      captureRejection(err);
      throw err;
    }
  );
  const abpReportPromise = loadDatasetRows(
    scopeId,
    abpReportBatchId,
    srDsAbpReport
  ).then(
    (value) => {
      tickIfStillRunning("Loaded abpReport", AGGREGATOR_STEP_WEIGHTS.abpReport);
      return value;
    },
    (err) => {
      captureRejection(err);
      throw err;
    }
  );
  const schedulePromise = loadDatasetRows(
    scopeId,
    scheduleBatchId,
    srDsDeliverySchedule
  ).then(
    (value) => {
      tickIfStillRunning(
        "Loaded deliverySchedule",
        AGGREGATOR_STEP_WEIGHTS.schedule
      );
      return value;
    },
    (err) => {
      captureRejection(err);
      throw err;
    }
  );
  const transferPromise = buildTransferDeliveryLookupForScope(scopeId).then(
    (value) => {
      tickIfStillRunning(
        "Loaded transferHistory",
        AGGREGATOR_STEP_WEIGHTS.transfer
      );
      return value;
    },
    (err) => {
      captureRejection(err);
      throw err;
    }
  );

  // We wait for all 4 loads to settle before throwing on a rejection.
  //
  // Rationale: each load is an in-flight async operation (some heavy
  // — `getOrBuildSystemSnapshot` is the largest at ~26 MB on prod;
  // the others read indexed `srDs*` scans). If we used `Promise.all`
  // and let it reject the moment one load fails, the 3 sibling
  // promises would orphan: they keep executing in the background,
  // pinning their intermediate JS heap until they settle, while the
  // caller already considers `aggregatorInputs` dead and is free to
  // re-enter or shed load. The progress reporter is safely guarded
  // by the per-tick `firstRejection` check above (no orphan ticks),
  // but the underlying heap pressure stays until the orphan loaders
  // finish. Waiting for `allSettled` keeps the caller's lifecycle
  // and the loaders' lifecycles aligned: by the time the function
  // throws, every sibling has released its working memory.
  //
  // Tradeoff: this does NOT short-circuit the wasted work — the
  // siblings still run to completion. The downstream loaders
  // (`getOrBuildSystemSnapshot`, `loadDatasetRows`,
  // `buildTransferDeliveryLookupForScope`) do not currently accept
  // an `AbortSignal`. A future hardening pass that adds cooperative
  // cancellation to those loaders would let this function abort the
  // siblings on first rejection; until then the `allSettled` wait
  // is the correctness-preserving minimum.
  const settled = await Promise.allSettled([
    snapshotPromise,
    abpReportPromise,
    schedulePromise,
    transferPromise,
  ]);

  if (firstRejection !== undefined) {
    throw firstRejection;
  }

  // All four resolved — destructure their values. The narrowing
  // here is safe: the `firstRejection === undefined` check above
  // guarantees no `rejected` entries in `settled`.
  const [snapshotSettled, abpReportSettled, scheduleSettled, transferSettled] =
    settled;
  if (
    snapshotSettled.status !== "fulfilled" ||
    abpReportSettled.status !== "fulfilled" ||
    scheduleSettled.status !== "fulfilled" ||
    transferSettled.status !== "fulfilled"
  ) {
    // Defensive: should be unreachable given the firstRejection check,
    // but the type system can't see that, and we'd rather throw a
    // legible error than fall through to a destructure-of-undefined.
    throw new Error(
      "loadCommonAggregatorInputs: internal invariant violated — Promise.allSettled returned a rejected entry with no captured firstRejection"
    );
  }

  return {
    snapshot: snapshotSettled.value,
    abpReportRows: abpReportSettled.value,
    scheduleRows: scheduleSettled.value,
    transferLookup: transferSettled.value,
  };
}
