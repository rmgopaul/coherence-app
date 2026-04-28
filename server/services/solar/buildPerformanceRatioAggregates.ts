/**
 * Server-side aggregator for the Performance Ratio tab.
 *
 * Companion plan PR 1 (2026-04-28). The Performance Ratio tab on
 * `/solar-rec/dashboard?tab=performance-ratio` was crashing on the
 * dashboard's largest scope — a 700k-row `convertedReads` dataset
 * blew past tab heap on first iteration even after the per-tab
 * memo merge (#217) and columnar-direct read (#222) shipped.
 *
 * This file ports the heavy client-side memo cascade into a single
 * pure aggregator function that operates on already-loaded row
 * arrays + lookup maps. The wrapper that builds those inputs and
 * caches the result via `withArtifactCache` lands in PR 3 so this
 * PR stays scoped to the pure function + test coverage.
 *
 * Inputs (all already row-backed; the wrapper that loads them is
 * standard `loadDatasetRows` against `srDs*` tables):
 *
 *   - `convertedReadsRows` — `srDsConvertedReads` rows. The hot
 *     loop iterates these row-by-row; the aggregator never builds
 *     an intermediate "normalized read" array (the source of the
 *     2× heap pressure the client fix in #217 already removed).
 *   - `systems` — `PerformanceRatioInputSystem[]` carrying every
 *     per-system field the row build needs. The wrapper produces
 *     this from the system snapshot + monitoring details, applying
 *     the same Part-2 eligibility filter the client applies in
 *     `part2EligibleSystemsForSizeReporting`.
 *   - 5 lookup maps (ABP AC kW, Part-2 verification date, annual
 *     production profile, GATS generation baseline, generator
 *     Date Online fallback) — all small, sub-100 KB each on prod.
 *
 * Output: `PerformanceRatioRow[]` matching the client's existing
 * `PerformanceRatioRow` shape one-for-one (same field names, same
 * derivation rules) so the eventual client refactor can drop in
 * the server response without changing presentation. Default sort
 * is the same triple-key order: readDate desc → ratio desc →
 * systemName asc.
 *
 * The pure function does no I/O — all loading + caching happens in
 * the eventual `getOrBuildPerformanceRatioAggregates` wrapper. The
 * tests file in this directory covers row count, match type
 * derivation, baseline resolution (GATS vs. generator-online
 * fallback), expected-production prorating, the sort order, and
 * the invalid/unmatched/matched counter triples.
 */

// `PerformanceRatioMatchType` is intentionally redefined here as a
// string literal union so this server file has no client import.
// The eventual wire type can `import type` from `state/types.ts`
// once the client refactor lands; keeping the dependency direction
// server → shared (not server → client) is canonical for the
// Task 5.13/5.14 aggregator templates.
export type PerformanceRatioMatchType =
  | "Monitoring + System ID + System Name"
  | "Monitoring + System ID"
  | "Monitoring + System Name";

/**
 * Per-system input record. The wrapper builds this from the
 * system snapshot's `systems[]` (filtered to Part-2-verified) plus
 * the monitoring details lookup keyed off the system. Token arrays
 * pre-extract the candidate keys for the index build below — the
 * client side does this in `portalMonitoringCandidates`; the
 * wrapper will mirror that logic byte-for-byte before calling the
 * pure aggregator.
 */
export type PerformanceRatioInputSystem = {
  key: string;
  trackingSystemRefId: string | null;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  installedKwAc: number | null;
  /** Resolved via `resolveContractValueAmount` on the client; same value. */
  contractValue: number;
  /** Pre-tokenized normalized monitoring identifiers (1-3 entries typical). */
  monitoringTokens: string[];
  /** Pre-tokenized normalized system IDs (1-3 entries). */
  idTokens: string[];
  /** Pre-tokenized normalized system names (1-3 entries). */
  nameTokens: string[];
};

/**
 * Annual production profile (12 monthly kWh values) used to
 * compute expected energy for any (baselineDate, readDate) range.
 * Mirrors the client-side `AnnualProductionProfile` type so the
 * wrapper can populate it from `srDsAnnualProductionEstimates`.
 */
export type PerformanceRatioAnnualProductionProfile = {
  monthlyKwh: number[];
};

/**
 * Generation baseline derived from `srDsAccountSolarGeneration` /
 * `srDsGenerationEntry` for a tracking ID. The client pre-builds
 * this map; the wrapper will mirror that build. Falls back to
 * generator Date Online when missing.
 */
export type PerformanceRatioGenerationBaseline = {
  date: Date;
  valueWh: number;
  source: string;
};

export type PerformanceRatioRow = {
  key: string;
  convertedReadKey: string;
  matchType: PerformanceRatioMatchType;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  readDate: Date | null;
  readDateRaw: string;
  lifetimeReadWh: number;
  trackingSystemRefId: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  portalAcSizeKw: number | null;
  abpAcSizeKw: number | null;
  part2VerificationDate: Date | null;
  baselineReadWh: number | null;
  baselineDate: Date | null;
  baselineSource: string | null;
  productionDeltaWh: number | null;
  expectedProductionWh: number | null;
  performanceRatioPercent: number | null;
  contractValue: number;
};

export type PerformanceRatioAggregates = {
  rows: PerformanceRatioRow[];
  convertedReadCount: number;
  matchedConvertedReads: number;
  unmatchedConvertedReads: number;
  invalidConvertedReads: number;
};

export type PerformanceRatioConvertedReadRow = {
  monitoring: string;
  monitoring_system_id: string;
  monitoring_system_name: string;
  lifetime_meter_read_wh: string;
  read_date: string;
};

export type PerformanceRatioInput = {
  convertedReadsRows: readonly PerformanceRatioConvertedReadRow[];
  systems: readonly PerformanceRatioInputSystem[];
  abpAcSizeKwByApplicationId: ReadonlyMap<string, number>;
  abpPart2VerificationDateByApplicationId: ReadonlyMap<string, Date>;
  annualProductionByTrackingId: ReadonlyMap<
    string,
    PerformanceRatioAnnualProductionProfile
  >;
  generationBaselineByTrackingId: ReadonlyMap<
    string,
    PerformanceRatioGenerationBaseline
  >;
  generatorDateOnlineByTrackingId: ReadonlyMap<string, Date>;
};

const EMPTY_AGGREGATES: PerformanceRatioAggregates = Object.freeze({
  rows: [] as PerformanceRatioRow[],
  convertedReadCount: 0,
  matchedConvertedReads: 0,
  unmatchedConvertedReads: 0,
  invalidConvertedReads: 0,
}) as PerformanceRatioAggregates;

// ---------------------------------------------------------------------------
// Local pure helpers — duplicates of `client/src/solar-rec-dashboard/lib/helpers`
// kept inline so this server file has zero client imports. Bodies are
// byte-for-byte mirrors of the client versions; divergence detector
// is the test file's parity assertions.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeMonitoringMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeSystemIdMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_\-/.]+/g, "")
    .trim();
}

function normalizeSystemNameMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function parseEnergyToWh(
  raw: string | undefined,
  _fieldName: string,
  _unitHint: "wh" | "kwh"
): number | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function calculateExpectedWhForRange(
  monthlyKwh: number[],
  startDate: Date | null,
  endDate: Date | null
): number | null {
  if (!Array.isArray(monthlyKwh) || monthlyKwh.length !== 12) return null;
  if (!startDate || !endDate) return null;
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;

  let totalWh = 0;
  let cursorYear = startDate.getUTCFullYear();
  let cursorMonth = startDate.getUTCMonth();

  while (true) {
    const monthStart = Date.UTC(cursorYear, cursorMonth, 1);
    const monthEnd = Date.UTC(cursorYear, cursorMonth + 1, 1);
    if (monthStart >= endMs) break;

    const segmentStart = Math.max(monthStart, startMs);
    const segmentEnd = Math.min(monthEnd, endMs);
    if (segmentEnd <= segmentStart) {
      cursorMonth += 1;
      if (cursorMonth > 11) {
        cursorMonth = 0;
        cursorYear += 1;
      }
      continue;
    }

    const dayCount = (segmentEnd - segmentStart) / DAY_MS;
    const daysInMonth = (monthEnd - monthStart) / DAY_MS;
    const monthKwh = monthlyKwh[cursorMonth] ?? 0;
    if (daysInMonth > 0) {
      totalWh += (monthKwh * 1000 * dayCount) / daysInMonth;
    }

    cursorMonth += 1;
    if (cursorMonth > 11) {
      cursorMonth = 0;
      cursorYear += 1;
    }
  }

  if (!Number.isFinite(totalWh)) return null;
  return totalWh;
}

// ---------------------------------------------------------------------------
// Index build — three Maps that the hot loop queries per converted-read row
// to skip the O(reads × systems) cross-join. Identical to the client's
// `performanceRatioMatchIndexes`.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure aggregator
// ---------------------------------------------------------------------------

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
    // Mirror the client's empty-state — early bail keeps the index
    // build off the hot path when either side has no data yet.
    return { ...EMPTY_AGGREGATES, convertedReadCount: convertedReadsRows.length };
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

    if (
      (!bothMatches || bothMatches.size === 0) &&
      (!idMatches || idMatches.size === 0) &&
      (!nameMatches || nameMatches.size === 0)
    ) {
      unmatchedConvertedReads += 1;
      continue;
    }

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
        key: `${readKey}-${candidateKey}-${rows.length + 1}`,
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
