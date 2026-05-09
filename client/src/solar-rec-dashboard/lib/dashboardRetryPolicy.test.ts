import { describe, expect, it } from "vitest";
import {
  DASHBOARD_TRANSIENT_RETRY_LIMIT,
  dashboardTransientRetryDelay,
  extractTransportHttpStatus,
  shouldRetryDashboardTransient,
} from "./dashboardRetryPolicy";

describe("extractTransportHttpStatus", () => {
  it("reads `httpStatus` from the top level (tRPC client default shape)", () => {
    expect(extractTransportHttpStatus({ httpStatus: 502 })).toBe(502);
  });

  it("reads `data.httpStatus` (tRPC server-error nested shape)", () => {
    expect(extractTransportHttpStatus({ data: { httpStatus: 429 } })).toBe(429);
  });

  it("reads `status` (raw fetch / Response shape)", () => {
    expect(extractTransportHttpStatus({ status: 504 })).toBe(504);
  });

  it("reads `cause.status` (chained-error shape)", () => {
    expect(extractTransportHttpStatus({ cause: { status: 503 } })).toBe(503);
  });

  it("returns null for unrecognized shapes", () => {
    expect(extractTransportHttpStatus(null)).toBeNull();
    expect(extractTransportHttpStatus(undefined)).toBeNull();
    expect(extractTransportHttpStatus("string error")).toBeNull();
    expect(extractTransportHttpStatus({})).toBeNull();
    expect(extractTransportHttpStatus({ unrelated: "field" })).toBeNull();
  });
});

describe("shouldRetryDashboardTransient", () => {
  it("retries on 429 (Too Many Requests — heap pressure)", () => {
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 429 })
    ).toBe(true);
  });

  it("retries on 502 (Render LB-translated 429)", () => {
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 502 })
    ).toBe(true);
  });

  it("retries on 503 / 504 (other transient overload states)", () => {
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 503 })
    ).toBe(true);
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 504 })
    ).toBe(true);
  });

  it("does NOT retry on 4xx other than 429 (deterministic client errors)", () => {
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 400 })
    ).toBe(false);
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 401 })
    ).toBe(false);
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 403 })
    ).toBe(false);
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 404 })
    ).toBe(false);
  });

  it("does NOT retry on 500 (deterministic server error — retrying hides the bug)", () => {
    // 500 typically means an unhandled exception in the resolver;
    // retrying just hides the actual problem and burns more
    // resources. Stay conservative.
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 500 })
    ).toBe(false);
  });

  it("does NOT retry when no HTTP status is recognizable on the error", () => {
    // Don't speculate. If the client can't tell the status, the
    // retry decision is false (defer to React Query's no-retry
    // default for unknown shapes).
    expect(shouldRetryDashboardTransient(0, new Error("network down"))).toBe(
      false
    );
  });

  it("stops retrying once the failure count exceeds the limit", () => {
    expect(
      shouldRetryDashboardTransient(
        DASHBOARD_TRANSIENT_RETRY_LIMIT,
        { httpStatus: 502 }
      )
    ).toBe(true); // boundary — still allowed
    expect(
      shouldRetryDashboardTransient(
        DASHBOARD_TRANSIENT_RETRY_LIMIT + 1,
        { httpStatus: 502 }
      )
    ).toBe(false);
  });

  it("respects a caller-supplied maxAttempts override", () => {
    expect(
      shouldRetryDashboardTransient(0, { httpStatus: 502 }, { maxAttempts: 0 })
    ).toBe(true); // boundary — first attempt ok
    expect(
      shouldRetryDashboardTransient(1, { httpStatus: 502 }, { maxAttempts: 0 })
    ).toBe(false);
  });
});

describe("dashboardTransientRetryDelay (full-jitter)", () => {
  // Post-merge review fixup: pre-jitter the delay was deterministic
  // (1.5s, 3s, 6s, 15s cap), which means 24 sequential pages all
  // hitting a 502 retried at the SAME instants — recreating the
  // cascade. Full jitter (uniform random over `[0, ceiling]`)
  // breaks the synchronization. Tests assert the JITTER CEILING
  // shape (worst-case bound by attempt) rather than the exact
  // value, since the result is non-deterministic.
  it("attempt 0 is bounded above by 1.5s ceiling", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = dashboardTransientRetryDelay(0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1500);
    }
  });

  it("attempt 1 is bounded above by 3s ceiling (doubles each attempt before cap)", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = dashboardTransientRetryDelay(1);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(3000);
    }
  });

  it("attempt 2 is bounded above by 6s ceiling", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = dashboardTransientRetryDelay(2);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(6000);
    }
  });

  it("late attempts cap at 15s ceiling (jitter is bounded by 15s)", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = dashboardTransientRetryDelay(50);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(15_000);
    }
  });

  it("yields different values across calls (jitter is real, not a constant)", () => {
    // 100 samples — collision probability for 100 floor-of-uniform
    // values over [0, 6000) is vanishingly small. If jitter were
    // broken (e.g. the function returned a constant) all 100 would
    // collide. The threshold of >50 unique values gives the test
    // robustness without flake.
    const samples = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      samples.add(dashboardTransientRetryDelay(2));
    }
    expect(samples.size).toBeGreaterThan(50);
  });
});

// 2026-05-09 follow-up to PR-6 (#535) — Retry-After honoring.
describe("dashboardTransientRetryDelay — Retry-After honoring (PR-FU-2)", () => {
  it("uses the server's retryAfterMs as a floor when it exceeds the jittered ceiling", () => {
    // Server says wait 5000ms. Attempt 0's jittered ceiling is
    // 1500ms, so the server's floor wins on every sample.
    for (let i = 0; i < 50; i += 1) {
      const delay = dashboardTransientRetryDelay(0, {
        data: { retryAfterMs: 5000 },
      });
      expect(delay).toBeGreaterThanOrEqual(5000);
    }
  });

  it("uses the jittered ceiling when it exceeds the server's retryAfterMs (max wins)", () => {
    // Server says wait 100ms. Attempt 50's jittered ceiling is
    // 15_000ms, so jitter wins on most samples. The 100ms floor
    // only matters when jitter produces a value < 100, which is
    // rare (100/15000 ≈ 0.7% of samples).
    const samples = Array.from({ length: 100 }, () =>
      dashboardTransientRetryDelay(10, {
        data: { retryAfterMs: 100 },
      })
    );
    const aboveServerFloor = samples.filter((s) => s > 100).length;
    expect(aboveServerFloor).toBeGreaterThan(90);
  });

  it("falls back to pure jitter when the error has no retryAfterMs", () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = dashboardTransientRetryDelay(
        0,
        new Error("network down")
      );
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1500);
    }
  });

  it("ignores malformed retryAfterMs values (NaN / negative / string / non-object)", () => {
    for (const bad of [NaN, -1, "5000", null, undefined, {}]) {
      const delay = dashboardTransientRetryDelay(0, {
        data: { retryAfterMs: bad },
      });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1500);
    }
  });

  it("works without a second `error` argument (backward compat with PR-6 callers)", () => {
    const delay = dashboardTransientRetryDelay(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1500);
  });
});
