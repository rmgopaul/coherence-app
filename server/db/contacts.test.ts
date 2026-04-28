/**
 * Phase E (2026-04-28) — tests for personal contacts db helpers.
 *
 * Mocks `_core` getDb + withDbRetry. Each helper either issues a
 * SELECT / UPDATE / INSERT / DELETE and the stub records the
 * terminal call so we can assert on shape (whereCalled count,
 * setValue payload, affectedRows fallback).
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
  archivePersonalContact,
  deletePersonalContact,
  insertPersonalContact,
  listPersonalContacts,
  recordPersonalContactEvent,
  updatePersonalContact,
} from "./contacts";

interface BuilderCall {
  kind: "select" | "update" | "insert" | "delete";
  whereCalled: number;
  setValue?: Record<string, unknown>;
  insertValues?: unknown;
  orderByCount?: number;
}

function makeDbStub(opts: {
  selectRows?: Record<string, unknown>[][];
  updateAffected?: number;
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

  function makeInsertChain(): Record<string, unknown> {
    const call: BuilderCall = { kind: "insert", whereCalled: 0 };
    calls.push(call);
    return {
      values: (v: unknown) => {
        call.insertValues = v;
        return Promise.resolve();
      },
    };
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
    update: () => makeUpdateChain(),
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

describe("listPersonalContacts", () => {
  it("returns the rows the stub yields", async () => {
    const rows = [{ id: "a", userId: 1, name: "Alice" }];
    const stub = makeDbStub({ selectRows: [rows] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await listPersonalContacts(1);
    expect(result).toEqual(rows);
  });

  it("returns empty array when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    const result = await listPersonalContacts(1);
    expect(result).toEqual([]);
  });

  it("issues exactly one WHERE call (default = exclude archived)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listPersonalContacts(1);
    expect(stub.calls[0].whereCalled).toBe(1);
  });

  it("includes archived rows when opts.includeArchived is true", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listPersonalContacts(1, { includeArchived: true });
    // Same WHERE-call count; the difference is in the AND vs not-AND
    // condition inside the chain.
    expect(stub.calls[0].whereCalled).toBe(1);
  });

  it("issues a 2-key orderBy when sort=stale (lastContactedAt + name)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listPersonalContacts(1, { sort: "stale" });
    expect(stub.calls[0].orderByCount).toBe(1);
  });

  it("clamps the limit to a sane range", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      listPersonalContacts(1, { limit: 0 })
    ).resolves.toEqual([]);
    await expect(
      listPersonalContacts(1, { limit: 9999 })
    ).resolves.toEqual([]);
  });
});

describe("insertPersonalContact", () => {
  it("forwards the entry to db.insert(...).values(...)", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const entry = {
      id: "x",
      userId: 1,
      name: "Alice",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await insertPersonalContact(entry as never);
    const insertCall = stub.calls.find((c) => c.kind === "insert");
    expect(insertCall?.insertValues).toBe(entry);
  });

  it("is a no-op when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      insertPersonalContact({
        id: "x",
        userId: 1,
        name: "Alice",
      } as never)
    ).resolves.toBeUndefined();
  });
});

describe("updatePersonalContact", () => {
  it("returns false when the patch is empty", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    // Empty patch → no UPDATE, no SQL.
    const ok = await updatePersonalContact(1, "x", {});
    expect(ok).toBe(false);
    expect(stub.calls.length).toBe(0);
  });

  it("strips undefined fields but keeps explicit nulls", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    await updatePersonalContact(1, "x", {
      name: "Alice",
      email: null,
      phone: undefined,
      role: "Engineer",
    });
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall?.setValue?.name).toBe("Alice");
    expect(updateCall?.setValue?.email).toBeNull();
    expect(updateCall?.setValue?.role).toBe("Engineer");
    expect("phone" in (updateCall?.setValue ?? {})).toBe(false);
    // The helper always stamps updatedAt on a real patch.
    expect(updateCall?.setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns false when no row matched the (userId, id) pair", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updatePersonalContact(1, "missing", { name: "x" });
    expect(ok).toBe(false);
  });
});

describe("recordPersonalContactEvent", () => {
  it("stamps lastContactedAt to the provided now", async () => {
    const fixedNow = new Date("2026-04-28T12:00:00Z");
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await recordPersonalContactEvent(1, "x", fixedNow);
    expect(ok).toBe(true);
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall?.setValue?.lastContactedAt).toBe(fixedNow);
    expect(updateCall?.setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("clears lastContactedAt when null is passed", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await recordPersonalContactEvent(1, "x", null);
    expect(ok).toBe(true);
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall?.setValue?.lastContactedAt).toBeNull();
  });

  it("returns false when no row matched", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await recordPersonalContactEvent(1, "missing");
    expect(ok).toBe(false);
  });
});

describe("archivePersonalContact", () => {
  it("stamps archivedAt to a Date when archived=true", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await archivePersonalContact(1, "x", true);
    expect(ok).toBe(true);
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall?.setValue?.archivedAt).toBeInstanceOf(Date);
  });

  it("clears archivedAt when archived=false (restore path)", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await archivePersonalContact(1, "x", false);
    expect(ok).toBe(true);
    const updateCall = stub.calls.find((c) => c.kind === "update");
    expect(updateCall?.setValue?.archivedAt).toBeNull();
  });
});

describe("deletePersonalContact", () => {
  it("issues a DELETE scoped by both userId AND id", async () => {
    const stub = makeDbStub({ deleteAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await deletePersonalContact(1, "x");
    expect(ok).toBe(true);
    const deleteCall = stub.calls.find((c) => c.kind === "delete");
    expect(deleteCall?.whereCalled).toBe(1);
  });

  it("returns false when no row matched", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await deletePersonalContact(1, "missing");
    expect(ok).toBe(false);
  });
});
