/**
 * Source-rail test for `getDashboardPerformanceRatioPage`
 * (Phase 2 PR-G-3).
 *
 * Mirrors `solarRecDashboardChangeOwnershipPage.test.ts` — pin the
 * procedure's shape (auth gate, input validation, dual filter
 * axes, DB-helper call, response envelope) without spinning up a
 * real DB or tRPC caller. Actual data path is covered by
 * `dashboardPerformanceRatioFacts.test.ts` (PR-G-1) and
 * `buildDashboardPerformanceRatioFacts.test.ts` (PR-G-2).
 *
 * Additional rails vs. ChangeOwnership:
 *   - **Two filter axes** (`matchType` + `monitoring`) instead of
 *     one. Both must pass through to the DB helper or the
 *     covering indexes are wasted.
 *   - **Cursor max length 255** (not 128) because the `key`
 *     column is the `${convertedReadKey}-${systemKey}` composite,
 *     which can exceed 128 chars on systems with long stable
 *     identifiers.
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

describe("getDashboardPerformanceRatioPage (source rail)", () => {
  const proc = sliceProcedure("getDashboardPerformanceRatioPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares cursor as a nullable optional string with maxLength 255 (matches key column)", () => {
    // Field name `cursor` (not `cursorAfter`) — tRPC v11
    // useInfiniteQuery auto-inject convention.
    // maxLength 255 matches the schema's varchar(255) `key` column
    // (composite of convertedReadKey + systemKey).
    expect(proc!).toMatch(/cursor:\s*z\.string\(\)/);
    expect(proc!).toMatch(/\.max\(255\)/);
    expect(proc!).toMatch(/\.nullable\(\)/);
  });

  it("declares limit as bounded int [1, 1000] with default 200", () => {
    expect(proc!).toMatch(/limit:\s*z\.number\(\)\.int\(\)/);
    expect(proc!).toMatch(/\.min\(1\)/);
    expect(proc!).toMatch(/\.max\(1000\)/);
    expect(proc!).toMatch(/\.default\(200\)/);
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
    // Free-form string sized to fit the schema's varchar(128)
    // `monitoring` column.
    expect(proc!).toMatch(/monitoring:\s*z\.string\(\)/);
    expect(proc!).toMatch(
      /monitoring:\s*z[\s\S]*?\.max\(128\)[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("delegates to getPerformanceRatioFactsPage from the DB helper module", () => {
    expect(proc!).toMatch(/getPerformanceRatioFactsPage/);
    expect(proc!).toMatch(
      /import\(\s*"\.\.\/db\/dashboardPerformanceRatioFacts"\s*\)/
    );
  });

  it("forwards BOTH filter axes to the DB helper (key wiring)", () => {
    // Defends against a regression where an input is accepted but
    // never passed through — the proc would still pass tsc but
    // filtered reads would scan the whole table.
    expect(proc!).toMatch(/matchType:\s*input\.matchType\s*\?\?\s*null/);
    expect(proc!).toMatch(/monitoring:\s*input\.monitoring\s*\?\?\s*null/);
  });

  it("derives nextCursor from the last row's key when the page is full", () => {
    expect(proc!).toMatch(/rows\.length === input\.limit/);
    expect(proc!).toMatch(/\.key/);
  });

  it("ships nextCursor=null AND hasMore=false at end-of-stream (kept in sync)", () => {
    expect(proc!).toMatch(/nextCursor\s*!==\s*null/);
    expect(proc!).toMatch(/hasMore/);
  });

  it("ships a `_runnerVersion` marker (CLAUDE.md Hard Rule #3)", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-g-3/);
  });

  it("ships a `_checkpoint` for cache-busting + deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint:\s*"performance-ratio-page-v1"/);
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("does NOT call the heavy aggregator (this proc is the OOM-safe replacement, not a wrapper)", () => {
    // Defends against a regression where someone "consolidates" by
    // calling `getOrBuildPerformanceRatio` from this proc, defeating
    // the whole point of the fact-table migration.
    expect(proc!).not.toMatch(/getOrBuildPerformanceRatio/);
  });
});

describe("getDashboardPerformanceRatioSummary (source rail)", () => {
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
    // Cache-only contract: NEVER triggers a row materialization.
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

  it("returns `available: false` on cold cache (no payload yet)", () => {
    expect(proc!).toMatch(/available:\s*false/);
  });

  it("returns `available: true` + summary fields on warm cache", () => {
    expect(proc!).toMatch(/available:\s*true/);
    // Spot-check the fields the client tab will render. JSON.parse
    // is the canonical deserialization path.
    expect(proc!).toMatch(/JSON\.parse/);
  });

  it("ships a `_runnerVersion` marker on BOTH cold and warm paths", () => {
    // Const declaration sets the literal value once; both return
    // branches reference the variable so a single regex on the
    // const captures both paths.
    expect(proc!).toMatch(
      /const\s+_runnerVersion\s*=\s*"phase-2-pr-g-3-summary/
    );
    // Both branches return the variable.
    expect(proc!).toMatch(
      /return\s*\{\s*available:\s*false[\s\S]*?_runnerVersion[\s\S]*?\}/
    );
    expect(proc!).toMatch(
      /return\s*\{\s*available:\s*true[\s\S]*?_runnerVersion[\s\S]*?\}/
    );
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("falls back to `available: false` on JSON.parse failure (corrupt payload self-heal)", () => {
    // Defends against a future schema change that leaves stale
    // payloads from a prior version. The next build overwrites;
    // the client renders N/A in the meantime instead of garbage.
    expect(proc!).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
  });
});
