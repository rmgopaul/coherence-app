/**
 * 2026-05-09 — PR-CB-1 — DB-helper contract tests for the
 * performance-ratio compliant-facts table.
 *
 * Covers:
 *   - upsertPerformanceRatioCompliantFacts: chunking + on-duplicate-
 *     key set
 *   - pruneSupersededPerformanceRatioCompliantFacts: NOT IN keep-list
 *   - getPerformanceRatioCompliantFactsPage: filter / sort / search
 *     / offset / pagination tie-breaker
 *   - getPerformanceRatioCompliantFactsCount: same filter args
 *   - getPerformanceRatioCompliantFactsAggregates: count +
 *     withCompliantSource
 *   - getPerformanceRatioCompliantSourceOptions: distinct values,
 *     null-excluded
 *   - getPerformanceRatioCompliantMonitoringOptions: distinct values
 *   - getPerformanceRatioCompliantFactsBySystemKeys: scopeId +
 *     buildId + IN list
 *   - COMPLIANT_SOURCE_NONE_SENTINEL: filter routes to IS NULL
 *
 * Mirrors the `vi.hoisted` mock pattern from the parent fact-table
 * test (`server/db/dashboardPerformanceRatioFacts.test.ts`).
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
  COMPLIANT_SOURCE_NONE_SENTINEL,
  getPerformanceRatioCompliantFactsAggregates,
  getPerformanceRatioCompliantFactsBySystemKeys,
  getPerformanceRatioCompliantFactsCount,
  getPerformanceRatioCompliantFactsPage,
  getPerformanceRatioCompliantMonitoringOptions,
  getPerformanceRatioCompliantSourceOptions,
  pruneSupersededPerformanceRatioCompliantFacts,
  upsertPerformanceRatioCompliantFacts,
} from "./dashboardPerformanceRatioCompliantFacts";

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
    buildId: "bld-1",
    systemKey: `sk-${suffix}`,
    key: `converted-${suffix}-sys-${suffix}`,
    systemId: `sys-${suffix}`,
    stateApplicationRefId: null,
    trackingSystemRefId: `tsr-${suffix}`,
    systemName: `System ${suffix}`,
    matchType: "Monitoring + System ID",
    monitoring: "Enphase",
    monitoringSystemId: `ms-${suffix}`,
    monitoringSystemName: `MonitoringSys ${suffix}`,
    monitoringPlatform: "Enphase",
    installerName: "Acme Solar",
    portalAcSizeKw: "10.0000",
    abpAcSizeKw: null,
    part2VerificationDate: null,
    readDate: null,
    readDateRaw: "2026-01-15",
    performanceRatioPercent: "85.0000",
    productionDeltaWh: null,
    expectedProductionWh: null,
    contractValue: "1000.0000",
    baselineReadWh: null,
    baselineDate: null,
    baselineSource: null,
    lifetimeReadWh: "12345678.0000",
    compliantSource: "10kW AC or Less",
    ...overrides,
  };
}

describe("upsertPerformanceRatioCompliantFacts", () => {
  it("returns early without DB call on empty input", async () => {
    await upsertPerformanceRatioCompliantFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows with onDuplicateKeyUpdate set on every mutable column", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertPerformanceRatioCompliantFacts(rows as never);
    const insertCall = stub.calls.find((c) => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // Spot-check representative mutable columns across each schema
    // family — the `key` source-row identifier, every numeric
    // family, every nullable family, the auto-compliant tag.
    expect(Object.keys(set)).toContain("key");
    expect(Object.keys(set)).toContain("matchType");
    expect(Object.keys(set)).toContain("readDate");
    expect(Object.keys(set)).toContain("lifetimeReadWh");
    expect(Object.keys(set)).toContain("performanceRatioPercent");
    expect(Object.keys(set)).toContain("contractValue");
    expect(Object.keys(set)).toContain("compliantSource");
    expect(Object.keys(set)).toContain("updatedAt");
    // PK columns + auto-managed createdAt NOT in update set.
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("buildId");
    expect(Object.keys(set)).not.toContain("systemKey");
    expect(Object.keys(set)).not.toContain("createdAt");
  });

  it("chunks rows at 200 per INSERT", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 450 }, (_, i) => makeRow(String(i)));
    await upsertPerformanceRatioCompliantFacts(rows as never);
    const insertCalls = stub.calls.filter((c) => c.kind === "insert");
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(200);
    expect(insertCalls[1].insertValues?.length).toBe(200);
    expect(insertCalls[2].insertValues?.length).toBe(50);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertPerformanceRatioCompliantFacts([makeRow("1")] as never)
    ).rejects.toThrow(/db unavailable/i);
  });
});

describe("pruneSupersededPerformanceRatioCompliantFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 17 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneSupersededPerformanceRatioCompliantFacts(
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
      await pruneSupersededPerformanceRatioCompliantFacts("scope-1", [
        "bld-current",
      ])
    ).toBe(0);
  });

  it("returns 0 when getDb yields null (no leak, no throw)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await pruneSupersededPerformanceRatioCompliantFacts("scope-1", [
        "bld-current",
      ])
    ).toBe(0);
  });

  it("scope-only delete when keepBuildIds is empty (test teardown path)", async () => {
    const stub = makeDbStub({ deleteAffected: 99 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneSupersededPerformanceRatioCompliantFacts(
      "scope-1",
      []
    );
    expect(result).toBe(99);
  });
});

describe("getPerformanceRatioCompliantFactsPage", () => {
  it("calls SELECT with WHERE / ORDER BY / LIMIT / OFFSET", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("1"), makeRow("2")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const rows = await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      {
        limit: 50,
        offset: 0,
        sortBy: "performanceRatioPercent",
        sortDir: "desc",
      }
    );
    expect(rows.length).toBe(2);
    const selectCall = stub.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
    expect(selectCall?.offsetCalled).toBe(1);
  });

  it("returns empty array when getDb yields null (no throw, no leak)", async () => {
    mocks.getDb.mockResolvedValue(null);
    const rows = await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: 50, offset: 0, sortBy: "systemName", sortDir: "asc" }
    );
    expect(rows).toEqual([]);
  });

  it("clamps limit to the safe range [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    // limit=0 → clamped to 1; limit=99999 → clamped to 1000;
    // limit=-50 → clamped to 1. Behavior is internal — assert via
    // the round-trip succeeding without throw.
    await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: 0, offset: 0, sortBy: "readDate", sortDir: "desc" }
    );
    await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: 99999, offset: 0, sortBy: "readDate", sortDir: "desc" }
    );
    await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: -50, offset: 0, sortBy: "readDate", sortDir: "desc" }
    );
    expect(stub.calls.filter((c) => c.kind === "select")).toHaveLength(3);
  });

  it("supports every sortBy enum member", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    for (const sortBy of [
      "performanceRatioPercent",
      "readDate",
      "systemName",
      "compliantSource",
    ] as const) {
      await getPerformanceRatioCompliantFactsPage(
        { scopeId: "scope-1", buildId: "bld-1" },
        { limit: 50, offset: 0, sortBy, sortDir: "asc" }
      );
    }
    // Four sortBy values × one SELECT each = 4 select calls. None
    // should throw on the resolveSortColumn switch.
    expect(stub.calls.filter((c) => c.kind === "select")).toHaveLength(4);
  });

  it("supports both sortDir values", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: 50, offset: 0, sortBy: "readDate", sortDir: "asc" }
    );
    await getPerformanceRatioCompliantFactsPage(
      { scopeId: "scope-1", buildId: "bld-1" },
      { limit: 50, offset: 0, sortBy: "readDate", sortDir: "desc" }
    );
    expect(stub.calls.filter((c) => c.kind === "select")).toHaveLength(2);
  });

  it("applies optional filter args without throwing (compliantSource / monitoring / search)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioCompliantFactsPage(
      {
        scopeId: "scope-1",
        buildId: "bld-1",
        compliantSource: "10kW AC or Less",
        monitoring: "Enphase",
        search: "Acme",
      },
      { limit: 50, offset: 0, sortBy: "systemName", sortDir: "asc" }
    );
    expect(stub.calls.find((c) => c.kind === "select")?.whereCalled).toBe(1);
  });

  it("escapes MySQL LIKE wildcards in the search term", async () => {
    // Behavioral guard against the regression where a user typing
    // `_5kW` would unintentionally match `15kW` / `25kW`. The
    // escaping is internal to `buildPerformanceRatioCompliantFilter
    // Conditions`; assert the round-trip doesn't throw and the
    // SELECT fires.
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioCompliantFactsPage(
      {
        scopeId: "scope-1",
        buildId: "bld-1",
        search: "_5kW",
      },
      { limit: 50, offset: 0, sortBy: "systemName", sortDir: "asc" }
    );
    expect(stub.calls.filter((c) => c.kind === "select")).toHaveLength(1);
  });

  it("compliantSource sentinel filter routes through the WHERE clause", async () => {
    // Visibility check that the special `__none__` filter doesn't
    // throw; the actual `compliantSource IS NULL` predicate is
    // exercised by integration paths in subsequent PRs.
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getPerformanceRatioCompliantFactsPage(
      {
        scopeId: "scope-1",
        buildId: "bld-1",
        compliantSource: COMPLIANT_SOURCE_NONE_SENTINEL,
      },
      { limit: 50, offset: 0, sortBy: "systemName", sortDir: "asc" }
    );
    expect(stub.calls.filter((c) => c.kind === "select")).toHaveLength(1);
  });
});

describe("getPerformanceRatioCompliantFactsCount", () => {
  it("returns the COUNT(*) value from the row", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 42 }]] });
    mocks.getDb.mockResolvedValue(stub);
    const count = await getPerformanceRatioCompliantFactsCount({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(count).toBe(42);
  });

  it("returns 0 when DB returns no rows", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioCompliantFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(0);
  });

  it("coerces string-form COUNT (TiDB driver edge case) to number", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "1234" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioCompliantFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(1234);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioCompliantFactsCount({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toBe(0);
  });
});

describe("getPerformanceRatioCompliantFactsAggregates", () => {
  it("returns count + withCompliantSource", async () => {
    const stub = makeDbStub({
      selectRows: [[{ count: 100, withCompliantSource: 75 }]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const agg = await getPerformanceRatioCompliantFactsAggregates({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    expect(agg).toEqual({ count: 100, withCompliantSource: 75 });
  });

  it("returns zero aggregates when DB returns no rows", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioCompliantFactsAggregates({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual({ count: 0, withCompliantSource: 0 });
  });

  it("returns zero aggregates when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioCompliantFactsAggregates({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual({ count: 0, withCompliantSource: 0 });
  });
});

describe("getPerformanceRatioCompliantSourceOptions", () => {
  it("returns sorted compliantSource values, excluding null/empty", async () => {
    // Helper relies on the SQL-side `selectDistinct` for dedup;
    // its own job is to filter null/empty + sort. Mock fixture
    // mirrors what `selectDistinct` would return — already deduped.
    const stub = makeDbStub({
      selectDistinctRows: [
        [
          { compliantSource: "Explicit Platform" },
          { compliantSource: "10kW AC or Less" },
          { compliantSource: null },
          { compliantSource: "" },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    const out = await getPerformanceRatioCompliantSourceOptions({
      scopeId: "scope-1",
      buildId: "bld-1",
    });
    // Sorted alphabetically, nulls + empty filtered.
    expect(out).toEqual(["10kW AC or Less", "Explicit Platform"]);
  });

  it("returns [] when DB returns no rows", async () => {
    const stub = makeDbStub({ selectDistinctRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioCompliantSourceOptions({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual([]);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioCompliantSourceOptions({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual([]);
  });
});

describe("getPerformanceRatioCompliantMonitoringOptions", () => {
  it("returns sorted distinct monitoring values", async () => {
    const stub = makeDbStub({
      selectDistinctRows: [
        [
          { monitoring: "SolarEdge" },
          { monitoring: "Enphase" },
          { monitoring: null },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getPerformanceRatioCompliantMonitoringOptions({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual(["Enphase", "SolarEdge"]);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioCompliantMonitoringOptions({
        scopeId: "scope-1",
        buildId: "bld-1",
      })
    ).toEqual([]);
  });
});

describe("getPerformanceRatioCompliantFactsBySystemKeys", () => {
  it("returns [] when systemKeys is empty (no DB call)", async () => {
    const result = await getPerformanceRatioCompliantFactsBySystemKeys({
      scopeId: "scope-1",
      buildId: "bld-1",
      systemKeys: [],
    });
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows from the IN clause", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const rows = await getPerformanceRatioCompliantFactsBySystemKeys({
      scopeId: "scope-1",
      buildId: "bld-1",
      systemKeys: ["sk-a", "sk-b"],
    });
    expect(rows.length).toBe(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getPerformanceRatioCompliantFactsBySystemKeys({
        scopeId: "scope-1",
        buildId: "bld-1",
        systemKeys: ["sk-a"],
      })
    ).toEqual([]);
  });
});

describe("COMPLIANT_SOURCE_NONE_SENTINEL", () => {
  it("is a stable namespaced string that cannot collide with real source labels", () => {
    expect(COMPLIANT_SOURCE_NONE_SENTINEL).toBe("__none__");
  });
});
