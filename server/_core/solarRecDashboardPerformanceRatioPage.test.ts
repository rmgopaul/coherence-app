/**
 * Source-rail tests for the Performance-Ratio router procs after
 * the 2026-05-09 Option C build-isolation refactor.
 *
 * Pin the procedure shapes (auth gate, input validation, filter
 * surface, slim wire shape, visibility-pointer contract) without
 * spinning up a real DB or tRPC caller. The data path is covered
 * by `dashboardPerformanceRatioFacts.test.ts` and
 * `buildDashboardPerformanceRatioFacts.test.ts`.
 *
 * Procs covered:
 *   - getDashboardPerformanceRatioPage (extended with offset /
 *     sortBy / sortDir / search; visibility gated by summary
 *     buildId)
 *   - getDashboardPerformanceRatioSummary (extended with the
 *     monitoringOptions + aggregate fields)
 *   - getDashboardPerformanceRatioFilteredAggregates (new)
 *   - getDashboardPerformanceRatioCompliantContext (new)
 *   - startDashboardCsvExport input now accepts performanceRatioCsv
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTER_FILE = resolve(__dirname, "solarRecDashboardRouter.ts");
const source = readFileSync(ROUTER_FILE, "utf8");

function sliceProcedure(name: string): string | null {
  const start = source.indexOf(`${name}: dashboardProcedure`);
  if (start === -1) return null;
  const nextProcedure = /\n  [A-Za-z0-9_]+: dashboardProcedure/g;
  nextProcedure.lastIndex = start + 1;
  const next = nextProcedure.exec(source);
  return source.slice(start, next?.index ?? source.length);
}

describe("getDashboardPerformanceRatioPage (Option C source rail)", () => {
  const proc = sliceProcedure("getDashboardPerformanceRatioPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares offset as a non-negative integer (default 0)", () => {
    expect(proc!).toMatch(/offset:\s*z\.number\(\)\.int\(\)\.min\(0\)/);
    expect(proc!).toMatch(/offset:\s*z[\s\S]*?\.default\(0\)/);
  });

  it("declares limit as bounded int [1, 1000] with default 100 (Option C smaller default)", () => {
    expect(proc!).toMatch(/limit:\s*z\.number\(\)\.int\(\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.min\(1\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.max\(1000\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.default\(100\)/);
  });

  it("accepts the full PerformanceRatioMatchType enum (3 values)", () => {
    expect(proc!).toMatch(/"Monitoring \+ System ID \+ System Name"/);
    expect(proc!).toMatch(/"Monitoring \+ System ID"/);
    expect(proc!).toMatch(/"Monitoring \+ System Name"/);
  });

  it("declares matchType as nullable + optional (omit-to-fetch-all semantics)", () => {
    expect(proc!).toMatch(
      /matchType:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares monitoring as a length-bounded nullable optional string", () => {
    expect(proc!).toMatch(
      /monitoring:\s*z\.string\(\)[\s\S]*?\.max\(128\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares search as an optional bounded string (multi-column LIKE)", () => {
    expect(proc!).toMatch(
      /search:\s*z\.string\(\)[\s\S]*?\.max\(200\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares sortBy as the 5-value enum", () => {
    expect(proc!).toMatch(/"performanceRatioPercent"/);
    expect(proc!).toMatch(/"productionDeltaWh"/);
    expect(proc!).toMatch(/"expectedProductionWh"/);
    expect(proc!).toMatch(/"systemName"/);
    expect(proc!).toMatch(/"readDate"/);
    expect(proc!).toMatch(/sortBy:\s*z\s*\.\s*enum/);
  });

  it("declares sortDir as the (asc | desc) enum with default desc", () => {
    expect(proc!).toMatch(/sortDir:\s*z\s*\.\s*enum\(\["asc",\s*"desc"\]\)/);
    expect(proc!).toMatch(/sortDir:\s*z[\s\S]*?\.default\("desc"\)/);
  });

  it("delegates to getPerformanceRatioFactsPage from the DB helper module", () => {
    expect(proc!).toMatch(/getPerformanceRatioFactsPage/);
    expect(proc!).toMatch(
      /import\(\s*\n?\s*"\.\.\/db\/dashboardPerformanceRatioFacts"\s*\)/
    );
  });

  it("filters by the SUMMARY's buildId (visibility-pointer contract)", () => {
    // The proc resolves the visible build via the summary
    // artifact's `buildId`, then passes it as the `buildId`
    // filter to the DB helper. Defends against a regression
    // that would expose rows from in-flight or failed builds.
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
    // The page proc parses the summary once via the canonical
    // shared helper to avoid double-parsing for buildId + builtAt.
    expect(proc!).toMatch(/parsePerformanceRatioSummaryPayload/);
    expect(proc!).toMatch(/buildId,/);
  });

  it("returns `available: false` + empty rows when no successful build exists", () => {
    expect(proc!).toMatch(/available:\s*false/);
    // Must ship `_runnerVersion` even on the empty path.
    expect(proc!).toMatch(/_runnerVersion/);
  });

  it("strips scopeId + buildId from each row (slim wire shape)", () => {
    // Wire-shape projection: the per-row mapper builds an explicit
    // PerformanceRatioPageRow object. Forbidden fields:
    expect(proc!).not.toMatch(/scopeId:\s*row\.scopeId/);
    expect(proc!).not.toMatch(/buildId:\s*row\.buildId/);
    // Allowed fields (spot-check):
    expect(proc!).toMatch(/key:\s*row\.key/);
    expect(proc!).toMatch(/performanceRatioPercent:\s*row\.performanceRatioPercent/);
  });

  it("returns totalCount (driven by getPerformanceRatioFactsCount) for pagination footer", () => {
    expect(proc!).toMatch(/getPerformanceRatioFactsCount/);
    expect(proc!).toMatch(/totalCount/);
  });

  it("returns hasMore + nextCursor (offset-based pagination)", () => {
    expect(proc!).toMatch(/hasMore/);
    expect(proc!).toMatch(/nextCursor/);
  });

  it("ships a `_runnerVersion` marker (CLAUDE.md Hard Rule #3)", () => {
    expect(proc!).toMatch(
      /_runnerVersion\s*=\s*"phase-2-pr-g-option-c-page/
    );
  });

  it("ships a `_checkpoint` for cache-busting + deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint/);
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("does NOT call the heavy aggregator (Option C bypasses it)", () => {
    expect(proc!).not.toMatch(/getOrBuildPerformanceRatio/);
  });
});

describe("getDashboardPerformanceRatioSummary (Option C source rail)", () => {
  const proc = sliceProcedure("getDashboardPerformanceRatioSummary");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("reads from the side-cache via getComputedArtifact (not the heavy aggregator)", () => {
    expect(proc!).toMatch(/getComputedArtifact/);
    expect(proc!).not.toMatch(/getOrBuildPerformanceRatio/);
  });

  it("uses the build-runner-written summary artifact-type + version-key constants", () => {
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_VERSION_KEY/);
    expect(proc!).toMatch(
      /import\(\s*\n?\s*"\.\.\/services\/solar\/buildDashboardPerformanceRatioFacts"/
    );
  });

  it("returns `available: false` on cold cache", () => {
    expect(proc!).toMatch(/available:\s*false/);
  });

  it("returns `available: true` + spreads the validated summary on warm cache", () => {
    expect(proc!).toMatch(/available:\s*true/);
    // Codex review fixup: the proc no longer inlines a typed
    // JSON.parse cast — it delegates to
    // `parsePerformanceRatioSummaryPayload` which validates
    // every required Option-C field. The spread `...summary`
    // ships every field from the parser's return.
    expect(proc!).toMatch(/parsePerformanceRatioSummaryPayload/);
    expect(proc!).toMatch(/\.\.\.summary/);
  });

  it("ships a `_runnerVersion` marker on both cold and warm paths", () => {
    expect(proc!).toMatch(
      /const\s+_runnerVersion\s*=\s*"phase-2-pr-g-option-c-summary/
    );
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("returns `available: false` when `parsePerformanceRatioSummaryPayload` rejects (self-heal)", () => {
    // Pre-Codex-review the proc had an inline try/catch around
    // JSON.parse + a raw type cast. The cast didn't validate
    // missing fields — a pre-Option-C summary payload (lacking
    // allocationCount / monitoringOptions / etc.) would surface
    // with NaN tile values + an empty dropdown. The shared
    // parser now validates every required field; the proc just
    // checks for a null return.
    expect(proc!).toMatch(/if\s*\(\s*!summary\s*\)/);
  });
});

describe("getDashboardPerformanceRatioFilteredAggregates (new in Option C)", () => {
  const proc = sliceProcedure(
    "getDashboardPerformanceRatioFilteredAggregates"
  );

  it("is registered", () => {
    expect(proc).not.toBeNull();
  });

  it("accepts the same 3 filter args as the page proc", () => {
    expect(proc!).toMatch(/matchType:/);
    expect(proc!).toMatch(/monitoring:/);
    expect(proc!).toMatch(/search:/);
  });

  it("filters by the summary's buildId (visibility-pointer contract)", () => {
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
    // Filtered-aggregates proc only needs the buildId, so it
    // uses the slim `extractPerformanceRatioVisibleBuildId`
    // helper rather than parsing the full payload.
    expect(proc!).toMatch(/extractPerformanceRatioVisibleBuildId/);
  });

  it("delegates to getPerformanceRatioFactsAggregates", () => {
    expect(proc!).toMatch(/getPerformanceRatioFactsAggregates/);
  });

  it("uses the shared `computePortfolioRatioPercent` helper (single source of truth for the formula)", () => {
    // Pre-fix the proc inlined a near-duplicate of the build
    // runner's portfolio-ratio formula, missing the
    // Number.isFinite guards.
    expect(proc!).toMatch(/computePortfolioRatioPercent/);
  });

  it("computes portfolioRatioPercent in the response", () => {
    expect(proc!).toMatch(/portfolioRatioPercent/);
  });

  it("returns `available: false` when no successful build exists", () => {
    expect(proc!).toMatch(/available:\s*false/);
  });

  it("ships a `_runnerVersion` marker", () => {
    expect(proc!).toMatch(
      /_runnerVersion[\s\S]*?phase-2-pr-g-option-c-filtered-agg/
    );
  });
});

describe("getDashboardPerformanceRatioCompliantContext (new in Option C)", () => {
  const proc = sliceProcedure(
    "getDashboardPerformanceRatioCompliantContext"
  );

  it("is registered", () => {
    expect(proc).not.toBeNull();
  });

  it("reads BOTH side-cache artifact types (auto-compliant + best-per-system) AND the summary artifact (visibility gate)", () => {
    // Codex review fixup: pre-fix this proc returned the
    // latest side-cache rows whether or not the summary's
    // visibility flip had completed, so a build that failed
    // AFTER side-cache writes but BEFORE the summary write
    // would surface its (now-superseded) compliant rows
    // alongside the OLD main table — inconsistent UI. The
    // proc now reads the summary artifact too and gates on
    // a 3-way buildId match (summary === auto === best).
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
    expect(proc!).toMatch(/PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE/);
    expect(proc!).toMatch(/PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE/);
    expect(proc!).toMatch(/extractPerformanceRatioVisibleBuildId/);
    expect(proc!).toMatch(
      /autoPayload\.buildId\s*!==\s*visibleBuildId/
    );
    expect(proc!).toMatch(
      /bestPayload\.buildId\s*!==\s*visibleBuildId/
    );
  });

  it("returns autoSources + bestPerSystem + buildId on the warm path", () => {
    expect(proc!).toMatch(/autoSources/);
    expect(proc!).toMatch(/bestPerSystem/);
    expect(proc!).toMatch(/buildId/);
  });

  it("returns `available: false` when either artifact is missing", () => {
    expect(proc!).toMatch(/available:\s*false/);
  });

  it("scopes the read by ctx.scopeId", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("ships a `_runnerVersion` marker", () => {
    expect(proc!).toMatch(
      /_runnerVersion[\s\S]*?phase-2-pr-g-option-c-compliant/
    );
  });
});

describe("startDashboardCsvExport — performanceRatioCsv input (new in Option C)", () => {
  const proc = sliceProcedure("startDashboardCsvExport");

  it("is registered", () => {
    expect(proc).not.toBeNull();
  });

  it("accepts performanceRatioCsv as a discriminated-union variant", () => {
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)/);
  });

  it("requires the same filter + sort args the page proc accepts", () => {
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)[\s\S]*?matchType:/);
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)[\s\S]*?monitoring:/);
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)[\s\S]*?search:/);
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)[\s\S]*?sortBy:/);
    expect(proc!).toMatch(/exportType:\s*z\.literal\("performanceRatioCsv"\)[\s\S]*?sortDir:/);
  });
});

describe("startDashboardCsvExport — performanceRatioCompliantBestCsv input (PR-CB-4)", () => {
  const proc = sliceProcedure("startDashboardCsvExport");

  it("accepts performanceRatioCompliantBestCsv as a discriminated-union variant", () => {
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)/
    );
  });

  it("requires the same filter + sort args the compliant-best page proc accepts", () => {
    // compliantSource (string-nullable) — the new filter unique
    // to the compliant-best subset; not present on the parent
    // performanceRatioCsv export.
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?compliantSource:/
    );
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?monitoring:/
    );
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?search:/
    );
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?sortBy:/
    );
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?sortDir:/
    );
  });

  it("declares sortBy as the 4-value enum specific to compliant-best (NOT the parent's 5-value enum)", () => {
    // The compliant-best sort enum has only 4 values: the parent
    // performanceRatioCsv enum's `productionDeltaWh` and
    // `expectedProductionWh` are not part of this enum because
    // they're not load-bearing for the compliant-best subset
    // (the subset is already filtered on `part2 + ratio in [30,
    // 150]` so productionDelta and expectedProduction add no
    // sortable signal).
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?\.enum\(\[\s*"performanceRatioPercent",\s*"readDate",\s*"systemName",\s*"compliantSource",?\s*\]\)/
    );
  });

  it("declares sortDir as the (asc | desc) enum", () => {
    expect(proc!).toMatch(
      /exportType:\s*z\.literal\("performanceRatioCompliantBestCsv"\)[\s\S]*?sortDir:\s*z\.enum\(\["asc",\s*"desc"\]\)/
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// PR-CB-3 — getDashboardPerformanceRatioCompliantBestPage
// ────────────────────────────────────────────────────────────────────

describe("getDashboardPerformanceRatioCompliantBestPage (PR-CB-3 source rail)", () => {
  const proc = sliceProcedure("getDashboardPerformanceRatioCompliantBestPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares offset as a non-negative integer (default 0)", () => {
    expect(proc!).toMatch(/offset:\s*z\.number\(\)\.int\(\)\.min\(0\)/);
    expect(proc!).toMatch(/offset:\s*z[\s\S]*?\.default\(0\)/);
  });

  it("declares limit as bounded int [1, 1000] with default 100", () => {
    expect(proc!).toMatch(/limit:\s*z\.number\(\)\.int\(\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.min\(1\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.max\(1000\)/);
    expect(proc!).toMatch(/limit:\s*z[\s\S]*?\.default\(100\)/);
  });

  it("declares compliantSource as a length-bounded nullable optional string (matches DB column varchar(64))", () => {
    expect(proc!).toMatch(
      /compliantSource:\s*z\.string\(\)[\s\S]*?\.max\(64\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares monitoring as a length-bounded nullable optional string", () => {
    expect(proc!).toMatch(
      /monitoring:\s*z\.string\(\)[\s\S]*?\.max\(128\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares search as an optional bounded string (multi-column LIKE)", () => {
    expect(proc!).toMatch(
      /search:\s*z\.string\(\)[\s\S]*?\.max\(200\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("declares sortBy as an enum of the 4 supported sort columns (default readDate)", () => {
    expect(proc!).toMatch(/"performanceRatioPercent"/);
    expect(proc!).toMatch(/"readDate"/);
    expect(proc!).toMatch(/"systemName"/);
    expect(proc!).toMatch(/"compliantSource"/);
    expect(proc!).toMatch(/sortBy:[\s\S]*?\.default\("readDate"\)/);
  });

  it("declares sortDir as enum [asc, desc] with default desc", () => {
    expect(proc!).toMatch(/sortDir:\s*z\.enum\(\["asc",\s*"desc"\]\)/);
    expect(proc!).toMatch(/sortDir:[\s\S]*?\.default\("desc"\)/);
  });

  it("emits a _runnerVersion marker for deploy verification", () => {
    expect(proc!).toMatch(/_runnerVersion[\s\S]*?phase-2-pr-cb-3-page/);
  });

  it("emits a _checkpoint string for deploy verification", () => {
    expect(proc!).toMatch(
      /_checkpoint[\s\S]*?performance-ratio-compliant-best-page/
    );
  });

  it("gates visibility on the summary artifact's buildId", () => {
    expect(proc!).toMatch(/parsePerformanceRatioSummaryPayload/);
    expect(proc!).toMatch(/summary\?\.buildId/);
    expect(proc!).toMatch(/available:\s*false/);
  });

  it("returns rows + totalCount + offset + nextCursor + hasMore + buildId + builtAt", () => {
    expect(proc!).toMatch(/rows[,\s]/);
    expect(proc!).toMatch(/totalCount/);
    expect(proc!).toMatch(/nextCursor/);
    expect(proc!).toMatch(/hasMore/);
    expect(proc!).toMatch(/buildId/);
    expect(proc!).toMatch(/builtAt/);
  });

  it("uses the new fact-table DB helpers (page + count)", () => {
    expect(proc!).toMatch(/getPerformanceRatioCompliantFactsPage/);
    expect(proc!).toMatch(/getPerformanceRatioCompliantFactsCount/);
  });

  it("reuses the parent fact-table summary's buildId pointer (not the autoCompliant or bestPerSystem artifacts)", () => {
    // The page proc reads only the summary artifact for visibility
    // gating; secondary artifacts like
    // PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE are NOT
    // read here (avoids a 3-way artifact race).
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
    expect(proc!).not.toMatch(/PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE/);
    expect(proc!).not.toMatch(/PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE/);
  });
});

// ────────────────────────────────────────────────────────────────────
// PR-CB-3 — getDashboardPerformanceRatioCompliantBestSummary
// ────────────────────────────────────────────────────────────────────

describe("getDashboardPerformanceRatioCompliantBestSummary (PR-CB-3 source rail)", () => {
  const proc = sliceProcedure(
    "getDashboardPerformanceRatioCompliantBestSummary"
  );

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("emits a _runnerVersion marker for deploy verification", () => {
    expect(proc!).toMatch(/_runnerVersion[\s\S]*?phase-2-pr-cb-3-summary/);
  });

  it("gates visibility on the summary artifact's buildId via the shared extractor helper", () => {
    expect(proc!).toMatch(/extractPerformanceRatioVisibleBuildId/);
    expect(proc!).toMatch(/PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE/);
  });

  it("returns count + withCompliantSource aggregates", () => {
    expect(proc!).toMatch(/count:\s*aggregates\.count/);
    expect(proc!).toMatch(/withCompliantSource:\s*aggregates\.withCompliantSource/);
  });

  it("returns the dropdown options (compliantSourceOptions + monitoringOptions)", () => {
    expect(proc!).toMatch(/compliantSourceOptions/);
    expect(proc!).toMatch(/monitoringOptions/);
  });

  it("uses Promise.all for the 3 parallel reads (aggregates + 2 distinct-options)", () => {
    expect(proc!).toMatch(/Promise\.all\(/);
    expect(proc!).toMatch(/getPerformanceRatioCompliantFactsAggregates/);
    expect(proc!).toMatch(/getPerformanceRatioCompliantSourceOptions/);
    expect(proc!).toMatch(/getPerformanceRatioCompliantMonitoringOptions/);
  });

  it("returns available=false when no summary buildId exists yet (cold cache)", () => {
    expect(proc!).toMatch(/if\s*\(\s*!buildId\s*\)/);
    expect(proc!).toMatch(/available:\s*false/);
  });
});
