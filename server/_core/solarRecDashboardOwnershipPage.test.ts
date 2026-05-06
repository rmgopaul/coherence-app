/**
 * Source-rail test for `getDashboardOwnershipPage`
 * (Phase 2 PR-E-3).
 *
 * Mirrors `solarRecDashboardChangeOwnershipPage.test.ts` — pin
 * the procedure's shape (auth gate, input validation, status
 * filter, source filter, DB-helper call, response envelope)
 * without spinning up a real DB or tRPC caller. The actual data
 * path is covered by `dashboardOwnershipFacts.test.ts` (PR-E-1).
 *
 * Two filter axes vs. PR-D-3's one: the OverviewTab combines
 * `ownershipStatus` (primary control) with the Matched System vs
 * Part II Unmatched `source` toggle. Both covering indexes —
 * `(scopeId, ownershipStatus)` and `(scopeId, source)` — exist
 * because the proc actually passes both inputs through to the DB
 * helper. This test pins both wirings.
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

  it("accepts the full OwnershipStatus enum (6 values: Transferred / Not Transferred / Terminated × Reporting / Not Reporting)", () => {
    // Listing all 6 values defends against a regression where one
    // is dropped silently and the OverviewTab's status filter
    // breaks for that status.
    expect(proc!).toMatch(/"Transferred and Reporting"/);
    expect(proc!).toMatch(/"Transferred and Not Reporting"/);
    expect(proc!).toMatch(/"Not Transferred and Reporting"/);
    expect(proc!).toMatch(/"Not Transferred and Not Reporting"/);
    expect(proc!).toMatch(/"Terminated and Reporting"/);
    expect(proc!).toMatch(/"Terminated and Not Reporting"/);
  });

  it("declares status as nullable + optional (omit-to-fetch-all semantics)", () => {
    expect(proc!).toMatch(
      /status:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
  });

  it("accepts the 2-value source enum (Matched System vs Part II Unmatched)", () => {
    // The source toggle is the second filter axis vs PR-D-3.
    // Pinning both values explicitly defends against a regression
    // where the union narrows silently.
    expect(proc!).toMatch(/"Matched System"/);
    expect(proc!).toMatch(/"Part II Unmatched"/);
  });

  it("declares source as nullable + optional (combinable with status; either omitted)", () => {
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

  it("forwards the status filter to the DB helper (key wiring axis 1)", () => {
    // Defends against a regression where the input is accepted
    // but never passed through — the proc would still pass tsc
    // but status-filtered reads would scan the whole table.
    expect(proc!).toMatch(/status:\s*input\.status\s*\?\?\s*null/);
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

  it("ships a `_runnerVersion` marker (CLAUDE.md Hard Rule #3)", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-e-3/);
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
