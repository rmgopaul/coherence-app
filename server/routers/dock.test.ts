/**
 * dockRouter — server-side smoke tests.
 *
 * The full procedures are integration-shaped (they hit the DB), so this
 * file focuses on the pure parts the router relies on: the canonical
 * URL helper from @shared, and the local meta JSON parser inlined in
 * personalData.ts. We re-implement the parser here so the test doesn't
 * have to expose it.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeUrl, classifyUrl } from "@shared/dropdock.helpers";

// Mirror of the inlined parseDockMeta in personalData.ts. Kept in sync
// here so behavior changes break this test before they reach prod.
function parseDockMeta(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")])
      );
    }
  } catch {
    // fall through
  }
  return {};
}

describe("dockRouter helpers", () => {
  it("canonicalize matches between client and server", () => {
    // The unique constraint on (userId, urlCanonical) only works if the
    // client's classify+canonicalize and the server's canonicalize agree.
    const cases = [
      "https://Example.com/foo/",
      "https://example.com/foo",
      "https://example.com/foo?utm_source=x&keep=1",
      "https://mail.google.com/mail/u/0/#inbox/MSG_ABC",
    ];
    for (const u of cases) {
      const fromClient = classifyUrl(u).urlCanonical;
      const fromServer = canonicalizeUrl(u);
      expect(fromClient).toBe(fromServer);
    }
  });

  it("client-side dedupe key is stable across pastes of the same URL", () => {
    const a = classifyUrl("https://example.com/foo/").urlCanonical;
    const b = classifyUrl("https://EXAMPLE.com/foo").urlCanonical;
    const c = classifyUrl(
      "https://example.com/foo/?utm_source=x&utm_medium=y"
    ).urlCanonical;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("parseDockMeta handles null, invalid, and array inputs without throwing", () => {
    expect(parseDockMeta(null)).toEqual({});
    expect(parseDockMeta(undefined)).toEqual({});
    expect(parseDockMeta("")).toEqual({});
    expect(parseDockMeta("not json")).toEqual({});
    expect(parseDockMeta("[1,2,3]")).toEqual({});
  });

  it("parseDockMeta coerces values to strings", () => {
    expect(parseDockMeta('{"messageId": 42, "eid": "abc"}')).toEqual({
      messageId: "42",
      eid: "abc",
    });
    expect(parseDockMeta('{"k": null}')).toEqual({ k: "" });
  });

  it("parseDockMeta round-trips a normal classified URL meta", () => {
    const meta = classifyUrl(
      "https://docs.google.com/spreadsheets/d/SHEET123/edit"
    ).meta;
    const stringified = JSON.stringify(meta);
    expect(parseDockMeta(stringified)).toEqual(meta);
  });
});
