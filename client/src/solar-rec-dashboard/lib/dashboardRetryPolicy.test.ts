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

describe("dashboardTransientRetryDelay", () => {
  it("starts at 1.5s and doubles each attempt", () => {
    expect(dashboardTransientRetryDelay(0)).toBe(1500);
    expect(dashboardTransientRetryDelay(1)).toBe(3000);
    expect(dashboardTransientRetryDelay(2)).toBe(6000);
  });

  it("caps at 15s to prevent runaway delays", () => {
    expect(dashboardTransientRetryDelay(10)).toBe(15_000);
    expect(dashboardTransientRetryDelay(50)).toBe(15_000);
  });
});
