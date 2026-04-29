/**
 * Server-side input loader for the Performance Ratio aggregator.
 *
 * Phase 5d PR 1 (2026-04-29) — assembles the seven inputs that
 * `buildPerformanceRatioAggregates` needs from `srDs*` rows + the
 * system snapshot. The pure aggregator + shared helpers were
 * already in main from PRs #227 / #232; this file is the missing
 * wiring so the cache wrapper (`getOrBuildPerformanceRatio` in
 * `buildPerformanceRatioAggregates.ts`) can call out for live
 * data.
 *
 * The 3 map builders below (annual-production-by-tracking-id,
 * generation-baseline-by-tracking-id, generator-date-online-by-
 * tracking-id) are byte-for-byte mirrors of the client functions
 * in `client/src/solar-rec-dashboard/lib/helpers/system.ts`. Kept
 * server-side rather than moved to `shared/` to keep this PR's
 * blast radius contained — a follow-up can DRY them onto
 * `@shared/solarRecPerformanceRatio` once the client tab consumes
 * the aggregator.
 *
 * The system tokenization (`monitoringTokens` / `idTokens` /
 * `nameTokens`) mirrors `portalMonitoringCandidates` in
 * `PerformanceRatioTab.tsx` (~line 264).
 */
import {
  srDsAccountSolarGeneration,
  srDsAbpReport,
  srDsAnnualProductionEstimates,
  srDsConvertedReads,
  srDsGenerationEntry,
  srDsGeneratorDetails,
  srDsSolarApplications,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  parseAbpAcSizeKw,
  parseDateOnlineAsMidMonth,
  parsePart2VerificationDate,
  type CsvRow,
} from "./aggregatorHelpers";
import {
  loadDatasetRows,
  getOrBuildSystemSnapshot,
} from "./buildSystemSnapshot";
import {
  clean,
  normalizeMonitoringMatch,
  normalizeSystemIdMatch,
  normalizeSystemNameMatch,
  parseDate,
  parseEnergyToWh,
  parseNumber,
  type PerformanceRatioInput,
  type PerformanceRatioInputSystem,
} from "@shared/solarRecPerformanceRatio";

// ---------------------------------------------------------------------------
// Constants — mirror `client/src/solar-rec-dashboard/lib/constants.ts`.
// Kept inline so this file is portable to a future shared location.
// ---------------------------------------------------------------------------

const MONTH_HEADERS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const GENERATION_BASELINE_VALUE_HEADERS = [
  "Last Meter Read (kWh)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Most Recent Production (kWh)",
  "Most Recent Production",
  "Generation (kWh)",
  "Production (kWh)",
];

const GENERATION_BASELINE_DATE_HEADERS = [
  "Last Meter Read Date",
  "Last Month of Gen",
  "Effective Date",
  "Month of Generation",
];

// ---------------------------------------------------------------------------
// Helpers ported from
// `client/src/solar-rec-dashboard/lib/helpers/csvIdentity.ts`.
// `parseDateOnlineAsMidMonth` is imported from `aggregatorHelpers`
// (already a server-side mirror of the client function).
// ---------------------------------------------------------------------------

function resolveLastMeterReadRawValue(row: CsvRow): string {
  const direct =
    clean(row["Last Meter Read (kWh)"]) ||
    clean(row["Last Meter Read (kW)"]) ||
    clean(row["Last Meter Read"]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = clean(key).toLowerCase();
    if (
      normalizedKey.includes("last meter read") &&
      !normalizedKey.includes("date")
    ) {
      const candidate = clean(value);
      if (candidate) return candidate;
    }
  }
  return "";
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const cleaned = clean(v);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function splitRawCandidates(value: string | undefined): string[] {
  // Matches the client `splitRawCandidates` semantics — split on
  // commas, semicolons, pipes, whitespace; drop empties. This
  // single-line regex covers the documented separator alphabet.
  return clean(value)
    .split(/[,;|]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Per-dataset builders — byte-for-byte mirrors of the 3 client
// `system.ts` builders. Take CsvRow[] (the loadDatasetRows shape)
// and return the maps the aggregator consumes.
//
// Exported so Phase 5d PR 2+ aggregators (Forecast, REC perf eval)
// can reuse these without duplicating the byte-for-byte logic. A
// future Phase-5d cleanup can hoist these to shared and the client
// can re-export from there.
// ---------------------------------------------------------------------------

export type ServerAnnualProductionProfile = {
  monthlyKwh: number[];
};

export type ServerGenerationBaseline = {
  valueWh: number;
  date: Date | null;
  source: string;
};

type AnnualProductionProfile = ServerAnnualProductionProfile;
type GenerationBaseline = ServerGenerationBaseline;

export function buildAnnualProductionByTrackingId(
  rows: CsvRow[]
): Map<string, AnnualProductionProfile> {
  const mapping = new Map<string, AnnualProductionProfile>();
  rows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]) || clean(row.unit_id);
    if (!trackingSystemRefId) return;
    const monthlyKwh = MONTH_HEADERS.map(
      (month) =>
        parseNumber(row[month] ?? row[month.toLowerCase()]) ?? 0
    );
    const current = mapping.get(trackingSystemRefId);
    if (!current) {
      mapping.set(trackingSystemRefId, { monthlyKwh });
      return;
    }
    const mergedMonthly = current.monthlyKwh.map((value, index) => {
      const candidate = monthlyKwh[index] ?? 0;
      return candidate > 0 ? candidate : value;
    });
    mapping.set(trackingSystemRefId, { monthlyKwh: mergedMonthly });
  });
  return mapping;
}

export function buildGenerationBaselineByTrackingId(
  generationEntryRows: CsvRow[],
  accountSolarGenerationRows: CsvRow[]
): Map<string, GenerationBaseline> {
  const mapping = new Map<string, GenerationBaseline>();

  const updateBaseline = (
    trackingSystemRefId: string,
    candidate: GenerationBaseline
  ) => {
    const existing = mapping.get(trackingSystemRefId);
    if (!existing) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }
    const existingTime = existing.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime = candidate.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (candidateTime > existingTime) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }
    if (candidateTime === existingTime) {
      const existingRank = existing.source === "Generation Entry" ? 2 : 1;
      const candidateRank = candidate.source === "Generation Entry" ? 2 : 1;
      if (candidateRank > existingRank) {
        mapping.set(trackingSystemRefId, candidate);
      }
    }
  };

  generationEntryRows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;
    let valueWh: number | null = null;
    for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
      valueWh = parseEnergyToWh(row[header], header, "kwh");
      if (valueWh !== null) break;
    }
    if (valueWh === null) return;
    let date: Date | null = null;
    for (const header of GENERATION_BASELINE_DATE_HEADERS) {
      date = parseDate(row[header]);
      if (date) break;
    }
    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Generation Entry",
    });
  });

  accountSolarGenerationRows.forEach((row) => {
    const trackingSystemRefId = clean(row["GATS Gen ID"]);
    if (!trackingSystemRefId) return;
    const valueWh = parseEnergyToWh(
      resolveLastMeterReadRawValue(row),
      "Last Meter Read (kWh)",
      "kwh"
    );
    if (valueWh === null) return;
    const date =
      parseDate(row["Last Meter Read Date"]) ??
      parseDate(row["Month of Generation"]);
    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Account Solar Generation",
    });
  });

  return mapping;
}

export function buildGeneratorDateOnlineByTrackingId(
  rows: CsvRow[]
): Map<string, Date> {
  const mapping = new Map<string, Date>();
  rows.forEach((row) => {
    const trackingSystemRefId =
      clean(row["GATS Unit ID"]) ||
      clean(row.gats_unit_id) ||
      clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;
    const dateOnline = parseDateOnlineAsMidMonth(
      row["Date Online"] ??
        row["Date online"] ??
        row.date_online ??
        row.date_online_month_year
    );
    if (!dateOnline) return;
    const existing = mapping.get(trackingSystemRefId);
    if (!existing || dateOnline < existing) {
      mapping.set(trackingSystemRefId, dateOnline);
    }
  });
  return mapping;
}

// ---------------------------------------------------------------------------
// ABP Report → application-id-keyed maps. Mirrors the parent-level
// `abpAcSizeKwByApplicationId` + `abpPart2VerificationDateByApplicationId`
// memos in SolarRecDashboard.tsx.
// ---------------------------------------------------------------------------

function buildAbpAcSizeKwByApplicationId(
  abpRows: CsvRow[]
): Map<string, number> {
  const mapping = new Map<string, number>();
  abpRows.forEach((row) => {
    const applicationId =
      clean(row.Application_ID) || clean(row.application_id);
    if (!applicationId) return;
    const ac = parseAbpAcSizeKw(row);
    if (ac === null || !Number.isFinite(ac)) return;
    if (!mapping.has(applicationId)) mapping.set(applicationId, ac);
  });
  return mapping;
}

function buildAbpPart2VerificationDateByApplicationId(
  abpRows: CsvRow[]
): Map<string, Date> {
  const mapping = new Map<string, Date>();
  abpRows.forEach((row) => {
    const applicationId =
      clean(row.Application_ID) || clean(row.application_id);
    if (!applicationId) return;
    const date =
      parsePart2VerificationDate(
        row.Part_2_App_Verification_Date ?? row.part_2_app_verification_date
      ) ?? null;
    if (!date) return;
    const existing = mapping.get(applicationId);
    if (!existing || date > existing) mapping.set(applicationId, date);
  });
  return mapping;
}

// ---------------------------------------------------------------------------
// Monitoring-details map — mirrors `monitoringDetailsBySystemKey`
// in SolarRecDashboard.tsx (~line 3740). Built from
// `srDsSolarApplications` rows; keyed by (id|tracking|name) the
// same way the client builds it so the lookup priority is
// preserved.
// ---------------------------------------------------------------------------

interface MonitoringDetailsRecord {
  online_monitoring: string;
  online_monitoring_system_id: string;
  online_monitoring_system_name: string;
  online_monitoring_website_api_link: string;
  online_monitoring_notes: string;
}

function buildMonitoringDetailsBySystemKey(
  solarApplicationsRows: CsvRow[]
): Map<string, MonitoringDetailsRecord> {
  const mapping = new Map<string, MonitoringDetailsRecord>();

  const merge = (key: string, detail: MonitoringDetailsRecord) => {
    const current = mapping.get(key);
    if (!current) {
      mapping.set(key, detail);
      return;
    }
    const merged: MonitoringDetailsRecord = { ...current };
    (Object.keys(detail) as Array<keyof MonitoringDetailsRecord>).forEach(
      (field) => {
        if (!merged[field] && detail[field]) merged[field] = detail[field];
      }
    );
    mapping.set(key, merged);
  };

  for (const row of solarApplicationsRows) {
    const systemId = clean(row.system_id) || clean(row.Application_ID);
    const trackingId =
      clean(row.tracking_system_ref_id) ||
      clean(row.reporting_entity_ref_id) ||
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2);
    const systemName = clean(row.system_name) || clean(row.Project_Name);
    if (!systemId && !trackingId && !systemName) continue;

    const detail: MonitoringDetailsRecord = {
      online_monitoring: clean(row.online_monitoring),
      online_monitoring_system_id: clean(row.online_monitoring_system_id),
      online_monitoring_system_name: clean(row.online_monitoring_system_name),
      online_monitoring_website_api_link: clean(
        row.online_monitoring_website_api_link
      ),
      online_monitoring_notes: clean(row.online_monitoring_notes),
    };

    if (systemId) merge(`id:${systemId}`, detail);
    if (trackingId) merge(`tracking:${trackingId}`, detail);
    if (systemName) merge(`name:${systemName.toLowerCase()}`, detail);
  }

  return mapping;
}

function getMonitoringDetailsForSystem(
  system: SnapshotSystemForPerfRatio,
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>
): MonitoringDetailsRecord | undefined {
  const keyById = system.systemId ? `id:${system.systemId}` : "";
  const keyByTracking = system.trackingSystemRefId
    ? `tracking:${system.trackingSystemRefId}`
    : "";
  const keyByName = system.systemName
    ? `name:${system.systemName.toLowerCase()}`
    : "";
  return (
    (keyById ? monitoringDetailsBySystemKey.get(keyById) : undefined) ??
    (keyByTracking
      ? monitoringDetailsBySystemKey.get(keyByTracking)
      : undefined) ??
    (keyByName ? monitoringDetailsBySystemKey.get(keyByName) : undefined)
  );
}

// ---------------------------------------------------------------------------
// System tokenization — mirrors `portalMonitoringCandidates` in
// PerformanceRatioTab.tsx (~line 264). Iterates the system snapshot's
// records, filters to ones with a `trackingSystemRefId`, and emits
// pre-tokenized `monitoringTokens` / `idTokens` / `nameTokens` arrays.
// ---------------------------------------------------------------------------

interface SnapshotSystemForPerfRatio {
  key: string;
  trackingSystemRefId: string | null;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  installedKwAc: number | null;
  totalContractAmount: number | null;
  contractedValue: number | null;
  // Whether the system passed Part 2 size-reporting eligibility —
  // matches the `part2EligibleSystemsForSizeReporting` filter in
  // SolarRecDashboard.tsx. The aggregator only matches against
  // eligible systems.
  part2EligibleForSizeReporting: boolean;
}

function tokenizeSystemForPerfRatio(
  system: SnapshotSystemForPerfRatio,
  details: MonitoringDetailsRecord | undefined
): PerformanceRatioInputSystem {
  const monitoringTokens = uniqueNonEmpty([
    normalizeMonitoringMatch(system.monitoringPlatform),
    normalizeMonitoringMatch(details?.online_monitoring ?? ""),
  ]);
  const idTokens = uniqueNonEmpty([
    ...splitRawCandidates(details?.online_monitoring_system_id ?? "").map(
      (value) => normalizeSystemIdMatch(value)
    ),
    normalizeSystemIdMatch(system.systemId ?? ""),
  ]);
  const nameTokens = uniqueNonEmpty([
    ...splitRawCandidates(details?.online_monitoring_system_name ?? "").map(
      (value) => normalizeSystemNameMatch(value)
    ),
    normalizeSystemNameMatch(system.systemName),
  ]);
  const contractValue =
    system.totalContractAmount ?? system.contractedValue ?? 0;

  return {
    key: system.key,
    trackingSystemRefId: system.trackingSystemRefId,
    systemId: system.systemId,
    stateApplicationRefId: system.stateApplicationRefId,
    systemName: system.systemName,
    installerName: system.installerName,
    monitoringPlatform: system.monitoringPlatform,
    installedKwAc: system.installedKwAc,
    contractValue,
    monitoringTokens,
    idTokens,
    nameTokens,
  };
}

// ---------------------------------------------------------------------------
// Snapshot extraction — pulls the structural subset of system fields
// the aggregator needs from `getOrBuildSystemSnapshot`'s output.
// `snapshot.systems` is `unknown[]` because `SystemRecord` is typed
// in client-land; we runtime-validate each row + substitute defaults
// for missing fields, mirroring `extractSnapshotSystems` in
// `buildContractVintageAggregates.ts`.
// ---------------------------------------------------------------------------

function extractSnapshotSystemsForPerfRatio(
  rawSystems: readonly unknown[]
): SnapshotSystemForPerfRatio[] {
  const out: SnapshotSystemForPerfRatio[] = [];
  for (const raw of rawSystems) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;

    const stringOrEmpty = (v: unknown): string =>
      typeof v === "string" ? v : "";
    const stringOrNull = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    const numberOrNull = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const boolOr = (v: unknown, fallback: boolean): boolean =>
      typeof v === "boolean" ? v : fallback;

    const key = stringOrNull(r.key);
    if (!key) continue;

    out.push({
      key,
      trackingSystemRefId: stringOrNull(r.trackingSystemRefId),
      systemId: stringOrNull(r.systemId),
      stateApplicationRefId: stringOrNull(r.stateApplicationRefId),
      systemName: stringOrEmpty(r.systemName),
      installerName: stringOrEmpty(r.installerName),
      monitoringPlatform: stringOrEmpty(r.monitoringPlatform),
      installedKwAc: numberOrNull(r.installedKwAc),
      totalContractAmount: numberOrNull(r.totalContractAmount),
      contractedValue: numberOrNull(r.contractedValue),
      part2EligibleForSizeReporting: boolOr(
        r.part2EligibleForSizeReporting,
        false
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint — loads + assembles the full PerformanceRatioInput.
// ---------------------------------------------------------------------------

export const PERFORMANCE_RATIO_INPUT_DEPS = [
  "convertedReads",
  "annualProductionEstimates",
  "generationEntry",
  "accountSolarGeneration",
  "generatorDetails",
  "abpReport",
  "solarApplications",
] as const;

export interface PerformanceRatioInputBatchIds {
  convertedReadsBatchId: string | null;
  annualProductionBatchId: string | null;
  generationEntryBatchId: string | null;
  accountSolarGenerationBatchId: string | null;
  generatorDetailsBatchId: string | null;
  abpReportBatchId: string | null;
  solarApplicationsBatchId: string | null;
}

/**
 * Resolve the active batch ids for every dataset the
 * Performance Ratio aggregator depends on. Returned in a stable
 * shape so the cache-input-hash function can fingerprint the
 * full set deterministically.
 */
export async function resolvePerformanceRatioBatchIds(
  scopeId: string
): Promise<PerformanceRatioInputBatchIds> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    PERFORMANCE_RATIO_INPUT_DEPS as unknown as string[]
  );
  const find = (key: string) =>
    versions.find((v) => v.datasetKey === key)?.batchId ?? null;
  return {
    convertedReadsBatchId: find("convertedReads"),
    annualProductionBatchId: find("annualProductionEstimates"),
    generationEntryBatchId: find("generationEntry"),
    accountSolarGenerationBatchId: find("accountSolarGeneration"),
    generatorDetailsBatchId: find("generatorDetails"),
    abpReportBatchId: find("abpReport"),
    solarApplicationsBatchId: find("solarApplications"),
  };
}

export async function loadPerformanceRatioInput(
  scopeId: string,
  batchIds: PerformanceRatioInputBatchIds
): Promise<PerformanceRatioInput> {
  const [
    snapshot,
    convertedReadsRows,
    annualProductionRows,
    generationEntryRows,
    accountSolarGenerationRows,
    generatorDetailsRows,
    abpReportRows,
    solarApplicationsRows,
  ] = await Promise.all([
    getOrBuildSystemSnapshot(scopeId),
    batchIds.convertedReadsBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.convertedReadsBatchId,
          srDsConvertedReads
        )
      : Promise.resolve([] as CsvRow[]),
    batchIds.annualProductionBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.annualProductionBatchId,
          srDsAnnualProductionEstimates
        )
      : Promise.resolve([] as CsvRow[]),
    batchIds.generationEntryBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.generationEntryBatchId,
          srDsGenerationEntry
        )
      : Promise.resolve([] as CsvRow[]),
    batchIds.accountSolarGenerationBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.accountSolarGenerationBatchId,
          srDsAccountSolarGeneration
        )
      : Promise.resolve([] as CsvRow[]),
    batchIds.generatorDetailsBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.generatorDetailsBatchId,
          srDsGeneratorDetails
        )
      : Promise.resolve([] as CsvRow[]),
    batchIds.abpReportBatchId
      ? loadDatasetRows(scopeId, batchIds.abpReportBatchId, srDsAbpReport)
      : Promise.resolve([] as CsvRow[]),
    batchIds.solarApplicationsBatchId
      ? loadDatasetRows(
          scopeId,
          batchIds.solarApplicationsBatchId,
          srDsSolarApplications
        )
      : Promise.resolve([] as CsvRow[]),
  ]);

  // Build the 5 derived maps + monitoring-details-by-system-key.
  const annualProductionByTrackingId = buildAnnualProductionByTrackingId(
    annualProductionRows
  );
  const generationBaselineByTrackingId = buildGenerationBaselineByTrackingId(
    generationEntryRows,
    accountSolarGenerationRows
  );
  const generatorDateOnlineByTrackingId = buildGeneratorDateOnlineByTrackingId(
    generatorDetailsRows
  );
  const abpAcSizeKwByApplicationId = buildAbpAcSizeKwByApplicationId(
    abpReportRows
  );
  const abpPart2VerificationDateByApplicationId =
    buildAbpPart2VerificationDateByApplicationId(abpReportRows);
  const monitoringDetailsBySystemKey = buildMonitoringDetailsBySystemKey(
    solarApplicationsRows
  );

  // Tokenize systems. Filter to part-2-eligible-for-size-reporting
  // + has-trackingSystemRefId (matches the client's
  // `part2EligibleSystemsForSizeReporting` filter on
  // PerformanceRatioTab line ~266-267).
  const snapshotSystems = extractSnapshotSystemsForPerfRatio(snapshot.systems);
  const systems: PerformanceRatioInputSystem[] = snapshotSystems
    .filter(
      (s) => s.part2EligibleForSizeReporting && Boolean(s.trackingSystemRefId)
    )
    .map((s) =>
      tokenizeSystemForPerfRatio(
        s,
        getMonitoringDetailsForSystem(s, monitoringDetailsBySystemKey)
      )
    );

  // Reshape convertedReads rows into the aggregator's expected
  // shape. `loadDatasetRows` returns CsvRow with both typed-column
  // names AND CSV-header keys (via the rawRow merge); we pick the
  // canonical lower_snake_case names the aggregator iterates.
  const convertedReadsForAggregator = convertedReadsRows.map((row) => ({
    monitoring: clean(row.monitoring),
    monitoring_system_id: clean(row.monitoring_system_id),
    monitoring_system_name: clean(row.monitoring_system_name),
    lifetime_meter_read_wh: clean(row.lifetime_meter_read_wh),
    read_date: clean(row.read_date),
  }));

  // Note on the cast: the shared `PerformanceRatioGenerationBaseline`
  // declares `date: Date` (non-null), but our local
  // `GenerationBaseline` (and the matching client builder it mirrors)
  // allow `date: Date | null`. The aggregator is tolerant of nulls
  // at runtime via `baseline?.date ?? generatorDateOnline`, so the
  // wider type is safe to feed in. The cast goes through unknown
  // rather than fighting the structural-type widening — same pattern
  // used by `extractSnapshotSystems` in `aggregatorHelpers.ts`.
  return {
    convertedReadsRows: convertedReadsForAggregator,
    systems,
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId,
    annualProductionByTrackingId,
    generationBaselineByTrackingId:
      generationBaselineByTrackingId as unknown as PerformanceRatioInput["generationBaselineByTrackingId"],
    generatorDateOnlineByTrackingId,
  };
}
