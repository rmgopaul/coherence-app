import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  getDbExecuteAffectedRows: vi.fn(),
}));

vi.mock("../../db/_core", async () => {
  // Preserve real exports (sql template tag, ENV, etc.) so the module
  // under test still imports the drizzle SQL helpers it needs; swap
  // only the three symbols the DELETE path actually uses.
  const actual = await vi.importActual<typeof import("../../db/_core")>(
    "../../db/_core"
  );
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
    getDbExecuteAffectedRows: mocks.getDbExecuteAffectedRows,
  };
});

describe("deleteDatasetBatchRows", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.withDbRetry.mockReset();
    mocks.getDbExecuteAffectedRows.mockReset();
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

  it("issues a DELETE filtered by batchId against the correct typed table", async () => {
    const whereCall = vi.fn(async () => ({ affectedRows: 17 }));
    const deleteCall = vi.fn(() => ({ where: whereCall }));
    const db = { delete: deleteCall };

    mocks.getDb.mockResolvedValue(db);
    mocks.getDbExecuteAffectedRows.mockReturnValue(17);

    const { deleteDatasetBatchRows } = await import("./datasetRowPersistence");
    const { srDsTransferHistory } = await import("../../../drizzle/schema");

    const affected = await deleteDatasetBatchRows(
      "transferHistory",
      "batch-to-purge"
    );

    expect(affected).toBe(17);
    expect(deleteCall).toHaveBeenCalledTimes(1);
    expect(deleteCall).toHaveBeenCalledWith(srDsTransferHistory);
    expect(whereCall).toHaveBeenCalledTimes(1);
    // withDbRetry should label the operation so failures surface the
    // dataset we were purging.
    expect(mocks.withDbRetry).toHaveBeenCalledWith(
      "delete transferHistory batch rows",
      expect.any(Function)
    );
  });

  it("maps every known dataset key to its typed srDs* table", async () => {
    const { deleteDatasetBatchRows } = await import("./datasetRowPersistence");
    const schema = await import("../../../drizzle/schema");

    const expected: Array<[string, unknown]> = [
      ["solarApplications", schema.srDsSolarApplications],
      ["abpReport", schema.srDsAbpReport],
      ["generationEntry", schema.srDsGenerationEntry],
      ["accountSolarGeneration", schema.srDsAccountSolarGeneration],
      ["contractedDate", schema.srDsContractedDate],
      ["deliveryScheduleBase", schema.srDsDeliverySchedule],
      ["transferHistory", schema.srDsTransferHistory],
    ];

    for (const [datasetKey, table] of expected) {
      const whereCall = vi.fn(async () => ({ affectedRows: 1 }));
      const deleteCall = vi.fn(() => ({ where: whereCall }));
      mocks.getDb.mockResolvedValue({ delete: deleteCall });
      mocks.getDbExecuteAffectedRows.mockReturnValue(1);

      await deleteDatasetBatchRows(datasetKey, "batch-x");

      expect(deleteCall).toHaveBeenCalledWith(table);
    }
  });
});
