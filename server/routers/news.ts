/**
 * News router — Phase D.
 *
 * Default source: AP's public RSS feed (free, unmetered). Optional
 * NewsAPI provider behind `NEWS_FEED_MODE=newsapi` + `NEWSAPI_KEY`.
 *
 * In-process 10-minute cache. Always returns a `NewsPayload` with
 * `items` + a `reason` discriminator — the client branches on the
 * reason to pick editorial empty-state copy ("slow news morning"
 * vs "wire went dark" vs "SET NEWSAPI_KEY").
 *
 * Env vars:
 *   NEWS_FEED_MODE = 'ap-rss' | 'newsapi' | 'off'   (default: 'ap-rss')
 *   NEWSAPI_KEY    = API key for newsapi.org (required when mode = 'newsapi')
 *
 * Spec: productivity-hub/handoff/new-integrations.md §"News"
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";

const AP_RSS_URL = "https://apnews.com/hub/ap-top-news.rss";
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

function resolveMode(): "ap-rss" | "newsapi" | "off" {
  const raw = (process.env.NEWS_FEED_MODE ?? "").trim().toLowerCase();
  if (raw === "newsapi") return "newsapi";
  if (raw === "off") return "off";
  return "ap-rss";
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

export function parseApRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = pickTag(block, "title");
    const url = pickTag(block, "link");
    if (!title || !url) continue;
    items.push({
      src: "AP",
      title,
      url,
      publishedAt: pickTag(block, "pubDate"),
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/*  Provider fetchers                                                  */
/* ------------------------------------------------------------------ */

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

async function fetchApRss(): Promise<NewsPayload> {
  try {
    const response = await fetch(AP_RSS_URL, {
      signal: AbortSignal.timeout(6_000),
      headers: {
        "user-agent": "coherence-news/1.0 (+productivity-hub)",
      },
    });
    if (!response.ok) {
      console.warn(
        `[news] AP RSS responded ${response.status} ${response.statusText}`
      );
      return { items: [], reason: "fetch-failed" };
    }
    const xml = await response.text();
    const items = parseApRss(xml).slice(0, 20);
    return {
      items,
      reason: items.length === 0 ? "no-items" : "ok",
    };
  } catch (err) {
    console.warn("[news] AP RSS fetch failed:", err);
    if (isTimeoutError(err)) {
      return { items: [], reason: "upstream-timeout" };
    }
    return { items: [], reason: "fetch-failed" };
  }
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

      const payload =
        mode === "newsapi" ? await fetchNewsApi() : await fetchApRss();

      cachedPayload = { at: Date.now(), payload };
      return {
        items: payload.items.slice(0, count),
        reason: payload.reason,
      };
    }),
});

export const __test__ = { parseApRss, resolveMode };
