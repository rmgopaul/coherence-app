/**
 * Date-math helpers. Range truncation, month-window alignment, and
 * the prorated expected-production calculation used by Performance
 * Ratio + Forecast tabs.
 */

import {
  DAY_MS,
  STALE_UPLOAD_DAYS,
} from "@/solar-rec-dashboard/lib/constants";

export function toStartOfDay(value: Date): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  );
}

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

export function calculateExpectedWhForRange(
  monthlyKwh: number[],
  startDate: Date,
  endDate: Date,
): number | null {
  if (monthlyKwh.length !== 12) return null;
  const start = toStartOfDay(startDate);
  const end = toStartOfDay(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return null;
  if (end <= start) return 0;

  let cursor = start;
  let expectedWh = 0;

  while (cursor < end) {
    const monthStart = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      1,
    );
    const monthEnd = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      1,
    );
    const segmentEnd = monthEnd < end ? monthEnd : end;
    const dayCount =
      (segmentEnd.getTime() - cursor.getTime()) / DAY_MS;
    const daysInMonth =
      (monthEnd.getTime() - monthStart.getTime()) / DAY_MS;
    const monthlyValueKwh = monthlyKwh[cursor.getMonth()] ?? 0;
    expectedWh +=
      (monthlyValueKwh * 1_000 * dayCount) / daysInMonth;
    cursor = segmentEnd;
  }

  return Number.isFinite(expectedWh) ? expectedWh : null;
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
