import { describe, expect, it } from "vitest";
import {
  decideAutoApply,
  type AutoApplyDecisionInput,
} from "./scheduleBAutoApplyThrottle";

const BASE: AutoApplyDecisionInput = {
  successfulResultCount: 0,
  lastAppliedCount: 0,
  lastAppliedAtMs: 0,
  nowMs: 1_700_000_000_000,
  jobIsComplete: false,
  minIntervalMs: 30_000,
  applyInFlight: false,
};

describe("decideAutoApply", () => {
  it("skips when there are zero successful results", () => {
    const result = decideAutoApply({ ...BASE, successfulResultCount: 0 });
    expect(result).toEqual({ kind: "skip", reason: "no-results" });
  });

  it("skips when the new count is not greater than the last applied count", () => {
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 50,
      lastAppliedCount: 50,
    });
    expect(result).toEqual({ kind: "skip", reason: "no-new-results" });
  });

  it("skips when an apply is already in flight (Bug #3 race guard)", () => {
    // The motivating bug: an effect re-fire while a prior timer
    // body is mid-await must NOT schedule a second mutation. The
    // helper returns "skip: in-flight" so the effect short-circuits
    // before scheduling another timer.
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 50,
      applyInFlight: true,
    });
    expect(result).toEqual({ kind: "skip", reason: "in-flight" });
  });

  it("schedules with delayMs=0 when the import job is complete", () => {
    // Tab activation after a finished scan: fire immediately, once.
    // The `applyInFlight` ref + optimistic `lastAppliedCount` write
    // (in the component) prevent multiple fires in this case.
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 0,
      jobIsComplete: true,
      lastAppliedAtMs: BASE.nowMs - 5000,
    });
    expect(result).toEqual({ kind: "schedule", delayMs: 0 });
  });

  it("schedules with full delay when no apply has happened yet (job running)", () => {
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 0,
      lastAppliedAtMs: 0,
      jobIsComplete: false,
      minIntervalMs: 30_000,
    });
    // First-ever apply during a running job — last apply at 0 means
    // elapsed = nowMs, which is much larger than the throttle
    // window, so delay drops to 0. (The original behavior; the
    // first-load case is intentionally not throttled.)
    expect(result).toEqual({ kind: "schedule", delayMs: 0 });
  });

  it("schedules with the remaining throttle window after a recent apply", () => {
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 50,
      lastAppliedAtMs: BASE.nowMs - 10_000, // 10s ago
      jobIsComplete: false,
      minIntervalMs: 30_000,
    });
    // 30s window − 10s elapsed = 20s remaining
    expect(result).toEqual({ kind: "schedule", delayMs: 20_000 });
  });

  it("schedules with delayMs=0 when the throttle window has fully elapsed", () => {
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 50,
      lastAppliedAtMs: BASE.nowMs - 60_000, // 60s ago
      jobIsComplete: false,
      minIntervalMs: 30_000,
    });
    expect(result).toEqual({ kind: "schedule", delayMs: 0 });
  });

  it("never returns negative delays even when clocks skew or `now` is stale", () => {
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 50,
      lastAppliedAtMs: BASE.nowMs + 5_000, // future timestamp
      jobIsComplete: false,
      minIntervalMs: 30_000,
    });
    expect(result.kind).toBe("schedule");
    expect((result as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(0);
  });

  it("`applyInFlight` short-circuits BEFORE the jobIsComplete fast path", () => {
    // Defensive ordering: the in-flight guard wins even when the
    // job is complete (which would otherwise schedule a 0ms timer
    // on every effect fire).
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 100,
      lastAppliedCount: 0,
      jobIsComplete: true,
      applyInFlight: true,
    });
    expect(result).toEqual({ kind: "skip", reason: "in-flight" });
  });

  it("`successfulResultCount === 0` short-circuits BEFORE applyInFlight", () => {
    // The "no results" check is cheapest and wins. (Order
    // assertion — keeps the helper's branches testable in
    // isolation.)
    const result = decideAutoApply({
      ...BASE,
      successfulResultCount: 0,
      applyInFlight: true,
    });
    expect(result).toEqual({ kind: "skip", reason: "no-results" });
  });
});
