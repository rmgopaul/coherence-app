/**
 * Trend / delivery pace helpers — pure functions used by both the
 * Trends tab and the Alerts tab. Both call `buildTrendDeliveryPace`
 * with the same inputs, so we keep the calculation here once instead
 * of duplicating it across two extracted components.
 */

import { clean } from "@/lib/helpers";
import { getDeliveredForYear } from "@/solar-rec-dashboard/lib/transferHistoryDeliveries";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";

export type TrendDeliveryPaceRow = {
  contract: string;
  required: number;
  delivered: number;
  /** Time-elapsed expected pace, capped at 100. */
  expectedPace: number;
  /** Actual delivered/required pace, capped at 100. */
  actualPace: number;
};

/**
 * For each utility contract that has an active delivery year (start
 * and end straddling `now`), compute the time-elapsed expected pace
 * and the GATS-actual delivery pace. Used by the Trends tab chart
 * and the Alerts tab's "delivery pace below 80%" alert.
 *
 * Pure: no React, no closures over state. Same inputs always yield
 * the same output.
 */
export function buildTrendDeliveryPace(
  scheduleRows: CsvRow[],
  transferDeliveryLookup: Map<string, Map<number, number>>,
  now: Date = new Date(),
): TrendDeliveryPaceRow[] {
  if (scheduleRows.length === 0) return [];

  const contractPace = new Map<string, TrendDeliveryPaceRow>();

  for (const row of scheduleRows) {
    const contractId = row.utility_contract_number || "Unknown";
    const trackingId = clean(row.tracking_system_ref_id);

    for (let y = 1; y <= 15; y++) {
      const startRaw = row[`year${y}_start_date`];
      const endRaw = row[`year${y}_end_date`];
      const required = parseFloat(row[`year${y}_quantity_required`] || "0") || 0;
      if (!startRaw || required === 0) continue;

      const start = new Date(startRaw);
      const end = endRaw
        ? new Date(endRaw)
        : new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
      if (now < start || now > end) continue; // Not active

      // Delivered for this (system, year) comes from the transfer lookup.
      const delivered = trackingId
        ? getDeliveredForYear(transferDeliveryLookup, trackingId, start.getFullYear())
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
        // Recompute pace for the aggregate
        existing.actualPace =
          existing.required > 0 ? (existing.delivered / existing.required) * 100 : 0;
        existing.expectedPace = Math.min(100, expectedPace); // Use latest active year's pace
      }
    }
  }

  return Array.from(contractPace.values()).sort((a, b) =>
    a.contract.localeCompare(b.contract),
  );
}
