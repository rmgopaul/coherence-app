/**
 * Tesla Powerhub adapter — pure-helper tests.
 *
 * First slice of Concern #1 from the PRs 366-383 review: vendor
 * restoration PRs (#368, #371, #373) shipped without adapter-level
 * vitest specs. This file covers the file-local pure helpers
 * (URL canonicalization, token-payload parsing, timestamp coercion,
 * abort-error detection, JSON-body parsing, base64 basic auth) via
 * the `__TEST_ONLY__` export. Network-bound integration paths
 * (`getTeslaPowerhubProductionMetrics`,
 * `getTeslaPowerhubAccessibleGroups`, `listTeslaPowerhubSites`)
 * stay out of scope here — they need fetch mocking and are
 * follow-up PRs.
 *
 * Why pure helpers first:
 *   - Adapter regressions in pure helpers manifest as silent wrong
 *     behavior (e.g., a token-payload parser that no longer
 *     surfaces `error_description` makes 401s look like generic
 *     failures). Tests prevent that regression class without
 *     needing live API mocks.
 *   - The pure surface is small enough that one PR fits a
 *     tractable scope.
 *   - Exposes the helpers via `__TEST_ONLY__` (mirrors
 *     `dashboardCsvExportJobs`, `teslaPowerhubProductionJobs`)
 *     without changing the adapter's public import surface.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeTeslaPowerhubUrl,
  __TEST_ONLY__,
} from "./teslaPowerhub";

const {
  normalizeTimeoutMs,
  isAbortOrTimeoutError,
  buildBasicAuth,
  parseJsonBody,
  formatPayloadPreview,
  parseTokenPayload,
  parseTimestampMs,
  isLikelySiteIdKey,
} = __TEST_ONLY__;

// ────────────────────────────────────────────────────────────────────
// normalizeTeslaPowerhubUrl — already exported, but rails belong here
// ────────────────────────────────────────────────────────────────────

describe("normalizeTeslaPowerhubUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeTeslaPowerhubUrl("https://example.com/")).toBe(
      "https://example.com"
    );
    expect(normalizeTeslaPowerhubUrl("https://example.com//")).toBe(
      "https://example.com"
    );
    expect(normalizeTeslaPowerhubUrl("https://example.com/path/")).toBe(
      "https://example.com/path"
    );
  });

  it("preserves a URL with no trailing slash", () => {
    expect(normalizeTeslaPowerhubUrl("https://example.com")).toBe(
      "https://example.com"
    );
    expect(normalizeTeslaPowerhubUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
  });

  it("returns null for null/undefined/empty", () => {
    expect(normalizeTeslaPowerhubUrl(null)).toBeNull();
    expect(normalizeTeslaPowerhubUrl(undefined)).toBeNull();
    expect(normalizeTeslaPowerhubUrl("")).toBeNull();
    expect(normalizeTeslaPowerhubUrl("   ")).toBeNull();
  });

  it("trims surrounding whitespace before slash-stripping", () => {
    expect(normalizeTeslaPowerhubUrl("  https://example.com/  ")).toBe(
      "https://example.com"
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// normalizeTimeoutMs — bounded numeric coercion
// ────────────────────────────────────────────────────────────────────

describe("normalizeTimeoutMs", () => {
  it("returns a positive finite number unchanged", () => {
    expect(normalizeTimeoutMs(5000, 1000)).toBe(5000);
    expect(normalizeTimeoutMs(1, 999)).toBe(1);
  });

  it("falls back when the value is null/undefined", () => {
    expect(normalizeTimeoutMs(null, 5000)).toBe(5000);
    expect(normalizeTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it("falls back on zero / negative / NaN / infinite values", () => {
    expect(normalizeTimeoutMs(0, 5000)).toBe(5000);
    expect(normalizeTimeoutMs(-1, 5000)).toBe(5000);
    expect(normalizeTimeoutMs(NaN, 5000)).toBe(5000);
    expect(normalizeTimeoutMs(Infinity, 5000)).toBe(5000);
    expect(normalizeTimeoutMs(-Infinity, 5000)).toBe(5000);
  });
});

// ────────────────────────────────────────────────────────────────────
// isAbortOrTimeoutError — multi-signal detection
// ────────────────────────────────────────────────────────────────────

describe("isAbortOrTimeoutError", () => {
  it("matches AbortError by name", () => {
    const err = new Error("doesn't matter");
    err.name = "AbortError";
    expect(isAbortOrTimeoutError(err)).toBe(true);
  });

  it("matches TimeoutError by name", () => {
    const err = new Error("doesn't matter");
    err.name = "TimeoutError";
    expect(isAbortOrTimeoutError(err)).toBe(true);
  });

  it("matches by 'aborted due to timeout' message regardless of name", () => {
    const err = new Error("Operation aborted due to timeout");
    expect(isAbortOrTimeoutError(err)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isAbortOrTimeoutError(new Error("network down"))).toBe(false);
    expect(isAbortOrTimeoutError(new TypeError("boom"))).toBe(false);
  });

  it("safely handles non-error inputs", () => {
    expect(isAbortOrTimeoutError(null)).toBe(false);
    expect(isAbortOrTimeoutError(undefined)).toBe(false);
    expect(isAbortOrTimeoutError("string error")).toBe(false);
    expect(isAbortOrTimeoutError({ name: "AbortError" })).toBe(true);
    // Object with name only — no message — also matches.
  });
});

// ────────────────────────────────────────────────────────────────────
// buildBasicAuth — RFC 7617 base64 of `client:secret`
// ────────────────────────────────────────────────────────────────────

describe("buildBasicAuth", () => {
  it("encodes client:secret as base64 with the Basic prefix", () => {
    expect(buildBasicAuth("user", "pass")).toBe("Basic dXNlcjpwYXNz");
  });

  it("handles unicode in credentials", () => {
    const expected = `Basic ${Buffer.from("ünder:scöre").toString("base64")}`;
    expect(buildBasicAuth("ünder", "scöre")).toBe(expected);
  });

  it("encodes empty credentials as empty colon-pair", () => {
    expect(buildBasicAuth("", "")).toBe("Basic Og==");
  });
});

// ────────────────────────────────────────────────────────────────────
// parseJsonBody — empty-safe JSON parsing
// ────────────────────────────────────────────────────────────────────

describe("parseJsonBody", () => {
  it("returns the parsed object on valid JSON", () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns an empty object on whitespace-only input", () => {
    expect(parseJsonBody("")).toEqual({});
    expect(parseJsonBody("   ")).toEqual({});
    expect(parseJsonBody("\n\t")).toEqual({});
  });

  it("returns an empty object on malformed JSON (does not throw)", () => {
    expect(parseJsonBody("not json")).toEqual({});
    expect(parseJsonBody("{")).toEqual({});
    expect(parseJsonBody("{a:1}")).toEqual({});
  });

  it("preserves arrays and primitives that are valid JSON", () => {
    expect(parseJsonBody("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonBody('"hello"')).toBe("hello");
    expect(parseJsonBody("42")).toBe(42);
    expect(parseJsonBody("null")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// formatPayloadPreview — bounded preview for error messages
// ────────────────────────────────────────────────────────────────────

describe("formatPayloadPreview", () => {
  it("uses the trimmed raw body when present", () => {
    expect(formatPayloadPreview({ unused: "obj" }, "  raw text  ")).toBe(
      "raw text"
    );
  });

  it("caps the preview at 400 characters", () => {
    const long = "x".repeat(1000);
    expect(formatPayloadPreview({}, long)).toHaveLength(400);
  });

  it("falls back to JSON.stringify(payload) when raw is empty", () => {
    expect(formatPayloadPreview({ a: 1 }, "")).toBe('{"a":1}');
  });

  it("returns empty string when payload is non-serializable and raw is empty", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatPayloadPreview(cyclic, "")).toBe("");
  });

  it("caps JSON.stringify fallback at 400 characters too", () => {
    const big = { data: "x".repeat(1000) };
    expect(formatPayloadPreview(big, "")).toHaveLength(400);
  });
});

// ────────────────────────────────────────────────────────────────────
// parseTokenPayload — extracts access_token + surfaces errors
// ────────────────────────────────────────────────────────────────────

describe("parseTokenPayload", () => {
  it("extracts access_token from the top-level shape", () => {
    const result = parseTokenPayload(
      { access_token: "tok-123", token_type: "Bearer", expires_in: 3600 },
      ""
    );
    expect(result.access_token).toBe("tok-123");
  });

  it("extracts access_token from a nested `data` envelope", () => {
    const result = parseTokenPayload(
      { data: { access_token: "tok-456", expires_in: 1800 } },
      ""
    );
    expect(result.access_token).toBe("tok-456");
  });

  it("throws with error_description when access_token is missing", () => {
    expect(() =>
      parseTokenPayload(
        { error_description: "invalid client credentials" },
        ""
      )
    ).toThrow(/invalid client credentials/);
  });

  it("throws with request_id when surfaced", () => {
    expect(() =>
      parseTokenPayload({ meta: { request_id: "req-abc" } }, "{}")
    ).toThrow(/request_id=req-abc/);
  });

  it("throws with payload preview attached for forensics", () => {
    expect(() =>
      parseTokenPayload(
        { error: { error_description: "rate limited" } },
        '{"error":{"error_description":"rate limited"}}'
      )
    ).toThrow(/rate limited/);
  });

  it("throws even on garbage payload (no access_token)", () => {
    expect(() => parseTokenPayload(null, "")).toThrow(/missing access_token/);
    expect(() => parseTokenPayload("not-an-object", "literal")).toThrow(
      /missing access_token/
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// parseTimestampMs — flexible date/timestamp coercion
// ────────────────────────────────────────────────────────────────────

describe("parseTimestampMs", () => {
  it("treats a number > 1e12 as already-millis", () => {
    expect(parseTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("treats a number > 1e9 (and < 1e12) as seconds — converts to millis", () => {
    expect(parseTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects a number too small to be either seconds-since-epoch or millis", () => {
    expect(parseTimestampMs(123)).toBeNull();
    expect(parseTimestampMs(0)).toBeNull();
  });

  it("rejects non-finite numbers", () => {
    expect(parseTimestampMs(NaN)).toBeNull();
    expect(parseTimestampMs(Infinity)).toBeNull();
  });

  it("parses a numeric string the same as the corresponding number", () => {
    expect(parseTimestampMs("1700000000000")).toBe(1_700_000_000_000);
    expect(parseTimestampMs("1700000000")).toBe(1_700_000_000_000);
  });

  it("falls back to Date.parse for ISO date strings", () => {
    expect(parseTimestampMs("2024-01-01T00:00:00Z")).toBe(
      Date.parse("2024-01-01T00:00:00Z")
    );
  });

  it("returns null for unparseable strings", () => {
    expect(parseTimestampMs("not a date")).toBeNull();
    expect(parseTimestampMs("")).toBeNull();
    expect(parseTimestampMs("   ")).toBeNull();
  });

  it("returns null for non-number/non-string inputs", () => {
    expect(parseTimestampMs(null)).toBeNull();
    expect(parseTimestampMs(undefined)).toBeNull();
    expect(parseTimestampMs({})).toBeNull();
    expect(parseTimestampMs([])).toBeNull();
    expect(parseTimestampMs(true)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// isLikelySiteIdKey — heuristic for "is this string an upstream id?"
// ────────────────────────────────────────────────────────────────────

describe("isLikelySiteIdKey", () => {
  it("accepts pure-numeric ids of length 4+", () => {
    expect(isLikelySiteIdKey("1234")).toBe(true);
    expect(isLikelySiteIdKey("99999")).toBe(true);
  });

  it("rejects pure-numeric ids of length 3 or shorter", () => {
    expect(isLikelySiteIdKey("123")).toBe(false);
    expect(isLikelySiteIdKey("1")).toBe(false);
  });

  it("accepts UUIDs", () => {
    expect(isLikelySiteIdKey("550e8400-e29b-41d4-a716-446655440000")).toBe(
      true
    );
  });

  it("accepts mixed alphanumerics with at least one digit and length 6+", () => {
    expect(isLikelySiteIdKey("abc123")).toBe(true);
    expect(isLikelySiteIdKey("SITE_42_USA")).toBe(true);
  });

  it("rejects pure-letters (no digits)", () => {
    expect(isLikelySiteIdKey("abcdefg")).toBe(false);
    expect(isLikelySiteIdKey("PowerWall")).toBe(false);
  });

  it("rejects short alphanumerics (< 6 chars)", () => {
    expect(isLikelySiteIdKey("ab12")).toBe(false);
    expect(isLikelySiteIdKey("a1")).toBe(false);
  });

  it("rejects empty / whitespace-only", () => {
    expect(isLikelySiteIdKey("")).toBe(false);
    expect(isLikelySiteIdKey("   ")).toBe(false);
  });

  it("trims before evaluating", () => {
    expect(isLikelySiteIdKey("  1234  ")).toBe(true);
  });
});
