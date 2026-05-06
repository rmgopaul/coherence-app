import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveBatchForDataset: vi.fn(),
  loadDatasetRowsPage: vi.fn(),
}));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db")>("../../db");
  return {
    ...actual,
    getActiveBatchForDataset: mocks.getActiveBatchForDataset,
  };
});

vi.mock("./buildSystemSnapshot", async () => {
  const actual = await vi.importActual<typeof import("./buildSystemSnapshot")>(
    "./buildSystemSnapshot"
  );
  return {
    ...actual,
    loadDatasetRowsPage: mocks.loadDatasetRowsPage,
  };
});

import {
  DASHBOARD_DATASET_CSV_EXPORT_KEYS,
  buildDatasetCsvExport,
  isDashboardDatasetCsvExportKey,
} from "./dashboardDatasetCsvExport";

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildDatasetCsvExport", () => {
  it("returns an empty artifact when there is no active batch", async () => {
    mocks.getActiveBatchForDataset.mockResolvedValue(null);

    const result = await buildDatasetCsvExport(
      "scope-a",
      "transferHistory",
      "2026-05-06T12:34:56.000Z"
    );

    expect(result).toEqual({
      csv: "",
      fileName: "dataset-transfer-history-20260506123456.csv",
      rowCount: 0,
      csvBytes: 0,
    });
    expect(mocks.loadDatasetRowsPage).not.toHaveBeenCalled();
  });

  it("builds a consistent two-pass CSV when later pages add sparse headers", async () => {
    mocks.getActiveBatchForDataset.mockResolvedValue({ id: "batch-1" });
    mocks.loadDatasetRowsPage.mockImplementation(
      async (
        _scopeId: string,
        _batchId: string,
        _table: unknown,
        options: { cursor: string | null }
      ) => {
        if (options.cursor === null) {
          return {
            rows: [{ alpha: "1" }],
            rowIds: ["row-1"],
            nextCursor: "row-1",
          };
        }
        if (options.cursor === "row-1") {
          return {
            rows: [{ alpha: "2", beta: "B" }],
            rowIds: ["row-2"],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected cursor ${options.cursor}`);
      }
    );

    const result = await buildDatasetCsvExport(
      "scope-a",
      "solarApplications",
      "2026-05-06T12:34:56.000Z"
    );

    expect(result.rowCount).toBe(2);
    expect(result.fileName).toBe(
      "dataset-solar-applications-20260506123456.csv"
    );
    expect(result.csv).toBeUndefined();
    expect(result.filePath).toBeTruthy();
    expect(result.csvBytes).toBeGreaterThan(0);
    const csv = await readFile(result.filePath!, "utf8");
    expect(csv).toBe(["alpha,beta", "1,", "2,B"].join("\n"));
    expect(mocks.loadDatasetRowsPage).toHaveBeenCalledTimes(4);
    await result.cleanup?.();
    await expect(stat(result.filePath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("isDashboardDatasetCsvExportKey", () => {
  it("accepts all raw dashboard dataset export keys and rejects unknown keys", () => {
    for (const key of DASHBOARD_DATASET_CSV_EXPORT_KEYS) {
      expect(isDashboardDatasetCsvExportKey(key)).toBe(true);
    }
    expect(isDashboardDatasetCsvExportKey("notARealDataset")).toBe(false);
    expect(isDashboardDatasetCsvExportKey(null)).toBe(false);
  });
});
