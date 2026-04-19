import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  deleteDatasetBatchRows: vi.fn(),
}));

vi.mock("./db/_core", () => ({
  getDb: mocks.getDb,
  withDbRetry: mocks.withDbRetry,
}));

vi.mock("./services/solar/datasetRowPersistence", () => ({
  deleteDatasetBatchRows: mocks.deleteDatasetBatchRows,
}));

describe("solarRecDatasets", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getDb.mockReset();
    mocks.withDbRetry.mockReset();
    mocks.deleteDatasetBatchRows.mockReset();
    mocks.withDbRetry.mockImplementation(async (_operation, action) => action());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("activates dataset versions transactionally and updates batch metadata in the same unit of work", async () => {
    const events: string[] = [];
    const completedAt = new Date("2026-04-17T20:00:00.000Z");

    const tx = {
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            if (values.status === "superseded") {
              events.push("supersedeOldActive");
              return;
            }

            events.push("markNewBatchActive");
            expect(values.status).toBe("active");
            expect(values.rowCount).toBe(42);
            expect(values.completedAt).toBe(completedAt);
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => ({
          onDuplicateKeyUpdate: vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
            events.push("swapActivePointer");
            expect(values.scopeId).toBe("scope-1");
            expect(values.datasetKey).toBe("transferHistory");
            expect(values.batchId).toBe("batch-new");
            expect(set.batchId).toBe("batch-new");
            expect(set.activatedAt).toBeInstanceOf(Date);
          }),
        }),
      })),
    };

    const db = {
      transaction: vi.fn(async (callback: (trx: typeof tx) => Promise<void>) => {
        events.push("beginTransaction");
        await callback(tx);
        events.push("commitTransaction");
      }),
    };

    mocks.getDb.mockResolvedValue(db);

    const { activateDatasetVersion } = await import("./db/solarRecDatasets");

    await activateDatasetVersion("scope-1", "transferHistory", "batch-new", {
      rowCount: 42,
      completedAt,
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "beginTransaction",
      "supersedeOldActive",
      "swapActivePointer",
      "markNewBatchActive",
      "commitTransaction",
    ]);
  });

  it("marks orphaned in-flight import batches as failed on startup", async () => {
    let appliedUpdate: Record<string, unknown> | null = null;

    const db = {
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          appliedUpdate = values;
          return {
            where: vi.fn(async () => [{ affectedRows: 2 }]),
          };
        },
      })),
    };

    mocks.getDb.mockResolvedValue(db);

    const { clearOrphanedImportBatchesOnStartup } = await import(
      "./db/solarRecDatasets"
    );

    const cleared = await clearOrphanedImportBatchesOnStartup();

    expect(cleared).toBe(2);
    expect(appliedUpdate).not.toBeNull();
    expect(appliedUpdate?.status).toBe("failed");
    expect(appliedUpdate?.error).toBe("orphaned by server restart");
    expect(appliedUpdate?.completedAt).toBeInstanceOf(Date);
  });

  it("archives old superseded batches after purging their typed dataset rows", async () => {
    const oldCompletedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const recentCompletedAt = new Date();
    const archivedUpdates: Array<Record<string, unknown>> = [];

    const selectResults = [
      {
        from: vi.fn(async () => [{ batchId: "batch-active" }]),
      },
      {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  id: "batch-active",
                  datasetKey: "transferHistory",
                  completedAt: oldCompletedAt,
                },
                {
                  id: "batch-old",
                  datasetKey: "transferHistory",
                  completedAt: oldCompletedAt,
                },
                {
                  id: "batch-recent",
                  datasetKey: "transferHistory",
                  completedAt: recentCompletedAt,
                },
              ]),
            })),
          })),
        })),
      },
    ];

    const db = {
      select: vi.fn(() => {
        const next = selectResults.shift();
        if (!next) {
          throw new Error("Unexpected select call");
        }
        return next;
      }),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          archivedUpdates.push(values);
          return {
            where: vi.fn(async () => [{ affectedRows: 1 }]),
          };
        },
      })),
    };

    mocks.getDb.mockResolvedValue(db);
    mocks.deleteDatasetBatchRows.mockResolvedValue(321);

    const { archiveSupersededImportBatchesOnStartup } = await import(
      "./db/solarRecDatasets"
    );

    const result = await archiveSupersededImportBatchesOnStartup(5);

    expect(result).toEqual({ archivedBatches: 1, purgedRows: 321 });
    expect(mocks.deleteDatasetBatchRows).toHaveBeenCalledWith(
      "transferHistory",
      "batch-old"
    );
    expect(archivedUpdates).toEqual([{ status: "archived" }]);
  });
});
