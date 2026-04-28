/**
 * Server-side DataQualityTab cross-reference reconciliation.
 *
 * Replaces the tab's `dataQualityUnmatched` useMemo that walked
 * `datasets.deliveryScheduleBase.rows` + `datasets.convertedReads.rows`
 * to build the set difference of (tracking-system-ref-id ∩
 * monitoring-system-id). At ~10k schedule rows + ~28k converted-reads
 * rows on a populated scope, that useMemo forced both lazy datasets
 * to materialize on every DataQuality-tab activation just to compute
 * a few thousand mismatched IDs. The aggregator runs the same set
 * math server-side, caches the result by input batch hash, and
 * returns the (already-small) mismatch lists.
 *
 * Task 5.14 PR-4 (2026-04-27). Output shape mirrors the previous
 * client useMemo's `dataQualityUnmatched` exactly (same field
 * names, same lowercased ID semantics) so the tab's render path
 * doesn't have to change.
 *
 * The planning doc originally suggested two `useInfiniteQuery`
 * paginated reads — a single dedicated server aggregator is the
 * cheaper move because (a) the ~38k total rows would take ~76
 * sequential 500-row round-trips through `getDatasetRowsPage`,
 * and (b) the result is small enough (a few thousand IDs at
 * worst) that returning it as a one-shot tRPC response is
 * trivially in budget. Cache is keyed by input batch IDs so
 * subsequent tab activations hit the artifact cache.
 */

import { createHash } from "node:crypto";
import {
  srDsConvertedReads,
  srDsDeliverySchedule,
} from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import { type CsvRow, clean, toPercentValue } from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Output type — byte-equivalent to the prior client `dataQualityUnmatched`
// ---------------------------------------------------------------------------

export type DataQualityReconciliation = {
  /** Tracking IDs in deliveryScheduleBase that have no monitoring counterpart. */
  inScheduleNotMonitoring: string[];
  /** Monitoring system IDs in convertedReads that have no schedule counterpart. */
  inMonitoringNotSchedule: string[];
  /** Match rate (0–100) or null when both sets are empty. */
  matchedPercent: number | null;
};

const EMPTY_RECONCILIATION: DataQualityReconciliation = {
  inScheduleNotMonitoring: [],
  inMonitoringNotSchedule: [],
  matchedPercent: null,
};

// Wire-payload safety net. The UI shows mismatches in scrollable
// `<details>` blocks; if a populated scope has more than this many
// mismatches the user already has bigger problems than the truncation.
// Picked an order of magnitude above the largest realistic count
// (~28k convertedReads rows × maybe 15 % mismatch rate ≈ 4k IDs).
const MAX_MISMATCH_LIST_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Pure aggregator — same set-difference math the client useMemo did
// ---------------------------------------------------------------------------

export function buildDataQualityReconciliation(input: {
  scheduleRows: CsvRow[];
  convertedReadsRows: CsvRow[];
}): DataQualityReconciliation {
  const { scheduleRows, convertedReadsRows } = input;

  const scheduleIds = new Set<string>();
  const monitoringIds = new Set<string>();

  for (const row of scheduleRows) {
    const id = clean(row.tracking_system_ref_id) || clean(row.system_id);
    if (id) scheduleIds.add(id.toLowerCase());
  }

  for (const row of convertedReadsRows) {
    const id = clean(row.monitoring_system_id);
    if (id) monitoringIds.add(id.toLowerCase());
  }

  const inScheduleNotMonitoring: string[] = [];
  scheduleIds.forEach((id) => {
    if (
      !monitoringIds.has(id) &&
      inScheduleNotMonitoring.length < MAX_MISMATCH_LIST_SIZE
    ) {
      inScheduleNotMonitoring.push(id);
    }
  });
  const inMonitoringNotSchedule: string[] = [];
  monitoringIds.forEach((id) => {
    if (
      !scheduleIds.has(id) &&
      inMonitoringNotSchedule.length < MAX_MISMATCH_LIST_SIZE
    ) {
      inMonitoringNotSchedule.push(id);
    }
  });

  // Match-rate denominator = size of the union (every distinct ID
  // referenced by either dataset). Numerator = ids present in both
  // (intersection) — derived as union − schedule-only − monitoring-
  // only, byte-equivalent to the previous client useMemo.
  const union = new Set<string>();
  scheduleIds.forEach((id) => union.add(id));
  monitoringIds.forEach((id) => union.add(id));
  const totalUnique = union.size;
  const matched =
    totalUnique - inScheduleNotMonitoring.length - inMonitoringNotSchedule.length;
  const matchedPercent = toPercentValue(matched, totalUnique);

  return {
    inScheduleNotMonitoring,
    inMonitoringNotSchedule,
    matchedPercent,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint
// ---------------------------------------------------------------------------

const RECONCILIATION_DEPS = ["deliveryScheduleBase", "convertedReads"] as const;
const ARTIFACT_TYPE = "dataQualityReconciliation";

export const DATA_QUALITY_RECONCILIATION_RUNNER_VERSION =
  "task-5.14-pr4-data-quality-reconciliation@1";

async function computeDataQualityReconciliationInputHash(
  scopeId: string
): Promise<{
  hash: string;
  scheduleBatchId: string | null;
  convertedReadsBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    RECONCILIATION_DEPS as unknown as string[]
  );
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;
  const convertedReadsBatchId =
    versions.find((v) => v.datasetKey === "convertedReads")?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `schedule:${scheduleBatchId ?? ""}`,
        `convertedReads:${convertedReadsBatchId ?? ""}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, scheduleBatchId, convertedReadsBatchId };
}

/**
 * Public entrypoint for the tRPC query. When either input batch is
 * missing the reconciliation is empty — the freshness table elsewhere
 * on the tab already surfaces the "missing" / "stale" state for the
 * underlying dataset.
 */
export async function getOrBuildDataQualityReconciliation(
  scopeId: string
): Promise<DataQualityReconciliation & { fromCache: boolean }> {
  const { hash, scheduleBatchId, convertedReadsBatchId } =
    await computeDataQualityReconciliationInputHash(scopeId);

  if (!scheduleBatchId || !convertedReadsBatchId) {
    return { ...EMPTY_RECONCILIATION, fromCache: false };
  }

  const { result, fromCache } =
    await withArtifactCache<DataQualityReconciliation>({
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: jsonSerde<DataQualityReconciliation>(),
      rowCount: (out) =>
        out.inScheduleNotMonitoring.length + out.inMonitoringNotSchedule.length,
      recompute: async () => {
        const [scheduleRows, convertedReadsRows] = await Promise.all([
          loadDatasetRows(scopeId, scheduleBatchId, srDsDeliverySchedule),
          loadDatasetRows(scopeId, convertedReadsBatchId, srDsConvertedReads),
        ]);
        return buildDataQualityReconciliation({
          scheduleRows,
          convertedReadsRows,
        });
      },
    });

  return { ...result, fromCache };
}
