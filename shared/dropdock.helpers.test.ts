import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  classifyUrl,
  extractMarkdownLink,
  extractUrlFromPaste,
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
