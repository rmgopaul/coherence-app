/**
 * Source-text regression rails for the OverviewTab component.
 *
 * Strategy mirrors `dashboardMountResilience.test.ts`: read the
 * component's source verbatim and assert load-bearing textual
 * predicates. Cheap structural guards against accidental removal.
 *
 * Today's coverage is intentionally narrow — the existing
 * `dashboardMountResilience` file is the regression rail for
 * mount-tier query gates; this file covers the "Reported for
 * Current Window" tile added 2026-05-14 so a future refactor that
 * accidentally drops the tile fails immediately with a clear diff
 * against the documented contract.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OVERVIEW_TAB_FILE = resolve(__dirname, "OverviewTab.tsx");
const DASHBOARD_FILE = resolve(
  __dirname,
  "..",
  "..",
  "features",
  "solar-rec",
  "SolarRecDashboard.tsx"
);

describe("OverviewTab — Reported for Current Window tile (2026-05-14)", () => {
  it("renders a 'Reported for Current Window' CardDescription", () => {
    const source = readFileSync(OVERVIEW_TAB_FILE, "utf8");
    expect(source).toMatch(
      /<CardDescription>\s*Reported for Current Window\s*<\/CardDescription>/
    );
  });

  it("imports the reportedForCurrentWindowTile prop and renders its count via formatNumber", () => {
    const source = readFileSync(OVERVIEW_TAB_FILE, "utf8");
    // Prop is destructured from props.
    expect(source).toMatch(/reportedForCurrentWindowTile/);
    // Count goes through the standard formatter (mirrors the
    // existing "Reporting in Last 3 Months" tile).
    expect(source).toMatch(/formatNumber\(reportedForCurrentWindowTile\.count\)/);
    // Sub-label is the window's display label.
    expect(source).toMatch(/reportedForCurrentWindowTile\?\.label/);
  });

  it("does NOT touch the existing 'Reporting in Last 3 Months' tile's computation", () => {
    // The new tile is ADDITIVE — the legacy reporting tile must
    // still read from `summary.reportingSystems` /
    // `summary.reportingPercent`.
    const source = readFileSync(OVERVIEW_TAB_FILE, "utf8");
    expect(source).toMatch(
      /<CardDescription>\s*Reporting in Last 3 Months\s*<\/CardDescription>/
    );
    expect(source).toMatch(
      /formatNumber\(summary\.reportingSystems\)/
    );
    expect(source).toMatch(
      /formatPercent\(summary\.reportingPercent\)/
    );
  });
});

describe("SolarRecDashboard — wires reportedForCurrentWindowTile from slimSummary", () => {
  it("passes reportedForCurrentWindowTile prop from slimSummary.currentGatsWindow + reportedForCurrentWindow", () => {
    // The new tile is foundation-derived (slim-only) — the prop
    // must come from slimSummary, NOT from the heavy
    // overviewSummaryQuery. A future refactor that source-typos
    // either name should fail this rail.
    const source = readFileSync(DASHBOARD_FILE, "utf8");
    expect(source).toMatch(/reportedForCurrentWindowTile=\{[\s\S]{0,400}slimSummary/);
    expect(source).toMatch(/slimSummary\.currentGatsWindow\.label/);
    expect(source).toMatch(/slimSummary\.reportedForCurrentWindow/);
  });
});
