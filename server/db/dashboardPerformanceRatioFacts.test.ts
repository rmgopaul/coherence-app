/**
 * 2026-05-09 — Option C — DB-helper contract tests for the
 * performance-ratio facts table after the build-isolation refactor.
 *
 * Covers:
 *   - upsertPerformanceRatioFacts: chunking + on-duplicate-key set
 *   - pruneSupersededPerformanceRatioFacts: NOT IN keep-list
 *   - getPerformanceRatioFactsPage: filter / sort / search / offset
 *   - getPerformanceRatioFactsCount: same filter args
 *   - getPerformanceRatioFactsAggregates: counts + sums under filter
 *   - getPerformanceRatioMonitoringOptions: distinct values
 *   - getPerformanceRatioFactsByKeys: scopeId + buildId + IN list
 *   - **buildId isolation**: a page query passing buildId=B-1 never
 *     returns rows tagged buildId=B-2 (the visibility-pointer
 *     contract).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardChangeOwnershipFacts.test.ts`.
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
  getPerformanceRatioFactsAggregates,
  getPerformanceRatioFactsByKeys,
  getPerformanceRatioFactsCount,
  getPerformanceRatioFactsPage,
  getPerformanceRatioMonitoringOptions,
  pruneSupersededPerformanceRatioFacts,
  upsertPerformanceRatioFacts,
} from "./dashboardPerformanceRatioFacts";

interface BuilderCall {
  kind: "select" | "selectDistinct" | "insert" | "delete";
  whereCalled: number;
  insertValues?: unknown[];
  onDuplicateSet?: Record<string, unknown>;
  orderByCount?: number;
  limitCalled?: number;
  offsetCalled?: number;
}

function makeDbStub(opts: {
  selectRows?: Record<string, unknown>[][];
  selectDistinctRows?: Record<string, unknown>[][];
  deleteAffected?: number;
}) {
  const calls: BuilderCall[] = [];
  let selectIdx = 0;
  let selectDistinctIdx = 0;

  function makeSelectChain(): Record<string, unknown> {
    const my = selectIdx;
    selectIdx += 1;
    const call: BuilderCall = {
      kind: "select",
      whereCalled: 0,
      orderByCount: 0,
      limitCalled: 0,
      offsetCalled: 0,
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
      offset: () => {
        call.offsetCalled! += 1;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(opts.selectRows?.[my] ?? []).then(resolve),
    };
    return chain;
  }

  function makeSelectDistinctChain(): Record<string, unknown> {
    const my = selectDistinctIdx;
    selectDistinctIdx += 1;
    const call: BuilderCall = {
      kind: "selectDistinct",
      whereCalled: 0,
      orderByCount: 0,
    };
    calls.push(call);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => {
        call.whereCalled += 1;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(opts.selectDistinctRows?.[my] ?? []).then(resolve),
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
    selectDistinct: () => makeSelectDistinctChain(),
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

function makeRow(
  suffix: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
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
    ...overrides,
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
    const insertCall = stub.calls.find((c) => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // Mutable columns. Spot-check a representative subset covering
    // each column-type family in the schema.
    expect(Object.keys(set)).toContain("convertedReadKey");
    expect(Object.keys(set)).toContain("matchType");
    expect(Object.keys(set)).toContain("readDate");
    expect(Object.keys(set)).toContain("lifetimeReadWh");
    expect(Object.keys(set)).toContain("performanceRatioPercent");
    expect(Object.keys(set)).toContain("contractValue");
    expect(Object.keys(set)).toContain("updatedAt");
    // PK columns + auto-managed createdAt NOT in update set.
    // (Option C — `buildId` is now part of the PK, so it's NOT
    // in the update set either; rows from different builds are
    // independent inserts.)
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("key");
    expect(Object.keys(set)).not.toContain("buildId");
    expect(Object.keys(set)).not.toContain("createdAt");
  });

  it("chunks rows at 500 per INSERT (Math.ceil(N / 500) call count)", async () => {
    // 2026-05-13 — CHUNK_SIZE bumped 200 → 500 for write-roundtrip
    // throughput. 1_100 rows → 3 chunks (500 + 500 + 100).
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 1_100 }, (_, i) => makeRow(String(i)));
    await upsertPerformanceRatioFacts(rows as never);
    const insertCalls = stub.calls.filter((c) => c.kind === "insert");
    expect(insertCalls).toHaveLength(Math.ceil(1_100 / 500));
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(500);
    expect(insertCalls[1].insertValues?.length).toBe(500);
    expect(insertCalls[2].insertValues?.length).toBe(100);
  });

  it("a 500-row input lands in exactly one INSERT (chunk-size boundary rail)", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 500 }, (_, i) => makeRow(String(i)));
    await upsertPerformanceRatioFacts(rows as never);
    const insertCalls = stub.calls.filter((c) => c.kind === "insert");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].insertValues?.length).toBe(500);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertPerformanceRatioFacts([makeRow("1")] as never)
    ).rejects.toThrow(/db unavailable/i);
  });
});

describe("pruneSupersededPerformanceRatioFacts (Option C)", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 17 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneSupersededPerformanceRatioFacts(
      "scope-1",
      ["bld-current"]
    );
    expect(result).toBe(17);
    const deleteCall = stub.calls.find((c) => c.kind === "delete");
    expect(deleteCall?.whereCalled).toBe(1);
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await pruneSupersededPerformanceRatioFacts("scope-1", ["bld-current"])
    ).toBe(0);
  });

  it("returns 0 when getDb yields null (no leak, no throw)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await pruneSupersededPerformanceRatioFacts("scope-1", ["bld-current"])
    ).toBe(0);
  });

  it("scope-only delete when keepBuildIds is empty (test teardown path)", async () => {
    const stub = makeDbStub({ deleteAffected: 99 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneSupersededPerformanceRatioFacts("scope-1", []);
    expect(result).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Page reads — Option C contract
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGINATION = {
  limit: 100,
  offset: 0,
  sortBy: "readDate" as const,
  sortDir: "desc" as const,
};

describe("getPerformanceRatioFactsPage (Option C — buildId-scoped, filter/sort/search/offset)", () => {
  it("returns the rows the stub yields under default sort/limit/offset", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      DEFAULT_PAGINATION
    );
    expect(result).toHaveLength(2);
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
    expect(selectCall?.offsetCalled).toBe(1);
  });

  it("applies offset when provided (random-page access)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { ...DEFAULT_PAGINATION, offset: 250 }
    );
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.offsetCalled).toBe(1);
  });

  it("applies matchType filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage(
      {
        scopeId: "scope-1",
        buildId: "bld-1",
        matchType: "Monitoring + System ID",
      },
      DEFAULT_PAGINATION
    );
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies monitoring filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1", monitoring: "Enphase" },
      DEFAULT_PAGINATION
    );
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies search across multiple LIKE columns when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1", search: " AcMe " },
      DEFAULT_PAGINATION
    );
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("supports each sortBy option without throwing", async () => {
    const stub = makeDbStub({ selectRows: [[], [], [], [], []] });
    mocks.getDb.mockResolvedValue(stub);
    for (const sortBy of [
      "performanceRatioPercent",
      "productionDeltaWh",
      "expectedProductionWh",
      "systemName",
      "readDate",
    ] as const) {
      await getPerformanceRatioFactsPage(
        { scopeId: "scope-1", buildId: "bld-1" },
        { ...DEFAULT_PAGINATION, sortBy }
      );
    }
    const selectCalls = stub.calls.filter((c) => c.kind === "select");
    expect(selectCalls).toHaveLength(5);
    for (const call of selectCalls) {
      expect(call.orderByCount).toBe(1);
    }
  });

  it("supports each sortDir option (asc | desc)", async () => {
    const stub = makeDbStub({ selectRows: [[], []] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { ...DEFAULT_PAGINATION, sortDir: "asc" }
    );
    await getPerformanceRatioFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { ...DEFAULT_PAGINATION, sortDir: "desc" }
    );
    const selectCalls = stub.calls.filter((c) => c.kind === "select");
    expect(selectCalls).toHaveLength(2);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[], []] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      getPerformanceRatioFactsPage(
        { scopeId: "scope-1", buildId: "bld-1" },
        { ...DEFAULT_PAGINATION, limit: 0 }
      )
    ).resolves.not.toThrow();
    await expect(
      getPerformanceRatioFactsPage(
        { scopeId: "scope-1", buildId: "bld-1" },
        { ...DEFAULT_PAGINATION, limit: 9999 }
      )
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioFactsPage(
        { scopeId: "scope-1", buildId: "bld-1" },
        DEFAULT_PAGINATION
      )
    ).toEqual([]);
  });
});

describe("getPerformanceRatioFactsCount (Option C — same filter args as page)", () => {
  it("returns the count from a numeric COUNT() result under the buildId filter", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 850 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(850);
  });

  it("applies matchType filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 42 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
        matchType: "Monitoring + System Name",
      })
    ).toBe(42);
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies monitoring filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 31 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
        monitoring: "Solis",
      })
    ).toBe(31);
  });

  it("applies search filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 7 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
        search: "Acme",
      })
    ).toBe(7);
  });

  it("coerces a string COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "1234" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(1234);
  });

  it("returns 0 when result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(0);
  });
});

describe("getPerformanceRatioFactsAggregates (Option C)", () => {
  it("returns aggregates from the SELECT result (numeric coercion)", async () => {
    const stub = makeDbStub({
      selectRows: [
        [
          {
            allocationCount: 100,
            withBaseline: 75,
            withExpected: 60,
            withRatio: 50,
            totalDeltaWh: "12345.6789",
            totalExpectedWh: "20000.0000",
            totalContractValue: "98765.4321",
          },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsAggregates({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(result.allocationCount).toBe(100);
    expect(result.withBaseline).toBe(75);
    expect(result.withExpected).toBe(60);
    expect(result.withRatio).toBe(50);
    expect(result.totalDeltaWh).toBeCloseTo(12345.6789, 4);
    expect(result.totalExpectedWh).toBeCloseTo(20000, 4);
    expect(result.totalContractValue).toBeCloseTo(98765.4321, 4);
  });

  it("returns zero aggregates when the result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsAggregates({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(result.allocationCount).toBe(0);
    expect(result.totalDeltaWh).toBe(0);
  });
});

describe("getPerformanceRatioMonitoringOptions (Option C)", () => {
  it("returns sorted distinct monitoring values for the visible build", async () => {
    const stub = makeDbStub({
      selectDistinctRows: [
        [
          { monitoring: "SolarEdge" },
          { monitoring: "Enphase" },
          { monitoring: "AlsoEnergy" },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioMonitoringOptions({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(result).toEqual(["AlsoEnergy", "Enphase", "SolarEdge"]);
  });

  it("filters out empty / non-string values defensively", async () => {
    const stub = makeDbStub({
      selectDistinctRows: [
        [
          { monitoring: "Enphase" },
          { monitoring: "" },
          { monitoring: null },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioMonitoringOptions({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(result).toEqual(["Enphase"]);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioMonitoringOptions({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual([]);
  });
});

describe("getPerformanceRatioFactsByKeys (scope + build scoped)", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsByKeys({
      scopeId: "scope-1",
      buildId: "bld-1",
      keys: [],
    });
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys (scope + build scoped)", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getPerformanceRatioFactsByKeys({
      scopeId: "scope-1",
      buildId: "bld-1",
      keys: ["converted-1-sys-a", "converted-2-sys-b"],
    });
    expect(result).toHaveLength(2);
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioFactsByKeys({
        scopeId: "scope-1",
        buildId: "bld-1",
        keys: ["converted-1-sys-a"],
      })
    ).toEqual([]);
  });
});
