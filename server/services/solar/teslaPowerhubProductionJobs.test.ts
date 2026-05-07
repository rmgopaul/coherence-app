/**
 * Tesla Powerhub production-jobs runner — DB-backed tests.
 *
 * Mirrors the `dashboardCsvExportJobs.test.ts` fake-DB pattern:
 * `vi.mock` the DB helper module with an in-test `fakeDb` array
 * that faithfully implements the helper contract (atomic claim,
 * scope-aware reads, predicated UPDATEs that no-op on miss). The
 * Tesla Powerhub fetch (`getTeslaPowerhubProductionMetrics`) is
 * mocked directly so the worker can be exercised without a live
 * Tesla API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ────────────────────────────────────────────────────────────────────
// Fake DB
// ────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  scopeId: string;
  createdBy: number | null;
  config: unknown;
  status: "queued" | "running" | "completed" | "failed";
  progressJson: unknown;
  resultJson: string | null;
  errorMessage: string | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  runnerVersion: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

const fakeDb: FakeRow[] = [];
function fakeReset(): void {
  fakeDb.length = 0;
}
function fakeFind(scopeId: string, id: string): FakeRow | undefined {
  return fakeDb.find(r => r.scopeId === scopeId && r.id === id);
}
function fakeFindById(id: string): FakeRow | undefined {
  return fakeDb.find(r => r.id === id);
}

vi.mock("../../db/teslaPowerhubProductionJobs", () => ({
  insertTeslaPowerhubProductionJob: vi.fn(async (entry: Partial<FakeRow>) => {
    const now = new Date();
    fakeDb.push({
      id: entry.id ?? "",
      scopeId: entry.scopeId ?? "",
      createdBy: entry.createdBy ?? null,
      config: entry.config ?? {},
      status: (entry.status ?? "queued") as FakeRow["status"],
      progressJson: entry.progressJson ?? null,
      resultJson: null,
      errorMessage: null,
      claimedBy: null,
      claimedAt: null,
      runnerVersion: entry.runnerVersion ?? "test",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    });
  }),
  getTeslaPowerhubProductionJob: vi.fn(
    async (scopeId: string, id: string): Promise<FakeRow | null> => {
      const row = fakeFind(scopeId, id);
      return row ? { ...row } : null;
    }
  ),
  getTeslaPowerhubProductionJobById: vi.fn(
    async (id: string): Promise<FakeRow | null> => {
      const row = fakeFindById(id);
      return row ? { ...row } : null;
    }
  ),
  listRecentTeslaPowerhubProductionJobs: vi.fn(
    async (scopeId: string): Promise<FakeRow[]> =>
      fakeDb
        .filter(r => r.scopeId === scopeId)
        .map(r => ({ ...r }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  ),
  claimTeslaPowerhubProductionJob: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      staleClaimBefore: Date,
      runnerVersion: string
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      const queuedOk = row.status === "queued";
      const staleOk =
        row.status === "running" &&
        row.claimedAt !== null &&
        row.claimedAt < staleClaimBefore;
      if (!queuedOk && !staleOk) return false;
      const now = new Date();
      row.status = "running";
      row.claimedBy = claimedBy;
      row.claimedAt = now;
      row.startedAt = now;
      row.runnerVersion = runnerVersion;
      row.updatedAt = now;
      return true;
    }
  ),
  refreshTeslaPowerhubProductionJobClaim: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      const now = new Date();
      row.claimedAt = now;
      row.updatedAt = now;
      return true;
    }
  ),
  updateTeslaPowerhubProductionJobProgress: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      progress: unknown
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      row.progressJson = progress;
      row.updatedAt = new Date();
      return true;
    }
  ),
  completeTeslaPowerhubProductionJobSuccess: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      fields: { resultJson: string; finalProgress: unknown }
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      const now = new Date();
      row.status = "completed";
      row.finishedAt = now;
      row.resultJson = fields.resultJson;
      row.progressJson = fields.finalProgress;
      row.errorMessage = null;
      row.updatedAt = now;
      return true;
    }
  ),
  completeTeslaPowerhubProductionJobFailure: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      fields: { errorMessage: string; finalProgress: unknown }
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      const now = new Date();
      row.status = "failed";
      row.finishedAt = now;
      row.errorMessage = fields.errorMessage;
      row.progressJson = fields.finalProgress;
      row.updatedAt = now;
      return true;
    }
  ),
  failStaleTeslaPowerhubProductionJobs: vi.fn(
    async (staleClaimBefore: Date): Promise<number> => {
      let n = 0;
      const now = new Date();
      for (const row of fakeDb) {
        if (
          row.status === "running" &&
          row.claimedAt !== null &&
          row.claimedAt < staleClaimBefore
        ) {
          row.status = "failed";
          row.finishedAt = now;
          row.errorMessage =
            "stale claim — Tesla Powerhub production worker did not complete the job";
          row.updatedAt = now;
          n++;
        }
      }
      return n;
    }
  ),
  pruneTerminalTeslaPowerhubProductionJobs: vi.fn(
    async (olderThan: Date): Promise<FakeRow[]> => {
      const doomed = fakeDb.filter(
        r =>
          (r.status === "completed" || r.status === "failed") &&
          r.finishedAt !== null &&
          r.finishedAt < olderThan
      );
      for (const d of doomed) {
        const idx = fakeDb.indexOf(d);
        if (idx >= 0) fakeDb.splice(idx, 1);
      }
      return doomed.map(r => ({ ...r }));
    }
  ),
}));

// Mock the Tesla Powerhub HTTP fetch — the runner consumes its
// result, not the live API.
vi.mock("./teslaPowerhub", () => ({
  getTeslaPowerhubProductionMetrics: vi.fn(),
}));

import {
  TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
  __TEST_ONLY__,
  startTeslaPowerhubProductionJob,
  runTeslaPowerhubProductionJob,
  getTeslaPowerhubProductionJobSnapshot,
  debugTeslaPowerhubProductionJobs,
  type TeslaPowerhubProductionJobSnapshot,
} from "./teslaPowerhubProductionJobs";
import * as teslaPowerhubMock from "./teslaPowerhub";

const SCOPE = "scope-A";
const OTHER_SCOPE = "scope-B";

const fakeApiContext = {
  bearerToken: "test-token",
  baseUrl: "https://example.tesla.test",
  fetchImpl: vi.fn(),
  // The runner only forwards apiContext to
  // getTeslaPowerhubProductionMetrics; the mocked fetch never reads
  // these fields.
} as unknown as Parameters<
  typeof startTeslaPowerhubProductionJob
>[0]["apiContext"];

beforeEach(() => {
  fakeReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// start
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — start", () => {
  it("inserts a queued row + returns a snapshot-shaped result", async () => {
    const result = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 7,
        apiContext: fakeApiContext,
        groupId: "g-1",
        endpointUrl: "https://endpoint.example",
        signal: "v1",
      },
      async () => {
        /* no-op runner */
      },
      () => {
        /* no-op scheduler */
      }
    );

    expect(result.jobId).toMatch(/.+/);
    expect(result.status).toBe("queued");
    expect(result._runnerVersion).toBe(
      TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
    );

    const row = fakeFindById(result.jobId)!;
    expect(row.scopeId).toBe(SCOPE);
    expect(row.status).toBe("queued");
    expect(row.config).toEqual({
      groupId: "g-1",
      endpointUrl: "https://endpoint.example",
      signal: "v1",
      scanMode: "standard",
    });
    expect(row.runnerVersion).toBe(
      TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
    );
  });

  it("schedules the runner via the injected scheduler", async () => {
    let runnerCalls = 0;
    let schedulerCalls = 0;
    await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: null,
        apiContext: fakeApiContext,
      },
      async () => {
        runnerCalls += 1;
      },
      cb => {
        schedulerCalls += 1;
        cb();
      }
    );

    expect(schedulerCalls).toBe(1);
    expect(runnerCalls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// runner
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — runner", () => {
  it("claims, runs, and marks completed with serialized result", async () => {
    const fakeResult = {
      sites: [{ siteId: "s1", energyProducedWh: 100 }],
      windows: [],
      debug: null,
    };
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValueOnce(fakeResult);

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
        groupId: "g-1",
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    const row = fakeFindById(jobId)!;
    expect(row.status).toBe("completed");
    expect(row.errorMessage).toBeNull();
    expect(JSON.parse(row.resultJson!)).toEqual(fakeResult);
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("uses bounded standard scan options by default", async () => {
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValueOnce({ sites: [], windows: [], debug: null });

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    expect(
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics
    ).toHaveBeenCalledWith(
      fakeApiContext,
      expect.objectContaining({
        fetchExternalIds: true,
        includeDebugPreviews: false,
        perSiteGapFillMode: "group-only",
      })
    );
  });

  it("preserves the previous deep scan behavior when requested", async () => {
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValueOnce({ sites: [], windows: [], debug: null });

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
        scanMode: "deep",
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    expect(
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics
    ).toHaveBeenCalledWith(
      fakeApiContext,
      expect.objectContaining({
        fetchExternalIds: true,
        includeDebugPreviews: true,
        perSiteGapFillMode: "deep",
      })
    );
  });

  it("marks failed with the error message on a thrown fetch", async () => {
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValueOnce(new Error("boom"));

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    const row = fakeFindById(jobId)!;
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("boom");
    expect(row.resultJson).toBeNull();
  });

  it("formats global-timeout errors with actionable copy", async () => {
    const err = new Error("Operation aborted due to timeout");
    err.name = "TimeoutError";
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValueOnce(err);

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    const row = fakeFindById(jobId)!;
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toMatch(/exceeded \d+ minutes/i);
    expect(row.errorMessage).toMatch(/group ID or endpoint override/i);
  });

  it("noops if the row was already claimed by a different worker", async () => {
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue({ sites: [], windows: [], debug: null });

    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: null,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );

    // Another worker already claimed it.
    const row = fakeFindById(jobId)!;
    row.status = "running";
    row.claimedBy = "pid-other-host-x-deadbeef";
    row.claimedAt = new Date();

    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    // Foreign claim preserved; this worker did not advance state.
    expect(row.status).toBe("running");
    expect(row.claimedBy).toBe("pid-other-host-x-deadbeef");
  });
});

// ────────────────────────────────────────────────────────────────────
// snapshot reconstruction
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — snapshot", () => {
  it("returns null for a missing id and null for cross-scope reads", async () => {
    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: null,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );

    expect(
      await getTeslaPowerhubProductionJobSnapshot(SCOPE, "missing")
    ).toBeNull();
    expect(
      await getTeslaPowerhubProductionJobSnapshot(OTHER_SCOPE, jobId)
    ).toBeNull();
  });

  it("reconstructs a queued snapshot with default progress + carried config", async () => {
    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 9,
        apiContext: fakeApiContext,
        groupId: "g-99",
        endpointUrl: null,
        signal: null,
      },
      async () => undefined,
      () => undefined
    );

    const snap = (await getTeslaPowerhubProductionJobSnapshot(
      SCOPE,
      jobId
    )) as TeslaPowerhubProductionJobSnapshot;
    expect(snap.id).toBe(jobId);
    expect(snap.status).toBe("queued");
    expect(snap.config).toEqual({
      groupId: "g-99",
      endpointUrl: null,
      signal: null,
      scanMode: "standard",
    });
    expect(snap.progress.percent).toBe(0);
    expect(snap.progress.message).toBe("Queued");
    expect(snap.result).toBeNull();
    expect(snap.error).toBeNull();
    expect(snap._runnerVersion).toBe(
      TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
    );
  });

  it("reconstructs a completed snapshot with result + 100% progress", async () => {
    (
      teslaPowerhubMock.getTeslaPowerhubProductionMetrics as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValueOnce({
      sites: [{ siteId: "s-1" }, { siteId: "s-2" }],
      windows: [],
      debug: null,
    });
    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: 1,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    await runTeslaPowerhubProductionJob(jobId, fakeApiContext);

    const snap = (await getTeslaPowerhubProductionJobSnapshot(
      SCOPE,
      jobId
    )) as TeslaPowerhubProductionJobSnapshot;
    expect(snap.status).toBe("completed");
    expect(snap.progress.percent).toBe(100);
    expect(snap.progress.message).toBe("Completed");
    expect(snap.result).toBeTruthy();
    expect(snap.result!.sites.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// scope isolation
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — scope isolation", () => {
  it("never reveals a job to a different scope", async () => {
    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: null,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    expect(
      await getTeslaPowerhubProductionJobSnapshot(OTHER_SCOPE, jobId)
    ).toBeNull();
    const debug = await debugTeslaPowerhubProductionJobs(OTHER_SCOPE);
    expect(debug.jobs.find(j => j.id === jobId)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// stale-claim sweep + cross-process safety
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — stale claim recovery", () => {
  it("flips a running row whose claimedAt is older than STALE_CLAIM_MS to failed", async () => {
    const { jobId } = await startTeslaPowerhubProductionJob(
      {
        scopeId: SCOPE,
        createdBy: null,
        apiContext: fakeApiContext,
      },
      async () => undefined,
      () => undefined
    );
    const row = fakeFindById(jobId)!;
    row.status = "running";
    row.claimedBy = "pid-dead-x-aaaaaaaa";
    row.claimedAt = new Date(Date.now() - __TEST_ONLY__.STALE_CLAIM_MS - 1000);

    await __TEST_ONLY__.sweepStaleAndPruned();

    expect(row.status).toBe("failed");
    expect(row.errorMessage).toMatch(/stale claim/);
  });

  it("two workers racing for a queued claim only one wins", async () => {
    const dbHelpers = await import("../../db/teslaPowerhubProductionJobs");
    await dbHelpers.insertTeslaPowerhubProductionJob({
      id: "race",
      scopeId: SCOPE,
      createdBy: null,
      config: {} as never,
      status: "queued",
      runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
    });
    const staleClaimBefore = new Date(
      Date.now() - __TEST_ONLY__.STALE_CLAIM_MS
    );
    const [a, b] = await Promise.all([
      dbHelpers.claimTeslaPowerhubProductionJob(
        SCOPE,
        "race",
        "pid-A-host-x-aaaaaaaa",
        staleClaimBefore,
        TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
      ),
      dbHelpers.claimTeslaPowerhubProductionJob(
        SCOPE,
        "race",
        "pid-B-host-y-bbbbbbbb",
        staleClaimBefore,
        TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
      ),
    ]);
    expect([a, b].filter(r => r === true)).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// runner version + claim id
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — runner version + claim id", () => {
  it("exports the v3-db-backed runner version", () => {
    expect(TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION).toBe(
      "solar-rec-tesla-powerhub-production-job-v3-db-backed"
    );
  });

  it("claim id includes pid + host + suffix", () => {
    const id = __TEST_ONLY__.getClaimId();
    expect(id).toMatch(/^pid-\d+-host-.+-[0-9a-f]{8}$/);
    expect(__TEST_ONLY__.getClaimId()).toBe(id);
  });
});

// ────────────────────────────────────────────────────────────────────
// parser helpers
// ────────────────────────────────────────────────────────────────────

describe("teslaPowerhubProductionJobs — parsers", () => {
  it("parseProgress accepts a well-formed shape", () => {
    expect(
      __TEST_ONLY__.parseProgress({
        currentStep: 3,
        totalSteps: 8,
        percent: 38,
        message: "Fetching",
        windowKey: "2025-04",
      })
    ).toEqual({
      currentStep: 3,
      totalSteps: 8,
      percent: 38,
      message: "Fetching",
      windowKey: "2025-04",
    });
  });

  it("parseProgress falls back to defaults on garbage input", () => {
    expect(__TEST_ONLY__.parseProgress(null)).toEqual({
      currentStep: 0,
      totalSteps: 8,
      percent: 0,
      message: "Queued",
      windowKey: null,
    });
    expect(__TEST_ONLY__.parseProgress({ totally: "wrong" })).toEqual({
      currentStep: 0,
      totalSteps: 8,
      percent: 0,
      message: "",
      windowKey: null,
    });
  });

  it("parseConfig falls back to nulls on garbage input", () => {
    expect(__TEST_ONLY__.parseConfig(null)).toEqual({
      groupId: null,
      endpointUrl: null,
      signal: null,
      scanMode: "standard",
    });
  });

  it("parseResult returns null on JSON parse error", () => {
    expect(__TEST_ONLY__.parseResult("not-json")).toBeNull();
    expect(__TEST_ONLY__.parseResult(null)).toBeNull();
  });
});
