/**
 * Pure helpers shared across the REC performance spine tabs —
 * Forecast, Performance Evaluation, and Snapshot Log.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 9. The two helpers
 * below are the only computational logic the spine needs outside the
 * big `performanceSourceRows` memo itself: one builds the delivery
 * year label ("2023-2024") that the UI filter and the forecast key
 * both compare against; the other turns a row + a target year index
 * into a rolling-3-year REC window (actuals only in the 3rd delivery
 * year, otherwise prior years come from the Schedule B "required"
 * column).
 *
 * Both functions are pure — no component state, no side effects, no
 * closures over dashboard refs — so they live in helpers and are
 * imported by both the parent's `recPerformanceEvaluation` memo and
 * the child `ForecastTab`'s `forecastProjections` memo.
 */

import { formatDate } from "@/solar-rec-dashboard/lib/helpers/formatting";

export {
  buildRecReviewDeliveryYearLabel,
  deriveRecPerformanceThreeYearValues,
} from "@shared/solarRecPerformanceRatio";

/**
 * Render a Schedule B delivery-year entry as the canonical
 * "startYear-endYear" label when both dates are parseable, otherwise
 * fall back progressively to raw strings. Used by the REC Performance
 * Evaluation contract/year filter and the Forecast tab's energy-year
 * matcher.
 */
export function buildDeliveryYearLabel(
  start: Date | null,
  end: Date | null,
  startRaw: string,
  endRaw: string,
): string {
  if (start && end) {
    return `${start.getFullYear()}-${end.getFullYear()}`;
  }
  if (startRaw && endRaw) return `${startRaw} to ${endRaw}`;
  if (startRaw) return startRaw;
  if (start) return formatDate(start);
  return "Unknown";
}

/**
 * Thin alias over `buildDeliveryYearLabel` so the perf-eval call sites
 * can communicate intent ("this label must match the REC-review energy
 * year layout") without duplicating logic. The schedule start date IS
 * the delivery year start — no +1 offset — so the energy year
 * "2023-06-01 to 2024-05-31" renders as "2023-2024".
 */
