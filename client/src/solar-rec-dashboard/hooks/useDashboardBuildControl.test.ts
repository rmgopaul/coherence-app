import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTerminalDashboardBuildStatus } from "../lib/dashboardBuildStatus";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("isTerminalDashboardBuildStatus", () => {
  it("matches the server build-job terminal states", () => {
    expect(isTerminalDashboardBuildStatus("succeeded")).toBe(true);
    expect(isTerminalDashboardBuildStatus("failed")).toBe(true);
    expect(isTerminalDashboardBuildStatus("notFound")).toBe(true);
    expect(isTerminalDashboardBuildStatus("queued")).toBe(false);
    expect(isTerminalDashboardBuildStatus("running")).toBe(false);
    expect(isTerminalDashboardBuildStatus(null)).toBe(false);
  });
});

describe("fact-backed tab build controls", () => {
  it("keeps fact-backed tabs on the shared build control hook", () => {
    const ownershipTab = readSource("../components/OwnershipTab.tsx");
    const changeOwnershipTab = readSource(
      "../components/ChangeOwnershipTab.tsx",
    );
    const offlineMonitoringTab = readSource(
      "../components/OfflineMonitoringTab.tsx",
    );
    const comparisonsTab = readSource("../components/ComparisonsTab.tsx");

    expect(ownershipTab).toMatch(/useDashboardBuildControl/);
    expect(ownershipTab).not.toMatch(/startDashboardBuild\.useMutation/);

    expect(changeOwnershipTab).toMatch(/useDashboardBuildControl/);
    expect(changeOwnershipTab).toMatch(
      /getDashboardChangeOwnershipPage\.invalidate/,
    );
    expect(changeOwnershipTab).toMatch(/Rebuild table/);

    expect(offlineMonitoringTab).toMatch(/useDashboardBuildControl/);
    expect(offlineMonitoringTab).toMatch(
      /getDashboardMonitoringDetailsPage\.invalidate/,
    );
    expect(offlineMonitoringTab).toMatch(/Rebuild table/);

    expect(comparisonsTab).toMatch(/useDashboardBuildControl/);
    expect(comparisonsTab).toMatch(/getDashboardSystemsPage\.invalidate/);
    expect(comparisonsTab).toMatch(/Rebuild table/);
  });

  // 2026-05-13 — pin the inline build-progress bar in every tab
  // that has a "Rebuild table" button. Pre-fix the button showed
  // a flat "Building…" string while the server actually emitted
  // per-step progress (currentStep / totalSteps / percent /
  // message / factTable) — the data was there, the UI wasn't.
  // Adding `<DashboardBuildProgressBar>` below each button
  // surfaces the real progress. This rail ensures a future
  // refactor doesn't silently drop the mount + the user goes
  // back to the flat placeholder.
  it("each rebuild-capable tab mounts <DashboardBuildProgressBar>", () => {
    const tabs = [
      "../components/AlertsTab.tsx",
      "../components/ChangeOwnershipTab.tsx",
      "../components/ComparisonsTab.tsx",
      "../components/OfflineMonitoringTab.tsx",
      "../components/OwnershipTab.tsx",
    ];
    for (const tabPath of tabs) {
      const code = readSource(tabPath);
      expect(code, `${tabPath} should import the progress bar`).toMatch(
        /import\s+\{\s*DashboardBuildProgressBar\s*\}/,
      );
      // Tightened from /buildProgress,/ — that pattern broke if
      // Prettier reformatted the destructure to put `buildProgress`
      // last (no trailing comma without `trailingComma: all`). The
      // word-boundary form survives any ordering.
      expect(code, `${tabPath} should destructure buildProgress`).toMatch(
        /\bbuildProgress\b/,
      );
      expect(code, `${tabPath} should mount the bar JSX`).toMatch(
        /<DashboardBuildProgressBar/,
      );
    }
  });
});
