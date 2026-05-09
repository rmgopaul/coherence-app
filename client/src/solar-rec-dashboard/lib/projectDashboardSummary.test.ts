import { describe, expect, it } from "vitest";
import { pinSharedCountsToSlim } from "./projectDashboardSummary";

describe("pinSharedCountsToSlim", () => {
  it("overrides every shared count field with the slim value", () => {
    // The motivating numbers from the prod QA walk. Slim says 17,645
    // small systems; heavy says 17,705. Pin to slim so the Overview
    // tile doesn't shift after the user activates a heavy tab.
    const heavy = {
      totalSystems: 24_293,
      reportingSystems: 20_543,
      reportingPercent: 84.56,
      smallSystems: 17_705,
      largeSystems: 6_656,
      ownershipOverview: {
        terminatedTotal: 62, // heavy-only field, must survive
      },
    };
    const slim = {
      totalSystems: 24_291,
      reportingSystems: 20_518,
      reportingPercent: 84.46,
      smallSystems: 17_645,
      largeSystems: 6_646,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.totalSystems).toBe(24_291);
    expect(result.reportingSystems).toBe(20_518);
    expect(result.reportingPercent).toBe(84.46);
    expect(result.smallSystems).toBe(17_645);
    expect(result.largeSystems).toBe(6_646);
  });

  it("preserves heavy-only fields verbatim", () => {
    const heavy = {
      totalSystems: 1,
      reportingSystems: 1,
      reportingPercent: 100,
      smallSystems: 1,
      largeSystems: 0,
      ownershipOverview: {
        terminatedTotal: 99,
        otherHeavyOnlyField: { nested: "value" },
      },
      anotherHeavyExclusiveField: "preserved",
    };
    const slim = {
      totalSystems: 0,
      reportingSystems: 0,
      reportingPercent: null,
      smallSystems: 0,
      largeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.ownershipOverview).toEqual({
      terminatedTotal: 99,
      otherHeavyOnlyField: { nested: "value" },
    });
    expect(result.anotherHeavyExclusiveField).toBe("preserved");
  });

  it("preserves null reportingPercent (legitimate when totalSystems is 0)", () => {
    const heavy = {
      totalSystems: 0,
      reportingSystems: 0,
      reportingPercent: null as number | null,
      smallSystems: 0,
      largeSystems: 0,
    };
    const slim = {
      totalSystems: 0,
      reportingSystems: 0,
      reportingPercent: null as number | null,
      smallSystems: 0,
      largeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.reportingPercent).toBeNull();
  });

  it("does not mutate the input objects", () => {
    const heavy = {
      totalSystems: 100,
      reportingSystems: 80,
      reportingPercent: 80,
      smallSystems: 75,
      largeSystems: 25,
      heavyOnly: "kept",
    };
    const slim = {
      totalSystems: 99,
      reportingSystems: 79,
      reportingPercent: 79.8,
      smallSystems: 74,
      largeSystems: 25,
    };
    const heavySnapshot = JSON.stringify(heavy);
    const slimSnapshot = JSON.stringify(slim);
    pinSharedCountsToSlim(heavy, slim);
    expect(JSON.stringify(heavy)).toBe(heavySnapshot);
    expect(JSON.stringify(slim)).toBe(slimSnapshot);
  });
});
