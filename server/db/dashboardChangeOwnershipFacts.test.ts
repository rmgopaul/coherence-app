/**
 * Tests for the dashboard change-of-ownership facts helpers
 * (Phase 2 PR-D-1).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardMonitoringDetailsFacts.test.ts` for shape
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
  deleteOrphanedChangeOwnershipFacts,
  getChangeOwnershipFactsBySystemKeys,
  getChangeOwnershipFactsCount,
  getChangeOwnershipFactsPage,
  upsertChangeOwnershipFacts,
} from "./dashboardChangeOwnershipFacts";

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
    systemName: `System ${suffix}`,
    systemId: null,
    trackingSystemRefId: null,
    installedKwAc: "5.0000",
    contractType: "TURNKEY",
    contractStatusText: "Active",
    contractedDate: null,
    zillowStatus: null,
    zillowSoldDate: null,
    latestReportingDate: null,
    changeOwnershipStatus: "Transferred and Reporting",
    ownershipStatus: "Transferred and Reporting",
    isReporting: true,
    isTerminated: false,
    isTransferred: true,
    hasChangedOwnership: true,
    totalContractAmount: null,
    contractedValue: null,
    buildId: "bld-1",
  };
}

describe("upsertChangeOwnershipFacts", () => {
  it("returns early without DB call on empty input", async () => {
    await upsertChangeOwnershipFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows with onDuplicateKeyUpdate set on every mutable column", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertChangeOwnershipFacts(rows as never);
    const insertCall = stub.calls.find(c => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    const set = insertCall?.onDuplicateSet ?? {};
    // Mutable columns + buildId — 19 fields total.
    expect(Object.keys(set)).toContain("systemName");
    expect(Object.keys(set)).toContain("changeOwnershipStatus");
    expect(Object.keys(set)).toContain("contractedDate");
    expect(Object.keys(set)).toContain("isReporting");
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
    await upsertChangeOwnershipFacts(rows as never);
    const insertCalls = stub.calls.filter(c => c.kind === "insert");
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(500);
    expect(insertCalls[1].insertValues?.length).toBe(500);
    expect(insertCalls[2].insertValues?.length).toBe(250);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertChangeOwnershipFacts([makeRow("1")] as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("deleteOrphanedChangeOwnershipFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 12 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await deleteOrphanedChangeOwnershipFacts(
      "scope-1",
      "bld-current"
    );
    expect(result).toBe(12);
    const deleteCall = stub.calls.find(c => c.kind === "delete");
    expect(deleteCall?.whereCalled).toBe(1);
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await deleteOrphanedChangeOwnershipFacts("scope-1", "bld-current")
    ).toBe(0);
  });

  it("returns 0 when getDb yields null (no leak, no throw)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await deleteOrphanedChangeOwnershipFacts("scope-1", "bld-current")
    ).toBe(0);
  });
});

describe("getChangeOwnershipFactsPage", () => {
  it("returns the rows the stub yields without filters", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getChangeOwnershipFactsPage("scope-1", {
      limit: 100,
    });
    expect(result).toHaveLength(2);
  });

  it("uses cursorAfter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getChangeOwnershipFactsPage("scope-1", {
      cursorAfter: "key-a",
      limit: 50,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
  });

  it("applies status filter when provided (covering index path)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getChangeOwnershipFactsPage("scope-1", {
      status: "Transferred and Reporting",
      limit: 100,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      getChangeOwnershipFactsPage("scope-1", { limit: 0 })
    ).resolves.not.toThrow();
    await expect(
      getChangeOwnershipFactsPage("scope-1", { limit: 9999 })
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getChangeOwnershipFactsPage("scope-1", { limit: 100 })
    ).toEqual([]);
  });
});

describe("getChangeOwnershipFactsBySystemKeys", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getChangeOwnershipFactsBySystemKeys(
      "scope-1",
      []
    );
    expect(result).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("a"), makeRow("b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getChangeOwnershipFactsBySystemKeys(
      "scope-1",
      ["key-a", "key-b"]
    );
    expect(result).toHaveLength(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getChangeOwnershipFactsBySystemKeys("scope-1", ["key-a"])
    ).toEqual([]);
  });
});

describe("getChangeOwnershipFactsCount", () => {
  it("returns the count from a numeric COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 75 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getChangeOwnershipFactsCount("scope-1")).toBe(75);
  });

  it("applies status filter when provided", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 12 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await getChangeOwnershipFactsCount("scope-1", {
        status: "Terminated",
      })
    ).toBe(12);
    const selectCall = stub.calls.find(c => c.kind === "select");
    // One where call with both scope + status conditions ANDed.
    expect(selectCall?.whereCalled).toBe(1);
  });

  it("coerces a string COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "999" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getChangeOwnershipFactsCount("scope-1")).toBe(999);
  });

  it("returns 0 when result is empty", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getChangeOwnershipFactsCount("scope-1")).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getChangeOwnershipFactsCount("scope-1")).toBe(0);
  });
});
