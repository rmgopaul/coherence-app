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

  // 2026-05-12 — regression rails for the auto-heal silent-empty
  // bug. When ingestDataset is fed a CSV whose headers validate
  // but whose body has 0 data rows (e.g. a header-only export or
  // a multi-source manifest whose source files are all empty),
  // the prior behavior was to activate the new batch with
  // rowCount=0 — leaving `populationStatus === "empty"` and tab
  // aggregators silently empty. New guard fails ingest loudly.
  describe("0-row guard (2026-05-12)", () => {
    it("refuses to activate when the CSV has valid headers but 0 data rows", async () => {
      const csv =
        "System ID,Payment Number,Total RECS,REC Price,Invoice Amount ($)\n";

      const result = await ingestDataset(
        "scope-1",
        "abpUtilityInvoiceRows",
        csv,
        "test.csv",
        "replace",
        42
      );

      expect(result.status).toBe("failed");
      expect(result.rowCount).toBe(0);
      expect(result.errors[0]?.message).toMatch(/parsed to 0 data rows/);
      expect(result.errors[0]?.message).toMatch(/System ID/);
      expect(mocks.activateDatasetVersion).not.toHaveBeenCalled();
      expect(mocks.updateImportBatchStatus).toHaveBeenCalledWith(
        "batch-new",
        "failed",
        expect.objectContaining({
          error: expect.stringMatching(/0 data rows/),
        })
      );
    });

    it("still fails on bad headers (existing rail — pin against shadowing)", async () => {
      const csv = "wrong,headers,for,this\nrow1,row2,row3,row4\n";

      const result = await ingestDataset(
        "scope-1",
        "abpUtilityInvoiceRows",
        csv,
        "test.csv",
        "replace",
        42
      );

      expect(result.status).toBe("failed");
      expect(result.errors[0]?.message).toMatch(/missing required columns/);
      expect(mocks.activateDatasetVersion).not.toHaveBeenCalled();
    });

    it("error message names the file size for diagnosability", async () => {
      const csv =
        "systemId,paymentNumber,recQuantity,recPrice,invoiceAmount" +
        " ".repeat(120) +
        "\n";

      const result = await ingestDataset(
        "scope-1",
        "abpUtilityInvoiceRows",
        csv,
        "test.csv",
        "replace",
        42
      );

      expect(result.status).toBe("failed");
      expect(result.errors[0]?.message).toMatch(
        new RegExp(`File size: ${csv.length} bytes`)
      );
    });

    it("a CSV with one valid data row still activates normally", async () => {
      // Regression rail: the guard fires on `parsed.rows.length
      // === 0`, NOT on `csvText.length` heuristics. Adding any
      // non-empty row should bypass the guard.
      const csv = [
        "systemId,paymentNumber,recQuantity,recPrice,invoiceAmount",
        "SYS-1,PAY-1,100,5.5,550",
      ].join("\n");

      const result = await ingestDataset(
        "scope-1",
        "abpUtilityInvoiceRows",
        csv,
        "test.csv",
        "replace",
        42
      );

      expect(result.status).toBe("active");
      expect(result.rowCount).toBe(1);
      expect(mocks.activateDatasetVersion).toHaveBeenCalled();
    });
  });
});
