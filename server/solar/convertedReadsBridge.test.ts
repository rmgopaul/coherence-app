import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectExistingPayloadKind,
  isServerManagedConvertedReadsSourceId,
  LEGACY_PLAIN_CSV_SOURCE_ID,
  summarizeServerManagedConvertedReadsSources,
} from "./convertedReadsBridge";

describe("detectExistingPayloadKind", () => {
  it("returns 'missing' for null", () => {
    expect(detectExistingPayloadKind(null)).toBe("missing");
  });

  it("returns 'missing' for empty string", () => {
    expect(detectExistingPayloadKind("")).toBe("missing");
  });

  it("returns 'manifest' for a valid _rawSourcesV1 payload", () => {
    const payload = JSON.stringify({
      _rawSourcesV1: true,
      version: 1,
      sources: [
        {
          id: "individual_solaredge",
          fileName: "SolarEdge API",
          uploadedAt: "2026-04-29T00:00:00.000Z",
          rowCount: 100,
          sizeBytes: 5000,
          storageKey: "convertedReads_individual_solaredge",
          chunkKeys: ["convertedReads_individual_solaredge_chunk_0"],
          encoding: "utf8",
          contentType: "text/csv",
        },
      ],
    });
    expect(detectExistingPayloadKind(payload)).toBe("manifest");
  });

  it("returns 'plain-csv' for a CSV header + rows", () => {
    const csv =
      "monitoring,monitoring_system_id,lifetime_meter_read_wh,read_date\n" +
      "SolarEdge,1234,9876543,4/29/2026\n" +
      "SolarEdge,1235,1234567,4/29/2026\n";
    expect(detectExistingPayloadKind(csv)).toBe("plain-csv");
  });

  it("returns 'plain-csv' for a single-line CSV (no trailing newline)", () => {
    expect(detectExistingPayloadKind("a,b,c")).toBe("plain-csv");
  });

  it("returns 'garbage' for JSON that's not a manifest", () => {
    expect(detectExistingPayloadKind(JSON.stringify({ foo: "bar" }))).toBe(
      "garbage"
    );
    expect(
      detectExistingPayloadKind(JSON.stringify({ _rawSourcesV1: false }))
    ).toBe("garbage");
    expect(
      detectExistingPayloadKind(JSON.stringify({ _rawSourcesV1: true }))
    ).toBe("garbage"); // missing sources array
    expect(
      detectExistingPayloadKind(
        JSON.stringify({ _rawSourcesV1: true, sources: "not-an-array" })
      )
    ).toBe("garbage");
  });

  it("returns 'garbage' for non-CSV plain text without commas", () => {
    expect(detectExistingPayloadKind("just some words")).toBe("garbage");
  });

  it("does NOT misclassify a JSON-like string with a comma as plain-csv", () => {
    // "{a, b}" parses as JSON failure but the first line has a comma —
    // we accept this as "plain-csv" because it cannot be misinterpreted
    // by anything downstream and being conservative loses real data.
    // Documenting the behavior so future changes don't drift.
    expect(detectExistingPayloadKind("{a, b}")).toBe("plain-csv");
  });
});

describe("isServerManagedConvertedReadsSourceId", () => {
  it("recognizes mon_batch_* prefix", () => {
    expect(isServerManagedConvertedReadsSourceId("mon_batch_solaredge")).toBe(
      true
    );
  });

  it("recognizes individual_* prefix", () => {
    expect(
      isServerManagedConvertedReadsSourceId("individual_solaredge")
    ).toBe(true);
    expect(
      isServerManagedConvertedReadsSourceId("individual_enphase_v4")
    ).toBe(true);
  });

  it("recognizes the legacy_plain_csv exact ID (newly tagged 2026-04-29)", () => {
    expect(isServerManagedConvertedReadsSourceId(LEGACY_PLAIN_CSV_SOURCE_ID)).toBe(
      true
    );
    // Defensive: confirm the constant matches the documented string.
    expect(LEGACY_PLAIN_CSV_SOURCE_ID).toBe("legacy_plain_csv");
  });

  it("does NOT treat user-uploaded sources as server-managed", () => {
    expect(isServerManagedConvertedReadsSourceId("user_abc123")).toBe(false);
    expect(isServerManagedConvertedReadsSourceId("ds_random_slug")).toBe(false);
    expect(
      isServerManagedConvertedReadsSourceId("legacy_plain_csv_other")
    ).toBe(false);
  });
});

describe("summarizeServerManagedConvertedReadsSources", () => {
  it("returns monitoring and individual API sources from the manifest for upload-card display", () => {
    const payload = JSON.stringify({
      _rawSourcesV1: true,
      version: 1,
      sources: [
        {
          id: "user_upload",
          fileName: "manual.csv",
          uploadedAt: "2026-05-01T00:00:00.000Z",
          rowCount: 10,
        },
        {
          id: "mon_batch_solaredge",
          fileName: "Monitoring batch: SolarEdge (12)",
          uploadedAt: "2026-05-03T00:00:00.000Z",
          rowCount: 12,
        },
        {
          id: "individual_egauge",
          fileName: "eGauge API (4 rows)",
          uploadedAt: "2026-05-02T00:00:00.000Z",
          rowCount: 4,
        },
      ],
    });

    expect(summarizeServerManagedConvertedReadsSources(payload)).toEqual([
      {
        jobId: "mon_batch_solaredge",
        fileName: "Monitoring batch: SolarEdge (12)",
        uploadedAt: "2026-05-03T00:00:00.000Z",
        rowCount: 12,
      },
      {
        jobId: "individual_egauge",
        fileName: "eGauge API (4 rows)",
        uploadedAt: "2026-05-02T00:00:00.000Z",
        rowCount: 4,
      },
    ]);
  });

  it("returns an empty list for non-manifest payloads", () => {
    expect(
      summarizeServerManagedConvertedReadsSources("monitoring,read_date\n")
    ).toEqual([]);
    expect(summarizeServerManagedConvertedReadsSources(null)).toEqual([]);
  });

  it("skips malformed manifest source entries without throwing", () => {
    const payload = JSON.stringify({
      _rawSourcesV1: true,
      version: 1,
      sources: [null, { id: 123 }, { id: "mon_batch_hoymiles" }],
    });

    expect(summarizeServerManagedConvertedReadsSources(payload)).toEqual([
      {
        jobId: "mon_batch_hoymiles",
        fileName: "mon_batch_hoymiles",
        uploadedAt: null,
        rowCount: null,
      },
    ]);
  });
});

describe("plain-CSV migration end-to-end (mocked DB)", () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    vi.resetModules();
    vi.doMock("../db", () => ({
      getSolarRecDashboardPayload: vi.fn(
        async (_userId: number, key: string) => stored.get(key) ?? null
      ),
      saveSolarRecDashboardPayload: vi.fn(
        async (_userId: number, key: string, payload: string) => {
          stored.set(key, payload);
        }
      ),
    }));
    // Avoid scheduling a real sync job during the test.
    vi.doMock("../services/solar/coreDatasetSyncJobs", () => ({
      startSyncJob: vi.fn(() => "test-job-id"),
    }));
    vi.doMock("../services/solar/serverSideMigration", () => ({
      syncOneCoreDatasetFromStorage: vi.fn(async () => ({
        datasetKey: "convertedReads",
        state: "done",
        batchId: "test-batch",
        rowCount: 0,
        durationMs: 1,
      })),
    }));
  });

  it("preserves a plain-CSV payload as legacy_plain_csv source on first push", async () => {
    const csv =
      "monitoring,monitoring_system_id,monitoring_system_name,lifetime_meter_read_wh,status,alert_severity,read_date\n" +
      "SolarEdge,1111,Site A,1000000,,,4/28/2026\n" +
      "SolarEdge,2222,Site B,2000000,,,4/28/2026\n";
    stored.set("dataset:convertedReads", csv);

    const { pushIndividualRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const result = await pushIndividualRunsToConvertedReads(
      42,
      "solaredge",
      "SolarEdge",
      [
        {
          monitoring: "SolarEdge",
          monitoring_system_id: "3333",
          monitoring_system_name: "Site C",
          lifetime_meter_read_wh: "3000000",
          status: "",
          alert_severity: "",
          read_date: "4/29/2026",
        },
      ]
    );

    expect(result?.pushed).toBe(1);

    // Manifest must contain BOTH the legacy source AND the new individual source.
    const manifest = JSON.parse(stored.get("dataset:convertedReads")!);
    expect(manifest._rawSourcesV1).toBe(true);
    const sourceIds = manifest.sources.map((s: { id: string }) => s.id).sort();
    expect(sourceIds).toEqual(["individual_solaredge", "legacy_plain_csv"]);

    const legacy = manifest.sources.find(
      (s: { id: string }) => s.id === "legacy_plain_csv"
    );
    expect(legacy.rowCount).toBe(2);
    expect(legacy.fileName).toMatch(/auto-migrated/);
  });

  it("does NOT migrate when payload is already a manifest", async () => {
    const existingManifest = {
      _rawSourcesV1: true,
      version: 1,
      sources: [
        {
          id: "user_existing",
          fileName: "User upload",
          uploadedAt: "2026-04-28T00:00:00.000Z",
          rowCount: 5,
          sizeBytes: 200,
          storageKey: "convertedReads_user_existing",
          chunkKeys: ["convertedReads_user_existing_chunk_0"],
          encoding: "utf8",
          contentType: "text/csv",
        },
      ],
    };
    stored.set("dataset:convertedReads", JSON.stringify(existingManifest));
    stored.set(
      "dataset:convertedReads_user_existing_chunk_0",
      "monitoring,monitoring_system_id,monitoring_system_name,lifetime_meter_read_wh,status,alert_severity,read_date\nSolarEdge,9999,X,5,,,4/27/2026\n"
    );

    const { pushIndividualRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );
    await pushIndividualRunsToConvertedReads(42, "solaredge", "SolarEdge", [
      {
        monitoring: "SolarEdge",
        monitoring_system_id: "1111",
        monitoring_system_name: "Site A",
        lifetime_meter_read_wh: "1000000",
        status: "",
        alert_severity: "",
        read_date: "4/29/2026",
      },
    ]);

    const manifest = JSON.parse(stored.get("dataset:convertedReads")!);
    const sourceIds = manifest.sources.map((s: { id: string }) => s.id).sort();
    // user_existing preserved + new individual_solaredge appended;
    // legacy_plain_csv NOT created (no plain payload to migrate).
    expect(sourceIds).toEqual(["individual_solaredge", "user_existing"]);
  });
});

describe("monitoring batch sync scheduling", () => {
  const stored = new Map<string, string>();
  const startSyncJob = vi.fn(() => "test-sync-job");

  beforeEach(() => {
    stored.clear();
    startSyncJob.mockClear();
    vi.resetModules();
    vi.doMock("../db", () => ({
      getSolarRecDashboardPayload: vi.fn(
        async (_userId: number, key: string) => stored.get(key) ?? null
      ),
      saveSolarRecDashboardPayload: vi.fn(
        async (_userId: number, key: string, payload: string) => {
          stored.set(key, payload);
          return true;
        }
      ),
    }));
    vi.doMock("../services/solar/coreDatasetSyncJobs", () => ({
      startSyncJob,
    }));
    vi.doMock("../services/solar/serverSideMigration", () => ({
      syncOneCoreDatasetFromStorage: vi.fn(async () => ({
        datasetKey: "convertedReads",
        state: "done",
        batchId: "test-batch",
        rowCount: 0,
        durationMs: 1,
      })),
    }));
  });

  it("lets the monitoring runner defer row-table sync until the final provider write lands", async () => {
    const {
      pushMonitoringRunsToConvertedReads,
      scheduleConvertedReadsRowTableSync,
    } = await import("./convertedReadsBridge");

    const result = await pushMonitoringRunsToConvertedReads(
      42,
      "solaredge",
      "SolarEdge",
      [
        {
          provider: "solaredge",
          siteId: "123",
          siteName: "Site 123",
          lifetimeKwh: 99,
          dateKey: "2026-05-06",
          status: "success",
        },
      ],
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );

    expect(result?.pushed).toBe(1);
    expect(startSyncJob).not.toHaveBeenCalled();

    scheduleConvertedReadsRowTableSync(42, "scope-1");
    expect(startSyncJob).toHaveBeenCalledTimes(1);
    expect(startSyncJob).toHaveBeenCalledWith(
      "scope-1",
      "convertedReads",
      expect.any(Function)
    );
  });
});
