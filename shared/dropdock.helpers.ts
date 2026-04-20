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
 *   gcal    — calendar.google.com (extracts ?eid)
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

function stripTrackingParams(u: URL): URL {
  const out = new URL(u.toString());
  // Snapshot keys via forEach to avoid downlevelIteration on the
  // URLSearchParamsIterator (server tsconfig doesn't allow direct iter).
  const keys: string[] = [];
  out.searchParams.forEach((_value, key) => {
    keys.push(key);
  });
  for (const key of keys) {
    if (TRACKING_PARAMS.has(key)) out.searchParams.delete(key);
  }
  return out;
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
  u = stripTrackingParams(u);
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

  // ---- Google Calendar: calendar.google.com/...?eid=<base64>
  if (host === "calendar.google.com") {
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
  return firstUrlLine ?? trimmed;
}
