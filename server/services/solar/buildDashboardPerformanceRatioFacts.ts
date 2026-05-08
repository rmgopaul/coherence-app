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
  createPerformanceRatioAccumulator,
  PERFORMANCE_RATIO_RUNNER_VERSION,
} from "./buildPerformanceRatioAggregates";
import {
  forEachPerformanceRatioConvertedReadPage,
  loadPerformanceRatioStaticInput,
  resolvePerformanceRatioBatchIds,
} from "./loadPerformanceRatioInput";
import {
  type PerformanceRatioRow,
  resolveAutoCompliantSourceForRow,
  getAutoCompliantSourcePriority,
} from "@shared/solarRecPerformanceRatio";
import {
  upsertPerformanceRatioFacts,
  pruneSupersededPerformanceRatioFacts,
} from "../../db/dashboardPerformanceRatioFacts";
import type { InsertSolarRecDashboardPerformanceRatioFact } from "../../../drizzle/schema";
import { upsertComputedArtifact } from "../../db/solarRecDatasets";
import { startDashboardJobMetric } from "./dashboardJobMetrics";

const STEP_NAME = "performanceRatioFacts";
const METRIC_PREFIX = "[dashboard:fact-build:performanceRatio]";

/**
 * Slim summary side-cache contract. The summary proc reads this row
 * and returns it ~as-is to the client.
 *
 * 2026-05-09 — Option C — the summary's `buildId` is also the
 * VISIBILITY POINTER for the per-build PK fact table. Page reads
 * filter `WHERE scopeId=? AND buildId=summary_buildId`, so
 * pre-cutover writes (or rows from a failed in-flight build) are
 * never visible until the summary is updated. The summary is
 * therefore always written AFTER all fact rows are written; a
 * mid-stream failure leaves the OLD summary in place and the
 * partial new build's rows are invisible.
 *
 * Keyed by a fixed `inputVersionHash` of `"current"` — successive
 * builds overwrite the same row, the freshest build always wins.
 *
 * The aggregator's own `withArtifactCache` row (under
 * PERFORMANCE_RATIO_RUNNER_VERSION) is unaffected; that one is
 * keyed by the 7-batch-ID input hash and is unused by the tab's
 * read path now.
 */
export const PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE =
  "performanceRatioSummary";
export const PERFORMANCE_RATIO_SUMMARY_VERSION_KEY = "current";

/**
 * 2026-05-09 — Option C side-caches. The PerformanceRatioTab's
 * "Compliant Sources" + best-per-system tables read these
 * pre-aggregated rows instead of scanning the full per-build fact
 * set client-side. Each is keyed `(scopeId, "current")` and
 * overwritten on every successful build, mirroring the summary
 * cache. Both side-caches carry their own `buildId` stamp; the
 * client cross-checks against the summary's `buildId` so a stale
 * cache (older than the visible build) can be detected.
 */
export const PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE =
  "performanceRatioAutoCompliantSources";
export const PERFORMANCE_RATIO_AUTO_COMPLIANT_VERSION_KEY = "current";

export const PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE =
  "performanceRatioCompliantBestPerSystem";
export const PERFORMANCE_RATIO_BEST_PER_SYSTEM_VERSION_KEY = "current";

/**
 * Cap on auto-compliant-sources entries cached in a single
 * artifact row. Production today has < 5 k unique systemIds; the
 * 25 k cap leaves substantial headroom while keeping the JSON
 * payload comfortably under the 1 MB dashboard guardrail
 * (25 k × ~30 B ≈ 750 KB).
 */
const AUTO_COMPLIANT_ENTRIES_HARD_CAP = 25_000;

/**
 * Cap on best-per-system entries. Production today has at most
 * one entry per unique system × eligible-month combo; ~few
 * thousand on the largest portfolio. The 5 k cap keeps the
 * artifact payload bounded.
 */
const BEST_PER_SYSTEM_HARD_CAP = 5_000;

export type PerformanceRatioSummaryPayload = {
  // Aggregator counters (pre-existing).
  convertedReadCount: number;
  matchedConvertedReads: number;
  unmatchedConvertedReads: number;
  invalidConvertedReads: number;
  matchedSystemCount: number;

  // 2026-05-09 — Option C — server-side aggregates that the
  // headline tile values read directly. Mirror the client's
  // pre-cutover `performanceRatioSummary` memo. Computed during
  // streaming so no post-write re-scan is needed.
  allocationCount: number;
  withBaseline: number;
  withExpected: number;
  withRatio: number;
  totalDeltaWh: number;
  totalExpectedWh: number;
  /**
   * `totalDeltaWh / totalExpectedWh × 100`, rounded to one
   * decimal place; `null` when `totalExpectedWh <= 0`. Mirrors
   * the client's old `toPercentValue(totalDeltaWh,
   * totalExpectedWh)` helper.
   */
  portfolioRatioPercent: number | null;
  totalContractValue: number;

  // Distinct monitoring values seen in the matched rows. Powers
  // the monitoring-filter dropdown without an extra round-trip.
  monitoringOptions: string[];

  // Visibility pointer + observability.
  buildId: string;
  aggregatorVersion: string;
  builtAt: string;
};

/**
 * Auto-compliant-sources side-cache. Per-systemId classification
 * pre-computed during streaming using
 * `resolveAutoCompliantSourceForRow` from shared. Priority ties
 * resolve via `getAutoCompliantSourcePriority` (10kW = 1, explicit
 * platform = 2; higher wins).
 */
export type PerformanceRatioAutoCompliantSourcesPayload = {
  buildId: string;
  builtAt: string;
  /**
   * `Record<systemId, source>`. Truncated to
   * `AUTO_COMPLIANT_ENTRIES_HARD_CAP` entries deterministically
   * (sorted alphabetically by systemId) when production exceeds
   * the cap; `truncated` flag tells the client to surface a
   * "showing first N" notice and request pagination if/when the
   * paginated read shipped in a follow-up PR.
   */
  sources: Record<string, string>;
  truncated: boolean;
  /**
   * Total number of entries observed (pre-truncation). Lets the
   * client display "X of Y systems classified" even when the
   * cache truncates.
   */
  totalEntries: number;
};

/**
 * Best-per-system side-cache. Filter: `part2VerificationDate IS
 * NOT NULL AND performanceRatioPercent BETWEEN 30 AND 150`.
 * Reduce: keep the row with most-recent read-window month, then
 * highest ratio, then most-recent readDate. Mirrors the client
 * memo `compliantPerformanceRatioRows` exactly. Each row carries
 * the auto-compliant-source as a pre-attached field so the client
 * doesn't need a second lookup; manual sources from localStorage
 * still overlay client-side at render time.
 */
export type PerformanceRatioCompliantBestRow = {
  // Subset of fact-row fields the client renders in the
  // best-per-system table. `compliantSource` is the auto-source
  // resolved by the build; `evidenceCount` always 0 here (manual
  // entries' evidence count overlays at render time).
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string;
  systemName: string;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  monitoringPlatform: string;
  matchType: string;
  installerName: string;
  portalAcSizeKw: number | null;
  abpAcSizeKw: number | null;
  part2VerificationDate: string | null;
  readDate: string | null;
  readDateRaw: string;
  performanceRatioPercent: number | null;
  productionDeltaWh: number | null;
  expectedProductionWh: number | null;
  contractValue: number;
  baselineReadWh: number | null;
  baselineDate: string | null;
  baselineSource: string | null;
  lifetimeReadWh: number;
  compliantSource: string | null;
};

export type PerformanceRatioBestPerSystemPayload = {
  buildId: string;
  builtAt: string;
  rows: PerformanceRatioCompliantBestRow[];
  truncated: boolean;
  totalEntries: number;
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
 * that wrote it. Under Option C the per-build PK
 * `(scopeId, buildId, key)` lets multiple builds coexist; the
 * `pruneSupersededPerformanceRatioFacts` sweep reads `buildId` to
 * delete rows from non-visible builds.
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

// ---------------------------------------------------------------------------
// Streaming accumulators
// ---------------------------------------------------------------------------

/**
 * Running tallies updated per page during streaming. The runner
 * step folds each page's freshly-written fact rows into this
 * structure so the final summary write is a constant-time read of
 * the accumulators rather than a re-scan of the table.
 */
export interface PerformanceRatioStreamingAccumulators {
  matchedSystemKeys: Set<string>;
  monitoringValues: Set<string>;
  allocationCount: number;
  withBaseline: number;
  withExpected: number;
  withRatio: number;
  totalDeltaWh: number;
  totalExpectedWh: number;
  totalContractValue: number;
  /**
   * `Map<systemId, {source, priority}>`. Per-systemId auto-
   * compliant source with priority resolved during streaming;
   * higher priority wins on collision per
   * `getAutoCompliantSourcePriority`.
   */
  autoCompliantSources: Map<string, { source: string; priority: number }>;
  /**
   * `Map<systemKey, candidate>` for best-per-system selection.
   * `systemKey = stateApplicationRefId || systemId ||
   * trackingSystemRefId || systemName.toLowerCase()` mirrors the
   * pre-cutover client memo. Tie-break: most-recent read-window
   * month, then highest ratio, then most-recent readDate.
   */
  bestPerSystem: Map<string, PerformanceRatioCompliantBestRow>;
}

export function createPerformanceRatioStreamingAccumulators():
  PerformanceRatioStreamingAccumulators {
  return {
    matchedSystemKeys: new Set<string>(),
    monitoringValues: new Set<string>(),
    allocationCount: 0,
    withBaseline: 0,
    withExpected: 0,
    withRatio: 0,
    totalDeltaWh: 0,
    totalExpectedWh: 0,
    totalContractValue: 0,
    autoCompliantSources: new Map(),
    bestPerSystem: new Map(),
  };
}

/**
 * Fold a page of freshly-written fact rows into the accumulators.
 * Called after each `upsertPerformanceRatioFacts` so peak heap is
 * still bounded by ONE page (the rows array is consumed and
 * dropped before the next iteration).
 *
 * `rawRows` is the input to the aggregator (PerformanceRatioRow
 * shape, with native `number | null` decimals); `factRows` is the
 * already-validated insert shape (decimals as strings). We accept
 * both because the auto-compliant + best-per-system structures
 * need raw numbers for comparisons; the count/sum aggregates can
 * use either.
 */
export function accumulatePerformanceRatioPage(
  acc: PerformanceRatioStreamingAccumulators,
  rawRows: readonly PerformanceRatioRow[]
): void {
  for (const row of rawRows) {
    // Aggregates / monitoring options.
    acc.allocationCount += 1;
    if (row.trackingSystemRefId) {
      acc.matchedSystemKeys.add(row.trackingSystemRefId);
    }
    if (row.monitoring) {
      acc.monitoringValues.add(row.monitoring);
    }
    if (row.baselineReadWh !== null) acc.withBaseline += 1;
    if (
      row.expectedProductionWh !== null &&
      row.expectedProductionWh > 0
    ) {
      acc.withExpected += 1;
    }
    if (row.performanceRatioPercent !== null) acc.withRatio += 1;
    if (typeof row.productionDeltaWh === "number") {
      acc.totalDeltaWh += row.productionDeltaWh;
    }
    if (typeof row.expectedProductionWh === "number") {
      acc.totalExpectedWh += row.expectedProductionWh;
    }
    if (typeof row.contractValue === "number") {
      acc.totalContractValue += row.contractValue;
    }

    // Auto-compliant sources — priority-resolved per systemId.
    if (row.systemId) {
      const candidate = resolveAutoCompliantSourceForRow({
        monitoringPlatform: row.monitoringPlatform,
        portalAcSizeKw: row.portalAcSizeKw,
        abpAcSizeKw: row.abpAcSizeKw,
      });
      if (candidate) {
        const candidatePriority =
          getAutoCompliantSourcePriority(candidate);
        const existing = acc.autoCompliantSources.get(row.systemId);
        if (!existing || candidatePriority > existing.priority) {
          acc.autoCompliantSources.set(row.systemId, {
            source: candidate,
            priority: candidatePriority,
          });
        }
      }
    }

    // Best-per-system — eligible: part2 + ratio in [30, 150].
    if (
      row.part2VerificationDate &&
      row.performanceRatioPercent !== null &&
      row.performanceRatioPercent >= 30 &&
      row.performanceRatioPercent <= 150
    ) {
      const systemKey =
        row.stateApplicationRefId ||
        row.systemId ||
        row.trackingSystemRefId ||
        row.systemName.toLowerCase();
      const candidate: PerformanceRatioCompliantBestRow = {
        key: row.key,
        systemId: row.systemId,
        stateApplicationRefId: row.stateApplicationRefId,
        trackingSystemRefId: row.trackingSystemRefId,
        systemName: row.systemName,
        monitoring: row.monitoring,
        monitoringSystemId: row.monitoringSystemId,
        monitoringSystemName: row.monitoringSystemName,
        monitoringPlatform: row.monitoringPlatform,
        matchType: row.matchType,
        installerName: row.installerName,
        portalAcSizeKw: row.portalAcSizeKw,
        abpAcSizeKw: row.abpAcSizeKw,
        part2VerificationDate: row.part2VerificationDate
          ? row.part2VerificationDate.toISOString()
          : null,
        readDate: row.readDate ? row.readDate.toISOString() : null,
        readDateRaw: row.readDateRaw,
        performanceRatioPercent: row.performanceRatioPercent,
        productionDeltaWh: row.productionDeltaWh,
        expectedProductionWh: row.expectedProductionWh,
        contractValue: row.contractValue,
        baselineReadWh: row.baselineReadWh,
        baselineDate: row.baselineDate
          ? row.baselineDate.toISOString()
          : null,
        baselineSource: row.baselineSource,
        lifetimeReadWh: row.lifetimeReadWh,
        // Initial null — `buildBestPerSystemPayload` re-attaches
        // the FINAL auto-compliant source after the entire stream
        // has been observed (per-page state would otherwise miss
        // a higher-priority source resolved on a later page).
        compliantSource: null,
      };
      const existing = acc.bestPerSystem.get(systemKey);
      if (!existing || compareCompliantRowsForBestPerSystem(candidate, existing) > 0) {
        acc.bestPerSystem.set(systemKey, candidate);
      }
    }
  }
}

/**
 * Compare two `PerformanceRatioCompliantBestRow` candidates for
 * best-per-system tie-breaking. Returns positive if `a` is better
 * than `b`, negative if worse, zero if equal.
 *
 * Mirrors the client memo's tie-breaker: most-recent read-window
 * month, then highest ratio, then most-recent readDate.
 */
function compareCompliantRowsForBestPerSystem(
  a: PerformanceRatioCompliantBestRow,
  b: PerformanceRatioCompliantBestRow
): number {
  const aWindow = readWindowMs(a.readDate);
  const bWindow = readWindowMs(b.readDate);
  if (aWindow !== bWindow) return aWindow - bWindow;
  const aRatio = a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
  const bRatio = b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
  if (aRatio !== bRatio) return aRatio - bRatio;
  const aRead = readDateMs(a.readDate);
  const bRead = readDateMs(b.readDate);
  return aRead - bRead;
}

function readWindowMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.NEGATIVE_INFINITY;
  // Snap to first-of-month — matches the client's
  // `toReadWindowMonthStart`.
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function readDateMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? Number.NEGATIVE_INFINITY
    : date.getTime();
}

/**
 * Compute the final summary payload from streaming accumulators
 * + the aggregator's converted-read counters. Pure: no I/O.
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
  accumulators: PerformanceRatioStreamingAccumulators;
}): PerformanceRatioSummaryPayload {
  const { buildId, builtAt, aggregate, accumulators } = args;
  const portfolioRatioPercent = computePortfolioRatioPercent(
    accumulators.totalDeltaWh,
    accumulators.totalExpectedWh
  );
  const monitoringOptions = Array.from(
    accumulators.monitoringValues
  ).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
  return {
    convertedReadCount: aggregate.convertedReadCount,
    matchedConvertedReads: aggregate.matchedConvertedReads,
    unmatchedConvertedReads: aggregate.unmatchedConvertedReads,
    invalidConvertedReads: aggregate.invalidConvertedReads,
    matchedSystemCount: accumulators.matchedSystemKeys.size,
    allocationCount: accumulators.allocationCount,
    withBaseline: accumulators.withBaseline,
    withExpected: accumulators.withExpected,
    withRatio: accumulators.withRatio,
    totalDeltaWh: accumulators.totalDeltaWh,
    totalExpectedWh: accumulators.totalExpectedWh,
    portfolioRatioPercent,
    totalContractValue: accumulators.totalContractValue,
    monitoringOptions,
    buildId,
    aggregatorVersion: PERFORMANCE_RATIO_RUNNER_VERSION,
    builtAt: builtAt.toISOString(),
  };
}

/**
 * Mirror of the client's `toPercentValue(totalDeltaWh,
 * totalExpectedWh)` pre-cutover helper.
 */
export function computePortfolioRatioPercent(
  totalDeltaWh: number,
  totalExpectedWh: number
): number | null {
  if (!Number.isFinite(totalExpectedWh) || totalExpectedWh <= 0) {
    return null;
  }
  if (!Number.isFinite(totalDeltaWh)) return null;
  const ratio = (totalDeltaWh / totalExpectedWh) * 100;
  return Math.round(ratio * 10) / 10;
}

/**
 * Build the auto-compliant-sources side-cache payload from the
 * streaming accumulator.
 */
export function buildAutoCompliantSourcesPayload(args: {
  buildId: string;
  builtAt: Date;
  accumulators: PerformanceRatioStreamingAccumulators;
}): PerformanceRatioAutoCompliantSourcesPayload {
  const { buildId, builtAt, accumulators } = args;
  const totalEntries = accumulators.autoCompliantSources.size;
  const entries = Array.from(accumulators.autoCompliantSources).sort(
    ([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
  const truncated = entries.length > AUTO_COMPLIANT_ENTRIES_HARD_CAP;
  const kept = truncated
    ? entries.slice(0, AUTO_COMPLIANT_ENTRIES_HARD_CAP)
    : entries;
  const sources: Record<string, string> = {};
  for (const [systemId, value] of kept) {
    sources[systemId] = value.source;
  }
  return {
    buildId,
    builtAt: builtAt.toISOString(),
    sources,
    truncated,
    totalEntries,
  };
}

/**
 * Build the best-per-system side-cache payload from the
 * streaming accumulator. `compliantSource` on each row is set
 * AFTER the auto-compliant Map is finalized so late-stream
 * priority resolution is reflected.
 */
export function buildBestPerSystemPayload(args: {
  buildId: string;
  builtAt: Date;
  accumulators: PerformanceRatioStreamingAccumulators;
}): PerformanceRatioBestPerSystemPayload {
  const { buildId, builtAt, accumulators } = args;
  // Re-attach `compliantSource` per row using the FINAL
  // auto-compliant Map (per-page accumulation may have set this
  // to null when a system's first eligible row was processed
  // before its compliant-source-priority candidate appeared).
  const rows: PerformanceRatioCompliantBestRow[] = [];
  for (const candidate of Array.from(accumulators.bestPerSystem.values())) {
    rows.push({
      ...candidate,
      compliantSource: candidate.systemId
        ? accumulators.autoCompliantSources.get(candidate.systemId)?.source ??
          null
        : null,
    });
  }
  // Stable display order: most-recent read-window first, then
  // highest ratio, then systemName ascending. Mirrors the client
  // memo's final sort.
  rows.sort((a, b) => {
    const aWindow = readWindowMs(a.readDate);
    const bWindow = readWindowMs(b.readDate);
    if (aWindow !== bWindow) return bWindow - aWindow;
    const aRatio = a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
    const bRatio = b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
    if (aRatio !== bRatio) return bRatio - aRatio;
    return a.systemName.localeCompare(b.systemName, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
  const totalEntries = rows.length;
  const truncated = rows.length > BEST_PER_SYSTEM_HARD_CAP;
  const kept = truncated ? rows.slice(0, BEST_PER_SYSTEM_HARD_CAP) : rows;
  return {
    buildId,
    builtAt: builtAt.toISOString(),
    rows: kept,
    truncated,
    totalEntries,
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
 * Single source of truth for parsing a `performanceRatioSummary`
 * artifact's `payload` field (a JSON-stringified
 * `PerformanceRatioSummaryPayload`). Returns `null` on malformed
 * JSON or missing required fields. Both the router's read procs
 * and the CSV-export builder go through this helper so a future
 * schema change has a single audit point.
 */
export function parsePerformanceRatioSummaryPayload(
  rawPayload: string | null
): PerformanceRatioSummaryPayload | null {
  if (!rawPayload) return null;
  try {
    const parsed = JSON.parse(rawPayload) as Partial<PerformanceRatioSummaryPayload>;
    if (typeof parsed.buildId !== "string" || parsed.buildId.length === 0) {
      return null;
    }
    if (typeof parsed.builtAt !== "string") return null;
    return parsed as PerformanceRatioSummaryPayload;
  } catch {
    return null;
  }
}

/**
 * Convenience: extract just the `buildId` from a summary artifact.
 * Used by procs that only need the visibility pointer (page,
 * filtered-aggregates, CSV-export). Equivalent to
 * `parsePerformanceRatioSummaryPayload(...)?.buildId ?? null` but
 * cheaper for the buildId-only case.
 */
export function extractPerformanceRatioVisibleBuildId(
  rawPayload: string | null
): string | null {
  if (!rawPayload) return null;
  try {
    const parsed = JSON.parse(rawPayload) as { buildId?: unknown };
    return typeof parsed.buildId === "string" && parsed.buildId.length > 0
      ? parsed.buildId
      : null;
  } catch {
    return null;
  }
}

async function writeAutoCompliantSourcesArtifact(
  scopeId: string,
  payload: PerformanceRatioAutoCompliantSourcesPayload
): Promise<void> {
  await upsertComputedArtifact({
    scopeId,
    artifactType: PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE,
    inputVersionHash: PERFORMANCE_RATIO_AUTO_COMPLIANT_VERSION_KEY,
    payload: JSON.stringify(payload),
    rowCount: Object.keys(payload.sources).length,
  });
}

async function writeBestPerSystemArtifact(
  scopeId: string,
  payload: PerformanceRatioBestPerSystemPayload
): Promise<void> {
  await upsertComputedArtifact({
    scopeId,
    artifactType: PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE,
    inputVersionHash: PERFORMANCE_RATIO_BEST_PER_SYSTEM_VERSION_KEY,
    payload: JSON.stringify(payload),
    rowCount: payload.rows.length,
  });
}

/**
 * Runner step. Drives the whole table-refresh in one pass:
 * load static input → stream convertedReads page-by-page →
 * per page: match + emit fact rows + UPSERT + drain → orphan-
 * sweep → summary write.
 *
 * Step contract (from `DashboardBuildStep`): never throws unless
 * the work genuinely failed. The runner converts thrown errors
 * into the build row's `errorMessage` and stops at the first
 * failing step.
 *
 * **2026-05-08 OOM hardening — streaming-write fact rows.**
 * The pre-fix path called `getOrBuildPerformanceRatio` (which
 * accumulates ALL matched rows in memory before returning), then
 * upserted in one batch. On prod-shape data (~13M convertedReads
 * with thousands of matched rows + the static input maps + the
 * system snapshot) heap headroom was insufficient — the worker
 * OOMed during the convertedReads streaming/match phase, before
 * the aggregator could write its `withArtifactCache` row. The
 * stale-claim sweep eventually marked the build failed.
 *
 * Streaming fix: bypass `getOrBuildPerformanceRatio`. Manually
 * call `loadPerformanceRatioStaticInput` once, then stream
 * convertedReads through `forEachPerformanceRatioConvertedReadPage`,
 * draining the accumulator's matched rows after EACH page and
 * UPSERTing them immediately. Memory peak is bounded by ONE page's
 * worth of fact rows (~2.5k max — see
 * `PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE` in
 * `loadPerformanceRatioInput.ts`; PR #488 cut from 5k to 2.5k for
 * additional OOM headroom) instead of all matched rows accumulating
 * across the full stream.
 *
 * Bonus: the per-page DB upsert acts as a regular event-loop
 * yield point so the runner's heartbeat timer fires on cadence
 * — the pre-fix path's long synchronous match-then-upsert phase
 * could starve the heartbeat for minutes, which is what
 * triggered the false "stale claim" failure path even when the
 * worker was technically alive.
 *
 * **Side effects.** This step does NOT populate the
 * `performanceRatio` artifact-cache row that the legacy
 * `getOrBuildPerformanceRatio` proc reads. After PR-G-5 retired
 * the legacy tRPC proc, no client reads that cache row; the
 * fact table + slim summary side cache are the only consumers.
 *
 * **Cold-cache behavior.** When the underlying snapshot is still
 * building (fire-and-forget) and `loadPerformanceRatioStaticInput`
 * returns empty systems, the matcher emits 0 fact rows and the
 * summary writes 0 counters. The next scheduled or user-
 * triggered build picks up the warmed snapshot and replaces the
 * empty summary. Matches `runSystemStep`'s behavior in PR-F-2.
 */
async function runPerformanceRatioStep(args: {
  scopeId: string;
  buildId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { scopeId, buildId, signal } = args;
  // 2026-05-08 (consolidation follow-up to PR #505) — switch the
  // perf-ratio fact-builder onto `startDashboardJobMetric` to match
  // the other 4 fact-builders converted in #505. The streaming-write
  // structure is preserved (per-page `process.stdout.write` for
  // operational tracing, plus the setImmediate yield from #502); only
  // the TERMINAL metric line goes through the shared API.
  const metric = startDashboardJobMetric({
    prefix: METRIC_PREFIX,
    jobId: buildId,
    context: { scopeId },
  });

  // 2026-05-09 — Option C build-isolation refactor. The fact-row
  // PK now includes `buildId`, so this build's writes coexist with
  // any prior build's rows in the table; visibility flips on the
  // summary write. Strict ordering:
  //   1. Stream pages → UPSERT rows tagged with THIS buildId
  //      (rows are NOT visible — page reader filters by the
  //      summary's buildId, which is still the PRIOR build's).
  //   2. Once streaming + accumulators are complete: write
  //      auto-compliant + best-per-system side caches under the
  //      new buildId.
  //   3. Write the summary artifact with the new `buildId` —
  //      THIS is the visibility flip; tab reads now see the new
  //      build's rows.
  //   4. Best-effort prune of superseded rows (older `buildId`s).
  //
  // If the runner throws between (1) and (3), the OLD summary
  // remains the visible build pointer; partially-written new
  // rows sit invisible until the next successful build's prune
  // sweep reclaims them.
  try {
    if (signal.aborted) throw new Error("aborted before batch resolution");
    const batchIds = await resolvePerformanceRatioBatchIds(scopeId);

    // No convertedReads → write empty side caches + empty
    // summary, then prune. `allocationCount = 0` and
    // `monitoringOptions = []` reach the client.
    if (!batchIds.convertedReadsBatchId) {
      if (signal.aborted)
        throw new Error("aborted before empty summary write");
      const builtAt = new Date();
      const streamingTotals = createPerformanceRatioStreamingAccumulators();
      // Write side caches BEFORE summary (visibility-flip ordering).
      await writeAutoCompliantSourcesArtifact(
        scopeId,
        buildAutoCompliantSourcesPayload({
          buildId,
          builtAt,
          accumulators: streamingTotals,
        })
      );
      await writeBestPerSystemArtifact(
        scopeId,
        buildBestPerSystemPayload({
          buildId,
          builtAt,
          accumulators: streamingTotals,
        })
      );
      const summary = buildPerformanceRatioSummaryPayload({
        buildId,
        builtAt,
        aggregate: {
          convertedReadCount: 0,
          matchedConvertedReads: 0,
          unmatchedConvertedReads: 0,
          invalidConvertedReads: 0,
        },
        accumulators: streamingTotals,
      });
      await writePerformanceRatioSummary(scopeId, summary);
      const prunedCount = await pruneSupersededPerformanceRatioFacts(
        scopeId,
        [buildId]
      );
      metric.finish({
        skipped: true,
        reason: "no convertedReads batch",
        orphanedDeleted: prunedCount,
      });
      return;
    }

    if (signal.aborted) throw new Error("aborted before static input load");
    const staticInput = await loadPerformanceRatioStaticInput(
      scopeId,
      batchIds
    );
    if (signal.aborted) throw new Error("aborted after static input load");

    // 2026-05-09 review fixup — rename `accumulator` to `matcher`
    // to disambiguate from the new `streamingTotals` struct. The
    // pre-fix names `accumulator` (singular, upstream matcher) and
    // `accumulators` (plural, my Option-C totals) were one letter
    // apart — easy to typo into the wrong reference.
    const matcher = createPerformanceRatioAccumulator(staticInput);
    const streamingTotals = createPerformanceRatioStreamingAccumulators();
    let totalFactsWritten = 0;
    let pageCount = 0;

    await forEachPerformanceRatioConvertedReadPage(
      scopeId,
      batchIds.convertedReadsBatchId,
      async (pageRows, startIndex) => {
        if (signal.aborted) throw new Error("aborted mid-stream");
        matcher.processRows(pageRows, startIndex);
        const drained = matcher.drainPendingRows();
        pageCount += 1;
        // 2026-05-08 step-4 hardening — yield to the event loop so
        // the heartbeat setInterval can fire even if upserts are
        // queueing microtasks back-to-back. await on a setImmediate
        // gives the timer queue a definite chance to drain.
        //
        // 2026-05-08 self-review (#488 follow-up, #494 heap-log
        // companion) — yield BEFORE the early-returns + the heap
        // log. Tail-of-stream pages where matches taper off
        // otherwise stayed synchronously hot, starving the
        // heartbeat. With this move every page (including pure
        // no-match pages) goes through the event loop at least
        // once, AND the heap reading captured below reflects
        // post-GC state — the yield gives V8 a chance to compact
        // before we sample.
        //
        // Cost: one `setImmediate` tick per page (microseconds × N
        // pages). Negligible vs. the diagnostic value when the
        // heartbeat must fire reliably under heap pressure.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        // 2026-05-08 step-4 hardening — log heap on EVERY page (was
        // every 10 in PR #488; PR #494 ensures EMPTY-drain pages
        // also emit the log line).
        const heapMb = Math.round(
          process.memoryUsage().heapUsed / 1024 / 1024
        );
        process.stdout.write(
          `[buildDashboardPerformanceRatioFacts] streamed page=${pageCount} ` +
            `factsWrittenSoFar=${totalFactsWritten} ` +
            `drainSize=${drained.length} ` +
            `heapUsed=${heapMb}MB\n`
        );
        if (drained.length === 0) return;
        const factRows = buildPerformanceRatioFactRows({
          scopeId,
          buildId,
          rows: drained,
        });
        if (factRows.length === 0) return;
        await upsertPerformanceRatioFacts(factRows);
        totalFactsWritten += factRows.length;
        // 2026-05-09 — Option C — fold the page's raw rows into
        // the streaming totals. Server-side aggregates +
        // compliant context are derived here so the final
        // summary write is constant-time.
        accumulatePerformanceRatioPage(streamingTotals, drained);
      }
    );

    // ----- Visibility flip ordering -----
    if (signal.aborted) throw new Error("aborted before side-cache writes");
    const counters = matcher.getCounters();
    const builtAt = new Date();

    // Side caches BEFORE summary so a client that hits the new
    // summary (visibility flip) and immediately follows with a
    // compliant-context fetch never reads a stale side-cache row.
    await writeAutoCompliantSourcesArtifact(
      scopeId,
      buildAutoCompliantSourcesPayload({
        buildId,
        builtAt,
        accumulators: streamingTotals,
      })
    );
    await writeBestPerSystemArtifact(
      scopeId,
      buildBestPerSystemPayload({
        buildId,
        builtAt,
        accumulators: streamingTotals,
      })
    );

    if (signal.aborted) throw new Error("aborted before summary write");
    const summary = buildPerformanceRatioSummaryPayload({
      buildId,
      builtAt,
      aggregate: {
        convertedReadCount: counters.convertedReadCount,
        matchedConvertedReads: counters.matchedConvertedReads,
        unmatchedConvertedReads: counters.unmatchedConvertedReads,
        invalidConvertedReads: counters.invalidConvertedReads,
      },
      accumulators: streamingTotals,
    });
    // ⚠️ This call is the visibility flip. Until it returns
    // success, page reads continue to see the prior build's
    // rows (or nothing, if no prior build).
    await writePerformanceRatioSummary(scopeId, summary);

    // Best-effort: prune rows from superseded builds. Failure
    // here doesn't roll back the visibility flip; stale rows
    // simply persist invisible until the next prune.
    let orphanedDeleted = 0;
    try {
      orphanedDeleted = await pruneSupersededPerformanceRatioFacts(
        scopeId,
        [buildId]
      );
    } catch (pruneErr) {
      console.warn(
        `${METRIC_PREFIX} prune of superseded rows failed (visibility flip already succeeded): ${
          pruneErr instanceof Error ? pruneErr.message : String(pruneErr)
        }`
      );
    }

    metric.finish({
      rowsWritten: totalFactsWritten,
      pageCount,
      orphanedDeleted,
      convertedReadCount: counters.convertedReadCount,
      matchedConvertedReads: counters.matchedConvertedReads,
      unmatchedConvertedReads: counters.unmatchedConvertedReads,
      invalidConvertedReads: counters.invalidConvertedReads,
      matchedSystemCount: streamingTotals.matchedSystemKeys.size,
      allocationCount: streamingTotals.allocationCount,
      autoCompliantSystems: streamingTotals.autoCompliantSources.size,
      compliantBestPerSystem: streamingTotals.bestPerSystem.size,
      streaming: true,
    });
  } catch (err) {
    metric.fail(err);
    throw err;
  }
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
