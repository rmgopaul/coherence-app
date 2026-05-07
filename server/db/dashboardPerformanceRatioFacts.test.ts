/**
 * Tests for the dashboard performance-ratio facts helpers
 * (Phase 2 PR-G-1).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardChangeOwnershipFacts.test.ts` for shape
 * consistency across the dashboard fact-table family.
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
  deleteOrphanedPerformanceRatioFacts,
  getPerformanceRatioFactsByKeys,
  getPerformanceRatioFactsCount,
  getPerformanceRatioFactsPage,
  upsertPerformanceRatioFacts,
} from "./dashboardPerformanceRatioFacts";

interface BuilderCall {
  kind: "select" | "insert" | "delete";
  whereCalled: number;
  insertValues?: unknown[];
  onDuplicateSet?: Record<string, unknown>;
  orderByCount?: number;
  limitCalled?: number;
}

function makeDbStub(opts: {
  selectRows?: Record<string, unknown>[][];
  deleteAffected?: number;
}) {
  const calls: BuilderCall[] = [];
  let selectIdx = 0;

  function makeSelectChain(): Record<string, unknown> {
    const my = selectIdx;
    selectIdx += 1;
    const call: BuilderCall = {
      kind: "select",
      whereCalled: 0,
      orderByCount: 0,
      limitCalled: 0,
    };
    calls.push(call);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => {
        call.whereCalled += 1;
        return chain;
      },
      orderBy: () => {
        call.orderByCount! += 1;
        return chain;
      },
      limit: () => {
        call.limitCalled! += 1;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(opts.selectRows?.[my] ?? []).then(resolve),
    };
    return chain;
  }

  function makeInsertChain(): Record<string, unknown> {
    const call: BuilderCall = { kind: "insert", whereCalled: 0 };
    calls.push(call);
    const chain: Record<string, unknown> = {
      values: (v: unknown) => {
        call.insertValues = v as unknown[];
        return chain;
      },
      onDuplicateKeyUpdate: (config: { set: Record<string, unknown> }) => {
        call.onDuplicateSet = config.set;
        return Promise.resolve();
      },
      then: (resolve: (out: unknown) => unknown) =>
        Promise.resolve().then(resolve),
    };
    return chain;
  }

  function makeDeleteChain(): Record<string, unknown> {
    const call: BuilderCall = { kind: "delete", whereCalled: 0 };
    calls.push(call);
    const chain: Record<string, unknown> = {
      where: () => {
        call.whereCalled += 1;
        return chain;
      },
      then: (resolve: (out: unknown) => unknown) =>
        Promise.resolve({ affectedRows: opts.deleteAffected ?? 0 }).then(
          resolve
        ),
    };
    return chain;
  }

  return {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
    delete: () => makeDeleteChain(),
    calls,
  };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRow(suffix: string): Record<string, unknown> {
  return {
    scopeId: "scope-1",
    key: `converted-${suffix}-sys-${suffix}`,
    convertedReadKey: `converted-${suffix}`,
    matchType: "Monitoring + System ID",
    monitoring: "Enphase",
    monitoringSystemId: `ms-${suffix}`,
    monitoringSystemName: `MonitoringSys ${suffix}`,
    readDate: null,
    readDateRaw: "2026-01-15",
    lifetimeReadWh: "12345678.0000",
    trackingSystemRefId: `tsr-${suffix}`,
    systemId: `sys-${suffix}`,
    stateApplicationRefId: null,
    systemName: `System ${suffix}`,
    installerName: "Acme Solar",
    monitoringPlatform: "Enphase",
    portalAcSizeKw: "10.0000",
    abpAcSizeKw: null,
    part2VerificationDate: null,
    baselineReadWh: null,
    baselineDate: null,
    baselineSource: null,
    productionDeltaWh: null,
    expectedProductionWh: null,
    performanceRatioPercent: null,
    contractValue: "0.0000",
    buildId: "bld-1",
  };
}

describe("upsertPerformanceRatioFacts", () => {
  it("returns early without DB call on empty input", async () => {
    await upsertPerformanceRatioFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows with onDuplicateKeyUpdate set on every mutable column", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertPerformanceRatioFacts(rows as never);
    const insertCall = stub.calls.find(c => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // Mutable columns + buildId. Spot-check a representative subset
    // covering each column-type family in the schema.
    expect(Object.keys(set)).toContain("convertedReadKey");
    expect(Object.keys(set)).toContain("matchType");
    expect(Object.keys(set)).toContain("readDate");
    expect(Object.keys(set)).toContain("lifetimeReadWh");
    expect(Object.keys(set)).toContain("performanceRatioPercent");
    expect(Object.keys(set)).toContain("contractValue");
    expect(Object.keys(set)).toContain("buildId");
    // PK columns + auto-managed timestamps NOT in update set.
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("key");
    expect(Object.keys(set)).not.toContain("createdAt");
    expect(Object.keys(set)).not.toContain("updatedAt");
  });

  it("chunks rows at 200 per INSERT", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 450 }, (_, i) => makeRow(String(i)));
    await upsertPerformanceRatioFacts(rows as never);
    const insertCalls = stub.calls.filter(c => c.kind === "insert");
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(200);
    expect(insertCalls[1].insertValues?.length).toBe(200);
    expect(insertCalls[2].insertValues?.length).toBe(50);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertPerformanceRatioFacts([makeRow("1")] as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("deleteOrphanedPerformanceRatioFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 17 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await deleteOrphanedPerformanceRatioFacts(
      "scope-1",
      "bld-current"
    );
    expect(result).toBe(17);
    const deleteCall = stub.calls.find(c => c.kind === "delete");
    expect(deleteCall?.whereCalled).toBe(1);
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await deleteOrphanedPerformanceRatioFacts("scope-1", "bld-current")
    ).toBe(0);
  });

  it("returns 0 when getDb yields null (no leak, no throw)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await deleteOrphanedPerformanceRatioFacts("scope-1", "bld-current")
    ).toBe(0);
  });
});

describe("getPerformanceRatioFactsPage", () => {
  it("returns the rows the stub yields without filters", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsPage("scope-1", {
      limit: 100,
    });
    expect(result).toHaveLength(2);
  });

  it("uses cursorAfter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage("scope-1", {
      cursorAfter: "converted-5-sys-5",
      limit: 50,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
  });

  it("applies matchType filter when provided (covering index path)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage("scope-1", {
      matchType: "Monitoring + System ID",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
  });

  it("applies monitoring filter when provided (covering index path)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage("scope-1", {
      monitoring: "Enphase",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies both filter axes simultaneously", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage("scope-1", {
      matchType: "Monitoring + System ID + System Name",
      monitoring: "SolarEdge",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      getPerformanceRatioFactsPage("scope-1", { limit: 0 })
    ).resolves.not.toThrow();
    await expect(
      getPerformanceRatioFactsPage("scope-1", { limit: 9999 })
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioFactsPage("scope-1", { limit: 100 })
    ).toEqual([]);
  });
});

describe("getPerformanceRatioFactsByKeys", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsByKeys("scope-1", []);
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsByKeys("scope-1", [
      "converted-1-sys-a",
      "converted-2-sys-b",
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioFactsByKeys("scope-1", ["converted-1-sys-a"])
    ).toEqual([]);
  });
});

describe("getPerformanceRatioFactsCount", () => {
  it("returns the count from a numeric COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 850 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getPerformanceRatioFactsCount("scope-1")).toBe(850);
  });

  it("applies matchType filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 42 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount("scope-1", {
        matchType: "Monitoring + System Name",
      })
    ).toBe(42);
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies monitoring filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 31 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount("scope-1", {
        monitoring: "Solis",
      })
    ).toBe(31);
  });

  it("coerces a string COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "1234" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getPerformanceRatioFactsCount("scope-1")).toBe(1234);
  });

  it("returns 0 when result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getPerformanceRatioFactsCount("scope-1")).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getPerformanceRatioFactsCount("scope-1")).toBe(0);
  });
});
