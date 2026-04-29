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
import type {
  PerformanceSourceRow,
  RecPerformanceThreeYearValues,
} from "@/solar-rec-dashboard/state/types";

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
export function buildRecReviewDeliveryYearLabel(
  start: Date | null,
  end: Date | null,
  startRaw: string,
  endRaw: string,
): string {
  return buildDeliveryYearLabel(start, end, startRaw, endRaw);
}

/**
 * Given a Schedule B row + a target year index (0-based into
 * `row.years`), compute the rolling 3-year REC delivery window used by
 * REC Performance Evaluation and the Forecast tab.
 *
 * Returns `null` when:
 *   - the target year has fewer than 2 prior years (array bounds),
 *   - any of the three years is missing,
 *   - the system has no first-transfer energy year (ineligible),
 *   - the target year has no start date,
 *   - the system is not yet in its 3rd actual delivery year.
 *
 * Otherwise returns the three years' delivered RECs, with a
 * per-year source flag: years 1 and 2 come from the Schedule B
 * "required" column unless this is the system's 3rd delivery year
 * (in which case all three come from actual deliveries). Year 3 is
 * always the actual delivered count.
 *
 * `rollingAverage` is the integer floor of the three-year mean;
 * `expectedRecs` is the Schedule B required count for year 3.
 */
export function deriveRecPerformanceThreeYearValues(
  sourceRow: PerformanceSourceRow,
  targetYearIndex: number,
): RecPerformanceThreeYearValues | null {
  // Array bounds: need at least 2 prior years for the rolling average.
  if (targetYearIndex < 2) return null;

  const dyOneYear = sourceRow.years[targetYearIndex - 2];
  const dyTwoYear = sourceRow.years[targetYearIndex - 1];
  const dyThreeYear = sourceRow.years[targetYearIndex];
  if (!dyOneYear || !dyTwoYear || !dyThreeYear) return null;

  // Every contract start date is determined by the first REC transfer in
  // GATS. No fallback to PDF dates. If there's no transfer data, the
  // system is not eligible for performance evaluation.
  if (sourceRow.firstTransferEnergyYear === null || !dyThreeYear.startDate) {
    return null;
  }

  const firstDeliveryYear = sourceRow.firstTransferEnergyYear + 1;
  const targetEnergyYear = dyThreeYear.startDate.getFullYear();
  const actualDeliveryYearNumber = targetEnergyYear - firstDeliveryYear + 1;

  // Only include systems in their 3rd+ actual delivery year.
  if (actualDeliveryYearNumber < 3) return null;

  const isThirdDeliveryYear = actualDeliveryYearNumber === 3;
  const values: Array<{ value: number; source: "Actual" | "Expected" }> = isThirdDeliveryYear
    ? [
        { value: dyOneYear.delivered, source: "Actual" },
        { value: dyTwoYear.delivered, source: "Actual" },
        { value: dyThreeYear.delivered, source: "Actual" },
      ]
    : [
        { value: dyOneYear.required, source: "Expected" },
        { value: dyTwoYear.required, source: "Expected" },
        { value: dyThreeYear.delivered, source: "Actual" },
      ];

  return {
    scheduleYearNumber: dyThreeYear.yearIndex,
    deliveryYearOne: values[0]!.value,
    deliveryYearTwo: values[1]!.value,
    deliveryYearThree: values[2]!.value,
    deliveryYearOneSource: values[0]!.source,
    deliveryYearTwoSource: values[1]!.source,
    deliveryYearThreeSource: values[2]!.source,
    rollingAverage: Math.floor((values[0]!.value + values[1]!.value + values[2]!.value) / 3),
    expectedRecs: dyThreeYear.required,
  };
}
