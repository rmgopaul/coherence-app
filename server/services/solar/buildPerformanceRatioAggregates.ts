/**
 * Server-side aggregator for the Performance Ratio tab.
 *
 * Pure function — no I/O. The wrapper that loads inputs from
 * `srDs*` tables + the system snapshot and caches the result via
 * `withArtifactCache` lands in PR 3 of the migration plan.
 *
 * Helpers + types live in `@shared/solarRecPerformanceRatio` so the
 * client tab and this aggregator share one source of truth. The
 * client's existing `client/src/solar-rec-dashboard/lib/helpers/...`
 * call sites re-export from there; nothing on the client moved.
 */

import {
  calculateExpectedWhForRange,
  clean,
  normalizeMonitoringMatch,
  normalizeSystemIdMatch,
  normalizeSystemNameMatch,
  parseDate,
  parseEnergyToWh,
  type PerformanceRatioAggregates,
  type PerformanceRatioConvertedReadRow,
  type PerformanceRatioInput,
  type PerformanceRatioInputSystem,
  type PerformanceRatioMatchType,
  type PerformanceRatioRow,
} from "@shared/solarRecPerformanceRatio";

export type {
  PerformanceRatioAggregates,
  PerformanceRatioInput,
  PerformanceRatioInputSystem,
  PerformanceRatioMatchType,
  PerformanceRatioRow,
} from "@shared/solarRecPerformanceRatio";

type MatchIndexes = {
  byMonitoringAndId: Map<string, Set<string>>;
  byMonitoringAndName: Map<string, Set<string>>;
  byMonitoringAndIdAndName: Map<string, Set<string>>;
  candidateByKey: Map<string, PerformanceRatioInputSystem>;
};

function buildMatchIndexes(
  systems: readonly PerformanceRatioInputSystem[]
): MatchIndexes {
  const byMonitoringAndId = new Map<string, Set<string>>();
  const byMonitoringAndName = new Map<string, Set<string>>();
  const byMonitoringAndIdAndName = new Map<string, Set<string>>();
  const candidateByKey = new Map<string, PerformanceRatioInputSystem>();

  const add = (
    map: Map<string, Set<string>>,
    key: string,
    candidateKey: string
  ) => {
    if (!key) return;
    const current = map.get(key);
    if (current) {
      current.add(candidateKey);
      return;
    }
    map.set(key, new Set([candidateKey]));
  };

  for (const system of systems) {
    if (!system.trackingSystemRefId) continue;
    candidateByKey.set(system.key, system);
    for (const monitoringToken of system.monitoringTokens) {
      for (const idToken of system.idTokens) {
        add(byMonitoringAndId, `${monitoringToken}__${idToken}`, system.key);
      }
      for (const nameToken of system.nameTokens) {
        add(
          byMonitoringAndName,
          `${monitoringToken}__${nameToken}`,
          system.key
        );
      }
      for (const idToken of system.idTokens) {
        for (const nameToken of system.nameTokens) {
          add(
            byMonitoringAndIdAndName,
            `${monitoringToken}__${idToken}__${nameToken}`,
            system.key
          );
        }
      }
    }
  }

  return {
    byMonitoringAndId,
    byMonitoringAndName,
    byMonitoringAndIdAndName,
    candidateByKey,
  };
}

export function buildPerformanceRatioAggregates(
  input: PerformanceRatioInput
): PerformanceRatioAggregates {
  const accumulator = createPerformanceRatioAccumulator(input);
  accumulator.processRows(input.convertedReadsRows, 0);
  return accumulator.toAggregates();
}

/**
 * Cross-source dedup key for a single normalized convertedReads row.
 *
 * The matcher emits one fact row per `(convertedRead row, candidate
 * system)` tuple, so two convertedReads source rows representing
 * the SAME physical reading via different ingestion paths
 * (`mon_batch_<provider>` API push vs. `individual_<provider>`
 * manual CSV upload) would emit two identical fact rows without a
 * dedup chokepoint. This helper computes the key the matcher uses
 * to collapse them.
 *
 * **Key shape: `${monitoringNormalized}|${dedupIdentifier}|${lifetimeReadWh}|${dedupDateKey}`**
 *
 * - **Monitoring component:** the normalized monitoring source
 *   (e.g. `solaredge`, `enphase`). Distinct providers are distinct
 *   physical readings even when sysName + lifetime + date all match.
 * - **Identifier component:** the system NAME normalized when
 *   non-empty (the common case — the bridge always populates it;
 *   manual CSV uploads almost always populate it). Falls back to
 *   the system ID when name is empty. The validity check at the
 *   call site guarantees at least one is populated, so the
 *   identifier is never the empty string. Edge case: rows that
 *   share monitoring + lifetime + date but differ in BOTH name and
 *   id hash to different keys and don't dedup — accepted, those
 *   are genuinely different physical readings.
 * - **Lifetime component:** the parsed `lifetime_meter_read_wh`
 *   (already a number at this point). Two rows with different
 *   lifetimes are different physical readings even when monitoring
 *   + name + date match.
 * - **Date component:** the parsed `readDate.getTime()` when
 *   parsing succeeded so two source rows representing the same
 *   calendar day with different string formats (e.g. `4/13/2026`
 *   from `convertedReadsBridge.ts:formatReadDate` vs. `2026-04-13`
 *   from a manual CSV upload) hash to the same key. Falls back to
 *   the raw string when parsing failed (the source row would emit
 *   `readDate: null` to the matcher anyway, so dedup on the raw
 *   string is the cleanest available signal).
 *
 * Pure function — extracted from the accumulator inline body for
 * code reuse + unit testability (post-merge review fixup of PR-1,
 * 2026-05-09 follow-up).
 */
export function buildCrossSourceDedupKey(args: {
  monitoringNormalized: string;
  monitoringSystemNameNormalized: string;
  monitoringSystemIdNormalized: string;
  lifetimeReadWh: number;
  readDate: Date | null;
  readDateRaw: string;
}): string {
  const dedupIdentifier =
    args.monitoringSystemNameNormalized ||
    args.monitoringSystemIdNormalized;
  const dedupDateKey = args.readDate
    ? args.readDate.getTime()
    : args.readDateRaw;
  return `${args.monitoringNormalized}|${dedupIdentifier}|${args.lifetimeReadWh}|${dedupDateKey}`;
}

type PerformanceRatioStaticInput = Omit<
  PerformanceRatioInput,
  "convertedReadsRows"
>;

export type PerformanceRatioCounters = {
  convertedReadCount: number;
  matchedConvertedReads: number;
  unmatchedConvertedReads: number;
  invalidConvertedReads: number;
  /** See `PerformanceRatioAggregates.dedupedConvertedReads`. */
  dedupedConvertedReads: number;
};

type PerformanceRatioAccumulator = {
  processRows: (
    convertedReadsRows: readonly PerformanceRatioConvertedReadRow[],
    startIndex: number
  ) => void;
  toAggregates: () => PerformanceRatioAggregates;
  /**
   * Streaming-drain hook for the fact-table build runner step
   * (PR-G-2 + 2026-05-08 OOM hardening). Returns the matched
   * rows accumulated since the last call AND clears the internal
   * buffer so the next page starts fresh.
   *
   * Counters (`convertedReadCount`, `matched`, `unmatched`,
   * `invalid`) are PRESERVED across drains — a caller that
   * drains incrementally during streaming and reads
   * `getCounters()` at the end gets the same totals as the
   * legacy `toAggregates()` path.
   *
   * The legacy `toAggregates()` path is unaffected as long as
   * the caller never calls `drainPendingRows()` — the rows
   * array stays full and the final sort + return are identical.
   * Mixing the two is undefined; pick one mode per call site.
   */
  drainPendingRows: () => PerformanceRatioRow[];
  /** Snapshot of the counter state. Safe to call mid-stream. */
  getCounters: () => PerformanceRatioCounters;
};

export function createPerformanceRatioAccumulator(
  input: PerformanceRatioStaticInput
): PerformanceRatioAccumulator {
  const {
    systems,
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId,
    annualProductionByTrackingId,
    generationBaselineByTrackingId,
    generatorDateOnlineByTrackingId,
  } = input;

  const indexes = buildMatchIndexes(systems);

  let rows: PerformanceRatioRow[] = [];
  let convertedReadCount = 0;
  let matchedConvertedReads = 0;
  let unmatchedConvertedReads = 0;
  let invalidConvertedReads = 0;
  let dedupedConvertedReads = 0;
  // Cross-source dedup key set, accumulated across `processRows`
  // pages. The matcher emits one fact row per (convertedRead row,
  // candidate system) tuple; without dedup, two convertedReads
  // source rows that report the SAME physical reading via different
  // ingestion paths (`mon_batch_<provider>` API push vs.
  // `individual_<provider>` manual CSV upload) match the same
  // candidate at the same priority tier and emit two identical
  // fact rows. The bridge can't dedup at write time because the
  // sources are server-managed independently; the matcher is the
  // chokepoint. First-wins tie-break — the surviving fact row's
  // `monitoringSystemId` field reflects whichever raw row arrived
  // first (which may be empty if the manual-CSV row is first), but
  // downstream consumers of the fact table read
  // `candidate.systemId`, not the raw row's `monitoring_system_id`,
  // so the displayed system identity is stable.
  //
  // **Counter-partition semantics** (post-merge review of PR-1,
  // 2026-05-09 follow-up + remediation). The dedup branch fires
  // AFTER the validity check but BEFORE the match attempt. So:
  //   - `convertedReadCount = matched + unmatched + invalid + deduped`
  //     is the strict partition.
  //   - A row that's a duplicate of a previously-matched row counts
  //     as `deduped`, not `matched`. The `matched` counter records
  //     UNIQUE physical readings that produced a fact row.
  //   - A row that's a duplicate of a previously-VALID-but-unmatched
  //     row counts as `deduped`. Its key was added to the dedup set
  //     by the prior row even though the prior produced no fact;
  //     acceptable, because the second row by definition has the
  //     same keys → also no candidate → no fact either way.
  //   - INVALID rows (failed the validity check above) NEVER reach
  //     the dedup branch — they hit `invalidConvertedReads += 1;
  //     continue;` before the dedup-key is ever computed. A
  //     subsequent invalid row with the same shape also fails
  //     validity and increments `invalidConvertedReads` again. So
  //     "duplicate of an invalid row" doesn't exist as a category;
  //     the partition still holds.
  //
  // **Heap cost note.** The Set grows linearly in input row count.
  // Each entry is ~50 chars × ~2 bytes/char = ~100 bytes. On a
  // 225k-row prod batch that's ~22 MB peak — within budget given
  // the streaming-drain pattern bounds the rest of the matcher's
  // heap to one page's worth of fact rows. If batches grow to
  // millions of rows, replace the Set with a hashed bloom filter
  // or sharded LRU; for now the simple Set is correct + cheap.
  const processedCrossSourceKeys = new Set<string>();

  return {
    processRows: (convertedReadsRows, startIndex) => {
      convertedReadCount += convertedReadsRows.length;

      if (convertedReadsRows.length === 0 || systems.length === 0) {
        return;
      }

      for (let index = 0; index < convertedReadsRows.length; index += 1) {
        const row = convertedReadsRows[index]!;
        const globalIndex = startIndex + index;
        const monitoring = clean(row.monitoring);
        const monitoringNormalized = normalizeMonitoringMatch(monitoring);
        const lifetimeReadWh = parseEnergyToWh(
          row.lifetime_meter_read_wh,
          "lifetime_meter_read_wh",
          "wh"
        );
        const monitoringSystemId = clean(row.monitoring_system_id);
        const monitoringSystemIdNormalized =
          normalizeSystemIdMatch(monitoringSystemId);
        const monitoringSystemName = clean(row.monitoring_system_name);
        const monitoringSystemNameNormalized =
          normalizeSystemNameMatch(monitoringSystemName);

        if (
          !monitoringNormalized ||
          lifetimeReadWh === null ||
          (!monitoringSystemIdNormalized && !monitoringSystemNameNormalized)
        ) {
          invalidConvertedReads += 1;
          continue;
        }

        const readDateRaw = clean(row.read_date);
        const readDate = parseDate(readDateRaw);
        const crossSourceKey = buildCrossSourceDedupKey({
          monitoringNormalized,
          monitoringSystemNameNormalized,
          monitoringSystemIdNormalized,
          lifetimeReadWh,
          readDate,
          readDateRaw,
        });
        if (processedCrossSourceKeys.has(crossSourceKey)) {
          dedupedConvertedReads += 1;
          continue;
        }
        processedCrossSourceKeys.add(crossSourceKey);

        const readKey = `converted-${globalIndex}`;

        const bothMatches =
          monitoringSystemIdNormalized && monitoringSystemNameNormalized
            ? indexes.byMonitoringAndIdAndName.get(
                `${monitoringNormalized}__${monitoringSystemIdNormalized}__${monitoringSystemNameNormalized}`
              ) ?? null
            : null;
        const idMatches = monitoringSystemIdNormalized
          ? indexes.byMonitoringAndId.get(
              `${monitoringNormalized}__${monitoringSystemIdNormalized}`
            ) ?? null
          : null;
        const nameMatches = monitoringSystemNameNormalized
          ? indexes.byMonitoringAndName.get(
              `${monitoringNormalized}__${monitoringSystemNameNormalized}`
            ) ?? null
          : null;

        const matchedCandidateKeys = new Set<string>();
        bothMatches?.forEach((k) => matchedCandidateKeys.add(k));
        idMatches?.forEach((k) => matchedCandidateKeys.add(k));
        nameMatches?.forEach((k) => matchedCandidateKeys.add(k));

        if (matchedCandidateKeys.size === 0) {
          unmatchedConvertedReads += 1;
          continue;
        }
        matchedConvertedReads += 1;

        matchedCandidateKeys.forEach((candidateKey) => {
          const candidate = indexes.candidateByKey.get(candidateKey);
          if (!candidate || !candidate.trackingSystemRefId) return;

          const baseline = generationBaselineByTrackingId.get(
            candidate.trackingSystemRefId
          );
          const generatorDateOnline =
            generatorDateOnlineByTrackingId.get(candidate.trackingSystemRefId) ??
            null;
          const baselineValueWh =
            baseline?.valueWh ?? (generatorDateOnline ? 0 : null);
          const baselineDate = baseline?.date ?? generatorDateOnline;
          const baselineSource =
            baseline?.source ??
            (generatorDateOnline
              ? "Generator Details (Date Online @ day 15, baseline 0)"
              : null);
          const annualProfile = annualProductionByTrackingId.get(
            candidate.trackingSystemRefId
          );
          const productionDeltaWh =
            baselineValueWh !== null ? lifetimeReadWh - baselineValueWh : null;
          const expectedProductionWh =
            baselineDate && readDate && annualProfile
              ? calculateExpectedWhForRange(
                  annualProfile.monthlyKwh,
                  baselineDate,
                  readDate
                )
              : null;
          const performanceRatioPercent =
            productionDeltaWh !== null &&
            expectedProductionWh !== null &&
            expectedProductionWh > 0
              ? (productionDeltaWh / expectedProductionWh) * 100
              : null;

          const matchType: PerformanceRatioMatchType =
            bothMatches && bothMatches.has(candidateKey)
              ? "Monitoring + System ID + System Name"
              : idMatches && idMatches.has(candidateKey)
                ? "Monitoring + System ID"
                : "Monitoring + System Name";

          rows.push({
            key: `${readKey}-${candidateKey}`,
            convertedReadKey: readKey,
            matchType,
            monitoring,
            monitoringSystemId,
            monitoringSystemName,
            readDate,
            readDateRaw,
            lifetimeReadWh,
            trackingSystemRefId: candidate.trackingSystemRefId,
            systemId: candidate.systemId,
            stateApplicationRefId: candidate.stateApplicationRefId,
            systemName: candidate.systemName,
            installerName: candidate.installerName,
            monitoringPlatform: candidate.monitoringPlatform,
            portalAcSizeKw: candidate.installedKwAc,
            abpAcSizeKw: candidate.stateApplicationRefId
              ? abpAcSizeKwByApplicationId.get(
                  candidate.stateApplicationRefId
                ) ?? null
              : null,
            part2VerificationDate: candidate.stateApplicationRefId
              ? abpPart2VerificationDateByApplicationId.get(
                  candidate.stateApplicationRefId
                ) ?? null
              : null,
            baselineReadWh: baselineValueWh,
            baselineDate,
            baselineSource,
            productionDeltaWh,
            expectedProductionWh,
            performanceRatioPercent,
            contractValue: candidate.contractValue,
          });
        });
      }
    },
    toAggregates: () => {
      rows.sort((a, b) => {
        const aTime = a.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bTime = b.readDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (aTime !== bTime) return bTime - aTime;
        const aRatio = a.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        const bRatio = b.performanceRatioPercent ?? Number.NEGATIVE_INFINITY;
        if (aRatio !== bRatio) return bRatio - aRatio;
        return a.systemName.localeCompare(b.systemName, undefined, {
          sensitivity: "base",
          numeric: true,
        });
      });

      return {
        rows,
        convertedReadCount,
        matchedConvertedReads,
        unmatchedConvertedReads,
        invalidConvertedReads,
        dedupedConvertedReads,
      };
    },
    // 2026-05-08 OOM hardening — streaming-drain hook for the
    // fact-table build runner step. Returns the matched rows
    // accumulated since the last call AND replaces the internal
    // buffer with a fresh empty array. Counter state is
    // preserved (next page accumulates additional matches).
    //
    // Mixing `drainPendingRows()` with a later `toAggregates()`
    // is undefined — `toAggregates()` would only see rows added
    // after the last drain. Pick one mode per accumulator
    // instance.
    drainPendingRows: () => {
      const drained = rows;
      rows = [];
      return drained;
    },
    getCounters: () => ({
      convertedReadCount,
      matchedConvertedReads,
      unmatchedConvertedReads,
      invalidConvertedReads,
      dedupedConvertedReads,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint — Phase 5d PR 1 (2026-04-29).
//
// Wraps the pure aggregator with the `withArtifactCache` memoization
// layer so repeat tRPC calls hit the cache instead of re-loading
// every srDs* table + snapshot. Cache key bundles the active batch
// IDs of the 7 input datasets — any batch flip invalidates the
// cached result deterministically.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import {
  forEachPerformanceRatioConvertedReadPage,
  loadPerformanceRatioStaticInput,
  resolvePerformanceRatioBatchIds,
  type PerformanceRatioInputBatchIds,
} from "./loadPerformanceRatioInput";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

const PERFORMANCE_RATIO_ARTIFACT_TYPE = "performanceRatio";

// 2026-05-09 — bumped from `@2` to `@3` for the cross-source dedup
// fix (Bug #5 from the 2026-05-09 prod QA walk). Old `@2` cache rows
// hold pre-dedup `rows` arrays and lack the new
// `dedupedConvertedReads` counter; bumping forces a recompute on
// next access. `withArtifactCache` rolls forward by the version
// suffix in the cache key.
export const PERFORMANCE_RATIO_RUNNER_VERSION =
  "phase-5d-pr1-performance-ratio@3";

function computePerformanceRatioInputHash(
  batchIds: PerformanceRatioInputBatchIds
): string {
  return createHash("sha256")
    .update(
      [
        `convertedReads:${batchIds.convertedReadsBatchId ?? ""}`,
        `annualProductionEstimates:${batchIds.annualProductionBatchId ?? ""}`,
        `generationEntry:${batchIds.generationEntryBatchId ?? ""}`,
        `accountSolarGeneration:${batchIds.accountSolarGenerationBatchId ?? ""}`,
        `generatorDetails:${batchIds.generatorDetailsBatchId ?? ""}`,
        `abpReport:${batchIds.abpReportBatchId ?? ""}`,
        `solarApplications:${batchIds.solarApplicationsBatchId ?? ""}`,
        `runner:${PERFORMANCE_RATIO_RUNNER_VERSION}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Public entrypoint for the Performance Ratio tab's tRPC query.
 * Returns the same `PerformanceRatioAggregates` shape that the
 * client tab's existing `performanceRatioResult` useMemo
 * produces, plus a `fromCache` flag for telemetry.
 *
 * Empty-state semantics:
 *   - No `convertedReads` active batch → empty result (no work to do).
 *   - All other deps absent are tolerated; the underlying loader
 *     supplies empty arrays + maps and the aggregator produces
 *     consistent counts (e.g. all reads invalid because no
 *     systems matched).
 */
export async function getOrBuildPerformanceRatio(
  scopeId: string
): Promise<PerformanceRatioAggregates & { fromCache: boolean }> {
  const batchIds = await resolvePerformanceRatioBatchIds(scopeId);

  if (!batchIds.convertedReadsBatchId) {
    return {
      rows: [],
      convertedReadCount: 0,
      matchedConvertedReads: 0,
      unmatchedConvertedReads: 0,
      invalidConvertedReads: 0,
      dedupedConvertedReads: 0,
      fromCache: false,
    };
  }

  const inputVersionHash = computePerformanceRatioInputHash(batchIds);

  const { result, fromCache } = await withArtifactCache<
    PerformanceRatioAggregates
  >({
    scopeId,
    artifactType: PERFORMANCE_RATIO_ARTIFACT_TYPE,
    inputVersionHash,
    serde: superjsonSerde<PerformanceRatioAggregates>(),
    rowCount: (data) => data.rows.length,
    recompute: async () => {
      const input = await loadPerformanceRatioStaticInput(scopeId, batchIds);
      const accumulator = createPerformanceRatioAccumulator(input);
      await forEachPerformanceRatioConvertedReadPage(
        scopeId,
        batchIds.convertedReadsBatchId,
        (rows, startIndex) => {
          accumulator.processRows(rows, startIndex);
        }
      );
      return accumulator.toAggregates();
    },
  });

  return { ...result, fromCache };
}
