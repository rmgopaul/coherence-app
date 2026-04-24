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
