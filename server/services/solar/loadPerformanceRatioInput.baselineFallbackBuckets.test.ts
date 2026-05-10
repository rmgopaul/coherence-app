/**
 * Bucket-classifier test for the Performance Ratio baseline-fallback
 * diagnostic (2026-05-09).
 *
 * Background: the matcher in `buildPerformanceRatioAggregates`
 * looks up `generationBaselineByTrackingId.get(systemRef)` for
 * every matched (convertedRead, candidate) tuple; on miss, it
 * falls back to the `Date Online @ day 15, baseline 0` shape from
 * `generatorDetails`. On prod ~6000 systems take that fallback,
 * and `classifyPerformanceRatioBaselineFallback` attributes the
 * count to one of four root causes (A/B/C + sub-bucket on whether
 * the fallback even has a Date Online to use).
 *
 * This test pins the bucket-resolution semantics. The classifier
 * is pure — no DB, no streaming pass, no schema deps — so every
 * case constructs the inputs directly.
 */
import { describe, expect, it } from "vitest";
import {
  classifyPerformanceRatioBaselineFallback,
  createAccountSolarGenerationStats,
  type AccountSolarGenerationStats,
} from "./loadPerformanceRatioInput";

function makeStats(opts: {
  rowsTotal?: number;
  rowsBlankGatsGenId?: number;
  rowsBlankValue?: number;
  seenExact: string[];
  withValue: string[];
}): AccountSolarGenerationStats {
  const stats = createAccountSolarGenerationStats();
  stats.rowsTotal = opts.rowsTotal ?? 0;
  stats.rowsBlankGatsGenId = opts.rowsBlankGatsGenId ?? 0;
  stats.rowsBlankValue = opts.rowsBlankValue ?? 0;
  for (const id of opts.seenExact) {
    stats.seenGatsGenIds.add(id);
    stats.seenGatsGenIdsLowercased.add(id.toLowerCase());
  }
  for (const id of opts.withValue) {
    stats.idsWithAtLeastOneValidValue.add(id);
  }
  return stats;
}

describe("classifyPerformanceRatioBaselineFallback", () => {
  it("counts a system with a baseline as withBaseline (NOT in any bucket)", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [{ trackingSystemRefId: "GEN001" }],
      generationBaselineByTrackingId: new Map([["GEN001", { ok: true }]]),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["GEN001"],
        withValue: ["GEN001"],
      }),
    });
    expect(result.totalSystems).toBe(1);
    expect(result.systemsWithBaseline).toBe(1);
    expect(result.systemsMissingBaseline).toBe(0);
    expect(result.bucketAMissingFromAccountSolarGen).toBe(0);
    expect(result.bucketBValueParseFailed).toBe(0);
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(0);
  });

  it("classifies a system with no baseline AND no row as Bucket A", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [{ trackingSystemRefId: "GEN_MISSING" }],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["GEN_OTHER"],
        withValue: ["GEN_OTHER"],
      }),
    });
    expect(result.bucketAMissingFromAccountSolarGen).toBe(1);
    expect(result.bucketBValueParseFailed).toBe(0);
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(0);
    expect(result.systemsMissingBaseline).toBe(1);
  });

  it("classifies a system seen in accountSolarGen but with no parseable value as Bucket B", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [{ trackingSystemRefId: "GEN_BLANK_VAL" }],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["GEN_BLANK_VAL"],
        withValue: [], // no row had a parseable Last Meter Read
      }),
    });
    expect(result.bucketAMissingFromAccountSolarGen).toBe(0);
    expect(result.bucketBValueParseFailed).toBe(1);
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(0);
  });

  it("classifies a system whose only match is via lowercased form as Bucket C", () => {
    // System has `gen001` (lowercase); accountSolarGen has `GEN001`.
    // The `clean` call in `applyAccountSolarGenerationPageToBaselineMap`
    // doesn't normalize case, so the join misses on exact match,
    // but the lowercased index hits.
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [{ trackingSystemRefId: "gen001" }],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["GEN001"], // uppercased only
        withValue: ["GEN001"],
      }),
    });
    expect(result.bucketAMissingFromAccountSolarGen).toBe(0);
    expect(result.bucketBValueParseFailed).toBe(0);
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(1);
  });

  it("classifies Bucket C BEFORE Bucket B when both apply (lowercased-only match takes precedence)", () => {
    // System ref `gen-X` is not in `seenGatsGenIds` (different
    // case). Even though the lowercased-but-uppercased form had
    // no value, the actionable signal is "case mismatch", not
    // "blank value".
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [{ trackingSystemRefId: "gen-X" }],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["GEN-X"],
        withValue: [], // GEN-X had no parseable value
      }),
    });
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(1);
    expect(result.bucketAMissingFromAccountSolarGen).toBe(0);
    expect(result.bucketBValueParseFailed).toBe(0);
  });

  it("counts fallbackEligibleByDateOnline only for systems with a Date Online entry", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [
        { trackingSystemRefId: "MISSING_HAS_DATE_ONLINE" },
        { trackingSystemRefId: "MISSING_NO_DATE_ONLINE" },
      ],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map([
        ["MISSING_HAS_DATE_ONLINE", new Date("2024-01-15")],
      ]),
      accountSolarGenerationStats: makeStats({
        seenExact: [],
        withValue: [],
      }),
    });
    expect(result.fallbackEligibleByDateOnline).toBe(1);
    expect(result.missingBaselineAndNoDateOnline).toBe(1);
    expect(result.systemsMissingBaseline).toBe(2);
  });

  it("ignores systems with no trackingSystemRefId (NULL refs don't get matched anyway)", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [
        { trackingSystemRefId: null },
        { trackingSystemRefId: "" },
        { trackingSystemRefId: "GEN_VALID" },
      ],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: [],
        withValue: [],
      }),
    });
    // null ref is ignored; "" is also ignored (truthiness check).
    expect(result.totalSystems).toBe(1);
    expect(result.bucketAMissingFromAccountSolarGen).toBe(1);
  });

  it("buckets sum to systemsMissingBaseline (invariant)", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [
        { trackingSystemRefId: "WITH_BASE" },
        { trackingSystemRefId: "BUCKET_A" },
        { trackingSystemRefId: "BUCKET_B" },
        { trackingSystemRefId: "bucket_c" }, // case mismatch with BUCKET_C
      ],
      generationBaselineByTrackingId: new Map([["WITH_BASE", { ok: true }]]),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        seenExact: ["BUCKET_B", "BUCKET_C"],
        withValue: ["BUCKET_C"],
      }),
    });
    expect(result.totalSystems).toBe(4);
    expect(result.systemsWithBaseline).toBe(1);
    expect(result.systemsMissingBaseline).toBe(3);
    expect(
      result.bucketAMissingFromAccountSolarGen +
        result.bucketBValueParseFailed +
        result.bucketCCaseOrWhitespaceMismatch
    ).toBe(result.systemsMissingBaseline);
    expect(result.bucketAMissingFromAccountSolarGen).toBe(1); // BUCKET_A
    expect(result.bucketBValueParseFailed).toBe(1); // BUCKET_B
    expect(result.bucketCCaseOrWhitespaceMismatch).toBe(1); // bucket_c
  });

  it("passes through row-level counters from the stats accumulator", () => {
    const result = classifyPerformanceRatioBaselineFallback({
      systems: [],
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
      accountSolarGenerationStats: makeStats({
        rowsTotal: 1_234_567,
        rowsBlankGatsGenId: 42,
        rowsBlankValue: 9_999,
        seenExact: [],
        withValue: [],
      }),
    });
    expect(result.rowsTotal).toBe(1_234_567);
    expect(result.rowsBlankGatsGenId).toBe(42);
    expect(result.rowsBlankValue).toBe(9_999);
  });
});
