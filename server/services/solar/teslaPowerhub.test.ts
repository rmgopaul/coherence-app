/**
 * Tesla Powerhub adapter — unit + integration tests.
 *
 * Slice 1 (the original file content, below the divider): pure
 * helpers — URL canonicalization, token-payload parsing, timestamp
 * coercion, abort-error detection, JSON-body parsing, base64 basic
 * auth. Behavior of file-local helpers via `__TEST_ONLY__`.
 *
 * Slice 3 (this PR's addition, the `requestClientCredentialsToken`
 * describe block): integration tests for the token-fetch path. It's
 * the simplest network-bound entry in the adapter (single fetch, 4
 * distinct outcomes), so it's the natural place to establish the
 * fetch-mock pattern (`vi.stubGlobal("fetch", ...)`) for solar
 * adapters before tackling the multi-fetch site-discovery + telemetry
 * paths.
 *
 * Concern #1 from the PRs 366-383 review: vendor restoration PRs
 * (#368, #371, #373) shipped without adapter-level vitest specs.
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
 *
 * Why the token path next:
 *   - Every other Tesla integration path (`listTeslaPowerhubSites`,
 *     `getTeslaPowerhubAccessibleGroups`,
 *     `getTeslaPowerhubProductionMetrics`) calls
 *     `requestClientCredentialsToken` first. A regression in the
 *     token path takes EVERY downstream path with it.
 *   - The 4 outcomes are well-defined (200 / non-2xx / timeout /
 *     network error) which makes the test rails clean.
 *   - It's a single fetch — multi-fetch paths can layer on top of
 *     this once the pattern is established.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeTeslaPowerhubUrl,
  TESLA_POWERHUB_DEFAULT_TOKEN_URL,
  type TeslaPowerhubApiContext,
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
  requestClientCredentialsToken,
  fetchJsonWithBearerToken,
  fetchAccessibleSites,
  fetchAccessibleGroups,
  fetchGroupSites,
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

// ────────────────────────────────────────────────────────────────────
// requestClientCredentialsToken — integration tests w/ fetch mock
// (Concern #1 slice 3 — establishes the fetch-mock pattern for
// solar adapters before tackling the multi-fetch paths)
// ────────────────────────────────────────────────────────────────────

const VALID_CONTEXT: TeslaPowerhubApiContext = {
  clientId: "client-abc",
  clientSecret: "secret-xyz",
  tokenUrl: null,
  apiBaseUrl: null,
  portalBaseUrl: null,
};

/** Build a Response stand-in that matches what the implementation reads. */
function buildResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: string;
}): Response {
  // Implementation calls `response.text()` for both happy and error
  // paths; we don't need a full Response. A minimal duck-typed object
  // is enough and avoids polyfill-specific behavior.
  const status = opts.status ?? (opts.ok ? 200 : 500);
  return {
    ok: opts.ok,
    status,
    statusText: opts.statusText ?? (opts.ok ? "OK" : "Internal Server Error"),
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("requestClientCredentialsToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed token on a 200 response", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: JSON.stringify({
          access_token: "tok-abc",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
    );
    const token = await requestClientCredentialsToken(VALID_CONTEXT);
    expect(token.access_token).toBe("tok-abc");
    expect(token.token_type).toBe("Bearer");
    expect(token.expires_in).toBe(3600);
  });

  it("calls the default token URL when context.tokenUrl is empty/null", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: JSON.stringify({ access_token: "tok-1" }),
      })
    );
    await requestClientCredentialsToken(VALID_CONTEXT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(TESLA_POWERHUB_DEFAULT_TOKEN_URL);
  });

  it("respects an override token URL when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: JSON.stringify({ access_token: "tok-2" }),
      })
    );
    await requestClientCredentialsToken({
      ...VALID_CONTEXT,
      tokenUrl: "https://custom.example.com/oauth/token",
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://custom.example.com/oauth/token");
  });

  it("sends Basic auth header derived from clientId:clientSecret", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: JSON.stringify({ access_token: "tok-3" }),
      })
    );
    await requestClientCredentialsToken(VALID_CONTEXT);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // base64("client-abc:secret-xyz") = "Y2xpZW50LWFiYzpzZWNyZXQteHl6"
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("client-abc:secret-xyz").toString("base64")}`
    );
  });

  it("sends the form-encoded grant_type=client_credentials body", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: JSON.stringify({ access_token: "tok-4" }),
      })
    );
    await requestClientCredentialsToken(VALID_CONTEXT);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("throws on a non-2xx response with status + statusText", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: "",
      })
    );
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /401 Unauthorized/
    );
  });

  it("includes response body in the error message when present", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        body: '{"error":"client_not_allowlisted"}',
      })
    );
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /client_not_allowlisted/
    );
  });

  it("surfaces a 5xx as a non-OK error (not silently retrying)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })
    );
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /503/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("translates an AbortError into the operator-friendly timeout message", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /timed out after 20 seconds.*allowlisted this server egress/i
    );
  });

  it("translates a TimeoutError the same way as AbortError", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeoutErr);
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /timed out after 20 seconds/
    );
  });

  it("re-throws an unrelated network error verbatim (no timeout-message rewrite)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /ECONNREFUSED/
    );
    // Importantly NOT the timeout message — operator-debugging hint
    // would be misleading on a connection-refused error.
    await expect(
      (async () => {
        fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
        try {
          await requestClientCredentialsToken(VALID_CONTEXT);
        } catch (err) {
          expect((err as Error).message).not.toMatch(/allowlisted/);
          throw err;
        }
      })()
    ).rejects.toBeDefined();
  });

  it("propagates an externally-aborted signal (caller cancels mid-flight)", async () => {
    const controller = new AbortController();
    controller.abort();
    // Simulate fetch noticing the aborted signal — implementation
    // wires the caller's signal into AbortSignal.any alongside its
    // 20s timeout, so an already-aborted external signal surfaces
    // as an AbortError that gets remapped to the timeout message.
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(
      requestClientCredentialsToken(VALID_CONTEXT, {
        signal: controller.signal,
      })
    ).rejects.toThrow(/timed out after 20 seconds/);
  });

  it("throws missing-access_token when the 200 body has no access_token", async () => {
    // Defends against a regression where an empty/garbage 200 body
    // would silently succeed and downstream `Authorization: Bearer`
    // would send `Bearer undefined`.
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: '{"unrelated":"value"}',
      })
    );
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /missing access_token/
    );
  });

  it("throws missing-access_token when the 200 body is malformed JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ok: true,
        body: "not json",
      })
    );
    await expect(requestClientCredentialsToken(VALID_CONTEXT)).rejects.toThrow(
      /missing access_token/
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchJsonWithBearerToken — integration tests w/ fetch mock
// (Concern #1 slice 4a — covers the foundational helper EVERY
//  multi-fetch path in this adapter delegates to)
// ────────────────────────────────────────────────────────────────────

/** Build a Response stand-in that exposes headers + json + text. */
function buildBearerResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  json?: unknown;
}): Response {
  const status = opts.status ?? (opts.ok ? 200 : 500);
  const headers = new Map<string, string>();
  if (opts.contentType !== undefined) {
    headers.set("content-type", opts.contentType);
  }
  return {
    ok: opts.ok,
    status,
    statusText: opts.statusText ?? (opts.ok ? "OK" : "Internal Server Error"),
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    text: async () => opts.body ?? "",
    json: async () =>
      opts.json !== undefined
        ? opts.json
        : opts.body
          ? JSON.parse(opts.body)
          : null,
  } as unknown as Response;
}

describe("fetchJsonWithBearerToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 200 + application/json response", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: { sites: [{ id: "site-1" }] },
      })
    );
    const result = await fetchJsonWithBearerToken(
      "https://example.com/sites",
      "tok-abc"
    );
    expect(result).toEqual({ sites: [{ id: "site-1" }] });
  });

  it("sends Authorization: Bearer <token> + Accept: application/json headers", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: {},
      })
    );
    await fetchJsonWithBearerToken("https://example.com/x", "tok-xyz");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-xyz");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("hits the URL passed in (verbatim, no rewriting)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: {},
      })
    );
    await fetchJsonWithBearerToken(
      "https://gridlogic-api.sn.tesla.services/v2/sites/list",
      "tok"
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gridlogic-api.sn.tesla.services/v2/sites/list");
  });

  it("throws on non-OK response with status + statusText", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })
    );
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/401 Unauthorized/);
  });

  it("includes response body in the non-OK error message when present", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        body: '{"error":"insufficient_scope"}',
      })
    );
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/insufficient_scope/);
  });

  it("does NOT silently retry on 5xx (single attempt)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })
    );
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a 200 with non-JSON content-type (e.g. HTML error page)", async () => {
    // Defends against a class of upstream regressions where a Tesla
    // gateway returns a 200 + HTML "maintenance" page. Without this
    // guard, response.json() throws a less-actionable "Unexpected
    // token <" error; the explicit content-type check surfaces a
    // clearer message with a body preview.
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "text/html",
        body: "<html><body>Maintenance</body></html>",
      })
    );
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/Unexpected content type.*text\/html/);
  });

  it("throws on a 200 with no content-type at all", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: undefined,
        body: "{}",
      })
    );
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/Unexpected content type/);
  });

  it("includes a truncated body preview in the wrong-content-type error", async () => {
    // Truncated to 200 chars — verify the preview is bounded so a
    // 50 KB error page doesn't bloat logs.
    const longBody = "x".repeat(500);
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "text/plain",
        body: longBody,
      })
    );
    const promise = fetchJsonWithBearerToken("https://example.com/x", "tok");
    await expect(promise).rejects.toThrow(/text\/plain/);
    try {
      await promise;
    } catch (err) {
      const msg = (err as Error).message;
      // The truncated portion should appear in the message...
      expect(msg).toContain("x".repeat(200));
      // ...but the full 500-char body should NOT (truncation works).
      expect(msg).not.toContain("x".repeat(300));
    }
  });

  it("translates a timeout to '(Request timed out after N ms)' when timeoutMs is set", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeoutErr);
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok", {
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/Request timed out after 5000 ms/);
  });

  it("re-throws an external AbortSignal abort verbatim (caller cancellation)", async () => {
    // When the CALLER's signal aborts (not our internal timeout), we
    // re-throw the original error so callers that distinguish abort
    // vs timeout can do so. The implementation checks
    // `options.signal.aborted` to disambiguate.
    const controller = new AbortController();
    controller.abort();
    const abortErr = new Error("aborted by caller");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok", {
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted by caller/);
  });

  it("re-throws unrelated network errors verbatim (no timeout-message rewrite)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("does not synthesize a timeout message when no timeoutMs is set", async () => {
    // Without timeoutMs, an AbortError on the underlying fetch
    // shouldn't be remapped — operators would chase the wrong cause.
    const abortErr = new Error("internal abort");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(
      fetchJsonWithBearerToken("https://example.com/x", "tok")
    ).rejects.toThrow(/internal abort/);
  });
});

// ────────────────────────────────────────────────────────────────────
// URL-candidate iterators (fetchAccessibleSites,
// fetchAccessibleGroups, fetchGroupSites) — Concern #1 slice 4b
//
// All three follow an identical shape: build N candidate URLs, try
// each via `fetchJsonWithBearerToken`, return the first non-empty
// success (with `resolvedEndpointUrl`), accumulate diagnostics on
// failure / empty-but-200, return empty result + diagnostics if all
// URLs fail.
// ────────────────────────────────────────────────────────────────────

/** A site descriptor payload that `collectSitesFromUnknown` recognizes. */
function siteListPayload(siteIds: string[]): unknown {
  // collectSitesFromUnknown looks for arrays under "sites", "site_ids",
  // etc. Use a UUID-shaped string so the parser's UUID regex matches.
  return { sites: siteIds };
}

/** A group descriptor payload that `collectGroupsFromUnknown` recognizes. */
function groupListPayload(groupIds: string[]): unknown {
  // detectGroupId checks `group_id` / `groupId` / `group_uuid` first;
  // it only falls back to plain `id` when `type` or `asset_type`
  // contains "group" or "portfolio". Use `group_id` for unambiguous
  // detection independent of any type heuristic.
  return groupIds.map(id => ({ group_id: id, name: `Group ${id}` }));
}

const SITE_UUID_1 = "00000000-0000-4000-8000-000000000001";
const SITE_UUID_2 = "00000000-0000-4000-8000-000000000002";

describe("fetchAccessibleSites", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first URL's payload when it parses to non-empty sites", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1, SITE_UUID_2]),
      })
    );
    const result = await fetchAccessibleSites(VALID_CONTEXT, "tok", {});
    expect(result.sites).toHaveLength(2);
    expect(result.resolvedEndpointUrl).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through past a 200-but-empty URL to the next candidate", async () => {
    // First URL: 200 OK but no recognizable sites — iterator falls through.
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: { unrelated: "value" },
      })
    );
    // Second URL: succeeds with sites.
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1]),
      })
    );
    const result = await fetchAccessibleSites(VALID_CONTEXT, "tok", {});
    expect(result.sites).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls through past a 401 to the next candidate (collected as diagnostic)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1]),
      })
    );
    const result = await fetchAccessibleSites(VALID_CONTEXT, "tok", {});
    expect(result.sites).toHaveLength(1);
  });

  it("returns empty result + diagnostics when ALL URLs fail", async () => {
    // Sticky mock — every call returns the same 500.
    fetchMock.mockResolvedValue(
      buildBearerResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );
    const result = await fetchAccessibleSites(VALID_CONTEXT, "tok", {});
    expect(result.sites).toEqual([]);
    expect(result.resolvedEndpointUrl).toBeNull();
    // Diagnostics shape: { error: "No sites found...", attempts: [...] }
    const preview = result.rawPreview as {
      error: string;
      attempts: Array<{ url: string; status: string }>;
    };
    expect(preview.error).toMatch(/No sites found in \d+ URL candidate/);
    expect(preview.attempts.length).toBeGreaterThan(0);
    expect(preview.attempts[0].status).toMatch(/500/);
  });

  it("aborts mid-iteration when the caller's signal is set", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      // Simulate the first URL's response triggering abort
      // (e.g. caller cancelled while we were waiting). On the next
      // iteration `throwIfSignalAborted` should throw.
      controller.abort();
      return buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: { unrelated: "no sites" },
      });
    });
    await expect(
      fetchAccessibleSites(VALID_CONTEXT, "tok", {
        signal: controller.signal,
      })
    ).rejects.toThrow();
    // Only the first URL was attempted before abort short-circuited.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the override endpoint URL first when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1]),
      })
    );
    await fetchAccessibleSites(VALID_CONTEXT, "tok", {
      endpointUrl: "https://override.example.com/sites/list",
    });
    const [firstUrl] = fetchMock.mock.calls[0];
    expect(firstUrl).toBe("https://override.example.com/sites/list");
  });
});

describe("fetchAccessibleGroups", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first URL's payload when it parses to non-empty groups", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: groupListPayload(["group-1", "group-2"]),
      })
    );
    const result = await fetchAccessibleGroups(VALID_CONTEXT, "tok", {});
    expect(result.groups.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("short-circuits — NO fetch — when endpointUrl already encodes a group ID", async () => {
    // The early-return path: regex extracts the group ID from the URL
    // and returns immediately without hitting the network.
    const result = await fetchAccessibleGroups(VALID_CONTEXT, "tok", {
      endpointUrl: "https://example.com/asset/groups/abc-123/sites",
    });
    expect(result.groups).toEqual([
      { groupId: "abc-123", groupName: null },
    ]);
    expect(result.resolvedEndpointUrl).toBe(
      "https://example.com/asset/groups/abc-123/sites"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through past a 200-empty URL to the next candidate", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: { unrelated: "value" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: groupListPayload(["group-x"]),
      })
    );
    const result = await fetchAccessibleGroups(VALID_CONTEXT, "tok", {});
    expect(result.groups.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty result + diagnostics when ALL URLs fail", async () => {
    fetchMock.mockResolvedValue(
      buildBearerResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })
    );
    const result = await fetchAccessibleGroups(VALID_CONTEXT, "tok", {});
    expect(result.groups).toEqual([]);
    expect(result.resolvedEndpointUrl).toBeNull();
    const preview = result.rawPreview as {
      error: string;
      attempts: unknown[];
    };
    expect(preview.error).toMatch(/No groups found in \d+ URL candidate/);
  });
});

describe("fetchGroupSites", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first URL's payload when it parses to non-empty sites", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1]),
      })
    );
    const result = await fetchGroupSites(VALID_CONTEXT, "tok", {
      groupId: "group-abc",
    });
    expect(result.sites).toHaveLength(1);
    expect(result.resolvedEndpointUrl).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through past 200-empty + 401 URLs to a third candidate that succeeds", async () => {
    // Mixed-failure sequence — proves the iterator handles both
    // empty-but-200 and error responses uniformly.
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: { unrelated: "no sites here" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_2]),
      })
    );
    const result = await fetchGroupSites(VALID_CONTEXT, "tok", {
      groupId: "group-abc",
    });
    expect(result.sites).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns empty result + diagnostics when ALL URLs fail", async () => {
    fetchMock.mockResolvedValue(
      buildBearerResponse({
        ok: false,
        status: 500,
        statusText: "Server Error",
      })
    );
    const result = await fetchGroupSites(VALID_CONTEXT, "tok", {
      groupId: "group-abc",
    });
    expect(result.sites).toEqual([]);
    expect(result.resolvedEndpointUrl).toBeNull();
    const preview = result.rawPreview as {
      error: string;
      attempts: unknown[];
    };
    expect(preview.error).toMatch(/No sites found in \d+ URL candidate/);
  });

  it("trims surrounding whitespace from groupId before building URLs", async () => {
    fetchMock.mockResolvedValueOnce(
      buildBearerResponse({
        ok: true,
        contentType: "application/json",
        json: siteListPayload([SITE_UUID_1]),
      })
    );
    await fetchGroupSites(VALID_CONTEXT, "tok", {
      groupId: "  group-trimmed  ",
    });
    const [url] = fetchMock.mock.calls[0];
    // The group ID appears in the URL with no surrounding whitespace.
    expect(url).toMatch(/group-trimmed/);
    expect(url).not.toMatch(/\s/);
  });
});
