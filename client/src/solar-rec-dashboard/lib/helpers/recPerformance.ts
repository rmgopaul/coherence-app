/**
 * Pure helpers shared across the REC performance spine tabs —
 * Forecast, Performance Evaluation, and Snapshot Log.
 *
 * `deriveRecPerformanceThreeYearValues` lives in
 * `@shared/solarRecPerformanceRatio` so the server aggregator and the
 * client tabs share one source of truth (re-exported below for back-
 * compat — call sites import from this file).
 *
 * `buildDeliveryYearLabel` + `buildRecReviewDeliveryYearLabel` stay
 * client-local on purpose. The shared versions of these label builders
 * use `start.toISOString().slice(0, 10)` for the "we have a parsed
 * `start` but no `startRaw`" fallback — the right format for server-
 * side aggregation where consistent ISO output matters. The client UI
 * fallback uses `formatDate(start)` (locale-formatted, e.g. "Jun 1,
 * 2024") so the visible label matches the rest of the dashboard's
 * date rendering. The fallback path is theoretical (in practice
 * `start` is always parsed from `startRaw`, so the path 3 branch
 * fires first) but the divergence is preserved deliberately. If
 * anyone unifies these in the future, port the locale-formatted
 * fallback into shared via a render-side adapter, not by changing
 * shared.
 */

import { formatDate } from "@/solar-rec-dashboard/lib/helpers/formatting";

export { deriveRecPerformanceThreeYearValues } from "@shared/solarRecPerformanceRatio";

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
