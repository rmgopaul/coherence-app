/**
 * Tests for the shared "should-cache an empty aggregate" predicate.
 *
 * Pinning the FOUR sequential bug-fixes that converged on this
 * shape (PRs #556 / #557 / #567 / today's forecast fix). The
 * existing per-aggregator test suites
 * (`buildForecastAggregates.test.ts` /
 * `buildPerformanceSourceRows.test.ts`) still exercise the same
 * call sites via the re-exported name — those serve as the
 * "call-site rail"; these tests pin the shared kernel.
 */

import { describe, it, expect } from "vitest";
import { shouldCacheAggregatorEmptyResult } from "./aggregatorCachePredicates";

describe("shouldCacheAggregatorEmptyResult", () => {
  it("caches the trivially-empty case (no schedule rows → output is structurally empty)", () => {
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("caches the trivially-empty case regardless of eligibility shape", () => {
    // No schedule rows means the output is empty no matter what
    // the eligibility filter would have produced. Caching is safe.
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 42_000,
      })
    ).toBe(true);
  });

  it("REFUSES when schedule rows exist but eligibility is empty (the prod 2026-05 poison vector)", () => {
    // The case that poisoned the perf-source-rows cache on prod
    // 2026-05-13 (and the forecast cache on prod 2026-05-11): a
    // transient `eligibleTrackingIdCount=0` on a non-empty
    // schedule cached the empty result, and every subsequent
    // call served the poisoned payload until either a batch
    // upload bumped the input hash or an operator bumped the
    // runner version.
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(false);
  });

  it("REFUSES the suspicious-empty case (schedule + eligible IDs both present but no rows out)", () => {
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(false);
  });

  it("caches non-empty results regardless of input shape", () => {
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 1,
        scheduleRowsTotal: 1,
        eligibleTrackingIdCount: 1,
      })
    ).toBe(true);
    expect(
      shouldCacheAggregatorEmptyResult({
        rowsEmitted: 50_000,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(true);
  });
});
