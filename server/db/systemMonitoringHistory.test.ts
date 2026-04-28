/**
 * Task 9.5 PR-6 (2026-04-28) — monitoring history helper tests.
 * Mocks `_core` getDb + withDbRetry per the established pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));

vi.mock("./_core", async () => {
  const actual = await vi.importActual<typeof import("./_core")>("./_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
  };
});

import {
  getMonitoringHistoryForCsgId,
  resolveGenerationEntryBatchId,
  computeConsecutiveErrorStreak,
} from "./systemMonitoringHistory";

type StubRow = Record<string, unknown>;

function makeDbStub(rowsByQueryIndex: StubRow[][]) {
  let idx = 0;
  function makeChain() {
    const my = idx;
    idx += 1;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (resolve: (rows: StubRow[]) => unknown) =>
        Promise.resolve(rowsByQueryIndex[my] ?? []).then(resolve),
    };
    return chain;
  }
  return { select: () => makeChain() };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeConsecutiveErrorStreak", () => {
  it("returns 0 when the most recent run is a success", () => {
    expect(
      computeConsecutiveErrorStreak([
        { status: "success" },
        { status: "error" },
        { status: "error" },
      ])
    ).toBe(0);
  });

  it("counts consecutive non-success runs from the head", () => {
    expect(
      computeConsecutiveErrorStreak([
        { status: "error" },
        { status: "error" },
        { status: "no_data" },
        { status: "skipped" },
        { status: "success" },
      ])
    ).toBe(4);
  });

  it("returns 0 for empty input", () => {
    expect(computeConsecutiveErrorStreak([])).toBe(0);
  });

  it("returns the full length when no success exists in the window", () => {
    expect(
      computeConsecutiveErrorStreak([
        { status: "error" },
        { status: "error" },
        { status: "error" },
      ])
    ).toBe(3);
  });
});

describe("resolveGenerationEntryBatchId", () => {
  it("returns null when no active version exists", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    expect(await resolveGenerationEntryBatchId("scope-1")).toBeNull();
  });

  it("returns the batchId when active", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[{ batchId: "ge-1" }]]));
    expect(await resolveGenerationEntryBatchId("scope-1")).toBe("ge-1");
  });
});

describe("getMonitoringHistoryForCsgId", () => {
  const fakeRegistry = {
    csgId: "CSG-001",
    abpId: "SYS-9",
    applicationId: "APP-1",
    systemId: "SYS-9",
    trackingSystemRefId: "GATS-X",
    stateCertificationNumber: null,
    systemName: "Smith Site",
    installedKwAc: 7.5,
    installedKwDc: null,
    recPrice: null,
    totalContractAmount: null,
    annualRecs: null,
    contractType: null,
    installerName: null,
    county: null,
    state: null,
    zipCode: null,
    contractedDate: null,
  };

  it("short-circuits on blank csgId", async () => {
    const out = await getMonitoringHistoryForCsgId("scope-1", "");
    expect(out.runs).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns empty when registry has no trackingSystemRefId", async () => {
    const noTracking = { ...fakeRegistry, trackingSystemRefId: null };
    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: noTracking,
    });
    expect(out.runs).toEqual([]);
    expect(out.monitoringVendor).toBeNull();
  });

  it("returns empty when generationEntry dataset isn't active", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // resolveGenerationEntryBatchId — empty
        [],
      ])
    );
    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.runs).toEqual([]);
    expect(out.monitoringVendor).toBeNull();
  });

  it("returns vendor=null when generation-entry has no row for the tracking ID", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "ge-1" }], // active batch
        [], // generation-entry lookup empty
      ])
    );
    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.monitoringVendor).toBeNull();
    expect(out.monitoringSystemId).toBeNull();
    expect(out.runs).toEqual([]);
  });

  it("rolls up runs + computes alarm signals", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batch
        [{ batchId: "ge-1" }],
        // 2. generation-entry — vendor + system id resolved
        [
          {
            onlineMonitoring: "Solis",
            onlineMonitoringSystemId: "VEND-77",
          },
        ],
        // 3. monitoring runs — date desc, mix of statuses
        [
          {
            dateKey: "2026-04-28",
            status: "error",
            readingsCount: 0,
            lifetimeKwh: null,
            errorMessage: "401 Unauthorized",
            durationMs: 1200,
            triggeredAt: new Date("2026-04-28T03:00:00Z"),
          },
          {
            dateKey: "2026-04-27",
            status: "error",
            readingsCount: 0,
            lifetimeKwh: null,
            errorMessage: "401 Unauthorized",
            durationMs: 1100,
            triggeredAt: new Date("2026-04-27T03:00:00Z"),
          },
          {
            dateKey: "2026-04-26",
            status: "success",
            readingsCount: 1,
            lifetimeKwh: 5_300,
            errorMessage: null,
            durationMs: 850,
            triggeredAt: new Date("2026-04-26T03:00:00Z"),
          },
          {
            dateKey: "2026-04-25",
            status: "no_data",
            readingsCount: 0,
            lifetimeKwh: null,
            errorMessage: null,
            durationMs: 420,
            triggeredAt: new Date("2026-04-25T03:00:00Z"),
          },
        ],
      ])
    );

    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.monitoringVendor).toBe("Solis");
    expect(out.monitoringSystemId).toBe("VEND-77");
    expect(out.totalRuns).toBe(4);
    expect(out.successCount).toBe(1);
    expect(out.errorCount).toBe(2);
    expect(out.noDataCount).toBe(1);
    expect(out.skippedCount).toBe(0);
    expect(out.latestSuccessfulRunDate).toBe("2026-04-26");
    expect(out.latestErrorRunDate).toBe("2026-04-28");
    expect(out.consecutiveErrorStreak).toBe(2); // 2 errors at the head before success
  });

  it("returns 0 streak when the most recent run is a success", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "ge-1" }],
        [
          {
            onlineMonitoring: "Solis",
            onlineMonitoringSystemId: "VEND-77",
          },
        ],
        [
          {
            dateKey: "2026-04-28",
            status: "success",
            readingsCount: 1,
            lifetimeKwh: 5_400,
            errorMessage: null,
            durationMs: 700,
            triggeredAt: new Date("2026-04-28T03:00:00Z"),
          },
          {
            dateKey: "2026-04-27",
            status: "error",
            readingsCount: 0,
            lifetimeKwh: null,
            errorMessage: "transient",
            durationMs: 800,
            triggeredAt: new Date("2026-04-27T03:00:00Z"),
          },
        ],
      ])
    );

    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.consecutiveErrorStreak).toBe(0);
    expect(out.latestSuccessfulRunDate).toBe("2026-04-28");
    expect(out.latestErrorRunDate).toBe("2026-04-27");
  });

  it("returns empty runs but preserves vendor when no monitoringApiRuns rows exist", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "ge-1" }],
        [
          {
            onlineMonitoring: "Solis",
            onlineMonitoringSystemId: "VEND-77",
          },
        ],
        [], // monitoringApiRuns empty
      ])
    );

    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.monitoringVendor).toBe("Solis");
    expect(out.monitoringSystemId).toBe("VEND-77");
    expect(out.runs).toEqual([]);
    expect(out.totalRuns).toBe(0);
  });

  it("clamps the limit to [1, 365]", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "ge-1" }],
        [
          {
            onlineMonitoring: "Solis",
            onlineMonitoringSystemId: "VEND-77",
          },
        ],
        [],
      ])
    );
    const out = await getMonitoringHistoryForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
      limit: 99999,
    });
    // No throw + sane shape.
    expect(out.runs).toEqual([]);
  });
});
