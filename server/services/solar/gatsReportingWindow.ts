/**
 * GATS Generation Window helpers (2026-05-14) — pure date math, no
 * DB, no clock side effects.
 *
 * A GATS Generation Window is named after a calendar month (e.g.
 * "April Generation Window"). The window OPENS on the last business
 * day (Mon-Fri, no holiday handling) of its named month and COVERS
 * the date range [the 16th of the named month, the 15th of the next
 * month]. The currently-active window is determined by today's date:
 * the most recent last-business-day-of-month ≤ today names the
 * current window.
 *
 * Worked example. Today = 2026-05-14.
 *   - Last business day of April 2026 = Thursday April 30, 2026.
 *   - Last business day of May 2026 = Friday May 29, 2026.
 *   - April 30 ≤ May 14 < May 29, so the current window is
 *     "April Generation Window", covering April 16 – May 15, 2026.
 *
 * Worked example. Today = 2026-05-29.
 *   - Last business day of May 2026 = Friday May 29, 2026.
 *   - May 29 ≤ May 29, so the current window is "May Generation
 *     Window", covering May 16 – June 15, 2026.
 *
 * The helpers are intentionally narrow: the Overview tile only ever
 * needs the current window, and per-date windowId lookup is what the
 * foundation builder calls during its single-pass generation walks.
 * Holiday calendars / business-day variants belong to the future
 * "show non-Part-II reporting" extension if it ever ships.
 */

import { parseIsoDate } from "./helpers";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export type GatsReportingWindow = {
  /** Stable identifier — "yyyy-mm" of the named month. */
  id: string;
  /** Display label e.g. "April Generation Window". */
  label: string;
  /** Year of the named month. */
  namedYear: number;
  /** Month number 1-12 (April = 4). */
  namedMonth: number;
  /** ISO date of the first of the named month — generationEntry check. */
  generationEntryDateIso: string; // "yyyy-mm-01"
  /** Window start (inclusive). */
  windowStartIso: string; // "yyyy-mm-16"
  /** Window end (inclusive). */
  windowEndIso: string; // "yyyy-(mm+1)-15"
  /** Last business day of the named month — the date the window opens. */
  openDateIso: string;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoFromYmd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function daysInMonth(year: number, month: number): number {
  // JS quirk: day 0 of `month + 1` is the last day of `month`.
  return new Date(year, month, 0).getDate();
}

/**
 * Last business day of `(year, month)` — Mon-Fri only, no holiday
 * handling. Walks back from the last calendar day skipping Sat/Sun.
 *
 * Returned `Date` is constructed in **local time** at midnight. The
 * server runs in `TZ=America/Chicago` per `vitest.config.ts`. The
 * comparison done by `getCurrentGatsReportingWindow` uses Date
 * timestamps so DST shifts don't matter — both sides of the
 * comparison share the same timezone offset by construction.
 *
 * `month` is 1-12 (the spec convention), NOT 0-11 (JS convention).
 */
export function lastBusinessDayOfMonth(year: number, month: number): Date {
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`lastBusinessDayOfMonth: invalid year/month: ${year}/${month}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`lastBusinessDayOfMonth: month out of range: ${month}`);
  }
  let day = daysInMonth(year, month);
  // Walk back skipping Sat (6) and Sun (0).
  let candidate = new Date(year, month - 1, day);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    day -= 1;
    candidate = new Date(year, month - 1, day);
  }
  return candidate;
}

function makeWindow(year: number, month: number): GatsReportingWindow {
  const id = `${year}-${pad2(month)}`;
  const label = `${MONTH_NAMES[month - 1]} Generation Window`;
  const generationEntryDateIso = isoFromYmd(year, month, 1);
  const windowStartIso = isoFromYmd(year, month, 16);
  // Window end = 15th of the NEXT calendar month.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const windowEndIso = isoFromYmd(nextYear, nextMonth, 15);
  const open = lastBusinessDayOfMonth(year, month);
  const openDateIso = isoFromYmd(
    open.getFullYear(),
    open.getMonth() + 1,
    open.getDate()
  );
  return {
    id,
    label,
    namedYear: year,
    namedMonth: month,
    generationEntryDateIso,
    windowStartIso,
    windowEndIso,
    openDateIso,
  };
}

/**
 * Given a `today` Date, return the current GATS reporting window.
 *
 * Algorithm:
 *   - `lastBdayPrevMonth` = last business day of (today.year, today.month - 1)
 *   - `lastBdayThisMonth` = last business day of (today.year, today.month)
 *   - If today >= lastBdayThisMonth → window named after today's month is
 *     current (e.g. May 29 → "May Generation Window").
 *   - Else → window named after the PREVIOUS month is current (e.g. May
 *     14 → "April Generation Window").
 *
 * The handoff therefore happens at the boundary of `lastBdayThisMonth`:
 * the moment the user crosses past the last business day, the windowId
 * changes and the cached slim summary invalidates (its cache key embeds
 * the windowId).
 *
 * Tests live in `gatsReportingWindow.test.ts`.
 */
export function getCurrentGatsReportingWindow(
  today: Date
): GatsReportingWindow {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) {
    throw new Error("getCurrentGatsReportingWindow: invalid today Date");
  }
  const year = today.getFullYear();
  const month = today.getMonth() + 1; // 1-12
  const lastBdayThis = lastBusinessDayOfMonth(year, month);
  // Compare at day-level resolution. `today` may carry a time-of-day
  // (e.g. 2026-05-14T18:00 from `new Date()`); the spec is "find the
  // most recent last-business-day-of-month ≤ today". A timestamp at
  // any time on lastBdayThis must satisfy that, so we strip times by
  // comparing the **date** components only.
  const todayYmd = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const thisYmd =
    lastBdayThis.getFullYear() * 10000 +
    (lastBdayThis.getMonth() + 1) * 100 +
    lastBdayThis.getDate();

  if (todayYmd >= thisYmd) {
    return makeWindow(year, month);
  }
  // Window named after the previous month is current.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return makeWindow(prevYear, prevMonth);
}

/**
 * Build a `GatsReportingWindow` from its `(year, month)` pair. Useful
 * when a per-date windowId lookup yields the id and the caller wants
 * the full descriptor (e.g., to surface the label in a UI tile).
 */
export function getReportingWindowForNamedMonth(
  year: number,
  month: number
): GatsReportingWindow {
  return makeWindow(year, month);
}

/**
 * Given an ISO date string `yyyy-mm-dd`, return the windowId
 * (`"yyyy-mm"`) of the window that contains it per the spec — window
 * N covers month N's 16th through month N+1's 15th.
 *
 *   "2026-04-20" → "2026-04" (April window covers 4/16-5/15)
 *   "2026-04-10" → "2026-03" (March window covers 3/16-4/15)
 *   "2026-04-16" → "2026-04" (start-of-window edge case)
 *   "2026-05-15" → "2026-04" (end-of-window edge case)
 *   "2026-05-16" → "2026-05" (start of next window)
 *
 * Returns `null` if the input is not a valid `yyyy-mm-dd` ISO date.
 */
export function windowIdForDate(isoDate: string): string | null {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return null;
  const { year, month, day } = parsed;
  if (day >= 16) {
    // Within the window named after the current month.
    return `${year}-${pad2(month)}`;
  }
  // day <= 15 — within the window named after the PREVIOUS month.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${pad2(prevMonth)}`;
}
