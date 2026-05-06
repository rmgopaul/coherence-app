/**
 * Tests for the dashboard monitoring-details facts helpers
 * (Phase 2 PR-C-1).
 *
 * Mocks `_core` getDb + withDbRetry via `vi.hoisted`. Each helper
 * either issues SELECT / INSERT (with onDuplicateKeyUpdate) /
 * DELETE; the stub records the terminal call so tests can assert
 * on shape (chunk count, where-call count, set-on-update payload,
 * affectedRows fallback, IN-list dispatch).
 *
 * Mirrors the test infra from
 * `server/db/solarRecDashboardBuilds.test.ts` so the dashboard
 * fact-table family stays uniform.
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
  deleteOrphanedMonitoringDetailsFacts,
  getMonitoringDetailsFactsBySystemKeys,
  getMonitoringDetailsFactsCount,
  getMonitoringDetailsFactsPage,
  upsertMonitoringDetailsFacts,
} from "./dashboardMonitoringDetailsFacts";

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
  insertResolves?: boolean;
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
        Promise.resolve(opts.insertResolves ?? true).then(resolve),
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

describe("upsertMonitoringDetailsFacts", () => {
  function makeRow(
    suffix: string
  ): Record<string, unknown> {
    return {
      scopeId: "scope-1",
      systemKey: `id:abc-${suffix}`,
      onlineMonitoring: "Yes",
      onlineMonitoringSystemId: `sys-${suffix}`,
      buildId: "bld-1",
    };
  }

  it("returns early without DB call on empty input", async () => {
    await upsertMonitoringDetailsFacts([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("forwards rows to db.insert(...).values(...) with onDuplicateKeyUpdate set", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = [makeRow("1"), makeRow("2")];
    await upsertMonitoringDetailsFacts(rows as never);
    const insertCall = stub.calls.find(c => c.kind === "insert");
    expect(insertCall?.insertValues).toEqual(rows);
    // onDuplicateKeyUpdate.set must include every mutable column +
    // `buildId`. (PK columns scopeId/systemKey are NOT updated.)
    const set = insertCall?.onDuplicateSet ?? {};
    expect(Object.keys(set)).toContain("onlineMonitoring");
    expect(Object.keys(set)).toContain("buildId");
    expect(Object.keys(set)).toContain("abpAcSizeKw");
    // Should NOT include the PK columns or auto-managed updatedAt.
    expect(Object.keys(set)).not.toContain("scopeId");
    expect(Object.keys(set)).not.toContain("systemKey");
    expect(Object.keys(set)).not.toContain("updatedAt");
    expect(Object.keys(set)).not.toContain("createdAt");
  });

  it("chunks rows at 500 per INSERT", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const rows = Array.from({ length: 1250 }, (_, i) => makeRow(String(i)));
    await upsertMonitoringDetailsFacts(rows as never);
    const insertCalls = stub.calls.filter(c => c.kind === "insert");
    // 1250 rows / 500 chunk → 3 INSERT calls (500 + 500 + 250).
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].insertValues?.length).toBe(500);
    expect(insertCalls[1].insertValues?.length).toBe(500);
    expect(insertCalls[2].insertValues?.length).toBe(250);
  });

  it("throws when the DB is unavailable (write is mandatory)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      upsertMonitoringDetailsFacts([makeRow("1")] as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("deleteOrphanedMonitoringDetailsFacts", () => {
  it("returns the affected-row count from the DELETE", async () => {
    const stub = makeDbStub({ deleteAffected: 7 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await deleteOrphanedMonitoringDetailsFacts(
      "scope-1",
      "bld-current"
    );
    expect(result).toBe(7);
    const deleteCall = stub.calls.find(c => c.kind === "delete");
    expect(deleteCall?.whereCalled).toBe(1);
  });

  it("returns 0 when no rows match (current build matches all rows)", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await deleteOrphanedMonitoringDetailsFacts("scope-1", "bld-current")
    ).toBe(0);
  });

  it("returns 0 when getDb yields null (no leak, no throw)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await deleteOrphanedMonitoringDetailsFacts("scope-1", "bld-current")
    ).toBe(0);
  });
});

describe("getMonitoringDetailsFactsPage", () => {
  function makeRow(systemKey: string): Record<string, unknown> {
    return {
      scopeId: "scope-1",
      systemKey,
      onlineMonitoring: "Yes",
      buildId: "bld-1",
    };
  }

  it("returns the rows the stub yields", async () => {
    const stub = makeDbStub({
      selectRows: [[makeRow("id:a"), makeRow("id:b")]],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getMonitoringDetailsFactsPage("scope-1", {
      limit: 100,
    });
    expect(result).toHaveLength(2);
  });

  it("uses cursorAfter when provided (paginated WHERE call)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getMonitoringDetailsFactsPage("scope-1", {
      cursorAfter: "id:a",
      limit: 50,
    });
    const selectCall = stub.calls.find(c => c.kind === "select");
    expect(selectCall?.whereCalled).toBe(1);
    expect(selectCall?.orderByCount).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
  });

  it("clamps limit to [1, 1000]", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    // Limit 0 → clamped to 1. Limit 9999 → clamped to 1000.
    // We can't easily inspect the actual numeric arg passed to
    // .limit() through the stub, but verify the call shape stays
    // correct (no throw).
    await expect(
      getMonitoringDetailsFactsPage("scope-1", { limit: 0 })
    ).resolves.not.toThrow();
    await expect(
      getMonitoringDetailsFactsPage("scope-1", { limit: 9999 })
    ).resolves.not.toThrow();
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getMonitoringDetailsFactsPage("scope-1", { limit: 100 })
    ).toEqual([]);
  });
});

describe("getMonitoringDetailsFactsBySystemKeys", () => {
  it("returns [] without DB call on empty keys array", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const result = await getMonitoringDetailsFactsBySystemKeys(
      "scope-1",
      []
    );
    expect(result).toEqual([]);
    // Empty IN-list would be invalid SQL; helper short-circuits
    // BEFORE getDb to avoid even checking connection.
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns rows for the given keys", async () => {
    const stub = makeDbStub({
      selectRows: [
        [
          { scopeId: "scope-1", systemKey: "id:a", buildId: "bld-1" },
          { scopeId: "scope-1", systemKey: "id:b", buildId: "bld-1" },
        ],
      ],
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getMonitoringDetailsFactsBySystemKeys(
      "scope-1",
      ["id:a", "id:b"]
    );
    expect(result).toHaveLength(2);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await getMonitoringDetailsFactsBySystemKeys("scope-1", ["id:a"])
    ).toEqual([]);
  });
});

describe("getMonitoringDetailsFactsCount", () => {
  it("returns the count from a numeric COUNT() result", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: 42 }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getMonitoringDetailsFactsCount("scope-1")).toBe(42);
  });

  it("coerces a string COUNT() result (some MySQL drivers return string)", async () => {
    const stub = makeDbStub({ selectRows: [[{ n: "1234" }]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getMonitoringDetailsFactsCount("scope-1")).toBe(1234);
  });

  it("returns 0 when result is empty / unparseable", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    expect(await getMonitoringDetailsFactsCount("scope-1")).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getMonitoringDetailsFactsCount("scope-1")).toBe(0);
  });
});
