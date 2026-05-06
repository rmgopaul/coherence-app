/**
 * Locus adapter — integration tests w/ fetch mock.
 *
 * Concern #1 slice 5 PR-A from the PRs 366-383 review. Locus is the
 * smallest non-Hoymiles solar adapter (~444 LOC) with ZERO existing
 * test coverage. This slice establishes the fetch-mock pattern for
 * Locus by covering `listSites` — the public entry point used by
 * monitoring + dashboard — end-to-end through OAuth2 client-credentials
 * token + per-partner site listing.
 *
 * Why this slice / why now
 * ------------------------
 * Slices 3-4e proved the `vi.stubGlobal("fetch", ...)` pattern
 * across two adapters (Tesla bearer-token + eGauge digest-auth).
 * Locus is a third distinct auth shape: OAuth2 client_credentials
 * with form-encoded body (different from Tesla's JSON body) plus
 * an in-memory token cache (different from Tesla's stateless
 * per-call token fetches). Coverage here proves the pattern carries
 * to a third adapter and pins the cache contract — a regression
 * that disabled caching would silently quadruple Locus API
 * call volume against rate limits.
 *
 * The exported `extractSites` pure helper (called by `listSites`)
 * gets indirect coverage through these tests. If pure-helper
 * dedicated rails become valuable in the future, they can be added
 * to a `__TEST_ONLY__` block — for now the integration coverage is
 * cheaper and exercises the same code path.
 *
 * Test strategy
 * -------------
 * - Each test uses a UNIQUE `clientId` so the module-level
 *   `locusTokenCache` stays clean between tests (cache key is
 *   `${clientId}::${baseUrl}`). The cache-hit test deliberately
 *   reuses a clientId across two `listSites` calls.
 * - Error-path tests use 401 (AuthError) instead of 500 because
 *   `fetchJson` retries up to 2x on 5xx with 1s + 2s backoffs —
 *   401 short-circuits to `AuthError` on the first attempt.
 * - Token-fetch errors use `getLocusAccessToken`'s direct `fetch`
 *   call (NOT through `fetchJson`), so 5xx there is fine and
 *   doesn't trigger retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSites, type LocusApiContext } from "./locus";

const BASE_URL = "https://api.locusenergy.com/v3";

function makeContext(suffix: string): LocusApiContext {
  // Unique clientId per test prevents `locusTokenCache` cross-test pollution.
  return {
    clientId: `client-${suffix}`,
    clientSecret: "secret",
    partnerId: "partner-001",
    baseUrl: BASE_URL,
  };
}

function buildLocusResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  json?: unknown;
}): Response {
  const status = opts.status ?? (opts.ok ? 200 : 500);
  return {
    ok: opts.ok,
    status,
    statusText: opts.statusText ?? (opts.ok ? "OK" : "Internal Server Error"),
    headers: {
      get: () => null,
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

const SITE_PAYLOAD_CANONICAL = {
  sites: [
    {
      id: "site-A",
      name: "Acme",
      nameplate: 7500,
      address: "123 Sun St",
      timezone: "America/Chicago",
      status: "active",
    },
    {
      id: "site-B",
      siteName: "Beta",
      capacity: 5000,
      status: null,
    },
  ],
};

describe("listSites (integration)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("happy path: token + sites endpoint returns parsed LocusSite[]", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok-1", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: SITE_PAYLOAD_CANONICAL })
    );
    const result = await listSites(makeContext("happy"));
    expect(result.sites).toHaveLength(2);
    expect(result.sites[0]).toEqual({
      siteId: "site-A",
      name: "Acme",
      capacity: 7500,
      address: "123 Sun St",
      timeZone: "America/Chicago",
      status: "active",
    });
    // Field-alias coverage: siteName picked up when `name` is absent;
    // capacity from `capacity` when `nameplate` is absent.
    expect(result.sites[1].name).toBe("Beta");
    expect(result.sites[1].capacity).toBe(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("token request: POSTs form-encoded body to /oauth/token with grant_type=client_credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(makeContext("token-shape"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/oauth/token`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["Accept"]).toBe("application/json");
    const body = (init as RequestInit).body as string;
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("client-token-shape");
    expect(params.get("client_secret")).toBe("secret");
  });

  it("sites endpoint: hits /partners/<partnerId>/sites with Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok-bearer", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(makeContext("sites-url"));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE_URL}/partners/partner-001/sites`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-bearer");
  });

  it("sites endpoint: URL-encodes partnerId with reserved characters", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites({
      ...makeContext("encode"),
      partnerId: "partner/with/slash",
    });
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE_URL}/partners/partner%2Fwith%2Fslash/sites`);
  });

  it("token caching: a second listSites call with the same clientId reuses the cached token (no /oauth/token re-fetch)", async () => {
    const ctx = makeContext("cache");
    // First call: token fetch + sites fetch.
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok-cached", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call: cache hit → only the sites fetch fires.
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Last call MUST be the sites endpoint, not /oauth/token.
    const lastUrl = fetchMock.mock.calls[2][0] as string;
    expect(lastUrl).toBe(`${BASE_URL}/partners/partner-001/sites`);
    // Same Bearer token reused.
    const lastHeaders = (fetchMock.mock.calls[2][1] as RequestInit)
      .headers as Record<string, string>;
    expect(lastHeaders["Authorization"]).toBe("Bearer tok-cached");
  });

  it("token failure: throws when /oauth/token returns non-OK (no sites fetch)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })
    );
    await expect(listSites(makeContext("tok-fail"))).rejects.toThrow(
      /OAuth2 token request failed.*401/i
    );
    // Token failure short-circuits — sites endpoint never hit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token failure: 500 body included in error message for operator visibility", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: false,
        status: 500,
        body: "Service temporarily unavailable",
      })
    );
    await expect(listSites(makeContext("tok-500"))).rejects.toThrow(
      /Service temporarily unavailable/
    );
  });

  it("token success but missing access_token: throws explicit error", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { unrelated: "value" }, // no access_token field
      })
    );
    await expect(listSites(makeContext("no-token"))).rejects.toThrow(
      /no access_token was returned/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token expires_in default: missing expires_in falls back to 3600s (so cache works)", async () => {
    const ctx = makeContext("expires-default");
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        // No expires_in — implementation defaults to 3600.
        json: { access_token: "tok-defaulted" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(ctx);
    // A second call within 3600s should hit the cache.
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { sites: [] } })
    );
    await listSites(ctx);
    // Total fetches = 1 token + 2 sites (token cached on 2nd call).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sites parser: accepts top-level array as the sites list", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: [
          { id: "site-1", name: "Solo Site" },
          { id: "site-2", name: "Other" },
        ],
      })
    );
    const result = await listSites(makeContext("top-array"));
    expect(result.sites).toHaveLength(2);
    expect(result.sites[0].siteId).toBe("site-1");
  });

  it("sites parser: accepts `data` envelope as the sites list", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { data: [{ id: "site-data", name: "Envelope" }] },
      })
    );
    const result = await listSites(makeContext("data-env"));
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].siteId).toBe("site-data");
  });

  it("sites parser: drops rows without a recognizable site ID", async () => {
    // Defends against a regression where `extractSites` fabricates
    // site IDs from non-id fields and pollutes the inventory.
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: {
          sites: [
            { id: "site-keeper", name: "Keep" },
            { name: "No ID — should be dropped" },
            { id: "", name: "Empty ID — also dropped" },
          ],
        },
      })
    );
    const result = await listSites(makeContext("drop-no-id"));
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].siteId).toBe("site-keeper");
  });

  it("sites parser: returns empty array when the payload has no recognizable list", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({ ok: true, json: { unrelated: "value" } })
    );
    const result = await listSites(makeContext("empty-shape"));
    expect(result.sites).toEqual([]);
  });

  it("sites endpoint 401: surfaces as AuthError without retry (production token-rotation case)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: true,
        json: { access_token: "tok", expires_in: 3600 },
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildLocusResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })
    );
    await expect(listSites(makeContext("401-rotation"))).rejects.toThrow(
      /authentication failed.*401/i
    );
    // 1 token + 1 sites attempt = 2. AuthError doesn't retry, so the
    // sites endpoint is hit exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
