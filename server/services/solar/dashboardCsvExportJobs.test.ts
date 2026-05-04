/**
 * Focused unit tests for the dashboard CSV export job registry.
 *
 * Phase 6 PR-B (DB-backed registry). The service-layer functions
 * are now async and consume DB helpers in
 * `server/db/dashboardCsvExportJobs.ts`. We mock that module with
 * an in-test fake-DB so tests stay process-local and don't
 * require a live TiDB connection. The fake-DB faithfully
 * implements the helper contract (atomic claim, scope-aware
 * reads, predicated UPDATEs that no-op when the predicate misses)
 * so cross-process / claim-loss scenarios are testable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ────────────────────────────────────────────────────────────────────
// Fake DB (mocks `server/db/dashboardCsvExportJobs`)
// ────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  scopeId: string;
  input: unknown;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  fileName: string | null;
  artifactUrl: string | null;
  rowCount: number | null;
  csvBytes: number | null;
  errorMessage: string | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  runnerVersion: string;
  updatedAt: Date;
}

const fakeDb: FakeRow[] = [];

function fakeReset(): void {
  fakeDb.length = 0;
}

function fakeFind(scopeId: string, id: string): FakeRow | undefined {
  return fakeDb.find((r) => r.scopeId === scopeId && r.id === id);
}

function fakeFindById(id: string): FakeRow | undefined {
  return fakeDb.find((r) => r.id === id);
}

vi.mock("../../db/dashboardCsvExportJobs", () => ({
  insertDashboardCsvExportJob: vi.fn(async (entry: Partial<FakeRow>) => {
    const now = new Date();
    fakeDb.push({
      id: entry.id ?? "",
      scopeId: entry.scopeId ?? "",
      input: entry.input ?? null,
      status: (entry.status ?? "queued") as FakeRow["status"],
      createdAt: now,
      startedAt: null,
      completedAt: null,
      fileName: null,
      artifactUrl: null,
      rowCount: null,
      csvBytes: null,
      errorMessage: null,
      claimedBy: null,
      claimedAt: null,
      runnerVersion: entry.runnerVersion ?? "test",
      updatedAt: now,
    });
  }),
  getDashboardCsvExportJob: vi.fn(
    async (scopeId: string, id: string): Promise<FakeRow | null> => {
      const row = fakeFind(scopeId, id);
      return row ? { ...row } : null;
    }
  ),
  claimDashboardCsvExportJob: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      staleClaimBefore: Date
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
      row.updatedAt = now;
      return true;
    }
  ),
  completeDashboardCsvExportJobSuccess: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      fields: {
        fileName: string | null;
        artifactUrl: string | null;
        rowCount: number;
        csvBytes: number;
      }
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      const now = new Date();
      row.status = "succeeded";
      row.completedAt = now;
      row.fileName = fields.fileName;
      row.artifactUrl = fields.artifactUrl;
      row.rowCount = fields.rowCount;
      row.csvBytes = fields.csvBytes;
      row.updatedAt = now;
      return true;
    }
  ),
  completeDashboardCsvExportJobFailure: vi.fn(
    async (
      scopeId: string,
      id: string,
      claimedBy: string,
      errorMessage: string
    ): Promise<boolean> => {
      const row = fakeFind(scopeId, id);
      if (!row) return false;
      if (row.claimedBy !== claimedBy) return false;
      if (row.status !== "running") return false;
      const now = new Date();
      row.status = "failed";
      row.completedAt = now;
      row.errorMessage = errorMessage;
      row.updatedAt = now;
      return true;
    }
  ),
  pruneTerminalDashboardCsvExportJobs: vi.fn(
    async (olderThan: Date): Promise<FakeRow[]> => {
      const doomed = fakeDb.filter(
        (r) =>
          (r.status === "succeeded" || r.status === "failed") &&
          r.completedAt !== null &&
          r.completedAt < olderThan
      );
      for (const d of doomed) {
        const idx = fakeDb.indexOf(d);
        if (idx >= 0) fakeDb.splice(idx, 1);
      }
      return doomed.map((r) => ({ ...r }));
    }
  ),
  failStaleDashboardCsvExportJobs: vi.fn(
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
          row.completedAt = now;
          row.errorMessage =
            "stale claim — worker process did not complete the job";
          row.updatedAt = now;
          n++;
        }
      }
      return n;
    }
  ),
}));

// Storage + aggregator mocks (unchanged from the in-memory test).

vi.mock("../../storage", () => ({
  storagePut: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
  })),
  storageGet: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
  })),
  storageDelete: vi.fn(async () => ({ deleted: true, mode: "local" as const })),
}));

vi.mock("./buildOverviewSummaryAggregates", () => ({
  getOrBuildOverviewSummary: vi.fn(async () => ({
    result: {
      ownershipRows: [
        {
          systemName: "Sunny Acres",
          systemId: "sys-1",
          trackingSystemRefId: "trk-1",
          stateApplicationRefId: null,
          part2ProjectName: "Sunny Acres",
          part2ApplicationId: null,
          part2SystemId: null,
          part2TrackingId: null,
          source: "abp",
          ownershipStatus: "Transferred and Reporting",
          isReporting: true,
          isTransferred: true,
          isTerminated: false,
          contractType: "REC",
          contractStatusText: "Active",
          latestReportingDate: new Date("2026-04-01T00:00:00Z"),
          contractedDate: new Date("2024-01-01T00:00:00Z"),
          zillowStatus: null,
          zillowSoldDate: null,
        },
      ],
    },
    fromCache: false,
  })),
}));

vi.mock("./buildChangeOwnershipAggregates", () => ({
  getOrBuildChangeOwnership: vi.fn(async () => ({
    result: {
      rows: [
        {
          systemName: "Transferred Project",
          systemId: "sys-2",
          trackingSystemRefId: "trk-2",
          ownershipStatus: "Transferred and Reporting",
          changeOwnershipStatus: "Transferred and Reporting",
          isReporting: true,
          isTransferred: true,
          isTerminated: false,
          contractType: "REC",
          contractStatusText: "Active",
          contractedDate: new Date("2023-06-01T00:00:00Z"),
          zillowStatus: null,
          zillowSoldDate: null,
          latestReportingDate: new Date("2026-04-15T00:00:00Z"),
        },
      ],
    },
    fromCache: false,
  })),
}));

// Mock the db/_core import the service uses for the
// `getDashboardCsvExportJobById` worker helper. The service
// fetches by ID directly via Drizzle for that one path; we
// substitute a lightweight fake that walks fakeDb.
vi.mock("../../db/_core", async () => {
  const actual = await vi.importActual<typeof import("../../db/_core")>(
    "../../db/_core"
  );
  return {
    ...actual,
    getDb: vi.fn(async () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (_n: number) => {
              // The service uses this for `getDashboardCsvExportJobById`.
              // We can't see which `eq()` was passed without recreating
              // Drizzle's API; instead, return ALL rows and rely on the
              // service's `.limit(1)` semantics — but that breaks if
              // multiple rows exist. The service's only by-id call is
              // followed by a uniqueness check (one row per id), so we
              // mimic by returning the most-recently-inserted row that
              // the runner could possibly want.
              //
              // Practical approach: the service tests drive a single
              // job at a time, so returning fakeDb's last row is
              // sufficient. Tests that exercise multi-job behavior
              // override this individually.
              const last = fakeDb[fakeDb.length - 1];
              return last ? [last] : [];
            },
          }),
        }),
      }),
    })),
    withDbRetry: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn()
    ),
  };
});

import {
  DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
  __TEST_ONLY__,
  getCsvExportJobStatus,
  runCsvExportJob,
  startCsvExportJob,
  type DashboardCsvExportInput,
} from "./dashboardCsvExportJobs";

const SCOPE = "scope-A";
const OTHER_SCOPE = "scope-B";

beforeEach(() => {
  fakeReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Drive a job from start to runner completion synchronously.
 * Production uses `setImmediate` to keep `startCsvExportJob`
 * non-blocking; tests use a no-op scheduler and call the runner
 * directly.
 */
async function startAndRun(
  scopeId: string,
  input: DashboardCsvExportInput
): Promise<string> {
  const { jobId } = await startCsvExportJob(scopeId, input, runCsvExportJob, () => {
    /* tests drive runner manually */
  });
  await runCsvExportJob(jobId);
  return jobId;
}

describe("dashboardCsvExportJobs — start (DB-backed)", () => {
  it("returns a unique 32-hex-char jobId per call", async () => {
    const a = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    const b = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.jobId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.jobId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("inserts the job as queued before the runner starts", async () => {
    const { jobId } = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("queued");
    expect(status?.startedAt).toBeNull();
    expect(status?.completedAt).toBeNull();
  });

  it("schedules the runner via the scheduler function", async () => {
    let scheduledRunner: (() => void) | null = null;
    const ranFor: string[] = [];
    await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async (jobId) => {
        ranFor.push(jobId);
      },
      (cb) => {
        scheduledRunner = cb;
      }
    );
    expect(scheduledRunner).not.toBeNull();
    expect(ranFor).toHaveLength(0);
    scheduledRunner!();
    await Promise.resolve();
    expect(ranFor).toHaveLength(1);
  });
});

describe("dashboardCsvExportJobs — runner: ownership-tile (DB-backed)", () => {
  it("claims, runs aggregator + CSV builder + storagePut, marks succeeded", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.fileName).toMatch(/^ownership-status-reporting-\d{14}\.csv$/);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(status?.rowCount).toBe(1);
    expect(status?.error).toBeNull();
  });

  it("succeeds with rowCount=0 and url=null when the tile filter matches no rows", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "terminated",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(0);
    expect(status?.url).toBeNull();
    expect(status?.fileName).toMatch(/^ownership-status-terminated-\d{14}\.csv$/);
  });
});

describe("dashboardCsvExportJobs — runner: change-ownership-tile (DB-backed)", () => {
  it("claims, runs change-ownership aggregator + CSV builder + storagePut", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "changeOwnershipTile",
      status: "Transferred and Reporting",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(1);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
  });

  it("legacy split-Terminated input resolves to rowCount=0 (no aggregator rows match)", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "changeOwnershipTile",
      status: "Terminated and Reporting",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(0);
    expect(status?.url).toBeNull();
  });
});

describe("dashboardCsvExportJobs — scope isolation (DB-backed)", () => {
  it("returns null when reading a job from a different scope", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    expect(await getCsvExportJobStatus(OTHER_SCOPE, jobId)).toBeNull();
    expect((await getCsvExportJobStatus(SCOPE, jobId))?.status).toBe(
      "succeeded"
    );
  });

  it("returns null for an unknown jobId (no existence leak)", async () => {
    expect(await getCsvExportJobStatus(SCOPE, "nonexistent")).toBeNull();
  });
});

describe("dashboardCsvExportJobs — cross-process claim safety", () => {
  it("a worker that lost its claim cannot mark the row succeeded", async () => {
    // Set up: insert a queued row, simulate worker A claiming it,
    // then have a stale-claim sweep flip it to failed (mimicking
    // worker A's process dying), then have worker A try to
    // complete. The completion UPDATE must no-op because
    // claimedBy no longer matches (it was cleared by the
    // failure UPDATE — we'll set it to a different value).
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const id = "claim-loss-test-id";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const claimedA = await dbHelpers.claimDashboardCsvExportJob(
      SCOPE,
      id,
      "worker-A",
      longAgo
    );
    expect(claimedA).toBe(true);
    // Simulate worker B claiming after A's claim went stale.
    // To do that, manually backdate A's claim to "long ago" so
    // staleClaimBefore lets B in.
    const row = fakeFindById(id)!;
    row.claimedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const claimedB = await dbHelpers.claimDashboardCsvExportJob(
      SCOPE,
      id,
      "worker-B",
      new Date(Date.now() - 5 * 60 * 1000) // staleClaimBefore = 5 min ago
    );
    expect(claimedB).toBe(true);
    // Now worker A tries to complete. It should fail because
    // claimedBy is no longer "worker-A".
    const completedByA = await dbHelpers.completeDashboardCsvExportJobSuccess(
      SCOPE,
      id,
      "worker-A",
      { fileName: "x.csv", artifactUrl: "url", rowCount: 1, csvBytes: 100 }
    );
    expect(completedByA).toBe(false);
    // Worker B can complete legitimately.
    const completedByB = await dbHelpers.completeDashboardCsvExportJobSuccess(
      SCOPE,
      id,
      "worker-B",
      { fileName: "y.csv", artifactUrl: "url2", rowCount: 5, csvBytes: 500 }
    );
    expect(completedByB).toBe(true);
  });
});

describe("dashboardCsvExportJobs — sweepStaleAndPruned", () => {
  it("flips stale-claim running rows to failed", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const id = "stale-test-id";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    await dbHelpers.claimDashboardCsvExportJob(
      SCOPE,
      id,
      "worker-A",
      new Date(Date.now() - 60 * 60 * 1000)
    );
    // Backdate the claim so the sweep treats it as stale.
    const row = fakeFindById(id)!;
    row.claimedAt = new Date(Date.now() - 10 * 60 * 1000);

    await __TEST_ONLY__.sweepStaleAndPruned();

    const after = fakeFindById(id);
    expect(after?.status).toBe("failed");
    expect(after?.errorMessage).toContain("stale claim");
  });

  it("prunes terminal rows older than JOB_TTL_MS and fires storageDelete", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const storageMod = await import("../../storage");
    const deleteMock = vi.mocked(storageMod.storageDelete);
    deleteMock.mockClear();

    const id = "ttl-test-id";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    // Fast-forward to a completed-and-aged state by mutating the
    // row directly.
    const row = fakeFindById(id)!;
    row.status = "succeeded";
    row.completedAt = new Date(
      Date.now() - __TEST_ONLY__.JOB_TTL_MS - 60_000
    );
    row.fileName = "ownership-status-reporting-20260401120000.csv";
    row.artifactUrl =
      "/_local_uploads/solar-rec-dashboard/scope-A/exports/abc-ownership-status-reporting-20260401120000.csv";

    await __TEST_ONLY__.sweepStaleAndPruned();
    await Promise.resolve(); // let the fire-and-forget storageDelete settle

    expect(fakeFindById(id)).toBeUndefined(); // row pruned
    expect(deleteMock).toHaveBeenCalled();
  });

  it("does NOT prune fresh terminal rows", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const id = "fresh-terminal-test-id";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const row = fakeFindById(id)!;
    row.status = "succeeded";
    row.completedAt = new Date(); // just now

    await __TEST_ONLY__.sweepStaleAndPruned();

    expect(fakeFindById(id)).toBeDefined();
  });
});

describe("dashboardCsvExportJobs — runner version + claim id", () => {
  it("exports a v2-db-backed runner version (revs from v1)", () => {
    expect(DASHBOARD_CSV_EXPORT_RUNNER_VERSION).toBe(
      "dashboard-csv-export-jobs-v2-db-backed"
    );
  });

  it("claim id includes pid + host + suffix", () => {
    const id = __TEST_ONLY__.getClaimId();
    expect(id).toMatch(/^pid-\d+-host-.+-[0-9a-f]{8}$/);
    // Stable across calls within the same process.
    expect(__TEST_ONLY__.getClaimId()).toBe(id);
  });
});

describe("dashboardCsvExportJobs — input JSON parsing", () => {
  it("accepts ownershipTile shape", () => {
    const result = __TEST_ONLY__.parseInputJson({
      exportType: "ownershipTile",
      tile: "reporting",
    });
    expect(result).toEqual({ exportType: "ownershipTile", tile: "reporting" });
  });

  it("accepts changeOwnershipTile shape", () => {
    const result = __TEST_ONLY__.parseInputJson({
      exportType: "changeOwnershipTile",
      status: "Transferred and Reporting",
    });
    expect(result).toEqual({
      exportType: "changeOwnershipTile",
      status: "Transferred and Reporting",
    });
  });

  it("rejects unknown shapes", () => {
    expect(__TEST_ONLY__.parseInputJson(null)).toBeNull();
    expect(__TEST_ONLY__.parseInputJson(undefined)).toBeNull();
    expect(__TEST_ONLY__.parseInputJson({})).toBeNull();
    expect(__TEST_ONLY__.parseInputJson({ exportType: "wrong" })).toBeNull();
    expect(
      __TEST_ONLY__.parseInputJson({
        exportType: "ownershipTile",
        tile: "invalid",
      })
    ).toBeNull();
  });
});
