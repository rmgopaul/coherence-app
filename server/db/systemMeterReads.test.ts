/**
 * Task 9.5 PR-1 (2026-04-28) — meter-read history join-chain tests.
 *
 * Mocks `_core` getDb + withDbRetry so the join logic is exercised
 * without spinning up MySQL. The systemRegistry import shares the
 * same mock — its sub-queries appear at fixed indices in the row
 * sequence below.
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
  getLatestMeterReadsForCsgId,
  getSystemRecentMeterReads,
  resolveMeterReadsBatchIds,
} from "./systemMeterReads";

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
      values: () => chain,
      set: () => chain,
      offset: () => chain,
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

describe("resolveMeterReadsBatchIds", () => {
  it("returns nulls when no active versions exist", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await resolveMeterReadsBatchIds("scope-1");
    expect(out).toEqual({
      generationEntry: null,
      convertedReads: null,
    });
  });

  it("maps both target dataset keys to slot batches", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { datasetKey: "generationEntry", batchId: "ge-1" },
          { datasetKey: "convertedReads", batchId: "cr-1" },
          { datasetKey: "transferHistory", batchId: "ignored" },
        ],
      ])
    );
    const out = await resolveMeterReadsBatchIds("scope-1");
    expect(out).toEqual({
      generationEntry: "ge-1",
      convertedReads: "cr-1",
    });
  });
});

describe("getLatestMeterReadsForCsgId", () => {
  // The systemRegistry helper that this composer pulls from runs
  // four sub-queries (active batches → mapping → applications →
  // contracted date). The pre-resolvedRegistry option lets us
  // bypass that to keep tests focused on the meter-read logic.
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

  it("returns empty result for blank csgId", async () => {
    const out = await getLatestMeterReadsForCsgId("scope-1", "");
    expect(out.reads).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns empty result when convertedReads dataset isn't active", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // resolveMeterReadsBatchIds — only generationEntry active
        [{ datasetKey: "generationEntry", batchId: "ge-1" }],
      ])
    );
    const out = await getLatestMeterReadsForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.reads).toEqual([]);
    expect(out.latestReadDate).toBeNull();
  });

  it("joins generationEntry → convertedReads via monitoringSystemId", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches
        [
          { datasetKey: "generationEntry", batchId: "ge-1" },
          { datasetKey: "convertedReads", batchId: "cr-1" },
        ],
        // 2. generationEntry lookup — vendor + system id resolved
        [
          {
            onlineMonitoring: "Solis",
            onlineMonitoringSystemId: "VEND-SYS-77",
            onlineMonitoringSystemName: "Smith Site - Solis",
          },
        ],
        // 3. converted reads — newest first
        [
          { readDate: "2026-04-27", lifetimeMeterReadWh: 5_000_000 },
          { readDate: "2026-04-20", lifetimeMeterReadWh: 4_900_000 },
          { readDate: "2026-04-13", lifetimeMeterReadWh: 4_800_000 },
        ],
      ])
    );

    const out = await getLatestMeterReadsForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.monitoringVendor).toBe("Solis");
    expect(out.monitoringSystemId).toBe("VEND-SYS-77");
    expect(out.reads.length).toBe(3);
    expect(out.latestReadDate).toBe("2026-04-27");
    expect(out.latestReadWh).toBe(5_000_000);
  });

  it("falls back to systemName match when no generation-entry row exists", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — both active
        [
          { datasetKey: "generationEntry", batchId: "ge-1" },
          { datasetKey: "convertedReads", batchId: "cr-1" },
        ],
        // 2. generationEntry lookup — empty (no row)
        [],
        // 3. converted reads — matched on systemName
        [
          { readDate: "2026-04-15", lifetimeMeterReadWh: 1_234_000 },
        ],
      ])
    );

    const out = await getLatestMeterReadsForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.monitoringVendor).toBeNull();
    expect(out.monitoringSystemId).toBeNull();
    expect(out.reads.length).toBe(1);
    expect(out.latestReadWh).toBe(1_234_000);
  });

  it("returns empty when no matchers can be built (no vendor/name available)", async () => {
    const sparseRegistry = {
      ...fakeRegistry,
      systemName: null,
      trackingSystemRefId: null,
    };
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — both active
        [
          { datasetKey: "generationEntry", batchId: "ge-1" },
          { datasetKey: "convertedReads", batchId: "cr-1" },
        ],
      ])
    );
    const out = await getLatestMeterReadsForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: sparseRegistry,
    });
    expect(out.reads).toEqual([]);
  });

  it("clamps the limit to [1, 200]", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { datasetKey: "generationEntry", batchId: "ge-1" },
          { datasetKey: "convertedReads", batchId: "cr-1" },
        ],
        [
          {
            onlineMonitoring: "X",
            onlineMonitoringSystemId: "y",
            onlineMonitoringSystemName: "z",
          },
        ],
        [],
      ])
    );
    // Out-of-bounds limit values should be clamped silently.
    const out = await getLatestMeterReadsForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
      limit: 99999,
    });
    expect(out.reads).toEqual([]);
    // No assertion on the bounded limit here — we'd need a real DB
    // to observe the LIMIT clause. The clamp is a defense-in-depth
    // measure documented in the helper; this test confirms calling
    // with a wild limit doesn't throw.
  });
});

describe("getSystemRecentMeterReads", () => {
  it("returns empty result when both systemId and systemName are blank", async () => {
    const out = await getSystemRecentMeterReads("scope-1", {
      systemId: null,
      systemName: "",
    });
    expect(out.reads).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns empty result when convertedReads dataset isn't active", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // resolveMeterReadsBatchIds — only generationEntry active
        [{ datasetKey: "generationEntry", batchId: "ge-1" }],
      ])
    );
    const out = await getSystemRecentMeterReads("scope-1", {
      systemId: "SYS-9",
      systemName: "Smith Site",
    });
    expect(out.reads).toEqual([]);
  });

  it("returns reads ordered by readDate desc when matched by systemId", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches
        [{ datasetKey: "convertedReads", batchId: "cr-1" }],
        // 2. converted reads — DB returns them already sorted by
        //    readDate DESC because the helper's .orderBy() runs on
        //    the server. We mirror that here.
        [
          {
            readDate: "2026-04-27",
            monitoring: "Solis",
            lifetimeMeterReadWh: 5_000_000,
          },
          {
            readDate: "2026-04-20",
            monitoring: "Solis",
            lifetimeMeterReadWh: 4_900_000,
          },
          {
            readDate: "2026-04-13",
            monitoring: "Solis",
            lifetimeMeterReadWh: 4_800_000,
          },
        ],
      ])
    );
    const out = await getSystemRecentMeterReads("scope-1", {
      systemId: "SYS-9",
      systemName: "Smith Site",
    });
    expect(out.reads).toHaveLength(3);
    expect(out.reads[0]).toEqual({
      readDate: "2026-04-27",
      monitoring: "Solis",
      lifetimeMeterReadWh: 5_000_000,
    });
    expect(out.reads[2]?.readDate).toBe("2026-04-13");
  });

  it("falls back to systemName-only match when systemId is null", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ datasetKey: "convertedReads", batchId: "cr-1" }],
        [
          {
            readDate: "2026-04-15",
            monitoring: null,
            lifetimeMeterReadWh: 1_234_000,
          },
        ],
      ])
    );
    const out = await getSystemRecentMeterReads("scope-1", {
      systemId: null,
      systemName: "Smith Site",
    });
    expect(out.reads).toHaveLength(1);
    expect(out.reads[0]).toEqual({
      readDate: "2026-04-15",
      monitoring: null,
      lifetimeMeterReadWh: 1_234_000,
    });
  });

  it("filters out rows with missing readDate (defensive — db has nullable column)", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ datasetKey: "convertedReads", batchId: "cr-1" }],
        [
          {
            readDate: "2026-04-15",
            monitoring: "Enphase",
            lifetimeMeterReadWh: 1000,
          },
          { readDate: null, monitoring: "Enphase", lifetimeMeterReadWh: 999 },
          { readDate: "", monitoring: "Enphase", lifetimeMeterReadWh: 998 },
        ],
      ])
    );
    const out = await getSystemRecentMeterReads("scope-1", {
      systemId: "SYS-1",
      systemName: "",
    });
    expect(out.reads).toHaveLength(1);
    expect(out.reads[0]?.readDate).toBe("2026-04-15");
  });
});
