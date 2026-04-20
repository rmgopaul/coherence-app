import { describe, expect, it } from "vitest";
import { __test__ } from "./news";

const { parseRssItems, mergePayloads, normalizeTitleForDedupe } = __test__;

const AP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[Senate passes budget deal]]></title>
      <link>https://apnews.com/article/budget</link>
      <pubDate>Sun, 20 Apr 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Tech giant unveils AI chip]]></title>
      <link>https://apnews.com/article/chip</link>
      <pubDate>Sun, 20 Apr 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const GOOGLE_FIXTURE = `<?xml version="1.0"?>
<rss>
  <channel>
    <item>
      <title>Senate passes budget deal - Reuters</title>
      <link>https://news.google.com/articles/budget</link>
      <pubDate>Sun, 20 Apr 2026 13:00:00 GMT</pubDate>
      <source url="https://www.reuters.com">Reuters</source>
    </item>
    <item>
      <title>Storm batters East Coast overnight</title>
      <link>https://news.google.com/articles/storm</link>
      <pubDate>Sun, 20 Apr 2026 11:30:00 GMT</pubDate>
      <source url="https://www.nytimes.com">The New York Times</source>
    </item>
  </channel>
</rss>`;

describe("news · parseRssItems", () => {
  it("parses AP items with the default source chip", () => {
    const items = parseRssItems(AP_FIXTURE, "AP");
    expect(items).toHaveLength(2);
    expect(items[0].src).toBe("AP");
    expect(items[0].title).toBe("Senate passes budget deal");
    expect(items[0].url).toBe("https://apnews.com/article/budget");
  });

  it("extracts per-item sources from Google News when requested", () => {
    const items = parseRssItems(GOOGLE_FIXTURE, "Google News", {
      extractGoogleSource: true,
    });
    expect(items).toHaveLength(2);
    expect(items[0].src).toBe("Reuters");
    expect(items[1].src).toBe("The New York Times");
  });

  it("falls back to defaultSrc when no <source> tag is present", () => {
    const items = parseRssItems(AP_FIXTURE, "Google News", {
      extractGoogleSource: true,
    });
    expect(items[0].src).toBe("Google News");
  });
});

describe("news · normalizeTitleForDedupe", () => {
  it("strips trailing ' - Source' suffixes", () => {
    const a = normalizeTitleForDedupe("Senate passes budget deal");
    const b = normalizeTitleForDedupe("Senate passes budget deal - Reuters");
    expect(a).toBe(b);
  });

  it("is case-insensitive", () => {
    expect(normalizeTitleForDedupe("HELLO WORLD")).toBe(
      normalizeTitleForDedupe("hello world")
    );
  });
});

describe("news · mergePayloads", () => {
  const ap = parseRssItems(AP_FIXTURE, "AP");
  const google = parseRssItems(GOOGLE_FIXTURE, "Google News", {
    extractGoogleSource: true,
  });

  it("dedupes Google entries whose titles match AP (with/without source suffix)", () => {
    const merged = mergePayloads(
      { items: ap, reason: "ok" },
      { items: google, reason: "ok" }
    );
    const titles = merged.items.map((i) => i.title);
    // AP wins the shared headline — the Reuters-suffix Google copy drops.
    expect(titles).toEqual([
      "Senate passes budget deal",
      "Tech giant unveils AI chip",
      "Storm batters East Coast overnight",
    ]);
    expect(merged.reason).toBe("ok");
  });

  it("marks reason ok when at least one item survives", () => {
    const merged = mergePayloads(
      { items: [], reason: "fetch-failed" },
      { items: google, reason: "ok" }
    );
    expect(merged.items.length).toBeGreaterThan(0);
    expect(merged.reason).toBe("ok");
  });

  it("surfaces the strongest failure reason when both payloads are empty", () => {
    const merged = mergePayloads(
      { items: [], reason: "no-items" },
      { items: [], reason: "upstream-429" }
    );
    expect(merged.reason).toBe("upstream-429");
  });
});
