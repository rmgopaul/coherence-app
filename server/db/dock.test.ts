/**
 * Phase E (2026-04-28) — tests for the dock auto-archive helper +
 * the listDockItems archived-row filter.
 *
 * Mocks `_core` getDb + withDbRetry so the WHERE clause + the
 * `archivedAt = now()` mutation are exercised without spinning up
 * MySQL. The fake builder records each terminal call so we can
 * assert the right method was used (insert vs update vs select).
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

import { archiveStaleDockItems, listDockItems } from "./dock";

interface BuilderCall {
  kind: "select" | "update" | "insert" | "delete";
  whereCalled: number;
  setValue?: Record<string, unknown>;
}

function makeDbStub(opts: {
  selectRows?: Record<string, unknown>[][];
  updateAffected?: number;
}) {
  const calls: BuilderCall[] = [];
  let selectIdx = 0;

  function makeSelectChain(): Record<string, unknown> {
    const my = selectIdx;
    selectIdx += 1;
    const call: BuilderCall = { kind: "select", whereCalled: 0 };
    calls.push(call);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => {
        call.whereCalled += 1;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(opts.selectRows?.[my] ?? []).then(resolve),
    };
    return chain;
  }

  function makeUpdateChain(): Record<string, unknown> {
    const call: BuilderCall = { kind: "update", whereCalled: 0 };
    calls.push(call);
    const chain: Record<string, unknown> = {
      set: (value: Record<string, unknown>) => {
        call.setValue = value;
        return chain;
      },
      where: () => {
        call.whereCalled += 1;
        return chain;
      },
      then: (resolve: (out: unknown) => unknown) =>
        Promise.resolve({ affectedRows: opts.updateAffected ?? 0 }).then(
          resolve
        ),
    };
    return chain;
  }

  return {
    select: () => makeSelectChain(),
    update: () => makeUpdateChain(),
    insert: () => ({ values: () => Promise.resolve() }),
    delete: () => ({ where: () => Promise.resolve() }),
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

describe("listDockItems", () => {
  it("issues exactly one WHERE clause when not including archived", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listDockItems(1, 100);
    // The where() helper should be called once on the chain — once
    // for the AND of (userId, archivedAt IS NULL).
    expect(stub.calls[0].whereCalled).toBe(1);
  });

  it("returns the rows the stub yields", async () => {
    const rows = [
      { id: "x", userId: 1, source: "url", archivedAt: null },
    ];
    const stub = makeDbStub({ selectRows: [rows] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await listDockItems(1, 100);
    expect(result).toEqual(rows);
  });

  it("returns empty array when getDb yields null (test/dev with no DB)", async () => {
    mocks.getDb.mockResolvedValue(null);
    const result = await listDockItems(1, 100);
    expect(result).toEqual([]);
  });

  it("includes archived rows when opts.includeArchived is true", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listDockItems(1, 100, { includeArchived: true });
    // Same number of WHERE calls (1); semantics differ via the
    // condition we built. The fact that the chain didn't throw is
    // the smoke test — the actual archived-row inclusion is verified
    // end-to-end on the real DB.
    expect(stub.calls[0].whereCalled).toBe(1);
  });
});

describe("archiveStaleDockItems", () => {
  it("issues an UPDATE with archivedAt set to the given `now`", async () => {
    const fixedNow = new Date("2026-04-28T10:00:00Z");
    const stub = makeDbStub({ updateAffected: 7 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await archiveStaleDockItems({ now: fixedNow });
    expect(result.affected).toBe(7);
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.setValue).toEqual({ archivedAt: fixedNow });
  });

  it("clamps ageDays to a minimum of 1 (defensive)", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    // Both 0 and -5 should be treated as 1 day. We don't observe
    // the cutoff directly through the stub, but the helper must not
    // throw and must still attempt the update.
    const a = await archiveStaleDockItems({ ageDays: 0 });
    const b = await archiveStaleDockItems({ ageDays: -5 });
    expect(a.affected).toBe(0);
    expect(b.affected).toBe(0);
    expect(stub.calls.filter((c) => c.kind === "update").length).toBe(2);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    const result = await archiveStaleDockItems({ ageDays: 30 });
    expect(result.affected).toBe(0);
  });

  it("scopes to a single user when userId is provided", async () => {
    const stub = makeDbStub({ updateAffected: 2 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await archiveStaleDockItems({
      userId: 42,
      ageDays: 30,
    });
    expect(result.affected).toBe(2);
    // Single update issued; userId narrowed the WHERE chain.
    expect(stub.calls.filter((c) => c.kind === "update").length).toBe(1);
  });

  it("falls back to rowCount when affectedRows is missing (driver variance)", async () => {
    // Custom stub: terminal then() yields a header without
    // affectedRows but with rowCount.
    const stub = {
      update: () => {
        const chain: Record<string, unknown> = {
          set: () => chain,
          where: () => chain,
          then: (resolve: (out: unknown) => unknown) =>
            Promise.resolve({ rowCount: 4 }).then(resolve),
        };
        return chain;
      },
    };
    mocks.getDb.mockResolvedValue(stub);
    const result = await archiveStaleDockItems({ ageDays: 30 });
    expect(result.affected).toBe(4);
  });
});
