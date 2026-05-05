import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateDatasetVersion: vi.fn(),
  cloneDatasetBatchRows: vi.fn(),
  compactAccountSolarGenerationLatestMeterReads: vi.fn(),
  createImportBatch: vi.fn(),
  createImportErrors: vi.fn(),
  createImportFile: vi.fn(),
  getActiveBatchForDataset: vi.fn(),
  hasPersistence: vi.fn(),
  loadExistingRowKeys: vi.fn(),
  partitionAppendRowsByKeySet: vi.fn(),
  persistDatasetRows: vi.fn(),
  storagePut: vi.fn(),
  updateImportBatchStatus: vi.fn(),
}));

vi.mock("../../routers/helpers", () => ({
  parseCsvText: (csvText: string) => {
    const [headerLine = "", ...lines] = csvText.trim().split(/\r?\n/);
    const headers = headerLine.split(",");
    const rows = lines
      .filter(line => line.trim().length > 0)
      .map(line => {
        const values = line.split(",");
        return Object.fromEntries(
          headers.map((header, index) => [header, values[index] ?? ""])
        );
      });
    return { headers, rows };
  },
}));

vi.mock("../../db", () => ({
  activateDatasetVersion: mocks.activateDatasetVersion,
  createImportBatch: mocks.createImportBatch,
  createImportErrors: mocks.createImportErrors,
  createImportFile: mocks.createImportFile,
  getActiveBatchForDataset: mocks.getActiveBatchForDataset,
  updateImportBatchStatus: mocks.updateImportBatchStatus,
}));

vi.mock("../../storage", () => ({
  storagePut: mocks.storagePut,
}));

vi.mock("./datasetRowPersistence", () => ({
  cloneDatasetBatchRows: mocks.cloneDatasetBatchRows,
  compactAccountSolarGenerationLatestMeterReads:
    mocks.compactAccountSolarGenerationLatestMeterReads,
  hasPersistence: mocks.hasPersistence,
  loadExistingRowKeys: mocks.loadExistingRowKeys,
  partitionAppendRowsByKeySet: mocks.partitionAppendRowsByKeySet,
  persistDatasetRows: mocks.persistDatasetRows,
}));

import { ingestDataset } from "./datasetIngestion";

describe("ingestDataset", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createImportBatch.mockResolvedValue("batch-new");
    mocks.createImportFile.mockResolvedValue(undefined);
    mocks.storagePut.mockResolvedValue(undefined);
    mocks.createImportErrors.mockResolvedValue(undefined);
    mocks.updateImportBatchStatus.mockResolvedValue(undefined);
    mocks.hasPersistence.mockReturnValue(true);
    mocks.persistDatasetRows.mockImplementation(
      async (_scopeId, _batchId, _datasetKey, rows: unknown[]) => rows.length
    );
    mocks.getActiveBatchForDataset.mockResolvedValue({ id: "batch-active" });
    mocks.cloneDatasetBatchRows.mockResolvedValue(2);
    mocks.loadExistingRowKeys.mockResolvedValue(new Set<string>());
    mocks.partitionAppendRowsByKeySet.mockImplementation(
      (_datasetKey, rows: unknown[]) => ({ toInsert: rows, dedupedCount: 0 })
    );
    mocks.compactAccountSolarGenerationLatestMeterReads.mockResolvedValue({
      rowCount: 3,
      deletedRows: 1,
    });
    mocks.activateDatasetVersion.mockResolvedValue(undefined);
  });

  it("compacts legacy Account Solar Generation ingest before activation", async () => {
    const csv = [
      "Month of Generation,GATS Gen ID,Facility Name,Meter ID,Last Meter Read Date,Last Meter Read (kWh)",
      "03/01/2026,NON305284,Bruce Thompson - 26157,1,04/01/2026,66988",
      "03/01/2026,NON305284,Bruce Thompson - 26157,1,05/01/2026,68783",
    ].join("\n");

    const result = await ingestDataset(
      "scope-1",
      "accountSolarGeneration",
      csv,
      "asg.csv",
      "append",
      42
    );

    expect(result.rowCount).toBe(3);
    expect(
      mocks.compactAccountSolarGenerationLatestMeterReads
    ).toHaveBeenCalledWith("scope-1", "batch-new");
    expect(mocks.activateDatasetVersion).toHaveBeenCalledWith(
      "scope-1",
      "accountSolarGeneration",
      "batch-new",
      expect.objectContaining({ rowCount: 3 })
    );
  });
});
