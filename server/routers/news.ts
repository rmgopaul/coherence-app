/**
 * News router — Phase D.
 *
 * Default source: merged feed from AP + Google News Top Stories (both
 * free, unmetered RSS). Optional NewsAPI provider behind
 * `NEWS_FEED_MODE=newsapi` + `NEWSAPI_KEY`. Single-source modes
 * (`ap-rss` / `google`) still available for debugging or operator
 * preference.
 *
 * In-process 10-minute cache. Always returns a `NewsPayload` with
 * `items` + a `reason` discriminator — the client branches on the
 * reason to pick editorial empty-state copy ("slow news morning"
 * vs "wire went dark" vs "SET NEWSAPI_KEY").
 *
 * Env vars:
 *   NEWS_FEED_MODE = 'merged' | 'ap-rss' | 'google' | 'newsapi' | 'off'
 *                    (default: 'merged')
 *   NEWSAPI_KEY    = API key for newsapi.org (required when mode = 'newsapi')
 *
 * Spec: productivity-hub/handoff/new-integrations.md §"News"
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";

const AP_RSS_URL = "https://apnews.com/hub/ap-top-news.rss";
const GOOGLE_NEWS_RSS_URL =
  "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
const NEWS_API_URL = "https://newsapi.org/v2/top-headlines";
const CACHE_MS = 10 * 60_000;

export interface NewsItem {
  src: string;
  title: string;
  url: string;
  publishedAt: string;
}

/**
 * Reason codes surfaced alongside the headline list so the client can
 * distinguish "feed disabled" from "fetch failed" from "feed returned
 * zero items" — each gets its own editorial empty-state copy.
 *
 *   ok              — items present, no problem
 *   off             — NEWS_FEED_MODE=off (operator turned it off)
 *   no-api-key      — mode=newsapi but NEWSAPI_KEY not set
 *   no-items        — provider responded 200 but returned no articles
 *   fetch-failed    — network/parse error or upstream non-2xx
 *   upstream-401    — 401 from NewsAPI (key rejected)
 *   upstream-429    — 429 rate limit
 *   upstream-timeout — AbortSignal.timeout tripped
 */
export type NewsFetchReason =
  | "ok"
  | "off"
  | "no-api-key"
  | "no-items"
  | "fetch-failed"
  | "upstream-401"
  | "upstream-429"
  | "upstream-timeout";

export interface NewsPayload {
  items: NewsItem[];
  reason: NewsFetchReason;
}

let cachedPayload: { at: number; payload: NewsPayload } | null = null;

type NewsMode = "merged" | "ap-rss" | "google" | "newsapi" | "off";

function resolveMode(): NewsMode {
  const raw = (process.env.NEWS_FEED_MODE ?? "").trim().toLowerCase();
  if (raw === "newsapi") return "newsapi";
  if (raw === "off") return "off";
  if (raw === "ap-rss" || raw === "ap") return "ap-rss";
  if (raw === "google" || raw === "google-news") return "google";
  // Default to merged so AP + Google News flow without extra config.
  return "merged";
}

/* ------------------------------------------------------------------ */
/*  Inline RSS parser (no xml2js / fast-xml-parser dep)                */
/* ------------------------------------------------------------------ */

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = re.exec(block);
  return match ? decodeEntities(match[1]) : "";
}

/**
 * Google News wraps the source attribution inside a <source> tag
 * inside each <item>. Extract it so the UI can show "REUTERS" /
 * "CNN" etc instead of a generic "GOOGLE" chip.
 *
 *   <source url="…">Reuters</source>
 */
function pickGoogleSource(block: string): string | null {
  const re = /<source[^>]*>([\s\S]*?)<\/source>/i;
  const m = re.exec(block);
  if (!m) return null;
  const name = decodeEntities(m[1]);
  return name || null;
}

export function parseRssItems(
  xml: string,
  defaultSrc: string,
  opts: { extractGoogleSource?: boolean } = {}
): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = pickTag(block, "title");
    const url = pickTag(block, "link");
    if (!title || !url) continue;
    const src = opts.extractGoogleSource
      ? pickGoogleSource(block) ?? defaultSrc
      : defaultSrc;
    items.push({
      src,
      title,
      url,
      publishedAt: pickTag(block, "pubDate"),
    });
  }
  return items;
}

// Retained for backward-compat with any caller that imported the
// AP-specific helper name.
export function parseApRss(xml: string): NewsItem[] {
  return parseRssItems(xml, "AP");
}

/* ------------------------------------------------------------------ */
/*  Provider fetchers                                                  */
/* ------------------------------------------------------------------ */

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

async function fetchRssPayload(
  url: string,
  defaultSrc: string,
  label: string,
  opts: { extractGoogleSource?: boolean } = {}
): Promise<NewsPayload> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6_000),
      headers: {
        "user-agent": "coherence-news/1.0 (+productivity-hub)",
      },
    });
    if (!response.ok) {
      console.warn(
        `[news] ${label} responded ${response.status} ${response.statusText}`
      );
      return { items: [], reason: "fetch-failed" };
    }
    const xml = await response.text();
    const items = parseRssItems(xml, defaultSrc, opts).slice(0, 20);
    return {
      items,
      reason: items.length === 0 ? "no-items" : "ok",
    };
  } catch (err) {
    console.warn(`[news] ${label} fetch failed:`, err);
    if (isTimeoutError(err)) {
      return { items: [], reason: "upstream-timeout" };
    }
    return { items: [], reason: "fetch-failed" };
  }
}

async function fetchApRss(): Promise<NewsPayload> {
  return fetchRssPayload(AP_RSS_URL, "AP", "AP RSS");
}

async function fetchGoogleNews(): Promise<NewsPayload> {
  return fetchRssPayload(GOOGLE_NEWS_RSS_URL, "Google News", "Google News", {
    extractGoogleSource: true,
  });
}

/**
 * Normalize a title for dedupe: lowercase, collapse whitespace, strip
 * common trailing " - Source Name" attributions Google News adds.
 */
function normalizeTitleForDedupe(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+-\s+[^-]+$/, "") // drop "... - Source" suffix
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Merge two payloads preserving order (primary first, then any item
 * from secondary whose normalized title isn't already present).
 * Reason precedence: if primary has items → "ok"; else defer to
 * secondary; else return the strongest single-source reason.
 */
function mergePayloads(
  primary: NewsPayload,
  secondary: NewsPayload
): NewsPayload {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of primary.items) {
    const key = normalizeTitleForDedupe(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  for (const item of secondary.items) {
    const key = normalizeTitleForDedupe(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  if (merged.length > 0) {
    return { items: merged, reason: "ok" };
  }
  // Both empty — surface the most actionable reason (401/429/timeout
  // beats a generic fetch-failed).
  const rank: Record<NewsFetchReason, number> = {
    "upstream-401": 5,
    "upstream-429": 4,
    "upstream-timeout": 3,
    "fetch-failed": 2,
    "no-items": 1,
    "no-api-key": 1,
    off: 0,
    ok: 0,
  };
  const pick =
    rank[primary.reason] >= rank[secondary.reason]
      ? primary.reason
      : secondary.reason;
  return { items: [], reason: pick };
}

async function fetchNewsApi(): Promise<NewsPayload> {
  const key = process.env.NEWSAPI_KEY?.trim();
  if (!key) return { items: [], reason: "no-api-key" };
  try {
    const url = `${NEWS_API_URL}?country=us&pageSize=20&apiKey=${encodeURIComponent(key)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) {
      console.warn(
        `[news] NewsAPI responded ${response.status} ${response.statusText}`
      );
      if (response.status === 401) {
        return { items: [], reason: "upstream-401" };
      }
      if (response.status === 429) {
        return { items: [], reason: "upstream-429" };
      }
      return { items: [], reason: "fetch-failed" };
    }
    const json = (await response.json()) as {
      articles?: Array<{
        source?: { name?: string };
        title?: string;
        url?: string;
        publishedAt?: string;
      }>;
    };
    const items = (json.articles ?? [])
      .filter((a) => a.title && a.url)
      .map((a) => ({
        src: a.source?.name ?? "News",
        title: a.title ?? "",
        url: a.url ?? "",
        publishedAt: a.publishedAt ?? "",
      }));
    return {
      items,
      reason: items.length === 0 ? "no-items" : "ok",
    };
  } catch (err) {
    console.warn("[news] NewsAPI fetch failed:", err);
    if (isTimeoutError(err)) {
      return { items: [], reason: "upstream-timeout" };
    }
    return { items: [], reason: "fetch-failed" };
  }
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

export const newsRouter = router({
  getHeadlines: protectedProcedure
    .input(
      z
        .object({
          count: z.number().int().min(1).max(20).default(6),
        })
        .optional()
    )
    .query(async ({ input }): Promise<NewsPayload> => {
      const count = input?.count ?? 6;
      const mode = resolveMode();
      if (mode === "off") {
        return { items: [], reason: "off" };
      }

      if (cachedPayload && Date.now() - cachedPayload.at < CACHE_MS) {
        return {
          items: cachedPayload.payload.items.slice(0, count),
          reason: cachedPayload.payload.reason,
        };
      }

      const payload = await (async (): Promise<NewsPayload> => {
        switch (mode) {
          case "newsapi":
            return fetchNewsApi();
          case "ap-rss":
            return fetchApRss();
          case "google":
            return fetchGoogleNews();
          case "merged":
          default: {
            // Fetch both in parallel — a single slow source shouldn't
            // block the whole feed. Promise.allSettled means one
            // rejecting doesn't take out the other.
            const [ap, google] = await Promise.allSettled([
              fetchApRss(),
              fetchGoogleNews(),
            ]);
            const apPayload: NewsPayload =
              ap.status === "fulfilled"
                ? ap.value
                : { items: [], reason: "fetch-failed" };
            const googlePayload: NewsPayload =
              google.status === "fulfilled"
                ? google.value
                : { items: [], reason: "fetch-failed" };
            return mergePayloads(apPayload, googlePayload);
          }
        }
      })();

      cachedPayload = { at: Date.now(), payload };
      return {
        items: payload.items.slice(0, count),
        reason: payload.reason,
      };
    }),
});

export const __test__ = {
  parseApRss,
  parseRssItems,
  resolveMode,
  mergePayloads,
  normalizeTitleForDedupe,
};
