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
  const {
    convertedReadsRows,
    systems,
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId,
    annualProductionByTrackingId,
    generationBaselineByTrackingId,
    generatorDateOnlineByTrackingId,
  } = input;

  if (convertedReadsRows.length === 0 || systems.length === 0) {
    return {
      rows: [],
      convertedReadCount: convertedReadsRows.length,
      matchedConvertedReads: 0,
      unmatchedConvertedReads: 0,
      invalidConvertedReads: 0,
    };
  }

  const indexes = buildMatchIndexes(systems);

  const rows: PerformanceRatioRow[] = [];
  let matchedConvertedReads = 0;
  let unmatchedConvertedReads = 0;
  let invalidConvertedReads = 0;

  for (let index = 0; index < convertedReadsRows.length; index += 1) {
    const row = convertedReadsRows[index]!;
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
    const readKey = `converted-${index}`;

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
          ? abpAcSizeKwByApplicationId.get(candidate.stateApplicationRefId) ??
            null
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
    convertedReadCount: convertedReadsRows.length,
    matchedConvertedReads,
    unmatchedConvertedReads,
    invalidConvertedReads,
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
  loadPerformanceRatioInput,
  resolvePerformanceRatioBatchIds,
  type PerformanceRatioInputBatchIds,
} from "./loadPerformanceRatioInput";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

const PERFORMANCE_RATIO_ARTIFACT_TYPE = "performanceRatio";

export const PERFORMANCE_RATIO_RUNNER_VERSION =
  "phase-5d-pr1-performance-ratio@1";

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
      const input = await loadPerformanceRatioInput(scopeId, batchIds);
      return buildPerformanceRatioAggregates(input);
    },
  });

  return { ...result, fromCache };
}
