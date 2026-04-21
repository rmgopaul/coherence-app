import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));

// Preserve the real _core exports (sql tag, getDbExecuteAffectedRows,
// ENV, etc.) so the module under test wires up its SQL helpers for
// real. We only swap the two symbols that actually talk to the DB.
vi.mock("../../db/_core", async () => {
  const actual = await vi.importActual<typeof import("../../db/_core")>(
    "../../db/_core"
  );
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
  };
});

describe("deleteDatasetBatchRows", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.withDbRetry.mockReset();
    // Pass-through: invoke the action so we can inspect the drizzle
    // query chain the function built.
    mocks.withDbRetry.mockImplementation(async (_label, action) => action());
  });

  it("returns 0 without hitting the database for an unknown dataset key", async () => {
    const { deleteDatasetBatchRows } = await import("./datasetRowPersistence");
    const result = await deleteDatasetBatchRows("not-a-real-dataset", "batch-x");
    expect(result).toBe(0);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("throws when the database is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    const { deleteDatasetBatchRows } = await import("./datasetRowPersistence");
    await expect(
      deleteDatasetBatchRows("transferHistory", "batch-x")
    ).rejects.toThrow("Database not available");
  });

  it("issues a DELETE filtered by (table, batchId) and returns the affected row count", async () => {
    const whereCall = vi.fn(async () => ({ affectedRows: 17 }));
    const deleteCall = vi.fn(() => ({ where: whereCall }));
    mocks.getDb.mockResolvedValue({ delete: deleteCall });

    const { deleteDatasetBatchRows } = await import("./datasetRowPersistence");
    const { srDsTransferHistory } = await import("../../../drizzle/schema");

    const affected = await deleteDatasetBatchRows(
      "transferHistory",
      "batch-to-purge"
    );

    // End-to-end: real getDbExecuteAffectedRows extracts 17 from the
    // { affectedRows: 17 } shape our mocked .where() returned.
    expect(affected).toBe(17);

    expect(deleteCall).toHaveBeenCalledTimes(1);
    expect(deleteCall).toHaveBeenCalledWith(srDsTransferHistory);

    // Verify the WHERE clause is eq(table.batchId, batchId) — guards
    // against a column swap (scopeId vs batchId) or value swap
    // (datasetKey vs batchId) that the mapping assertion wouldn't
    // catch on its own.
    expect(whereCall).toHaveBeenCalledTimes(1);
    expect(whereCall).toHaveBeenCalledWith(
      eq(srDsTransferHistory.batchId, "batch-to-purge")
    );

    // Label carries the dataset key so a failing DB retry surfaces
    // which dataset was being purged; exact wording is internal.
    expect(mocks.withDbRetry).toHaveBeenCalledWith(
      expect.stringContaining("transferHistory"),
      expect.any(Function)
    );
  });

  it("maps every exported dataset key to its typed srDs* table", async () => {
    const { deleteDatasetBatchRows, SRDS_TABLES } = await import(
      "./datasetRowPersistence"
    );

    const entries = Object.entries(SRDS_TABLES) as Array<
      [keyof typeof SRDS_TABLES, (typeof SRDS_TABLES)[keyof typeof SRDS_TABLES]]
    >;
    expect(entries.length).toBe(7);

    for (const [datasetKey, table] of entries) {
      const whereCall = vi.fn(async () => ({ affectedRows: 0 }));
      const deleteCall = vi.fn(() => ({ where: whereCall }));
      mocks.getDb.mockResolvedValue({ delete: deleteCall });

      await deleteDatasetBatchRows(datasetKey, "batch-x");

      expect(deleteCall).toHaveBeenCalledWith(table);
      expect(whereCall).toHaveBeenCalledWith(eq(table.batchId, "batch-x"));
    }
  });
});
