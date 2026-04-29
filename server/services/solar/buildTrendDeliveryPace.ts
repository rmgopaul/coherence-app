/**
 * Server-side delivery-pace aggregator. Shared by the Trends and
 * Alerts tabs.
 *
 * Task 5.13 PR-2 (2026-04-27) — moves
 * `client/src/solar-rec-dashboard/lib/helpers/trends.ts:buildTrendDeliveryPace`
 * onto the server. Both `AlertsTab` and `TrendsTab` used to call the
 * client-side helper from a `useMemo` over
 * `datasets.deliveryScheduleBase.rows`. The server now reads
 * `srDsDeliverySchedule` rows for the active scope, joins them with
 * the cached `transferDeliveryLookup`, and returns the small
 * `TrendDeliveryPaceRow[]` aggregate (one row per active utility
 * contract).
 *
 * Cache strategy: the result depends on `now` (used to filter active
 * year-windows and to compute the time-elapsed expected pace), so
 * the cache key includes a daily date bucket. Same batch + same UTC
 * day → cache hit. Recompute is sub-second on prod data, so the
 * daily granularity is conservative.
 */

import { createHash } from "node:crypto";
import { srDsDeliverySchedule } from "../../../drizzle/schemas/solar";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  clean,
  getDeliveredForYear,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import {
  buildTransferDeliveryLookupForScope,
  type TransferDeliveryLookupPayload,
} from "./buildTransferDeliveryLookup";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// Note: `parseFloat` (not `parseNumber`) is used below for
// `year${y}_quantity_required` to match the client helper at
// `client/src/solar-rec-dashboard/lib/helpers/trends.ts:47`. This
// preserves byte-equivalent behavior with the original client
// implementation; it also means the helper is forgiving about
// trailing characters where `parseNumber` would return null.
// Normalizing to `parseNumber` is a follow-up — the matched test
// fixtures lock the current behavior in place.

// ---------------------------------------------------------------------------
// Output type — kept structurally identical to the client version so
// existing tab consumers don't need to change shape.
// ---------------------------------------------------------------------------

export type TrendDeliveryPaceRow = {
  contract: string;
  required: number;
  delivered: number;
  /** Time-elapsed expected pace, capped at 100. */
  expectedPace: number;
  /** Actual delivered/required pace, capped at 100. */
  actualPace: number;
};

// ---------------------------------------------------------------------------
// Pure aggregator — byte-for-byte mirror of the client helper. The matched
// test files (server side here, client side at
// `client/src/solar-rec-dashboard/lib/helpers/trends.test.ts`) are the
// divergence detector for the duplicated implementation.
// ---------------------------------------------------------------------------

export function buildTrendDeliveryPace(
  scheduleRows: CsvRow[],
  transferDeliveryLookup: TransferDeliveryLookupPayload,
  now: Date = new Date()
): TrendDeliveryPaceRow[] {
  if (scheduleRows.length === 0) return [];

  const contractPace = new Map<string, TrendDeliveryPaceRow>();

  for (const row of scheduleRows) {
    const contractId = row.utility_contract_number || "Unknown";
    const trackingId = clean(row.tracking_system_ref_id);

    for (let y = 1; y <= 15; y++) {
      const startRaw = row[`year${y}_start_date`];
      const endRaw = row[`year${y}_end_date`];
      const required =
        parseFloat(row[`year${y}_quantity_required`] || "0") || 0;
      if (!startRaw || required === 0) continue;

      const start = new Date(startRaw);
      const end = endRaw
        ? new Date(endRaw)
        : new Date(
            start.getFullYear() + 1,
            start.getMonth(),
            start.getDate()
          );
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
      if (now < start || now > end) continue; // Not active

      const delivered = trackingId
        ? getDeliveredForYear(
            transferDeliveryLookup,
            trackingId,
            start.getFullYear()
          )
        : 0;

      const totalMs = end.getTime() - start.getTime();
      const elapsedMs = now.getTime() - start.getTime();
      const expectedPace = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
      const actualPace = required > 0 ? (delivered / required) * 100 : 0;

      const existing = contractPace.get(contractId);
      if (!existing) {
        contractPace.set(contractId, {
          contract: contractId,
          required,
          delivered,
          expectedPace: Math.min(100, expectedPace),
          actualPace: Math.min(100, actualPace),
        });
      } else {
        existing.required += required;
        existing.delivered += delivered;
        existing.actualPace =
          existing.required > 0
            ? (existing.delivered / existing.required) * 100
            : 0;
        existing.expectedPace = Math.min(100, expectedPace);
      }
    }
  }

  return Array.from(contractPace.values()).sort((a, b) =>
    a.contract.localeCompare(b.contract)
  );
}

// ---------------------------------------------------------------------------
// Cached server entrypoint.
// ---------------------------------------------------------------------------

const TREND_DELIVERY_PACE_DEPS = ["deliveryScheduleBase"] as const;

const ARTIFACT_TYPE = "trendDeliveryPace";

export const TREND_DELIVERY_PACE_RUNNER_VERSION =
  // 2026-04-29 (@2): bumped after `getDeliveredForYear`
  // case-sensitivity fix. Pre-fix, the `actualPace` numerator
  // was always 0 in production because raw mixed-case trackingId
  // missed lowercase lookup keys. The cache must invalidate so
  // every active scope recomputes pace with real delivered values.
  "data-flow-pr5_13_trenddeliverypace@2";

/** UTC YYYY-MM-DD bucket — narrow enough for daily pace shifts. */
function dateBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function computeTrendDeliveryPaceInputHash(
  scopeId: string,
  now: Date
): Promise<{
  hash: string;
  scheduleBatchId: string | null;
  lookupBatchId: string | null;
}> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    TREND_DELIVERY_PACE_DEPS as unknown as string[]
  );
  const scheduleBatchId =
    versions.find((v) => v.datasetKey === "deliveryScheduleBase")?.batchId ??
    null;

  // Transfer-delivery lookup is keyed by transferHistory's active batch.
  // We don't need to load the full lookup here — just the batchId for the
  // hash. `buildTransferDeliveryLookupForScope` is called only on cache
  // miss.
  const transferVersions = await getActiveVersionsForKeys(scopeId, [
    "transferHistory",
  ]);
  const lookupBatchId =
    transferVersions.find((v) => v.datasetKey === "transferHistory")
      ?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `schedule:${scheduleBatchId ?? ""}`,
        `transfer:${lookupBatchId ?? ""}`,
        `day:${dateBucket(now)}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, scheduleBatchId, lookupBatchId };
}

/**
 * Public entrypoint for the tRPC query. Returns the same
 * `TrendDeliveryPaceRow[]` array the two client tabs used to build
 * locally.
 *
 * Cache: `withArtifactCache` keyed by SHA-256 of
 * (scheduleBatchId, transferBatchId, UTC day). Cache miss recomputes
 * (loadDatasetRows + transfer lookup + aggregator), writes back,
 * returns. Plain JSON serde — the result has no Date fields.
 */
export async function getOrBuildTrendDeliveryPace(
  scopeId: string,
  now: Date = new Date()
): Promise<{ rows: TrendDeliveryPaceRow[]; fromCache: boolean }> {
  const { hash, scheduleBatchId } = await computeTrendDeliveryPaceInputHash(
    scopeId,
    now
  );

  if (!scheduleBatchId) {
    return { rows: [], fromCache: false };
  }

  const { result, fromCache } = await withArtifactCache<TrendDeliveryPaceRow[]>({
    scopeId,
    artifactType: ARTIFACT_TYPE,
    inputVersionHash: hash,
    serde: jsonSerde<TrendDeliveryPaceRow[]>(),
    rowCount: (rows) => rows.length,
    recompute: async () => {
      const [scheduleRows, transferLookup] = await Promise.all([
        loadDatasetRows(scopeId, scheduleBatchId, srDsDeliverySchedule),
        buildTransferDeliveryLookupForScope(scopeId),
      ]);
      return buildTrendDeliveryPace(scheduleRows, transferLookup, now);
    },
  });

  return { rows: result, fromCache };
}
