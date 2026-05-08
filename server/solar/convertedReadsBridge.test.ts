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

// ---------------------------------------------------------------------------
// 2026-05-08 Tesla dual-ID emission: when a Tesla Powerhub run carries an
// STE ID (siteExternalId) distinct from the alphanumeric siteId, the bridge
// emits TWO converted-reads rows per site so the Performance Ratio matcher
// finds systems regardless of which identifier the system DB stored.
// ---------------------------------------------------------------------------

describe("Tesla Powerhub dual-ID converted-reads emission", () => {
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
          return true;
        }
      ),
    }));
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

  async function readManifestRows(): Promise<Record<string, string>[]> {
    const manifest = JSON.parse(stored.get("dataset:convertedReads")!);
    expect(manifest._rawSourcesV1).toBe(true);
    expect(manifest.sources).toHaveLength(1);
    const source = manifest.sources[0];
    // The bridge writes the CSV across `chunkKeys`, with a chunk-pointer
    // JSON stored under `source.storageKey`. Tiny test payloads collapse
    // to one chunk; reassembly tracks the runtime path in
    // `loadSourceRows`.
    const chunkKeys: string[] = source.chunkKeys ?? [];
    const parts: string[] = [];
    for (const key of chunkKeys) {
      const part = stored.get(`dataset:${key}`);
      if (part !== undefined) parts.push(part);
    }
    const rawCsv = parts.join("");
    const lines = rawCsv.split("\n").filter(Boolean);
    const headers = lines[0]!.split(",");
    return lines.slice(1).map((line) => {
      const cells = line.split(",");
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] ?? "";
      });
      return row;
    });
  }

  it("emits TWO rows per Tesla site (alphanumeric + STE) when siteExternalId is present and distinct", async () => {
    const { pushMonitoringRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const result = await pushMonitoringRunsToConvertedReads(
      42,
      "tesla-powerhub",
      "Tesla",
      [
        {
          provider: "tesla-powerhub",
          siteId: "abcd-1234-uuid-shape",
          siteName: "Acme Solar",
          lifetimeKwh: 1234.5,
          dateKey: "2026-05-08",
          status: "success",
          siteExternalId: "STE9876",
        },
      ],
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );

    expect(result?.pushed).toBe(2);
    const rows = await readManifestRows();
    expect(rows).toHaveLength(2);

    const idsEmitted = rows.map((r) => r.monitoring_system_id).sort();
    expect(idsEmitted).toEqual(["STE9876", "abcd-1234-uuid-shape"]);

    // Both rows share monitoring + name + reading + date.
    rows.forEach((r) => {
      expect(r.monitoring).toBe("Tesla");
      expect(r.monitoring_system_name).toBe("Acme Solar");
      expect(r.lifetime_meter_read_wh).toBe(String(Math.round(1234.5 * 1000)));
      expect(r.read_date).toBe("5/8/2026");
    });
  });

  it("emits ONE row when siteExternalId is missing (no alternate to duplicate)", async () => {
    const { pushMonitoringRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const result = await pushMonitoringRunsToConvertedReads(
      42,
      "tesla-powerhub",
      "Tesla",
      [
        {
          provider: "tesla-powerhub",
          siteId: "abcd-1234-uuid-shape",
          siteName: "Acme Solar",
          lifetimeKwh: 1000,
          dateKey: "2026-05-08",
          status: "success",
          // siteExternalId omitted
        },
      ],
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );

    expect(result?.pushed).toBe(1);
    const rows = await readManifestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monitoring_system_id).toBe("abcd-1234-uuid-shape");
  });

  it("emits ONE row when siteExternalId equals siteId (no duplicate to introduce)", async () => {
    const { pushMonitoringRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const result = await pushMonitoringRunsToConvertedReads(
      42,
      "tesla-powerhub",
      "Tesla",
      [
        {
          provider: "tesla-powerhub",
          siteId: "STE9876",
          siteName: "Acme Solar",
          lifetimeKwh: 1000,
          dateKey: "2026-05-08",
          status: "success",
          siteExternalId: "STE9876",
        },
      ],
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );

    expect(result?.pushed).toBe(1);
    const rows = await readManifestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monitoring_system_id).toBe("STE9876");
  });

  it("emits ONE row for non-Tesla providers even when siteExternalId is present", async () => {
    const { pushMonitoringRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const result = await pushMonitoringRunsToConvertedReads(
      42,
      "solaredge",
      "SolarEdge",
      [
        {
          provider: "solaredge",
          siteId: "site-A",
          siteName: "Acme Solar",
          lifetimeKwh: 1000,
          dateKey: "2026-05-08",
          status: "success",
          // Non-Tesla providers get single-row emission regardless of
          // whether they happen to surface an alternate identifier.
          siteExternalId: "ALT-ID-123",
        },
      ],
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );

    expect(result?.pushed).toBe(1);
    const rows = await readManifestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monitoring_system_id).toBe("site-A");
  });

  it("emits four rows for two Tesla sites (two each) and dedupes against priors on rerun", async () => {
    const { pushMonitoringRunsToConvertedReads } = await import(
      "./convertedReadsBridge"
    );

    const runs = [
      {
        provider: "tesla-powerhub",
        siteId: "uuid-A",
        siteName: "Site A",
        lifetimeKwh: 100,
        dateKey: "2026-05-08",
        status: "success",
        siteExternalId: "STE-A",
      },
      {
        provider: "tesla-powerhub",
        siteId: "uuid-B",
        siteName: "Site B",
        lifetimeKwh: 200,
        dateKey: "2026-05-08",
        status: "success",
        siteExternalId: "STE-B",
      },
    ];

    const first = await pushMonitoringRunsToConvertedReads(
      42,
      "tesla-powerhub",
      "Tesla",
      runs,
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );
    expect(first?.pushed).toBe(4);

    const rowsAfterFirst = await readManifestRows();
    expect(rowsAfterFirst).toHaveLength(4);

    // Re-run with the same inputs — every row dedupes; pushed should be 0.
    const second = await pushMonitoringRunsToConvertedReads(
      42,
      "tesla-powerhub",
      "Tesla",
      runs,
      { scheduleRowTableSync: false, scopeId: "scope-1" }
    );
    expect(second?.pushed).toBe(0);
    expect(second?.skipped).toBe(2);

    const rowsAfterSecond = await readManifestRows();
    expect(rowsAfterSecond).toHaveLength(4);
  });
});
