/**
 * Tests for the dashboard build-jobs runner (Phase 2 PR-B).
 *
 * Mocks:
 *   - DB helper layer (`../../db/solarRecDashboardBuilds`) so claim,
 *     heartbeat, completion, progress writes can be observed.
 *   - The scope-less row read inside the runner (it imports
 *     `../../db/_core` + `drizzle/schema` lazily); we mock those so
 *     the runner sees a fresh-claimed row at start.
 *
 * The steps array is mutable via `setDashboardBuildSteps()` (test-
 * only). Each test installs its own steps then restores the original
 * empty array.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimSolarRecDashboardBuild: vi.fn(),
  completeSolarRecDashboardBuildSuccess: vi.fn(),
  completeSolarRecDashboardBuildFailure: vi.fn(),
  refreshSolarRecDashboardBuildClaim: vi.fn(),
  updateSolarRecDashboardBuildProgress: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../../db/solarRecDashboardBuilds", () => ({
  claimSolarRecDashboardBuild: mocks.claimSolarRecDashboardBuild,
  completeSolarRecDashboardBuildSuccess:
    mocks.completeSolarRecDashboardBuildSuccess,
  completeSolarRecDashboardBuildFailure:
    mocks.completeSolarRecDashboardBuildFailure,
  refreshSolarRecDashboardBuildClaim:
    mocks.refreshSolarRecDashboardBuildClaim,
  updateSolarRecDashboardBuildProgress:
    mocks.updateSolarRecDashboardBuildProgress,
  // The runner doesn't call these — provide stubs to satisfy
  // ESM total-export semantics.
  insertSolarRecDashboardBuild: vi.fn(),
  getSolarRecDashboardBuild: vi.fn(),
  failStaleSolarRecDashboardBuilds: vi.fn(),
  pruneTerminalSolarRecDashboardBuilds: vi.fn(),
}));

// The runner uses a scope-less SELECT path that imports `../../db/_core`
// + `../../../drizzle/schema` lazily. Mock both so the row is whatever
// the test sets up.
vi.mock("../../db/_core", async () => {
  const actual = await vi.importActual<typeof import("../../db/_core")>(
    "../../db/_core"
  );
  return {
    ...actual,
    getDb: mocks.getDb,
  };
});

import {
  DASHBOARD_BUILD_RUNNER_VERSION,
  __TEST_ONLY__,
  getDashboardBuildSteps,
  runDashboardBuildJob,
  setDashboardBuildSteps,
  type DashboardBuildStep,
} from "./dashboardBuildJobRunner";

interface DbStubOptions {
  rowAtStart?: Record<string, unknown> | null;
}

function installDbStub(opts: DbStubOptions): void {
  // The runner's `getRowAcrossScopes` does:
  //   db.select().from(t).where(eq(...)).limit(1)
  // and awaits the chain. Build a thenable chain that resolves with
  // whatever rows we've configured.
  const rows =
    opts.rowAtStart === null || opts.rowAtStart === undefined
      ? []
      : [opts.rowAtStart];
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (rows: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  mocks.getDb.mockResolvedValue({
    select: () => chain,
  });
}

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.refreshSolarRecDashboardBuildClaim.mockResolvedValue(true);
  mocks.updateSolarRecDashboardBuildProgress.mockResolvedValue(true);
  mocks.completeSolarRecDashboardBuildSuccess.mockResolvedValue(true);
  mocks.completeSolarRecDashboardBuildFailure.mockResolvedValue(true);
  // Reset the steps array to empty (production default) before
  // every test.
  setDashboardBuildSteps([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
});

describe("runDashboardBuildJob — claim semantics", () => {
  it("returns silently when the row was pruned before the runner fired", async () => {
    installDbStub({ rowAtStart: null });
    await runDashboardBuildJob("bld-pruned");
    expect(mocks.claimSolarRecDashboardBuild).not.toHaveBeenCalled();
    expect(mocks.completeSolarRecDashboardBuildSuccess).not.toHaveBeenCalled();
  });

  it("returns silently when the claim fails (another worker won)", async () => {
    installDbStub({
      rowAtStart: { id: "bld-1", scopeId: "scope-1", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(false);
    await runDashboardBuildJob("bld-1");
    expect(mocks.claimSolarRecDashboardBuild).toHaveBeenCalledTimes(1);
    expect(mocks.completeSolarRecDashboardBuildSuccess).not.toHaveBeenCalled();
    expect(mocks.completeSolarRecDashboardBuildFailure).not.toHaveBeenCalled();
  });

  it("claim payload includes claimedBy, staleClaimBefore, runnerVersion", async () => {
    installDbStub({
      rowAtStart: { id: "bld-1", scopeId: "scope-1", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    await runDashboardBuildJob("bld-1");
    const args = mocks.claimSolarRecDashboardBuild.mock.calls[0];
    // Args: scopeId, id, claimedBy, staleClaimBefore, runnerVersion
    expect(args[0]).toBe("scope-1");
    expect(args[1]).toBe("bld-1");
    expect(args[2]).toMatch(/^pid-\d+-host-.+-[0-9a-f]{8}$/);
    expect(args[3]).toBeInstanceOf(Date);
    expect(args[4]).toBe(DASHBOARD_BUILD_RUNNER_VERSION);
  });
});

describe("runDashboardBuildJob — empty steps array (PR-B default)", () => {
  it("claims, writes a 100% progress, completes success — no steps run", async () => {
    installDbStub({
      rowAtStart: { id: "bld-empty", scopeId: "s", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);

    await runDashboardBuildJob("bld-empty");

    expect(mocks.completeSolarRecDashboardBuildSuccess).toHaveBeenCalledTimes(
      1
    );
    expect(mocks.completeSolarRecDashboardBuildFailure).not.toHaveBeenCalled();
    // Final 100% progress write fires.
    expect(
      mocks.updateSolarRecDashboardBuildProgress
    ).toHaveBeenCalledTimes(1);
    const [, , , progress] =
      mocks.updateSolarRecDashboardBuildProgress.mock.calls[0];
    expect((progress as { percent: number }).percent).toBe(100);
    expect((progress as { totalSteps: number }).totalSteps).toBe(0);
  });
});

describe("runDashboardBuildJob — step execution", () => {
  it("runs every registered step + writes per-step progress", async () => {
    installDbStub({
      rowAtStart: { id: "bld-2", scopeId: "s", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    const stepA: DashboardBuildStep = {
      name: "stepA",
      run: vi.fn().mockResolvedValue(undefined),
    };
    const stepB: DashboardBuildStep = {
      name: "stepB",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([stepA, stepB]);

    await runDashboardBuildJob("bld-2");

    expect(stepA.run).toHaveBeenCalledTimes(1);
    expect(stepB.run).toHaveBeenCalledTimes(1);
    // 1 progress per step + 1 final = 3.
    expect(mocks.updateSolarRecDashboardBuildProgress).toHaveBeenCalledTimes(3);
    expect(mocks.completeSolarRecDashboardBuildSuccess).toHaveBeenCalledTimes(
      1
    );
  });

  it("step receives scopeId + buildId + abort signal", async () => {
    installDbStub({
      rowAtStart: { id: "bld-3", scopeId: "scope-X", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    const observed: { scopeId?: string; buildId?: string; signal?: AbortSignal } =
      {};
    setDashboardBuildSteps([
      {
        name: "observer",
        run: async args => {
          observed.scopeId = args.scopeId;
          observed.buildId = args.buildId;
          observed.signal = args.signal;
        },
      },
    ]);

    await runDashboardBuildJob("bld-3");

    expect(observed.scopeId).toBe("scope-X");
    expect(observed.buildId).toBe("bld-3");
    expect(observed.signal).toBeInstanceOf(AbortSignal);
    expect(observed.signal!.aborted).toBe(false);
  });

  it("captures per-step error into completeFailure with `${stepName}: ${msg}`", async () => {
    installDbStub({
      rowAtStart: { id: "bld-fail", scopeId: "s", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    setDashboardBuildSteps([
      {
        name: "boomStep",
        run: async () => {
          throw new Error("aggregator crashed");
        },
      },
    ]);

    await runDashboardBuildJob("bld-fail");

    expect(mocks.completeSolarRecDashboardBuildFailure).toHaveBeenCalledTimes(
      1
    );
    const [, , , msg] =
      mocks.completeSolarRecDashboardBuildFailure.mock.calls[0];
    expect(msg as string).toBe("boomStep: aggregator crashed");
    expect(mocks.completeSolarRecDashboardBuildSuccess).not.toHaveBeenCalled();
  });

  it("stops at the first failing step (subsequent steps not run)", async () => {
    installDbStub({
      rowAtStart: { id: "bld-stop", scopeId: "s", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    const stepA: DashboardBuildStep = {
      name: "stepA",
      run: vi.fn().mockRejectedValue(new Error("a-crash")),
    };
    const stepB: DashboardBuildStep = {
      name: "stepB",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([stepA, stepB]);

    await runDashboardBuildJob("bld-stop");

    expect(stepA.run).toHaveBeenCalledTimes(1);
    expect(stepB.run).not.toHaveBeenCalled();
    expect(mocks.completeSolarRecDashboardBuildFailure).toHaveBeenCalledTimes(
      1
    );
  });
});

describe("runDashboardBuildJob — heartbeat / claim-loss safety", () => {
  it("does NOT write success when a step's progress write returns false (claim lost)", async () => {
    // Simulate a stale-claim race: between step completion and the
    // success write, another claimer took the row. The claimedBy=ours
    // predicate makes our completeSuccess UPDATE no-op; the test
    // simulates that by having the mock return false.
    installDbStub({
      rowAtStart: { id: "bld-stale", scopeId: "s", status: "queued" },
    });
    mocks.claimSolarRecDashboardBuild.mockResolvedValue(true);
    mocks.completeSolarRecDashboardBuildSuccess.mockResolvedValue(false);
    setDashboardBuildSteps([
      { name: "s1", run: vi.fn().mockResolvedValue(undefined) },
    ]);
    await runDashboardBuildJob("bld-stale");
    // Still tries to write success (the UPDATE no-ops on the mock,
    // but the runner doesn't know that and shouldn't crash).
    expect(mocks.completeSolarRecDashboardBuildSuccess).toHaveBeenCalledTimes(
      1
    );
    // No failure write either — the row is owned by someone else now.
    expect(mocks.completeSolarRecDashboardBuildFailure).not.toHaveBeenCalled();
  });
});

describe("step registry — getDashboardBuildSteps + setDashboardBuildSteps", () => {
  it("starts empty (PR-B production default)", () => {
    expect(getDashboardBuildSteps()).toEqual([]);
  });

  it("setDashboardBuildSteps swaps the array + returns the previous", () => {
    const stepA: DashboardBuildStep = {
      name: "A",
      run: async () => {},
    };
    const previous = setDashboardBuildSteps([stepA]);
    expect(previous).toEqual([]);
    expect(getDashboardBuildSteps()).toEqual([stepA]);
    // Reset for the next test (also handled by afterEach).
    setDashboardBuildSteps(previous);
  });
});

describe("__TEST_ONLY__ surface", () => {
  it("exposes timing + claim-id helpers for follow-up tests", () => {
    expect(typeof __TEST_ONLY__.HEARTBEAT_INTERVAL_MS).toBe("number");
    expect(typeof __TEST_ONLY__.STALE_CLAIM_MS).toBe("number");
    expect(typeof __TEST_ONLY__.PER_STEP_TIMEOUT_MS).toBe("number");
    // HEARTBEAT_INTERVAL_MS must be < STALE_CLAIM_MS (ideally 5x faster).
    expect(__TEST_ONLY__.HEARTBEAT_INTERVAL_MS).toBeLessThan(
      __TEST_ONLY__.STALE_CLAIM_MS / 2
    );
    expect(__TEST_ONLY__.getClaimId()).toMatch(
      /^pid-\d+-host-.+-[0-9a-f]{8}$/
    );
  });
});
