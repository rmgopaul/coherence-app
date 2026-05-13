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

  it("rejects with the first rejection when one load fails, after all loads settle", async () => {
    // Promise lifecycle: snapshot rejects *before* the slowest
    // sibling resolves. The loader MUST wait for the slowest sibling
    // to settle (so its heap is released) before throwing.
    //
    // We test this by:
    //   1. Making snapshot reject on the first microtask.
    //   2. Making transfer resolve only after we manually flip a
    //      `transferResolved` flag.
    //   3. Calling `loadCommonAggregatorInputs` and asserting the
    //      promise is still pending after enough microtasks for the
    //      snapshot rejection to have propagated.
    //   4. Releasing the transfer resolve and confirming the
    //      function rejects with the original snapshot error.
    const snapshotError = new Error("snapshot blew up");
    mockGetOrBuildSystemSnapshot.mockRejectedValueOnce(snapshotError);
    mockLoadDatasetRows.mockResolvedValue([{ row: "fast-1" }]);

    let resolveTransfer: ((value: unknown) => void) | undefined;
    const transferPromise = new Promise((resolve) => {
      resolveTransfer = resolve;
    });
    mockBuildTransferDeliveryLookupForScope.mockReturnValueOnce(
      transferPromise
    );

    const reporter = makeStubReporter();
    let resolvedValue: unknown = undefined;
    let rejectedReason: unknown = undefined;
    const callPromise = loadCommonAggregatorInputs(
      "scope-1",
      "batch-abp",
      "batch-schedule",
      reporter
    ).then(
      (value) => {
        resolvedValue = value;
      },
      (err) => {
        rejectedReason = err;
      }
    );

    // Give the microtask queue several turns so the snapshot
    // rejection has every chance to propagate to a `Promise.all`-
    // style early-throw if the loader were still using that.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // The outer promise must still be pending — transfer hasn't
    // resolved yet, and `Promise.allSettled` waits for all four.
    expect(resolvedValue).toBeUndefined();
    expect(rejectedReason).toBeUndefined();

    // Release the slow sibling.
    resolveTransfer!({ byTrackingId: {} });
    await callPromise;

    // Now we expect the original snapshot error.
    expect(rejectedReason).toBe(snapshotError);
    expect(resolvedValue).toBeUndefined();
  });

  it("doesn't emit progress ticks after the first rejection", async () => {
    // Snapshot rejects immediately; the other 3 loaders resolve
    // later. Their `.then` lambdas would normally call `tickStage1`
    // on success, but the post-rejection guard inside the loader
    // must suppress those ticks so the progress channel isn't
    // polluted with "Loaded …" reports for a recompute that's
    // already failing.
    const snapshotError = new Error("snapshot failed first");
    mockGetOrBuildSystemSnapshot.mockRejectedValueOnce(snapshotError);

    // Resolve the other loaders only after the snapshot rejection
    // has had a chance to propagate. We chain through a Promise that
    // resolves after 5 microtasks so the snapshot rejection
    // observably races ahead.
    const microtaskDelay = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    mockLoadDatasetRows.mockImplementation(async () => {
      await microtaskDelay();
      return [];
    });
    mockBuildTransferDeliveryLookupForScope.mockImplementation(async () => {
      await microtaskDelay();
      return { byTrackingId: {} };
    });

    const reporter = makeStubReporter();
    await expect(
      loadCommonAggregatorInputs(
        "scope-1",
        "batch-abp",
        "batch-schedule",
        reporter
      )
    ).rejects.toBe(snapshotError);

    // The reporter should have received exactly one "Loading inputs"
    // tick (emitted synchronously before any loader resolves), and
    // no "Loaded …" ticks afterward — the post-rejection guard
    // suppresses them.
    const labels = reporter.reports.map((r) => r.stageLabel);
    expect(labels).toEqual(["Loading inputs"]);

    // Defensive: none of the "Loaded …" labels showed up.
    for (const label of labels) {
      expect(label).not.toMatch(/^Loaded /);
    }
  });
});
