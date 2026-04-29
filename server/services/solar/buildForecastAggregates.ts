/**
 * Server-side aggregator for the Forecast tab.
 *
 * Phase 5d PR 2 (2026-04-29) — replaces the client
 * `forecastProjections` useMemo in
 * `client/src/solar-rec-dashboard/components/ForecastTab.tsx`.
 *
 * Output is small (~50 contract rows × 10 numeric fields ≈ 7.5 KB
 * uncompressed) so a plain JSON cache serde with superjson Date
 * round-trip would be overkill — the result has zero Date fields
 * once aggregated. Energy-year boundaries (May 1) participate in
 * the cache key so the cache invalidates automatically when the
 * server crosses the boundary; no clock-skew handling needed.
 *
 * Helpers (`buildRecReviewDeliveryYearLabel`,
 * `deriveRecPerformanceThreeYearValues`,
 * `buildScheduleYearEntries`) live in
 * `@shared/solarRecPerformanceRatio` (hoisted in Phase 5d Salvage
 * A, #271). The `buildPerformanceSourceRows` aggregator was
 * private here through PR #278; consolidated with the shared
 * `server/services/solar/buildPerformanceSourceRows.ts` module in
 * Phase 5e Followup #2 (2026-04-29).
 */

import { createHash } from "node:crypto";
import {
  srDsAbpReport,
  srDsAccountSolarGeneration,
  srDsAnnualProductionEstimates,
  srDsDeliverySchedule,
  srDsGenerationEntry,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  extractSnapshotSystems,
  type CsvRow,
  type SnapshotSystem,
} from "./aggregatorHelpers";
import {
  buildPart2EligibilityMaps,
} from "./buildContractVintageAggregates";
import { buildPerformanceSourceRows } from "./buildPerformanceSourceRows";
import {
  loadDatasetRows,
  getOrBuildSystemSnapshot,
} from "./buildSystemSnapshot";
import { buildTransferDeliveryLookupForScope } from "./buildTransferDeliveryLookup";
import {
  buildAnnualProductionByTrackingId,
  buildGenerationBaselineByTrackingId,
  type ServerAnnualProductionProfile,
  type ServerGenerationBaseline,
} from "./loadPerformanceRatioInput";
import {
  buildRecReviewDeliveryYearLabel,
  calculateExpectedWhForRange,
  deriveRecPerformanceThreeYearValues,
  type PerformanceSourceRow,
} from "@shared/solarRecPerformanceRatio";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

export interface ForecastContractRow {
  contract: string;
  systemsTotal: number;
  systemsReporting: number;
  requiredRecs: number;
  baselineRollingAvg: number;
  revisedRollingAvgReporting: number;
  revisedRollingAvgAll: number;
  delPercent: number | null;
  gapReporting: number;
  gapAll: number;
}

export interface ForecastAggregates {
  rows: ForecastContractRow[];
  /**
   * Echoed back in the response so the client can verify the
   * server's energy-year matches its own ambient session
   * computation. Diverges only across a May 1 boundary mid-session.
   */
  energyYearLabel: string;
}

// ---------------------------------------------------------------------------
// Energy-year computation — runs at request time so May 1 boundary
// crossings invalidate the cache automatically.
// ---------------------------------------------------------------------------

interface EnergyYearWindow {
  label: string; // "YYYY-YYYY+1"
  endDate: Date; // April 30 of EY end
  floorDate: Date; // June 1 of EY start - 1
}

function computeEnergyYearWindow(now: Date = new Date()): EnergyYearWindow {
  // Mirror of the FORECAST_NOW / FORECAST_EY_* constants at the top
  // of ForecastTab.tsx. Energy year runs May 1 – April 30. After
  // May (month >= 5 in 0-indexed UTC), the EY rolls forward.
  const startYear =
    now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  const endYear = startYear + 1;
  return {
    label: `${startYear}-${endYear}`,
    endDate: new Date(endYear, 3, 30), // April 30
    floorDate: new Date(startYear - 1, 5, 1), // June 1, two years before end
  };
}

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of `forecastProjections` in
// ForecastTab.tsx (~L200-330).
// ---------------------------------------------------------------------------

export interface ForecastAggregatorInput {
  performanceSourceRows: PerformanceSourceRow[];
  systems: SnapshotSystem[];
  annualProductionByTrackingId: ReadonlyMap<
    string,
    ServerAnnualProductionProfile
  >;
  generationBaselineByTrackingId: ReadonlyMap<
    string,
    ServerGenerationBaseline
  >;
  energyYear: EnergyYearWindow;
}

export function buildForecastAggregates(
  input: ForecastAggregatorInput
): ForecastContractRow[] {
  const {
    performanceSourceRows,
    systems,
    annualProductionByTrackingId,
    generationBaselineByTrackingId,
    energyYear,
  } = input;

  if (performanceSourceRows.length === 0) return [];

  const contractMap = new Map<
    string,
    {
      contract: string;
      systemsTotal: number;
      systemsReporting: number;
      requiredRecs: number;
      baselineRollingAvg: number;
      revisedRollingAvgReporting: number;
      revisedRollingAvgAll: number;
    }
  >();

  for (const sourceRow of performanceSourceRows) {
    const targetYearIndex = sourceRow.years.findIndex((year) => {
      const label = buildRecReviewDeliveryYearLabel(
        year.startDate,
        year.endDate,
        year.startRaw,
        year.endRaw
      );
      return label === energyYear.label;
    });
    const recWindow = deriveRecPerformanceThreeYearValues(
      sourceRow,
      targetYearIndex
    );
    if (!recWindow) continue;

    const dy1Val = recWindow.deliveryYearOne;
    const dy2Val = recWindow.deliveryYearTwo;
    const dy3Actual = recWindow.deliveryYearThree;
    const obligation = recWindow.expectedRecs;
    const baselineRollingAvg = recWindow.rollingAverage;

    const trackingId = sourceRow.trackingSystemRefId;
    const profile = annualProductionByTrackingId.get(trackingId);
    const baseline = generationBaselineByTrackingId.get(trackingId);
    const sys = systems.find((s) => s.trackingSystemRefId === trackingId);
    const isReporting = sys?.isReporting ?? false;

    let meterReadDate = baseline?.date ?? null;
    if (meterReadDate && meterReadDate < energyYear.floorDate) {
      meterReadDate = energyYear.floorDate;
    }

    let projectedRecsForSystem = 0;
    if (profile && meterReadDate) {
      const endDate = energyYear.endDate;
      if (meterReadDate < endDate) {
        const expectedWh = calculateExpectedWhForRange(
          profile.monthlyKwh,
          meterReadDate,
          endDate
        );
        if (expectedWh !== null && expectedWh > 0) {
          projectedRecsForSystem = Math.floor(expectedWh / 1000 / 1000);
        }
      }
    } else if (profile && !meterReadDate) {
      const expectedWh = calculateExpectedWhForRange(
        profile.monthlyKwh,
        energyYear.floorDate,
        energyYear.endDate
      );
      if (expectedWh !== null && expectedWh > 0) {
        projectedRecsForSystem = Math.floor(expectedWh / 1000 / 1000);
      }
    }

    const dy3RevisedReporting =
      isReporting && meterReadDate
        ? dy3Actual + projectedRecsForSystem
        : dy3Actual;
    const dy3RevisedAll = dy3Actual + projectedRecsForSystem;

    const revisedRollingAvgReporting = Math.floor(
      (dy1Val + dy2Val + dy3RevisedReporting) / 3
    );
    const revisedRollingAvgAll = Math.floor(
      (dy1Val + dy2Val + dy3RevisedAll) / 3
    );

    const contractId = sourceRow.contractId;
    const existing = contractMap.get(contractId) ?? {
      contract: contractId,
      systemsTotal: 0,
      systemsReporting: 0,
      requiredRecs: 0,
      baselineRollingAvg: 0,
      revisedRollingAvgReporting: 0,
      revisedRollingAvgAll: 0,
    };

    existing.systemsTotal++;
    if (isReporting) existing.systemsReporting++;
    existing.requiredRecs += obligation;
    existing.baselineRollingAvg += baselineRollingAvg;
    existing.revisedRollingAvgReporting += revisedRollingAvgReporting;
    existing.revisedRollingAvgAll += revisedRollingAvgAll;
    contractMap.set(contractId, existing);
  }

  return Array.from(contractMap.values())
    .map((c) => ({
      ...c,
      delPercent:
        c.requiredRecs > 0 ? (c.baselineRollingAvg / c.requiredRecs) * 100 : null,
      gapReporting: c.revisedRollingAvgReporting - c.requiredRecs,
      gapAll: c.revisedRollingAvgAll - c.requiredRecs,
    }))
    .sort((a, b) => a.gapReporting - b.gapReporting);
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const FORECAST_DEPS = [
  "deliveryScheduleBase",
  "annualProductionEstimates",
  "generationEntry",
  "accountSolarGeneration",
  "abpReport",
] as const;

const FORECAST_ARTIFACT_TYPE = "forecast";

export const FORECAST_RUNNER_VERSION = "phase-5d-pr2-forecast@3";
// 2026-04-29 (@3): consolidated this file's private
// `buildPerformanceSourceRows` with the shared module at
// `server/services/solar/buildPerformanceSourceRows.ts`. Output is
// identical post-#279, but the cache key bundles the runner version
// — bump for traceability.
// 2026-04-29 (@2): bumped after `getDeliveredForYear`
// case-sensitivity fix. The private `buildPerformanceSourceRows`
// inside this file silently returned 0 deliveries in prod
// (lookup keys lowercased, raw mixed-case trackingId passed).
// Cache invalidation forces recompute against the corrected
// helper.

interface ForecastBatchIds {
  deliveryScheduleBaseBatchId: string | null;
  annualProductionBatchId: string | null;
  generationEntryBatchId: string | null;
  accountSolarGenerationBatchId: string | null;
  abpReportBatchId: string | null;
}

async function resolveForecastBatchIds(
  scopeId: string
): Promise<ForecastBatchIds> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    FORECAST_DEPS as unknown as string[]
  );
  const find = (key: string) =>
    versions.find((v) => v.datasetKey === key)?.batchId ?? null;
  return {
    deliveryScheduleBaseBatchId: find("deliveryScheduleBase"),
    annualProductionBatchId: find("annualProductionEstimates"),
    generationEntryBatchId: find("generationEntry"),
    accountSolarGenerationBatchId: find("accountSolarGeneration"),
    abpReportBatchId: find("abpReport"),
  };
}

function computeForecastInputHash(
  batchIds: ForecastBatchIds,
  energyYearLabel: string
): string {
  return createHash("sha256")
    .update(
      [
        `deliveryScheduleBase:${batchIds.deliveryScheduleBaseBatchId ?? ""}`,
        `annualProductionEstimates:${batchIds.annualProductionBatchId ?? ""}`,
        `generationEntry:${batchIds.generationEntryBatchId ?? ""}`,
        `accountSolarGeneration:${batchIds.accountSolarGenerationBatchId ?? ""}`,
        `abpReport:${batchIds.abpReportBatchId ?? ""}`,
        `energyYear:${energyYearLabel}`,
        `runner:${FORECAST_RUNNER_VERSION}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Public entrypoint for the Forecast tab's tRPC query. Returns the
 * same `ForecastContractRow[]` that the client tab's
 * `forecastProjections` useMemo produces, plus the active
 * `energyYearLabel` (so the client can verify the server isn't
 * mid-boundary-crossing on May 1) and a `fromCache` flag.
 *
 * Empty-state semantics:
 *   - No `deliveryScheduleBase` active batch → empty result (no
 *     systems to forecast).
 *   - All other deps absent → tolerated; the underlying loader
 *     supplies empty arrays + maps and the aggregator produces
 *     consistent empty output.
 */
export async function getOrBuildForecastAggregates(scopeId: string): Promise<
  ForecastAggregates & { fromCache: boolean }
> {
  const batchIds = await resolveForecastBatchIds(scopeId);
  const energyYear = computeEnergyYearWindow();

  if (!batchIds.deliveryScheduleBaseBatchId) {
    return {
      rows: [],
      energyYearLabel: energyYear.label,
      fromCache: false,
    };
  }

  const inputVersionHash = computeForecastInputHash(batchIds, energyYear.label);

  const { result, fromCache } = await withArtifactCache<ForecastAggregates>({
    scopeId,
    artifactType: FORECAST_ARTIFACT_TYPE,
    inputVersionHash,
    serde: jsonSerde<ForecastAggregates>(),
    rowCount: (data) => data.rows.length,
    recompute: async () => {
      // 2026-04-29 OOM hotfix (PR 2.5) — load datasets sequentially
      // with explicit array-drop between phases. Same pattern as
      // `loadPerformanceRatioInput`: build each small lookup map
      // first, drop the source array, then load the next. Forecast
      // doesn't have a single huge table like convertedReads, but
      // sequential loading keeps peak memory predictable and
      // prevents the aggregator from racing the `getOrBuildSystem
      // Snapshot` cache miss on first compute.
      process.stdout.write(
        `[forecastAggregates] cache miss for scope=${scopeId} — sequential dataset loads beginning. ` +
          `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
      );

      const snapshot = await getOrBuildSystemSnapshot(scopeId);

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
      annualProductionRows = [];

      let generationEntryRows = batchIds.generationEntryBatchId
        ? await loadDatasetRows(
            scopeId,
            batchIds.generationEntryBatchId,
            srDsGenerationEntry
          )
        : ([] as CsvRow[]);
      let accountSolarGenerationRows = batchIds.accountSolarGenerationBatchId
        ? await loadDatasetRows(
            scopeId,
            batchIds.accountSolarGenerationBatchId,
            srDsAccountSolarGeneration
          )
        : ([] as CsvRow[]);
      const generationBaselineByTrackingId =
        buildGenerationBaselineByTrackingId(
          generationEntryRows,
          accountSolarGenerationRows
        );
      generationEntryRows = [];
      accountSolarGenerationRows = [];

      let abpReportRows = batchIds.abpReportBatchId
        ? await loadDatasetRows(
            scopeId,
            batchIds.abpReportBatchId,
            srDsAbpReport
          )
        : ([] as CsvRow[]);

      const transferDeliveryLookup =
        await buildTransferDeliveryLookupForScope(scopeId);

      const scheduleRows = await loadDatasetRows(
        scopeId,
        batchIds.deliveryScheduleBaseBatchId,
        srDsDeliverySchedule
      );

      process.stdout.write(
        `[forecastAggregates] all datasets loaded. ` +
          `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB. ` +
          `Aggregator running next.\n`
      );

      // `extractSnapshotSystems` produces the canonical
      // `SnapshotSystem` shape that both
      // `buildPart2EligibilityMaps` and the shared
      // `buildPerformanceSourceRows` consume. Reusing it (instead of
      // inlining a validator) keeps the contract-vintage / forecast
      // pipelines honoring the same field defaults.
      const systems = extractSnapshotSystems(snapshot.systems);
      const systemsByTrackingId = new Map<string, SnapshotSystem>();
      for (const sys of systems) {
        if (sys.trackingSystemRefId) {
          systemsByTrackingId.set(sys.trackingSystemRefId, sys);
        }
      }

      const part2Eligibility = buildPart2EligibilityMaps(
        abpReportRows,
        systems
      );
      // abpReportRows no longer needed; help V8 reclaim the array
      // before the (smaller) buildPerformanceSourceRows pass.
      abpReportRows = [];
      const eligibleTrackingIds = part2Eligibility.eligibleTrackingIds;

      const performanceSourceRows = buildPerformanceSourceRows({
        scheduleRows,
        eligibleTrackingIds,
        systemsByTrackingId,
        transferDeliveryLookup,
      });

      const rows = buildForecastAggregates({
        performanceSourceRows,
        systems,
        annualProductionByTrackingId,
        generationBaselineByTrackingId,
        energyYear,
      });

      return {
        rows,
        energyYearLabel: energyYear.label,
      };
    },
  });

  return { ...result, fromCache };
}
