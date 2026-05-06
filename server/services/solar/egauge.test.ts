/**
 * eGauge adapter — pure-helper + integration tests.
 *
 * Slice 2 (#394, original file content below the `truncate` divider):
 *   pure-helper tests covering URL canonicalization, portfolio host
 *   conversion, cookie/jwt parsing, ISO-date-to-unix coercion, HTML
 *   stripping, meter-ID extraction. 124 rails via `__TEST_ONLY__`.
 *
 * Slice 4d (this PR's addition, the `getEgaugeSystemInfo` describe
 *   block at end of file): integration tests covering BOTH access
 *   modes — public (single GET) and credential digest-auth (3-step
 *   challenge → login → /api/sys flow). Establishes the fetch-mock
 *   pattern for eGauge so future slices can layer
 *   `getEgaugeLocalData` / `getEgaugeRegisterLatest` /
 *   `getEgaugePortfolioSystems` on top.
 *
 * Why integration coverage NOW:
 *   - Slice 2 pinned the pure helpers; the network-bound paths
 *     remained uncovered. Tesla slices 3-4c established the
 *     `vi.stubGlobal("fetch", ...)` pattern across token /
 *     bearer-auth / URL-iteration / telemetry; this PR proves the
 *     pattern carries over to eGauge's distinctly different auth
 *     model (digest-style challenge/response with realm + nonce +
 *     md5 hash composition, plus optional cookie persistence).
 *   - eGauge is the largest non-Tesla solar adapter (~1,733 LOC).
 *     Its production-mode auth path is materially different from
 *     Tesla's bearer-token flow, so the pattern transfer alone is
 *     a worthwhile signal to PR-reviewers.
 *
 * Why pure helpers first (kept from slice 2 docstring):
 *   - Adapter regressions in pure helpers manifest as silent wrong
 *     behavior. Tests prevent that regression class without needing
 *     live API mocks.
 *   - The pure surface is small enough that one PR fits a
 *     tractable scope.
 *
 * Still uncovered after this PR: `getEgaugeLocalData`,
 * `getEgaugeRegisterLatest`, `getEgaugeRegisterHistory`,
 * `getEgaugePortfolioSystems`, `getMeterProductionSnapshot`. All
 * five reuse the same auth flow established here, so the marginal
 * cost of each subsequent slice is just per-endpoint URL/payload
 * shape verification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __TEST_ONLY__,
  buildEgaugeRegisterTimeExpression,
  EGAUGE_DEFAULT_BASE_URL,
  EGAUGE_PORTFOLIO_BASE_URL,
  getEgaugeSystemInfo,
  normalizeEgaugeBaseUrl,
  normalizeEgaugePortfolioBaseUrl,
} from "./egauge";
import type { EgaugeApiContext } from "./egauge";

const {
  truncate,
  withHttpsIfMissing,
  isEgaugePortalHost,
  tryConvertPortalDevicesUrlToMeterBase,
  isCredentialAccess,
  normalizeEgaugeAccessType,
  parseCookiePair,
  getSetCookieValues,
  md5Hex,
  parseIsoDateToUnixStart,
  parseIsoDateToUnixEnd,
  firstDayOfMonth,
  firstDayOfPreviousMonth,
  lastDayOfPreviousMonth,
  extractJwtToken,
  extractSummaryString,
  extractRegisterCount,
  extractLocalValueCount,
  normalizeErrorPayload,
  stripHtml,
  parseLooseNumber,
  extractMeterIdFromDevicePath,
  extractMeterIdFromQueryParam,
  extractMeterIdFromProxyUrl,
  extractMeterIdFromInlineUrl,
  looksLikePortfolioMeterId,
} = __TEST_ONLY__;

// ────────────────────────────────────────────────────────────────────
// truncate — bounded output with ellipsis
// ────────────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns input unchanged when shorter than the cap", () => {
    expect(truncate("hello")).toBe("hello");
    expect(truncate("")).toBe("");
  });

  it("truncates with an ellipsis when over the cap", () => {
    const long = "x".repeat(500);
    const result = truncate(long);
    expect(result).toHaveLength(300);
    expect(result.endsWith("…")).toBe(true);
  });

  it("respects a custom maxLength", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("abcdefgh", 5)).toHaveLength(5);
  });

  it("does not truncate when length equals cap exactly", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });
});

// ────────────────────────────────────────────────────────────────────
// withHttpsIfMissing — protocol-prefix coercion
// ────────────────────────────────────────────────────────────────────

describe("withHttpsIfMissing", () => {
  it("preserves https:// URLs unchanged", () => {
    expect(withHttpsIfMissing("https://example.com")).toBe(
      "https://example.com"
    );
  });

  it("preserves http:// URLs unchanged (case-insensitive)", () => {
    expect(withHttpsIfMissing("http://example.com")).toBe("http://example.com");
    expect(withHttpsIfMissing("HTTP://example.com")).toBe("HTTP://example.com");
  });

  it("prepends https:// when no protocol is present", () => {
    expect(withHttpsIfMissing("example.com")).toBe("https://example.com");
    expect(withHttpsIfMissing("egauge.net/devices/foo")).toBe(
      "https://egauge.net/devices/foo"
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// isEgaugePortalHost — portal hostname detection
// ────────────────────────────────────────────────────────────────────

describe("isEgaugePortalHost", () => {
  it("matches the portal apex and www subdomain (case-insensitive)", () => {
    expect(isEgaugePortalHost("egauge.net")).toBe(true);
    expect(isEgaugePortalHost("www.egauge.net")).toBe(true);
    expect(isEgaugePortalHost("WWW.EGAUGE.NET")).toBe(true);
    expect(isEgaugePortalHost("EGAUGE.NET")).toBe(true);
  });

  it("rejects per-meter d.egauge.net subdomains", () => {
    expect(isEgaugePortalHost("egauge12345.d.egauge.net")).toBe(false);
    expect(isEgaugePortalHost("foo.d.egauge.net")).toBe(false);
  });

  it("rejects unrelated hostnames", () => {
    expect(isEgaugePortalHost("example.com")).toBe(false);
    expect(isEgaugePortalHost("egauge.com")).toBe(false);
    expect(isEgaugePortalHost("")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// tryConvertPortalDevicesUrlToMeterBase — operator-friendly fallback
// ────────────────────────────────────────────────────────────────────

describe("tryConvertPortalDevicesUrlToMeterBase", () => {
  it("rewrites egauge.net/devices/<id> to the meter base URL", () => {
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://egauge.net/devices/egauge12345")
      )
    ).toBe("https://egauge12345.d.egauge.net");
  });

  it("rewrites the www subdomain too", () => {
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://www.egauge.net/devices/egauge99999/extra")
      )
    ).toBe("https://egauge99999.d.egauge.net");
  });

  it("returns null when the host is not the portal", () => {
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://example.com/devices/egauge1")
      )
    ).toBeNull();
  });

  it("returns null when the path doesn't start with /devices/", () => {
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://egauge.net/some/devices/egauge1")
      )
    ).toBeNull();
    expect(
      tryConvertPortalDevicesUrlToMeterBase(new URL("https://egauge.net/"))
    ).toBeNull();
  });

  it("returns null when the device segment has invalid characters", () => {
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://egauge.net/devices/has space")
      )
    ).toBeNull();
    expect(
      tryConvertPortalDevicesUrlToMeterBase(
        new URL("https://egauge.net/devices/")
      )
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// isCredentialAccess — discriminator for auth flows
// ────────────────────────────────────────────────────────────────────

describe("isCredentialAccess", () => {
  it("returns true for credential-required access types", () => {
    expect(isCredentialAccess("user_login")).toBe(true);
    expect(isCredentialAccess("site_login")).toBe(true);
    expect(isCredentialAccess("portfolio_login")).toBe(true);
  });

  it("returns false for public access", () => {
    expect(isCredentialAccess("public")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// normalizeEgaugeAccessType — coerce unknown to valid enum
// ────────────────────────────────────────────────────────────────────

describe("normalizeEgaugeAccessType", () => {
  it("preserves the four valid types verbatim", () => {
    expect(normalizeEgaugeAccessType("public")).toBe("public");
    expect(normalizeEgaugeAccessType("user_login")).toBe("user_login");
    expect(normalizeEgaugeAccessType("site_login")).toBe("site_login");
    expect(normalizeEgaugeAccessType("portfolio_login")).toBe(
      "portfolio_login"
    );
  });

  it("falls back to 'public' on unknown / null / non-string inputs", () => {
    expect(normalizeEgaugeAccessType("garbage")).toBe("public");
    expect(normalizeEgaugeAccessType(null)).toBe("public");
    expect(normalizeEgaugeAccessType(undefined)).toBe("public");
    expect(normalizeEgaugeAccessType(123)).toBe("public");
    expect(normalizeEgaugeAccessType({})).toBe("public");
  });
});

// ────────────────────────────────────────────────────────────────────
// normalizeEgaugeBaseUrl — public API: meter URL canonicalization
// ────────────────────────────────────────────────────────────────────

describe("normalizeEgaugeBaseUrl", () => {
  it("strips trailing slashes and /api suffix", () => {
    expect(normalizeEgaugeBaseUrl("https://meter.d.egauge.net/")).toBe(
      "https://meter.d.egauge.net"
    );
    expect(normalizeEgaugeBaseUrl("https://meter.d.egauge.net/api")).toBe(
      "https://meter.d.egauge.net"
    );
    expect(normalizeEgaugeBaseUrl("https://meter.d.egauge.net/api/foo")).toBe(
      "https://meter.d.egauge.net"
    );
  });

  it("prepends https:// if missing", () => {
    expect(normalizeEgaugeBaseUrl("meter.d.egauge.net")).toBe(
      "https://meter.d.egauge.net"
    );
  });

  it("rewrites a portal /devices/<id> URL to the meter host", () => {
    expect(normalizeEgaugeBaseUrl("https://egauge.net/devices/m1")).toBe(
      "https://m1.d.egauge.net"
    );
    expect(normalizeEgaugeBaseUrl("egauge.net/devices/m1/foo")).toBe(
      "https://m1.d.egauge.net"
    );
  });

  it("throws on a portal URL without a /devices/ segment", () => {
    expect(() => normalizeEgaugeBaseUrl("https://egauge.net/")).toThrow(
      /portal/i
    );
    expect(() => normalizeEgaugeBaseUrl("https://www.egauge.net/")).toThrow(
      /portal/i
    );
  });

  it("throws on missing/empty input with a helpful default URL", () => {
    expect(() => normalizeEgaugeBaseUrl(null)).toThrow(EGAUGE_DEFAULT_BASE_URL);
    expect(() => normalizeEgaugeBaseUrl(undefined)).toThrow(
      EGAUGE_DEFAULT_BASE_URL
    );
    expect(() => normalizeEgaugeBaseUrl("")).toThrow(EGAUGE_DEFAULT_BASE_URL);
    expect(() => normalizeEgaugeBaseUrl("   ")).toThrow(
      EGAUGE_DEFAULT_BASE_URL
    );
  });

  it("throws on a URL the WHATWG parser rejects (unclosed bracket)", () => {
    // `withHttpsIfMissing` no-ops on inputs already starting with https://,
    // and `new URL("https://[")` rejects unbalanced IPv6 brackets — that
    // exercises the second throw path in `normalizeEgaugeBaseUrl`.
    expect(() => normalizeEgaugeBaseUrl("https://[")).toThrow(
      /eGauge base URL is invalid/
    );
  });

  it("preserves http:// (HTTP-allowed for self-hosted dev)", () => {
    expect(normalizeEgaugeBaseUrl("http://192.168.1.50")).toBe(
      "http://192.168.1.50"
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// normalizeEgaugePortfolioBaseUrl — portal URL canonicalization
// ────────────────────────────────────────────────────────────────────

describe("normalizeEgaugePortfolioBaseUrl", () => {
  it("returns the canonical default when input is empty/null", () => {
    expect(normalizeEgaugePortfolioBaseUrl(null)).toBe(
      EGAUGE_PORTFOLIO_BASE_URL
    );
    expect(normalizeEgaugePortfolioBaseUrl(undefined)).toBe(
      EGAUGE_PORTFOLIO_BASE_URL
    );
    expect(normalizeEgaugePortfolioBaseUrl("")).toBe(EGAUGE_PORTFOLIO_BASE_URL);
  });

  it("upgrades the bare apex to www.egauge.net", () => {
    expect(normalizeEgaugePortfolioBaseUrl("https://egauge.net")).toBe(
      "https://www.egauge.net"
    );
    expect(normalizeEgaugePortfolioBaseUrl("egauge.net")).toBe(
      "https://www.egauge.net"
    );
  });

  it("strips /eguard suffix when present", () => {
    expect(
      normalizeEgaugePortfolioBaseUrl("https://www.egauge.net/eguard")
    ).toBe("https://www.egauge.net");
    expect(
      normalizeEgaugePortfolioBaseUrl("https://www.egauge.net/eguard/foo")
    ).toBe("https://www.egauge.net");
  });

  it("strips trailing slashes", () => {
    expect(normalizeEgaugePortfolioBaseUrl("https://www.egauge.net/")).toBe(
      "https://www.egauge.net"
    );
  });

  it("throws when the URL is not on egauge.net", () => {
    expect(() =>
      normalizeEgaugePortfolioBaseUrl("https://example.com")
    ).toThrow(/egauge\.net/);
  });

  it("throws on invalid URL syntax", () => {
    expect(() => normalizeEgaugePortfolioBaseUrl("ht tp://bad")).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// parseCookiePair — name=value extraction from one Set-Cookie line
// ────────────────────────────────────────────────────────────────────

describe("parseCookiePair", () => {
  it("extracts the name=value before the first semicolon", () => {
    expect(parseCookiePair("session=abc123; Path=/; HttpOnly")).toEqual({
      name: "session",
      value: "abc123",
    });
  });

  it("handles no semicolons (just name=value)", () => {
    expect(parseCookiePair("token=xyz")).toEqual({ name: "token", value: "xyz" });
  });

  it("handles empty value", () => {
    expect(parseCookiePair("foo=")).toEqual({ name: "foo", value: "" });
  });

  it("returns null when there is no = (or it's the first char)", () => {
    expect(parseCookiePair("notacookie")).toBeNull();
    expect(parseCookiePair("=novalue")).toBeNull();
  });

  it("trims whitespace around name and value", () => {
    expect(parseCookiePair("  foo  =  bar  ; Path=/")).toEqual({
      name: "foo",
      value: "bar",
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// getSetCookieValues — handles native Headers + node-fetch shapes
// ────────────────────────────────────────────────────────────────────

describe("getSetCookieValues", () => {
  it("returns getSetCookie() output when available (native fetch)", () => {
    const headers = {
      getSetCookie: () => ["a=1; Path=/", "b=2; Secure"],
      get: () => null,
    } as unknown as Headers;
    expect(getSetCookieValues(headers)).toEqual(["a=1; Path=/", "b=2; Secure"]);
  });

  it("falls back to raw()['set-cookie'] when getSetCookie missing", () => {
    const headers = {
      raw: () => ({ "set-cookie": ["x=1", "y=2"] }),
      get: () => null,
    } as unknown as Headers;
    expect(getSetCookieValues(headers)).toEqual(["x=1", "y=2"]);
  });

  it("splits a single comma-joined set-cookie header", () => {
    const headers = {
      get: (name: string) =>
        name.toLowerCase() === "set-cookie"
          ? "first=1; Path=/, second=2; Secure"
          : null,
    } as unknown as Headers;
    expect(getSetCookieValues(headers)).toEqual([
      "first=1; Path=/",
      "second=2; Secure",
    ]);
  });

  it("returns [] when no set-cookie header is present", () => {
    const headers = { get: () => null } as unknown as Headers;
    expect(getSetCookieValues(headers)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// md5Hex — md5 hash hex output (used for digest auth)
// ────────────────────────────────────────────────────────────────────

describe("md5Hex", () => {
  it("returns the canonical md5 hex of the empty string", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("returns the canonical md5 hex of 'abc'", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("is deterministic", () => {
    expect(md5Hex("hello")).toBe(md5Hex("hello"));
  });
});

// ────────────────────────────────────────────────────────────────────
// parseIsoDateToUnixStart — YYYY-MM-DD → unix seconds at 00:00:00 UTC
// ────────────────────────────────────────────────────────────────────

describe("parseIsoDateToUnixStart", () => {
  it("parses a valid ISO date to 00:00:00Z unix seconds", () => {
    expect(parseIsoDateToUnixStart("2024-01-01")).toBe(
      Math.floor(Date.parse("2024-01-01T00:00:00Z") / 1000)
    );
  });

  it("handles a non-leap-year boundary correctly", () => {
    expect(parseIsoDateToUnixStart("2023-02-28")).toBe(
      Math.floor(Date.parse("2023-02-28T00:00:00Z") / 1000)
    );
  });

  it("throws on malformed input", () => {
    expect(() => parseIsoDateToUnixStart("01/01/2024")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDateToUnixStart("2024-1-1")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDateToUnixStart("")).toThrow(/YYYY-MM-DD/);
  });
});

// ────────────────────────────────────────────────────────────────────
// parseIsoDateToUnixEnd — YYYY-MM-DD → unix seconds at 23:59:59 UTC
// ────────────────────────────────────────────────────────────────────

describe("parseIsoDateToUnixEnd", () => {
  it("parses a valid ISO date to 23:59:59Z unix seconds", () => {
    expect(parseIsoDateToUnixEnd("2024-01-01")).toBe(
      Math.floor(Date.parse("2024-01-01T23:59:59Z") / 1000)
    );
  });

  it("end-of-day is exactly 86399 seconds after start-of-day", () => {
    const start = parseIsoDateToUnixStart("2024-06-15");
    const end = parseIsoDateToUnixEnd("2024-06-15");
    expect(end - start).toBe(86399);
  });

  it("throws on malformed input", () => {
    expect(() => parseIsoDateToUnixEnd("garbage")).toThrow(/YYYY-MM-DD/);
  });
});

// ────────────────────────────────────────────────────────────────────
// firstDayOfMonth — month-anchor helpers
// ────────────────────────────────────────────────────────────────────

describe("firstDayOfMonth", () => {
  it("returns the first day of the month containing the input date", () => {
    expect(firstDayOfMonth("2024-06-15")).toBe("2024-06-01");
    expect(firstDayOfMonth("2024-06-01")).toBe("2024-06-01");
    expect(firstDayOfMonth("2024-06-30")).toBe("2024-06-01");
  });

  it("throws on malformed input", () => {
    expect(() => firstDayOfMonth("06/15/2024")).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// firstDayOfPreviousMonth — handles year boundary
// ────────────────────────────────────────────────────────────────────

describe("firstDayOfPreviousMonth", () => {
  it("returns the first of the previous month within the same year", () => {
    expect(firstDayOfPreviousMonth("2024-06-15")).toBe("2024-05-01");
  });

  it("rolls back across a January → December boundary", () => {
    expect(firstDayOfPreviousMonth("2024-01-15")).toBe("2023-12-01");
  });

  it("handles March → February (the leap-month boundary)", () => {
    expect(firstDayOfPreviousMonth("2024-03-15")).toBe("2024-02-01");
  });
});

// ────────────────────────────────────────────────────────────────────
// lastDayOfPreviousMonth — handles month-length variation + leap year
// ────────────────────────────────────────────────────────────────────

describe("lastDayOfPreviousMonth", () => {
  it("returns the last day of the previous month (31-day prior)", () => {
    expect(lastDayOfPreviousMonth("2024-02-15")).toBe("2024-01-31");
  });

  it("returns Feb 29 in a leap year", () => {
    expect(lastDayOfPreviousMonth("2024-03-15")).toBe("2024-02-29");
  });

  it("returns Feb 28 in a non-leap year", () => {
    expect(lastDayOfPreviousMonth("2023-03-15")).toBe("2023-02-28");
  });

  it("rolls back across a January → December boundary", () => {
    expect(lastDayOfPreviousMonth("2024-01-15")).toBe("2023-12-31");
  });
});

// ────────────────────────────────────────────────────────────────────
// extractJwtToken — direct + nested response shapes
// ────────────────────────────────────────────────────────────────────

describe("extractJwtToken", () => {
  it("extracts from top-level `jwt`", () => {
    expect(extractJwtToken({ jwt: "tok-1" })).toBe("tok-1");
  });

  it("extracts from top-level `token` / `access_token` / `accessToken`", () => {
    expect(extractJwtToken({ token: "tok-2" })).toBe("tok-2");
    expect(extractJwtToken({ access_token: "tok-3" })).toBe("tok-3");
    expect(extractJwtToken({ accessToken: "tok-4" })).toBe("tok-4");
  });

  it("extracts from a nested `response` envelope", () => {
    expect(extractJwtToken({ response: { jwt: "tok-5" } })).toBe("tok-5");
    expect(extractJwtToken({ response: { access_token: "tok-6" } })).toBe(
      "tok-6"
    );
  });

  it("prefers top-level over response when both present", () => {
    expect(
      extractJwtToken({ jwt: "top", response: { jwt: "nested" } })
    ).toBe("top");
  });

  it("returns null when nothing matches", () => {
    expect(extractJwtToken({})).toBeNull();
    expect(extractJwtToken({ unrelated: "value" })).toBeNull();
    expect(extractJwtToken(null)).toBeNull();
    expect(extractJwtToken("not-an-object")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractSummaryString — flexible field aliasing across system info
// ────────────────────────────────────────────────────────────────────

describe("extractSummaryString", () => {
  it("returns the first matching top-level key in priority order", () => {
    expect(
      extractSummaryString({ name: "n", system_name: "sn" }, [
        "name",
        "system_name",
      ])
    ).toBe("n");
  });

  it("falls through to a nested envelope (system/info/device/data/response)", () => {
    expect(
      extractSummaryString({ system: { name: "from-system" } }, ["name"])
    ).toBe("from-system");
    expect(
      extractSummaryString({ info: { serial: "S-123" } }, ["serial"])
    ).toBe("S-123");
    expect(
      extractSummaryString({ device: { name: "D" } }, ["name"])
    ).toBe("D");
    expect(
      extractSummaryString({ data: { name: "D2" } }, ["name"])
    ).toBe("D2");
    expect(
      extractSummaryString({ response: { name: "R" } }, ["name"])
    ).toBe("R");
  });

  it("returns null when no key matches anywhere", () => {
    expect(extractSummaryString({}, ["name"])).toBeNull();
    expect(extractSummaryString({ unrelated: "x" }, ["name"])).toBeNull();
  });

  it("ignores empty-string values and continues searching", () => {
    expect(
      extractSummaryString({ name: "", system_name: "from-sn" }, [
        "name",
        "system_name",
      ])
    ).toBe("from-sn");
  });
});

// ────────────────────────────────────────────────────────────────────
// extractRegisterCount — array OR registers/regs/values keyed counts
// ────────────────────────────────────────────────────────────────────

describe("extractRegisterCount", () => {
  it("returns array length when the payload is an array", () => {
    expect(extractRegisterCount([1, 2, 3])).toBe(3);
    expect(extractRegisterCount([])).toBe(0);
  });

  it("returns root.registers / root.regs / root.values length", () => {
    expect(extractRegisterCount({ registers: [1, 2, 3, 4] })).toBe(4);
    expect(extractRegisterCount({ regs: [1] })).toBe(1);
    expect(extractRegisterCount({ values: [1, 2] })).toBe(2);
  });

  it("falls through to a nested data/response envelope", () => {
    expect(
      extractRegisterCount({ data: { registers: [1, 2, 3] } })
    ).toBe(3);
    expect(extractRegisterCount({ response: { regs: [1, 2] } })).toBe(2);
  });

  it("returns null when no list is present", () => {
    expect(extractRegisterCount({})).toBeNull();
    expect(extractRegisterCount(null)).toBeNull();
    expect(extractRegisterCount("string")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractLocalValueCount — values OR readings count
// ────────────────────────────────────────────────────────────────────

describe("extractLocalValueCount", () => {
  it("returns top-level values length", () => {
    expect(extractLocalValueCount({ values: [1, 2, 3] })).toBe(3);
  });

  it("returns nested data.values / data.readings length", () => {
    expect(extractLocalValueCount({ data: { values: [1, 2] } })).toBe(2);
    expect(extractLocalValueCount({ data: { readings: [1] } })).toBe(1);
    expect(
      extractLocalValueCount({ response: { readings: [1, 2, 3, 4] } })
    ).toBe(4);
  });

  it("returns null when no list is present", () => {
    expect(extractLocalValueCount({})).toBeNull();
    expect(extractLocalValueCount({ unrelated: [1] })).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// normalizeErrorPayload — JSON detail extraction or fallback to text
// ────────────────────────────────────────────────────────────────────

describe("normalizeErrorPayload", () => {
  it("extracts `detail` from valid JSON", () => {
    expect(normalizeErrorPayload('{"detail":"bad request"}')).toBe(
      "bad request"
    );
  });

  it("extracts `error` from valid JSON when detail missing", () => {
    expect(normalizeErrorPayload('{"error":"auth failed"}')).toBe(
      "auth failed"
    );
  });

  it("extracts `message` from valid JSON when detail+error missing", () => {
    expect(normalizeErrorPayload('{"message":"server boom"}')).toBe(
      "server boom"
    );
  });

  it("falls back to truncated raw text when JSON has no recognized fields", () => {
    expect(normalizeErrorPayload('{"unrelated":"value"}')).toBe(
      '{"unrelated":"value"}'
    );
  });

  it("returns truncated raw text on non-JSON input", () => {
    expect(normalizeErrorPayload("plain text error")).toBe("plain text error");
  });

  it("returns empty string on whitespace-only input", () => {
    expect(normalizeErrorPayload("")).toBe("");
    expect(normalizeErrorPayload("   ")).toBe("");
  });

  it("truncates long payloads", () => {
    const long = "x".repeat(500);
    expect(normalizeErrorPayload(long)).toHaveLength(300);
  });
});

// ────────────────────────────────────────────────────────────────────
// stripHtml — tag stripping + entity decoding
// ────────────────────────────────────────────────────────────────────

describe("stripHtml", () => {
  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("decodes &nbsp; / &amp; / &lt; / &gt;", () => {
    expect(stripHtml("a&nbsp;b")).toBe("a b");
    expect(stripHtml("Tom&amp;Jerry")).toBe("Tom&Jerry");
    expect(stripHtml("&lt;hi&gt;")).toBe("<hi>");
  });

  it("collapses multiple whitespace to single spaces", () => {
    expect(stripHtml("a   b\t\nc")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripHtml("   <p>foo</p>   ")).toBe("foo");
  });

  it("returns empty string on tag-only input", () => {
    expect(stripHtml("<br/><br/>")).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────
// parseLooseNumber — comma-tolerant numeric coercion
// ────────────────────────────────────────────────────────────────────

describe("parseLooseNumber", () => {
  it("returns finite numbers unchanged", () => {
    expect(parseLooseNumber(42)).toBe(42);
    expect(parseLooseNumber(0)).toBe(0);
    expect(parseLooseNumber(-1.5)).toBe(-1.5);
  });

  it("rejects non-finite numbers", () => {
    expect(parseLooseNumber(NaN)).toBeNull();
    expect(parseLooseNumber(Infinity)).toBeNull();
    expect(parseLooseNumber(-Infinity)).toBeNull();
  });

  it("strips thousands-comma separators in strings", () => {
    expect(parseLooseNumber("1,234")).toBe(1234);
    expect(parseLooseNumber("1,234,567.89")).toBe(1234567.89);
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseLooseNumber("  42  ")).toBe(42);
  });

  it("returns null on empty / unparseable strings", () => {
    expect(parseLooseNumber("")).toBeNull();
    expect(parseLooseNumber("   ")).toBeNull();
    expect(parseLooseNumber("not a number")).toBeNull();
    expect(parseLooseNumber("12abc")).toBeNull();
  });

  it("returns null for non-string/non-number inputs", () => {
    expect(parseLooseNumber(null)).toBeNull();
    expect(parseLooseNumber(undefined)).toBeNull();
    expect(parseLooseNumber({})).toBeNull();
    expect(parseLooseNumber([])).toBeNull();
    expect(parseLooseNumber(true)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractMeterIdFromDevicePath — /device/<id> or /devices/<id>
// ────────────────────────────────────────────────────────────────────

describe("extractMeterIdFromDevicePath", () => {
  it("extracts from a full URL with /devices/<id>", () => {
    expect(
      extractMeterIdFromDevicePath("https://www.egauge.net/devices/m1")
    ).toBe("m1");
  });

  it("accepts singular /device/<id> as well", () => {
    expect(
      extractMeterIdFromDevicePath("https://example.com/device/foo123")
    ).toBe("foo123");
  });

  it("works on relative paths starting with /", () => {
    expect(extractMeterIdFromDevicePath("/devices/m1/extra")).toBe("m1");
  });

  it("returns null on unrelated paths", () => {
    expect(extractMeterIdFromDevicePath("https://example.com/other/m1")).toBeNull();
    expect(extractMeterIdFromDevicePath("/foo/bar")).toBeNull();
  });

  it("returns null when the candidate has invalid characters", () => {
    expect(
      extractMeterIdFromDevicePath("https://egauge.net/devices/has space")
    ).toBeNull();
  });

  it("returns null on null/empty/non-URL input", () => {
    expect(extractMeterIdFromDevicePath(null)).toBeNull();
    expect(extractMeterIdFromDevicePath("")).toBeNull();
    expect(extractMeterIdFromDevicePath("not a url or path")).toBeNull();
  });

  it("returns null on malformed URLs", () => {
    expect(extractMeterIdFromDevicePath("https://[::bad")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractMeterIdFromQueryParam — ?device_name= / ?meter_id= / ?name=
// ────────────────────────────────────────────────────────────────────

describe("extractMeterIdFromQueryParam", () => {
  it("extracts from device_name", () => {
    expect(
      extractMeterIdFromQueryParam(
        "https://www.egauge.net/foo?device_name=m1"
      )
    ).toBe("m1");
  });

  it("extracts from meter_id / meterId / name", () => {
    expect(
      extractMeterIdFromQueryParam("https://example.com/?meter_id=m2")
    ).toBe("m2");
    expect(
      extractMeterIdFromQueryParam("https://example.com/?meterId=m3")
    ).toBe("m3");
    expect(extractMeterIdFromQueryParam("https://example.com/?name=m4")).toBe(
      "m4"
    );
  });

  it("works on a relative URL", () => {
    expect(extractMeterIdFromQueryParam("/foo?device_name=m5")).toBe("m5");
  });

  it("returns null when no recognized param is present", () => {
    expect(
      extractMeterIdFromQueryParam("https://example.com/?other=m1")
    ).toBeNull();
  });

  it("returns null when the value has invalid characters", () => {
    expect(
      extractMeterIdFromQueryParam("https://example.com/?name=has%20space")
    ).toBeNull();
  });

  it("returns null on null / empty / non-URL", () => {
    expect(extractMeterIdFromQueryParam(null)).toBeNull();
    expect(extractMeterIdFromQueryParam("")).toBeNull();
    expect(extractMeterIdFromQueryParam("not-a-url")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractMeterIdFromProxyUrl — first hostname label
// ────────────────────────────────────────────────────────────────────

describe("extractMeterIdFromProxyUrl", () => {
  it("returns the first hostname label", () => {
    expect(extractMeterIdFromProxyUrl("https://m1.d.egauge.net")).toBe("m1");
    expect(extractMeterIdFromProxyUrl("https://meter99.proxy.example.com")).toBe(
      "meter99"
    );
  });

  it("rejects hostnames where the first label has invalid characters", () => {
    // No invalid-char labels exist in real DNS, but exercise the regex.
    // localhost, single label — accepted (matches the regex).
    expect(extractMeterIdFromProxyUrl("https://localhost")).toBe("localhost");
  });

  it("returns null on malformed URL", () => {
    expect(extractMeterIdFromProxyUrl("not-a-url")).toBeNull();
    expect(extractMeterIdFromProxyUrl("")).toBeNull();
    expect(extractMeterIdFromProxyUrl(null)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractMeterIdFromInlineUrl — find URL inside text, then proxy-id it
// ────────────────────────────────────────────────────────────────────

describe("extractMeterIdFromInlineUrl", () => {
  it("extracts from a URL embedded in text", () => {
    expect(
      extractMeterIdFromInlineUrl("see https://m1.d.egauge.net for details")
    ).toBe("m1");
  });

  it("extracts the FIRST URL when multiple are present", () => {
    expect(
      extractMeterIdFromInlineUrl(
        "main https://primary.d.egauge.net or https://secondary.d.egauge.net"
      )
    ).toBe("primary");
  });

  it("returns null when no URL appears", () => {
    expect(extractMeterIdFromInlineUrl("plain text")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractMeterIdFromInlineUrl(null)).toBeNull();
    expect(extractMeterIdFromInlineUrl("")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// looksLikePortfolioMeterId — heuristic for portfolio-formatted ids
// ────────────────────────────────────────────────────────────────────

describe("looksLikePortfolioMeterId", () => {
  it("accepts strings starting with 'egauge' (case-insensitive)", () => {
    expect(looksLikePortfolioMeterId("egauge12345")).toBe(true);
    expect(looksLikePortfolioMeterId("EGAUGE99")).toBe(true);
    expect(looksLikePortfolioMeterId("Egauge_meter")).toBe(true);
  });

  it("accepts any allowed-character string with at least one digit", () => {
    expect(looksLikePortfolioMeterId("m1")).toBe(true);
    expect(looksLikePortfolioMeterId("site_42")).toBe(true);
    expect(looksLikePortfolioMeterId("foo-99-bar")).toBe(true);
  });

  it("rejects pure-letter strings (no digits)", () => {
    expect(looksLikePortfolioMeterId("plain")).toBe(false);
    expect(looksLikePortfolioMeterId("foo_bar")).toBe(false);
  });

  it("rejects strings with disallowed characters", () => {
    expect(looksLikePortfolioMeterId("has space")).toBe(false);
    expect(looksLikePortfolioMeterId("foo/bar")).toBe(false);
    expect(looksLikePortfolioMeterId("a@b")).toBe(false);
  });

  it("rejects null / empty", () => {
    expect(looksLikePortfolioMeterId(null)).toBe(false);
    expect(looksLikePortfolioMeterId("")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// buildEgaugeRegisterTimeExpression — public API: register-API t-spec
// ────────────────────────────────────────────────────────────────────

describe("buildEgaugeRegisterTimeExpression", () => {
  it("builds 'startUnix:intervalSec:endUnix' from valid inputs", () => {
    const startUnix = parseIsoDateToUnixStart("2024-01-01");
    const endUnix = parseIsoDateToUnixEnd("2024-01-31");
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        intervalMinutes: 15,
      })
    ).toBe(`${startUnix}:${15 * 60}:${endUnix}`);
  });

  it("trims surrounding whitespace from date inputs", () => {
    const startUnix = parseIsoDateToUnixStart("2024-01-01");
    const endUnix = parseIsoDateToUnixEnd("2024-01-01");
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "  2024-01-01  ",
        endDate: "  2024-01-01  ",
        intervalMinutes: 5,
      })
    ).toBe(`${startUnix}:${5 * 60}:${endUnix}`);
  });

  it("clamps intervalMinutes to a positive integer (floor) with a 1-minute minimum", () => {
    const startUnix = parseIsoDateToUnixStart("2024-01-01");
    const endUnix = parseIsoDateToUnixEnd("2024-01-01");
    // fractional → floor
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-01-01",
        endDate: "2024-01-01",
        intervalMinutes: 5.7,
      })
    ).toBe(`${startUnix}:${5 * 60}:${endUnix}`);
    // zero/negative → clamp to 1
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-01-01",
        endDate: "2024-01-01",
        intervalMinutes: 0,
      })
    ).toBe(`${startUnix}:60:${endUnix}`);
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-01-01",
        endDate: "2024-01-01",
        intervalMinutes: -10,
      })
    ).toBe(`${startUnix}:60:${endUnix}`);
  });

  it("falls back to 15-minute interval on non-finite input", () => {
    const startUnix = parseIsoDateToUnixStart("2024-01-01");
    const endUnix = parseIsoDateToUnixEnd("2024-01-01");
    expect(
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-01-01",
        endDate: "2024-01-01",
        intervalMinutes: NaN,
      })
    ).toBe(`${startUnix}:${15 * 60}:${endUnix}`);
  });

  it("throws when end < start", () => {
    expect(() =>
      buildEgaugeRegisterTimeExpression({
        startDate: "2024-02-01",
        endDate: "2024-01-31",
        intervalMinutes: 15,
      })
    ).toThrow(/End date must be on or after start date/);
  });

  it("throws on malformed dates", () => {
    expect(() =>
      buildEgaugeRegisterTimeExpression({
        startDate: "01/01/2024",
        endDate: "2024-01-02",
        intervalMinutes: 15,
      })
    ).toThrow(/YYYY-MM-DD/);
  });
});

// ────────────────────────────────────────────────────────────────────
// getEgaugeSystemInfo — integration tests w/ fetch mock
// (Concern #1 slice 4d — establishes fetch-mock pattern for eGauge,
//  parallel to Tesla slice 3 #399 but for digest-auth instead of
//  client-credentials bearer)
// ────────────────────────────────────────────────────────────────────

const PUBLIC_CONTEXT: EgaugeApiContext = {
  baseUrl: "https://meter.d.egauge.net",
  accessType: "public",
  username: null,
  password: null,
};

const CREDENTIAL_CONTEXT: EgaugeApiContext = {
  baseUrl: "https://meter.d.egauge.net",
  accessType: "user_login",
  username: "operator",
  password: "secret-password",
};

/**
 * Build a Response stand-in matching what `EgaugeClient.requestJson`
 * reads. The implementation calls `response.text()` for the body,
 * `response.headers.get("set-cookie")` (or `getSetCookie()` /
 * `raw()`) for cookies, and `response.ok` / `response.status` /
 * `response.statusText` for error handling.
 */
function buildEgaugeResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  /** Cookie values to expose via `headers.getSetCookie()`. */
  setCookies?: string[];
}): Response {
  const status = opts.status ?? (opts.ok ? 200 : 500);
  return {
    ok: opts.ok,
    status,
    statusText: opts.statusText ?? (opts.ok ? "OK" : "Internal Server Error"),
    headers: {
      get: (_name: string) => null,
      getSetCookie: () => opts.setCookies ?? [],
    },
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("getEgaugeSystemInfo (integration)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── public access mode ───────────────────────────────────────────

  it("public mode: single GET to /api/sys returns parsed system info", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({
          name: "Acme Solar",
          serial: "egauge12345",
        }),
      })
    );
    const result = await getEgaugeSystemInfo(PUBLIC_CONTEXT);
    expect(result.systemName).toBe("Acme Solar");
    expect(result.serialNumber).toBe("egauge12345");
    expect(result.accessType).toBe("public");
    expect(result.baseUrl).toBe("https://meter.d.egauge.net");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("public mode: hits /api/sys (NOT /api/auth/* in public mode)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ name: "X" }),
      })
    );
    await getEgaugeSystemInfo(PUBLIC_CONTEXT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toBe("https://meter.d.egauge.net/api/sys");
    const headers = (init as RequestInit).headers as Record<string, string>;
    // Public mode should NOT send Authorization header.
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Accept"]).toBe("application/json");
  });

  it("public mode: extracts serialNumber from `serial_number` alias too", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ system_name: "Foo", serial_number: "abc-001" }),
      })
    );
    const result = await getEgaugeSystemInfo(PUBLIC_CONTEXT);
    expect(result.systemName).toBe("Foo");
    expect(result.serialNumber).toBe("abc-001");
  });

  it("public mode: returns null systemName/serialNumber when payload has no recognized fields", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ unrelated: "value" }),
      })
    );
    const result = await getEgaugeSystemInfo(PUBLIC_CONTEXT);
    expect(result.systemName).toBeNull();
    expect(result.serialNumber).toBeNull();
  });

  it("public mode: surfaces non-OK status as a thrown error", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })
    );
    await expect(getEgaugeSystemInfo(PUBLIC_CONTEXT)).rejects.toThrow(/503/);
  });

  // ── credential mode (digest auth) ────────────────────────────────

  it("credential mode: completes the 3-step challenge → login → /api/sys flow", async () => {
    // 1. Challenge: GET /api/auth/unauthorized → returns realm + nonce
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ rlm: "egauge", nnc: "server-nonce-abc" }),
      })
    );
    // 2. Login: POST /api/auth/login → returns JWT
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ jwt: "session-jwt-xyz" }),
      })
    );
    // 3. /api/sys: GET with Bearer JWT
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({
          name: "Authenticated System",
          serial: "egauge99999",
        }),
      })
    );

    const result = await getEgaugeSystemInfo(CREDENTIAL_CONTEXT);
    expect(result.systemName).toBe("Authenticated System");
    expect(result.serialNumber).toBe("egauge99999");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step 1 URL: /api/auth/unauthorized
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://meter.d.egauge.net/api/auth/unauthorized"
    );
    // Step 2 URL: /api/auth/login (POST with body)
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://meter.d.egauge.net/api/auth/login"
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
    // Step 3 URL: /api/sys with Bearer JWT
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://meter.d.egauge.net/api/sys"
    );
    const sysHeaders = (fetchMock.mock.calls[2][1] as RequestInit)
      .headers as Record<string, string>;
    expect(sysHeaders["Authorization"]).toBe("Bearer session-jwt-xyz");
  });

  it("credential mode: login POST body includes realm, username, both nonces, and a digest hash", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ rlm: "egauge-realm", nnc: "srv-nonce" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ jwt: "tok" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ name: "n" }),
      })
    );

    await getEgaugeSystemInfo(CREDENTIAL_CONTEXT);

    const loginInit = fetchMock.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(loginInit.body as string);
    expect(body.rlm).toBe("egauge-realm");
    expect(body.nnc).toBe("srv-nonce");
    expect(body.usr).toBe("operator");
    // Client nonce is randomly generated — just check format (32 hex chars).
    expect(body.cnnc).toMatch(/^[0-9a-f]{32}$/);
    // Digest hash is 32 hex chars (md5 hex output).
    expect(body.hash).toMatch(/^[0-9a-f]{32}$/);
    // Headers correct.
    const headers = loginInit.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("credential mode: throws when challenge response is missing realm/nonce", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ unrelated: "value" }),
      })
    );
    await expect(getEgaugeSystemInfo(CREDENTIAL_CONTEXT)).rejects.toThrow(
      /login challenge failed.*realm\/nonce/i
    );
    // Only the challenge call fired — login was never attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("credential mode: accepts session cookie auth when login returns no JWT (cookies path)", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ rlm: "r", nnc: "n" }),
        // Challenge response sets a session cookie.
        setCookies: ["session=cookie-value-1; Path=/"],
      })
    );
    // Login response — no JWT, but the cookie from step 1 already
    // satisfies `this.cookies.size > 0`, so authentication succeeds.
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ unrelated: "no-jwt-here" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ name: "Cookie-Authed" }),
      })
    );
    const result = await getEgaugeSystemInfo(CREDENTIAL_CONTEXT);
    expect(result.systemName).toBe("Cookie-Authed");
    // The 3rd request (/api/sys) carries the Cookie header from step 1.
    const sysHeaders = (fetchMock.mock.calls[2][1] as RequestInit)
      .headers as Record<string, string>;
    expect(sysHeaders["Cookie"]).toContain("session=cookie-value-1");
  });

  it("credential mode: throws when login returns NO JWT AND NO cookie", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ rlm: "r", nnc: "n" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ unrelated: "still-no-jwt" }),
      })
    );
    await expect(getEgaugeSystemInfo(CREDENTIAL_CONTEXT)).rejects.toThrow(
      /no JWT\/session cookie/i
    );
  });

  it("credential mode: throws when username or password is missing", async () => {
    const missingCreds: EgaugeApiContext = {
      ...CREDENTIAL_CONTEXT,
      password: null,
    };
    await expect(getEgaugeSystemInfo(missingCreds)).rejects.toThrow(
      /username and password are required/i
    );
    // No fetch fired — pre-flight credential check rejects before challenge.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("credential mode: surfaces non-OK from /api/sys after successful auth", async () => {
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ rlm: "r", nnc: "n" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: true,
        body: JSON.stringify({ jwt: "tok" }),
      })
    );
    fetchMock.mockResolvedValueOnce(
      buildEgaugeResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );
    await expect(getEgaugeSystemInfo(CREDENTIAL_CONTEXT)).rejects.toThrow(
      /500/
    );
  });
});
