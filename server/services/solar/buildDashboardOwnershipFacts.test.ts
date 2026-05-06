/**
 * Tests for the dashboard ownership fact-table builder
 * (Phase 2 PR-E-2).
 *
 * Two layers tested:
 *   1. Pure transformation `buildOwnershipFactRows` —
 *      OwnershipOverviewExportRow[] → fact rows. Unit tests, no
 *      mocks needed.
 *   2. Runner step + registration — uses `vi.hoisted` mocks for
 *      the DB upsert/delete helpers + the existing
 *      `getOrBuildOverviewSummary` aggregator.
 *
 * Mirrors the test infra from
 * `buildDashboardChangeOwnershipFacts.test.ts`. Two intentional
 * shape differences vs. PR-D-2:
 *   - No decimal serialization (no numeric columns on this fact
 *     table) → no `numberToDecimalString` test cases.
 *   - The `source` discriminator is the new filter axis for the
 *     OverviewTab — explicitly pinned end-to-end so a regression
 *     where the field is dropped surfaces immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertOwnershipFacts: vi.fn(),
  deleteOrphanedOwnershipFacts: vi.fn(),
  getOrBuildOverviewSummary: vi.fn(),
}));

vi.mock("../../db/dashboardOwnershipFacts", () => ({
  upsertOwnershipFacts: mocks.upsertOwnershipFacts,
  deleteOrphanedOwnershipFacts: mocks.deleteOrphanedOwnershipFacts,
  // Other exports unused by the builder; provide stubs so the
  // module's import-time evaluation doesn't break.
  getOwnershipFactsPage: vi.fn(),
  getOwnershipFactsBySystemKeys: vi.fn(),
  getOwnershipFactsCount: vi.fn(),
}));

vi.mock("./buildOverviewSummaryAggregates", async () => {
  const actual = await vi.importActual<
    typeof import("./buildOverviewSummaryAggregates")
  >("./buildOverviewSummaryAggregates");
  return {
    ...actual,
    getOrBuildOverviewSummary: mocks.getOrBuildOverviewSummary,
  };
});

import {
  __resetOwnershipBuildStepRegistrationForTests,
  buildOwnershipFactRows,
  ownershipBuildStep,
  registerOwnershipBuildStep,
} from "./buildDashboardOwnershipFacts";
import {
  getDashboardBuildSteps,
  setDashboardBuildSteps,
} from "./dashboardBuildJobRunner";
import type {
  OverviewSummaryAggregate,
  OwnershipOverviewExportRow,
} from "./buildOverviewSummaryAggregates";

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.upsertOwnershipFacts.mockResolvedValue(undefined);
  mocks.deleteOrphanedOwnershipFacts.mockResolvedValue(0);
  setDashboardBuildSteps([]);
  __resetOwnershipBuildStepRegistrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
  __resetOwnershipBuildStepRegistrationForTests();
});

// ────────────────────────────────────────────────────────────────────
// Pure transformation tests
// ────────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<OwnershipOverviewExportRow> = {}
): OwnershipOverviewExportRow {
  return {
    key: "sys-1",
    part2ProjectName: "Project Phoenix",
    part2ApplicationId: "app-100",
    part2SystemId: "p2-sys-1",
    part2TrackingId: "p2-tr-1",
    source: "Matched System",
    systemName: "Acme Solar",
    systemId: "sys-1",
    stateApplicationRefId: "state-1",
    trackingSystemRefId: "tr-1",
    ownershipStatus: "Transferred and Reporting",
    isReporting: true,
    isTransferred: true,
    isTerminated: false,
    contractType: "TURNKEY",
    contractStatusText: "Active",
    latestReportingDate: new Date("2026-04-01"),
    contractedDate: new Date("2024-01-15"),
    zillowStatus: null,
    zillowSoldDate: null,
    ...overrides,
  };
}

describe("buildOwnershipFactRows (pure transformation)", () => {
  it("returns one fact row per OwnershipOverviewExportRow", () => {
    const rows = buildOwnershipFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      rows: [makeRow({ key: "sys-a" }), makeRow({ key: "sys-b" })],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.systemKey).sort()).toEqual(["sys-a", "sys-b"]);
  });

  it("stamps every row with the supplied scopeId + buildId", () => {
    const rows = buildOwnershipFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      rows: [makeRow()],
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
  });

  it("uses OwnershipOverviewExportRow.key as the systemKey (PK)", () => {
    const rows = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ key: "custom-key-123" })],
    });
    expect(rows[0].systemKey).toBe("custom-key-123");
  });

  it("maps all 20 OwnershipOverviewExportRow fields 1:1", () => {
    const source = makeRow({
      key: "k",
      part2ProjectName: "Custom Project",
      part2ApplicationId: "p2-app-X",
      part2SystemId: "p2-sys-X",
      part2TrackingId: "p2-tr-X",
      source: "Part II Unmatched",
      systemName: "Custom Name",
      systemId: "sys-X",
      stateApplicationRefId: "state-X",
      trackingSystemRefId: "tr-X",
      ownershipStatus: "Terminated and Not Reporting",
      isReporting: false,
      isTransferred: false,
      isTerminated: true,
      contractType: "PPA",
      contractStatusText: "Pending",
      latestReportingDate: new Date("2026-04-30"),
      contractedDate: new Date("2024-06-15"),
      zillowStatus: "Sold",
      zillowSoldDate: new Date("2025-01-10"),
    });
    const [row] = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [source],
    });
    expect(row.part2ProjectName).toBe("Custom Project");
    expect(row.part2ApplicationId).toBe("p2-app-X");
    expect(row.part2SystemId).toBe("p2-sys-X");
    expect(row.part2TrackingId).toBe("p2-tr-X");
    expect(row.source).toBe("Part II Unmatched");
    expect(row.systemName).toBe("Custom Name");
    expect(row.systemId).toBe("sys-X");
    expect(row.stateApplicationRefId).toBe("state-X");
    expect(row.trackingSystemRefId).toBe("tr-X");
    expect(row.ownershipStatus).toBe("Terminated and Not Reporting");
    expect(row.isReporting).toBe(false);
    expect(row.isTransferred).toBe(false);
    expect(row.isTerminated).toBe(true);
    expect(row.contractType).toBe("PPA");
    expect(row.contractStatusText).toBe("Pending");
    expect(row.latestReportingDate).toEqual(new Date("2026-04-30"));
    expect(row.contractedDate).toEqual(new Date("2024-06-15"));
    expect(row.zillowStatus).toBe("Sold");
    expect(row.zillowSoldDate).toEqual(new Date("2025-01-10"));
  });

  it("preserves the source discriminator on EVERY row (key wiring for the OverviewTab filter)", () => {
    // The source filter is the new axis vs. PR-D-2 — defending
    // against a regression where the value gets dropped or
    // defaulted ("Matched System") and the Part II Unmatched
    // toggle silently shows the wrong rows.
    const rows = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({ key: "m-1", source: "Matched System" }),
        makeRow({ key: "u-1", source: "Part II Unmatched" }),
        makeRow({ key: "m-2", source: "Matched System" }),
      ],
    });
    expect(rows.map(r => r.source)).toEqual([
      "Matched System",
      "Part II Unmatched",
      "Matched System",
    ]);
  });

  it("passes through null nullable string fields as null", () => {
    const [row] = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          part2ApplicationId: null,
          part2SystemId: null,
          part2TrackingId: null,
          systemId: null,
          stateApplicationRefId: null,
          trackingSystemRefId: null,
          contractType: null,
          zillowStatus: null,
        }),
      ],
    });
    expect(row.part2ApplicationId).toBeNull();
    expect(row.part2SystemId).toBeNull();
    expect(row.part2TrackingId).toBeNull();
    expect(row.systemId).toBeNull();
    expect(row.stateApplicationRefId).toBeNull();
    expect(row.trackingSystemRefId).toBeNull();
    expect(row.contractType).toBeNull();
    expect(row.zillowStatus).toBeNull();
  });

  it("passes through null Dates as null", () => {
    const [row] = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          latestReportingDate: null,
          contractedDate: null,
          zillowSoldDate: null,
        }),
      ],
    });
    expect(row.latestReportingDate).toBeNull();
    expect(row.contractedDate).toBeNull();
    expect(row.zillowSoldDate).toBeNull();
  });

  it("preserves boolean false (not coerced/dropped)", () => {
    const [row] = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          isReporting: false,
          isTransferred: false,
          isTerminated: false,
        }),
      ],
    });
    expect(row.isReporting).toBe(false);
    expect(row.isTransferred).toBe(false);
    expect(row.isTerminated).toBe(false);
  });

  it("returns [] when the input rows array is empty", () => {
    const rows = buildOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [],
    });
    expect(rows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Runner-step orchestration tests
// ────────────────────────────────────────────────────────────────────

function makeAggregate(): OverviewSummaryAggregate {
  return {
    totalSystems: 2,
    reportingSystems: 2,
    reportingPercent: 100,
    smallSystems: 1,
    largeSystems: 1,
    unknownSizeSystems: 0,
    ownershipOverview: {
      reportingOwnershipTotal: 2,
      notTransferredReporting: 0,
      transferredReporting: 2,
      notReportingOwnershipTotal: 0,
      notTransferredNotReporting: 0,
      transferredNotReporting: 0,
      terminatedReporting: 0,
      terminatedNotReporting: 0,
      terminatedTotal: 0,
    },
    ownershipRows: [
      makeRow({ key: "sys-1" }),
      makeRow({ key: "sys-2", source: "Part II Unmatched" }),
    ],
    withValueDataCount: 2,
    totalContractedValue: 50000,
    totalDeliveredValue: 25000,
    totalGap: 25000,
    contractedValueReporting: 50000,
    contractedValueNotReporting: 0,
    contractedValueReportingPercent: 100,
    deliveredValuePercent: 50,
  };
}

describe("ownershipBuildStep — orchestration", () => {
  it("aggregator → upsert → orphan-sweep order with correct args", async () => {
    mocks.getOrBuildOverviewSummary.mockResolvedValue({
      result: makeAggregate(),
      fromCache: false,
    });
    mocks.deleteOrphanedOwnershipFacts.mockResolvedValue(7);

    await ownershipBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.getOrBuildOverviewSummary).toHaveBeenCalledWith("scope-A");
    expect(mocks.upsertOwnershipFacts).toHaveBeenCalledTimes(1);
    const [upsertedRows] = mocks.upsertOwnershipFacts.mock.calls[0];
    expect(upsertedRows).toHaveLength(2);
    expect(upsertedRows[0].buildId).toBe("bld-1");
    expect(upsertedRows[0].scopeId).toBe("scope-A");
    // Source discriminator round-trips through the runner.
    expect(upsertedRows[0].source).toBe("Matched System");
    expect(upsertedRows[1].source).toBe("Part II Unmatched");
    expect(mocks.deleteOrphanedOwnershipFacts).toHaveBeenCalledWith(
      "scope-A",
      "bld-1"
    );
    // Order check: upsert BEFORE orphan-sweep.
    const upsertOrder =
      mocks.upsertOwnershipFacts.mock.invocationCallOrder[0];
    const sweepOrder =
      mocks.deleteOrphanedOwnershipFacts.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(sweepOrder);
  });

  it("propagates upsert failures (runner converts to errorMessage)", async () => {
    mocks.getOrBuildOverviewSummary.mockResolvedValue({
      result: makeAggregate(),
      fromCache: false,
    });
    mocks.upsertOwnershipFacts.mockRejectedValue(new Error("upsert blew up"));

    await expect(
      ownershipBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/upsert blew up/);
    expect(mocks.deleteOrphanedOwnershipFacts).not.toHaveBeenCalled();
  });

  it("aborts before aggregate fetch when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ownershipBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.getOrBuildOverviewSummary).not.toHaveBeenCalled();
    expect(mocks.upsertOwnershipFacts).not.toHaveBeenCalled();
  });

  it("handles an empty ownershipRows aggregate (no abpReport on prod)", async () => {
    // The aggregator returns EMPTY_SUMMARY when no abpReport exists;
    // the step must still run upsert([]) + orphan-sweep so a stale
    // fact-table row from a previous build with content gets cleaned.
    mocks.getOrBuildOverviewSummary.mockResolvedValue({
      result: { ...makeAggregate(), ownershipRows: [] },
      fromCache: false,
    });

    await ownershipBuildStep.run({
      scopeId: "s",
      buildId: "b",
      signal: new AbortController().signal,
    });

    expect(mocks.upsertOwnershipFacts).toHaveBeenCalledWith([]);
    expect(mocks.deleteOrphanedOwnershipFacts).toHaveBeenCalledWith("s", "b");
  });
});

// ────────────────────────────────────────────────────────────────────
// Step registration
// ────────────────────────────────────────────────────────────────────

describe("registerOwnershipBuildStep", () => {
  it("appends the step to the runner's empty steps array on first call", async () => {
    expect(getDashboardBuildSteps()).toEqual([]);
    await registerOwnershipBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("ownershipFacts");
    expect(steps[0]).toBe(ownershipBuildStep);
  });

  it("is idempotent: subsequent calls do NOT duplicate the step", async () => {
    await registerOwnershipBuildStep();
    await registerOwnershipBuildStep();
    await registerOwnershipBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });

  it("preserves prior steps already in the array (e.g. monitoringDetails + changeOwnership)", async () => {
    const monitoringStep = {
      name: "monitoringDetailsFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    const changeOwnershipStep = {
      name: "changeOwnershipFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([monitoringStep, changeOwnershipStep]);
    await registerOwnershipBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(3);
    expect(steps[0]).toBe(monitoringStep);
    expect(steps[1]).toBe(changeOwnershipStep);
    expect(steps[2].name).toBe("ownershipFacts");
  });

  it("does NOT re-append when a step with the same name is already in the array", async () => {
    setDashboardBuildSteps([
      {
        name: "ownershipFacts",
        run: async () => {},
      },
    ]);
    await registerOwnershipBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });
});
