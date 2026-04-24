import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  classifyUrl,
  extractUrlFromPaste,
  hasSensitiveParams,
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
