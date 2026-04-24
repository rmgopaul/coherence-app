import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db _core so we can feed `resolveEffectivePermission` canned rows
// without spinning up a real connection. The helper compose-and-query code
// paths call `withDbRetry(label, fn)` which we pass through unchanged, and
// `getDb()` which we replace with a stub that returns a builder chain.

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

import { resolveEffectivePermission } from "./solarRecPermissions";

type StubRow = Record<string, unknown> | null;

function makeDbStub(rowByQueryIndex: StubRow[]) {
  let idx = 0;
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: async () => {
      const row = rowByQueryIndex[idx] ?? null;
      idx += 1;
      return row ? [row] : [];
    },
  };
  return builder;
}

describe("resolveEffectivePermission", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.withDbRetry.mockReset();
    mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bypasses the matrix for the scope owner", async () => {
    // No DB reads should be needed at all — we pass scope + user via opts.
    mocks.getDb.mockImplementation(() => {
      throw new Error("getDb must not be called on scope-owner bypass");
    });
    const result = await resolveEffectivePermission(7, "scope-user-7", "contract-scanner", {
      scope: { id: "scope-user-7", ownerUserId: 7 },
      user: { id: 7, isScopeAdmin: false },
    });
    expect(result).toEqual({ level: "admin", isBypass: true });
  });

  it("bypasses the matrix for scope-admin users", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("getDb must not be called on scope-admin bypass");
    });
    const result = await resolveEffectivePermission(42, "scope-user-7", "contract-scanner", {
      scope: { id: "scope-user-7", ownerUserId: 7 },
      user: { id: 42, isScopeAdmin: true },
    });
    expect(result).toEqual({ level: "admin", isBypass: true });
  });

  it("returns `none` (no bypass) when the user has no matrix row", async () => {
    // Only one DB lookup expected: the getSolarRecUserModulePermission query.
    mocks.getDb.mockResolvedValue(makeDbStub([null]));
    const result = await resolveEffectivePermission(42, "scope-user-7", "contract-scanner", {
      scope: { id: "scope-user-7", ownerUserId: 7 },
      user: { id: 42, isScopeAdmin: false },
    });
    expect(result).toEqual({ level: "none", isBypass: false });
  });

  it("returns the row's permission when present", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        {
          id: "perm-1",
          userId: 42,
          scopeId: "scope-user-7",
          moduleKey: "contract-scanner",
          permission: "edit",
        },
      ])
    );
    const result = await resolveEffectivePermission(42, "scope-user-7", "contract-scanner", {
      scope: { id: "scope-user-7", ownerUserId: 7 },
      user: { id: 42, isScopeAdmin: false },
    });
    expect(result).toEqual({ level: "edit", isBypass: false });
  });

  it("looks up the scope-admin flag when only `user` is omitted", async () => {
    // Two DB lookups: the isScopeAdmin check (returning true → bypass) should
    // short-circuit the permission-row lookup.
    mocks.getDb.mockResolvedValue(makeDbStub([{ id: 42, isScopeAdmin: true }]));
    const result = await resolveEffectivePermission(42, "scope-user-7", "contract-scanner", {
      scope: { id: "scope-user-7", ownerUserId: 7 },
    });
    expect(result).toEqual({ level: "admin", isBypass: true });
  });
});
