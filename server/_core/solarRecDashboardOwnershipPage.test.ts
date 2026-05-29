/**
 * Source-rail test for `getDashboardOwnershipPage`
 * (Phase 2 PR-E-3, updated through B3-cleanup 2026-05-29).
 *
 * Mirrors `solarRecDashboardChangeOwnershipPage.test.ts` — pin
 * the procedure's shape (auth gate, input validation, standing
 * filter, source filter, DB-helper call, response envelope)
 * without spinning up a real DB or tRPC caller. The actual data
 * path is covered by `dashboardOwnershipFacts.test.ts` (PR-E-1).
 *
 * Two filter axes: the OwnershipTab combines `standing` (the
 * 9-value risk-tier taxonomy, primary control) with the Matched
 * System vs Part II Unmatched `source` toggle. Both covering
 * indexes — `(scopeId, standing)` (PR B2) and `(scopeId, source)`
 * (PR-E-1) — exist because the proc actually passes both inputs
 * through to the DB helper. This test pins both wirings.
 *
 * History: PR-E-3 originally shipped with a 6-value `status`
 * filter axis (the legacy `ownershipStatus` enum) plus `source`.
 * B3-cleanup (migration 0077) retired both the column and the
 * `status` zod input after B3-final (#651) migrated every
 * consumer to `standing`.
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

describe("getDashboardOwnershipPage (source rail)", () => {
  const proc = sliceProcedure("getDashboardOwnershipPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares cursor as a nullable optional string with maxLength 128 (matches systemKey column)", () => {
    // Field name `cursor` (not `cursorAfter`) so the proc plays
    // cleanly with tRPC v11's `useInfiniteQuery`, which auto-injects
    // the cursor into the input field whose name matches the
    // convention.
    expect(proc!).toMatch(/cursor:\s*z\.string\(\)/);
    expect(proc!).toMatch(/\.max\(128\)/);
    expect(proc!).toMatch(/\.nullable\(\)/);
  });

  it("declares limit as bounded int [1, 1000] with default 200", () => {
    expect(proc!).toMatch(/limit:\s*z\.number\(\)\.int\(\)/);
    expect(proc!).toMatch(/\.min\(1\)/);
    expect(proc!).toMatch(/\.max\(1000\)/);
    expect(proc!).toMatch(/\.default\(200\)/);
  });

  // B3-cleanup: the legacy 6-value `OwnershipStatus` zod input was
  // retired here along with the column. Defend against accidental
  // re-introduction — a regression that re-adds the input would
  // re-create the silent-no-op trap that B3-cleanup closed.
  it("does NOT accept any of the legacy 6-value OwnershipStatus enum members", () => {
    expect(proc!).not.toMatch(/"Transferred and Reporting"/);
    expect(proc!).not.toMatch(/"Transferred and Not Reporting"/);
    expect(proc!).not.toMatch(/"Not Transferred and Reporting"/);
    expect(proc!).not.toMatch(/"Not Transferred and Not Reporting"/);
    expect(proc!).not.toMatch(/"Terminated and Reporting"/);
    expect(proc!).not.toMatch(/"Terminated and Not Reporting"/);
  });

  it("does NOT declare a legacy `status` zod input", () => {
    expect(proc!).not.toMatch(/^\s*status:\s*z/m);
  });

  // B3-final (PR #651): the `standing` filter axis is now the
  // sole risk-tier filter. Listing every Standing value
  // explicitly catches a silent enum drop.
  it("accepts the full 9-value Standing enum", () => {
    expect(proc!).toMatch(/"Active — Good Standing"/);
    expect(proc!).toMatch(/"Active — Good Standing \(Assigned\)"/);
    expect(proc!).toMatch(/"At Risk — Unassigned Transfer"/);
    expect(proc!).toMatch(/"At Risk — Reporting Lapse"/);
    expect(proc!).toMatch(/"At Risk — Reporting Lapse \(Assigned\)"/);
    expect(proc!).toMatch(/"Jeopardy \/ Default-Track"/);
    expect(proc!).toMatch(/"Closed — RECs Repaid \(Good Standing\)"/);
    expect(proc!).toMatch(/"Closed — Default"/);
    expect(proc!).toMatch(/"Unknown"/);
  });

  it("declares standing as nullable + optional", () => {
    expect(proc!).toMatch(
      /standing:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("accepts the 2-value source enum (Matched System vs Part II Unmatched)", () => {
    // The source toggle is the second filter axis vs PR-D-3.
    // Pinning both values explicitly defends against a regression
    // where the union narrows silently.
    expect(proc!).toMatch(/"Matched System"/);
    expect(proc!).toMatch(/"Part II Unmatched"/);
  });

  it("declares source as nullable + optional (combinable with standing)", () => {
    expect(proc!).toMatch(
      /source:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("delegates to getOwnershipFactsPage from the DB helper module", () => {
    expect(proc!).toMatch(/getOwnershipFactsPage/);
    expect(proc!).toMatch(
      /import\(\s*"\.\.\/db\/dashboardOwnershipFacts"\s*\)/
    );
  });

  it("forwards the standing filter to the DB helper (B3 risk-tier axis)", () => {
    // Same defense as `status` above — the proc could accept the
    // new `standing` input and silently never apply the WHERE
    // predicate.
    expect(proc!).toMatch(/standing:\s*input\.standing\s*\?\?\s*null/);
  });

  it("forwards the source filter to the DB helper (key wiring axis 2)", () => {
    // Same defense for the Matched System / Part II Unmatched
    // toggle — the new filter axis vs PR-D-3.
    expect(proc!).toMatch(/source:\s*input\.source\s*\?\?\s*null/);
  });

  it("derives nextCursor from the last row's systemKey when the page is full", () => {
    expect(proc!).toMatch(/rows\.length === input\.limit/);
    expect(proc!).toMatch(/systemKey/);
  });

  it("ships nextCursor=null AND hasMore=false at end-of-stream (kept in sync)", () => {
    expect(proc!).toMatch(/nextCursor\s*!==\s*null/);
    expect(proc!).toMatch(/hasMore/);
  });

  it("ships the bumped B3-cleanup `_runnerVersion` marker (CLAUDE.md Hard Rule #3)", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-e-3@3"/);
  });

  it("ships a `_checkpoint` for cache-busting + deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint:\s*"ownership-page-v1"/);
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("does NOT call the heavy aggregator (this proc is the OOM-safe replacement, not a wrapper)", () => {
    // Defends against a regression where someone "consolidates"
    // by calling `getOrBuildOverviewSummary` from this proc,
    // defeating the whole point of the fact-table migration.
    expect(proc!).not.toMatch(/getOrBuildOverviewSummary/);
  });
});
