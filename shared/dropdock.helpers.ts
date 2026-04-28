/**
 * DropDock URL classification + canonicalization helpers.
 *
 * Pure functions — no DOM, no fetch — so they can be reused server-side
 * (the dockRouter normalizes inbound URLs the same way the client
 * does, which is what gives us a stable unique-by-(userId, urlCanonical)
 * key) and unit-tested in isolation.
 *
 * Sources we recognize, mirroring the existing dockRouter.getItemDetails
 * mutation in server/routers/personalData.ts:
 *
 *   gmail   — mail.google.com (extracts hash messageId)
 *   gcal    — calendar.google.com OR www.google.com/calendar/...
 *             (the latter is the format Google Calendar API's
 *             `htmlLink` field returns; both extract `?eid`)
 *   gsheet  — docs.google.com/spreadsheets/
 *   todoist — todoist.com (extracts /showTask/<id> or /task/<id>)
 *   url     — anything else
 */

export type DockSource = "gmail" | "gcal" | "gsheet" | "todoist" | "url";

export interface ClassifiedUrl {
  source: DockSource;
  url: string;
  /** Stable lowercase form used for the (userId, urlCanonical) unique key. */
  urlCanonical: string;
  /** Source-specific metadata extracted from the URL. */
  meta: Record<string, string>;
}

/**
 * Tracking parameters that we strip when computing the canonical form.
 * Pasting `https://example.com/?utm_source=foo` and `https://example.com/`
 * should resolve to the same dock chip.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref",
  "ref_src",
]);

/**
 * Query parameters that typically carry short-lived credentials or
 * OAuth/CSRF state. Stripped from the canonical form so dedup ignores
 * them (two pastes of the same page with rotating tokens collapse to
 * one chip), and exposed to the UI via `hasSensitiveParams` so callers
 * can warn the user before they store a URL that leaks a credential.
 */
export const SENSITIVE_PARAMS = new Set([
  "token",
  "access_token",
  "code",
  "state",
  "sig",
  "auth",
  "key",
]);

function stripParams(u: URL, blocklist: Set<string>): URL {
  const out = new URL(u.toString());
  // Snapshot keys via forEach to avoid downlevelIteration on the
  // URLSearchParamsIterator (server tsconfig doesn't allow direct iter).
  const keys: string[] = [];
  out.searchParams.forEach((_value, key) => {
    keys.push(key);
  });
  for (const key of keys) {
    if (blocklist.has(key)) out.searchParams.delete(key);
  }
  return out;
}

/**
 * True when the URL carries at least one query parameter from
 * `SENSITIVE_PARAMS`. Intended for UI paste handlers so they can
 * warn the user that they're about to save a URL with a credential.
 */
export function hasSensitiveParams(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    // Iterate via forEach to sidestep the server tsconfig's
    // no-downlevelIteration restriction on Set<string>.
    let found = false;
    u.searchParams.forEach((_value, key) => {
      if (SENSITIVE_PARAMS.has(key)) found = true;
    });
    return found;
  } catch {
    return false;
  }
}

/**
 * Returns the URL with scheme + host lowercased, tracking params removed,
 * trailing slashes on the path normalized, and the hash kept (Gmail uses
 * the hash to identify a message thread).
 */
export function canonicalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Not a parseable URL — fall back to lowercase trimmed string so the
    // unique constraint still de-duplicates plain text pastes.
    return trimmed.toLowerCase();
  }
  u = stripParams(u, TRACKING_PARAMS);
  u = stripParams(u, SENSITIVE_PARAMS);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // Drop a single trailing slash on the pathname (but never on bare "/").
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/**
 * Classify a URL into a DockSource and pull out source-specific metadata.
 *
 * Returns `source: "url"` with empty meta for anything we don't
 * specifically recognize — those still render as a chip.
 */
export function classifyUrl(input: string): ClassifiedUrl {
  const url = input.trim();
  const urlCanonical = canonicalizeUrl(url);
  const empty: ClassifiedUrl = {
    source: "url",
    url,
    urlCanonical,
    meta: {},
  };
  if (!url) return empty;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return empty;
  }
  const host = parsed.hostname.toLowerCase();

  // ---- Gmail: mail.google.com/mail/u/0/#inbox/<MSGID>
  if (host === "mail.google.com") {
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const messageId = hash.split("/").pop() ?? "";
    const meta: Record<string, string> = {};
    if (messageId) meta.messageId = messageId;
    return { source: "gmail", url, urlCanonical, meta };
  }

  // ---- Google Calendar
  // Two URL shapes both classify as gcal:
  //   1. calendar.google.com/...?eid=<base64> — the standard
  //      "open calendar" deep link
  //   2. www.google.com/calendar/event?eid=<base64> — the format
  //      Google Calendar API's `htmlLink` field returns. Without
  //      this branch, dropping a calendar event chip via paste
  //      misses enrichment and the chip falls back to displaying
  //      the raw URL.
  const isGoogleCalendarHtmlLink =
    (host === "www.google.com" || host === "google.com") &&
    parsed.pathname.startsWith("/calendar");
  if (host === "calendar.google.com" || isGoogleCalendarHtmlLink) {
    const eid = parsed.searchParams.get("eid");
    const meta: Record<string, string> = {};
    if (eid) meta.eid = eid;
    return { source: "gcal", url, urlCanonical, meta };
  }

  // ---- Google Sheets: docs.google.com/spreadsheets/d/<ID>/...
  if (host === "docs.google.com" && parsed.pathname.startsWith("/spreadsheets/")) {
    const segments = parsed.pathname.split("/").filter(Boolean);
    const idIdx = segments.indexOf("d");
    const meta: Record<string, string> = {};
    if (idIdx >= 0 && segments[idIdx + 1]) meta.spreadsheetId = segments[idIdx + 1];
    return { source: "gsheet", url, urlCanonical, meta };
  }

  // ---- Todoist: todoist.com/showTask?id=<ID>  OR  todoist.com/app/task/<ID>
  if (host === "todoist.com" || host.endsWith(".todoist.com")) {
    const meta: Record<string, string> = {};
    const idQuery = parsed.searchParams.get("id");
    if (idQuery) meta.taskId = idQuery;
    const segs = parsed.pathname.split("/").filter(Boolean);
    const taskIdx = segs.indexOf("task");
    if (!meta.taskId && taskIdx >= 0 && segs[taskIdx + 1]) {
      meta.taskId = segs[taskIdx + 1];
    }
    return { source: "todoist", url, urlCanonical, meta };
  }

  return empty;
}

/**
 * Match a Markdown-style hyperlink anywhere in a string.
 *
 * Many apps (Todoist, Linear, Slack mobile) "Copy task link" produce
 * a Markdown-shaped clipboard payload like
 * `[Read sprint plan](https://todoist.com/showTask?id=12345)`. The
 * URL classifier can't parse that as a URL, so without this helper
 * the dock chip ends up as a raw `url` source with the literal
 * `[…](…)` text as the title.
 *
 * Returns the FIRST match's `{title, url}` or `null`. Pure — exposed
 * for testability.
 *
 * Phase E (2026-04-28) — fix for "dock chips show raw markdown."
 */
export function extractMarkdownLink(
  text: string
): { title: string; url: string } | null {
  if (typeof text !== "string") return null;
  // [title](url) — title can include any non-`]` character; url
  // can include any non-`)` character. Both required, both
  // non-empty after trim. We use a non-greedy match on the title
  // so a string like "[a](b) [c](d)" picks "a"/"b" not "a](b) [c"/"d".
  const match = /\[([^\]]+?)\]\(([^)]+?)\)/.exec(text);
  if (!match) return null;
  const title = match[1].trim();
  const url = match[2].trim();
  if (!title || !url) return null;
  return { title, url };
}

/**
 * Friendly fallback label for a dock chip when the title resolved
 * to null (enrichment failed: token expired, source unrecognized,
 * upstream API down, etc.).
 *
 * Background: the `getItemDetails` proc returns `{title: null}` on
 * any unresolved-title path so the chip renderer can decide what to
 * surface. Initially the chip rendered the raw URL on null, which
 * gives the user something clickable but is awful to read on a
 * 200-character calendar `htmlLink`. This helper picks a label from
 * the source kind so a "Calendar event" beats a 200-char URL —
 * still clickable, but readable in the chip strip.
 *
 * For unclassified URLs we try to extract host + first path segment
 * since "host/path" is far more useful than the full query/hash
 * tail. Falls back to a 60-char URL truncation if URL parsing
 * itself fails.
 *
 * Pure. Exposed for testability.
 */
export function chipFallbackLabel(source: DockSource, url: string): string {
  switch (source) {
    case "gmail":
      return "Gmail message";
    case "gcal":
      return "Calendar event";
    case "gsheet":
      return "Spreadsheet";
    case "todoist":
      return "Todoist task";
    case "url":
    default: {
      try {
        const u = new URL(url);
        const path = u.pathname === "/" ? "" : u.pathname;
        const composed = `${u.host}${path}`;
        return composed.length > 60
          ? `${composed.slice(0, 57)}…`
          : composed;
      } catch {
        return url.length > 60 ? `${url.slice(0, 57)}…` : url;
      }
    }
  }
}

/**
 * Replace every `[label](url)` substring in `text` with just
 * `label`. Used both as a defensive client-side chip-render step
 * (so old rows with unstripped markdown still render cleanly)
 * and server-side inside `getItemDetails` to clean Todoist task
 * content before persisting.
 *
 * Pure — exposed for testability. Idempotent: applying twice
 * produces the same result.
 */
export function stripMarkdownLinks(text: string): string {
  if (typeof text !== "string" || !text) return "";
  return text.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, "$1");
}

/**
 * Phase E (2026-04-28) — Cmd+C / Ctrl+C handler for the focused
 * dock chip.
 *
 * Default browser behavior on a focused `<a>` is "copy the
 * selection," and a chip's selection at rest is empty — so Cmd+C
 * silently does nothing. The intuitive expectation (per the Phase
 * E backlog: "Cmd+C copies dock chip URL") is that pressing the
 * shortcut while a chip is focused puts the chip's URL on the
 * clipboard, ready to paste somewhere.
 *
 * This helper computes whether the keydown qualifies as a
 * "URL copy intent." Returns `true` when:
 *   - The key is `c` (case-insensitive — `C` while shift is held
 *     would be the Capital-C shortcut, which we still honor)
 *   - Exactly one of `metaKey` / `ctrlKey` is held (covers macOS
 *     Cmd+C and Windows / Linux Ctrl+C)
 *   - No `altKey` (Option+C is a unicode-input combo)
 *   - The user does NOT have non-empty text selected within the
 *     chip — that's the "I want to copy a label fragment" intent
 *     and we shouldn't hijack it
 *
 * `getSelection` defaults to `window.getSelection` but is
 * injectable for tests (jsdom-free unit tests use a stub).
 *
 * Pure — exposed for testability.
 */
export interface DockChipCopyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

export function shouldCopyDockChipUrl(
  event: DockChipCopyEvent,
  getSelection: () => string | null = () =>
    typeof window !== "undefined" && typeof window.getSelection === "function"
      ? (window.getSelection()?.toString() ?? "")
      : ""
): boolean {
  if (event.altKey) return false;
  if (event.key !== "c" && event.key !== "C") return false;
  // XOR: exactly one of meta/ctrl, not both, not neither.
  const modifierExclusive =
    Boolean(event.metaKey) !== Boolean(event.ctrlKey);
  if (!modifierExclusive) return false;
  // Don't hijack when the user has actively selected text — they
  // want the default "copy selection" behavior.
  const selected = getSelection();
  if (selected && selected.trim().length > 0) return false;
  return true;
}

/**
 * Phase E (2026-04-28) — due-date categorization for the
 * dashboard's "Upcoming" strip and the chip's near-due visual cue.
 *
 *   overdue   — dueAt is in the past
 *   due-soon  — dueAt is within the next 4 hours
 *   upcoming  — dueAt is within the next 24 hours
 *   future    — dueAt is later than 24 hours from now
 *   none      — no dueAt set (chip is just a bookmark)
 *
 * Pure — exposed for testability. Accepts an injectable `now`
 * so tests can pin "current time" without faking Date globally.
 */
export type DockDueCategory =
  | "overdue"
  | "due-soon"
  | "upcoming"
  | "future"
  | "none";

export function categorizeDockDueDate(
  dueAt: Date | string | null | undefined,
  now: Date = new Date()
): DockDueCategory {
  if (!dueAt) return "none";
  const dueMs =
    dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();
  if (!Number.isFinite(dueMs)) return "none";
  const diff = dueMs - now.getTime();
  if (diff < 0) return "overdue";
  if (diff <= 4 * 3_600_000) return "due-soon";
  if (diff <= 24 * 3_600_000) return "upcoming";
  return "future";
}

/**
 * Phase E (2026-04-28) — short human-readable label for the
 * chip's due-date pill and the dashboard reminders strip.
 *
 *   "12m overdue"   — past, less than an hour ago
 *   "3h overdue"    — past, less than a day ago
 *   "2d overdue"    — past, more than a day ago
 *   "in 38m"        — under an hour away
 *   "in 5h"         — under a day away
 *   "Tomorrow 9am"  — same day or next day, with the hour
 *   "Mon 6pm"       — within the next 6 days, day name + hour
 *   "Apr 30"        — further out, month + day
 *
 * Pure — exposed for testability. The label drops minutes once
 * the gap is greater than ~6 hours so the chip text doesn't
 * jitter every minute on long-horizon reminders.
 */
export function formatDockDueLabel(
  dueAt: Date | string | null | undefined,
  now: Date = new Date()
): string {
  if (!dueAt) return "";
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  const dueMs = due.getTime();
  if (!Number.isFinite(dueMs)) return "";
  const diff = dueMs - now.getTime();
  const absMs = Math.abs(diff);
  const hours = Math.floor(absMs / 3_600_000);
  const minutes = Math.floor(absMs / 60_000);
  const days = Math.floor(absMs / 86_400_000);

  if (diff < 0) {
    if (minutes < 60) return `${Math.max(1, minutes)}m overdue`;
    if (hours < 24) return `${hours}h overdue`;
    return `${days}d overdue`;
  }

  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  if (hours < 6) return `in ${hours}h`;

  // Within a week → day name + hour. Otherwise month + day.
  const sameDay = sameLocalDay(due, now);
  const tomorrow = sameLocalDay(
    due,
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  );
  if (sameDay) return `Today ${formatHour(due)}`;
  if (tomorrow) return `Tomorrow ${formatHour(due)}`;
  if (days <= 6) return `${formatWeekday(due)} ${formatHour(due)}`;
  return formatMonthDay(due);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatHour(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "am" : "pm";
  const display = ((h + 11) % 12) + 1; // 0→12, 13→1, etc.
  if (m === 0) return `${display}${suffix}`;
  const mm = m.toString().padStart(2, "0");
  return `${display}:${mm}${suffix}`;
}

function formatWeekday(d: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function formatMonthDay(d: Date): string {
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()];
  return `${month} ${d.getDate()}`;
}

/**
 * Given a clipboard-paste or drag-drop payload, extract the most
 * URL-looking string. Drops handlers receive a DataTransfer that may
 * contain `text/uri-list`, `text/plain`, or `application/json` — try
 * them in that order.
 */
export function extractUrlFromPaste(text: string): string {
  // Some apps (Slack, Linear) drop a JSON blob with a `url` field.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.url === "string") return parsed.url.trim();
      if (Array.isArray(parsed) && typeof parsed[0]?.url === "string") {
        return String(parsed[0].url).trim();
      }
    } catch {
      // fall through to plain-text handling.
    }
  }
  // text/uri-list lets one-per-line URLs be pasted; take the first
  // non-comment line.
  const firstUrlLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  const candidate = firstUrlLine ?? trimmed;

  // Phase E (2026-04-28) — markdown-paste support. If the candidate
  // is a `[title](url)` blob (or contains one as a prefix/sole
  // element), peel it down to just the URL so the classifier can
  // do its job. The title is recovered separately via
  // `extractMarkdownLink` from the original paste text in the
  // DropDock handler.
  const md = extractMarkdownLink(candidate);
  if (md) return md.url;
  return candidate;
}
