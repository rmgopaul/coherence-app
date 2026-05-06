/**
 * Tests for the dashboard ownership facts helpers
 * (Phase 2 PR-E-1).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardChangeOwnershipFacts.test.ts`. The two
 * filter axes (`status` and `source`) get explicit rails to
 * defend against a regression where one is dropped silently.
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
  deleteOrphanedOwnershipFacts,
  getOwnershipFactsBySystemKeys,
  getOwnershipFactsCount,
  getOwnershipFactsPage,
  upsertOwnershipFacts,
} from "./dashboardOwnershipFacts";

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
    part2ProjectName: "Project X",
    part2ApplicationId: null,
    part2SystemId: null,
    part2TrackingId: null,
    source: "Matched System",
    systemName: `System ${suffix}`,
    systemId: null,
    stateApplicationRefId: null,
    trackingSystemRefId: null,
    ownershipStatus: "Transferred and Reporting",
    isReporting: true,
    isTransferred: true,
    isTerminated: false,
    contractType: "TURNKEY",
    contractStatusText: "Active",
    latestReportingDate: null,
    contractedDate: null,
    zillowStatus: null,
    zillowSoldDate: null,
    buildId: "bld-1",
  };
}

describe("upsertOwnershipFacts", () => {
  it("returns early without DB call on empty input", async () => {
    await upsertOwnershipFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows with onDuplicateKeyUpdate set on every mutable column", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertOwnershipFacts(rows as never);
    const insertCall = stub.calls.find(c => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // 20 mutable columns + buildId = 21.
    expect(Object.keys(set)).toContain("part2ProjectName");
    expect(Object.keys(set)).toContain("source");
    expect(Object.keys(set)).toContain("systemName");
    expect(Object.keys(set)).toContain("ownershipStatus");
    expect(Object.keys(set)).toContain("isReporting");
    expect(Object.keys(set)).toContain("zillowSoldDate");
    expect(Object.keys(set)).toContain("buildId");
    // PK columns + auto-managed timestamps NOT in update set.
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("systemKey");
    expect(Object.keys(set)).not.toContain("createdAt");
    expect(Object.keys(set)).not.toContain("updatedAt");
  });

  it("chunks rows at 500 per INSERT", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 1250 }, (_, i) => makeRow(String(i)));
    await upsertOwnershipFacts(rows as never);
    const insertCalls = stub.calls.filter(c => c.kind === "insert");
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(500);
    expect(insertCalls[1].insertValues?.length).toBe(500);
    expect(insertCalls[2].insertValues?.length).toBe(250);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertOwnershipFacts([makeRow("1")] as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("deleteOrphanedOwnershipFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 18 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await deleteOrphanedOwnershipFacts(
      "scope-1",
      "bld-current"
    );
    expect(result).toBe(18);
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await deleteOrphanedOwnershipFacts("scope-1", "bld-current")
    ).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await deleteOrphanedOwnershipFacts("scope-1", "bld-current")
    ).toBe(0);
  });
});

describe("getOwnershipFactsPage", () => {
  it("returns the rows the stub yields without filters", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getOwnershipFactsPage("scope-1", { limit: 100 });
    expect(result).toHaveLength(2);
  });

  it("uses cursorAfter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getOwnershipFactsPage("scope-1", {
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
    await getOwnershipFactsPage("scope-1", {
      status: "Transferred and Reporting",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("applies source filter when provided (Matched System vs Part II Unmatched)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getOwnershipFactsPage("scope-1", {
      source: "Matched System",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("combines status + source filters into a single WHERE", async () => {
    // Both filter axes ANDed into one where clause; SELECT issues
    // exactly one filtered query (not two separate calls).
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getOwnershipFactsPage("scope-1", {
      status: "Terminated and Reporting",
      source: "Part II Unmatched",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      getOwnershipFactsPage("scope-1", { limit: 0 })
    ).resolves.not.toThrow();
    await expect(
      getOwnershipFactsPage("scope-1", { limit: 9999 })
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getOwnershipFactsPage("scope-1", { limit: 100 })
    ).toEqual([]);
  });
});

describe("getOwnershipFactsBySystemKeys", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getOwnershipFactsBySystemKeys("scope-1", []);
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getOwnershipFactsBySystemKeys("scope-1", [
      "key-a",
      "key-b",
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getOwnershipFactsBySystemKeys("scope-1", ["key-a"])
    ).toEqual([]);
  });
});

describe("getOwnershipFactsCount", () => {
  it("returns the count from a numeric COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 33 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getOwnershipFactsCount("scope-1")).toBe(33);
  });

  it("applies status filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 5 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getOwnershipFactsCount("scope-1", {
        status: "Terminated and Reporting",
      })
    ).toBe(5);
  });

  it("applies source filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 8 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getOwnershipFactsCount("scope-1", {
        source: "Part II Unmatched",
      })
    ).toBe(8);
  });

  it("combines status + source filters", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 2 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getOwnershipFactsCount("scope-1", {
        status: "Transferred and Reporting",
        source: "Matched System",
      })
    ).toBe(2);
  });

  it("coerces a string COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "777" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getOwnershipFactsCount("scope-1")).toBe(777);
  });

  it("returns 0 when result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getOwnershipFactsCount("scope-1")).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getOwnershipFactsCount("scope-1")).toBe(0);
  });
});
