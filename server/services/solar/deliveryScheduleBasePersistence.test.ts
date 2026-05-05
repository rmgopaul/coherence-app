import { describe, expect, it, vi } from "vitest";
import {
  persistDeliveryScheduleBaseCanonical,
  normalizeDeliveryScheduleBaseHeaders,
  type PersistDeliveryScheduleBaseCanonicalDeps,
} from "./deliveryScheduleBasePersistence";

function buildDeps(overrides: Partial<PersistDeliveryScheduleBaseCanonicalDeps> = {}) {
  const deps: PersistDeliveryScheduleBaseCanonicalDeps = {
    buildCsvText: vi.fn((headers, rows) => {
      const body = rows.map((row) =>
        headers.map((header) => row[header] ?? "").join(",")
      );
      return [headers.join(","), ...body].join("\n");
    }),
    ingestDataset: vi.fn(async () => ({
      batchId: "batch-123",
      status: "active" as const,
      rowCount: 1,
      dedupedCount: 0,
      errors: [],
    })),
    saveSolarRecDashboardPayload: vi.fn(async () => true),
    storagePut: vi.fn(async () => ({ key: "storage-key", url: "https://example.test/object" })),
    upsertSolarRecDatasetSyncState: vi.fn(async () => true),
    ...overrides,
  };
  return deps;
}

describe("persistDeliveryScheduleBaseCanonical", () => {
  it("creates an active deliveryScheduleBase batch before writing the compatibility blob", async () => {
    const callOrder: string[] = [];
    const deps = buildDeps({
      ingestDataset: vi.fn(async () => {
        callOrder.push("ingest");
        return {
          batchId: "batch-abc",
          status: "active" as const,
          rowCount: 1,
          dedupedCount: 0,
          errors: [],
        };
      }),
      saveSolarRecDashboardPayload: vi.fn(async () => {
        callOrder.push("db");
        return true;
      }),
      storagePut: vi.fn(async () => {
        callOrder.push("storage");
        return { key: "storage-key", url: "https://example.test/object" };
      }),
      upsertSolarRecDatasetSyncState: vi.fn(async () => {
        callOrder.push("sync-state");
        return true;
      }),
    });

    const result = await persistDeliveryScheduleBaseCanonical(
      {
        scopeId: "solar-rec",
        userId: 7,
        storagePath: "solar-rec-dashboard/solar-rec/datasets/deliveryScheduleBase.json",
        fileName: "Schedule B Import",
        uploadedAt: "2026-05-05T00:00:00.000Z",
        headers: ["system_name"],
        rows: [
          {
            tracking_system_ref_id: "NON100",
            system_name: "Test System",
          },
        ],
      },
      deps
    );

    expect(deps.ingestDataset).toHaveBeenCalledWith(
      "solar-rec",
      "deliveryScheduleBase",
      "tracking_system_ref_id,system_name\nNON100,Test System",
      "Schedule B Import",
      "replace",
      7
    );
    expect(callOrder[0]).toBe("ingest");
    expect(callOrder).toEqual(["ingest", "db", "storage", "sync-state"]);
    expect(result.batchId).toBe("batch-abc");
    expect(result.rowCount).toBe(1);
    expect(result.persistedToDatabase).toBe(true);
    expect(result.storageSynced).toBe(true);
    expect(result.syncStateUpdated).toBe(true);
  });

  it("does not write the legacy compatibility blob when row-table ingest fails", async () => {
    const deps = buildDeps({
      ingestDataset: vi.fn(async () => ({
        batchId: "batch-failed",
        status: "failed" as const,
        rowCount: 0,
        dedupedCount: 0,
        errors: [{ rowIndex: -1, message: "Row persistence failed" }],
      })),
    });

    await expect(
      persistDeliveryScheduleBaseCanonical(
        {
          scopeId: "solar-rec",
          userId: 7,
          storagePath:
            "solar-rec-dashboard/solar-rec/datasets/deliveryScheduleBase.json",
          fileName: "Schedule B Import",
          uploadedAt: "2026-05-05T00:00:00.000Z",
          headers: ["tracking_system_ref_id"],
          rows: [{ tracking_system_ref_id: "NON100" }],
        },
        deps
      )
    ).rejects.toThrow(/row-table ingest failed/);

    expect(deps.saveSolarRecDashboardPayload).not.toHaveBeenCalled();
    expect(deps.storagePut).not.toHaveBeenCalled();
    expect(deps.upsertSolarRecDatasetSyncState).not.toHaveBeenCalled();
  });

  it("keeps tracking_system_ref_id in the CSV header even for empty repairs", () => {
    expect(normalizeDeliveryScheduleBaseHeaders([], [])).toEqual([
      "tracking_system_ref_id",
    ]);
  });
});
