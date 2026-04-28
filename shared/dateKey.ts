/**
 * Canonical YYYY-MM-DD date-key helpers.
 *
 * The app used to re-implement this formatter roughly once per file —
 * 20+ copies of `${y}-${m}-${d}` with padStart(2, "0"). Small variations
 * (timezone handling, UTC vs local) crept in and were easy to confuse.
 * Everything that needs a YYYY-MM-DD key should import from here.
 *
 * Defaults to the caller's local time zone because that's what every
 * existing consumer expects. Pass `tz` when you need a specific IANA
 * zone (e.g., America/Chicago for server-side cross-user consistency).
 */

/** YYYY-MM-DD key for the given Date, in local time unless `tz` is set. */
export function toDateKey(date: Date, tz?: string): string {
  if (tz) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "00";
    const d = parts.find((p) => p.type === "day")?.value ?? "00";
    return `${y}-${m}-${d}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Today's YYYY-MM-DD key. Thin shortcut over toDateKey(new Date()). */
export function formatTodayKey(tz?: string): string {
  return toDateKey(new Date(), tz);
}

/**
 * Value for an HTML `<input type="date">` — same YYYY-MM-DD shape, but
 * the semantic is "picker form value," not "archive key." Kept as its
 * own function so the two intents stay distinguishable at call sites.
 */
export function formatDateInput(date: Date): string {
  return toDateKey(date);
}

/**
 * ISO week key for a date, e.g. "2026-W17". Matches the shape used by
 * `weeklyReviews.weekKey` so `(toIsoWeekKey(d), weekRangeFromKey(k))`
 * round-trip cleanly.
 *
 * Implementation: ISO 8601 — week 1 is the week containing the first
 * Thursday of the year. Mondays start the week. We compute the
 * "Thursday-anchored year" + the week number against that year's
 * first Thursday.
 *
 * Used by Phase E AI Weekly Review (2026-04-28).
 */
export function toIsoWeekKey(date: Date): string {
  // Snap to the UTC calendar date of the input. Using `getUTC*` here
  // (rather than `getFullYear` etc.) means the result is independent
  // of the runtime time zone — important because the daily-snapshot
  // pipeline keys by UTC dateKey, not local.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // Set to nearest Thursday: current date + 4 - (day || 7).
  // Day-of-week with Sunday=7 (so Monday=1, Sunday=7).
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Inverse of `toIsoWeekKey`: returns the `(start, end)` Monday/Sunday
 * dateKeys for an ISO week. Returns null for malformed inputs so
 * callers can fall back gracefully.
 *
 * Used by the AI Weekly Review service to load the right range of
 * dailySnapshots for a given weekKey.
 */
export function weekRangeFromKey(
  weekKey: string
): { startDateKey: string; endDateKey: string } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(week) ||
    week < 1 ||
    week > 53
  ) {
    return null;
  }
  // ISO 8601: week 1 is the week containing the first Thursday of
  // the year. Equivalent: week 1 contains January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  // Monday of week 1: jan4 - (jan4Day - 1) days.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  // Monday of the requested week: + 7 * (week - 1) days.
  const weekStart = new Date(week1Monday);
  weekStart.setUTCDate(week1Monday.getUTCDate() + 7 * (week - 1));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  return {
    startDateKey: toDateKey(weekStart, "UTC"),
    endDateKey: toDateKey(weekEnd, "UTC"),
  };
}

/**
 * Generate the list of YYYY-MM-DD keys for every day in `[start, end]`
 * inclusive. Both endpoints in YYYY-MM-DD form. Returns an empty array
 * when end < start. Used by the weekly review service to enumerate
 * which dailySnapshots to fetch.
 */
export function dateKeysInRange(
  startDateKey: string,
  endDateKey: string
): string[] {
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDateKey);
  const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDateKey);
  if (!startMatch || !endMatch) return [];
  const start = new Date(
    Date.UTC(Number(startMatch[1]), Number(startMatch[2]) - 1, Number(startMatch[3]))
  );
  const end = new Date(
    Date.UTC(Number(endMatch[1]), Number(endMatch[2]) - 1, Number(endMatch[3]))
  );
  if (end.getTime() < start.getTime()) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    out.push(toDateKey(cursor, "UTC"));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
