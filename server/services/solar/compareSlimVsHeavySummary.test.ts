import { describe, expect, it } from "vitest";
import {
  compareSlimVsHeavySummary,
  type DriftDiagnosticInput,
  type SharedCountSnapshot,
} from "./compareSlimVsHeavySummary";

const ZERO: SharedCountSnapshot = {
  totalSystems: 0,
  reportingSystems: 0,
  smallSystems: 0,
  largeSystems: 0,
  unknownSizeSystems: 0,
};

function input(
  overrides: Partial<DriftDiagnosticInput> = {}
): DriftDiagnosticInput {
  return {
    slim: ZERO,
    heavy: ZERO,
    unmatchedPart2AbpProjectCount: 0,
    sizeBucketMismatchCount: 0,
    reportingFlagMismatchCount: 0,
    ...overrides,
  };
}

describe("compareSlimVsHeavySummary — no drift", () => {
  it("returns the no-drift verdict when slim equals heavy on every field", () => {
    const equal: SharedCountSnapshot = {
      totalSystems: 1000,
      reportingSystems: 800,
      smallSystems: 750,
      largeSystems: 240,
      unknownSizeSystems: 10,
    };
    const result = compareSlimVsHeavySummary(input({ slim: equal, heavy: equal }));
    expect(result.verdict).toBe("no-drift");
    expect(result.totalAbsoluteDrift).toBe(0);
    expect(result.evidence).toEqual({
      unmatchedAbpRowsExplains: 0,
      staleSnapshotBucketsExplains: 0,
      reportingFlagMismatchesExplains: 0,
    });
  });
});

describe("compareSlimVsHeavySummary — primary verdicts", () => {
  it("identifies `primary:unmatched-abp-rows` for the prod-walk shape (heavy +60 / +25)", () => {
    // The motivating case from the 2026-05-09 prod walk. Slim
    // says totalSystems=24291, reportingSystems=20518; heavy
    // says totalSystems=24291+60, reportingSystems=20518+25.
    // Hypothesis: ~60 unmatched Part-II ABP rows in the active
    // batch produce the +60 totalSystems delta. The +25 on
    // reportingSystems is a SEPARATE mechanism (likely reporting-
    // flag mismatch on matched systems); unmatched rows alone
    // can't drive a positive reportingSystems delta because the
    // heavy aggregator routes them to `notTransferredNotReporting`,
    // which is not summed into `reportingSystems`.
    //
    // Post-remediation evidence math: unmatched explains the +60
    // totalSystems delta only (not the +25 reporting). The
    // remaining 25 units of drift are unaccounted (no reporting-
    // flag mismatch count provided here), so the verdict still
    // resolves to `primary:unmatched-abp-rows` (60/85 ≈ 70.6% > 50%
    // threshold) but the evidence doesn't over-attribute.
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 24_291,
          reportingSystems: 20_518,
          smallSystems: 17_645,
          largeSystems: 6_646,
          unknownSizeSystems: 0,
        },
        heavy: {
          totalSystems: 24_351, // +60
          reportingSystems: 20_543, // +25
          smallSystems: 17_645, // unchanged (size buckets are scoped, unmatched rows excluded)
          largeSystems: 6_646,
          unknownSizeSystems: 0,
        },
        unmatchedPart2AbpProjectCount: 60,
      })
    );
    expect(result.verdict).toBe("primary:unmatched-abp-rows");
    // Post-remediation: 60 (just the totalSystems delta), not 85
    // (which double-counted the +25 reportingSystems delta).
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(60);
    expect(result.evidence.reportingFlagMismatchesExplains).toBe(0);
    expect(result.totalAbsoluteDrift).toBe(85);
    expect(result.verdictNote).toContain("60 Part-II ABP rows");
  });

  it("does NOT attribute reportingSystems drift to unmatched ABP rows (mechanism direction guard)", () => {
    // Pre-remediation pre-fix the formula was `min(N,
    // |totalSystems delta|) + min(N, |reportingSystems delta|)`,
    // which falsely credited unmatched rows for ANY reporting
    // delta. Heavy's `reportingSystems = notTransferredReporting +
    // transferredReporting + terminatedReporting` formula doesn't
    // include unmatched rows (they go to
    // `notTransferredNotReporting`), so unmatched alone cannot
    // drive a positive reportingSystems delta. Test pins the
    // direction guard.
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 100,
          reportingSystems: 60, // 60 of 100 reporting
          smallSystems: 80,
          largeSystems: 20,
          unknownSizeSystems: 0,
        },
        heavy: {
          totalSystems: 100,
          reportingSystems: 70, // +10 reporting (NOT from unmatched)
          smallSystems: 80,
          largeSystems: 20,
          unknownSizeSystems: 0,
        },
        unmatchedPart2AbpProjectCount: 30, // even with high count
      })
    );
    // No totalSystems delta → unmatched explains 0.
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(0);
  });

  it("does NOT double-count when both unmatched and reportingFlag mechanisms have non-zero counts", () => {
    // Pre-remediation pre-fix BOTH mechanisms claimed a slice of
    // the reportingSystems delta, so `explainedTotal` could
    // exceed `totalAbsoluteDrift` and ratios could exceed 1.0.
    // Post-remediation: unmatched is confined to totalSystems;
    // reportingFlag is confined to reportingSystems.
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 100,
          reportingSystems: 80,
          smallSystems: 70,
          largeSystems: 30,
          unknownSizeSystems: 0,
        },
        heavy: {
          totalSystems: 110, // +10 (from 10 unmatched)
          reportingSystems: 75, // -5 (from 5 reporting-flag flips)
          smallSystems: 70,
          largeSystems: 30,
          unknownSizeSystems: 0,
        },
        unmatchedPart2AbpProjectCount: 10,
        reportingFlagMismatchCount: 5,
      })
    );
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(10);
    expect(result.evidence.reportingFlagMismatchesExplains).toBe(5);
    // Strict invariant: explainedTotal ≤ totalAbsoluteDrift.
    const explainedTotal =
      result.evidence.unmatchedAbpRowsExplains +
      result.evidence.staleSnapshotBucketsExplains +
      result.evidence.reportingFlagMismatchesExplains;
    expect(explainedTotal).toBeLessThanOrEqual(result.totalAbsoluteDrift);
  });

  it("identifies `primary:stale-snapshot-buckets` when only size buckets diverge", () => {
    // 30 systems have stale sizeBucket: snapshot says <=10 kW
    // but live row says >10 kW. Each contributes -1 to small
    // and +1 to large = 2 units of absolute drift per
    // mismatch. Total = 60 units.
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 1000,
          reportingSystems: 800,
          smallSystems: 700,
          largeSystems: 280,
          unknownSizeSystems: 20,
        },
        heavy: {
          totalSystems: 1000,
          reportingSystems: 800,
          smallSystems: 730, // +30 (snapshot's stale view)
          largeSystems: 250, // -30
          unknownSizeSystems: 20,
        },
        sizeBucketMismatchCount: 30,
      })
    );
    expect(result.verdict).toBe("primary:stale-snapshot-buckets");
    expect(result.evidence.staleSnapshotBucketsExplains).toBe(60);
    expect(result.totalAbsoluteDrift).toBe(60);
    expect(result.verdictNote).toContain("rebuild the system snapshot");
  });

  it("identifies `primary:reporting-flag-mismatch` when only reportingSystems diverges", () => {
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 1000,
          reportingSystems: 800,
          smallSystems: 750,
          largeSystems: 240,
          unknownSizeSystems: 10,
        },
        heavy: {
          totalSystems: 1000,
          reportingSystems: 815, // +15
          smallSystems: 750,
          largeSystems: 240,
          unknownSizeSystems: 10,
        },
        reportingFlagMismatchCount: 15,
      })
    );
    expect(result.verdict).toBe("primary:reporting-flag-mismatch");
    expect(result.evidence.reportingFlagMismatchesExplains).toBe(15);
    expect(result.totalAbsoluteDrift).toBe(15);
  });
});

describe("compareSlimVsHeavySummary — compound + unexplained verdicts", () => {
  it("identifies `compound:multiple-mechanisms` when no single mechanism explains a majority", () => {
    // 30 unmatched ABP rows AND 15 stale-snapshot bucket mismatches.
    // Total drift = 30 (totalSystems) + 30 (size buckets, 2 per
    // mismatch × 15 mismatches) = 60 units.
    // Unmatched explains 30 / 60 = 50% (NOT majority — strict >).
    // Snapshot explains 30 / 60 = 50%. Compound.
    const result = compareSlimVsHeavySummary(
      input({
        slim: {
          totalSystems: 1000,
          reportingSystems: 800,
          smallSystems: 700,
          largeSystems: 290,
          unknownSizeSystems: 10,
        },
        heavy: {
          totalSystems: 1030, // +30
          reportingSystems: 800,
          smallSystems: 715, // +15
          largeSystems: 275, // -15
          unknownSizeSystems: 10,
        },
        unmatchedPart2AbpProjectCount: 30,
        sizeBucketMismatchCount: 15,
      })
    );
    expect(result.verdict).toBe("compound:multiple-mechanisms");
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(30);
    expect(result.evidence.staleSnapshotBucketsExplains).toBe(30);
    expect(result.totalAbsoluteDrift).toBe(60);
  });

  it("identifies `unexplained` when none of the tracked mechanisms account for the drift", () => {
    // 50 units of drift but all 3 mechanism counts are 0.
    const result = compareSlimVsHeavySummary(
      input({
        slim: { ...ZERO, totalSystems: 100 },
        heavy: { ...ZERO, totalSystems: 150 },
        // All mechanism counts default to 0
      })
    );
    expect(result.verdict).toBe("unexplained");
    expect(result.totalAbsoluteDrift).toBe(50);
    expect(result.verdictNote).toContain("totalSystems=+50");
  });

  it("identifies `unexplained` when tracked mechanisms only account for a minority of drift", () => {
    // 100 units of drift but only 5 tracked
    const result = compareSlimVsHeavySummary(
      input({
        slim: { ...ZERO, totalSystems: 100, reportingSystems: 80 },
        heavy: { ...ZERO, totalSystems: 200, reportingSystems: 80 },
        unmatchedPart2AbpProjectCount: 5,
      })
    );
    expect(result.verdict).toBe("unexplained");
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(5);
    expect(result.totalAbsoluteDrift).toBe(100);
  });
});

describe("compareSlimVsHeavySummary — evidence accounting", () => {
  it("caps unmatchedAbpRowsExplains at the actual delta (cannot over-attribute)", () => {
    // 100 unmatched rows reported, but heavy.totalSystems is only +30
    // higher than slim. The mechanism cannot explain more than the
    // actual delta — cap at min(unmatchedCount, |delta|).
    const result = compareSlimVsHeavySummary(
      input({
        slim: { ...ZERO, totalSystems: 100 },
        heavy: { ...ZERO, totalSystems: 130 },
        unmatchedPart2AbpProjectCount: 100,
      })
    );
    expect(result.evidence.unmatchedAbpRowsExplains).toBe(30);
  });

  it("each size-bucket mismatch contributes 2 to absolute drift (one bucket -1, another +1)", () => {
    // 10 mismatches → 20 units of bucket absolute drift if all
    // distribute evenly across +/- on different buckets.
    const result = compareSlimVsHeavySummary(
      input({
        slim: { ...ZERO, smallSystems: 100, largeSystems: 100 },
        heavy: { ...ZERO, smallSystems: 110, largeSystems: 90 }, // +10/-10 = 20 abs
        sizeBucketMismatchCount: 10,
      })
    );
    expect(result.evidence.staleSnapshotBucketsExplains).toBe(20);
  });
});
