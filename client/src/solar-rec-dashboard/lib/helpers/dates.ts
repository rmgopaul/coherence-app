/**
 * Date-math helpers. Range truncation, month-window alignment, and
 * the prorated expected-production calculation used by Performance
 * Ratio + Forecast tabs.
 */

import {
  DAY_MS,
  STALE_UPLOAD_DAYS,
} from "@/solar-rec-dashboard/lib/constants";

// `toStartOfDay` and `calculateExpectedWhForRange` live in
// `@shared/solarRecPerformanceRatio` so the server aggregator and
// this tab share one implementation. Re-exported here so existing
// call sites don't change.
export {
  toStartOfDay,
  calculateExpectedWhForRange,
} from "@shared/solarRecPerformanceRatio";

export function toReadWindowMonthStart(value: Date): Date {
  if (value.getDate() <= 15) {
    return new Date(
      value.getFullYear(),
      value.getMonth() - 1,
      1,
    );
  }
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

export function maxDate(
  current: Date | null,
  candidate: Date | null,
): Date | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

export function isStaleUpload(
  uploadedAt: Date | null | undefined,
  thresholdDays = STALE_UPLOAD_DAYS,
): boolean {
  if (!uploadedAt) return true;
  const ageMs = Date.now() - uploadedAt.getTime();
  return ageMs > thresholdDays * DAY_MS;
}
