import { describe, expect, it, vi } from "vitest";
import {
  extractRetryAfterMsFromError,
  injectRetryAfterIntoBody,
  parseRetryAfterMs,
  wrapFetchWithRetryAfterCapture,
} from "./dashboardRetryAfter";

describe("parseRetryAfterMs", () => {
  it("parses integer-seconds form", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("60")).toBe(60_000);
  });

  it("parses fractional-seconds form (uncommon but spec-compliant)", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1500);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseRetryAfterMs("  5  ")).toBe(5000);
  });

  it("parses HTTP-date form (relative to now)", () => {
    const now = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(30_000);
  });

  it("returns 0 for HTTP-dates in the past (per spec, server's idea of 'now' may have drifted)", () => {
    const now = 1_700_000_000_000;
    const past = new Date(now - 30_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it("returns null for missing / empty / malformed headers", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("not-a-number")).toBeNull();
    // Negative seconds are spec-non-compliant; null guards against
    // a malformed server.
    expect(parseRetryAfterMs("-1")).toBeNull();
  });
});

describe("injectRetryAfterIntoBody", () => {
  it("injects retryAfterMs into a single-call tRPC error envelope", () => {
    const body = {
      error: {
        json: {
          message: "Server heap pressure — retry in a moment",
          code: -32_603,
          data: {
            code: "TOO_MANY_REQUESTS",
            httpStatus: 429,
          },
        },
      },
    };
    const result = injectRetryAfterIntoBody(body, 5000);
    expect(
      (result as typeof body).error.json.data
    ).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      httpStatus: 429,
      retryAfterMs: 5000,
    });
  });

  it("injects into every envelope of a batched tRPC error response", () => {
    const body = [
      {
        error: {
          json: {
            data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
          },
        },
      },
      {
        error: {
          json: {
            data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
          },
        },
      },
    ];
    injectRetryAfterIntoBody(body, 7500);
    expect(body[0]!.error.json.data).toMatchObject({ retryAfterMs: 7500 });
    expect(body[1]!.error.json.data).toMatchObject({ retryAfterMs: 7500 });
  });

  it("is a no-op for unrecognized body shapes (HTML error pages, etc.)", () => {
    expect(injectRetryAfterIntoBody("just a string", 5000)).toBe(
      "just a string"
    );
    expect(injectRetryAfterIntoBody(null, 5000)).toBeNull();
    expect(injectRetryAfterIntoBody(undefined, 5000)).toBeUndefined();
    expect(injectRetryAfterIntoBody(42, 5000)).toBe(42);
  });

  it("is a no-op when the envelope has no `data` field (malformed but tolerable)", () => {
    const body = { error: { json: { message: "no data here" } } };
    const before = JSON.stringify(body);
    injectRetryAfterIntoBody(body, 5000);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("mixes success + error envelopes in batched responses safely", () => {
    const body = [
      { result: { data: { ok: true } } },
      {
        error: {
          json: { data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } },
        },
      },
    ];
    injectRetryAfterIntoBody(body, 5000);
    expect(body[0]).toEqual({ result: { data: { ok: true } } }); // unchanged
    expect(body[1]!.error.json.data).toMatchObject({ retryAfterMs: 5000 });
  });
});

describe("extractRetryAfterMsFromError", () => {
  it("returns the value from `error.data.retryAfterMs` (post-injection shape)", () => {
    expect(
      extractRetryAfterMsFromError({
        data: { httpStatus: 429, retryAfterMs: 5000 },
      })
    ).toBe(5000);
  });

  it("returns null when the field is missing / non-numeric / negative", () => {
    expect(extractRetryAfterMsFromError({ data: {} })).toBeNull();
    expect(extractRetryAfterMsFromError({})).toBeNull();
    expect(
      extractRetryAfterMsFromError({ data: { retryAfterMs: "5000" } })
    ).toBeNull();
    expect(
      extractRetryAfterMsFromError({ data: { retryAfterMs: NaN } })
    ).toBeNull();
    expect(
      extractRetryAfterMsFromError({ data: { retryAfterMs: -1 } })
    ).toBeNull();
  });

  it("tolerates non-object errors (string, null, undefined)", () => {
    expect(extractRetryAfterMsFromError(null)).toBeNull();
    expect(extractRetryAfterMsFromError(undefined)).toBeNull();
    expect(extractRetryAfterMsFromError("string")).toBeNull();
    expect(extractRetryAfterMsFromError(42)).toBeNull();
  });
});

describe("wrapFetchWithRetryAfterCapture", () => {
  function makeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      statusText: "ERR",
      headers,
    });
  }

  it("passes through 200 OK responses unchanged", async () => {
    const inner = vi.fn(async () =>
      makeResponse(200, { result: { data: { ok: true } } })
    );
    const wrapped = wrapFetchWithRetryAfterCapture(inner);
    const result = await wrapped("https://example/test");
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toEqual({ result: { data: { ok: true } } });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("passes through transient responses with no Retry-After header unchanged", async () => {
    const inner = vi.fn(async () =>
      makeResponse(429, {
        error: { json: { data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } } },
      })
    );
    const wrapped = wrapFetchWithRetryAfterCapture(inner);
    const result = await wrapped("https://example/test");
    expect(result.status).toBe(429);
    const body = await result.json();
    expect(body.error.json.data).not.toHaveProperty("retryAfterMs");
  });

  it("injects retryAfterMs into a 429 response carrying Retry-After: 5", async () => {
    const inner = vi.fn(async () =>
      makeResponse(
        429,
        {
          error: {
            json: { data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } },
          },
        },
        { "Retry-After": "5" }
      )
    );
    const wrapped = wrapFetchWithRetryAfterCapture(inner);
    const result = await wrapped("https://example/test");
    expect(result.status).toBe(429);
    const body = await result.json();
    expect(body.error.json.data).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      httpStatus: 429,
      retryAfterMs: 5000,
    });
  });

  it("injects retryAfterMs for every transient-overload status (502 / 503 / 504)", async () => {
    for (const status of [502, 503, 504]) {
      const inner = vi.fn(async () =>
        makeResponse(
          status,
          {
            error: { json: { data: { httpStatus: status } } },
          },
          { "Retry-After": "10" }
        )
      );
      const wrapped = wrapFetchWithRetryAfterCapture(inner);
      const result = await wrapped("https://example/test");
      const body = await result.json();
      expect(body.error.json.data).toMatchObject({ retryAfterMs: 10_000 });
    }
  });

  it("does NOT inject retryAfterMs on non-transient errors (400, 401, 403, 500)", async () => {
    for (const status of [400, 401, 403, 500]) {
      const inner = vi.fn(async () =>
        makeResponse(
          status,
          { error: { json: { data: { httpStatus: status } } } },
          { "Retry-After": "5" }
        )
      );
      const wrapped = wrapFetchWithRetryAfterCapture(inner);
      const result = await wrapped("https://example/test");
      const body = await result.json();
      expect(body.error.json.data).not.toHaveProperty("retryAfterMs");
    }
  });

  it("preserves status, statusText, and headers on the rewritten response", async () => {
    const inner = vi.fn(async () =>
      makeResponse(
        429,
        { error: { json: { data: { httpStatus: 429 } } } },
        { "Retry-After": "5", "X-Custom-Header": "preserved" }
      )
    );
    const wrapped = wrapFetchWithRetryAfterCapture(inner);
    const result = await wrapped("https://example/test");
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("5");
    expect(result.headers.get("X-Custom-Header")).toBe("preserved");
  });

  it("tolerates malformed JSON bodies (returns the original text in a fresh Response)", async () => {
    const inner = vi.fn(async () => {
      return new Response("not valid json {[", {
        status: 429,
        headers: { "Retry-After": "5" },
      });
    });
    const wrapped = wrapFetchWithRetryAfterCapture(inner);
    const result = await wrapped("https://example/test");
    expect(result.status).toBe(429);
    expect(await result.text()).toBe("not valid json {[");
  });

  it("uses a caller-supplied `now` for HTTP-date Retry-After parsing", async () => {
    const fixedNow = 1_700_000_000_000;
    const future = new Date(fixedNow + 7000).toUTCString();
    const inner = vi.fn(async () =>
      makeResponse(
        429,
        { error: { json: { data: { httpStatus: 429 } } } },
        { "Retry-After": future }
      )
    );
    const wrapped = wrapFetchWithRetryAfterCapture(inner, {
      now: () => fixedNow,
    });
    const result = await wrapped("https://example/test");
    const body = await result.json();
    expect(body.error.json.data.retryAfterMs).toBe(7000);
  });
});
