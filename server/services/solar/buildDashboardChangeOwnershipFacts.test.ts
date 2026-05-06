/**
 * Tests for the dashboard changeOwnership fact-table builder
 * (Phase 2 PR-D-2).
 *
 * Two layers tested:
 *   1. Pure transformation `buildChangeOwnershipFactRows` —
 *      ChangeOwnershipExportRow[] → fact rows. Unit tests, no
 *      mocks needed.
 *   2. Runner step + registration — uses `vi.hoisted` mocks for
 *      the DB upsert/delete helpers + the existing
 *      `getOrBuildChangeOwnership` aggregator.
 *
 * Mirrors the test infra from
 * `buildDashboardMonitoringDetailsFacts.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertChangeOwnershipFacts: vi.fn(),
  deleteOrphanedChangeOwnershipFacts: vi.fn(),
  getOrBuildChangeOwnership: vi.fn(),
}));

vi.mock("../../db/dashboardChangeOwnershipFacts", () => ({
  upsertChangeOwnershipFacts: mocks.upsertChangeOwnershipFacts,
  deleteOrphanedChangeOwnershipFacts:
    mocks.deleteOrphanedChangeOwnershipFacts,
  // Other exports unused by the builder; provide stubs.
  getChangeOwnershipFactsPage: vi.fn(),
  getChangeOwnershipFactsBySystemKeys: vi.fn(),
  getChangeOwnershipFactsCount: vi.fn(),
}));

vi.mock("./buildChangeOwnershipAggregates", async () => {
  const actual = await vi.importActual<
    typeof import("./buildChangeOwnershipAggregates")
  >("./buildChangeOwnershipAggregates");
  return {
    ...actual,
    getOrBuildChangeOwnership: mocks.getOrBuildChangeOwnership,
  };
});

import {
  __resetChangeOwnershipBuildStepRegistrationForTests,
  buildChangeOwnershipFactRows,
  changeOwnershipBuildStep,
  registerChangeOwnershipBuildStep,
} from "./buildDashboardChangeOwnershipFacts";
import {
  getDashboardBuildSteps,
  setDashboardBuildSteps,
} from "./dashboardBuildJobRunner";
import type { ChangeOwnershipExportRow } from "./buildChangeOwnershipAggregates";

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.upsertChangeOwnershipFacts.mockResolvedValue(undefined);
  mocks.deleteOrphanedChangeOwnershipFacts.mockResolvedValue(0);
  setDashboardBuildSteps([]);
  __resetChangeOwnershipBuildStepRegistrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
  __resetChangeOwnershipBuildStepRegistrationForTests();
});

// ────────────────────────────────────────────────────────────────────
// Pure transformation tests
// ────────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<ChangeOwnershipExportRow> = {}
): ChangeOwnershipExportRow {
  return {
    key: "sys-1",
    systemName: "Acme Solar",
    systemId: "sys-1",
    trackingSystemRefId: "tr-1",
    installedKwAc: 7.5,
    contractType: "TURNKEY",
    contractStatusText: "Active",
    contractedDate: new Date("2024-01-15"),
    zillowStatus: null,
    zillowSoldDate: null,
    latestReportingDate: new Date("2026-04-01"),
    changeOwnershipStatus: "Transferred and Reporting",
    ownershipStatus: "Transferred and Reporting",
    isReporting: true,
    isTerminated: false,
    isTransferred: true,
    hasChangedOwnership: true,
    totalContractAmount: 50000.5,
    contractedValue: 25000,
    ...overrides,
  };
}

describe("buildChangeOwnershipFactRows (pure transformation)", () => {
  it("returns one fact row per ChangeOwnershipExportRow", () => {
    const rows = buildChangeOwnershipFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      rows: [makeRow({ key: "sys-a" }), makeRow({ key: "sys-b" })],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.systemKey).sort()).toEqual(["sys-a", "sys-b"]);
  });

  it("stamps every row with the supplied scopeId + buildId", () => {
    const rows = buildChangeOwnershipFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      rows: [makeRow()],
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
  });

  it("uses ChangeOwnershipExportRow.key as the systemKey (PK)", () => {
    const rows = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ key: "custom-key-123" })],
    });
    expect(rows[0].systemKey).toBe("custom-key-123");
  });

  it("maps all 19 ChangeOwnershipExportRow fields 1:1", () => {
    const source = makeRow({
      key: "k",
      systemName: "Custom Name",
      systemId: "sys-X",
      trackingSystemRefId: "tr-X",
      installedKwAc: 5.123,
      contractType: "PPA",
      contractStatusText: "Pending",
      contractedDate: new Date("2024-06-15"),
      zillowStatus: "Sold",
      zillowSoldDate: new Date("2025-01-10"),
      latestReportingDate: new Date("2026-04-30"),
      changeOwnershipStatus: "Terminated and Not Reporting",
      ownershipStatus: "Terminated and Not Reporting",
      isReporting: false,
      isTerminated: true,
      isTransferred: false,
      hasChangedOwnership: false,
      totalContractAmount: 12345.6789,
      contractedValue: 9876.5432,
    });
    const [row] = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [source],
    });
    expect(row.systemName).toBe("Custom Name");
    expect(row.systemId).toBe("sys-X");
    expect(row.trackingSystemRefId).toBe("tr-X");
    expect(row.contractType).toBe("PPA");
    expect(row.contractStatusText).toBe("Pending");
    expect(row.contractedDate).toEqual(new Date("2024-06-15"));
    expect(row.zillowStatus).toBe("Sold");
    expect(row.zillowSoldDate).toEqual(new Date("2025-01-10"));
    expect(row.latestReportingDate).toEqual(new Date("2026-04-30"));
    expect(row.changeOwnershipStatus).toBe("Terminated and Not Reporting");
    expect(row.ownershipStatus).toBe("Terminated and Not Reporting");
    expect(row.isReporting).toBe(false);
    expect(row.isTerminated).toBe(true);
    expect(row.isTransferred).toBe(false);
    expect(row.hasChangedOwnership).toBe(false);
  });

  it("converts numeric decimals to string form (Drizzle decimal contract)", () => {
    const [row] = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: 7.5,
          totalContractAmount: 50000.5,
          contractedValue: 25000,
        }),
      ],
    });
    expect(row.installedKwAc).toBe("7.5");
    expect(row.totalContractAmount).toBe("50000.5");
    expect(row.contractedValue).toBe("25000");
  });

  it("nullifies non-finite numeric values (NaN / Infinity)", () => {
    const [row] = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: NaN as number,
          totalContractAmount: Infinity as number,
          contractedValue: -Infinity as number,
        }),
      ],
    });
    expect(row.installedKwAc).toBeNull();
    expect(row.totalContractAmount).toBeNull();
    expect(row.contractedValue).toBeNull();
  });

  it("passes through null numeric values as null", () => {
    const [row] = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: null,
          totalContractAmount: null,
          contractedValue: null,
        }),
      ],
    });
    expect(row.installedKwAc).toBeNull();
    expect(row.totalContractAmount).toBeNull();
    expect(row.contractedValue).toBeNull();
  });

  it("passes through null Dates as null", () => {
    const [row] = buildChangeOwnershipFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          contractedDate: null,
          zillowSoldDate: null,
          latestReportingDate: null,
        }),
      ],
    });
    expect(row.contractedDate).toBeNull();
    expect(row.zillowSoldDate).toBeNull();
    expect(row.latestReportingDate).toBeNull();
  });

  it("returns [] when the input rows array is empty", () => {
    const rows = buildChangeOwnershipFactRows({
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

function makeAggregate() {
  return {
    rows: [makeRow({ key: "sys-1" }), makeRow({ key: "sys-2" })],
    summary: {
      total: 2,
      reporting: 2,
      notReporting: 0,
      reportingPercent: 100,
      contractedValueTotal: 50000,
      contractedValueReporting: 50000,
      contractedValueNotReporting: 0,
      counts: [],
    },
    cooNotTransferredNotReportingCurrentCount: 0,
    ownershipStackedChartRows: [
      {
        label: "Reporting" as const,
        notTransferred: 0,
        transferred: 2,
        changeOwnership: 0,
      },
      {
        label: "Not Reporting" as const,
        notTransferred: 0,
        transferred: 0,
        changeOwnership: 0,
      },
    ],
  };
}

describe("changeOwnershipBuildStep — orchestration", () => {
  it("aggregator → upsert → orphan-sweep order with correct args", async () => {
    mocks.getOrBuildChangeOwnership.mockResolvedValue({
      result: makeAggregate(),
      fromCache: false,
    });
    mocks.deleteOrphanedChangeOwnershipFacts.mockResolvedValue(5);

    await changeOwnershipBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.getOrBuildChangeOwnership).toHaveBeenCalledWith("scope-A");
    expect(mocks.upsertChangeOwnershipFacts).toHaveBeenCalledTimes(1);
    const [upsertedRows] = mocks.upsertChangeOwnershipFacts.mock.calls[0];
    expect(upsertedRows).toHaveLength(2);
    expect(upsertedRows[0].buildId).toBe("bld-1");
    expect(upsertedRows[0].scopeId).toBe("scope-A");
    expect(mocks.deleteOrphanedChangeOwnershipFacts).toHaveBeenCalledWith(
      "scope-A",
      "bld-1"
    );
    // Order check: upsert BEFORE orphan-sweep.
    const upsertOrder =
      mocks.upsertChangeOwnershipFacts.mock.invocationCallOrder[0];
    const sweepOrder =
      mocks.deleteOrphanedChangeOwnershipFacts.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(sweepOrder);
  });

  it("propagates upsert failures (runner converts to errorMessage)", async () => {
    mocks.getOrBuildChangeOwnership.mockResolvedValue({
      result: makeAggregate(),
      fromCache: false,
    });
    mocks.upsertChangeOwnershipFacts.mockRejectedValue(
      new Error("upsert blew up")
    );

    await expect(
      changeOwnershipBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/upsert blew up/);
    expect(mocks.deleteOrphanedChangeOwnershipFacts).not.toHaveBeenCalled();
  });

  it("aborts before aggregate fetch when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      changeOwnershipBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.getOrBuildChangeOwnership).not.toHaveBeenCalled();
    expect(mocks.upsertChangeOwnershipFacts).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Step registration
// ────────────────────────────────────────────────────────────────────

describe("registerChangeOwnershipBuildStep", () => {
  it("appends the step to the runner's empty steps array on first call", async () => {
    expect(getDashboardBuildSteps()).toEqual([]);
    await registerChangeOwnershipBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("changeOwnershipFacts");
    expect(steps[0]).toBe(changeOwnershipBuildStep);
  });

  it("is idempotent: subsequent calls do NOT duplicate the step", async () => {
    await registerChangeOwnershipBuildStep();
    await registerChangeOwnershipBuildStep();
    await registerChangeOwnershipBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });

  it("preserves prior steps already in the array (e.g. monitoringDetails)", async () => {
    const priorStep = {
      name: "monitoringDetailsFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([priorStep]);
    await registerChangeOwnershipBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe(priorStep);
    expect(steps[1].name).toBe("changeOwnershipFacts");
  });

  it("does NOT re-append when a step with the same name is already in the array", async () => {
    setDashboardBuildSteps([
      {
        name: "changeOwnershipFacts",
        run: async () => {},
      },
    ]);
    await registerChangeOwnershipBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });
});
