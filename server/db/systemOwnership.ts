/**
 * Task 9.5 PR-5 (2026-04-28) — ownership / transfer history per CSG ID.
 *
 * Powers the new "Ownership" section on the system detail page.
 * Joins `srDsTransferHistory` rows for one system and rolls them
 * up into a single ownership snapshot.
 *
 * Join key: `srDsTransferHistory.unitId === registry.trackingSystemRefId`
 * (the GATS Unit ID). When the registry doesn't carry a tracking
 * ID we return empty — the page renders the standard "no data on
 * file" state. There's no fuzzy fallback here because transfer
 * rows don't carry any other system-identifying field.
 *
 * MVP scope: simple history list + counterparty rollups. The
 * dashboard's full `changeOwnershipStatus` derivation also pulls
 * from contract status text + Zillow data — surfaced on the
 * detail page through other sections — so we deliberately don't
 * duplicate it here. A future PR can add a unified ownership-
 * status field once the team has feedback on the simpler view.
 */

import { eq, and, desc, getDb, withDbRetry } from "./_core";
import {
  srDsTransferHistory,
  solarRecActiveDatasetVersions,
} from "../../drizzle/schema";
import { getSystemByCsgId } from "./systemRegistry";

export interface SystemTransfer {
  transactionId: string | null;
  transferCompletionDate: string | null;
  quantity: number | null;
  transferor: string | null;
  transferee: string | null;
}

export interface SystemOwnershipResult {
  /** Most-recent transfer first, capped at the helper's limit. */
  transfers: SystemTransfer[];
  /** Total transfer rows matching this system across the active
   *  batch — not just the rows returned. UI shows "12 transfers
   *  · 3 unique parties" without needing a follow-up query. */
  count: number;
  /** Most recent `transferCompletionDate` in the result set. */
  latestTransferDate: string | null;
  /** Sum of `quantity` across ALL matching rows. `null` when zero
   *  parseable values exist. */
  totalQuantityTransferred: number | null;
  /** Distinct transferors across ALL matching rows. */
  uniqueTransferors: string[];
  /** Distinct transferees across ALL matching rows. */
  uniqueTransferees: string[];
}

const EMPTY_RESULT: SystemOwnershipResult = {
  transfers: [],
  count: 0,
  latestTransferDate: null,
  totalQuantityTransferred: null,
  uniqueTransferors: [],
  uniqueTransferees: [],
};

/** Resolve the transferHistory active batch. Exposed for testability. */
export async function resolveTransferHistoryBatchId(
  scopeId: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("ownership — active batch", () =>
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

/** Coerce a transfer-completion date string into something
 *  `Array.sort` can compare lexicographically. ISO ("YYYY-MM-DD")
 *  sorts correctly as-is; common alternatives like "M/D/YYYY"
 *  parse to ISO via Date. Returns the empty string for unparseable
 *  values so they sort to the bottom. Exposed for testability. */
export function transferDateSortKey(value: string | null): string {
  if (!value) return "";
  // ISO strings already sort right.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Look up transfer history for one CSG ID. Internally re-runs the
 * registry lookup to discover the system's tracking ID — callers
 * that already have a `SystemRegistryRecord` can pass it via
 * `opts.preResolvedRegistry` to avoid the duplicate read.
 */
export async function getOwnershipForCsgId(
  scopeId: string,
  csgId: string,
  opts: {
    /** Cap on transfer rows returned. Roll-up totals span ALL rows
     *  regardless. Default 30; clamped to [1, 200]. */
    limit?: number;
    preResolvedRegistry?: Awaited<ReturnType<typeof getSystemByCsgId>>;
  } = {}
): Promise<SystemOwnershipResult> {
  const trimmed = csgId.trim();
  if (!trimmed) return EMPTY_RESULT;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);

  const db = await getDb();
  if (!db) return EMPTY_RESULT;

  const registry =
    opts.preResolvedRegistry ?? (await getSystemByCsgId(scopeId, csgId));
  if (!registry) return EMPTY_RESULT;
  const trackingId = registry.trackingSystemRefId?.trim() || null;
  if (!trackingId) return EMPTY_RESULT;

  const batchId = await resolveTransferHistoryBatchId(scopeId);
  if (!batchId) return EMPTY_RESULT;

  // Pull every matching row in one query — transfer history per
  // system is bounded (typically <50 rows for the worst case).
  // Sorting + capping happens application-side after we compute
  // the roll-ups across the entire result set.
  const rows = await withDbRetry("ownership — transfer history lookup", () =>
    db
      .select({
        transactionId: srDsTransferHistory.transactionId,
        transferCompletionDate: srDsTransferHistory.transferCompletionDate,
        quantity: srDsTransferHistory.quantity,
        transferor: srDsTransferHistory.transferor,
        transferee: srDsTransferHistory.transferee,
      })
      .from(srDsTransferHistory)
      .where(
        and(
          eq(srDsTransferHistory.scopeId, scopeId),
          eq(srDsTransferHistory.batchId, batchId),
          eq(srDsTransferHistory.unitId, trackingId)
        )
      )
      .orderBy(desc(srDsTransferHistory.transferCompletionDate))
  );

  if (rows.length === 0) return EMPTY_RESULT;

  // Roll-ups span the entire result set; the limited slice is
  // for display only.
  let totalQty: number | null = null;
  const transferors = new Set<string>();
  const transferees = new Set<string>();
  let latestDate = "";
  for (const row of rows) {
    if (typeof row.quantity === "number" && Number.isFinite(row.quantity)) {
      totalQty = (totalQty ?? 0) + row.quantity;
    }
    const tor = row.transferor?.trim();
    if (tor) transferors.add(tor);
    const tee = row.transferee?.trim();
    if (tee) transferees.add(tee);
    const dateKey = transferDateSortKey(row.transferCompletionDate);
    if (dateKey > latestDate) latestDate = dateKey;
  }

  // Re-sort application-side using transferDateSortKey so dates
  // in non-ISO formats land in the right order even when the SQL
  // sort treated them as varchars.
  const sortedRows = [...rows].sort(
    (a, b) =>
      transferDateSortKey(b.transferCompletionDate).localeCompare(
        transferDateSortKey(a.transferCompletionDate)
      )
  );

  const limitedTransfers: SystemTransfer[] = sortedRows
    .slice(0, limit)
    .map((row) => ({
      transactionId: row.transactionId ?? null,
      transferCompletionDate: row.transferCompletionDate ?? null,
      quantity: row.quantity ?? null,
      transferor: row.transferor ?? null,
      transferee: row.transferee ?? null,
    }));

  return {
    transfers: limitedTransfers,
    count: rows.length,
    latestTransferDate: latestDate || null,
    totalQuantityTransferred: totalQty,
    uniqueTransferors: Array.from(transferors).sort(),
    uniqueTransferees: Array.from(transferees).sort(),
  };
}
