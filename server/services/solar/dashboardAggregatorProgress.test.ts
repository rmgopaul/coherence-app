/**
 * Tests for the in-memory aggregator-progress channel.
 *
 * The Map is module-level state, so every test resets via
 * `__resetAggregatorProgressForTests()` in `beforeEach`. Linger
 * timeouts are unref'd so they can't keep the process alive in
 * test mode.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  startAggregatorProgress,
  getAggregatorProgress,
  __resetAggregatorProgressForTests,
  __aggregatorProgressInternalsForTests,
} from "./dashboardAggregatorProgress";

beforeEach(() => {
  __resetAggregatorProgressForTests();
});

describe("startAggregatorProgress + getAggregatorProgress", () => {
  it("registers a running entry on start with sensible defaults", () => {
    const reporter = startAggregatorProgress("scope-1", "contractVintage");
    const state = getAggregatorProgress("scope-1", "contractVintage");
    expect(state).toMatchObject({
      scopeId: "scope-1",
      aggregatorKey: "contractVintage",
      stage: "loading",
      fractionComplete: 0,
      state: "running",
      errorMessage: null,
    });
    expect(state?.startedAt).toBeLessThanOrEqual(Date.now());
    reporter.finish();
  });

  it("returns null when no recompute is in flight for the given key", () => {
    expect(getAggregatorProgress("scope-1", "unknownKey")).toBeNull();
  });

  it("`report()` updates the entry's stage / label / fraction / counts", () => {
    const reporter = startAggregatorProgress("scope-1", "contractVintage");
    reporter.report({
      stage: "loading",
      stageLabel: "Loading deliveryScheduleBase",
      fractionComplete: 0.25,
      current: 6_000,
      total: 24_000,
      unitLabel: "rows",
    });
    const state = getAggregatorProgress("scope-1", "contractVintage");
    expect(state).toMatchObject({
      stage: "loading",
      stageLabel: "Loading deliveryScheduleBase",
      fractionComplete: 0.25,
      current: 6_000,
      total: 24_000,
      unitLabel: "rows",
      state: "running",
    });
    reporter.finish();
  });

  it("clamps fractionComplete into [0, 1]", () => {
    const reporter = startAggregatorProgress("scope-1", "contractVintage");
    reporter.report({
      stage: "computing",
      stageLabel: "fast",
      fractionComplete: 1.5,
    });
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.fractionComplete
    ).toBe(1);
    reporter.report({
      stage: "computing",
      stageLabel: "rewind",
      fractionComplete: -0.25,
    });
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.fractionComplete
    ).toBe(0);
    reporter.report({
      stage: "computing",
      stageLabel: "NaN",
      fractionComplete: Number.NaN,
    });
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.fractionComplete
    ).toBe(0);
    reporter.finish();
  });

  it("`finish()` snaps to state=done, fraction=1 — entry visible briefly then pruned", () => {
    vi.useFakeTimers();
    try {
      const reporter = startAggregatorProgress("scope-1", "contractVintage");
      reporter.report({
        stage: "computing",
        stageLabel: "halfway",
        fractionComplete: 0.5,
      });
      reporter.finish();
      const settled = getAggregatorProgress("scope-1", "contractVintage");
      expect(settled?.state).toBe("done");
      expect(settled?.fractionComplete).toBe(1);
      vi.advanceTimersByTime(
        __aggregatorProgressInternalsForTests.SUCCESS_LINGER_MS + 100
      );
      expect(getAggregatorProgress("scope-1", "contractVintage")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("`fail()` marks state=failed + error message, lingers, then prunes", () => {
    vi.useFakeTimers();
    try {
      const reporter = startAggregatorProgress("scope-1", "contractVintage");
      reporter.fail(new Error("ContractVintage exploded"));
      const settled = getAggregatorProgress("scope-1", "contractVintage");
      expect(settled?.state).toBe("failed");
      expect(settled?.errorMessage).toBe("ContractVintage exploded");
      vi.advanceTimersByTime(
        __aggregatorProgressInternalsForTests.FAILURE_LINGER_MS + 100
      );
      expect(getAggregatorProgress("scope-1", "contractVintage")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("`fail()` accepts non-Error values defensively", () => {
    const reporter = startAggregatorProgress("scope-1", "contractVintage");
    reporter.fail("string error");
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.errorMessage
    ).toBe("string error");
  });

  it("`finish()` and `fail()` are idempotent — second call is a no-op", () => {
    const reporter = startAggregatorProgress("scope-1", "contractVintage");
    reporter.finish();
    const after = getAggregatorProgress("scope-1", "contractVintage");
    reporter.fail(new Error("late fail"));
    // Second call should not overwrite the "done" terminal state
    expect(getAggregatorProgress("scope-1", "contractVintage")?.state).toBe(
      after?.state
    );
  });

  it("a running entry that hasn't reported in STALE_PROGRESS_MS is swept on read", () => {
    vi.useFakeTimers();
    try {
      const reporter = startAggregatorProgress("scope-1", "contractVintage");
      reporter.report({
        stage: "loading",
        stageLabel: "stuck",
        fractionComplete: 0.5,
      });
      // No further report; advance past the stale threshold
      vi.advanceTimersByTime(
        __aggregatorProgressInternalsForTests.STALE_PROGRESS_MS + 1
      );
      expect(getAggregatorProgress("scope-1", "contractVintage")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates progress per (scope, aggregatorKey) pair", () => {
    const a = startAggregatorProgress("scope-1", "contractVintage");
    const b = startAggregatorProgress("scope-1", "forecast");
    const c = startAggregatorProgress("scope-2", "contractVintage");

    a.report({ stage: "loading", stageLabel: "a", fractionComplete: 0.1 });
    b.report({ stage: "computing", stageLabel: "b", fractionComplete: 0.5 });
    c.report({ stage: "writing", stageLabel: "c", fractionComplete: 0.9 });

    expect(getAggregatorProgress("scope-1", "contractVintage")?.stageLabel).toBe(
      "a"
    );
    expect(getAggregatorProgress("scope-1", "forecast")?.stageLabel).toBe("b");
    expect(getAggregatorProgress("scope-2", "contractVintage")?.stageLabel).toBe(
      "c"
    );

    a.finish();
    b.finish();
    c.finish();
  });

  // 2026-05-12 follow-up — code-review fixup #4: concurrent-start race.
  it("join semantics: second start while first is running returns a no-op reporter", () => {
    const a = startAggregatorProgress("scope-1", "contractVintage");
    a.report({
      stage: "loading",
      stageLabel: "first owner",
      fractionComplete: 0.3,
    });

    // Second concurrent caller — the racy case `withArtifactCache`'s
    // single-flight is supposed to prevent. The second start
    // returns a no-op reporter; the first caller's entry stays
    // authoritative.
    const b = startAggregatorProgress("scope-1", "contractVintage");
    b.report({
      stage: "writing",
      stageLabel: "JOINED CALLER — should be ignored",
      fractionComplete: 0.99,
    });

    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.stageLabel
    ).toBe("first owner");

    b.finish();
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.state
    ).toBe("running");

    b.fail(new Error("ignored"));
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.state
    ).toBe("running");
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.errorMessage
    ).toBeNull();

    // First owner can still finish normally.
    a.finish();
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.state
    ).toBe("done");
  });

  it("a NEW start AFTER a previous start finish()'d creates a fresh entry", () => {
    // The join check is gated on `state === "running"`. Once the
    // previous entry transitions to `done`, a fresh start in the
    // linger window should replace it cleanly (not no-op).
    const first = startAggregatorProgress("scope-1", "contractVintage");
    first.finish();
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.state
    ).toBe("done");

    const second = startAggregatorProgress("scope-1", "contractVintage");
    second.report({
      stage: "loading",
      stageLabel: "fresh recompute",
      fractionComplete: 0.1,
    });
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.stageLabel
    ).toBe("fresh recompute");
    expect(
      getAggregatorProgress("scope-1", "contractVintage")?.state
    ).toBe("running");
    second.finish();
  });
});
