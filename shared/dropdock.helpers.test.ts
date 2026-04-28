import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  categorizeDockDueDate,
  chipFallbackLabel,
  classifyUrl,
  extractMarkdownLink,
  extractUrlFromPaste,
  formatDockDueLabel,
  hasSensitiveParams,
  shouldCopyDockChipUrl,
  stripMarkdownLinks,
} from "./dropdock.helpers";

describe("canonicalizeUrl", () => {
  it("lowercases scheme and host but preserves path case", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM/Path/Here")).toBe(
      "https://example.com/Path/Here"
    );
  });

  it("strips a trailing slash from the path but keeps a bare /", () => {
    expect(canonicalizeUrl("https://example.com/foo/bar/")).toBe(
      "https://example.com/foo/bar"
    );
    expect(canonicalizeUrl("https://example.com/")).toBe(
      "https://example.com/"
    );
  });

  it("removes utm_* and similar tracking parameters", () => {
    expect(
      canonicalizeUrl(
        "https://example.com/?utm_source=newsletter&utm_medium=email&keep=me"
      )
    ).toBe("https://example.com/?keep=me");
  });

  it("strips gclid, fbclid, mc_cid", () => {
    expect(canonicalizeUrl("https://x.com/?gclid=abc&fbclid=def")).toBe(
      "https://x.com/"
    );
  });

  it.each([
    "token",
    "access_token",
    "code",
    "state",
    "sig",
    "auth",
    "key",
  ])("strips the %s query parameter so credentials don't enter the dedup key", (param) => {
    expect(canonicalizeUrl(`https://example.com/?${param}=FAKE123`)).toBe(
      "https://example.com/"
    );
  });

  it("strips sensitive params alongside tracking params and keeps everything else", () => {
    expect(
      canonicalizeUrl(
        "https://example.com/?utm_source=n&token=T&code=C&keep=me"
      )
    ).toBe("https://example.com/?keep=me");
  });

  it("preserves the URL hash (Gmail uses it to identify a thread)", () => {
    // Trailing-slash normalization may eat the slash before #, but the
    // hash and message id must be preserved so dedup keys still resolve.
    const out = canonicalizeUrl("https://mail.google.com/mail/u/0/#inbox/MSG123");
    expect(out).toContain("#inbox/MSG123");
    expect(out.startsWith("https://mail.google.com/mail/u/0")).toBe(true);
  });

  it("falls back to the lowercased trimmed string when not parseable", () => {
    expect(canonicalizeUrl("  Not A URL  ")).toBe("not a url");
    expect(canonicalizeUrl("")).toBe("");
  });
});

describe("classifyUrl", () => {
  it("classifies Gmail and extracts the message id from the hash", () => {
    const r = classifyUrl(
      "https://mail.google.com/mail/u/0/#inbox/MSG_DEADBEEF"
    );
    expect(r.source).toBe("gmail");
    expect(r.meta).toEqual({ messageId: "MSG_DEADBEEF" });
  });

  it("classifies Google Calendar and extracts ?eid", () => {
    const r = classifyUrl(
      "https://calendar.google.com/calendar/u/0/r/eventedit?eid=ZXZlbnRJZCBjYWxJZA"
    );
    expect(r.source).toBe("gcal");
    expect(r.meta.eid).toBe("ZXZlbnRJZCBjYWxJZA");
  });

  it("classifies the htmlLink format www.google.com/calendar/event", () => {
    // The Google Calendar API's `htmlLink` field returns this URL
    // shape, not the calendar.google.com host. Without this case
    // dropping a calendar event chip via paste / drag misses
    // enrichment and the chip falls back to the raw URL.
    const r = classifyUrl(
      "https://www.google.com/calendar/event?eid=ZXZlbnRJZCBjYWxJZA"
    );
    expect(r.source).toBe("gcal");
    expect(r.meta.eid).toBe("ZXZlbnRJZCBjYWxJZA");
  });

  it("classifies the bare google.com/calendar host as gcal", () => {
    const r = classifyUrl("https://google.com/calendar/event?eid=abc");
    expect(r.source).toBe("gcal");
    expect(r.meta.eid).toBe("abc");
  });

  it("does NOT classify www.google.com/search as gcal", () => {
    // Defensive: only `/calendar` path-prefixed www.google.com URLs
    // should classify as gcal — a vanilla google search URL must
    // still fall through to source: url.
    const r = classifyUrl("https://www.google.com/search?q=hello");
    expect(r.source).toBe("url");
    expect(r.meta).toEqual({});
  });

  it("classifies Google Sheets and pulls the spreadsheet id", () => {
    const r = classifyUrl(
      "https://docs.google.com/spreadsheets/d/SHEET_ABC/edit#gid=0"
    );
    expect(r.source).toBe("gsheet");
    expect(r.meta.spreadsheetId).toBe("SHEET_ABC");
  });

  it("classifies Todoist via /app/task/<id>", () => {
    const r = classifyUrl("https://todoist.com/app/task/8123456789");
    expect(r.source).toBe("todoist");
    expect(r.meta.taskId).toBe("8123456789");
  });

  it("classifies Todoist via /showTask?id=<id>", () => {
    const r = classifyUrl("https://todoist.com/showTask?id=42");
    expect(r.source).toBe("todoist");
    expect(r.meta.taskId).toBe("42");
  });

  it("falls back to source: url for anything else", () => {
    const r = classifyUrl("https://news.ycombinator.com/item?id=1");
    expect(r.source).toBe("url");
    expect(r.meta).toEqual({});
  });

  it("returns urlCanonical alongside the original url", () => {
    const r = classifyUrl(
      "https://Example.com/foo/?utm_source=x"
    );
    expect(r.url).toBe("https://Example.com/foo/?utm_source=x");
    expect(r.urlCanonical).toBe("https://example.com/foo");
  });

  it("returns source: url for empty input without throwing", () => {
    expect(classifyUrl("").source).toBe("url");
    expect(classifyUrl("").urlCanonical).toBe("");
  });
});

describe("chipFallbackLabel", () => {
  it("returns 'Gmail message' for gmail source", () => {
    expect(chipFallbackLabel("gmail", "https://mail.google.com/x")).toBe(
      "Gmail message"
    );
  });

  it("returns 'Calendar event' for gcal source", () => {
    expect(
      chipFallbackLabel(
        "gcal",
        "https://www.google.com/calendar/event?eid=ZXZlbnRJZCBjYWxJZA"
      )
    ).toBe("Calendar event");
  });

  it("returns 'Spreadsheet' for gsheet source", () => {
    expect(chipFallbackLabel("gsheet", "https://docs.google.com/x")).toBe(
      "Spreadsheet"
    );
  });

  it("returns 'Todoist task' for todoist source", () => {
    expect(
      chipFallbackLabel("todoist", "https://todoist.com/showTask?id=12345")
    ).toBe("Todoist task");
  });

  it("falls back to host + path for url source", () => {
    expect(
      chipFallbackLabel("url", "https://news.ycombinator.com/item?id=1")
    ).toBe("news.ycombinator.com/item");
  });

  it("trims a host-only URL's trailing slash", () => {
    expect(chipFallbackLabel("url", "https://example.com/")).toBe(
      "example.com"
    );
  });

  it("truncates host+path beyond 60 chars with ellipsis", () => {
    const url = `https://example.com/${"p".repeat(100)}`;
    const result = chipFallbackLabel("url", url);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("…")).toBe(true);
  });

  it("falls back to truncated raw URL when URL parsing fails", () => {
    expect(chipFallbackLabel("url", "not a real url")).toBe("not a real url");
  });
});

describe("extractUrlFromPaste", () => {
  it("returns the first non-empty, non-comment line of plain text", () => {
    expect(extractUrlFromPaste("https://a.com\nhttps://b.com")).toBe(
      "https://a.com"
    );
    expect(extractUrlFromPaste("# this is a comment\nhttps://x.com")).toBe(
      "https://x.com"
    );
  });

  it("pulls .url from a JSON object (Slack/Linear-style drops)", () => {
    expect(
      extractUrlFromPaste('{"url":"https://example.com/x","title":"X"}')
    ).toBe("https://example.com/x");
  });

  it("pulls .url from the first item of a JSON array", () => {
    expect(extractUrlFromPaste('[{"url":"https://example.com/y"}]')).toBe(
      "https://example.com/y"
    );
  });

  it("falls back to the raw text when JSON parse fails", () => {
    expect(extractUrlFromPaste("{not json}")).toBe("{not json}");
  });

  it("trims surrounding whitespace", () => {
    expect(extractUrlFromPaste("   https://a.com   ")).toBe("https://a.com");
  });
});

describe("hasSensitiveParams", () => {
  it.each([
    "token",
    "access_token",
    "code",
    "state",
    "sig",
    "auth",
    "key",
  ])("flags URLs carrying %s", (param) => {
    expect(hasSensitiveParams(`https://example.com/?${param}=FAKE123`)).toBe(
      true
    );
  });

  it("returns false for clean URLs", () => {
    expect(hasSensitiveParams("https://example.com/?utm_source=x")).toBe(false);
    expect(hasSensitiveParams("https://example.com/path")).toBe(false);
  });

  it("returns false for unparseable input", () => {
    expect(hasSensitiveParams("not a url")).toBe(false);
    expect(hasSensitiveParams("")).toBe(false);
  });
});

describe("extractMarkdownLink (Phase E)", () => {
  it("extracts the first [title](url) match", () => {
    expect(
      extractMarkdownLink(
        "[Read sprint plan](https://docs.google.com/document/d/abc)"
      )
    ).toEqual({
      title: "Read sprint plan",
      url: "https://docs.google.com/document/d/abc",
    });
  });

  it("returns null when no match is present", () => {
    expect(extractMarkdownLink("just plain text")).toBeNull();
    expect(extractMarkdownLink("https://example.com")).toBeNull();
  });

  it("returns null for malformed brackets/parens", () => {
    expect(extractMarkdownLink("[just title]")).toBeNull();
    expect(extractMarkdownLink("(just url)")).toBeNull();
    expect(extractMarkdownLink("[]()")).toBeNull();
  });

  it("trims whitespace inside brackets and parens", () => {
    expect(
      extractMarkdownLink("[  Read me  ](  https://example.com  )")
    ).toEqual({ title: "Read me", url: "https://example.com" });
  });

  it("picks the first match in a paragraph with multiple links", () => {
    expect(
      extractMarkdownLink(
        "Compare [first](https://a.com) and [second](https://b.com)"
      )
    ).toEqual({ title: "first", url: "https://a.com" });
  });

  it("handles non-string input defensively", () => {
    // @ts-expect-error — purposely-wrong input
    expect(extractMarkdownLink(null)).toBeNull();
    // @ts-expect-error — purposely-wrong input
    expect(extractMarkdownLink(undefined)).toBeNull();
  });
});

describe("stripMarkdownLinks (Phase E)", () => {
  it("replaces [text](url) with text", () => {
    expect(
      stripMarkdownLinks(
        "Read [sprint plan](https://docs.google.com/document/d/abc) by Friday"
      )
    ).toBe("Read sprint plan by Friday");
  });

  it("strips multiple matches in one string", () => {
    expect(
      stripMarkdownLinks(
        "Compare [first](https://a.com) and [second](https://b.com)"
      )
    ).toBe("Compare first and second");
  });

  it("is a no-op for plain text", () => {
    expect(stripMarkdownLinks("nothing to strip here")).toBe(
      "nothing to strip here"
    );
  });

  it("is idempotent (applying twice produces the same result)", () => {
    const input = "Read [docs](https://a.com) and [more](https://b.com)";
    const once = stripMarkdownLinks(input);
    expect(stripMarkdownLinks(once)).toBe(once);
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(stripMarkdownLinks("")).toBe("");
    // @ts-expect-error — purposely-wrong input
    expect(stripMarkdownLinks(null)).toBe("");
    // @ts-expect-error — purposely-wrong input
    expect(stripMarkdownLinks(undefined)).toBe("");
  });
});

describe("shouldCopyDockChipUrl (Phase E)", () => {
  const noSelection = () => "";
  const withSelection = (text: string) => () => text;

  it("returns true for Cmd+C with no selection (macOS)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: false, altKey: false },
        noSelection
      )
    ).toBe(true);
  });

  it("returns true for Ctrl+C with no selection (Windows / Linux)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: false, ctrlKey: true, altKey: false },
        noSelection
      )
    ).toBe(true);
  });

  it("accepts uppercase C (shift held)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "C", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        noSelection
      )
    ).toBe(true);
  });

  it("returns false when alt is held (Option+C is unicode input)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: false, altKey: true },
        noSelection
      )
    ).toBe(false);
  });

  it("returns false when both meta and ctrl are held (ambiguous)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: true, altKey: false },
        noSelection
      )
    ).toBe(false);
  });

  it("returns false when no modifier is held (plain `c`)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: false, ctrlKey: false, altKey: false },
        noSelection
      )
    ).toBe(false);
  });

  it("returns false for non-c keys", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "v", metaKey: true, ctrlKey: false, altKey: false },
        noSelection
      )
    ).toBe(false);
    expect(
      shouldCopyDockChipUrl(
        { key: "Enter", metaKey: true, ctrlKey: false, altKey: false },
        noSelection
      )
    ).toBe(false);
  });

  it("returns false when the user has actively selected text (default copy wins)", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: false, altKey: false },
        withSelection("some highlighted text")
      )
    ).toBe(false);
  });

  it("treats whitespace-only selection as 'no selection'", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: false, altKey: false },
        withSelection("   \n  ")
      )
    ).toBe(true);
  });

  it("treats null selection as 'no selection'", () => {
    expect(
      shouldCopyDockChipUrl(
        { key: "c", metaKey: true, ctrlKey: false, altKey: false },
        () => null
      )
    ).toBe(true);
  });
});

describe("extractUrlFromPaste — markdown branch (Phase E)", () => {
  it("returns the URL from a [title](url) paste so classifyUrl can parse it", () => {
    const url = extractUrlFromPaste(
      "[Read sprint plan](https://todoist.com/showTask?id=12345)"
    );
    expect(url).toBe("https://todoist.com/showTask?id=12345");
  });

  it("strips surrounding text around a markdown link", () => {
    // The current behavior takes the first non-comment line, then
    // matches the markdown pattern within it. A line that contains
    // markdown surrounded by other words still resolves to the
    // URL — title recovery happens in the DropDock handler via
    // `extractMarkdownLink`, not here.
    expect(
      extractUrlFromPaste(
        "task: [Sprint plan](https://example.com/x) — due Friday"
      )
    ).toBe("https://example.com/x");
  });

  it("falls through to the bare URL when the input has no markdown", () => {
    expect(extractUrlFromPaste("https://example.com/x")).toBe(
      "https://example.com/x"
    );
  });
});

describe("categorizeDockDueDate", () => {
  const NOW = new Date("2026-04-28T12:00:00Z");

  it("returns 'none' when dueAt is null / undefined / empty", () => {
    expect(categorizeDockDueDate(null, NOW)).toBe("none");
    expect(categorizeDockDueDate(undefined, NOW)).toBe("none");
    expect(categorizeDockDueDate("", NOW)).toBe("none");
  });

  it("returns 'none' when dueAt is not parseable", () => {
    expect(categorizeDockDueDate("not-a-date", NOW)).toBe("none");
  });

  it("returns 'overdue' when dueAt is in the past", () => {
    expect(
      categorizeDockDueDate(new Date("2026-04-27T12:00:00Z"), NOW)
    ).toBe("overdue");
    // 1 second ago is still overdue.
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() - 1_000), NOW)
    ).toBe("overdue");
  });

  it("returns 'due-soon' for dueAt within the next 4 hours", () => {
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 30 * 60_000), NOW)
    ).toBe("due-soon");
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 4 * 3_600_000), NOW)
    ).toBe("due-soon");
  });

  it("returns 'upcoming' for dueAt 4–24 hours out", () => {
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 5 * 3_600_000), NOW)
    ).toBe("upcoming");
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 24 * 3_600_000), NOW)
    ).toBe("upcoming");
  });

  it("returns 'future' for dueAt beyond 24 hours out", () => {
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 25 * 3_600_000), NOW)
    ).toBe("future");
    expect(
      categorizeDockDueDate(new Date(NOW.getTime() + 30 * 86_400_000), NOW)
    ).toBe("future");
  });

  it("accepts ISO strings (tRPC wire payload)", () => {
    expect(
      categorizeDockDueDate("2026-04-28T13:00:00Z", NOW)
    ).toBe("due-soon");
  });
});

describe("formatDockDueLabel", () => {
  // 2026-04-28 is a Tuesday in UTC. Use local time semantics for
  // weekday/month formatting — vitest pins TZ=America/Chicago, so
  // 12:00 UTC is 07:00 local. We pick anchor times that read the
  // same in CST/CDT to keep tests TZ-stable.
  const NOW = new Date("2026-04-28T15:00:00Z"); // 10:00 CDT

  it("returns empty string for null / undefined / unparseable", () => {
    expect(formatDockDueLabel(null, NOW)).toBe("");
    expect(formatDockDueLabel(undefined, NOW)).toBe("");
    expect(formatDockDueLabel("not-a-date", NOW)).toBe("");
  });

  it("formats minutes-overdue", () => {
    expect(
      formatDockDueLabel(new Date(NOW.getTime() - 5 * 60_000), NOW)
    ).toBe("5m overdue");
  });

  it("formats hours-overdue", () => {
    expect(
      formatDockDueLabel(new Date(NOW.getTime() - 3 * 3_600_000), NOW)
    ).toBe("3h overdue");
  });

  it("formats days-overdue", () => {
    expect(
      formatDockDueLabel(new Date(NOW.getTime() - 2 * 86_400_000), NOW)
    ).toBe("2d overdue");
  });

  it("formats minutes-away", () => {
    expect(
      formatDockDueLabel(new Date(NOW.getTime() + 38 * 60_000), NOW)
    ).toBe("in 38m");
  });

  it("formats hours-away under 6h", () => {
    expect(
      formatDockDueLabel(new Date(NOW.getTime() + 5 * 3_600_000), NOW)
    ).toBe("in 5h");
  });

  it("formats today + hour for >6h same-day", () => {
    // NOW = 10:00 CDT; due = 22:00 CDT same day → "Today 10pm".
    const due = new Date(NOW.getTime() + 12 * 3_600_000);
    const label = formatDockDueLabel(due, NOW);
    expect(label).toMatch(/^Today \d{1,2}(:\d{2})?(am|pm)$/);
    expect(label.startsWith("Today")).toBe(true);
  });

  it("formats Tomorrow + hour", () => {
    const due = new Date(NOW.getTime() + 25 * 3_600_000);
    const label = formatDockDueLabel(due, NOW);
    expect(label.startsWith("Tomorrow")).toBe(true);
  });

  it("formats day-of-week + hour for 2–6 days out", () => {
    // 3 days out (Friday CDT). Day name + hour.
    const due = new Date(NOW.getTime() + 3 * 86_400_000);
    const label = formatDockDueLabel(due, NOW);
    expect(label).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /);
  });

  it("formats month + day for >6 days out", () => {
    const due = new Date(NOW.getTime() + 30 * 86_400_000);
    const label = formatDockDueLabel(due, NOW);
    // Month + day-of-month, no time. Matches "May 28" etc.
    expect(label).toMatch(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/
    );
  });

  it("preserves minutes when the hour-mark is non-round", () => {
    // 28h30m later: lands on the next calendar day → "Tomorrow
    // 2:30pm". The bucket varies with the time of day; the test
    // only cares that the label rendered the non-round minute.
    const due = new Date(NOW.getTime() + (28 * 60 + 30) * 60_000);
    const label = formatDockDueLabel(due, NOW);
    expect(label).toMatch(/\d{1,2}:\d{2}(am|pm)$/);
  });
});
