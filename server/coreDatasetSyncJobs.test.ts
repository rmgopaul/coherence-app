import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetMigrationStatus } from "./services/solar/serverSideMigration";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushBackgroundWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function doneResult(datasetKey: string): DatasetMigrationStatus {
  return {
    datasetKey,
    state: "done",
    batchId: "batch-1",
    rowCount: 123,
    durationMs: 45,
  };
}

describe("coreDatasetSyncJobs", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reuses the same job id for duplicate active syncs and clears the active index when finished", async () => {
    const deferred = createDeferred<DatasetMigrationStatus>();
    const runIngest = vi.fn(() => deferred.promise);

    const registry = await import("./services/solar/coreDatasetSyncJobs");

    const firstJobId = registry.startSyncJob(
      "scope-1",
      "transferHistory",
      runIngest
    );
    const secondJobId = registry.startSyncJob(
      "scope-1",
      "transferHistory",
      vi.fn(async () => doneResult("transferHistory"))
    );

    expect(secondJobId).toBe(firstJobId);

    await flushBackgroundWork();

    expect(runIngest).toHaveBeenCalledTimes(1);
    expect(registry.getSyncJob(firstJobId)?.state).toBe("running");
    expect(
      registry.listActiveJobsForScope("scope-1").map((job) => job.jobId)
    ).toEqual([firstJobId]);

    deferred.resolve(doneResult("transferHistory"));
    await flushBackgroundWork();

    const completedJob = registry.getSyncJob(firstJobId);
    expect(completedJob?.state).toBe("done");
    expect(registry.listActiveJobsForScope("scope-1")).toEqual([]);
  });

  it("stores a failed terminal state when the background ingest throws", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const registry = await import("./services/solar/coreDatasetSyncJobs");

      const jobId = registry.startSyncJob("scope-2", "abpReport", async () => {
        throw new Error("boom");
      });

      await flushBackgroundWork();

      const failedJob = registry.getSyncJob(jobId);
      expect(failedJob?.state).toBe("failed");
      expect(registry.listActiveJobsForScope("scope-2")).toEqual([]);

      if (!failedJob || failedJob.state !== "failed") {
        throw new Error("Expected failed terminal state");
      }
      expect(failedJob.error).toContain("boom");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
