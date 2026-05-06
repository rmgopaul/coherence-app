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
});
