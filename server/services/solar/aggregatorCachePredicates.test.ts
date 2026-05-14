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
 *
 * 2026-05-13 — added the cross-aggregator coverage rail at the
 * bottom of this file. It scans every `server/services/solar/
 * build*.ts` (non-test) source file and asserts that any builder
 * that calls `withArtifactCache` AND consumes
 * `loadCommonAggregatorInputs` / `getOrBuildSystemSnapshot` ALSO
 * declares a `shouldCache:` option. Future regressions where a
 * new builder is added without the gate get caught here.
 */

import fs from "node:fs";
import path from "node:path";
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

/**
 * 2026-05-13 — cross-aggregator regression rail.
 *
 * Background: PR #568 added the `shouldCache:` gate to two of the
 * sibling aggregators that share the
 * `(scheduleRowsTotal, eligibleTrackingIdCount, rowsEmitted)`
 * cache-poison shape (`forecast` + `performanceSourceRows`), but
 * left FIVE other call sites unguarded. Today's HIGH-2 follow-up
 * (this PR) wires the gate into those five
 * (`contractVintage`, `performanceRatio`, `overviewSummary`,
 * `changeOwnership`, `appPipelineMonthly`). This rail catches any
 * FUTURE call site that arrives without the gate.
 *
 * Heuristic: a builder needs the gate when it BOTH
 *   (a) calls `withArtifactCache` (i.e., persists a derived
 *       artifact); AND
 *   (b) consumes `loadCommonAggregatorInputs` OR
 *       `getOrBuildSystemSnapshot` OR `loadPerformanceRatioStatic
 *       Input` (the direct or indirect snapshot consumers — the
 *       only paths where a transient heap-pressure-induced
 *       empty-output can land).
 *
 * Test asserts that every such file ALSO contains the substring
 * `shouldCache:` somewhere in its body. A bare lexical check is
 * the cheapest way to keep the rail self-maintaining: the alias
 * import + the call-site key together produce two occurrences,
 * and the false-positive surface is bounded to comments — which
 * is acceptable here because the alias docstrings in each
 * aggregator deliberately mention `shouldCache:` to anchor the
 * pattern.
 */
describe("cross-aggregator gate coverage", () => {
  const SERVICES_SOLAR_DIR = __dirname;

  function readBuildSources(): { fileName: string; body: string }[] {
    return fs
      .readdirSync(SERVICES_SOLAR_DIR)
      .filter(
        (name) =>
          name.startsWith("build") &&
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts")
      )
      .map((name) => ({
        fileName: name,
        body: fs.readFileSync(path.join(SERVICES_SOLAR_DIR, name), "utf8"),
      }));
  }

  function consumesSnapshotIndirectly(body: string): boolean {
    return (
      body.includes("loadCommonAggregatorInputs") ||
      body.includes("getOrBuildSystemSnapshot") ||
      // `buildPerformanceRatioAggregates.ts` reaches the snapshot
      // via this helper, not the direct import.
      body.includes("loadPerformanceRatioStaticInput")
    );
  }

  function isWithArtifactCacheCallSite(body: string): boolean {
    // Only the actual `withArtifactCache(...)` or
    // `withArtifactCache<T>(...)` invocations matter — files that
    // merely import or comment on the helper get filtered out.
    // The regex requires the identifier followed by an optional
    // type-parameter list and an opening paren on the next char
    // boundary.
    return /withArtifactCache\s*(?:<[^>]+>)?\s*\(/.test(body);
  }

  it(
    "every `build*.ts` that calls withArtifactCache + consumes the system " +
      "snapshot declares a `shouldCache:` predicate",
    () => {
      const sources = readBuildSources();
      const offenders: string[] = [];
      for (const { fileName, body } of sources) {
        if (!isWithArtifactCacheCallSite(body)) continue;
        if (!consumesSnapshotIndirectly(body)) continue;
        if (!body.includes("shouldCache:")) {
          offenders.push(fileName);
        }
      }
      // Pin the expected zero-offender state. The error message
      // surfaces the offending file so the failure is actionable.
      expect(
        offenders,
        `These build*.ts files call withArtifactCache + consume the system ` +
          `snapshot but do not declare a 'shouldCache:' option — add one or ` +
          `document why the cache-poison vector does not apply.\n` +
          `Offending files:\n${offenders.map((f) => `  - ${f}`).join("\n")}`
      ).toEqual([]);
    }
  );

  it(
    "the rail itself sees a non-empty set of builders (sanity — guards " +
      "against a future grep mistake silently dropping all coverage)",
    () => {
      const sources = readBuildSources();
      const guarded = sources.filter(
        ({ body }) =>
          isWithArtifactCacheCallSite(body) &&
          consumesSnapshotIndirectly(body) &&
          body.includes("shouldCache:")
      );
      // The seven aggregators we expect to find post-HIGH-2:
      // contract-vintage, perf-ratio, overview-summary,
      // change-ownership, app-pipeline-monthly, forecast,
      // performance-source-rows. Future builders that adopt the
      // pattern can only grow this count.
      expect(guarded.length).toBeGreaterThanOrEqual(7);
    }
  );
});
