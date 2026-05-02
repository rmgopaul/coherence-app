import { describe, expect, it } from "vitest";
import type { OfflineMonitoringAggregate } from "./buildOfflineMonitoringAggregates";
import type { OverviewSummaryAggregate } from "./buildOverviewSummaryAggregates";
import { projectDashboardSummary } from "./buildDashboardSummary";

function makeOverview(
  partial: Partial<OverviewSummaryAggregate> = {}
): OverviewSummaryAggregate {
  return {
    totalSystems: 100,
    reportingSystems: 80,
    reportingPercent: 0.8,
    smallSystems: 70,
    largeSystems: 25,
    unknownSizeSystems: 5,
    ownershipOverview: {
      reportingOwnershipTotal: 80,
      notTransferredReporting: 70,
      transferredReporting: 10,
      notReportingOwnershipTotal: 20,
      notTransferredNotReporting: 18,
      transferredNotReporting: 2,
      terminatedReporting: 0,
      terminatedNotReporting: 0,
      terminatedTotal: 0,
    },
    ownershipRows: [],
    withValueDataCount: 95,
    totalContractedValue: 1_000_000,
    totalDeliveredValue: 750_000,
    totalGap: 250_000,
    contractedValueReporting: 800_000,
    contractedValueNotReporting: 200_000,
    contractedValueReportingPercent: 0.8,
    deliveredValuePercent: 0.75,
    ...partial,
  };
}

function makeOfflineMonitoring(
  partial: Partial<OfflineMonitoringAggregate> = {}
): OfflineMonitoringAggregate {
  return {
    eligiblePart2ApplicationIds: ["APP-1", "APP-2", "APP-3"],
    eligiblePart2PortalSystemIds: ["PS-1", "PS-2"],
    eligiblePart2TrackingIds: ["TR-1", "TR-2", "TR-3", "TR-4"],
    abpApplicationIdBySystemKey: { "id:PS-1": "APP-1" },
    monitoringDetailsBySystemKey: {},
    abpAcSizeKwBySystemKey: {},
    abpAcSizeKwByApplicationId: {},
    abpPart2VerificationDateByApplicationId: {},
    part2VerifiedSystemIds: ["PS-1", "PS-2"],
    part2VerifiedAbpRowsCount: 4,
    abpEligibleTotalSystemsCount: 4,
    ...partial,
  };
}

describe("projectDashboardSummary", () => {
  it("forwards every overview tile-value field", () => {
    const overview = makeOverview();
    const offlineMonitoring = makeOfflineMonitoring();
    const summary = projectDashboardSummary(overview, offlineMonitoring);

    expect(summary.totalSystems).toBe(overview.totalSystems);
    expect(summary.reportingSystems).toBe(overview.reportingSystems);
    expect(summary.reportingPercent).toBe(overview.reportingPercent);
    expect(summary.smallSystems).toBe(overview.smallSystems);
    expect(summary.largeSystems).toBe(overview.largeSystems);
    expect(summary.unknownSizeSystems).toBe(overview.unknownSizeSystems);
    expect(summary.ownershipOverview).toEqual(overview.ownershipOverview);
    expect(summary.withValueDataCount).toBe(overview.withValueDataCount);
    expect(summary.totalContractedValue).toBe(overview.totalContractedValue);
    expect(summary.totalDeliveredValue).toBe(overview.totalDeliveredValue);
    expect(summary.totalGap).toBe(overview.totalGap);
    expect(summary.contractedValueReporting).toBe(
      overview.contractedValueReporting
    );
    expect(summary.contractedValueNotReporting).toBe(
      overview.contractedValueNotReporting
    );
    expect(summary.contractedValueReportingPercent).toBe(
      overview.contractedValueReportingPercent
    );
    expect(summary.deliveredValuePercent).toBe(overview.deliveredValuePercent);
  });

  it("forwards the eligibility lists + abpEligibleTotalSystemsCount", () => {
    const offlineMonitoring = makeOfflineMonitoring();
    const summary = projectDashboardSummary(makeOverview(), offlineMonitoring);

    expect(summary.eligiblePart2ApplicationIds).toBe(
      offlineMonitoring.eligiblePart2ApplicationIds
    );
    expect(summary.eligiblePart2PortalSystemIds).toBe(
      offlineMonitoring.eligiblePart2PortalSystemIds
    );
    expect(summary.eligiblePart2TrackingIds).toBe(
      offlineMonitoring.eligiblePart2TrackingIds
    );
    expect(summary.abpEligibleTotalSystemsCount).toBe(
      offlineMonitoring.abpEligibleTotalSystemsCount
    );
  });

  it("does NOT include the heavy fields from either upstream aggregate", () => {
    const overview = makeOverview({
      ownershipRows: [
        {
          key: "k",
          part2ProjectName: "p",
          part2ApplicationId: "a",
          part2SystemId: "s",
          part2TrackingId: "t",
          source: "Matched System",
          systemName: "name",
          systemId: "s",
          stateApplicationRefId: null,
          trackingSystemRefId: null,
          ownershipStatus: "Not Transferred and Reporting",
          isReporting: true,
          isTransferred: false,
          isTerminated: false,
          contractType: null,
          contractStatusText: "",
          latestReportingDate: new Date("2026-04-01"),
          contractedDate: null,
          zillowStatus: null,
          zillowSoldDate: null,
        },
      ],
    });
    const offlineMonitoring = makeOfflineMonitoring({
      abpApplicationIdBySystemKey: { "id:PS-1": "APP-1" },
      monitoringDetailsBySystemKey: {
        "id:PS-1": {
          systemId: "PS-1",
          gatsId: null,
          stateApplicationRefId: null,
          trackingSystemRefId: null,
          systemName: "n",
          monitoringPlatform: null,
          loginUrl: null,
          username: null,
          password: null,
          lastReadingDate: null,
          lastReadingKwh: null,
          contractStatusText: "",
          contractType: null,
          isReporting: true,
          isTerminated: false,
        } as OfflineMonitoringAggregate["monitoringDetailsBySystemKey"][string],
      },
    });

    const summary = projectDashboardSummary(overview, offlineMonitoring);

    // The slim shape exposes only documented fields. Asserting these
    // names are absent on the type-erased object catches accidental
    // additions.
    const summaryKeys = new Set(Object.keys(summary));
    expect(summaryKeys.has("ownershipRows")).toBe(false);
    expect(summaryKeys.has("abpApplicationIdBySystemKey")).toBe(false);
    expect(summaryKeys.has("monitoringDetailsBySystemKey")).toBe(false);
    expect(summaryKeys.has("abpAcSizeKwBySystemKey")).toBe(false);
    expect(summaryKeys.has("abpAcSizeKwByApplicationId")).toBe(false);
    expect(summaryKeys.has("abpPart2VerificationDateByApplicationId")).toBe(
      false
    );
    expect(summaryKeys.has("part2VerifiedSystemIds")).toBe(false);
  });

  it("stays under the 1 MB dashboard wire budget on prod-shaped inputs", () => {
    // Production scope today reports ~21k Part-II eligible systems
    // (per docs/triage/dashboard-502-findings.md). Generate that
    // shape and confirm the slim summary fits under 1 MB even before
    // counting superjson overhead.
    const PROD_ELIGIBLE = 21_000;
    const ids = (prefix: string) =>
      Array.from({ length: PROD_ELIGIBLE }, (_, i) => `${prefix}-${i}`);

    const overview = makeOverview({ totalSystems: PROD_ELIGIBLE });
    const offlineMonitoring = makeOfflineMonitoring({
      eligiblePart2ApplicationIds: ids("APP"),
      eligiblePart2PortalSystemIds: ids("PS"),
      eligiblePart2TrackingIds: ids("TR"),
      abpEligibleTotalSystemsCount: PROD_ELIGIBLE,
    });

    const summary = projectDashboardSummary(overview, offlineMonitoring);
    const bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");

    // 1 MB hard rule from CLAUDE.md "Wire payload contracts."
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it("returns the eligibility arrays by reference (no defensive copy)", () => {
    // The projection is a hot path on every dashboard mount; cloning
    // the 21k-element arrays would burn CPU + heap for nothing. The
    // upstream aggregate is already cached/immutable in practice.
    const overview = makeOverview();
    const offlineMonitoring = makeOfflineMonitoring();
    const summary = projectDashboardSummary(overview, offlineMonitoring);

    expect(summary.eligiblePart2ApplicationIds).toBe(
      offlineMonitoring.eligiblePart2ApplicationIds
    );
    expect(summary.ownershipOverview).toBe(overview.ownershipOverview);
  });
});
