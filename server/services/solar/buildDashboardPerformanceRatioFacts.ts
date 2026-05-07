/**
 * Dashboard performance-ratio fact-table builder
 * (Phase 2 PR-G-2).
 *
 * Plugs into the build runner via `setDashboardBuildSteps`. After
 * this PR every successful build runs the existing fact-table
 * steps (`monitoringDetailsFacts`, `changeOwnershipFacts`,
 * `ownershipFacts`, `systemFacts`) AND the new
 * `performanceRatioFacts` step.
 *
 * Architectural shape mirrors PR-D-2 / PR-E-2 / PR-F-2 1:1:
 *   1. Call `getOrBuildPerformanceRatio(scopeId)` — returns
 *      cached `PerformanceRatioAggregates` (or rebuilds on cache
 *      miss). This is the existing aggregator that the legacy
 *      proc serves on the user's request hot path; PR-G-4 will
 *      retire that path entirely.
 *   2. Reshape `result.rows: PerformanceRatioRow[]` into
 *      `solarRecDashboardPerformanceRatioFacts` row records (one
 *      per matched system × converted-read pair).
 *   3. UPSERT the rows tagged with the current `buildId`, then
 *      delete orphaned rows.
 *   4. Write a slim summary side-cache row to
 *      `solarRecComputedArtifacts` so PR-G-3's slim summary proc
 *      can render the headline tile values
 *      (`convertedReadCount` / `matchedConvertedReads` / …)
 *      without paginating the fact rows. Mirrors how
 *      `getDashboardFinancialKpiSummary` reads its slim KPIs.
 *   5. Log a one-line metric on completion.
 *
 * Reusing the existing aggregator means we don't duplicate the
 * `PerformanceRatioRow[]` derivation logic. The aggregator already
 * runs through `withArtifactCache` so a build that fires shortly
 * after a previous one hits the cache rather than re-scanning
 * srDs* tables + the system snapshot.
 */

import type { DashboardBuildStep } from "./dashboardBuildJobRunner";
import {
  getOrBuildPerformanceRatio,
  PERFORMANCE_RATIO_RUNNER_VERSION,
} from "./buildPerformanceRatioAggregates";
import type { PerformanceRatioRow } from "@shared/solarRecPerformanceRatio";
import {
  upsertPerformanceRatioFacts,
  deleteOrphanedPerformanceRatioFacts,
} from "../../db/dashboardPerformanceRatioFacts";
import type { InsertSolarRecDashboardPerformanceRatioFact } from "../../../drizzle/schema";
import { upsertComputedArtifact } from "../../db/solarRecDatasets";

const STEP_NAME = "performanceRatioFacts";
const METRIC_PREFIX = "[dashboard:fact-build:performanceRatio]";

/**
 * Slim summary side-cache contract. PR-G-3's summary proc reads
 * this row and returns it ~as-is to the client.
 *
 * Keyed by a fixed `inputVersionHash` of `"current"` — successive
 * builds overwrite the same row, the freshest build always wins.
 * The aggregator's own `withArtifactCache` row (under
 * PERFORMANCE_RATIO_RUNNER_VERSION) is unaffected; that one is
 * keyed by the 7-batch-ID input hash and is the row PR-G-5 will
 * eventually retire.
 */
export const PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE =
  "performanceRatioSummary";
export const PERFORMANCE_RATIO_SUMMARY_VERSION_KEY = "current";

export type PerformanceRatioSummaryPayload = {
  convertedReadCount: number;
  matchedConvertedReads: number;
  unmatchedConvertedReads: number;
  invalidConvertedReads: number;
  matchedSystemCount: number;
  buildId: string;
  // Stamps the aggregator runner version that produced these
  // counts so a future schema/aggregator change can be detected
  // by clients reading a stale summary.
  aggregatorVersion: string;
  builtAt: string;
};

/**
 * Pure transformation: PerformanceRatioRow → fact-row insert
 * record.
 *
 * Extracted as a discrete signature so the test fixtures stay
 * focused on the row-shape contract. The runner-step adapter
 * calls the aggregator and narrows to `result.rows`.
 *
 * `buildId` is required because every fact row carries the build
 * that wrote it (the orphan-sweep mechanism in
 * `deleteOrphanedPerformanceRatioFacts` keys on this).
 *
 * **Decimal serialization.** The aggregator emits `number | null`
 * for `lifetimeReadWh` / `baselineReadWh` / `productionDeltaWh` /
 * `expectedProductionWh` / `performanceRatioPercent` /
 * `portalAcSizeKw` / `abpAcSizeKw` / `contractValue`, but
 * Drizzle's MySQL `decimal()` columns map to `string` at the
 * wire level. Convert numerically-finite values via `String(n)`
 * (preserves precision up to JS double's mantissa; the schema
 * columns are `decimal(20, 4)` / `decimal(18, 4)` /
 * `decimal(10, 4)` which are well within representable range).
 *
 * **Date serialization.** `readDate` / `baselineDate` /
 * `part2VerificationDate` arrive as `Date | null`; Drizzle's
 * MySQL `date` column accepts `Date` directly and persists as
 * `YYYY-MM-DD`. We pass through unchanged.
 *
 * **Required-field defensiveness.** `lifetimeReadWh` is non-
 * nullable in the schema; the aggregator always emits a finite
 * number (the row is filtered out earlier as `invalid` if it
 * isn't). Same for `contractValue`. We coerce via the same
 * helper for safety so an unexpected `null` from a future
 * aggregator change becomes a missing row (and a runner error
 * the caller surfaces) rather than a silent zero in the fact
 * table.
 */
export function buildPerformanceRatioFactRows(args: {
  scopeId: string;
  buildId: string;
  rows: readonly PerformanceRatioRow[];
}): InsertSolarRecDashboardPerformanceRatioFact[] {
  const { scopeId, buildId, rows } = args;
  const out: InsertSolarRecDashboardPerformanceRatioFact[] = [];
  for (const row of rows) {
    const lifetimeReadWh = numberToDecimalString(row.lifetimeReadWh);
    const contractValue = numberToDecimalString(row.contractValue);
    if (lifetimeReadWh === null || contractValue === null) continue;
    out.push({
      scopeId,
      key: row.key,
      convertedReadKey: row.convertedReadKey,
      matchType: row.matchType,
      monitoring: row.monitoring,
      monitoringSystemId: row.monitoringSystemId,
      monitoringSystemName: row.monitoringSystemName,
      readDate: row.readDate,
      readDateRaw: row.readDateRaw,
      lifetimeReadWh,
      trackingSystemRefId: row.trackingSystemRefId,
      systemId: row.systemId,
      stateApplicationRefId: row.stateApplicationRefId,
      systemName: row.systemName,
      installerName: row.installerName,
      monitoringPlatform: row.monitoringPlatform,
      portalAcSizeKw: numberToDecimalString(row.portalAcSizeKw),
      abpAcSizeKw: numberToDecimalString(row.abpAcSizeKw),
      part2VerificationDate: row.part2VerificationDate,
      baselineReadWh: numberToDecimalString(row.baselineReadWh),
      baselineDate: row.baselineDate,
      baselineSource: row.baselineSource,
      productionDeltaWh: numberToDecimalString(row.productionDeltaWh),
      expectedProductionWh: numberToDecimalString(row.expectedProductionWh),
      performanceRatioPercent: numberToDecimalString(
        row.performanceRatioPercent
      ),
      contractValue,
      buildId,
    });
  }
  return out;
}

function numberToDecimalString(value: number | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(value);
}

/**
 * Compute the slim summary payload from the aggregator's
 * counters + the reshaped fact rows. Pure function to keep the
 * runner step thin.
 */
export function buildPerformanceRatioSummaryPayload(args: {
  buildId: string;
  builtAt: Date;
  aggregate: {
    convertedReadCount: number;
    matchedConvertedReads: number;
    unmatchedConvertedReads: number;
    invalidConvertedReads: number;
  };
  factRows: readonly InsertSolarRecDashboardPerformanceRatioFact[];
}): PerformanceRatioSummaryPayload {
  const { buildId, builtAt, aggregate, factRows } = args;
  // matchedSystemCount = unique systems represented across the
  // matched rows. The aggregator emits ONE row per match (system
  // × converted-read), so the same system can appear N times.
  const systemKeys = new Set<string>();
  for (const row of factRows) {
    // Row's `key` is `${convertedReadKey}-${systemKey}`. The
    // candidate's stable identifier is the suffix after the
    // first `${convertedReadKey}-`. trackingSystemRefId is also
    // available and equally suitable; using it avoids re-parsing
    // the composite key.
    if (row.trackingSystemRefId) systemKeys.add(row.trackingSystemRefId);
  }
  return {
    convertedReadCount: aggregate.convertedReadCount,
    matchedConvertedReads: aggregate.matchedConvertedReads,
    unmatchedConvertedReads: aggregate.unmatchedConvertedReads,
    invalidConvertedReads: aggregate.invalidConvertedReads,
    matchedSystemCount: systemKeys.size,
    buildId,
    aggregatorVersion: PERFORMANCE_RATIO_RUNNER_VERSION,
    builtAt: builtAt.toISOString(),
  };
}

async function writePerformanceRatioSummary(
  scopeId: string,
  payload: PerformanceRatioSummaryPayload
): Promise<void> {
  await upsertComputedArtifact({
    scopeId,
    artifactType: PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE,
    inputVersionHash: PERFORMANCE_RATIO_SUMMARY_VERSION_KEY,
    payload: JSON.stringify(payload),
    rowCount: payload.matchedSystemCount,
  });
}

/**
 * Runner step. Drives the whole table-refresh in one pass:
 * aggregator → reshape → upsert → orphan-sweep → summary.
 *
 * Step contract (from `DashboardBuildStep`): never throws unless
 * the work genuinely failed. The runner converts thrown errors
 * into the build row's `errorMessage` and stops at the first
 * failing step.
 *
 * **Cold-cache behavior.** When `getOrBuildPerformanceRatio`
 * returns 0 rows because the system snapshot was still building
 * (fire-and-forget), we still write the (empty) summary so the
 * client sees `convertedReadCount: 0` rather than `available:
 * false`. The next scheduled or user-triggered build picks up
 * the warmed snapshot and replaces the empty summary. This
 * matches `runSystemStep`'s behavior in PR-F-2.
 */
async function runPerformanceRatioStep(args: {
  scopeId: string;
  buildId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { scopeId, buildId, signal } = args;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();

  if (signal.aborted) throw new Error("aborted before aggregate fetch");
  const aggregate = await getOrBuildPerformanceRatio(scopeId);
  if (signal.aborted) throw new Error("aborted after aggregate fetch");

  const factRows = buildPerformanceRatioFactRows({
    scopeId,
    buildId,
    rows: aggregate.rows,
  });

  if (signal.aborted) throw new Error("aborted before upsert");
  await upsertPerformanceRatioFacts(factRows);

  if (signal.aborted) throw new Error("aborted before orphan sweep");
  const orphanedDeleted = await deleteOrphanedPerformanceRatioFacts(
    scopeId,
    buildId
  );

  if (signal.aborted) throw new Error("aborted before summary write");
  const summary = buildPerformanceRatioSummaryPayload({
    buildId,
    builtAt: new Date(),
    aggregate,
    factRows,
  });
  await writePerformanceRatioSummary(scopeId, summary);

  const heapAfter = process.memoryUsage().heapUsed;
  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `${METRIC_PREFIX} metric ${JSON.stringify({
      scopeId,
      buildId,
      rowsWritten: factRows.length,
      orphanedDeleted,
      convertedReadCount: aggregate.convertedReadCount,
      matchedConvertedReads: aggregate.matchedConvertedReads,
      unmatchedConvertedReads: aggregate.unmatchedConvertedReads,
      invalidConvertedReads: aggregate.invalidConvertedReads,
      matchedSystemCount: summary.matchedSystemCount,
      fromCache: aggregate.fromCache,
      elapsedMs,
      heapDeltaBytes: heapAfter - heapBefore,
    })}`
  );
}

/**
 * The exported step. Registered with the runner via
 * `registerPerformanceRatioBuildStep()`.
 */
export const performanceRatioBuildStep: DashboardBuildStep = {
  name: STEP_NAME,
  run: runPerformanceRatioStep,
};

let registered = false;

/**
 * Idempotent registration. First call appends
 * `performanceRatioBuildStep` to the runner's steps array;
 * subsequent calls are no-ops. Designed so a module-level call
 * in `_core/index.ts` (server boot) wires it once.
 *
 * Order independence: the runner iterates steps sequentially in
 * registration order, but the steps themselves are independent
 * (each writes to a distinct fact table + side-cache row).
 * Registering this step after the existing four facts steps
 * means performanceRatio runs fifth; that's fine — they have no
 * dependency on each other.
 */
export async function registerPerformanceRatioBuildStep(): Promise<void> {
  if (registered) return;
  const { getDashboardBuildSteps, setDashboardBuildSteps } = await import(
    "./dashboardBuildJobRunner"
  );
  const previous = getDashboardBuildSteps();
  if (previous.some(step => step.name === STEP_NAME)) {
    registered = true;
    return;
  }
  setDashboardBuildSteps([...previous, performanceRatioBuildStep]);
  registered = true;
}

/**
 * Test-only — reset the idempotency flag so a test can call
 * `registerPerformanceRatioBuildStep()` repeatedly to verify its
 * behavior. Production code MUST NOT call this.
 */
export function __resetPerformanceRatioBuildStepRegistrationForTests(): void {
  registered = false;
}
