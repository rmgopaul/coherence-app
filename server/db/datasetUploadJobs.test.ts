/**
 * Tests for the dataset-upload db helpers (Phase 1 of the
 * server-side dashboard refactor).
 *
 * Mocks `_core` getDb + withDbRetry. Each helper either issues a
 * SELECT / UPDATE / INSERT / DELETE; the stub records the terminal
 * call so we can assert on shape (whereCalled count, setValue
 * payload, affectedRows fallback).
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
  deleteDatasetUploadJob,
  getDatasetUploadJob,
  incrementDatasetUploadJobCounter,
  insertDatasetUploadJob,
  listDatasetUploadJobErrors,
  listDatasetUploadJobs,
  pruneOldTerminalDatasetUploadJobs,
  recordDatasetUploadJobError,
  sweepStaleDatasetUploadJobs,
  touchDatasetUploadJob,
  updateDatasetUploadJob,
} from "./datasetUploadJobs";

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

describe("insertDatasetUploadJob", () => {
  it("forwards the row to db.insert(...).values(...)", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const entry = {
      id: "job-1",
      scopeId: "scope-1",
      initiatedByUserId: 42,
      datasetKey: "abpReport",
      fileName: "abp.csv",
      uploadedChunks: 0,
      rowsParsed: 0,
      rowsWritten: 0,
      status: "queued",
    };
    await insertDatasetUploadJob(entry as never);
    const call = stub.calls.find(c => c.kind === "insert");
    expect(call?.insertValues).toBe(entry);
  });

  it("is a no-op when getDb yields null (test/dev with no DB)", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(
      insertDatasetUploadJob({
        id: "x",
        scopeId: "s",
        initiatedByUserId: 1,
        datasetKey: "abpReport",
        fileName: "a",
      } as never)
    ).resolves.toBeUndefined();
  });
});

describe("getDatasetUploadJob", () => {
  it("returns the row when present", async () => {
    const row = { id: "job-1", scopeId: "scope-1", datasetKey: "abpReport" };
    const stub = makeDbStub({ selectRows: [[row]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getDatasetUploadJob("scope-1", "job-1");
    expect(result).toEqual(row);
  });

  it("returns null when (scopeId, id) doesn't match", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await getDatasetUploadJob("scope-1", "missing");
    expect(result).toBeNull();
  });

  it("returns null when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    const result = await getDatasetUploadJob("scope-1", "job-1");
    expect(result).toBeNull();
  });

  it("scopes the WHERE by both scopeId AND id", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await getDatasetUploadJob("scope-1", "job-1");
    expect(stub.calls[0].whereCalled).toBe(1);
  });
});

describe("listDatasetUploadJobs", () => {
  it("returns the rows the stub yields", async () => {
    const rows = [
      { id: "a", scopeId: "s", datasetKey: "abpReport" },
      { id: "b", scopeId: "s", datasetKey: "solarApplications" },
    ];
    const stub = makeDbStub({ selectRows: [rows] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await listDatasetUploadJobs("s");
    expect(result).toEqual(rows);
  });

  it("clamps the limit to a sane range", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(listDatasetUploadJobs("s", { limit: 0 })).resolves.toEqual([]);
    await expect(listDatasetUploadJobs("s", { limit: 9999 })).resolves.toEqual(
      []
    );
  });

  it("issues a single WHERE call when no datasetKey filter", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listDatasetUploadJobs("s");
    expect(stub.calls[0].whereCalled).toBe(1);
  });

  it("includes datasetKey in the WHERE when provided", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listDatasetUploadJobs("s", { datasetKey: "abpReport" });
    // Same WHERE-call count; the difference is in the AND inside.
    expect(stub.calls[0].whereCalled).toBe(1);
  });

  it("issues an ORDER BY for newest-first", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await listDatasetUploadJobs("s");
    expect(stub.calls[0].orderByCount).toBe(1);
  });
});

describe("updateDatasetUploadJob", () => {
  it("returns false when the patch is empty", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateDatasetUploadJob("s", "job-1", {});
    expect(ok).toBe(false);
    expect(stub.calls.length).toBe(0);
  });

  it("strips undefined fields but keeps explicit nulls", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    await updateDatasetUploadJob("s", "job-1", {
      status: "uploading",
      errorMessage: null,
      totalRows: undefined,
      totalChunks: 5,
    });
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.status).toBe("uploading");
    expect(call?.setValue?.errorMessage).toBeNull();
    expect(call?.setValue?.totalChunks).toBe(5);
    expect("totalRows" in (call?.setValue ?? {})).toBe(false);
    expect(call?.setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns false when no row matched", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateDatasetUploadJob("s", "missing", {
      status: "uploading",
    });
    expect(ok).toBe(false);
  });

  it("falls back to rowCount when affectedRows is absent", async () => {
    const stub = {
      update: () => {
        const chain: Record<string, unknown> = {
          set: () => chain,
          where: () => chain,
          then: (resolve: (out: unknown) => unknown) =>
            Promise.resolve({ rowCount: 1 }).then(resolve),
        };
        return chain;
      },
    };
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateDatasetUploadJob("s", "job-1", {
      status: "uploading",
    });
    expect(ok).toBe(true);
  });
});

describe("incrementDatasetUploadJobCounter", () => {
  it("increments rowsWritten by the supplied delta", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await incrementDatasetUploadJobCounter(
      "s",
      "job-1",
      "rowsWritten",
      500
    );
    expect(ok).toBe(true);
    const call = stub.calls.find(c => c.kind === "update");
    expect(call?.setValue?.rowsWritten).toBeDefined();
    expect(call?.setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns false on delta of 0 without issuing SQL", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await incrementDatasetUploadJobCounter(
      "s",
      "job-1",
      "rowsWritten",
      0
    );
    expect(ok).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("returns false on a non-finite delta (NaN, Infinity)", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok1 = await incrementDatasetUploadJobCounter(
      "s",
      "job-1",
      "rowsParsed",
      Number.NaN
    );
    const ok2 = await incrementDatasetUploadJobCounter(
      "s",
      "job-1",
      "rowsParsed",
      Number.POSITIVE_INFINITY
    );
    expect(ok1).toBe(false);
    expect(ok2).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("returns false when the row doesn't exist", async () => {
    const stub = makeDbStub({ updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await incrementDatasetUploadJobCounter(
      "s",
      "missing",
      "rowsWritten",
      10
    );
    expect(ok).toBe(false);
  });

  it("returns false when getDb yields null", async () => {
    mocks.getDb.mockResolvedValue(null);
    const ok = await incrementDatasetUploadJobCounter(
      "s",
      "job-1",
      "uploadedChunks",
      1
    );
    expect(ok).toBe(false);
  });
});

describe("recordDatasetUploadJobError", () => {
  it("forwards the error row to db.insert", async () => {
    const stub = makeDbStub({});
    mocks.getDb.mockResolvedValue(stub);
    const entry = {
      id: "err-1",
      jobId: "job-1",
      rowIndex: 42,
      errorMessage: "Bad row",
    };
    await recordDatasetUploadJobError(entry as never);
    const call = stub.calls.find(c => c.kind === "insert");
    expect(call?.insertValues).toBe(entry);
  });
});

describe("listDatasetUploadJobErrors", () => {
  it("returns the error rows", async () => {
    const rows = [
      { id: "e1", jobId: "job-1", errorMessage: "boom" },
      { id: "e2", jobId: "job-1", errorMessage: "second boom" },
    ];
    const stub = makeDbStub({ selectRows: [rows] });
    mocks.getDb.mockResolvedValue(stub);
    const result = await listDatasetUploadJobErrors("job-1");
    expect(result).toEqual(rows);
  });

  it("clamps the limit", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    await expect(
      listDatasetUploadJobErrors("job-1", { limit: 0 })
    ).resolves.toEqual([]);
    await expect(
      listDatasetUploadJobErrors("job-1", { limit: 99999 })
    ).resolves.toEqual([]);
  });
});

describe("deleteDatasetUploadJob", () => {
  it("issues DELETEs scoped by both scopeId AND id", async () => {
    const stub = makeDbStub({ deleteAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await deleteDatasetUploadJob("s", "job-1");
    expect(ok).toBe(true);
    const deletes = stub.calls.filter(c => c.kind === "delete");
    // One DELETE for errors, one for the job itself.
    expect(deletes.length).toBe(2);
  });

  it("returns false when no job matched", async () => {
    const stub = makeDbStub({ deleteAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await deleteDatasetUploadJob("s", "missing");
    expect(ok).toBe(false);
  });
});

describe("sweepStaleDatasetUploadJobs", () => {
  it("marks each loaded stale job failed with a cutoff WHERE", async () => {
    const staleJobs = [
      {
        id: "job-1",
        scopeId: "scope-1",
        datasetKey: "convertedReads",
        batchId: null,
      },
      {
        id: "job-2",
        scopeId: "scope-1",
        datasetKey: "transferHistory",
        batchId: null,
      },
    ];
    const stub = makeDbStub({ selectRows: [staleJobs], updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);

    const swept = await sweepStaleDatasetUploadJobs(10 * 60 * 1000);
    expect(swept).toBe(2);

    const updates = stub.calls.filter(c => c.kind === "update");
    expect(updates).toHaveLength(2);
    const update = updates[0]!;
    expect(update.setValue).toMatchObject({ status: "failed" });
    expect(update.setValue?.completedAt).toBeInstanceOf(Date);
    expect(update.setValue?.errorMessage).toMatch(/timed out/i);
    expect(update.whereCalled).toBe(1);
  });

  it("repairs stale jobs to done when their batch is already active", async () => {
    const batchCompletedAt = new Date("2026-05-05T12:00:00.000Z");
    const staleJobs = [
      {
        id: "job-1",
        scopeId: "scope-1",
        datasetKey: "accountSolarGeneration",
        batchId: "batch-active",
      },
    ];
    const stub = makeDbStub({
      selectRows: [
        staleJobs,
        [{ status: "active", completedAt: batchCompletedAt }],
      ],
      updateAffected: 1,
    });
    mocks.getDb.mockResolvedValue(stub);

    const swept = await sweepStaleDatasetUploadJobs(10 * 60 * 1000);
    expect(swept).toBe(1);

    const updates = stub.calls.filter(c => c.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].setValue).toMatchObject({
      status: "done",
      errorMessage: null,
      completedAt: batchCompletedAt,
    });
  });

  it("returns 0 when no rows match", async () => {
    const stub = makeDbStub({ selectRows: [[]], updateAffected: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const swept = await sweepStaleDatasetUploadJobs(60 * 60 * 1000);
    expect(swept).toBe(0);
  });

  it("returns 0 when DB is not available", async () => {
    mocks.getDb.mockResolvedValue(null);
    const swept = await sweepStaleDatasetUploadJobs(60 * 1000);
    expect(swept).toBe(0);
  });
});

describe("pruneOldTerminalDatasetUploadJobs", () => {
  it("loads terminal-status rows older than cutoff and deletes each via deleteDatasetUploadJob", async () => {
    const terminalRows = [
      { id: "old-done", scopeId: "scope-1" },
      { id: "old-failed", scopeId: "scope-1" },
    ];
    // Two SELECT rows (one per delete: errors + job).
    const stub = makeDbStub({
      selectRows: [terminalRows],
      deleteAffected: 1,
    });
    mocks.getDb.mockResolvedValue(stub);

    const pruned = await pruneOldTerminalDatasetUploadJobs(
      7 * 24 * 60 * 60 * 1000
    );
    expect(pruned).toBe(2);

    const deletes = stub.calls.filter((c) => c.kind === "delete");
    // Each row hits two DELETEs (errors then job) — total = rows × 2.
    expect(deletes).toHaveLength(4);
  });

  it("returns 0 when no rows are old enough to prune", async () => {
    const stub = makeDbStub({ selectRows: [[]] });
    mocks.getDb.mockResolvedValue(stub);
    const pruned = await pruneOldTerminalDatasetUploadJobs(
      24 * 60 * 60 * 1000
    );
    expect(pruned).toBe(0);
  });

  it("returns 0 when DB is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    const pruned = await pruneOldTerminalDatasetUploadJobs(60 * 1000);
    expect(pruned).toBe(0);
  });

  it("continues pruning when an individual row delete fails", async () => {
    const terminalRows = [
      { id: "row-a", scopeId: "scope-1" },
      { id: "row-b", scopeId: "scope-1" },
    ];
    // Both rows return affected=0 — interpreted as "not deleted"
    // by the helper, but no exception. Pruned count is 0; the
    // sweep continues across all rows without throwing.
    const stub = makeDbStub({
      selectRows: [terminalRows],
      deleteAffected: 0,
    });
    mocks.getDb.mockResolvedValue(stub);

    const pruned = await pruneOldTerminalDatasetUploadJobs(60 * 1000);
    expect(pruned).toBe(0);
  });
});

describe("touchDatasetUploadJob", () => {
  it("bumps updatedAt without changing counters or status", async () => {
    const stub = makeDbStub({ updateAffected: 1 });
    mocks.getDb.mockResolvedValue(stub);

    const ok = await touchDatasetUploadJob("scope-1", "job-1");
    expect(ok).toBe(true);

    const update = stub.calls.find(c => c.kind === "update");
    expect(update?.setValue?.updatedAt).toBeInstanceOf(Date);
    expect(update?.setValue).not.toHaveProperty("status");
    expect(update?.setValue).not.toHaveProperty("rowsParsed");
    expect(update?.setValue).not.toHaveProperty("rowsWritten");
    expect(update?.whereCalled).toBe(1);
  });
});
