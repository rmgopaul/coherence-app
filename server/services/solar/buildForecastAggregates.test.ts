import { describe, expect, it } from "vitest";
import {
  __forecastAggregatesTest,
  FORECAST_RUNNER_VERSION,
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
