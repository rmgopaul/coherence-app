/**
 * Tests for the dashboard system fact-table builder
 * (Phase 2 PR-F-2).
 *
 * Two layers tested:
 *   1. Pure transformation `buildSystemFactRows` —
 *      SystemRecordSubset[] → fact rows. Unit tests, no
 *      mocks needed.
 *   2. Runner step + registration — uses `vi.hoisted` mocks for
 *      the DB upsert/delete helpers + the existing
 *      `getOrBuildSystemSnapshot` aggregator.
 *
 * Mirrors the test infra from
 * `buildDashboardChangeOwnershipFacts.test.ts` /
 * `buildDashboardOwnershipFacts.test.ts`. Key extra rails vs the
 * earlier builders:
 *   - 10 decimal-string conversions (vs 3 for change-ownership) —
 *     defends against a regression where one column gets a
 *     direct-number assignment that bypasses the
 *     `numberToDecimalString` shim.
 *   - The `unknown[]` → `SystemRecordSubset[]` cast at the
 *     aggregator boundary is exercised end-to-end via the runner
 *     step test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertSystemFacts: vi.fn(),
  deleteOrphanedSystemFacts: vi.fn(),
  getOrBuildSystemSnapshot: vi.fn(),
}));

vi.mock("../../db/dashboardSystemFacts", () => ({
  upsertSystemFacts: mocks.upsertSystemFacts,
  deleteOrphanedSystemFacts: mocks.deleteOrphanedSystemFacts,
  // Other exports unused by the builder; provide stubs so the
  // module's import-time evaluation doesn't break.
  getSystemFactsPage: vi.fn(),
  getSystemFactsBySystemKeys: vi.fn(),
  getSystemFactsCount: vi.fn(),
}));

vi.mock("./buildSystemSnapshot", async () => {
  const actual = await vi.importActual<
    typeof import("./buildSystemSnapshot")
  >("./buildSystemSnapshot");
  return {
    ...actual,
    getOrBuildSystemSnapshot: mocks.getOrBuildSystemSnapshot,
  };
});

import {
  __resetSystemBuildStepRegistrationForTests,
  buildSystemFactRows,
  systemBuildStep,
  registerSystemBuildStep,
  type SystemRecordSubset,
} from "./buildDashboardSystemFacts";
import {
  getDashboardBuildSteps,
  setDashboardBuildSteps,
} from "./dashboardBuildJobRunner";

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.upsertSystemFacts.mockResolvedValue(undefined);
  mocks.deleteOrphanedSystemFacts.mockResolvedValue(0);
  setDashboardBuildSteps([]);
  __resetSystemBuildStepRegistrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
  __resetSystemBuildStepRegistrationForTests();
});

// ────────────────────────────────────────────────────────────────────
// Pure transformation tests
// ────────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<SystemRecordSubset> = {}
): SystemRecordSubset {
  return {
    key: "sys-1",
    systemId: "sys-1",
    stateApplicationRefId: "state-1",
    trackingSystemRefId: "tr-1",
    systemName: "Acme Solar",
    installedKwAc: 7.5,
    installedKwDc: 8.2,
    sizeBucket: "<=10 kW AC",
    recPrice: 1.25,
    totalContractAmount: 50000,
    contractedRecs: 200,
    deliveredRecs: 150,
    contractedValue: 25000,
    deliveredValue: 18750,
    valueGap: 6250,
    latestReportingDate: new Date("2026-04-01"),
    latestReportingKwh: 1234.5,
    isReporting: true,
    isTerminated: false,
    isTransferred: true,
    ownershipStatus: "Transferred and Reporting",
    hasChangedOwnership: false,
    changeOwnershipStatus: null,
    contractStatusText: "Active",
    contractType: "TURNKEY",
    zillowStatus: null,
    zillowSoldDate: null,
    contractedDate: new Date("2024-01-15"),
    monitoringType: "online",
    monitoringPlatform: "enphase",
    installerName: "Acme Solar Co",
    part2VerificationDate: null,
    ...overrides,
  };
}

describe("buildSystemFactRows (pure transformation)", () => {
  it("returns one fact row per SystemRecord", () => {
    const rows = buildSystemFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      rows: [makeRow({ key: "sys-a" }), makeRow({ key: "sys-b" })],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.systemKey).sort()).toEqual(["sys-a", "sys-b"]);
  });

  it("stamps every row with the supplied scopeId + buildId", () => {
    const rows = buildSystemFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      rows: [makeRow()],
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
  });

  it("uses SystemRecord.key as the systemKey (PK)", () => {
    const rows = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ key: "custom-key-123" })],
    });
    expect(rows[0].systemKey).toBe("custom-key-123");
  });

  it("maps all 31 SystemRecord fields 1:1", () => {
    const source = makeRow({
      key: "k",
      systemId: "sys-X",
      stateApplicationRefId: "state-X",
      trackingSystemRefId: "tr-X",
      systemName: "Custom Name",
      sizeBucket: ">10 kW AC",
      latestReportingDate: new Date("2026-04-30"),
      isReporting: false,
      isTerminated: true,
      isTransferred: false,
      ownershipStatus: "Terminated and Not Reporting",
      hasChangedOwnership: true,
      changeOwnershipStatus: "Change of Ownership - Not Transferred and Reporting",
      contractStatusText: "Pending",
      contractType: "PPA",
      zillowStatus: "Sold",
      zillowSoldDate: new Date("2025-01-10"),
      contractedDate: new Date("2024-06-15"),
      monitoringType: "manual",
      monitoringPlatform: "csv",
      installerName: "Other Solar",
      part2VerificationDate: new Date("2025-03-01"),
    });
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [source],
    });
    expect(row.systemId).toBe("sys-X");
    expect(row.stateApplicationRefId).toBe("state-X");
    expect(row.trackingSystemRefId).toBe("tr-X");
    expect(row.systemName).toBe("Custom Name");
    expect(row.sizeBucket).toBe(">10 kW AC");
    expect(row.latestReportingDate).toEqual(new Date("2026-04-30"));
    expect(row.isReporting).toBe(false);
    expect(row.isTerminated).toBe(true);
    expect(row.isTransferred).toBe(false);
    expect(row.ownershipStatus).toBe("Terminated and Not Reporting");
    expect(row.hasChangedOwnership).toBe(true);
    expect(row.changeOwnershipStatus).toBe(
      "Change of Ownership - Not Transferred and Reporting"
    );
    expect(row.contractStatusText).toBe("Pending");
    expect(row.contractType).toBe("PPA");
    expect(row.zillowStatus).toBe("Sold");
    expect(row.zillowSoldDate).toEqual(new Date("2025-01-10"));
    expect(row.contractedDate).toEqual(new Date("2024-06-15"));
    expect(row.monitoringType).toBe("manual");
    expect(row.monitoringPlatform).toBe("csv");
    expect(row.installerName).toBe("Other Solar");
    expect(row.part2VerificationDate).toEqual(new Date("2025-03-01"));
  });

  it("converts ALL 10 numeric decimal columns to string form (Drizzle decimal contract)", () => {
    // Defends against a regression where one of the 10 numeric
    // fields gets a direct-number assignment, bypassing the
    // `numberToDecimalString` shim. Drizzle's MySQL driver
    // accepts a number and silently truncates, surfacing as
    // imprecise values way later — covering all 10 here catches
    // the slip immediately.
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: 7.5,
          installedKwDc: 8.2,
          recPrice: 1.25,
          totalContractAmount: 50000,
          contractedRecs: 200.5,
          deliveredRecs: 150.25,
          contractedValue: 25000.5,
          deliveredValue: 18750.25,
          valueGap: 6250.25,
          latestReportingKwh: 1234.5,
        }),
      ],
    });
    expect(row.installedKwAc).toBe("7.5");
    expect(row.installedKwDc).toBe("8.2");
    expect(row.recPrice).toBe("1.25");
    expect(row.totalContractAmount).toBe("50000");
    expect(row.contractedRecs).toBe("200.5");
    expect(row.deliveredRecs).toBe("150.25");
    expect(row.contractedValue).toBe("25000.5");
    expect(row.deliveredValue).toBe("18750.25");
    expect(row.valueGap).toBe("6250.25");
    expect(row.latestReportingKwh).toBe("1234.5");
  });

  it("nullifies non-finite numeric values (NaN / Infinity) on every decimal column", () => {
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: NaN as number,
          installedKwDc: Infinity as number,
          recPrice: -Infinity as number,
          totalContractAmount: NaN as number,
          contractedRecs: NaN as number,
          deliveredRecs: Infinity as number,
          contractedValue: NaN as number,
          deliveredValue: NaN as number,
          valueGap: NaN as number,
          latestReportingKwh: NaN as number,
        }),
      ],
    });
    expect(row.installedKwAc).toBeNull();
    expect(row.installedKwDc).toBeNull();
    expect(row.recPrice).toBeNull();
    expect(row.totalContractAmount).toBeNull();
    expect(row.contractedRecs).toBeNull();
    expect(row.deliveredRecs).toBeNull();
    expect(row.contractedValue).toBeNull();
    expect(row.deliveredValue).toBeNull();
    expect(row.valueGap).toBeNull();
    expect(row.latestReportingKwh).toBeNull();
  });

  it("passes through null numeric values as null", () => {
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          installedKwAc: null,
          installedKwDc: null,
          recPrice: null,
          totalContractAmount: null,
          contractedRecs: null,
          deliveredRecs: null,
          contractedValue: null,
          deliveredValue: null,
          valueGap: null,
          latestReportingKwh: null,
        }),
      ],
    });
    expect(row.installedKwAc).toBeNull();
    expect(row.installedKwDc).toBeNull();
    expect(row.recPrice).toBeNull();
    expect(row.totalContractAmount).toBeNull();
    expect(row.contractedRecs).toBeNull();
    expect(row.deliveredRecs).toBeNull();
    expect(row.contractedValue).toBeNull();
    expect(row.deliveredValue).toBeNull();
    expect(row.valueGap).toBeNull();
    expect(row.latestReportingKwh).toBeNull();
  });

  it("passes through null Dates as null", () => {
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          latestReportingDate: null,
          zillowSoldDate: null,
          contractedDate: null,
          part2VerificationDate: null,
        }),
      ],
    });
    expect(row.latestReportingDate).toBeNull();
    expect(row.zillowSoldDate).toBeNull();
    expect(row.contractedDate).toBeNull();
    expect(row.part2VerificationDate).toBeNull();
  });

  it("preserves boolean false (not coerced/dropped)", () => {
    const [row] = buildSystemFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          isReporting: false,
          isTerminated: false,
          isTransferred: false,
          hasChangedOwnership: false,
        }),
      ],
    });
    expect(row.isReporting).toBe(false);
    expect(row.isTerminated).toBe(false);
    expect(row.isTransferred).toBe(false);
    expect(row.hasChangedOwnership).toBe(false);
  });

  it("returns [] when the input rows array is empty", () => {
    const rows = buildSystemFactRows({
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

function makeAggregateResult() {
  return {
    systems: [
      makeRow({ key: "sys-1" }),
      makeRow({ key: "sys-2", sizeBucket: ">10 kW AC" }),
    ],
    fromCache: false,
    inputVersionHash: "hash-X",
    runId: null,
    building: false,
  };
}

describe("systemBuildStep — orchestration", () => {
  it("aggregator → upsert → orphan-sweep order with correct args", async () => {
    mocks.getOrBuildSystemSnapshot.mockResolvedValue(makeAggregateResult());
    mocks.deleteOrphanedSystemFacts.mockResolvedValue(11);

    await systemBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.getOrBuildSystemSnapshot).toHaveBeenCalledWith("scope-A");
    expect(mocks.upsertSystemFacts).toHaveBeenCalledTimes(1);
    const [upsertedRows] = mocks.upsertSystemFacts.mock.calls[0];
    expect(upsertedRows).toHaveLength(2);
    expect(upsertedRows[0].buildId).toBe("bld-1");
    expect(upsertedRows[0].scopeId).toBe("scope-A");
    // Sanity check: the cast through `unknown[]` round-trips
    // sizing + ownership data correctly.
    expect(upsertedRows[0].sizeBucket).toBe("<=10 kW AC");
    expect(upsertedRows[1].sizeBucket).toBe(">10 kW AC");
    expect(mocks.deleteOrphanedSystemFacts).toHaveBeenCalledWith(
      "scope-A",
      "bld-1"
    );
    // Order check: upsert BEFORE orphan-sweep.
    const upsertOrder =
      mocks.upsertSystemFacts.mock.invocationCallOrder[0];
    const sweepOrder =
      mocks.deleteOrphanedSystemFacts.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(sweepOrder);
  });

  it("propagates upsert failures (runner converts to errorMessage)", async () => {
    mocks.getOrBuildSystemSnapshot.mockResolvedValue(makeAggregateResult());
    mocks.upsertSystemFacts.mockRejectedValue(new Error("upsert blew up"));

    await expect(
      systemBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/upsert blew up/);
    expect(mocks.deleteOrphanedSystemFacts).not.toHaveBeenCalled();
  });

  it("aborts before aggregate fetch when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      systemBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.getOrBuildSystemSnapshot).not.toHaveBeenCalled();
    expect(mocks.upsertSystemFacts).not.toHaveBeenCalled();
  });

  it("handles an empty systems array (cold scope with no abpReport / solarApplications)", async () => {
    mocks.getOrBuildSystemSnapshot.mockResolvedValue({
      ...makeAggregateResult(),
      systems: [],
    });

    await systemBuildStep.run({
      scopeId: "s",
      buildId: "b",
      signal: new AbortController().signal,
    });

    expect(mocks.upsertSystemFacts).toHaveBeenCalledWith([]);
    expect(mocks.deleteOrphanedSystemFacts).toHaveBeenCalledWith("s", "b");
  });
});

// ────────────────────────────────────────────────────────────────────
// Step registration
// ────────────────────────────────────────────────────────────────────

describe("registerSystemBuildStep", () => {
  it("appends the step to the runner's empty steps array on first call", async () => {
    expect(getDashboardBuildSteps()).toEqual([]);
    await registerSystemBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("systemFacts");
    expect(steps[0]).toBe(systemBuildStep);
  });

  it("is idempotent: subsequent calls do NOT duplicate the step", async () => {
    await registerSystemBuildStep();
    await registerSystemBuildStep();
    await registerSystemBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });

  it("preserves prior steps already in the array (monitoringDetails + changeOwnership + ownership)", async () => {
    const monitoringStep = {
      name: "monitoringDetailsFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    const changeOwnershipStep = {
      name: "changeOwnershipFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    const ownershipStep = {
      name: "ownershipFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([
      monitoringStep,
      changeOwnershipStep,
      ownershipStep,
    ]);
    await registerSystemBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe(monitoringStep);
    expect(steps[1]).toBe(changeOwnershipStep);
    expect(steps[2]).toBe(ownershipStep);
    expect(steps[3].name).toBe("systemFacts");
  });

  it("does NOT re-append when a step with the same name is already in the array", async () => {
    setDashboardBuildSteps([
      {
        name: "systemFacts",
        run: async () => {},
      },
    ]);
    await registerSystemBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });
});
