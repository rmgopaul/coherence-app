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
  parsePart2VerificationDate,
  type CsvRow,
} from "./aggregatorHelpers";
import {
  loadDatasetRows,
  loadDatasetRowsPage,
  getOrBuildSystemSnapshot,
} from "./buildSystemSnapshot";
import {
  buildAnnualProductionByTrackingId as sharedBuildAnnualProductionByTrackingId,
  buildGenerationBaselineByTrackingId as sharedBuildGenerationBaselineByTrackingId,
  buildGeneratorDateOnlineByTrackingId as sharedBuildGeneratorDateOnlineByTrackingId,
  clean,
  normalizeMonitoringMatch,
  normalizeSystemIdMatch,
  normalizeSystemNameMatch,
  parseDate,
  parseEnergyToWh,
  resolveLastMeterReadRawValue,
  type AnnualProductionProfile,
  type GenerationBaseline,
  type PerformanceRatioConvertedReadRow,
  type PerformanceRatioInput,
  type PerformanceRatioInputSystem,
  type SolarRecCsvRow,
} from "@shared/solarRecPerformanceRatio";

// ---------------------------------------------------------------------------
// Salvage PR A (2026-04-29) — `buildAnnualProductionByTrackingId`,
// `buildGenerationBaselineByTrackingId`,
// `buildGeneratorDateOnlineByTrackingId`, the `MONTH_HEADERS` /
// `GENERATION_BASELINE_*_HEADERS` constants, the
// `resolveLastMeterReadRawValue` helper, and the
// `ServerAnnualProductionProfile` / `ServerGenerationBaseline` types
// were all hoisted to `@shared/solarRecPerformanceRatio.ts` (and
// renamed back to the canonical `AnnualProductionProfile` /
// `GenerationBaseline` to drop the per-side prefix).
//
// Re-exporting the 3 builders under their original names keeps
// `buildForecastAggregates.ts` (the only other server caller) on
// its existing import path. A follow-up can drop the re-exports
// once Forecast switches to the shared imports directly.
// ---------------------------------------------------------------------------

/** @deprecated import directly from `@shared/solarRecPerformanceRatio`. */
export const buildAnnualProductionByTrackingId =
  sharedBuildAnnualProductionByTrackingId;
/** @deprecated import directly from `@shared/solarRecPerformanceRatio`. */
export const buildGenerationBaselineByTrackingId =
  sharedBuildGenerationBaselineByTrackingId;
/** @deprecated import directly from `@shared/solarRecPerformanceRatio`. */
export const buildGeneratorDateOnlineByTrackingId =
  sharedBuildGeneratorDateOnlineByTrackingId;

/**
 * Back-compat type aliases. Some callers still write
 * `ServerAnnualProductionProfile` / `ServerGenerationBaseline`; map
 * them to the shared canonical names so a follow-up can rename
 * call sites without breaking the type-check in this PR.
 */
export type ServerAnnualProductionProfile = AnnualProductionProfile;
export type ServerGenerationBaseline = GenerationBaseline;

/**
 * Streaming dataset-page walk. Mirrors
 * `forEachPerformanceRatioConvertedReadPage` (further down this
 * file) but parameterized over any `srDs*` table — used by the
 * 2026-05-08 OOM fix to incrementally fold heavy datasets
 * (`srDsAccountSolarGeneration`, 17M+ rows) into a result Map
 * page-by-page instead of materializing the full row set in
 * memory.
 *
 * Cursor-paginated via `loadDatasetRowsPage` (already proven on
 * convertedReads). Default page size matches
 * `PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE` so the per-page
 * memory budget is uniform across the build step.
 */
async function streamSrDsRowsPage(
  scopeId: string,
  batchId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any,
  onPage: (rows: CsvRow[]) => void | Promise<void>,
  options: { pageSize?: number } = {}
): Promise<number> {
  const pageSize = options.pageSize ?? STREAM_PAGE_SIZE_DEFAULT;
  let cursor: string | null = null;
  let totalRows = 0;
  let pageCount = 0;
  for (;;) {
    const page = await loadDatasetRowsPage(scopeId, batchId, table, {
      cursor,
      limit: pageSize,
    });
    if (page.rows.length > 0) {
      await onPage(page.rows);
    }
    totalRows += page.rows.length;
    pageCount += 1;
    if (pageCount === 1 || pageCount % 10 === 0 || !page.nextCursor) {
      process.stdout.write(
        `[loadPerformanceRatioInput] streamed page=${pageCount} ` +
          `totalRows=${totalRows} ` +
          `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
      );
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return totalRows;
}

// 2026-05-08 step-4 hardening — was 5_000. Cut to 2_500 because the
// previous value still produced a per-page allocation peak high enough
// to OOM the worker mid-stream on prod-shape data (build
// `bld-18271f3b…` died at pr=178,821 with the heartbeat frozen for
// 4+ minutes — process death, not a soft timeout). Halving the page
// size halves the transient `pageRows` footprint and the matched-row
// buffer between drains, which is the biggest dial we have without
// restructuring the aggregator.
const STREAM_PAGE_SIZE_DEFAULT = 2_500;

/**
 * Per-row accumulator for `srDsAccountSolarGeneration` pages.
 * Mirrors the accountSolarGeneration branch of
 * `buildGenerationBaselineByTrackingId` (in
 * `@shared/solarRecPerformanceRatio.ts`) 1:1 — same field
 * resolution, same merge rule (latest date wins; on ties,
 * "Generation Entry" outranks "Account Solar Generation").
 *
 * Mutates `mapping` in place. Returns nothing — the caller owns
 * the Map across pages.
 *
 * Exported so the parity test
 * (`loadPerformanceRatioInput.streamingBaseline.test.ts`) can
 * verify that calling this incrementally over chunked pages
 * produces a Map equal to the bulk
 * `buildGenerationBaselineByTrackingId([], allRows)` output.
 */
export function applyAccountSolarGenerationPageToBaselineMap(
  mapping: Map<string, GenerationBaseline>,
  page: CsvRow[]
): void {
  for (const row of page) {
    const trackingSystemRefId = clean((row as SolarRecCsvRow)["GATS Gen ID"]);
    if (!trackingSystemRefId) continue;
    const valueWh = parseEnergyToWh(
      resolveLastMeterReadRawValue(row as SolarRecCsvRow),
      "Last Meter Read (kWh)",
      "kwh"
    );
    if (valueWh === null) continue;
    const date =
      parseDate((row as SolarRecCsvRow)["Last Meter Read Date"]) ??
      parseDate((row as SolarRecCsvRow)["Month of Generation"]);

    const candidate: GenerationBaseline = {
      valueWh,
      date,
      source: "Account Solar Generation",
    };
    const existing = mapping.get(trackingSystemRefId);
    if (!existing) {
      mapping.set(trackingSystemRefId, candidate);
      continue;
    }
    const existingTime =
      existing.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime =
      candidate.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (candidateTime > existingTime) {
      mapping.set(trackingSystemRefId, candidate);
      continue;
    }
    if (candidateTime === existingTime) {
      const existingRank = existing.source === "Generation Entry" ? 2 : 1;
      const candidateRank = candidate.source === "Generation Entry" ? 2 : 1;
      if (candidateRank > existingRank) {
        mapping.set(trackingSystemRefId, candidate);
      }
    }
  }
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
// ABP Report → application-id-keyed maps. Mirrors the parent-level
// `abpAcSizeKwByApplicationId` + `abpPart2VerificationDateByApplicationId`
// memos in SolarRecDashboard.tsx.
// ---------------------------------------------------------------------------

function buildAbpAcSizeKwByApplicationId(
  abpRows: CsvRow[]
): Map<string, number> {
  const mapping = new Map<string, number>();
  applyAbpReportPageToAcSizeKwMap(mapping, abpRows);
  return mapping;
}

/**
 * 2026-05-08 OOM hardening — per-page accumulator for
 * `srDsAbpReport` pages. Mirrors `buildAbpAcSizeKwByApplicationId`'s
 * per-row logic (first-non-null wins per applicationId) but
 * mutates an externally-owned Map so the caller can stream
 * pages and keep peak memory bounded.
 *
 * Exported for the streaming-parity test
 * (`loadPerformanceRatioInput.streamingAbpReport.test.ts`).
 */
export function applyAbpReportPageToAcSizeKwMap(
  mapping: Map<string, number>,
  page: CsvRow[]
): void {
  for (const row of page) {
    const applicationId =
      clean(row.Application_ID) || clean(row.application_id);
    if (!applicationId) continue;
    const ac = parseAbpAcSizeKw(row);
    if (ac === null || !Number.isFinite(ac)) continue;
    if (!mapping.has(applicationId)) mapping.set(applicationId, ac);
  }
}

function buildAbpPart2VerificationDateByApplicationId(
  abpRows: CsvRow[]
): Map<string, Date> {
  const mapping = new Map<string, Date>();
  applyAbpReportPageToPart2VerificationDateMap(mapping, abpRows);
  return mapping;
}

/**
 * 2026-05-08 OOM hardening — per-page accumulator. Mirrors
 * `buildAbpPart2VerificationDateByApplicationId`'s per-row logic
 * (latest-date wins per applicationId) but mutates an externally-
 * owned Map.
 */
export function applyAbpReportPageToPart2VerificationDateMap(
  mapping: Map<string, Date>,
  page: CsvRow[]
): void {
  for (const row of page) {
    const applicationId =
      clean(row.Application_ID) || clean(row.application_id);
    if (!applicationId) continue;
    const date =
      parsePart2VerificationDate(
        row.Part_2_App_Verification_Date ?? row.part_2_app_verification_date
      ) ?? null;
    if (!date) continue;
    const existing = mapping.get(applicationId);
    if (!existing || date > existing) mapping.set(applicationId, date);
  }
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
  applySolarApplicationsPageToMonitoringDetailsMap(
    mapping,
    solarApplicationsRows
  );
  return mapping;
}

/**
 * 2026-05-08 OOM hardening — per-page accumulator for
 * `srDsSolarApplications`. Mirrors
 * `buildMonitoringDetailsBySystemKey`'s per-row logic
 * (first-non-empty merge per (id|tracking|name) key) but mutates
 * an externally-owned Map.
 */
export function applySolarApplicationsPageToMonitoringDetailsMap(
  mapping: Map<string, MonitoringDetailsRecord>,
  page: CsvRow[]
): void {
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

  for (const row of page) {
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
  // Whether the system has a Part 2 verification date on its
  // SystemRecord. Used in lieu of the original client-side
  // `part2EligibleSystemsForSizeReporting` filter (which built 3
  // ID sets from `part2VerifiedAbpRows`); the snapshot's
  // `part2VerificationDate` field is the closest pre-computed
  // proxy and is set whenever a matching solarApplications or
  // abpReport row carries a parsed Part_2_App_Verification_Date.
  part2HasVerification: boolean;
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
      // Snapshot cache uses plain JSON (not superjson), so Date
      // fields round-trip as ISO strings on cache hits and as
      // Date instances on fresh builds — accept either.
      part2HasVerification:
        r.part2VerificationDate instanceof Date ||
        (typeof r.part2VerificationDate === "string" &&
          r.part2VerificationDate.length > 0),
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

export type PerformanceRatioStaticInput = Omit<
  PerformanceRatioInput,
  "convertedReadsRows"
>;

// 2026-05-08 step-4 hardening — was 5_000. See STREAM_PAGE_SIZE_DEFAULT
// above for the failure mode this addresses. Each page allocates one
// projected `PerformanceRatioConvertedReadRow` array + one matched-
// rows buffer in the accumulator; halving the page caps both at half
// peak. The drain frequency doubles (smaller batches per upsert) but
// the upsert chunk size is independent of page size — the work just
// fits more pages between heartbeats, which is fine.
export const PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE = 2_500;

export function projectPerformanceRatioConvertedRead(
  row: CsvRow
): PerformanceRatioConvertedReadRow {
  return {
    monitoring: clean(row.monitoring),
    monitoring_system_id: clean(row.monitoring_system_id),
    monitoring_system_name: clean(row.monitoring_system_name),
    lifetime_meter_read_wh: clean(row.lifetime_meter_read_wh),
    read_date: clean(row.read_date),
  };
}

export async function loadPerformanceRatioStaticInput(
  scopeId: string,
  batchIds: PerformanceRatioInputBatchIds
): Promise<PerformanceRatioStaticInput> {
  process.stdout.write(
    `[loadPerformanceRatioInput] cache miss for scope=${scopeId} — static dataset loads beginning. ` +
      `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
  );

  // Phase 1: system snapshot (cached by getOrBuildSystemSnapshot).
  const snapshot = await getOrBuildSystemSnapshot(scopeId);

  // Phase 2: small-to-medium datasets, one at a time. Each map is
  // built immediately and the source array goes out of scope so V8
  // can reclaim it before the next load.

  let annualProductionRows = batchIds.annualProductionBatchId
    ? await loadDatasetRows(
        scopeId,
        batchIds.annualProductionBatchId,
        srDsAnnualProductionEstimates
      )
    : ([] as CsvRow[]);
  const annualProductionByTrackingId = buildAnnualProductionByTrackingId(
    annualProductionRows
  );
  // Help V8 by clearing the local reference. The aggregator only
  // needs the map.
  annualProductionRows = [];

  // 2026-05-08 OOM fix — `srDsAccountSolarGeneration` is the dataset
  // that OOMs the build worker on prod-shape data (17M+ rows × ~200
  // bytes/row × the JS-object overhead = multi-GB of heap). The
  // legacy `loadDatasetRows` materializes the full table at once,
  // which the V8 default heap (~1.4 GB) can't tolerate.
  //
  // Streaming fix: load the smaller `srDsGenerationEntry` (~100k
  // rows on prod) into a Map first, then stream
  // `srDsAccountSolarGeneration` page-by-page through the same
  // `updateBaseline` per-row reducer that the bulk
  // `buildGenerationBaselineByTrackingId` uses internally. Peak
  // memory becomes O(unique GATS Gen IDs in the Map) + one page
  // (~5k rows) instead of O(all 17M rows). The per-row logic
  // mirrors `buildGenerationBaselineByTrackingId`'s
  // accountSolarGeneration branch in `@shared/solarRecPerformanceRatio.ts`
  // 1:1 — same `clean / parseEnergyToWh / resolveLastMeterReadRawValue
  // / parseDate` calls, same source priority, same merge rule.
  let generationEntryRows = batchIds.generationEntryBatchId
    ? await loadDatasetRows(
        scopeId,
        batchIds.generationEntryBatchId,
        srDsGenerationEntry
      )
    : ([] as CsvRow[]);
  const generationBaselineByTrackingId = buildGenerationBaselineByTrackingId(
    generationEntryRows,
    [] // accountSolarGeneration applied incrementally below
  ) as Map<string, GenerationBaseline>;
  generationEntryRows = [];

  if (batchIds.accountSolarGenerationBatchId) {
    await streamSrDsRowsPage(
      scopeId,
      batchIds.accountSolarGenerationBatchId,
      srDsAccountSolarGeneration,
      (page) => {
        applyAccountSolarGenerationPageToBaselineMap(
          generationBaselineByTrackingId,
          page
        );
      }
    );
    process.stdout.write(
      `[loadPerformanceRatioInput] streamed accountSolarGeneration; ` +
        `baselineMapSize=${generationBaselineByTrackingId.size} ` +
        `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
    );
  }

  let generatorDetailsRows = batchIds.generatorDetailsBatchId
    ? await loadDatasetRows(
        scopeId,
        batchIds.generatorDetailsBatchId,
        srDsGeneratorDetails
      )
    : ([] as CsvRow[]);
  const generatorDateOnlineByTrackingId = buildGeneratorDateOnlineByTrackingId(
    generatorDetailsRows
  );
  generatorDetailsRows = [];

  // 2026-05-08 OOM fix follow-up — stream `srDsAbpReport` (243k
  // rows on prod) and `srDsSolarApplications` (273k rows on prod)
  // page-by-page. Each row carries `rawRow` JSON, so the bulk
  // `loadDatasetRows` peak was hundreds of MB per table; together
  // with the system snapshot + the other static maps it pushed
  // the build worker over V8's default heap ceiling. Streaming
  // bounds peak to one page (~5-10 MB) plus the resulting Maps,
  // which are dramatically smaller than the source rows.
  const abpAcSizeKwByApplicationId = new Map<string, number>();
  const abpPart2VerificationDateByApplicationId = new Map<string, Date>();
  if (batchIds.abpReportBatchId) {
    await streamSrDsRowsPage(
      scopeId,
      batchIds.abpReportBatchId,
      srDsAbpReport,
      (page) => {
        applyAbpReportPageToAcSizeKwMap(abpAcSizeKwByApplicationId, page);
        applyAbpReportPageToPart2VerificationDateMap(
          abpPart2VerificationDateByApplicationId,
          page
        );
      }
    );
    process.stdout.write(
      `[loadPerformanceRatioInput] streamed abpReport; ` +
        `acSizeKwMapSize=${abpAcSizeKwByApplicationId.size} ` +
        `part2DateMapSize=${abpPart2VerificationDateByApplicationId.size} ` +
        `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
    );
  }

  const monitoringDetailsBySystemKey = new Map<
    string,
    MonitoringDetailsRecord
  >();
  if (batchIds.solarApplicationsBatchId) {
    await streamSrDsRowsPage(
      scopeId,
      batchIds.solarApplicationsBatchId,
      srDsSolarApplications,
      (page) => {
        applySolarApplicationsPageToMonitoringDetailsMap(
          monitoringDetailsBySystemKey,
          page
        );
      }
    );
    process.stdout.write(
      `[loadPerformanceRatioInput] streamed solarApplications; ` +
        `monitoringDetailsMapSize=${monitoringDetailsBySystemKey.size} ` +
        `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
    );
  }

  // Tokenize systems. Filter to part-2-eligible-for-size-reporting
  // + has-trackingSystemRefId (matches the client's
  // `part2EligibleSystemsForSizeReporting` filter on
  // PerformanceRatioTab line ~266-267).
  const snapshotSystems = extractSnapshotSystemsForPerfRatio(snapshot.systems);
  const systems: PerformanceRatioInputSystem[] = snapshotSystems
    .filter(
      (s) => s.part2HasVerification && Boolean(s.trackingSystemRefId)
    )
    .map((s) =>
      tokenizeSystemForPerfRatio(
        s,
        getMonitoringDetailsForSystem(s, monitoringDetailsBySystemKey)
      )
    );

  process.stdout.write(
    `[loadPerformanceRatioInput] static datasets loaded; ` +
      `systems=${systems.length} ` +
      `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB. ` +
      `convertedReads will stream in pages next.\n`
  );

  // Note on the cast: the shared `PerformanceRatioGenerationBaseline`
  // declares `date: Date` (non-null), but our local
  // `GenerationBaseline` (and the matching client builder it mirrors)
  // allow `date: Date | null`. The aggregator is tolerant of nulls
  // at runtime via `baseline?.date ?? generatorDateOnline`, so the
  // wider type is safe to feed in. The cast goes through unknown
  // rather than fighting the structural-type widening — same pattern
  // used by `extractSnapshotSystems` in `aggregatorHelpers.ts`.
  return {
    systems,
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId,
    annualProductionByTrackingId,
    generationBaselineByTrackingId:
      generationBaselineByTrackingId as unknown as PerformanceRatioInput["generationBaselineByTrackingId"],
    generatorDateOnlineByTrackingId,
  };
}

export async function forEachPerformanceRatioConvertedReadPage(
  scopeId: string,
  batchId: string | null,
  onPage: (
    rows: PerformanceRatioConvertedReadRow[],
    startIndex: number
  ) => void | Promise<void>,
  options: { pageSize?: number } = {}
): Promise<number> {
  if (!batchId) return 0;

  const pageSize =
    options.pageSize ?? PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE;
  let cursor: string | null = null;
  let totalRows = 0;
  let pageCount = 0;

  for (;;) {
    const page = await loadDatasetRowsPage(
      scopeId,
      batchId,
      srDsConvertedReads,
      { cursor, limit: pageSize }
    );
    const projectedRows = page.rows.map(projectPerformanceRatioConvertedRead);
    if (projectedRows.length > 0) {
      await onPage(projectedRows, totalRows);
    }

    totalRows += projectedRows.length;
    pageCount += 1;

    if (pageCount === 1 || pageCount % 10 === 0 || !page.nextCursor) {
      process.stdout.write(
        `[loadPerformanceRatioInput] streamed convertedReads page=${pageCount} ` +
          `totalRows=${totalRows} ` +
          `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
      );
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return totalRows;
}

export async function loadPerformanceRatioInput(
  scopeId: string,
  batchIds: PerformanceRatioInputBatchIds
): Promise<PerformanceRatioInput> {
  const staticInput = await loadPerformanceRatioStaticInput(scopeId, batchIds);
  const convertedReadsRows: PerformanceRatioConvertedReadRow[] = [];
  await forEachPerformanceRatioConvertedReadPage(
    scopeId,
    batchIds.convertedReadsBatchId,
    (rows) => {
      convertedReadsRows.push(...rows);
    }
  );

  return {
    ...staticInput,
    convertedReadsRows,
  };
}
