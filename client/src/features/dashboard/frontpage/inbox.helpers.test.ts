import { describe, expect, it } from "vitest";
import {
  buildInboxRow,
  getGmailHeader,
  inferDomainTag,
  relativeTime,
} from "./inbox.helpers";
import type { GmailMessage } from "../types";

const NOW_MS = new Date(2026, 3, 20, 14, 0, 0).getTime();

function mail(
  id: string | undefined,
  internalDate: number,
  headers: Array<{ name: string; value: string }>,
  labels: string[] = ["UNREAD"],
  snippet = ""
): GmailMessage {
  return {
    id,
    threadId: id,
    internalDate: String(internalDate),
    labelIds: labels,
    snippet,
    payload: { headers },
  } as unknown as GmailMessage;
}

describe("getGmailHeader", () => {
  it("matches header names case-insensitively", () => {
    const m = mail("a", NOW_MS, [
      { name: "From", value: "alice@example.com" },
    ]);
    expect(getGmailHeader(m, "From")).toBe("alice@example.com");
    expect(getGmailHeader(m, "from")).toBe("alice@example.com");
    expect(getGmailHeader(m, "FROM")).toBe("alice@example.com");
  });

  it("returns empty string when the header is missing", () => {
    const m = mail("a", NOW_MS, [{ name: "Subject", value: "hi" }]);
    expect(getGmailHeader(m, "From")).toBe("");
  });

  it("returns empty string when payload.headers is missing", () => {
    const m = { id: "a" } as unknown as GmailMessage;
    expect(getGmailHeader(m, "From")).toBe("");
  });
});

describe("inferDomainTag", () => {
  it("pulls the SLD label and uppercases it (max 4 chars)", () => {
    expect(inferDomainTag("Alice <alice@example.com>")).toBe("EXAM");
    expect(inferDomainTag("alice@carbonsolutions.com")).toBe("CARB");
    expect(inferDomainTag("alice@ipa.org")).toBe("IPA");
  });

  it("handles co.uk-style hosts by taking the literal SLD", () => {
    // host = bbc.co.uk → labels = [bbc, co, uk] → SLD label = co
    expect(inferDomainTag("alice@bbc.co.uk")).toBe("CO");
  });

  it("returns null for missing / blank / non-email input", () => {
    expect(inferDomainTag("")).toBeNull();
    expect(inferDomainTag("   ")).toBeNull();
    expect(inferDomainTag("just a name")).toBeNull();
  });

  it("falls back to the single label for hostless addresses", () => {
    expect(inferDomainTag("alice@localhost")).toBe("LOCA");
  });
});

describe("relativeTime", () => {
  it("returns 'now' for ts within the last minute", () => {
    expect(relativeTime(NOW_MS - 30_000, NOW_MS)).toBe("now");
    expect(relativeTime(NOW_MS, NOW_MS)).toBe("now");
  });

  it("returns minutes when within the hour", () => {
    expect(relativeTime(NOW_MS - 5 * 60_000, NOW_MS)).toBe("5m");
    expect(relativeTime(NOW_MS - 59 * 60_000, NOW_MS)).toBe("59m");
  });

  it("returns hours when within the day", () => {
    expect(relativeTime(NOW_MS - 2 * 3_600_000, NOW_MS)).toBe("2h");
    expect(relativeTime(NOW_MS - 23 * 3_600_000, NOW_MS)).toBe("23h");
  });

  it("falls back to 'Xd ago' for older messages", () => {
    expect(relativeTime(NOW_MS - 3 * 86_400_000, NOW_MS)).toBe("3d ago");
  });

  it("returns 'now' for ts in the future (clock-skew safety)", () => {
    expect(relativeTime(NOW_MS + 60_000, NOW_MS)).toBe("now");
  });
});

describe("buildInboxRow", () => {
  it("returns null when the message has no id", () => {
    const m = mail(undefined, NOW_MS, []);
    expect(buildInboxRow(m, NOW_MS)).toBeNull();
  });

  it("builds a normalized row with sender + tag + relative time", () => {
    const m = mail(
      "msg1",
      NOW_MS - 10 * 60_000,
      [
        { name: "From", value: "Alice Smith <alice@ipa.org>" },
        { name: "Subject", value: "Hello" },
      ],
      ["UNREAD"],
      "preview text"
    );
    const row = buildInboxRow(m, NOW_MS);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: "msg1",
      threadId: "msg1",
      fromName: "Alice Smith",
      fromTag: "IPA",
      subject: "Hello",
      ts: "10m",
      starred: false,
    });
  });

  it("flags starred messages", () => {
    const m = mail(
      "msg2",
      NOW_MS - 60_000,
      [{ name: "From", value: "x@y.com" }],
      ["UNREAD", "STARRED"]
    );
    expect(buildInboxRow(m, NOW_MS)?.starred).toBe(true);
  });

  it("falls back to '(no subject)' when subject header is empty", () => {
    const m = mail(
      "msg3",
      NOW_MS - 60_000,
      [{ name: "From", value: "x@y.com" }]
    );
    expect(buildInboxRow(m, NOW_MS)?.subject).toBe("(no subject)");
  });

  it("truncates the snippet at 140 chars", () => {
    const longSnippet = "x".repeat(200);
    const m = mail(
      "msg4",
      NOW_MS - 60_000,
      [{ name: "From", value: "x@y.com" }],
      ["UNREAD"],
      longSnippet
    );
    expect(buildInboxRow(m, NOW_MS)?.snippet.length).toBe(140);
  });

  it("uses message.id as threadId fallback when threadId missing", () => {
    const m = {
      id: "msg5",
      internalDate: String(NOW_MS - 60_000),
      labelIds: ["UNREAD"],
      snippet: "",
      payload: { headers: [{ name: "From", value: "x@y.com" }] },
    } as unknown as GmailMessage;
    expect(buildInboxRow(m, NOW_MS)?.threadId).toBe("msg5");
  });
});
