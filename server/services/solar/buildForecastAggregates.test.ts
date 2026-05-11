import { describe, expect, it } from "vitest";
import {
  __forecastAggregatesTest,
  FORECAST_RUNNER_VERSION,
  shouldCacheForecastResult,
} from "./buildForecastAggregates";

const baseBatchIds = {
  deliveryScheduleBaseBatchId: "schedule-batch",
  transferHistoryBatchId: "transfer-batch-a",
  annualProductionBatchId: "annual-batch",
  generationEntryBatchId: "generation-batch",
  accountSolarGenerationBatchId: "account-generation-batch",
  abpReportBatchId: "abp-batch",
};

describe("Forecast aggregate cache key", () => {
  it("changes when only transferHistory changes", () => {
    const before = __forecastAggregatesTest.computeForecastInputHash(
      baseBatchIds,
      "2025-2026"
    );
    const after = __forecastAggregatesTest.computeForecastInputHash(
      {
        ...baseBatchIds,
        transferHistoryBatchId: "transfer-batch-b",
      },
      "2025-2026"
    );

    expect(before).not.toBe(after);
  });

  it("uses the runner version that includes transferHistory freshness", () => {
    expect(FORECAST_RUNNER_VERSION).toBe("phase-5d-pr2-forecast@4");
  });
});

/**
 * 2026-05-11 — predicate that decides whether a freshly-computed
 * Forecast result should be persisted. Same heuristic as the
 * sibling `shouldCachePerformanceSourceRowsResult`: refuse to cache
 * a zero-row result when the inputs that drive it were non-empty.
 * Documents the bug fix that made 24-34s "fromCache: true, rows: []"
 * responses impossible to clear without a batch upload.
 */
describe("shouldCacheForecastResult", () => {
  it("caches genuinely-empty results when the schedule input was empty", () => {
    expect(
      shouldCacheForecastResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("caches genuinely-empty results when no tracking ids are eligible", () => {
    expect(
      shouldCacheForecastResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("REFUSES to cache 0-row results when inputs were populated (the bug-fix case)", () => {
    // The exact scenario observed on prod 2026-05-11: 24k delivery
    // rows, 22k eligible tracking ids, recompute produced 0 rows
    // and got cached. Now it doesn't.
    expect(
      shouldCacheForecastResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(false);
  });

  it("caches non-empty results regardless of input shape", () => {
    expect(
      shouldCacheForecastResult({
        rowsEmitted: 50,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(true);
  });
});
