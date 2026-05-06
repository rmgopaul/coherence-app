/**
 * Source-rail test for `getDashboardSystemsPage`
 * (Phase 2 PR-F-3).
 *
 * Pins the paginated read-proc contract for the
 * `solarRecDashboardSystemFacts` table without requiring a DB or a
 * full tRPC caller. The fact-table helper itself is covered by
 * `dashboardSystemFacts.test.ts`.
 *
 * What this rail prevents:
 *   - accidentally dropping the solar-rec-dashboard read gate
 *   - letting callers request unbounded pages
 *   - accepting filters but not forwarding them to the DB helper
 *   - wrapping the old `getOrBuildSystemSnapshot` OOM path instead
 *     of reading the derived table
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

describe("getDashboardSystemsPage (source rail)", () => {
  const proc = sliceProcedure("getDashboardSystemsPage");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares cursor as a nullable optional string with maxLength 128", () => {
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

  it("accepts the full 6-value OwnershipStatus filter", () => {
    expect(proc!).toMatch(/"Transferred and Reporting"/);
    expect(proc!).toMatch(/"Transferred and Not Reporting"/);
    expect(proc!).toMatch(/"Not Transferred and Reporting"/);
    expect(proc!).toMatch(/"Not Transferred and Not Reporting"/);
    expect(proc!).toMatch(/"Terminated and Reporting"/);
    expect(proc!).toMatch(/"Terminated and Not Reporting"/);
  });

  it("accepts the full 3-value SizeBucket filter", () => {
    expect(proc!).toMatch(/"<=10 kW AC"/);
    expect(proc!).toMatch(/">10 kW AC"/);
    expect(proc!).toMatch(/"Unknown"/);
  });

  it("declares all filters as nullable + optional", () => {
    expect(proc!).toMatch(
      /ownershipStatus:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
    expect(proc!).toMatch(
      /sizeBucket:\s*z[\s\S]*?\.nullable\(\)[\s\S]*?\.optional\(\)/
    );
    expect(proc!).toMatch(/isReporting:\s*z\.boolean\(\)\.nullable\(\)\.optional\(\)/);
    // Phase 2 PR-F-4-f-1 filter axis. `useInfiniteQuery` callers
    // pass `isPart2Eligible: true` to retire the OverviewTab's
    // parent-level `part2EligibleSystemsForSizeReporting` walk.
    expect(proc!).toMatch(
      /isPart2Eligible:\s*z\.boolean\(\)\.nullable\(\)\.optional\(\)/
    );
  });

  it("delegates to getSystemFactsPage from the DB helper module", () => {
    expect(proc!).toMatch(/getSystemFactsPage/);
    expect(proc!).toMatch(
      /import\(\s*"\.\.\/db\/dashboardSystemFacts"\s*\)/
    );
  });

  it("forwards all four filter axes to the DB helper", () => {
    expect(proc!).toMatch(/status:\s*input\.ownershipStatus\s*\?\?\s*null/);
    expect(proc!).toMatch(/sizeBucket:\s*input\.sizeBucket\s*\?\?\s*null/);
    expect(proc!).toMatch(/isReporting:\s*input\.isReporting\s*\?\?\s*null/);
    expect(proc!).toMatch(
      /isPart2Eligible:\s*input\.isPart2Eligible\s*\?\?\s*null/
    );
  });

  it("derives nextCursor from the last row's systemKey when the page is full", () => {
    expect(proc!).toMatch(/rows\.length === input\.limit/);
    expect(proc!).toMatch(/systemKey/);
  });

  it("ships nextCursor=null AND hasMore=false at end-of-stream", () => {
    expect(proc!).toMatch(/nextCursor\s*!==\s*null/);
    expect(proc!).toMatch(/hasMore/);
  });

  it("ships a `_runnerVersion` marker bumped to @2 (PR-F-4-f-1 added isPart2Eligible filter axis)", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-f-3@2"/);
  });

  it("ships a `_checkpoint` for deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint:\s*"systems-page-v1"/);
  });

  it("scopes the read by ctx.scopeId", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("does NOT call the legacy SystemRecord[] snapshot path", () => {
    expect(proc!).not.toMatch(/getOrBuildSystemSnapshot/);
  });
});
