/**
 * 2026-05-13 — throughput-tuning rail for the convertedReads page
 * size used by the performance-ratio fact-build runner.
 *
 * Companion to the chunk-size rail in
 * `server/db/dashboardPerformanceRatioFacts.test.ts`. Together they
 * pin the two roundtrip-bound dials that motivated the
 * `bld-2ebd9c6cdcdd3e41495edb6725e80238` timeout fix:
 *   - SELECT page size (this file) → halves the streaming-loader's
 *     read roundtrip count.
 *   - upsert CHUNK_SIZE (sibling test) → roughly halves the per-page
 *     write roundtrip count.
 *
 * The 2026-05-08 hardening cut the page size from 5_000 → 2_500 to
 * survive a 13M-row prod-shape scope; the 2026-05-13 retune restores
 * it to 5_000 because today's failing scope is 1.58M rows (4× lower
 * memory pressure) and the step is roundtrip-bound, not memory-
 * bound. A regression that puts the constant below 5_000 will
 * resurface the timeout on the same scope shape, so this rail is
 * load-bearing.
 */
import { describe, expect, it } from "vitest";

import { PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE } from "./loadPerformanceRatioInput";

describe("PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE", () => {
  it("is at least 5_000 (throughput floor; see file header)", () => {
    expect(PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE).toBeGreaterThanOrEqual(
      5_000
    );
  });

  it("is an integer", () => {
    expect(
      Number.isInteger(PERFORMANCE_RATIO_CONVERTED_READS_PAGE_SIZE)
    ).toBe(true);
  });
});
