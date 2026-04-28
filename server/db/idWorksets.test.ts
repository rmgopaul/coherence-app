/**
 * Task 9.2 (2026-04-28) — id worksets db helpers tests.
 *
 * Mocks the `_core` db barrel so each helper's effective query
 * sequence is observable. The drizzle builder is opaque so the
 * stub fakes a chain whose terminal `then(...)` resolves to canned
 * rows in registration order — same pattern used in
 * `solarRecPermissions.test.ts` and `systemRegistry.test.ts`.
 *
 * Insert/update/delete builders also resolve via `then(...)` (with
 * `[]` as a placeholder) so the helper can `await` them.
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
  createIdWorkset,
  deleteIdWorkset,
  getIdWorkset,
  listIdWorksets,
  normalizeCsgIds,
  updateIdWorkset,
  appendCsgIdsToWorkset,
  IdWorksetNameConflictError,
  IdWorksetNotFoundError,
} from "./idWorksets";

type StubRow = Record<string, unknown>;

/**
 * Build a fake db that yields `rowsByQueryIndex[i]` for the i-th
 * builder chain consumed via `await`. Insert/update/delete chains
 * still need a placeholder slot (use `[]`) so the index aligns.
 */
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
      then: (resolve: (rows: StubRow[]) => unknown) =>
        Promise.resolve(rowsByQueryIndex[my] ?? []).then(resolve),
    };
    return chain;
  }
  return {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
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

describe("normalizeCsgIds", () => {
  it("trims, drops empty/whitespace, and preserves first-occurrence order", () => {
    const result = normalizeCsgIds([
      "  CSG-001  ",
      "",
      "CSG-002",
      "   ",
      "CSG-001",
      "CSG-003",
      "CSG-002",
    ]);
    expect(result).toEqual(["CSG-001", "CSG-002", "CSG-003"]);
  });

  it("filters out non-string entries (defensive)", () => {
    const result = normalizeCsgIds([
      "valid",
      // @ts-expect-error — intentionally hostile input
      null,
      // @ts-expect-error — intentionally hostile input
      undefined,
      // @ts-expect-error — intentionally hostile input
      42,
      "valid-2",
    ]);
    expect(result).toEqual(["valid", "valid-2"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeCsgIds([])).toEqual([]);
  });
});

describe("createIdWorkset", () => {
  it("inserts a workset row and reads it back as detail", async () => {
    const insertedRow: StubRow = {
      id: "ws-1",
      scopeId: "scope-1",
      createdByUserId: 5,
      lastEditedByUserId: null,
      name: "My set",
      description: null,
      csgIdsJson: '["CSG-001","CSG-002"]',
      csgIdCount: 2,
      createdAt: new Date("2026-04-28T10:00:00Z"),
      updatedAt: new Date("2026-04-28T10:00:00Z"),
    };
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. insert
        [],
        // 2. read-back select
        [insertedRow],
      ])
    );
    const result = await createIdWorkset("scope-1", {
      name: "My set",
      csgIds: ["  CSG-001 ", "CSG-002", "CSG-001"],
      createdByUserId: 5,
    });
    expect(result.id).toBe("ws-1");
    expect(result.csgIds).toEqual(["CSG-001", "CSG-002"]);
    expect(result.csgIdCount).toBe(2);
    expect(result.createdByUserId).toBe(5);
    expect(result.lastEditedByUserId).toBeNull();
  });

  it("rejects empty names", async () => {
    await expect(
      createIdWorkset("scope-1", {
        name: "   ",
        csgIds: ["CSG-001"],
        createdByUserId: 5,
      })
    ).rejects.toThrow(/required/i);
  });

  it("converts duplicate-key errors to IdWorksetNameConflictError", async () => {
    mocks.getDb.mockResolvedValue({
      insert: () => ({
        values: () => ({
          then: (
            _resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown
          ) => {
            const err = Object.assign(new Error("ER_DUP_ENTRY"), {
              code: "ER_DUP_ENTRY",
            });
            return Promise.reject(err).catch(reject);
          },
        }),
      }),
    });
    await expect(
      createIdWorkset("scope-1", {
        name: "Conflict",
        csgIds: ["CSG-001"],
        createdByUserId: 5,
      })
    ).rejects.toBeInstanceOf(IdWorksetNameConflictError);
  });
});

describe("getIdWorkset", () => {
  it("returns null when no row matches", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const result = await getIdWorkset("scope-1", "ws-missing");
    expect(result).toBeNull();
  });

  it("parses csgIdsJson into a string[] on hit", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          {
            id: "ws-1",
            scopeId: "scope-1",
            createdByUserId: 5,
            lastEditedByUserId: null,
            name: "Found",
            description: "desc",
            csgIdsJson: '["A","B","C"]',
            csgIdCount: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ])
    );
    const result = await getIdWorkset("scope-1", "ws-1");
    expect(result?.csgIds).toEqual(["A", "B", "C"]);
    expect(result?.description).toBe("desc");
  });

  it("returns empty csgIds when the JSON is malformed (defensive)", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          {
            id: "ws-bad",
            scopeId: "scope-1",
            createdByUserId: 5,
            lastEditedByUserId: null,
            name: "Bad",
            description: null,
            csgIdsJson: "{not json",
            csgIdCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ])
    );
    const result = await getIdWorkset("scope-1", "ws-bad");
    expect(result?.csgIds).toEqual([]);
  });
});

describe("listIdWorksets", () => {
  it("returns summaries (no csgIds)", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          {
            id: "ws-1",
            scopeId: "scope-1",
            name: "first",
            description: null,
            csgIdCount: 5,
            createdByUserId: 1,
            lastEditedByUserId: 2,
            createdAt: new Date("2026-04-27T00:00:00Z"),
            updatedAt: new Date("2026-04-28T00:00:00Z"),
          },
          {
            id: "ws-2",
            scopeId: "scope-1",
            name: "second",
            description: "another",
            csgIdCount: 12,
            createdByUserId: 3,
            lastEditedByUserId: null,
            createdAt: new Date("2026-04-26T00:00:00Z"),
            updatedAt: new Date("2026-04-26T00:00:00Z"),
          },
        ],
      ])
    );
    const result = await listIdWorksets("scope-1");
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("ws-1");
    // Summary shape — `csgIds` not present
    expect((result[0] as Record<string, unknown>).csgIds).toBeUndefined();
    expect(result[1].csgIdCount).toBe(12);
  });

  it("returns empty array when scope has no worksets", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const result = await listIdWorksets("scope-empty");
    expect(result).toEqual([]);
  });
});

describe("updateIdWorkset", () => {
  it("updates name + csgIds and returns the post-update detail", async () => {
    const after: StubRow = {
      id: "ws-1",
      scopeId: "scope-1",
      createdByUserId: 5,
      lastEditedByUserId: 6,
      name: "Renamed",
      description: null,
      csgIdsJson: '["X","Y"]',
      csgIdCount: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. existing-row read
        [
          {
            id: "ws-1",
            scopeId: "scope-1",
            createdByUserId: 5,
            lastEditedByUserId: null,
            name: "Original",
            description: null,
            csgIdsJson: '["A","B","C"]',
            csgIdCount: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        // 2. update
        [],
        // 3. read-back
        [after],
      ])
    );
    const result = await updateIdWorkset("scope-1", "ws-1", {
      name: "Renamed",
      csgIds: ["X", "Y", "X"],
      editedByUserId: 6,
    });
    expect(result.name).toBe("Renamed");
    expect(result.csgIds).toEqual(["X", "Y"]);
    expect(result.lastEditedByUserId).toBe(6);
  });

  it("throws IdWorksetNotFoundError when (scopeId, id) is missing", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    await expect(
      updateIdWorkset("scope-1", "ghost", {
        name: "X",
        editedByUserId: 1,
      })
    ).rejects.toBeInstanceOf(IdWorksetNotFoundError);
  });
});

describe("deleteIdWorkset", () => {
  it("returns true when the row exists and gets deleted", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          {
            id: "ws-1",
            scopeId: "scope-1",
            createdByUserId: 5,
            lastEditedByUserId: null,
            name: "X",
            description: null,
            csgIdsJson: "[]",
            csgIdCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        // delete (no rows returned)
        [],
      ])
    );
    const result = await deleteIdWorkset("scope-1", "ws-1");
    expect(result).toBe(true);
  });

  it("returns false when the row doesn't exist (no delete attempted)", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const result = await deleteIdWorkset("scope-1", "ghost");
    expect(result).toBe(false);
  });
});

describe("appendCsgIdsToWorkset", () => {
  it("merges existing IDs with new IDs preserving order, dedupes, and returns post-append detail", async () => {
    const existing: StubRow = {
      id: "ws-1",
      scopeId: "scope-1",
      createdByUserId: 5,
      lastEditedByUserId: null,
      name: "Set",
      description: null,
      csgIdsJson: '["A","B","C"]',
      csgIdCount: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const after: StubRow = {
      ...existing,
      lastEditedByUserId: 7,
      csgIdsJson: '["A","B","C","D","E"]',
      csgIdCount: 5,
    };
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. read existing inside append
        [existing],
        // 2. read existing inside the inner updateIdWorkset call
        [existing],
        // 3. update statement
        [],
        // 4. read-back inside updateIdWorkset
        [after],
      ])
    );
    const result = await appendCsgIdsToWorkset("scope-1", "ws-1", {
      csgIds: ["C", "D", "E", "A"],
      editedByUserId: 7,
    });
    expect(result.csgIds).toEqual(["A", "B", "C", "D", "E"]);
    expect(result.lastEditedByUserId).toBe(7);
  });

  it("throws IdWorksetNotFoundError when the workset doesn't exist", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    await expect(
      appendCsgIdsToWorkset("scope-1", "ghost", {
        csgIds: ["A"],
        editedByUserId: 1,
      })
    ).rejects.toBeInstanceOf(IdWorksetNotFoundError);
  });
});
