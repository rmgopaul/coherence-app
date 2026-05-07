/**
 * Source-rail test for `getSystemFactsBySystemKeys`
 * (Phase 2 PR-F-4-a).
 *
 * Pins the bounded detail-sheet lookup that lets the client fetch
 * one selected system from `solarRecDashboardSystemFacts` without
 * rehydrating the legacy `getSystemSnapshot` SystemRecord[] payload.
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

describe("getSystemFactsBySystemKeys (source rail)", () => {
  const proc = sliceProcedure("getSystemFactsBySystemKeys");

  it("is registered on the dashboard router", () => {
    expect(proc).not.toBeNull();
  });

  it("uses the solar-rec-dashboard:read permission gate", () => {
    expect(proc!).toMatch(
      /dashboardProcedure\(\s*"solar-rec-dashboard",\s*"read"\s*\)/
    );
  });

  it("declares a bounded key-list input", () => {
    expect(proc!).toMatch(/systemKeys:\s*z\.array/);
    expect(proc!).toMatch(/z\.string\(\)\.min\(1\)\.max\(128\)/);
    expect(proc!).toMatch(/\.max\(25\)/);
  });

  it("delegates to getSystemFactsBySystemKeys from the DB helper module", () => {
    expect(proc!).toMatch(/getSystemFactsBySystemKeys/);
    expect(proc!).toMatch(
      /import\(\s*"\.\.\/db\/dashboardSystemFacts"\s*\)/
    );
  });

  it("deduplicates and trims requested keys before hitting the DB", () => {
    expect(proc!).toMatch(/new Set/);
    expect(proc!).toMatch(/\.trim\(\)/);
    expect(proc!).toMatch(/\.filter\(Boolean\)/);
  });

  it("scopes the read by ctx.scopeId", () => {
    expect(proc!).toMatch(/ctx\.scopeId/);
  });

  it("orders rows back to the request key order", () => {
    expect(proc!).toMatch(/new Map/);
    expect(proc!).toMatch(/rows\.sort/);
    expect(proc!).toMatch(/a\.systemKey/);
    expect(proc!).toMatch(/b\.systemKey/);
  });

  it("ships a `_runnerVersion` marker for deploy verification", () => {
    expect(proc!).toMatch(/_runnerVersion:\s*"phase-2-pr-f-4-a@1"/);
  });

  it("ships a `_checkpoint` for deploy verification", () => {
    expect(proc!).toMatch(/_checkpoint:\s*"system-facts-by-keys-v1"/);
  });

  it("does NOT call the legacy SystemRecord[] snapshot path", () => {
    expect(proc!).not.toMatch(/getOrBuildSystemSnapshot/);
    expect(proc!).not.toMatch(/getSystemSnapshot/);
  });
});
