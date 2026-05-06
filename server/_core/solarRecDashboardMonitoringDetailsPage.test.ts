/**
 * Source-rail test for `getDashboardMonitoringDetailsPage`
 * (Phase 2 PR-C-3-a).
 *
 * Mirrors the source-rail pattern from
 * `solarRecDashboardSharedDatasets.test.ts` — pin the procedure's
 * shape (auth gate, input validation, DB-helper call, response
 * envelope) without spinning up a real DB or tRPC caller. The
 * actual data path is covered by `dashboardMonitoringDetailsFacts.test.ts`
 * (PR-C-1).
 *
 * What this rail prevents:
 *   - Auth gate regressions (e.g., a refactor that drops the
 *     `requirePermission("solar-rec-dashboard", "read")` gate).
 *   - Cursor-pagination contract drift (the client + server have
 *     to agree on `cursorAfter` / `nextCursor` / `hasMore`).
 *   - Missing `_runnerVersion` (Hard Rule #3 from CLAUDE.md).
 *   - Wire-payload-budget regressions (the limit max must stay
 *     bounded so no caller can request 50k rows).
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

describe("getDashboardMonitoringDetailsPage (source rail)", () => {
  const proc = sliceProcedure("getDashboardMonitoringDetailsPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares cursorAfter as a nullable optional string with maxLength 128 (matches systemKey column)", () => {
    expect(proc!).toMatch(/cursorAfter:\s*z\.string\(\)/);
    expect(proc!).toMatch(/\.max\(128\)/);
    expect(proc!).toMatch(/\.nullable\(\)/);
  });

  it("declares limit as bounded int [1, 1000] with default 200", () => {
    expect(proc!).toMatch(/limit:\s*z\.number\(\)\.int\(\)/);
    expect(proc!).toMatch(/\.min\(1\)/);
    expect(proc!).toMatch(/\.max\(1000\)/);
    expect(proc!).toMatch(/\.default\(200\)/);
  });

  it("delegates to getMonitoringDetailsFactsPage from the DB helper module", () => {
    expect(proc!).toMatch(/getMonitoringDetailsFactsPage/);
    expect(proc!).toMatch(
      /import\(\s*"\.\.\/db\/dashboardMonitoringDetailsFacts"\s*\)/
    );
  });

  it("derives nextCursor from the last row's systemKey when the page is full (rows.length === limit)", () => {
    // Pinning the cursor-derivation contract: client side has to
    // know that an empty page or a partial page (< limit) signals
    // end-of-stream.
    expect(proc!).toMatch(/rows\.length === input\.limit/);
    expect(proc!).toMatch(/systemKey/);
  });

  it("ships nextCursor=null AND hasMore=false at end-of-stream", () => {
    // hasMore is a derived convenience; cursor is the source of
    // truth. The two must stay in sync.
    expect(proc!).toMatch(/nextCursor\s*!==\s*null/);
    expect(proc!).toMatch(/hasMore/);
  });

  it("ships a `_runnerVersion` marker (CLAUDE.md Hard Rule #3)", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-c-3-a/);
  });

  it("ships a `_checkpoint` for cache-busting + deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint:\s*"monitoring-details-page-v1"/);
  });

  it("scopes the read by ctx.scopeId (cross-scope safety)", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("does NOT call the heavy aggregator (this proc is the OOM-safe replacement, not a wrapper)", () => {
    // Defends against a regression where someone "consolidates" by
    // calling `getOrBuildOfflineMonitoringAggregates` from this
    // proc, defeating the whole point of the fact-table migration.
    expect(proc!).not.toMatch(/getOrBuildOfflineMonitoringAggregates/);
  });
});
