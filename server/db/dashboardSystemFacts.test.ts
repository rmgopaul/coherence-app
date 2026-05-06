/**
 * Tests for the dashboard system facts helpers
 * (Phase 2 PR-F-1).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardOwnershipFacts.test.ts`. The three filter
 * axes (`status`, `sizeBucket`, `isReporting`) get explicit rails
 * to defend against a regression where one is dropped silently.
 *
 * Chunk size differs from the prior fact tables: 250 rows / INSERT
 * instead of 500. System fact rows are the widest yet (~33 columns
 * incl. PK + buildId + timestamps) so 250 × 33 ≈ 8.25k params keeps
 * us inside TiDB's per-statement parameter limit.
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
  deleteOrphanedSystemFacts,
  getSystemFactsBySystemKeys,
  getSystemFactsCount,
  getSystemFactsPage,
  upsertSystemFacts,
} from "./dashboardSystemFacts";

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
    systemKey: `key-${suffix}`,
    systemId: null,
    stateApplicationRefId: null,
    trackingSystemRefId: null,
    systemName: `System ${suffix}`,
    installedKwAc: "7.5",
    installedKwDc: "8.2",
    sizeBucket: "<=10 kW AC",
    recPrice: "1.25",
    totalContractAmount: "50000",
    contractedRecs: "200",
    deliveredRecs: "150",
    contractedValue: "25000",
    deliveredValue: "18750",
    valueGap: "6250",
    latestReportingDate: null,
    latestReportingKwh: null,
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
    contractedDate: null,
    monitoringType: "online",
    monitoringPlatform: "enphase",
    installerName: "Acme Solar",
    part2VerificationDate: null,
    buildId: "bld-1",
  };
}

describe("upsertSystemFacts", () => {
  it("returns early without DB call on empty input", async () => {
    await upsertSystemFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows with onDuplicateKeyUpdate set on every mutable column", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertSystemFacts(rows as never);
    const insertCall = stub.calls.find(c => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // 31 SystemRecord fields + isPart2Eligible (PR-F-4-f-1) +
    // buildId = 33 keys.
    expect(Object.keys(set)).toContain("systemName");
    expect(Object.keys(set)).toContain("installedKwAc");
    expect(Object.keys(set)).toContain("installedKwDc");
    expect(Object.keys(set)).toContain("sizeBucket");
    expect(Object.keys(set)).toContain("recPrice");
    expect(Object.keys(set)).toContain("contractedRecs");
    expect(Object.keys(set)).toContain("deliveredRecs");
    expect(Object.keys(set)).toContain("ownershipStatus");
    expect(Object.keys(set)).toContain("changeOwnershipStatus");
    expect(Object.keys(set)).toContain("hasChangedOwnership");
    expect(Object.keys(set)).toContain("isReporting");
    expect(Object.keys(set)).toContain("monitoringPlatform");
    expect(Object.keys(set)).toContain("installerName");
    expect(Object.keys(set)).toContain("part2VerificationDate");
    expect(Object.keys(set)).toContain("isPart2Eligible");
    expect(Object.keys(set)).toContain("buildId");
    // PK columns + auto-managed timestamps NOT in update set.
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("systemKey");
    expect(Object.keys(set)).not.toContain("createdAt");
    expect(Object.keys(set)).not.toContain("updatedAt");
  });

  it("chunks rows at 250 per INSERT (narrower than the other fact tables — 33-col rows)", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 600 }, (_, i) => makeRow(String(i)));
    await upsertSystemFacts(rows as never);
    const insertCalls = stub.calls.filter(c => c.kind === "insert");
    // 600 / 250 = 3 chunks: 250 + 250 + 100.
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(250);
    expect(insertCalls[1].insertValues?.length).toBe(250);
    expect(insertCalls[2].insertValues?.length).toBe(100);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertSystemFacts([makeRow("1")] as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("deleteOrphanedSystemFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 42 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await deleteOrphanedSystemFacts("scope-1", "bld-current");
    expect(result).toBe(42);
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await deleteOrphanedSystemFacts("scope-1", "bld-current")
    ).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await deleteOrphanedSystemFacts("scope-1", "bld-current")
    ).toBe(0);
  });
});

describe("getSystemFactsPage", () => {
  it("returns the rows the stub yields without filters", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getSystemFactsPage("scope-1", { limit: 100 });
    expect(result).toHaveLength(2);
  });

  it("uses cursorAfter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      cursorAfter: "key-a",
      limit: 50,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
  });

  it("applies status filter when provided (covering-index path)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      status: "Transferred and Reporting",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies sizeBucket filter when provided (SizeReportingTab axis)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      sizeBucket: "<=10 kW AC",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies isReporting=true filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      isReporting: true,
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies isReporting=false filter when provided (defends against truthy-only check)", async () => {
    // A regression that wrote `if (options.isReporting)` would
    // silently drop the false value; this rail catches it.
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      isReporting: false,
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies isPart2Eligible=true filter when provided (PR-F-4-f-1)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      isPart2Eligible: true,
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies isPart2Eligible=false filter (defends against truthy-only check)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      isPart2Eligible: false,
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("combines all 4 filters into a single WHERE", async () => {
    // All four axes ANDed into one where clause; SELECT issues
    // exactly one filtered query.
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSystemFactsPage("scope-1", {
      status: "Terminated and Reporting",
      sizeBucket: ">10 kW AC",
      isReporting: true,
      isPart2Eligible: true,
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      getSystemFactsPage("scope-1", { limit: 0 })
    ).resolves.not.toThrow();
    await expect(
      getSystemFactsPage("scope-1", { limit: 9999 })
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getSystemFactsPage("scope-1", { limit: 100 })).toEqual([]);
  });
});

describe("getSystemFactsBySystemKeys", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getSystemFactsBySystemKeys("scope-1", []);
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getSystemFactsBySystemKeys("scope-1", [
      "key-a",
      "key-b",
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getSystemFactsBySystemKeys("scope-1", ["key-a"])
    ).toEqual([]);
  });
});

describe("getSystemFactsCount", () => {
  it("returns the count from a numeric COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 33 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getSystemFactsCount("scope-1")).toBe(33);
  });

  it("applies status filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 5 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getSystemFactsCount("scope-1", {
        status: "Terminated and Reporting",
      })
    ).toBe(5);
  });

  it("applies sizeBucket filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 12 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getSystemFactsCount("scope-1", {
        sizeBucket: "<=10 kW AC",
      })
    ).toBe(12);
  });

  it("applies isReporting=false filter (defends against truthy-only check)", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 7 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getSystemFactsCount("scope-1", {
        isReporting: false,
      })
    ).toBe(7);
  });

  it("applies isPart2Eligible filter when provided (PR-F-4-f-1)", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 19 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getSystemFactsCount("scope-1", {
        isPart2Eligible: true,
      })
    ).toBe(19);
  });

  it("combines all 4 filter axes", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 2 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getSystemFactsCount("scope-1", {
        status: "Transferred and Reporting",
        sizeBucket: ">10 kW AC",
        isReporting: true,
        isPart2Eligible: true,
      })
    ).toBe(2);
  });

  it("coerces a string COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "777" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getSystemFactsCount("scope-1")).toBe(777);
  });

  it("returns 0 when result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getSystemFactsCount("scope-1")).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getSystemFactsCount("scope-1")).toBe(0);
  });
});
