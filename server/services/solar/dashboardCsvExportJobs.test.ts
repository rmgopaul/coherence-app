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
const datasetCsvExportMocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
}));
const deliveryTrackerDetailExportMocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
}));

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
  refreshDashboardCsvExportJobClaim: vi.fn(
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
}));

// Storage + aggregator mocks (unchanged from the in-memory test).

vi.mock("../../storage", () => ({
  storagePut: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
  })),
  storagePutFile: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
    bytes: 27,
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

vi.mock("./dashboardDatasetCsvExport", () => {
  const keys = ["transferHistory", "deliveryScheduleBase"] as const;
  return {
    DASHBOARD_DATASET_CSV_EXPORT_KEYS: keys,
    isDashboardDatasetCsvExportKey: (value: unknown) =>
      typeof value === "string" &&
      keys.includes(value as (typeof keys)[number]),
    buildDatasetCsvExport: vi.fn(
      async (_scopeId: string, datasetKey: string) => ({
        filePath: `/tmp/dataset-${datasetKey}.csv`,
        fileName: `dataset-${datasetKey}-20260506123456.csv`,
        rowCount: 1,
        csvBytes: 27,
        cleanup: datasetCsvExportMocks.cleanup,
      })
    ),
  };
});

vi.mock("./buildDeliveryTrackerData", () => ({
  buildDeliveryTrackerDetailCsvExport: vi.fn(async (_scopeId: string) => ({
    filePath: "/tmp/delivery-tracker-detail.csv",
    fileName: "delivery-tracker-detail-20260506123456.csv",
    rowCount: 2,
    csvBytes: 123,
    cleanup: deliveryTrackerDetailExportMocks.cleanup,
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
import { buildDatasetCsvExport } from "./dashboardDatasetCsvExport";
import { buildDeliveryTrackerDetailCsvExport } from "./buildDeliveryTrackerData";

const SCOPE = "scope-A";
const OTHER_SCOPE = "scope-B";

beforeEach(() => {
  fakeReset();
  __TEST_ONLY__.resetRunnerSchedulerState();
});

afterEach(() => {
  __TEST_ONLY__.resetRunnerSchedulerState();
  vi.useRealTimers();
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

async function flushMicrotasks(times = 32): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitForFakeJobStatus(
  id: string,
  status: FakeRow["status"],
  attempts = 50
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (fakeFindById(id)?.status === status) return;
    await flushMicrotasks(8);
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(
    `expected fake job ${id} to reach ${status}, got ${
      fakeFindById(id)?.status ?? "missing"
    }`
  );
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
    await Promise.resolve();
    expect(ranFor).toHaveLength(1);
  });

  it("preserves each queued job's injected runner", async () => {
    let scheduledRunner: (() => void) | null = null;
    const firstRunnerJobs: string[] = [];
    const secondRunnerJobs: string[] = [];

    const first = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async (jobId) => {
        firstRunnerJobs.push(jobId);
      },
      (cb) => {
        scheduledRunner = cb;
      }
    );
    const second = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async (jobId) => {
        secondRunnerJobs.push(jobId);
      },
      () => {
        throw new Error("second enqueue should reuse the scheduled drain");
      }
    );

    scheduledRunner!();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstRunnerJobs).toEqual([first.jobId]);
    expect(secondRunnerJobs).toEqual([second.jobId]);
  });
});

describe("dashboardCsvExportJobs — runner: ownership-tile (DB-backed)", () => {
  it("claims, runs aggregator + CSV builder + storagePutFile, marks succeeded", async () => {
    const storageMod = await import("../../storage");
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.fileName).toMatch(
      /^ownership-status-reporting-\d{14}\.csv$/
    );
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(status?.rowCount).toBe(1);
    expect(status?.error).toBeNull();
    expect(storageMod.storagePutFile).toHaveBeenCalledWith(
      expect.stringContaining(`${jobId}-`),
      expect.stringContaining("ownership-status-reporting-"),
      "text/csv; charset=utf-8"
    );
    expect(storageMod.storagePut).not.toHaveBeenCalled();
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
    expect(status?.fileName).toMatch(
      /^ownership-status-terminated-\d{14}\.csv$/
    );
  });
});

describe("dashboardCsvExportJobs — runner: change-ownership-tile (DB-backed)", () => {
  it("claims, runs change-ownership aggregator + CSV builder + storagePutFile", async () => {
    const storageMod = await import("../../storage");
    const jobId = await startAndRun(SCOPE, {
      exportType: "changeOwnershipTile",
      status: "Transferred and Reporting",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(1);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(storageMod.storagePutFile).toHaveBeenCalledWith(
      expect.stringContaining(`${jobId}-`),
      expect.stringContaining("change-ownership-transferred-and-reporting-"),
      "text/csv; charset=utf-8"
    );
    expect(storageMod.storagePut).not.toHaveBeenCalled();
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

describe("dashboardCsvExportJobs — runner: dataset CSV (DB-backed)", () => {
  it("claims, runs the dataset CSV builder + file-backed storagePut", async () => {
    const storageMod = await import("../../storage");
    const jobId = await startAndRun(SCOPE, {
      exportType: "datasetCsv",
      datasetKey: "transferHistory",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);

    expect(buildDatasetCsvExport).toHaveBeenCalledWith(
      SCOPE,
      "transferHistory"
    );
    expect(status?.status).toBe("succeeded");
    expect(status?.fileName).toBe("dataset-transferHistory-20260506123456.csv");
    expect(status?.rowCount).toBe(1);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(storageMod.storagePutFile).toHaveBeenCalledWith(
      expect.stringContaining(`${jobId}-`),
      "/tmp/dataset-transferHistory.csv",
      "text/csv; charset=utf-8"
    );
    expect(datasetCsvExportMocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it("defers temp-file cleanup until a timed-out file upload settles", async () => {
    vi.useFakeTimers();
    const storageMod = await import("../../storage");
    const storagePutFile = storageMod.storagePutFile as unknown as ReturnType<
      typeof vi.fn
    >;
    let resolveStoragePutFile:
      | ((value: { key: string; url: string; bytes: number }) => void)
      | null = null;
    storagePutFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStoragePutFile = resolve;
        })
    );
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "dataset-late-put-timeout",
      scopeId: SCOPE,
      input: { exportType: "datasetCsv", datasetKey: "transferHistory" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });

    const runPromise = runCsvExportJob("dataset-late-put-timeout");
    await vi.dynamicImportSettled();
    await flushMicrotasks(128);
    expect(resolveStoragePutFile).not.toBeNull();
    await vi.advanceTimersByTimeAsync(__TEST_ONLY__.EXPORT_RUNNER_TIMEOUT_MS);
    await runPromise;
    expect(fakeFindById("dataset-late-put-timeout")?.status).toBe("failed");
    expect(datasetCsvExportMocks.cleanup).not.toHaveBeenCalled();

    resolveStoragePutFile!({
      key: "unused",
      url: "/unused",
      bytes: 27,
    });
    await flushMicrotasks();
    expect(datasetCsvExportMocks.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("dashboardCsvExportJobs — runner: Delivery Tracker detail CSV (DB-backed)", () => {
  it("claims, runs the Delivery Tracker detail builder + file-backed storagePut", async () => {
    const storageMod = await import("../../storage");
    const jobId = await startAndRun(SCOPE, {
      exportType: "deliveryTrackerDetailCsv",
    });
    const status = await getCsvExportJobStatus(SCOPE, jobId);

    expect(buildDeliveryTrackerDetailCsvExport).toHaveBeenCalledWith(SCOPE);
    expect(status?.status).toBe("succeeded");
    expect(status?.fileName).toBe(
      "delivery-tracker-detail-20260506123456.csv"
    );
    expect(status?.rowCount).toBe(2);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(storageMod.storagePutFile).toHaveBeenCalledWith(
      expect.stringContaining(`${jobId}-`),
      "/tmp/delivery-tracker-detail.csv",
      "text/csv; charset=utf-8"
    );
    expect(deliveryTrackerDetailExportMocks.cleanup).toHaveBeenCalledTimes(1);
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
      longAgo,
      DASHBOARD_CSV_EXPORT_RUNNER_VERSION
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
      new Date(Date.now() - 5 * 60 * 1000), // staleClaimBefore = 5 min ago
      DASHBOARD_CSV_EXPORT_RUNNER_VERSION
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
      new Date(Date.now() - 60 * 60 * 1000),
      DASHBOARD_CSV_EXPORT_RUNNER_VERSION
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
    row.claimedBy = "pid-1-host-a-aaaaaaaa";
    row.artifactUrl =
      "/_local_uploads/solar-rec-dashboard/scope-A/exports/ttl-test-id-pid-1-host-a-aaaaaaaa-ownership-status-reporting-20260401120000.csv";

    await __TEST_ONLY__.sweepStaleAndPruned();
    await Promise.resolve(); // let the fire-and-forget storageDelete settle

    expect(fakeFindById(id)).toBeUndefined(); // row pruned
    expect(deleteMock).toHaveBeenCalled();
  });

  it("deletes claim-scoped v4 artifacts even when completion never recorded file metadata", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const storageMod = await import("../../storage");
    const deleteMock = vi.mocked(storageMod.storageDelete);
    deleteMock.mockClear();

    const id = "crash-after-upload-id";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const row = fakeFindById(id)!;
    row.status = "failed";
    row.completedAt = new Date(
      Date.now() - __TEST_ONLY__.JOB_TTL_MS - 60_000
    );
    row.claimedBy = "pid-9-host-z-99999999";
    row.fileName = null;
    row.artifactUrl = null;

    await __TEST_ONLY__.sweepStaleAndPruned();
    await flushMicrotasks();

    expect(fakeFindById(id)).toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith(
      "solar-rec-dashboard/scope-A/exports/crash-after-upload-id-pid-9-host-z-99999999.csv"
    );
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
  it("exports the v8 Delivery Tracker detail CSV runner version", () => {
    expect(DASHBOARD_CSV_EXPORT_RUNNER_VERSION).toBe(
      "dashboard-csv-export-jobs-v8-delivery-tracker-detail"
    );
  });

  it("claim id includes pid + host + suffix", () => {
    const id = __TEST_ONLY__.getClaimId();
    expect(id).toMatch(/^pid-\d+-host-.+-[0-9a-f]{8}$/);
  });

  it("uses claim-scoped storage keys for v4 artifacts and legacy keys for older rows", () => {
    expect(
      __TEST_ONLY__.storageKeyForJob(
        "job-1",
        SCOPE,
        "export.csv",
        "pid-1-host-a-aaaaaaaa",
        DASHBOARD_CSV_EXPORT_RUNNER_VERSION
      )
    ).toBe(
      "solar-rec-dashboard/scope-A/exports/job-1-pid-1-host-a-aaaaaaaa.csv"
    );
    expect(
      __TEST_ONLY__.storageKeyForJob(
        "job-1",
        SCOPE,
        null,
        "pid-1-host-a-aaaaaaaa",
        DASHBOARD_CSV_EXPORT_RUNNER_VERSION
      )
    ).toBe(
      "solar-rec-dashboard/scope-A/exports/job-1-pid-1-host-a-aaaaaaaa.csv"
    );
    expect(
      __TEST_ONLY__.storageKeyForJob(
        "job-1",
        SCOPE,
        "export.csv",
        "pid-1-host-a-aaaaaaaa",
        "dashboard-csv-export-jobs-v3-heartbeat"
      )
    ).toBe("solar-rec-dashboard/scope-A/exports/job-1-export.csv");
    expect(
      __TEST_ONLY__.storageKeyForJob(
        "job-1",
        SCOPE,
        null,
        "pid-1-host-a-aaaaaaaa",
        "dashboard-csv-export-jobs-v3-heartbeat"
      )
    ).toBeNull();
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

  it("accepts datasetCsv shape", () => {
    const result = __TEST_ONLY__.parseInputJson({
      exportType: "datasetCsv",
      datasetKey: "transferHistory",
    });
    expect(result).toEqual({
      exportType: "datasetCsv",
      datasetKey: "transferHistory",
    });
  });

  it("accepts deliveryTrackerDetailCsv shape", () => {
    const result = __TEST_ONLY__.parseInputJson({
      exportType: "deliveryTrackerDetailCsv",
    });
    expect(result).toEqual({ exportType: "deliveryTrackerDetailCsv" });
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
    expect(
      __TEST_ONLY__.parseInputJson({
        exportType: "datasetCsv",
        datasetKey: "unknownDataset",
      })
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// Codex P1/P2 follow-up rails (Phase 6 PR-B follow-up)
// ────────────────────────────────────────────────────────────────────

describe("dashboardCsvExportJobs — Codex P1: queued-job resume on status read", () => {
  // Pre-fix: startCsvExportJob inserts then schedules via
  // setImmediate. If the inserting process restarts before the
  // runner fires, the row sits queued forever — sweepStaleAndPruned
  // only handles `running` and terminal rows. Post-fix:
  // getCsvExportJobStatus opportunistically schedules the runner
  // when it sees a queued row. Claim semantics ensure exactly one
  // runner actually executes.
  it("kicks off the runner when status is read for a queued row that nobody scheduled", async () => {
    const id = "qjob-1";
    // Simulate a process restart: insert a queued row WITHOUT
    // calling startCsvExportJob (so no scheduler fires).
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    expect(fakeFindById(id)?.status).toBe("queued");

    // First status read fires the runner via setImmediate.
    const snap = await getCsvExportJobStatus(SCOPE, id);
    expect(snap).not.toBeNull();
    // Status read returns the pre-resume snapshot (still queued).
    expect(snap!.status).toBe("queued");

    await waitForFakeJobStatus(id, "succeeded");
  });

  it("dedupes repeated queued status polls before the local runner drains", async () => {
    const id = "qjob-dedupe";
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });

    const [first, second, third] = await Promise.all([
      getCsvExportJobStatus(SCOPE, id),
      getCsvExportJobStatus(SCOPE, id),
      getCsvExportJobStatus(SCOPE, id),
    ]);

    expect(first?.status).toBe("queued");
    expect(second?.status).toBe("queued");
    expect(third?.status).toBe("queued");
    const state = __TEST_ONLY__.getRunnerSchedulerState();
    expect(state.pendingJobIds).toEqual([id]);
    expect(state.pendingJobIdSet).toEqual([id]);
  });

  it("does not schedule a runner when the row is already running", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "running-job",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    // Manually flip to running so the resume branch must NOT fire.
    const row = fakeFindById("running-job")!;
    row.status = "running";
    row.claimedBy = "pid-other-host-x-aaaaaaaa";
    row.claimedAt = new Date();

    const snap = await getCsvExportJobStatus(SCOPE, "running-job");
    expect(snap!.status).toBe("running");

    await new Promise((r) => setImmediate(r));
    // Still running — the resume branch must NOT have re-claimed
    // (the claimedBy is foreign and not stale).
    expect(fakeFindById("running-job")?.status).toBe("running");
    expect(fakeFindById("running-job")?.claimedBy).toBe(
      "pid-other-host-x-aaaaaaaa"
    );
  });

  it("two simulated workers racing to claim a queued row produce exactly one success", async () => {
    const id = "race-job";
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const staleClaimBefore = new Date(
      Date.now() - __TEST_ONLY__.STALE_CLAIM_MS
    );
    const [a, b] = await Promise.all([
      dbHelpers.claimDashboardCsvExportJob(
        SCOPE,
        id,
        "pid-A-host-x-aaaaaaaa",
        staleClaimBefore,
        DASHBOARD_CSV_EXPORT_RUNNER_VERSION
      ),
      dbHelpers.claimDashboardCsvExportJob(
        SCOPE,
        id,
        "pid-B-host-y-bbbbbbbb",
        staleClaimBefore,
        DASHBOARD_CSV_EXPORT_RUNNER_VERSION
      ),
    ]);
    expect([a, b].filter((r) => r === true)).toHaveLength(1);
  });
});

describe("dashboardCsvExportJobs — Codex P1: heartbeat keeps healthy long jobs alive", () => {
  it("refreshes claimedAt for an active running row", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "long-job",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const claimId = "pid-W-host-z-cccccccc";
    const staleClaimBefore = new Date(
      Date.now() - __TEST_ONLY__.STALE_CLAIM_MS
    );
    await dbHelpers.claimDashboardCsvExportJob(
      SCOPE,
      "long-job",
      claimId,
      staleClaimBefore,
      DASHBOARD_CSV_EXPORT_RUNNER_VERSION
    );
    const initialClaimedAt = fakeFindById("long-job")!.claimedAt!.getTime();

    // Simulate worker still running 3 seconds later — heartbeat
    // would have fired by now in production.
    await new Promise((r) => setTimeout(r, 5));
    const refreshed = await dbHelpers.refreshDashboardCsvExportJobClaim(
      SCOPE,
      "long-job",
      claimId
    );
    expect(refreshed).toBe(true);
    const newClaimedAt = fakeFindById("long-job")!.claimedAt!.getTime();
    expect(newClaimedAt).toBeGreaterThan(initialClaimedAt);
  });

  it("stale-claim sweep does NOT fail a row whose heartbeat just refreshed", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "fresh-heartbeat",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const claimId = "pid-W-host-z-cccccccc";
    // Old initial claim (would be stale)…
    const row = fakeFindById("fresh-heartbeat")!;
    row.status = "running";
    row.claimedBy = claimId;
    row.claimedAt = new Date(
      Date.now() - __TEST_ONLY__.STALE_CLAIM_MS - 1000
    );

    // …but a heartbeat refresh fires before the sweeper runs.
    const refreshed = await dbHelpers.refreshDashboardCsvExportJobClaim(
      SCOPE,
      "fresh-heartbeat",
      claimId
    );
    expect(refreshed).toBe(true);

    // Now sweep — the row should NOT be marked failed.
    await __TEST_ONLY__.sweepStaleAndPruned();
    expect(fakeFindById("fresh-heartbeat")?.status).toBe("running");
  });

  it("refresh returns false when the caller's claim was already lost", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "lost-claim",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const row = fakeFindById("lost-claim")!;
    row.status = "running";
    row.claimedBy = "pid-other-host-x-dddddddd"; // foreign owner
    row.claimedAt = new Date();
    const refreshed = await dbHelpers.refreshDashboardCsvExportJobClaim(
      SCOPE,
      "lost-claim",
      "pid-W-host-z-cccccccc"
    );
    expect(refreshed).toBe(false);
  });

  it("fails a hung export and drains the next queued runner at the hard deadline", async () => {
    vi.useFakeTimers();
    __TEST_ONLY__.setMaxLocalRunnersForTest(1);
    const overviewMod = await import("./buildOverviewSummaryAggregates");
    const getOverview =
      overviewMod.getOrBuildOverviewSummary as unknown as ReturnType<
        typeof vi.fn
      >;
    getOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );

    const scheduledDrains: Array<() => void> = [];
    const scheduler = (cb: () => void) => {
      scheduledDrains.push(cb);
    };
    const { jobId } = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      runCsvExportJob,
      scheduler
    );

    expect(scheduledDrains).toHaveLength(1);
    scheduledDrains.shift()!();
    expect(__TEST_ONLY__.getRunnerSchedulerState().activeJobIds).toEqual([
      jobId,
    ]);
    await flushMicrotasks();
    expect(fakeFindById(jobId)?.status).toBe("running");

    let drainedJobId: string | null = null;
    const { jobId: waitingJobId } = await startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "notReporting" },
      async (id) => {
        drainedJobId = id;
      },
      scheduler
    );
    expect(__TEST_ONLY__.getRunnerSchedulerState().pendingJobIds).toEqual([
      waitingJobId,
    ]);
    expect(scheduledDrains).toHaveLength(1);
    // Drain attempt while the local runner slot is full. The
    // waiting job should remain pending until the timed-out
    // active runner releases the slot.
    scheduledDrains.shift()!();
    expect(__TEST_ONLY__.getRunnerSchedulerState().pendingJobIds).toEqual([
      waitingJobId,
    ]);
    expect(drainedJobId).toBeNull();

    await vi.advanceTimersByTimeAsync(__TEST_ONLY__.EXPORT_RUNNER_TIMEOUT_MS);
    await flushMicrotasks();

    const row = fakeFindById(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("exceeded hard runtime limit");
    expect(__TEST_ONLY__.getRunnerSchedulerState().activeJobIds).toEqual([]);
    expect(scheduledDrains).toHaveLength(1);
    scheduledDrains.shift()!();
    await flushMicrotasks();
    expect(drainedJobId).toBe(waitingJobId);
    expect(__TEST_ONLY__.getRunnerSchedulerState().pendingJobIds).toEqual([]);
  });
});

describe("dashboardCsvExportJobs — Codex P2: lost-claim success path cleans storage", () => {
  it("cleans the previous attempt's claim-scoped artifact when re-claiming a stale running row", async () => {
    const storageMod = await import("../../storage");
    const storageDelete = storageMod.storageDelete as unknown as ReturnType<
      typeof vi.fn
    >;
    storageDelete.mockClear();
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const id = "reclaim-stale-upload";
    await dbHelpers.insertDashboardCsvExportJob({
      id,
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    const row = fakeFindById(id)!;
    row.status = "running";
    row.claimedBy = "pid-old-host-z-00000000";
    row.claimedAt = new Date(
      Date.now() - __TEST_ONLY__.STALE_CLAIM_MS - 60_000
    );
    row.fileName = null;
    row.artifactUrl = null;

    await runCsvExportJob(id);
    await flushMicrotasks();

    expect(storageDelete).toHaveBeenCalledWith(
      "solar-rec-dashboard/scope-A/exports/reclaim-stale-upload-pid-old-host-z-00000000.csv"
    );
    const after = fakeFindById(id);
    expect(after?.status).toBe("succeeded");
    expect(after?.claimedBy).not.toBe("pid-old-host-z-00000000");
    expect(after?.runnerVersion).toBe(DASHBOARD_CSV_EXPORT_RUNNER_VERSION);
  });

  it("calls storageDelete when completeSuccess returns false post-storagePut", async () => {
    const storageMod = await import("../../storage");
    const storageDelete = storageMod.storageDelete as unknown as ReturnType<
      typeof vi.fn
    >;
    storageDelete.mockClear();
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const completeSuccess =
      dbHelpers.completeDashboardCsvExportJobSuccess as unknown as ReturnType<
        typeof vi.fn
      >;

    // Insert + schedule a job, but force completeSuccess to
    // return false so we land in the lost-claim cleanup branch.
    await dbHelpers.insertDashboardCsvExportJob({
      id: "lost-after-put",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    completeSuccess.mockImplementationOnce(async () => false);

    await runCsvExportJob("lost-after-put");

    // The runner should have called storageDelete with the
    // reconstructed key. Look for any call whose key includes
    // the jobId.
    const calls = storageDelete.mock.calls;
    expect(
      calls.some((args) =>
        typeof args[0] === "string" && args[0].includes("lost-after-put")
      )
    ).toBe(true);
  });

  it("calls storageDelete when success completion throws after storagePut", async () => {
    const storageMod = await import("../../storage");
    const storageDelete = storageMod.storageDelete as unknown as ReturnType<
      typeof vi.fn
    >;
    storageDelete.mockClear();
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const completeSuccess =
      dbHelpers.completeDashboardCsvExportJobSuccess as unknown as ReturnType<
        typeof vi.fn
      >;

    await dbHelpers.insertDashboardCsvExportJob({
      id: "completion-throws-after-put",
      scopeId: SCOPE,
      input: { exportType: "ownershipTile", tile: "reporting" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });
    completeSuccess.mockImplementationOnce(async () => {
      throw new Error("completion DB unavailable");
    });

    await runCsvExportJob("completion-throws-after-put");

    const calls = storageDelete.mock.calls;
    expect(
      calls.some((args) =>
        typeof args[0] === "string" &&
        args[0].includes("completion-throws-after-put")
      )
    ).toBe(true);
    expect(fakeFindById("completion-throws-after-put")?.status).toBe("failed");
  });

  it("cleans a late file-backed artifact when the upload resolves after runner timeout", async () => {
    vi.useFakeTimers();
    const storageMod = await import("../../storage");
    const storagePutFile = storageMod.storagePutFile as unknown as ReturnType<
      typeof vi.fn
    >;
    const storageDelete = storageMod.storageDelete as unknown as ReturnType<
      typeof vi.fn
    >;
    storageDelete.mockClear();
    let resolveStoragePutFile:
      | ((value: { key: string; url: string; bytes: number }) => void)
      | null = null;
    storagePutFile.mockImplementationOnce(
      (key: string) =>
        new Promise((resolve) => {
          resolveStoragePutFile = () =>
            resolve({
              key,
              url: `/_local_uploads/${key}`,
              bytes: 395,
            });
        })
    );
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    await dbHelpers.insertDashboardCsvExportJob({
      id: "late-put-timeout",
      scopeId: SCOPE,
      input: { exportType: "datasetCsv", datasetKey: "transferHistory" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });

    const runPromise = runCsvExportJob("late-put-timeout");
    await flushMicrotasks();
    expect(resolveStoragePutFile).not.toBeNull();
    await vi.advanceTimersByTimeAsync(__TEST_ONLY__.EXPORT_RUNNER_TIMEOUT_MS);
    await runPromise;
    expect(fakeFindById("late-put-timeout")?.status).toBe("failed");
    expect(storageDelete).not.toHaveBeenCalled();

    resolveStoragePutFile!({
      key: "unused",
      url: "/unused",
      bytes: 395,
    });
    await flushMicrotasks();
    expect(
      storageDelete.mock.calls.some(
        (args) =>
          typeof args[0] === "string" && args[0].includes("late-put-timeout")
      )
    ).toBe(true);
  });

  it("cleans a completed upload when success completion times out then reports lost claim", async () => {
    vi.useFakeTimers();
    const storageMod = await import("../../storage");
    const storageDelete = storageMod.storageDelete as unknown as ReturnType<
      typeof vi.fn
    >;
    storageDelete.mockClear();
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const completeSuccess =
      dbHelpers.completeDashboardCsvExportJobSuccess as unknown as ReturnType<
        typeof vi.fn
      >;
    let resolveComplete:
      | ((value: boolean | PromiseLike<boolean>) => void)
      | null = null;
    completeSuccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveComplete = resolve;
        })
    );
    await dbHelpers.insertDashboardCsvExportJob({
      id: "late-complete-timeout",
      scopeId: SCOPE,
      input: { exportType: "datasetCsv", datasetKey: "transferHistory" },
      status: "queued",
      runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
    });

    const runPromise = runCsvExportJob("late-complete-timeout");
    await flushMicrotasks(128);
    await vi.dynamicImportSettled();
    await flushMicrotasks(128);
    expect(resolveComplete).not.toBeNull();
    await vi.advanceTimersByTimeAsync(__TEST_ONLY__.EXPORT_RUNNER_TIMEOUT_MS);
    await runPromise;
    expect(fakeFindById("late-complete-timeout")?.status).toBe("running");
    expect(storageDelete).not.toHaveBeenCalled();

    resolveComplete!(false);
    await flushMicrotasks();
    expect(
      storageDelete.mock.calls.some(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("late-complete-timeout")
      )
    ).toBe(true);
  });
});

describe("dashboardCsvExportJobs — Codex P2: start fails fast when DB is unavailable", () => {
  // We can't easily simulate DB-unavailable through the fake
  // mock, but the helper's contract says it throws. This test
  // overrides the mock once to throw, mirroring what the real
  // helper does when getDb() returns null.
  it("startCsvExportJob rejects when insert throws and does NOT schedule a runner", async () => {
    const dbHelpers = await import("../../db/dashboardCsvExportJobs");
    const insert = dbHelpers.insertDashboardCsvExportJob as unknown as ReturnType<
      typeof vi.fn
    >;
    insert.mockImplementationOnce(async () => {
      throw new Error(
        "dashboardCsvExportJobs: database unavailable — cannot insert export job"
      );
    });

    let runnerCalls = 0;
    let schedulerCalls = 0;
    const fakeRunner = async () => {
      runnerCalls += 1;
    };
    const fakeScheduler = (cb: () => void) => {
      schedulerCalls += 1;
      cb();
    };

    await expect(
      startCsvExportJob(
        SCOPE,
        { exportType: "ownershipTile", tile: "reporting" },
        fakeRunner,
        fakeScheduler
      )
    ).rejects.toThrow(/database unavailable/i);

    expect(runnerCalls).toBe(0);
    expect(schedulerCalls).toBe(0);
  });
});
