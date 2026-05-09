import { describe, expect, it } from "vitest";
import { deriveSnapshotPart2ValueSummary } from "./snapshotPart2ValueSummary";

describe("deriveSnapshotPart2ValueSummary", () => {
  it("prefers slim values when present (Bug #4 + #7 fix path)", () => {
    // The motivating cases from the prod QA walk:
    //   Bug #4: pages stream in → row-walk total cycles
    //     $67M → $253M → $478M
    //   Bug #7: row-walk total ($478,105,589.58) drifts from
    //     slim ($478,195,793.54) by ~$90K
    // Slim must win in both cases so all tabs read the same value.
    const result = deriveSnapshotPart2ValueSummary({
      slim: {
        totalContractedValue: 478_195_793.54,
        contractedValueReporting: 400_000_000,
        contractedValueNotReporting: 78_195_793.54,
        contractedValueReportingPercent: 83.65,
      },
      rowWalk: {
        // Mid-stream partial sum that pre-fix would have leaked into
        // the header. With the slim-preference path this is ignored.
        totalContractedValue: 67_008_912.09,
        contractedValueReporting: 50_000_000,
        contractedValueNotReporting: 17_008_912.09,
        contractedValueReportingPercent: 74.6,
      },
      totalDeliveredValue: 100_000_000,
    });
    expect(result.totalContractedValue).toBe(478_195_793.54);
    expect(result.contractedValueReporting).toBe(400_000_000);
    expect(result.contractedValueNotReporting).toBe(78_195_793.54);
    expect(result.contractedValueReportingPercent).toBe(83.65);
  });

  it("computes totalGap from the slim totalContractedValue minus the row-walk delivered value", () => {
    const result = deriveSnapshotPart2ValueSummary({
      slim: {
        totalContractedValue: 500_000_000,
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      rowWalk: {
        totalContractedValue: 1, // ignored
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      totalDeliveredValue: 200_000_000,
    });
    expect(result.totalGap).toBe(300_000_000);
  });

  it("falls back to row-walk when slim is null (cold-mount window)", () => {
    // Before `dashboardSummaryQuery` resolves on cold mount, the
    // slim summary is null. The row-walk fallback keeps the helper
    // callable in that window — its values may be partial during
    // the page walk, but the user-visible cold-mount window is on
    // the order of milliseconds (slim is cached server-side).
    const result = deriveSnapshotPart2ValueSummary({
      slim: null,
      rowWalk: {
        totalContractedValue: 67_008_912.09,
        contractedValueReporting: 50_000_000,
        contractedValueNotReporting: 17_008_912.09,
        contractedValueReportingPercent: 74.6,
      },
      totalDeliveredValue: 25_000_000,
    });
    expect(result.totalContractedValue).toBe(67_008_912.09);
    expect(result.contractedValueReporting).toBe(50_000_000);
    expect(result.contractedValueNotReporting).toBe(17_008_912.09);
    expect(result.contractedValueReportingPercent).toBe(74.6);
    expect(result.totalGap).toBe(67_008_912.09 - 25_000_000);
  });

  it("preserves null for `contractedValueReportingPercent` when total is 0", () => {
    // Edge case from buildSlimDashboardSummary — when there are no
    // value rows, the percent is `null` (not 0). The helper passes
    // null through unchanged.
    const result = deriveSnapshotPart2ValueSummary({
      slim: {
        totalContractedValue: 0,
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      rowWalk: {
        totalContractedValue: 0,
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      totalDeliveredValue: 0,
    });
    expect(result.contractedValueReportingPercent).toBeNull();
    expect(result.totalGap).toBe(0);
  });

  it("totalDeliveredValue is always passed through verbatim (not in slim)", () => {
    const result = deriveSnapshotPart2ValueSummary({
      slim: {
        totalContractedValue: 478_000_000,
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      rowWalk: {
        totalContractedValue: 0,
        contractedValueReporting: 0,
        contractedValueNotReporting: 0,
        contractedValueReportingPercent: null,
      },
      totalDeliveredValue: 12_345_678.99,
    });
    expect(result.totalDeliveredValue).toBe(12_345_678.99);
  });
});
