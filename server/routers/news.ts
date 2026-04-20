/**
 * News router — Phase D.
 *
 * Default source: AP's public RSS feed (free, unmetered). Optional
 * NewsAPI provider behind `NEWS_FEED_MODE=newsapi` + `NEWSAPI_KEY`.
 *
 * In-process 10-minute cache. Returns an empty array when the feed
 * is turned off or upstream fails — the client renders "NEWS · NO
 * FEED CONFIGURED" in those cases.
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

let cachedItems: { at: number; items: NewsItem[] } | null = null;

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

async function fetchApRss(): Promise<NewsItem[]> {
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
      return [];
    }
    const xml = await response.text();
    return parseApRss(xml).slice(0, 20);
  } catch (err) {
    console.warn("[news] AP RSS fetch failed:", err);
    return [];
  }
}

async function fetchNewsApi(): Promise<NewsItem[]> {
  const key = process.env.NEWSAPI_KEY?.trim();
  if (!key) return [];
  try {
    const url = `${NEWS_API_URL}?country=us&pageSize=20&apiKey=${encodeURIComponent(key)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) {
      console.warn(
        `[news] NewsAPI responded ${response.status} ${response.statusText}`
      );
      return [];
    }
    const json = (await response.json()) as {
      articles?: Array<{
        source?: { name?: string };
        title?: string;
        url?: string;
        publishedAt?: string;
      }>;
    };
    return (json.articles ?? [])
      .filter((a) => a.title && a.url)
      .map((a) => ({
        src: a.source?.name ?? "News",
        title: a.title ?? "",
        url: a.url ?? "",
        publishedAt: a.publishedAt ?? "",
      }));
  } catch (err) {
    console.warn("[news] NewsAPI fetch failed:", err);
    return [];
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
    .query(async ({ input }) => {
      const count = input?.count ?? 6;
      const mode = resolveMode();
      if (mode === "off") return [] as NewsItem[];

      if (cachedItems && Date.now() - cachedItems.at < CACHE_MS) {
        return cachedItems.items.slice(0, count);
      }

      const items =
        mode === "newsapi" ? await fetchNewsApi() : await fetchApRss();

      cachedItems = { at: Date.now(), items };
      return items.slice(0, count);
    }),
});

export const __test__ = { parseApRss, resolveMode };
