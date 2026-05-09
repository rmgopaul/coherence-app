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
      unknownSizeSystems: 12,
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
      unknownSizeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.totalSystems).toBe(24_291);
    expect(result.reportingSystems).toBe(20_518);
    expect(result.reportingPercent).toBe(84.46);
    expect(result.smallSystems).toBe(17_645);
    expect(result.largeSystems).toBe(6_646);
    // 2026-05-09 follow-up: `unknownSizeSystems` is also a shared
    // field. Pinning it forecloses the same drift on that tile.
    expect(result.unknownSizeSystems).toBe(0);
  });

  it("preserves heavy-only fields verbatim", () => {
    const heavy = {
      totalSystems: 1,
      reportingSystems: 1,
      reportingPercent: 100,
      smallSystems: 1,
      largeSystems: 0,
      unknownSizeSystems: 0,
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
      unknownSizeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.ownershipOverview).toEqual({
      terminatedTotal: 99,
      otherHeavyOnlyField: { nested: "value" },
    });
    expect(result.anotherHeavyExclusiveField).toBe("preserved");
  });

  it("preserves caller-supplied tag fields (e.g. `kind` discriminator)", () => {
    // The parent's `summary` memo wraps the helper output as
    // `{...heavy, kind: "heavy"}` then runs `pinSharedCountsToSlim`.
    // Tag fields like `kind` MUST survive the pin so downstream
    // consumers that narrow on the discriminated union still
    // resolve correctly.
    const heavy = {
      totalSystems: 100,
      reportingSystems: 80,
      reportingPercent: 80,
      smallSystems: 75,
      largeSystems: 25,
      unknownSizeSystems: 0,
      kind: "heavy" as const,
      heavyOnly: { details: true },
    };
    const slim = {
      totalSystems: 99,
      reportingSystems: 79,
      reportingPercent: 79.8,
      smallSystems: 74,
      largeSystems: 25,
      unknownSizeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.kind).toBe("heavy");
    expect(result.heavyOnly).toEqual({ details: true });
  });

  it("preserves null reportingPercent (legitimate when totalSystems is 0)", () => {
    const heavy = {
      totalSystems: 0,
      reportingSystems: 0,
      reportingPercent: null as number | null,
      smallSystems: 0,
      largeSystems: 0,
      unknownSizeSystems: 0,
    };
    const slim = {
      totalSystems: 0,
      reportingSystems: 0,
      reportingPercent: null as number | null,
      smallSystems: 0,
      largeSystems: 0,
      unknownSizeSystems: 0,
    };
    const result = pinSharedCountsToSlim(heavy, slim);
    expect(result.reportingPercent).toBeNull();
  });

  it("is functionally a no-op when slim values equal heavy values", () => {
    // Sanity guard for the equal-values case. The override still
    // happens; the test confirms the result equals heavy.
    const sharedCounts = {
      totalSystems: 1000,
      reportingSystems: 800,
      reportingPercent: 80,
      smallSystems: 700,
      largeSystems: 300,
      unknownSizeSystems: 0,
    };
    const heavy = {
      ...sharedCounts,
      ownershipOverview: { terminatedTotal: 5 },
    };
    const result = pinSharedCountsToSlim(heavy, sharedCounts);
    expect(result).toEqual(heavy);
  });

  it("does not mutate the input objects", () => {
    const heavy = {
      totalSystems: 100,
      reportingSystems: 80,
      reportingPercent: 80,
      smallSystems: 75,
      largeSystems: 25,
      unknownSizeSystems: 0,
      heavyOnly: "kept",
    };
    const slim = {
      totalSystems: 99,
      reportingSystems: 79,
      reportingPercent: 79.8,
      smallSystems: 74,
      largeSystems: 25,
      unknownSizeSystems: 0,
    };
    const heavySnapshot = JSON.stringify(heavy);
    const slimSnapshot = JSON.stringify(slim);
    pinSharedCountsToSlim(heavy, slim);
    expect(JSON.stringify(heavy)).toBe(heavySnapshot);
    expect(JSON.stringify(slim)).toBe(slimSnapshot);
  });
});
