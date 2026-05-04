/**
 * Unit tests for `startDashboardJobMetric`.
 *
 * The utility is intentionally tiny and synchronous-friendly so the
 * tests just drive it directly and inspect the captured console
 * lines. No mocks of `process.memoryUsage` — we assert the shape of
 * the line, not specific byte values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardJobMetric } from "./dashboardJobMetrics";

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
