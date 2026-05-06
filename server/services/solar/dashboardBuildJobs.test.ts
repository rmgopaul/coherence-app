/**
 * Tests for the dashboard build-jobs service layer (Phase 2 PR-B).
 *
 * Mocks the DB helper layer (`../../db/solarRecDashboardBuilds`)
 * so tests assert on the service-layer orchestration without
 * needing a live DB. Mocking strategy mirrors the existing
 * `dashboardCsvExportJobs.test.ts` pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertSolarRecDashboardBuild: vi.fn(),
  getSolarRecDashboardBuild: vi.fn(),
  failStaleSolarRecDashboardBuilds: vi.fn(),
  pruneTerminalSolarRecDashboardBuilds: vi.fn(),
}));

vi.mock("../../db/solarRecDashboardBuilds", () => ({
  insertSolarRecDashboardBuild: mocks.insertSolarRecDashboardBuild,
  getSolarRecDashboardBuild: mocks.getSolarRecDashboardBuild,
  failStaleSolarRecDashboardBuilds: mocks.failStaleSolarRecDashboardBuilds,
  pruneTerminalSolarRecDashboardBuilds:
    mocks.pruneTerminalSolarRecDashboardBuilds,
  // Other exports (claim, complete, refresh, updateProgress) are
  // exercised by the runner tests via direct mocks there.
  claimSolarRecDashboardBuild: vi.fn(),
  completeSolarRecDashboardBuildSuccess: vi.fn(),
  completeSolarRecDashboardBuildFailure: vi.fn(),
  refreshSolarRecDashboardBuildClaim: vi.fn(),
  updateSolarRecDashboardBuildProgress: vi.fn(),
}));

import {
  __TEST_ONLY__,
  getDashboardBuildStatus,
  sweepStaleAndPrune,
  startDashboardBuild,
} from "./dashboardBuildJobs";
import { DASHBOARD_BUILD_RUNNER_VERSION } from "./dashboardBuildJobRunner";

beforeEach(() => {
  mocks.insertSolarRecDashboardBuild.mockReset();
  mocks.getSolarRecDashboardBuild.mockReset();
  mocks.failStaleSolarRecDashboardBuilds.mockReset();
  mocks.pruneTerminalSolarRecDashboardBuilds.mockReset();
  mocks.insertSolarRecDashboardBuild.mockResolvedValue(undefined);
  mocks.failStaleSolarRecDashboardBuilds.mockResolvedValue(0);
  mocks.pruneTerminalSolarRecDashboardBuilds.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startDashboardBuild", () => {
  it("inserts a queued row + schedules the runner; returns the buildId", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = vi.fn((cb: () => void) => cb());
    const { buildId } = await startDashboardBuild("scope-1", 42, {
      runner,
      scheduler,
    });
    expect(buildId).toMatch(/^bld-[0-9a-f]{32}$/);
    expect(mocks.insertSolarRecDashboardBuild).toHaveBeenCalledTimes(1);
    const [entry] = mocks.insertSolarRecDashboardBuild.mock.calls[0];
    expect(entry.id).toBe(buildId);
    expect(entry.scopeId).toBe("scope-1");
    expect(entry.createdBy).toBe(42);
    expect(entry.status).toBe("queued");
    expect(entry.runnerVersion).toBe(DASHBOARD_BUILD_RUNNER_VERSION);
    // Default inputVersions is an empty object (PR-B stub).
    expect(entry.inputVersionsJson).toEqual({});
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(buildId);
  });

  it("forwards inputVersions when provided (PR-C+ contract)", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = vi.fn((cb: () => void) => cb());
    const inputVersions = {
      solarApplications: "batch-app-1",
      transferHistory: "batch-th-1",
      abpReport: null,
    };
    await startDashboardBuild("scope-2", null, {
      runner,
      scheduler,
      inputVersions,
    });
    const [entry] = mocks.insertSolarRecDashboardBuild.mock.calls[0];
    expect(entry.inputVersionsJson).toBe(inputVersions);
    expect(entry.createdBy).toBeNull();
  });

  it("returns fast (mutation completes before runner finishes)", async () => {
    // Simulate a slow runner — the start mutation should not await it.
    // Track a resolver so the test can flush the deferred runner before
    // afterEach's restoreAllMocks resets the mock and the deferred
    // setImmediate callback's `run(buildId).catch(...)` chain blows up.
    let runnerResolve: (() => void) | null = null;
    const runnerPromise = new Promise<void>(r => {
      runnerResolve = r;
    });
    let runnerFired = false;
    const runner = vi.fn().mockImplementation(async () => {
      runnerFired = true;
      await runnerPromise;
    });
    const scheduler = vi.fn((cb: () => void) => setImmediate(cb));
    const { buildId } = await startDashboardBuild("scope-3", null, {
      runner,
      scheduler,
    });
    // The mutation has returned with the buildId. The runner has NOT
    // been called yet (setImmediate is deferred).
    expect(buildId).toBeTruthy();
    expect(runnerFired).toBe(false);
    // Now flush the deferred runner so the test doesn't leave an
    // unresolved promise pending past restoreAllMocks.
    await new Promise(r => setImmediate(r));
    expect(runnerFired).toBe(true);
    runnerResolve!();
    await runnerPromise;
  });

  it("logs (not throws) when the runner promise rejects post-schedule", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = vi
      .fn()
      .mockRejectedValue(new Error("runner blew up"));
    // Inline scheduler so the void run() fires synchronously.
    const scheduler = vi.fn((cb: () => void) => cb());
    await startDashboardBuild("scope-4", null, { runner, scheduler });
    // Allow the void promise rejection to flush.
    await new Promise(r => setImmediate(r));
    expect(errorSpy).toHaveBeenCalled();
    const [msg] = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];
    expect(String(msg)).toMatch(/runner threw outside row capture/);
  });
});

describe("getDashboardBuildStatus", () => {
  it("returns 'notFound' when the row doesn't exist (or is cross-scope)", async () => {
    mocks.getSolarRecDashboardBuild.mockResolvedValue(null);
    const result = await getDashboardBuildStatus("scope-1", "missing");
    expect(result.status).toBe("notFound");
    expect(result.buildId).toBe("missing");
    expect(result.progress).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.runnerVersion).toBe(DASHBOARD_BUILD_RUNNER_VERSION);
  });

  it("returns the snapshot when the row exists", async () => {
    const createdAt = new Date("2026-05-06T10:00:00Z");
    const startedAt = new Date("2026-05-06T10:00:01Z");
    const completedAt = new Date("2026-05-06T10:00:30Z");
    mocks.getSolarRecDashboardBuild.mockResolvedValue({
      id: "bld-1",
      scopeId: "scope-1",
      status: "succeeded",
      progressJson: {
        currentStep: 4,
        totalSteps: 4,
        percent: 100,
        message: "Build complete",
        factTable: null,
      },
      errorMessage: null,
      createdAt,
      startedAt,
      completedAt,
      runnerVersion: "test-runner@1",
    });
    const result = await getDashboardBuildStatus("scope-1", "bld-1");
    expect(result.status).toBe("succeeded");
    expect(result.buildId).toBe("bld-1");
    expect(result.progress).toEqual({
      currentStep: 4,
      totalSteps: 4,
      percent: 100,
      message: "Build complete",
      factTable: null,
    });
    expect(result.createdAt).toBe(createdAt.toISOString());
    expect(result.startedAt).toBe(startedAt.toISOString());
    expect(result.completedAt).toBe(completedAt.toISOString());
    expect(result.runnerVersion).toBe("test-runner@1");
  });

  it("re-schedules the runner when the row is still queued (orphan-rescue)", async () => {
    mocks.getSolarRecDashboardBuild.mockResolvedValue({
      id: "bld-q",
      scopeId: "scope-1",
      status: "queued",
      progressJson: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      runnerVersion: "v1",
    });
    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = vi.fn((cb: () => void) => cb());
    await getDashboardBuildStatus("scope-1", "bld-q", { runner, scheduler });
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("bld-q");
  });

  it("does NOT re-schedule the runner for terminal rows", async () => {
    mocks.getSolarRecDashboardBuild.mockResolvedValue({
      id: "bld-t",
      scopeId: "scope-1",
      status: "succeeded",
      progressJson: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      runnerVersion: "v1",
    });
    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = vi.fn((cb: () => void) => cb());
    await getDashboardBuildStatus("scope-1", "bld-t", { runner, scheduler });
    expect(scheduler).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("opportunistically fires the prune + stale-claim sweep on every read", async () => {
    mocks.getSolarRecDashboardBuild.mockResolvedValue(null);
    await getDashboardBuildStatus("scope-1", "x");
    expect(mocks.failStaleSolarRecDashboardBuilds).toHaveBeenCalledTimes(1);
    expect(
      mocks.pruneTerminalSolarRecDashboardBuilds
    ).toHaveBeenCalledTimes(1);
  });

  it("surfaces 'failed' status with the errorMessage intact", async () => {
    mocks.getSolarRecDashboardBuild.mockResolvedValue({
      id: "bld-f",
      scopeId: "scope-1",
      status: "failed",
      progressJson: null,
      errorMessage: "monitoringDetails: out of memory",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      runnerVersion: "v1",
    });
    const result = await getDashboardBuildStatus("scope-1", "bld-f");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("monitoringDetails: out of memory");
  });
});

describe("sweepStaleAndPrune", () => {
  it("returns counts from both DB helpers", async () => {
    mocks.failStaleSolarRecDashboardBuilds.mockResolvedValue(2);
    mocks.pruneTerminalSolarRecDashboardBuilds.mockResolvedValue([
      { id: "a" } as never,
      { id: "b" } as never,
      { id: "c" } as never,
    ]);
    const result = await sweepStaleAndPrune();
    expect(result).toEqual({ staleFailedCount: 2, prunedCount: 3 });
  });

  it("absorbs DB helper errors (logs warn, returns partial counts)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.failStaleSolarRecDashboardBuilds.mockRejectedValue(
      new Error("stale sweep failed")
    );
    mocks.pruneTerminalSolarRecDashboardBuilds.mockResolvedValue([
      { id: "x" } as never,
    ]);
    const result = await sweepStaleAndPrune();
    // Stale sweep failed → 0; prune still ran → 1.
    expect(result).toEqual({ staleFailedCount: 0, prunedCount: 1 });
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// __TEST_ONLY__ helpers — narrow shape checks
// ────────────────────────────────────────────────────────────────────

describe("buildSnapshot (test-only export)", () => {
  it("ISO-formats Date timestamps", () => {
    const row = {
      id: "bld-1",
      scopeId: "s",
      status: "running",
      progressJson: null,
      errorMessage: null,
      createdAt: new Date("2026-05-06T08:00:00Z"),
      startedAt: new Date("2026-05-06T08:00:01Z"),
      completedAt: null,
      runnerVersion: "v1",
    };
    const snap = __TEST_ONLY__.buildSnapshot(row as never);
    expect(snap.createdAt).toBe("2026-05-06T08:00:00.000Z");
    expect(snap.startedAt).toBe("2026-05-06T08:00:01.000Z");
    expect(snap.completedAt).toBeNull();
  });
});

describe("parseProgress (test-only export)", () => {
  it("returns the parsed shape on a valid record", () => {
    expect(
      __TEST_ONLY__.parseProgress({
        currentStep: 1,
        totalSteps: 4,
        percent: 25,
        message: "Building X",
        factTable: "monitoringDetails",
      })
    ).toEqual({
      currentStep: 1,
      totalSteps: 4,
      percent: 25,
      message: "Building X",
      factTable: "monitoringDetails",
    });
  });

  it("returns null when required numeric fields are missing or non-finite", () => {
    expect(__TEST_ONLY__.parseProgress(null)).toBeNull();
    expect(__TEST_ONLY__.parseProgress({})).toBeNull();
    expect(
      __TEST_ONLY__.parseProgress({ currentStep: "1", totalSteps: 4, percent: 25 })
    ).toBeNull();
    expect(
      __TEST_ONLY__.parseProgress({
        currentStep: NaN,
        totalSteps: 4,
        percent: 25,
      })
    ).toBeNull();
  });

  it("nulls non-string optional fields without rejecting the whole shape", () => {
    expect(
      __TEST_ONLY__.parseProgress({
        currentStep: 1,
        totalSteps: 4,
        percent: 25,
      })
    ).toEqual({
      currentStep: 1,
      totalSteps: 4,
      percent: 25,
      message: null,
      factTable: null,
    });
  });
});
