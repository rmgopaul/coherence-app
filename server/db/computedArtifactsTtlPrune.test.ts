/**
 * Tests for `pruneOldComputedArtifacts` (Phase 8 cleanup, 2026-05-08).
 *
 * Mirrors the `vi.hoisted` mock pattern from
 * `server/db/dashboardChangeOwnershipFacts.test.ts`. The helper is
 * fire-and-forget from `upsertComputedArtifact`, so tests pin its
 * behavior in isolation: select-then-delete shape, keep count,
 * affected-rows extraction, no-op when below threshold.
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

import { pruneOldComputedArtifacts } from "./solarRecDatasets";

interface BuilderCall {
  kind: "select" | "delete";
  whereCalled: number;
  orderByCalled?: number;
  limitCalled?: number;
}

function makeDbStub(opts: {
  selectRows?: Array<{ id: string }>;
  deleteAffected?: number;
}) {
  const calls: BuilderCall[] = [];

  function makeSelectChain(): Record<string, unknown> {
    const call: BuilderCall = {
      kind: "select",
      whereCalled: 0,
      orderByCalled: 0,
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
        call.orderByCalled! += 1;
        return chain;
      },
      limit: () => {
        call.limitCalled! += 1;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(opts.selectRows ?? []).then(resolve),
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
        Promise.resolve([
          { affectedRows: opts.deleteAffected ?? 0 },
        ]).then(resolve),
    };
    return chain;
  }

  return {
    select: () => makeSelectChain(),
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

describe("pruneOldComputedArtifacts", () => {
  it("returns 0 without a delete when fewer than `keep` rows exist", async () => {
    const stub = makeDbStub({
      selectRows: [{ id: "row-1" }, { id: "row-2" }], // only 2 rows; below default keep=3
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneOldComputedArtifacts("scope-1", "foundation-v1");
    expect(result).toBe(0);
    expect(stub.calls.find((c) => c.kind === "delete")).toBeUndefined();
  });

  it("uses default keep=3 when no options are provided", async () => {
    const stub = makeDbStub({
      selectRows: [{ id: "k1" }, { id: "k2" }, { id: "k3" }],
      deleteAffected: 5,
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneOldComputedArtifacts(
      "scope-1",
      "foundation-v1"
    );
    expect(result).toBe(5);
    // SELECT then DELETE.
    const kinds = stub.calls.map((c) => c.kind);
    expect(kinds).toEqual(["select", "delete"]);
  });

  it("respects an explicit keep override", async () => {
    const stub = makeDbStub({
      selectRows: [{ id: "k1" }, { id: "k2" }, { id: "k3" }, { id: "k4" }, { id: "k5" }],
      deleteAffected: 12,
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneOldComputedArtifacts("scope-1", "foundation-v1", {
      keep: 5,
    });
    expect(result).toBe(12);
  });

  it("orders by updatedAt DESC and limits the keeper read", async () => {
    const stub = makeDbStub({
      selectRows: [{ id: "k1" }, { id: "k2" }, { id: "k3" }],
      deleteAffected: 1,
    });
    mocks.getDb.mockResolvedValue(stub);
    await pruneOldComputedArtifacts("scope-1", "foundation-v1");
    const selectCall = stub.calls.find((c) => c.kind === "select");
    // Pin both: orderBy ran (covering index needs DESC sort), and
    // limit ran (we don't accidentally pull every row of the table).
    expect(selectCall?.orderByCalled).toBe(1);
    expect(selectCall?.limitCalled).toBe(1);
  });

  it("returns 0 when DB is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    const result = await pruneOldComputedArtifacts("scope-1", "foundation-v1");
    expect(result).toBe(0);
  });

  it("clamps keep to a minimum of 1 (defends against keep=0 mistakes)", async () => {
    const stub = makeDbStub({
      selectRows: [{ id: "k1" }],
      deleteAffected: 4,
    });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneOldComputedArtifacts("scope-1", "foundation-v1", {
      keep: 0,
    });
    // Effective keep is 1 (clamped); one row in DB means below
    // threshold (need 1+ to prune), so... wait — keep=1 means we need
    // at least 1 row in select to prune. One row WAS returned, so we
    // proceed to delete. Affected = 4.
    expect(result).toBe(4);
  });
});
