/**
 * Personal contacts pure helpers — Phase E (2026-04-28).
 *
 * Used by the front-page Contacts overlay. No DOM, no DB — just
 * data shaping over the row shape returned by `contacts.list`.
 * Exposed for testability and so a future server-side rollup
 * (e.g. "people who haven't been contacted in 30+ days") can reuse
 * the same bucketing logic.
 */

/**
 * Staleness buckets for the "Reach out" UI grouping. Order
 * matches what the overlay renders top-to-bottom: stale and never
 * surface first because they're the actionable ones.
 */
export const CONTACT_STALENESS = [
  "stale",
  "never",
  "this-month",
  "this-week",
  "today",
] as const;

export type ContactStaleness = (typeof CONTACT_STALENESS)[number];

export interface ContactRow {
  id: string;
  userId: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  company: string | null;
  notes: string | null;
  tags: string | null;
  lastContactedAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

/**
 * Bucket a contact by recency of `lastContactedAt`:
 *
 *   today       — stamped today (local-day boundary)
 *   this-week   — within the last 7 days (excluding today)
 *   this-month  — within the last 30 days (excluding the week)
 *   stale       — more than 30 days ago
 *   never       — no contact event recorded
 *
 * Pure — exposed for testability. Accepts ISO strings (the wire
 * format) as well as Date instances so the overlay can pass through
 * tRPC payloads directly.
 */
export function categorizeContactStaleness(
  lastContactedAt: Date | string | null | undefined,
  now: Date = new Date()
): ContactStaleness {
  if (!lastContactedAt) return "never";
  const d =
    lastContactedAt instanceof Date
      ? lastContactedAt
      : new Date(lastContactedAt);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "never";
  const diffDays = (now.getTime() - t) / 86_400_000;
  if (diffDays < 0) return "today"; // future stamp → bucket as "today"
  if (sameLocalDay(d, now)) return "today";
  if (diffDays < 7) return "this-week";
  if (diffDays < 30) return "this-month";
  return "stale";
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Render `lastContactedAt` as a short human label.
 *
 *   "Today"
 *   "Yesterday"
 *   "3 days ago"
 *   "2 weeks ago"
 *   "1 month ago"
 *   "Never"
 *
 * Pure — exposed for testability.
 */
export function formatLastContactedLabel(
  lastContactedAt: Date | string | null | undefined,
  now: Date = new Date()
): string {
  if (!lastContactedAt) return "Never";
  const d =
    lastContactedAt instanceof Date
      ? lastContactedAt
      : new Date(lastContactedAt);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "Never";
  if (t > now.getTime()) return "Today";
  if (sameLocalDay(d, now)) return "Today";
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1
  );
  if (sameLocalDay(d, yesterday)) return "Yesterday";
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/**
 * Free-form filter over a contact list. Empty / whitespace `query`
 * is a no-op. Matches case-insensitively against `name`, `email`,
 * `company`, `role`, `tags`, and `notes` so a search for "acme"
 * finds rows where Acme is the company OR appears in the notes.
 *
 * Pure — exposed for testability.
 */
export function filterContacts(
  rows: readonly ContactRow[],
  query: string
): ContactRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((row) => {
    const haystack = [
      row.name,
      row.email ?? "",
      row.company ?? "",
      row.role ?? "",
      row.tags ?? "",
      row.notes ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Group contacts into the staleness buckets so the overlay can
 * render section headers. Buckets that contain zero rows are
 * still present in the result (with empty arrays) so the caller
 * can decide whether to render the header anyway.
 *
 * Pure — exposed for testability.
 */
export function groupContactsByStaleness(
  rows: readonly ContactRow[],
  now: Date = new Date()
): Record<ContactStaleness, ContactRow[]> {
  const out: Record<ContactStaleness, ContactRow[]> = {
    stale: [],
    never: [],
    "this-month": [],
    "this-week": [],
    today: [],
  };
  for (const row of rows) {
    const bucket = categorizeContactStaleness(row.lastContactedAt, now);
    out[bucket].push(row);
  }
  return out;
}

/**
 * Split a comma-separated tags string into individual tags, with
 * each tag trimmed and lowercased. Empty tags are dropped. Pure
 * — exposed for testability and so the proc layer can normalize
 * inputs identically.
 */
export function parseContactTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}
