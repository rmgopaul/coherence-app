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

/**
 * Render a coarse "X ago" string for a past timestamp. Designed for
 * "Last rebuilt:" labels and similar low-stakes age callouts where
 * the absolute time is shown alongside (so the relative string only
 * needs to communicate scale, not precision).
 *
 * Buckets:
 *   - <  10s   →  "just now"
 *   - <  60s   →  "Ns ago"
 *   - <  60m   →  "Nm ago"
 *   - <  24h   →  "Nh ago"
 *   - >= 24h   →  "Nd ago"
 *
 * Future timestamps (clock skew) clamp to "just now". `null` /
 * unparseable inputs return `null` so the caller can hide the row.
 *
 * `nowMs` is injectable for deterministic tests; defaults to
 * `Date.now()`.
 */
export function formatRelativeTime(
  target: Date | string | number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (target == null) return null;
  const targetMs =
    target instanceof Date
      ? target.getTime()
      : typeof target === "number"
        ? target
        : Date.parse(target);
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = nowMs - targetMs;
  if (diffMs < 10_000) return "just now";
  if (diffMs < 60_000) {
    const seconds = Math.floor(diffMs / 1_000);
    return `${seconds}s ago`;
  }
  if (diffMs < 60 * 60_000) {
    const minutes = Math.floor(diffMs / 60_000);
    return `${minutes}m ago`;
  }
  if (diffMs < 24 * 60 * 60_000) {
    const hours = Math.floor(diffMs / (60 * 60_000));
    return `${hours}h ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  return `${days}d ago`;
}
