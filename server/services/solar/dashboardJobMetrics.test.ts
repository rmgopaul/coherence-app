/**
 * Unit tests for `startDashboardJobMetric`.
 *
 * The utility is intentionally tiny and synchronous-friendly so the
 * tests just drive it directly and inspect the captured console
 * lines. No mocks of `process.memoryUsage` — we assert the shape of
 * the line, not specific byte values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESERVED_METRIC_KEYS,
  startDashboardJobMetric,
} from "./dashboardJobMetrics";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

/**
 * Pull the JSON object embedded in a `prefix metric { ... }` log
 * line so tests assert on structured fields without re-parsing
 * formatting concerns.
 */
function parseMetricLine(line: string): Record<string, unknown> {
  const idx = line.indexOf("{");
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(line.slice(idx)) as Record<string, unknown>;
}

describe("startDashboardJobMetric", () => {
  it("emits a single info line with the expected fields on finish()", () => {
    const metric = startDashboardJobMetric({
      prefix: "[dashboard:csv-export-jobs]",
      jobId: "job-1",
      context: { exportType: "ownershipTile" },
    });
    metric.finish({ rowCount: 42, csvBytes: 1024, storageWrite: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toMatch(/^\[dashboard:csv-export-jobs\] metric /);

    const payload = parseMetricLine(line);
    expect(payload).toMatchObject({
      jobId: "job-1",
      exportType: "ownershipTile",
      outcome: "success",
      rowCount: 42,
      csvBytes: 1024,
      storageWrite: true,
    });
    expect(typeof payload.elapsedMs).toBe("number");
    expect(typeof payload.heapBeforeBytes).toBe("number");
    expect(typeof payload.heapAfterBytes).toBe("number");
    expect(payload.heapDeltaBytes).toBe(
      (payload.heapAfterBytes as number) - (payload.heapBeforeBytes as number)
    );
    expect(payload.error).toBeUndefined();
  });

  it("emits a single error line with the error message on fail()", () => {
    const metric = startDashboardJobMetric({
      prefix: "[dashboard:csv-export-jobs]",
      jobId: "job-2",
      context: { exportType: "changeOwnershipTile" },
    });
    metric.fail(new Error("storage exploded"));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toMatch(/^\[dashboard:csv-export-jobs\] metric /);

    const payload = parseMetricLine(line);
    expect(payload).toMatchObject({
      jobId: "job-2",
      exportType: "changeOwnershipTile",
      outcome: "failed",
      error: "storage exploded",
    });
  });

  it("stringifies non-Error fail() reasons", () => {
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "job-3",
    });
    metric.fail("plain string");
    const payload = parseMetricLine(String(errorSpy.mock.calls[0][0]));
    expect(payload.error).toBe("plain string");
  });

  it("ignores duplicate finish/fail calls — a metric settles once", () => {
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "job-4",
    });
    metric.finish({ rowCount: 1 });
    metric.finish({ rowCount: 999 });
    metric.fail(new Error("late failure"));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const payload = parseMetricLine(String(logSpy.mock.calls[0][0]));
    expect(payload.rowCount).toBe(1);
  });

  it("never throws even with no context provided", () => {
    expect(() => {
      const metric = startDashboardJobMetric({
        prefix: "[test]",
        jobId: "job-5",
      });
      metric.finish();
    }).not.toThrow();
    const payload = parseMetricLine(String(logSpy.mock.calls[0][0]));
    expect(payload).toMatchObject({ jobId: "job-5", outcome: "success" });
  });

  it("records elapsedMs that monotonically increases with real wall time", async () => {
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "job-6",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    metric.finish();
    const payload = parseMetricLine(String(logSpy.mock.calls[0][0]));
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(5);
  });
});

describe("startDashboardJobMetric — reserved-field protection", () => {
  it("exports the reserved-key set so callers and tests share one source of truth", () => {
    // Lock the contract: future Phase 2/4 builders that read this
    // set know which names they cannot pass through `context` /
    // `extra` and expect to survive.
    expect([...RESERVED_METRIC_KEYS].sort()).toEqual(
      [
        "jobId",
        "outcome",
        "elapsedMs",
        "heapBeforeBytes",
        "heapAfterBytes",
        "heapDeltaBytes",
        "error",
      ].sort()
    );
  });

  it("does not allow caller `context` to overwrite ANY reserved envelope field", () => {
    const collidingContext: Record<string, unknown> = {
      jobId: "context-attacker",
      outcome: "context-success",
      elapsedMs: 999_999,
      heapBeforeBytes: -1,
      heapAfterBytes: -2,
      heapDeltaBytes: -3,
      error: "context-error",
      // A non-reserved field passes through untouched.
      legitimateContextField: "preserved",
    };
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "real-job-id",
      context: collidingContext,
    });
    metric.finish();
    const payload = parseMetricLine(String(logSpy.mock.calls[0][0]));
    expect(payload.jobId).toBe("real-job-id");
    expect(payload.outcome).toBe("success");
    expect(payload.elapsedMs).not.toBe(999_999);
    expect(payload.heapBeforeBytes).not.toBe(-1);
    expect(payload.heapAfterBytes).not.toBe(-2);
    // heapDeltaBytes is computed from the real heap samples; just
    // confirm the colliding -3 didn't survive.
    expect(payload.heapDeltaBytes).not.toBe(-3);
    // Non-reserved context survives.
    expect(payload.legitimateContextField).toBe("preserved");
  });

  it("does not allow caller `extra` to overwrite ANY reserved envelope field", () => {
    // Use sentinel values that real envelope fields can never
    // produce (negative bytes, "extra-attacker" string outcomes,
    // very-large-negative elapsed). If any sentinel survives in the
    // payload, the spread order is wrong and the contract is broken.
    const collidingExtra: Record<string, unknown> = {
      jobId: "extra-attacker",
      outcome: "extra-success",
      elapsedMs: -999_999,
      heapBeforeBytes: -1,
      heapAfterBytes: -2,
      heapDeltaBytes: -3,
      // A legitimate extra survives.
      rowCount: 42,
      csvBytes: 1024,
    };
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "real-job-id",
    });
    metric.finish(collidingExtra);
    const payload = parseMetricLine(String(logSpy.mock.calls[0][0]));
    expect(payload.jobId).toBe("real-job-id");
    expect(payload.outcome).toBe("success");
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(payload.heapBeforeBytes).not.toBe(-1);
    expect(payload.heapAfterBytes).not.toBe(-2);
    expect(payload.heapDeltaBytes).not.toBe(-3);
    expect(payload.rowCount).toBe(42);
    expect(payload.csvBytes).toBe(1024);
  });

  it("does not allow caller `extra` to overwrite a fail() error string", () => {
    const metric = startDashboardJobMetric({
      prefix: "[test]",
      jobId: "real-job-id",
    });
    metric.fail(new Error("real error"), { error: "extra-attacker" });
    const payload = parseMetricLine(String(errorSpy.mock.calls[0][0]));
    expect(payload.error).toBe("real error");
  });
});
