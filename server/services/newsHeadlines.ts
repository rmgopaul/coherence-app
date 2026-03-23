/**
 * Google News RSS headline fetcher.
 * Parses RSS XML from Google News topic feeds.
 * No API key required.
 */

export interface NewsHeadline {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  category: "us-politics" | "world";
}

// Google News RSS topic URLs
const FEEDS: Array<{ url: string; category: NewsHeadline["category"]; limit: number }> = [
  {
    // US politics
    url: "https://news.google.com/rss/search?q=us+politics&hl=en-US&gl=US&ceid=US:en",
    category: "us-politics",
    limit: 5,
  },
  {
    // World news
    url: "https://news.google.com/rss/search?q=world+news&hl=en-US&gl=US&ceid=US:en",
    category: "world",
    limit: 5,
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Extract RSS items from XML text using regex (avoids needing an XML parser dependency).
 * Google News RSS items have: <title>, <link>, <pubDate>, <source>
 */
function parseRssItems(
  xml: string,
  category: NewsHeadline["category"],
  limit: number
): NewsHeadline[] {
  const items: NewsHeadline[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];

    const titleMatch = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ??
      block.match(/<title>(.*?)<\/title>/);
    const linkMatch = block.match(/<link>(.*?)<\/link>/);
    const pubDateMatch = block.match(/<pubDate>(.*?)<\/pubDate>/);
    const sourceMatch = block.match(/<source[^>]*>(.*?)<\/source>/) ??
      block.match(/<source[^>]*><!\[CDATA\[(.*?)\]\]><\/source>/);

    const title = decodeHtmlEntities(titleMatch?.[1] ?? "").trim();
    if (!title) continue;

    items.push({
      title,
      link: (linkMatch?.[1] ?? "").trim(),
      source: decodeHtmlEntities(sourceMatch?.[1] ?? "").trim(),
      pubDate: (pubDateMatch?.[1] ?? "").trim(),
      category,
    });
  }

  return items;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

async function fetchFeed(
  url: string,
  category: NewsHeadline["category"],
  limit: number
): Promise<NewsHeadline[]> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.warn(`[NewsHeadlines] Failed to fetch ${category}: HTTP ${response.status}`);
      return [];
    }

    const xml = await response.text();
    return parseRssItems(xml, category, limit);
  } catch (error) {
    console.warn(`[NewsHeadlines] Error fetching ${category}:`, error);
    return [];
  }
}

export async function fetchNewsHeadlines(): Promise<NewsHeadline[]> {
  const results = await Promise.all(
    FEEDS.map((feed) => fetchFeed(feed.url, feed.category, feed.limit))
  );
  return results.flat();
}
