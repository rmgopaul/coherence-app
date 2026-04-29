/**
 * Server-side `performanceSourceRows` aggregator. Mirrors the
 * client's parent useMemo at
 * `client/src/features/solar-rec/SolarRecDashboard.tsx :: performance
 * SourceRows` byte-for-byte (the matching logic was originally
 * extracted into `buildForecastAggregates.ts` as a private helper —
 * this file lifts it to a top-level export so a dedicated tRPC proc
 * can serve it to RecPerformanceEvaluationTab + Snapshot Log +
 * createLogEntry without those callers having to depend on the
 * Forecast aggregator's internals).
 *
 * 2026-04-29 — Phase 5d Salvage C (#273) noted this migration as
 * future work: once `performanceSourceRows` lives server-side, the
 * client `onApply` write in ScheduleBImport's auto-apply hybrid can
 * collapse to server-only and `existingDeliverySchedule` can come
 * from a new `getDashboardDeliverySchedule` query. This file is the
 * server side of that handoff; the client wiring + ScheduleBImport
 * follow-up are separate PRs.
 *
 * Output shape (`PerformanceSourceRow`) lives in
 * `@shared/solarRecPerformanceRatio` and matches the wire shape the
 * client tabs already consume. `years[i].delivered` is the
 * transfer-history-sourced value (NOT the Schedule B's
 * `quantity_delivered` column) — `transferHistory` is always the
 * source of truth for delivered RECs.
 *
 * Cache key bundles:
 *   - abpReport batch ID (drives Part-2 eligibility)
 *   - deliveryScheduleBase batch ID
 *   - transferHistory batch ID
 *   - system snapshot hash
 * Recompute cost is sub-second on prod-scale inputs.
 */

import { createHash } from "node:crypto";
import {
  srDsAbpReport,
  srDsDeliverySchedule,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  buildScheduleYearEntries,
  clean,
  type PerformanceSourceRow,
  type SolarRecCsvRow,
} from "@shared/solarRecPerformanceRatio";
import {
  type CsvRow,
  type SnapshotSystem,
  extractSnapshotSystems,
  getDeliveredForYear,
} from "./aggregatorHelpers";
import {
  buildPart2EligibilityMaps,
} from "./buildContractVintageAggregates";
import {
  computeSystemSnapshotHash,
  getOrBuildSystemSnapshot,
  loadDatasetRows,
} from "./buildSystemSnapshot";
import {
  buildTransferDeliveryLookupForScope,
  type TransferDeliveryLookupPayload,
} from "./buildTransferDeliveryLookup";
import { superjsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the parent useMemo. Extracted
// here so RecPerformanceEvaluationTab + Snapshot Log + createLogEntry
// can share with the Forecast aggregator. ForecastTab still calls
// this same function internally for its own pre-pass.
// ---------------------------------------------------------------------------

export interface BuildPerformanceSourceRowsInput {
  scheduleRows: CsvRow[];
  eligibleTrackingIds: ReadonlySet<string>;
  /**
   * Map<trackingSystemRefId, SnapshotSystem> — caller is responsible
   * for picking the canonical system per trackingId. The aggregator
   * reads `systemId`, `systemName`, and `recPrice` from each system.
   */
  systemsByTrackingId: ReadonlyMap<string, SnapshotSystem>;
  transferDeliveryLookup: TransferDeliveryLookupPayload;
}

export function buildPerformanceSourceRows(
  input: BuildPerformanceSourceRowsInput
): PerformanceSourceRow[] {
  const {
    scheduleRows,
    eligibleTrackingIds,
    systemsByTrackingId,
    transferDeliveryLookup,
  } = input;

  const out: PerformanceSourceRow[] = [];
  for (let rowIndex = 0; rowIndex < scheduleRows.length; rowIndex += 1) {
    const row = scheduleRows[rowIndex]!;
    const trackingSystemRefId = clean(row.tracking_system_ref_id);
    if (
      !trackingSystemRefId ||
      !eligibleTrackingIds.has(trackingSystemRefId)
    ) {
      continue;
    }
    const system = systemsByTrackingId.get(trackingSystemRefId);
    const years = buildScheduleYearEntries(row as SolarRecCsvRow);
    if (years.length === 0) continue;

    // The server's `transferDeliveryLookup.byTrackingId` is keyed by
    // LOWERCASED unitId (see buildTransferDeliveryLookup.ts:242), so
    // every consumer here must lowercase first. Mirrors the client
    // memo at `SolarRecDashboard.tsx :: performanceSourceRows`,
    // which did `transferDeliveryLookup.get(trackingSystemRefId
    // .toLowerCase())` for both the per-year delivered overlay AND
    // the firstTransferEnergyYear scan.
    const trackingIdLower = trackingSystemRefId.toLowerCase();
    const systemTransfersRecord =
      transferDeliveryLookup.byTrackingId[trackingIdLower] ?? null;

    let firstTransferEnergyYear: number | null = null as number | null;
    if (systemTransfersRecord) {
      for (const [yearStr, qty] of Object.entries(systemTransfersRecord)) {
        const ey = Number(yearStr);
        if (!Number.isFinite(ey)) continue;
        if (
          qty > 0 &&
          (firstTransferEnergyYear === null || ey < firstTransferEnergyYear)
        ) {
          firstTransferEnergyYear = ey;
        }
      }
    }

    for (const year of years) {
      if (!year.startDate) {
        year.delivered = 0;
        continue;
      }
      const eyStartYear = year.startDate.getFullYear();
      year.delivered = getDeliveredForYear(
        transferDeliveryLookup,
        trackingIdLower,
        eyStartYear
      );
    }

    out.push({
      key: `${trackingSystemRefId}-${rowIndex}`,
      contractId: clean(row.utility_contract_number) || "Unassigned",
      systemId: system?.systemId ?? null,
      trackingSystemRefId,
      systemName:
        clean(row.system_name) ||
        system?.systemName ||
        trackingSystemRefId,
      batchId:
        clean(row.batch_id) ||
        clean(row.state_certification_number) ||
        null,
      recPrice: system?.recPrice ?? null,
      years,
      firstTransferEnergyYear,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cached server entrypoint. Returns the same `PerformanceSourceRow[]`
// the client memo used to build, plus a fromCache flag for telemetry.
//
// superjson cache serde because `ScheduleYearEntry.{startDate,
// endDate}` are `Date | null`. JSON would silently coerce them to
// strings on cache hit and the client's `firstTransferEnergyYear`
// derivation (which calls `.getFullYear()`) would crash.
// ---------------------------------------------------------------------------

const PERFORMANCE_SOURCE_DEPS = ["abpReport", "deliveryScheduleBase"] as const;
const ARTIFACT_TYPE = "performanceSourceRows";

export const PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION =
  "phase-5e-pr8-performancesourcerows@1";

async function computePerformanceSourceRowsInputHash(
  scopeId: string
): Promise<{
  hash: string;
  abpReportBatchId: string | null;
  scheduleBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    PERFORMANCE_SOURCE_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;

  // Snapshot hash bundles every input the snapshot reads (which
  // includes our `recPrice`/`systemName` lookups), so any change to
  // any of those upstream inputs invalidates this aggregate.
  const snapshotHash = await computeSystemSnapshotHash(scopeId);

  // transferHistory's batch ID feeds the cached
  // `buildTransferDeliveryLookupForScope` separately; we include
  // it here so a transferHistory upload bumps THIS cache too.
  const transferVersions = await getActiveVersionsForKeys(scopeId, [
    "transferHistory",
  ]);
  const transferBatchId =
    transferVersions.find((v) => v.datasetKey === "transferHistory")
      ?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `abp:${abpReportBatchId ?? ""}`,
        `schedule:${scheduleBatchId ?? ""}`,
        `transfer:${transferBatchId ?? ""}`,
        `snapshot:${snapshotHash}`,
        `runner:${PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, scheduleBatchId };
}

export async function getOrBuildPerformanceSourceRows(
  scopeId: string
): Promise<{
  rows: PerformanceSourceRow[];
  fromCache: boolean;
}> {
  const { hash, abpReportBatchId, scheduleBatchId } =
    await computePerformanceSourceRowsInputHash(scopeId);

  // No delivery-schedule rows → nothing to aggregate. Mirror the
  // client memo's empty-state behavior.
  if (!scheduleBatchId) {
    return { rows: [], fromCache: false };
  }

  // No Part-2-verified abpReport → no eligible tracking IDs → empty
  // result. Skip the snapshot build + transfer-lookup load.
  if (!abpReportBatchId) {
    return { rows: [], fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<PerformanceSourceRow[]>(
    {
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: superjsonSerde<PerformanceSourceRow[]>(),
      rowCount: (rows) => rows.length,
      recompute: async () => {
        const [snapshot, abpReportRows, scheduleRows, transferLookup] =
          await Promise.all([
            getOrBuildSystemSnapshot(scopeId),
            loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
            loadDatasetRows(scopeId, scheduleBatchId, srDsDeliverySchedule),
            buildTransferDeliveryLookupForScope(scopeId),
          ]);

        const systems: SnapshotSystem[] = extractSnapshotSystems(
          snapshot.systems
        );

        // Eligibility filter — Part-2-verified tracking IDs in the
        // `solarApplications ∪ abpReport` cross-reference. Same logic
        // the parent's `part2EligibleSystemsForSizeReporting` uses.
        const { eligibleTrackingIds } = buildPart2EligibilityMaps(
          abpReportRows,
          systems
        );

        // 1:1 trackingId → system map. When duplicates exist (rare),
        // last-write-wins matches the client `Map.set` ordering.
        const systemsByTrackingId = new Map<string, SnapshotSystem>();
        for (const sys of systems) {
          if (!sys.trackingSystemRefId) continue;
          systemsByTrackingId.set(sys.trackingSystemRefId, sys);
        }

        return buildPerformanceSourceRows({
          scheduleRows,
          eligibleTrackingIds,
          systemsByTrackingId,
          transferDeliveryLookup: transferLookup,
        });
      },
    }
  );

  return { rows: result, fromCache };
}
