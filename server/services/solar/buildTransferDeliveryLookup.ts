/**
 * Server-side computation of the (trackingId → energyYear → delivered)
 * lookup from the typed srDsTransferHistory rows.
 *
 * This mirrors the client's `buildTransferDeliveryLookup` in
 * client/src/solar-rec-dashboard/lib/transferHistoryDeliveries.ts —
 * same algorithm, same Illinois utility filter, same Carbon Solutions
 * source filter, same June-1 energy-year bucketing.
 *
 * The result is keyed by the active transferHistory batch ID alone
 * (no other dataset affects the lookup). That makes the cache very
 * simple: one entry per transferHistory batch, invalidated only when
 * a new transferHistory upload lands.
 *
 * Typed columns cover every field the algorithm reads, so rawRow is
 * never loaded — about 450 MB of wire transfer saved on the 579k-
 * row production dataset.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb, withDbRetry } from "../../db/_core";
import {
  srDsTransferHistory,
  solarRecActiveDatasetVersions,
} from "../../../drizzle/schema";

// Serialized form: a plain JS object, not a Map, since tRPC can't
// serialize Map. Client hook revives to Map<string, Map<number, number>>.
export type TransferDeliveryLookupPayload = {
  byTrackingId: Record<string, Record<string, number>>;
  inputVersionHash: string | null;
  transferHistoryBatchId: string | null;
};

const CARBON_SOLUTIONS = "carbon solutions";
// Kept in sync with client lib/constants.ts UTILITY_PATTERNS. Any
// change there should mirror here to avoid parity drift.
const UTILITY_PATTERNS = ["comed", "ameren", "midamerican"];

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseQuantity(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const s = String(value).replace(/[$,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseCompletionDate(value: unknown): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  // ISO-ish: "2024-08-15" or "2024-08-15T10:30:00Z" etc.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // US: "8/15/2024" or "08/15/2024 06:02 AM"
  const us = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
  );
  if (us) {
    const month = Number(us[1]) - 1;
    const day = Number(us[2]);
    const year = Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3]);
    let hours = us[4] ? Number(us[4]) : 0;
    const minutes = us[5] ? Number(us[5]) : 0;
    const meridiem = us[6]?.toUpperCase();
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    const d = new Date(year, month, day, hours, minutes);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

async function getActiveTransferHistoryBatchId(
  scopeId: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("load active transferHistory batch", () =>
    db
      .select({ batchId: solarRecActiveDatasetVersions.batchId })
      .from(solarRecActiveDatasetVersions)
      .where(
        and(
          eq(solarRecActiveDatasetVersions.scopeId, scopeId),
          eq(solarRecActiveDatasetVersions.datasetKey, "transferHistory")
        )
      )
      .limit(1)
  );

  return rows[0]?.batchId ?? null;
}

/**
 * Load only the 5 columns we need. Skipping rawRow saves ~450MB of
 * transfer on the 579k-row production dataset.
 */
async function loadTransferRows(batchId: string): Promise<
  Array<{
    transactionId: string | null;
    unitId: string | null;
    transferor: string | null;
    transferee: string | null;
    transferCompletionDate: string | null;
    quantity: number | null;
  }>
> {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("load transferHistory rows", () =>
    db
      .select({
        transactionId: srDsTransferHistory.transactionId,
        unitId: srDsTransferHistory.unitId,
        transferor: srDsTransferHistory.transferor,
        transferee: srDsTransferHistory.transferee,
        transferCompletionDate: srDsTransferHistory.transferCompletionDate,
        quantity: srDsTransferHistory.quantity,
      })
      .from(srDsTransferHistory)
      .where(eq(srDsTransferHistory.batchId, batchId))
  );
}

// v2: adds compute-time txId dedup — prior version double-counted
// rows whose (txId, unitId, date-string, qty) ingest dedup key
// mismatched due to date-format drift across GATS re-exports
// (e.g., "03/22/2026 03:46 AM" vs "3/22/26 3:46"). Bumping the
// artifact type forces a cache miss on every scope so the fixed
// algorithm runs once per active batch.
const TRANSFER_DELIVERY_ARTIFACT_TYPE = "transfer_delivery_lookup_v2";

/**
 * Build the delivery lookup from the active transferHistory batch
 * for a scope. The result object is safe to serialize (plain
 * object, no Maps).
 *
 * Cached in `solarRecComputedArtifacts` keyed by the active
 * transferHistory batchId (batch IDs change atomically when a new
 * upload activates, so this is a perfect content hash). Cache hit
 * serves in ~1ms; cache miss runs the 200-500ms algorithm and
 * writes the result for next time.
 *
 * A per-process single-flight guard (`inFlightBuilds`) collapses
 * concurrent requests that miss the cache simultaneously onto one
 * promise — otherwise an N-user cold start would do N identical
 * iterations over 579k rows.
 */
const inFlightBuilds = new Map<
  string,
  Promise<TransferDeliveryLookupPayload>
>();

/** Typed-row shape loadTransferRows returns (exported for tests). */
export type TypedTransferRow = {
  transactionId: string | null;
  unitId: string | null;
  transferor: string | null;
  transferee: string | null;
  transferCompletionDate: string | null;
  quantity: number | null;
};

/**
 * Pure algorithm: given a batch's typed rows, produce the lookup
 * payload. Exported for direct unit-testing — the full
 * buildTransferDeliveryLookupForScope path also exercises cache
 * + single-flight machinery, which we don't want every test to
 * mock out.
 *
 * Dedupe by Transaction ID (first-write-wins). GATS Transaction IDs
 * are globally unique per confirmed transfer, so any row sharing a
 * txId we've already summed represents the same underlying transfer
 * and must be skipped. This is the last line of defense against
 * ingest-time dedup misses caused by date-string format drift
 * across GATS re-exports (e.g., "03/22/2026 03:46 AM" vs
 * "3/22/26 3:46" hashing to different composite keys).
 *
 * Rows with missing / empty Transaction IDs fall through to the
 * sum without a dedup guard — rare in practice, but preserves the
 * original behavior for incomplete data rather than collapsing
 * every such row to a single bucket.
 */
export function computeTransferDeliveryLookupFromRows(
  rows: readonly TypedTransferRow[],
  batchId: string
): TransferDeliveryLookupPayload {
  const byTrackingId: Record<string, Record<string, number>> = {};
  const seenTransactionIds = new Set<string>();

  for (const row of rows) {
    const unitId = clean(row.unitId);
    if (!unitId) continue;
    const qty = row.quantity ?? parseQuantity(row.quantity);
    if (qty === 0) continue;

    const txId = clean(row.transactionId);
    if (txId) {
      if (seenTransactionIds.has(txId)) continue;
      seenTransactionIds.add(txId);
    }

    const transferor = clean(row.transferor).toLowerCase();
    const transferee = clean(row.transferee).toLowerCase();
    const isFromCS = transferor.includes(CARBON_SOLUTIONS);
    const isToCS = transferee.includes(CARBON_SOLUTIONS);
    const transfereeIsUtility = UTILITY_PATTERNS.some((u) =>
      transferee.includes(u)
    );
    const transferorIsUtility = UTILITY_PATTERNS.some((u) =>
      transferor.includes(u)
    );

    let direction = 0;
    if (isFromCS && transfereeIsUtility) direction = 1;
    else if (transferorIsUtility && isToCS) direction = -1;
    else continue;

    const completionDate = parseCompletionDate(row.transferCompletionDate);
    if (!completionDate) continue;

    const month = completionDate.getMonth();
    const year = completionDate.getFullYear();
    const eyStartYear = month >= 5 ? year : year - 1;

    const key = unitId.toLowerCase();
    const yearMap = byTrackingId[key] ?? (byTrackingId[key] = {});
    const yearKey = String(eyStartYear);
    yearMap[yearKey] = (yearMap[yearKey] ?? 0) + qty * direction;
  }

  return {
    byTrackingId,
    inputVersionHash: batchId,
    transferHistoryBatchId: batchId,
  };
}

async function computeFresh(
  batchId: string
): Promise<TransferDeliveryLookupPayload> {
  const rows = await loadTransferRows(batchId);
  return computeTransferDeliveryLookupFromRows(rows, batchId);
}

export async function buildTransferDeliveryLookupForScope(
  scopeId: string
): Promise<TransferDeliveryLookupPayload> {
  const batchId = await getActiveTransferHistoryBatchId(scopeId);
  if (!batchId) {
    return {
      byTrackingId: {},
      inputVersionHash: null,
      transferHistoryBatchId: null,
    };
  }

  // Cache read.
  const { getComputedArtifact, upsertComputedArtifact } = await import(
    "../../db/solarRecDatasets"
  );
  const cached = await getComputedArtifact(
    scopeId,
    TRANSFER_DELIVERY_ARTIFACT_TYPE,
    batchId
  );
  if (cached?.payload) {
    try {
      const parsed = JSON.parse(cached.payload) as {
        byTrackingId: Record<string, Record<string, number>>;
      };
      if (parsed && typeof parsed === "object" && parsed.byTrackingId) {
        return {
          byTrackingId: parsed.byTrackingId,
          inputVersionHash: batchId,
          transferHistoryBatchId: batchId,
        };
      }
    } catch {
      // Malformed cache payload — fall through to recompute.
    }
  }

  // Single-flight: if someone else is already building this lookup
  // for this scope+batchId, await their promise rather than
  // launching a duplicate 579k-row iteration.
  const flightKey = `${scopeId}:${batchId}`;
  const existing = inFlightBuilds.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await computeFresh(batchId);

      // Best-effort cache write — don't fail the request if it fails.
      try {
        const serialized = JSON.stringify({
          byTrackingId: result.byTrackingId,
        });
        const rowCount = Object.keys(result.byTrackingId).length;
        await upsertComputedArtifact({
          scopeId,
          artifactType: TRANSFER_DELIVERY_ARTIFACT_TYPE,
          inputVersionHash: batchId,
          payload: serialized,
          rowCount,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[buildTransferDeliveryLookup] cache write failed:`,
          err instanceof Error ? err.message : err
        );
      }

      return result;
    } finally {
      inFlightBuilds.delete(flightKey);
    }
  })();
  inFlightBuilds.set(flightKey, promise);
  return promise;
}

// Lightweight hash-only accessor in case a consumer wants to check
// freshness without downloading the full lookup.
export async function getTransferDeliveryLookupHash(
  scopeId: string
): Promise<string | null> {
  return getActiveTransferHistoryBatchId(scopeId);
}

// Silence unused-import warning for `sql` (kept in imports for
// future extensions that may need SQL template literals here).
void sql;
