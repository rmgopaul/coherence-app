/**
 * Pure helpers for the broadsheet Masthead — extracted so they can be
 * unit-tested without React.
 *
 * The wireframe (handoff D1 §STRIP) renders a top inverted strip:
 *
 *   ● PRODUCTIVITY HUB · VOL XIV · ISSUE 109     SUN · APR 19 · 2026 · CST
 *
 * VOL is years since the project's launch year (2012). ISSUE is days
 * since the current user's account was created — that way the number
 * grows on its own without anyone having to maintain a counter.
 */

const PROJECT_LAUNCH_YEAR = 2012;
const VOL_MAX_YEARS = 20; // cap at XX so the roman numeral stays readable
const ISSUE_MAX = 9999;

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * Convert a small positive integer to a Roman numeral. Handles 1–4000
 * but we cap at VOL_MAX_YEARS (20) before calling.
 *
 * Returns "—" for invalid input so the masthead never shows NaN.
 */
export function toRomanNumeral(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const n = Math.floor(value);
  const table: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let remaining = n;
  let out = "";
  for (const [arabic, roman] of table) {
    while (remaining >= arabic) {
      out += roman;
      remaining -= arabic;
    }
  }
  return out;
}

/**
 * Volume = clamp(currentYear - 2012, 1, 20), in Roman.
 */
export function computeVolume(now: Date): string {
  const years = now.getFullYear() - PROJECT_LAUNCH_YEAR;
  const clamped = Math.min(Math.max(years, 1), VOL_MAX_YEARS);
  return toRomanNumeral(clamped);
}

/**
 * Issue = days since the user's account creation, padded to ≥3 digits.
 *
 * Falls back to days since the project launch when no createdAt is
 * available (new sessions, signed-out preview, etc.) — better than
 * showing "ISSUE 1" for everyone who lands on /dashboard fresh.
 */
export function computeIssueNumber(
  now: Date,
  accountCreatedAt: Date | string | null | undefined
): string {
  const fallback = new Date(`${PROJECT_LAUNCH_YEAR}-01-01T00:00:00Z`);
  let anchor: Date;
  if (accountCreatedAt instanceof Date) {
    anchor = accountCreatedAt;
  } else if (typeof accountCreatedAt === "string" && accountCreatedAt) {
    const parsed = new Date(accountCreatedAt);
    anchor = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  } else {
    anchor = fallback;
  }
  const ms = now.getTime() - anchor.getTime();
  const days = Math.max(1, Math.floor(ms / 86_400_000));
  const capped = Math.min(days, ISSUE_MAX);
  return capped.toString().padStart(3, "0");
}

/**
 * "SUN · APR 19 · 2026" — short broadsheet date strip.
 */
export function formatBroadsheetDate(now: Date): string {
  return `${DAY_NAMES[now.getDay()]} · ${MONTH_NAMES[now.getMonth()]} ${now.getDate()} · ${now.getFullYear()}`;
}

/**
 * Best-effort timezone abbreviation ("CST", "PDT", "GMT+9", …).
 * Falls back to the browser's offset when Intl can't resolve a name.
 */
export function getTimezoneAbbreviation(now: Date): string {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZoneName: "short",
    }).format(now);
    const parts = formatted.split(" ");
    const abbr = parts[parts.length - 1];
    if (abbr && /^[A-Z]/.test(abbr)) return abbr;
  } catch {
    // Intl not available or browser refused timeZoneName — fall through.
  }
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offsetMin) / 60);
  return `GMT${sign}${hours}`;
}
