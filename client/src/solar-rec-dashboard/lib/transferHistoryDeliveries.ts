/**
 * Build a (trackingId → energyYear → deliveredQuantity) lookup from GATS
 * Transfer History rows. This is the single source of truth for "how many
 * RECs were delivered to a utility for system X in energy year Y" used by
 * every consumer of the Solar REC dashboard's schedule data after Phase 1a.
 *
 * Extracted from the pre-Phase-1a inline `transferDeliveryLookup` useMemo
 * in SolarRecDashboard.tsx. Behavior is preserved verbatim:
 *
 *   - Transferor containing "carbon solutions" AND Transferee matching a
 *     Illinois utility pattern → delivery (+quantity).
 *   - Transferor matching a utility pattern AND Transferee containing
 *     "carbon solutions" → return (-quantity).
 *   - Anything else → ignored.
 *   - Transfer Completion Date determines the energy year bucket using
 *     the June 1 → May 31 convention: month ≥ 5 maps to the year starting
 *     that June; month < 5 maps to the previous June.
 *   - Missing / unparseable Transfer Completion Date → row ignored.
 *   - Zero-quantity rows → ignored.
 *   - Multiple transfers for the same (unit, year) → summed (with sign).
 *
 * Keying convention: tracking IDs are lowercased before insertion so
 * lookups can be case-insensitive.
 */

import { clean } from "@/lib/helpers";
import { parseDate, parseNumber } from "./parsers";
import { UTILITY_PATTERNS } from "./constants";
import type { CsvRow } from "../state/types";

export type TransferDeliveryLookup = Map<string, Map<number, number>>;

const CARBON_SOLUTIONS = "carbon solutions";

export function buildTransferDeliveryLookup(
  transferRows: CsvRow[]
): TransferDeliveryLookup {
  const lookup: TransferDeliveryLookup = new Map();
  if (transferRows.length === 0) return lookup;

  for (const row of transferRows) {
    const unitId = clean(row["Unit ID"]);
    if (!unitId) continue;
    const qty = parseNumber(row.Quantity) ?? 0;
    if (qty === 0) continue;

    const transferor = clean(row.Transferor).toLowerCase();
    const transferee = clean(row.Transferee).toLowerCase();

    const isFromCS = transferor.includes(CARBON_SOLUTIONS);
    const isToCS = transferee.includes(CARBON_SOLUTIONS);
    const transfereeIsUtility = UTILITY_PATTERNS.some((u) => transferee.includes(u));
    const transferorIsUtility = UTILITY_PATTERNS.some((u) => transferor.includes(u));

    let direction = 0;
    if (isFromCS && transfereeIsUtility) direction = 1;
    else if (transferorIsUtility && isToCS) direction = -1;
    else continue;

    const completionDateRaw = clean(row["Transfer Completion Date"]);
    const completionDate = completionDateRaw ? parseDate(completionDateRaw) : null;
    if (!completionDate) continue;

    const month = completionDate.getMonth();
    const year = completionDate.getFullYear();
    const eyStartYear = month >= 5 ? year : year - 1;

    const key = unitId.toLowerCase();
    let yearMap = lookup.get(key);
    if (!yearMap) {
      yearMap = new Map<number, number>();
      lookup.set(key, yearMap);
    }
    yearMap.set(eyStartYear, (yearMap.get(eyStartYear) ?? 0) + qty * direction);
  }

  return lookup;
}

/**
 * Look up the delivered quantity for a single (trackingId, energyYearStart)
 * pair. Returns 0 when no transfers were recorded. Energy year start is the
 * calendar year of June 1 (e.g. 2024 for the 2024-06-01 → 2025-05-31 year).
 */
export function getDeliveredForYear(
  lookup: TransferDeliveryLookup,
  trackingSystemRefId: string,
  energyYearStart: number
): number {
  return lookup.get(trackingSystemRefId.toLowerCase())?.get(energyYearStart) ?? 0;
}

/**
 * Sum delivered quantity for a tracking ID across every energy year in the
 * lookup. Used by memos that aggregate lifetime deliveries (the `systems`
 * mega-memo's `scheduleDelivered` field).
 */
export function getDeliveredLifetime(
  lookup: TransferDeliveryLookup,
  trackingSystemRefId: string
): number {
  const yearMap = lookup.get(trackingSystemRefId.toLowerCase());
  if (!yearMap) return 0;
  let total = 0;
  yearMap.forEach((qty) => {
    total += qty;
  });
  return total;
}
