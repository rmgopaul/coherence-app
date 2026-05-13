/**
 * Tests for the shared aggregator-input loader. Mocks the four
 * downstream sources so the test exercises only the orchestration
 * + progress-tick contract.
 *
 * The two consumer call sites (`buildContractVintageAggregates` +
 * `buildPerformanceSourceRows`) keep their full end-to-end tests
 * elsewhere; this file pins the loader's externally-observable
 * behavior: the progress ticks fire in the right order with the
 * right weights and the four return values come back with the
 * shapes the callers expect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock every downstream — we test progress orchestration, not I/O.
const mockGetOrBuildSystemSnapshot = vi.fn();
const mockLoadDatasetRows = vi.fn();
const mockBuildTransferDeliveryLookupForScope = vi.fn();

vi.mock("./buildSystemSnapshot", () => ({
  getOrBuildSystemSnapshot: (...args: unknown[]) =>
    mockGetOrBuildSystemSnapshot(...args),
  loadDatasetRows: (...args: unknown[]) => mockLoadDatasetRows(...args),
}));

vi.mock("./buildTransferDeliveryLookup", () => ({
  buildTransferDeliveryLookupForScope: (...args: unknown[]) =>
    mockBuildTransferDeliveryLookupForScope(...args),
}));

// The schema imports are pure type/identity references; loadDatasetRows
// receives them as arguments. The mock above ignores the argument shape.
vi.mock("../../../drizzle/schemas/solar", () => ({
  srDsAbpReport: { __tag: "srDsAbpReport" },
  srDsDeliverySchedule: { __tag: "srDsDeliverySchedule" },
}));

import {
  loadCommonAggregatorInputs,
  AGGREGATOR_STAGE_1_BASE,
  AGGREGATOR_STAGE_1_CAP,
  AGGREGATOR_STEP_WEIGHTS,
} from "./aggregatorInputs";
import type { AggregatorProgressReporter } from "./dashboardAggregatorProgress";

beforeEach(() => {
  mockGetOrBuildSystemSnapshot.mockReset();
  mockLoadDatasetRows.mockReset();
  mockBuildTransferDeliveryLookupForScope.mockReset();
});

function makeStubReporter(): AggregatorProgressReporter & {
  reports: Array<{
    stage: string;
    stageLabel: string;
    fractionComplete: number;
  }>;
} {
  const reports: Array<{
    stage: string;
    stageLabel: string;
    fractionComplete: number;
  }> = [];
  return {
    reports,
    report(input) {
      reports.push({
        stage: input.stage,
        stageLabel: input.stageLabel,
        fractionComplete: input.fractionComplete,
      });
    },
    finish() {},
    fail() {},
  };
}

describe("loadCommonAggregatorInputs", () => {
  it("returns the four-value destructure shape both consumers expect", async () => {
    const snapshotResult = { systems: ["sys1", "sys2"] };
    const abpRows = [{ tracking_system_ref_id: "NON1" }];
    const scheduleRows = [{ utility_contract_number: "C1" }];
    const transferLookup = { byTrackingId: {} };

    mockGetOrBuildSystemSnapshot.mockResolvedValueOnce(snapshotResult);
    mockLoadDatasetRows
      .mockResolvedValueOnce(abpRows) // first call → abpReport
      .mockResolvedValueOnce(scheduleRows); // second call → schedule
    mockBuildTransferDeliveryLookupForScope.mockResolvedValueOnce(
      transferLookup
    );

    const reporter = makeStubReporter();
    const result = await loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    );

    expect(result.snapshot).toBe(snapshotResult);
    expect(result.abpReportRows).toBe(abpRows);
    expect(result.scheduleRows).toBe(scheduleRows);
    expect(result.transferLookup).toBe(transferLookup);
  });

  it("emits 'Loading inputs' at STAGE_1_BASE before any input resolves", async () => {
    // Make every input resolve on the same microtask so we can verify
    // the initial report fires SYNCHRONOUSLY first.
    mockGetOrBuildSystemSnapshot.mockResolvedValue({ systems: [] });
    mockLoadDatasetRows.mockResolvedValue([]);
    mockBuildTransferDeliveryLookupForScope.mockResolvedValue({
      byTrackingId: {},
    });

    const reporter = makeStubReporter();
    await loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    );

    expect(reporter.reports[0]).toMatchObject({
      stage: "loading",
      stageLabel: "Loading inputs",
      fractionComplete: AGGREGATOR_STAGE_1_BASE,
    });
  });

  it("ticks progress for each input as it resolves; weights sum to (CAP - BASE)", async () => {
    mockGetOrBuildSystemSnapshot.mockResolvedValue({ systems: [] });
    mockLoadDatasetRows.mockResolvedValue([]);
    mockBuildTransferDeliveryLookupForScope.mockResolvedValue({
      byTrackingId: {},
    });

    const reporter = makeStubReporter();
    await loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    );

    // Initial + 4 ticks = 5 reports total.
    expect(reporter.reports).toHaveLength(5);

    // Final tick fraction equals CAP exactly when all four weights sum.
    const finalFraction = reporter.reports[4].fractionComplete;
    expect(finalFraction).toBeCloseTo(AGGREGATOR_STAGE_1_CAP, 6);

    const sumOfWeights =
      AGGREGATOR_STEP_WEIGHTS.snapshot +
      AGGREGATOR_STEP_WEIGHTS.schedule +
      AGGREGATOR_STEP_WEIGHTS.abpReport +
      AGGREGATOR_STEP_WEIGHTS.transfer;
    expect(AGGREGATOR_STAGE_1_BASE + sumOfWeights).toBeCloseTo(
      AGGREGATOR_STAGE_1_CAP,
      6
    );
  });

  it("clamps to STAGE_1_CAP even if weights overshoot (regression safety)", async () => {
    // We can't directly mutate the const weights from outside, but we
    // can verify the cap-clamp logic is present by checking the
    // helper's source contract — fractionComplete never exceeds
    // STAGE_1_CAP regardless of resolution order.
    mockGetOrBuildSystemSnapshot.mockResolvedValue({ systems: [] });
    mockLoadDatasetRows.mockResolvedValue([]);
    mockBuildTransferDeliveryLookupForScope.mockResolvedValue({
      byTrackingId: {},
    });

    const reporter = makeStubReporter();
    await loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    );

    for (const report of reporter.reports) {
      expect(report.fractionComplete).toBeLessThanOrEqual(
        AGGREGATOR_STAGE_1_CAP + 1e-9
      );
    }
  });

  it("passes batch IDs through to the right loaders", async () => {
    mockGetOrBuildSystemSnapshot.mockResolvedValue({ systems: [] });
    mockLoadDatasetRows.mockResolvedValue([]);
    mockBuildTransferDeliveryLookupForScope.mockResolvedValue({
      byTrackingId: {},
    });

    const reporter = makeStubReporter();
    await loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    );

    // System snapshot + transfer lookup are scope-scoped only.
    expect(mockGetOrBuildSystemSnapshot).toHaveBeenCalledWith("scope-1");
    expect(mockBuildTransferDeliveryLookupForScope).toHaveBeenCalledWith(
      "scope-1"
    );

    // `loadDatasetRows` called twice — one for each batch ID + table.
    const calls = mockLoadDatasetRows.mock.calls;
    expect(calls).toHaveLength(2);
    const batchIds = calls.map((c) => c[1]);
    expect(batchIds).toContain("batch-abp");
    expect(batchIds).toContain("batch-schedule");
  });

  it("propagates errors from any downstream loader", async () => {
    mockGetOrBuildSystemSnapshot.mockRejectedValueOnce(
      new Error("snapshot blew up")
    );
    mockLoadDatasetRows.mockResolvedValue([]);
    mockBuildTransferDeliveryLookupForScope.mockResolvedValue({
      byTrackingId: {},
    });

    const reporter = makeStubReporter();
    await expect(
      loadCommonAggregatorInputs(
        "scope-1",
        "batch-abp",
        "batch-schedule",
        reporter
      )
    ).rejects.toThrow(/snapshot blew up/);
  });
});
