/**
 * Tests for the solar REC dashboard build-jobs registry helpers
 * (Phase 2 PR-A — the OOM-rebuild keystone).
 *
 * Mocks `_core` getDb + withDbRetry via the established `vi.hoisted`
 * pattern. Each helper either issues a SELECT / UPDATE / INSERT /
 * DELETE; the stub records the terminal call so tests can assert
 * on shape (whereCalled count, setValue payload, affectedRows
 * fallback, insertValues forwarding).
 *
 * Mirrors `server/db/datasetUploadJobs.test.ts` so the test infra
 * stays uniform across the dashboard-job registries.
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
  claimSolarRecDashboardBuild,
  completeSolarRecDashboardBuildFailure,
  completeSolarRecDashboardBuildSuccess,
  failStaleSolarRecDashboardBuilds,
  getSolarRecDashboardBuild,
  insertSolarRecDashboardBuild,
  pruneTerminalSolarRecDashboardBuilds,
  refreshSolarRecDashboardBuildClaim,
  updateSolarRecDashboardBuildProgress,
} from "./solarRecDashboardBuilds";

interface BuilderCall {
  kind: "select" | "update" | "insert" | "delete";
  whereCalled: number;
  setValue?: Record<string, unknown>;
  insertValues?: unknown;
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
    const call: BuilderCall = { kind: "select", whereCalled: 0 };
    calls.push(call);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => {
        call.whereCalled += 1;
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

describe("insertSolarRecDashboardBuild", () => {
  it("forwards the row to db.insert(...).values(...)", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const entry = {
      id: "build-1",
      scopeId: "scope-1",
      createdBy: 42,
      inputVersionsJson: { solarApplications: "batch-1" },
      runnerVersion: "phase-2-pra@1",
    };
    await insertSolarRecDashboardBuild(entry as never);
    const call = stub.calls.find(c => c.kind === "insert");
    expect(call?.insertValues).toBe(entry);
  });

  it("throws when the DB is unavailable (registry is mandatory)", async () => {
    // Phase 6 contract — silently returning would let the runner
    // hand the client a buildId for a row that doesn't exist.
    mocks.getDb.mockResolvedValue(null);
    await expect(
      insertSolarRecDashboardBuild({
        id: "x",
        scopeId: "s",
        inputVersionsJson: {},
        runnerVersion: "v1",
      } as never)
    ).rejects.toThrow(/database unavailable/i);
  });
});

describe("getSolarRecDashboardBuild", () => {
  it("returns the row when present", async () => {
    const row = {
      id: "build-1",
      scopeId: "scope-1",
      status: "queued",
      runnerVersion: "v1",
    };
    const stub = makeDbStub({ selectRows: [[row]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getSolarRecDashboardBuild("scope-1", "build-1");
    expect(result).toEqual(row);
  });

  it("returns null when (scopeId, id) doesn't match (cross-scope safety)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getSolarRecDashboardBuild("scope-1", "missing");
    expect(result).toBeNull();
  });

  it("returns null when getDb yields null (no leak)", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await getSolarRecDashboardBuild("scope-1", "build-1")).toBeNull();
  });

  it("scopes the WHERE by both scopeId AND id (single where call)", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getSolarRecDashboardBuild("scope-1", "build-1");
    expect(stub.calls[0].whereCalled).toBe(1);
  });
});

describe("claimSolarRecDashboardBuild", () => {
  it("returns true when UPDATE affects exactly one row", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await claimSolarRecDashboardBuild(
      "scope-1",
      "build-1",
      "pid-12345-host-render-abc",
      new Date("2026-05-06T00:00:00Z"),
      "phase-2-pra@1"
    );
    expect(result).toBe(true);
  });

  it("returns false when no row matches the predicate (already claimed by another live worker)", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await claimSolarRecDashboardBuild(
        "scope-1",
        "build-1",
        "claimer-2",
        new Date(),
        "v1"
      )
    ).toBe(false);
  });

  it("sets status=running, claimedBy, claimedAt, startedAt, runnerVersion, updatedAt", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    await claimSolarRecDashboardBuild(
      "scope-1",
      "build-1",
      "pid-7-host-x",
      new Date("2026-05-06T00:00:00Z"),
      "phase-2-pra@1"
    );
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.status).toBe("running");
    expect(call?.setValue?.claimedBy).toBe("pid-7-host-x");
    expect(call?.setValue?.runnerVersion).toBe("phase-2-pra@1");
    // Timestamps set at "now" — assert they're Date instances.
    expect(call?.setValue?.claimedAt).toBeInstanceOf(Date);
    expect(call?.setValue?.startedAt).toBeInstanceOf(Date);
    expect(call?.setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns false when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await claimSolarRecDashboardBuild(
        "s",
        "i",
        "c",
        new Date(),
        "v"
      )
    ).toBe(false);
  });
});

describe("refreshSolarRecDashboardBuildClaim", () => {
  it("returns true when the heartbeat UPDATE affects one row", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await refreshSolarRecDashboardBuildClaim(
        "scope-1",
        "build-1",
        "claimer-1"
      )
    ).toBe(true);
  });

  it("returns false when the claim no longer matches (stale-replaced)", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await refreshSolarRecDashboardBuildClaim("s", "i", "c")
    ).toBe(false);
  });

  it("only updates claimedAt + updatedAt (NOT status, NOT startedAt, NOT runnerVersion)", async () => {
    // Heartbeat must NOT touch the runner-identity fields. Defends
    // against a regression where a heartbeat write resets startedAt
    // and inflates the claim window observed by the sweeper.
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    await refreshSolarRecDashboardBuildClaim("scope-1", "build-1", "c-1");
    const call = stub.calls.find(c => c.kind === "update");
    expect(Object.keys(call?.setValue ?? {}).sort()).toEqual(
      ["claimedAt", "updatedAt"].sort()
    );
  });
});

describe("completeSolarRecDashboardBuildSuccess", () => {
  it("returns true when UPDATE affects one row", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await completeSolarRecDashboardBuildSuccess(
        "scope-1",
        "build-1",
        "claimer-1"
      )
    ).toBe(true);
  });

  it("returns false when claimedBy mismatch (cross-process safety)", async () => {
    // Worker that lost its claim must NOT silently overwrite the
    // new claimer's terminal state — the claimedBy=ours predicate
    // protects this.
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await completeSolarRecDashboardBuildSuccess(
        "s",
        "i",
        "stale-claimer"
      )
    ).toBe(false);
  });

  it("sets status=succeeded + completedAt + updatedAt", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    await completeSolarRecDashboardBuildSuccess(
      "scope-1",
      "build-1",
      "claimer-1"
    );
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.status).toBe("succeeded");
    expect(call?.setValue?.completedAt).toBeInstanceOf(Date);
    expect(call?.setValue?.updatedAt).toBeInstanceOf(Date);
  });
});

describe("completeSolarRecDashboardBuildFailure", () => {
  it("returns true when UPDATE affects one row + records errorMessage", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await completeSolarRecDashboardBuildFailure(
        "scope-1",
        "build-1",
        "claimer-1",
        "boom: out of memory"
      )
    ).toBe(true);
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.status).toBe("failed");
    expect(call?.setValue?.errorMessage).toBe("boom: out of memory");
    expect(call?.setValue?.completedAt).toBeInstanceOf(Date);
  });

  it("returns false when claimedBy mismatch (cross-process safety)", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await completeSolarRecDashboardBuildFailure(
        "s",
        "i",
        "stale",
        "err"
      )
    ).toBe(false);
  });
});

describe("updateSolarRecDashboardBuildProgress", () => {
  it("forwards progressJson + updatedAt; no status / claim mutation", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const progress = {
      currentStep: 2,
      totalSteps: 4,
      percent: 50,
      message: "Building systemFacts",
      factTable: "systemFacts",
    };
    expect(
      await updateSolarRecDashboardBuildProgress(
        "scope-1",
        "build-1",
        "claimer-1",
        progress
      )
    ).toBe(true);
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.progressJson).toBe(progress);
    expect(Object.keys(call?.setValue ?? {}).sort()).toEqual(
      ["progressJson", "updatedAt"].sort()
    );
  });

  it("returns false when claimedBy mismatch (no-op on stale claim)", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await updateSolarRecDashboardBuildProgress(
        "s",
        "i",
        "stale",
        { currentStep: 1, totalSteps: 4 }
      )
    ).toBe(false);
  });
});

describe("pruneTerminalSolarRecDashboardBuilds", () => {
  it("returns [] when nothing matches the cutoff", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneTerminalSolarRecDashboardBuilds(
      new Date("2026-05-01T00:00:00Z")
    );
    expect(result).toEqual([]);
    // Only the SELECT fired — no DELETE because nothing was doomed.
    expect(stub.calls.filter(c => c.kind === "delete")).toHaveLength(0);
  });

  it("returns the doomed rows + issues a DELETE when matches found", async () => {
    const doomed = [
      {
        id: "build-old-1",
        scopeId: "s",
        status: "succeeded",
        completedAt: new Date("2026-04-01T00:00:00Z"),
      },
      {
        id: "build-old-2",
        scopeId: "s",
        status: "failed",
        completedAt: new Date("2026-04-15T00:00:00Z"),
      },
    ];
    const stub = makeDbStub({ selectRows: [doomed], deleteAffected: 2 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await pruneTerminalSolarRecDashboardBuilds(
      new Date("2026-05-01T00:00:00Z")
    );
    expect(result).toEqual(doomed);
    // DELETE was issued exactly once.
    expect(stub.calls.filter(c => c.kind === "delete")).toHaveLength(1);
  });

  it("returns [] when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(
      await pruneTerminalSolarRecDashboardBuilds(new Date())
    ).toEqual([]);
  });
});

describe("failStaleSolarRecDashboardBuilds", () => {
  it("returns the affected-row count + sets the canonical stale message", async () => {
    const stub = makeDbStub({ updateAffected: 3 });
    mocks.getDb.mockResolvedValue(stub);
    const result = await failStaleSolarRecDashboardBuilds(
      new Date("2026-05-06T00:00:00Z")
    );
    expect(result).toBe(3);
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.status).toBe("failed");
    expect(call?.setValue?.errorMessage).toMatch(/stale claim/i);
    expect(call?.setValue?.completedAt).toBeInstanceOf(Date);
  });

  it("returns 0 when no row matches the cutoff", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    expect(
      await failStaleSolarRecDashboardBuilds(new Date())
    ).toBe(0);
  });

  it("returns 0 when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await failStaleSolarRecDashboardBuilds(new Date())).toBe(0);
  });
});
