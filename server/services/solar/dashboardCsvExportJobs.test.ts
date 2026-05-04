/**
 * Focused unit tests for the dashboard CSV export job registry.
 *
 * The service is in-memory and process-local, so tests drive it
 * directly. We mock `./buildOverviewSummaryAggregates`,
 * `./buildChangeOwnershipAggregates`, and `../../storage` so the
 * runner can complete without a real DB or storage backend; the
 * mocks let us assert what the worker would have written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", () => ({
  storagePut: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
  })),
  storageGet: vi.fn(async (key: string) => ({
    key,
    url: `/_local_uploads/${key}`,
  })),
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
  __TEST_ONLY__.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Run a job with a synchronous scheduler so the test can assert the
 * post-runner state immediately after `runCsvExportJob` resolves.
 * Production uses `setImmediate` to keep the start mutation snappy;
 * the test path uses an explicit async drive instead.
 */
async function startAndRun(
  scopeId: string,
  input: DashboardCsvExportInput
): Promise<string> {
  const { jobId } = startCsvExportJob(scopeId, input, runCsvExportJob, () => {
    /* swallow — the test drives runner manually below */
  });
  await runCsvExportJob(jobId);
  return jobId;
}

describe("dashboardCsvExportJobs — start", () => {
  it("returns a unique 32-hex-char jobId per call", () => {
    const a = startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    const b = startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.jobId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.jobId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("registers the job as queued before the runner starts", () => {
    const { jobId } = startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => undefined,
      () => undefined
    );
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("queued");
    expect(status?.startedAt).toBeNull();
    expect(status?.completedAt).toBeNull();
  });

  it("schedules the runner via the scheduler function (default: setImmediate)", async () => {
    let scheduledRunner: (() => void) | null = null;
    const ranCount = { n: 0 };
    startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => {
        ranCount.n += 1;
      },
      (cb) => {
        scheduledRunner = cb;
      }
    );
    expect(scheduledRunner).not.toBeNull();
    expect(ranCount.n).toBe(0);
    scheduledRunner!();
    // Runner is async; let microtasks flush.
    await Promise.resolve();
    expect(ranCount.n).toBe(1);
  });

  it("captures a runner that throws into a failed-status record", async () => {
    let scheduledRunner: (() => void) | null = null;
    const { jobId } = startCsvExportJob(
      SCOPE,
      { exportType: "ownershipTile", tile: "reporting" },
      async () => {
        throw new Error("synthetic runner explosion");
      },
      (cb) => {
        scheduledRunner = cb;
      }
    );
    // Suppress the console.error the start helper emits.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduledRunner!();
      // Allow the rejection to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errSpy.mockRestore();
    }
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("failed");
    expect(status?.error).toContain("synthetic runner explosion");
    expect(status?.completedAt).not.toBeNull();
  });
});

describe("dashboardCsvExportJobs — runner: ownership-tile", () => {
  it("runs aggregator + CSV builder + storagePut and reports success with URL", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.fileName).toMatch(/^ownership-status-reporting-\d{14}\.csv$/);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
    expect(status?.rowCount).toBe(1);
    expect(status?.error).toBeNull();
  });

  it("succeeds with rowCount=0 and url=null when the tile filter matches no rows", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      // The mocked aggregator only contains a "Transferred and
      // Reporting" row — the "terminated" tile filter matches nothing.
      tile: "terminated",
    });
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(0);
    expect(status?.url).toBeNull();
    expect(status?.fileName).toMatch(/^ownership-status-terminated-\d{14}\.csv$/);
  });
});

describe("dashboardCsvExportJobs — runner: change-ownership-tile", () => {
  it("runs aggregator + CSV builder + storagePut for the change-ownership tile", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "changeOwnershipTile",
      status: "Transferred and Reporting",
    });
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(1);
    expect(status?.url).toContain(`solar-rec-dashboard/${SCOPE}/exports/`);
  });

  it("legacy split-Terminated input resolves to rowCount=0 (no aggregator rows match)", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "changeOwnershipTile",
      status: "Terminated and Reporting",
    });
    const status = getCsvExportJobStatus(SCOPE, jobId);
    expect(status?.status).toBe("succeeded");
    expect(status?.rowCount).toBe(0);
    expect(status?.url).toBeNull();
  });
});

describe("dashboardCsvExportJobs — scope isolation", () => {
  it("returns null when reading a job from a different scope", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    expect(getCsvExportJobStatus(OTHER_SCOPE, jobId)).toBeNull();
    expect(getCsvExportJobStatus(SCOPE, jobId)?.status).toBe("succeeded");
  });

  it("returns null for an unknown jobId (no existence leak)", () => {
    expect(getCsvExportJobStatus(SCOPE, "nonexistent")).toBeNull();
  });
});

describe("dashboardCsvExportJobs — TTL pruning", () => {
  it("prunes records whose completedAt is older than JOB_TTL_MS on the next status read", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    expect(__TEST_ONLY__.size()).toBe(1);

    const now = Date.now();
    // Force the record's completedAt back so the next prune evicts it.
    const stale = (
      getCsvExportJobStatus(SCOPE, jobId) as unknown as { completedAt: number }
    );
    expect(stale.completedAt).toBeDefined();
    // Fast-forward by mutating the clock the prune helper consults.
    const realDate = Date;
    try {
      // Mock Date.now in pruneExpired's view: shift forward past TTL.
      vi.spyOn(Date, "now").mockReturnValue(
        now + __TEST_ONLY__.JOB_TTL_MS + 1000
      );
      __TEST_ONLY__.pruneExpired();
    } finally {
      vi.spyOn(Date, "now").mockRestore();
      expect(global.Date).toBe(realDate);
    }
    expect(__TEST_ONLY__.size()).toBe(0);
    expect(getCsvExportJobStatus(SCOPE, jobId)).toBeNull();
  });

  it("does NOT prune a record still within TTL", async () => {
    const jobId = await startAndRun(SCOPE, {
      exportType: "ownershipTile",
      tile: "reporting",
    });
    __TEST_ONLY__.pruneExpired();
    expect(__TEST_ONLY__.size()).toBe(1);
    expect(getCsvExportJobStatus(SCOPE, jobId)?.status).toBe("succeeded");
  });
});

describe("dashboardCsvExportJobs — runner version marker", () => {
  it("exports a stable version string", () => {
    expect(DASHBOARD_CSV_EXPORT_RUNNER_VERSION).toBe(
      "dashboard-csv-export-jobs-v1"
    );
  });
});
