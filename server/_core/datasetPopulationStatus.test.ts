import { describe, expect, it } from "vitest";
import {
  derivePopulationStatus,
  type DerivePopulationStatusInput,
} from "./datasetPopulationStatus";

const input = (
  overrides: Partial<DerivePopulationStatusInput>
): DerivePopulationStatusInput => ({
  cloudStatus: "synced",
  hasActiveBatch: false,
  activeBatchRowCount: null,
  latestBatchFailed: false,
  ...overrides,
});

describe("derivePopulationStatus", () => {
  it("returns 'failed' when cloudStatus is 'failed' (terminal cloud-side state)", () => {
    expect(
      derivePopulationStatus(input({ cloudStatus: "failed" }))
    ).toBe("failed");
    // The active-batch / latestBatchFailed shape is irrelevant when
    // cloudStatus already terminally failed.
    expect(
      derivePopulationStatus(
        input({
          cloudStatus: "failed",
          hasActiveBatch: true,
          activeBatchRowCount: 1000,
        })
      )
    ).toBe("failed");
  });

  it("returns 'populated' when an active batch has rows", () => {
    expect(
      derivePopulationStatus(
        input({ hasActiveBatch: true, activeBatchRowCount: 1 })
      )
    ).toBe("populated");
    expect(
      derivePopulationStatus(
        input({ hasActiveBatch: true, activeBatchRowCount: 1_000_000 })
      )
    ).toBe("populated");
  });

  it("returns 'empty' when an active batch has 0 / null rows", () => {
    expect(
      derivePopulationStatus(
        input({ hasActiveBatch: true, activeBatchRowCount: 0 })
      )
    ).toBe("empty");
    expect(
      derivePopulationStatus(
        input({ hasActiveBatch: true, activeBatchRowCount: null })
      )
    ).toBe("empty");
  });

  it("returns 'failed' when storage-only AND latest batch failed (durable auto-heal stop)", () => {
    // The 2026-05-19 trap: blob present (cloudStatus "synced"),
    // every ingest fails header validation → no active version →
    // populationStatus must report "failed" so isStorageOnlySummary
    // returns false and the storage-only auto-heal stops retrying
    // across page reloads.
    expect(
      derivePopulationStatus(
        input({
          cloudStatus: "synced",
          hasActiveBatch: false,
          latestBatchFailed: true,
        })
      )
    ).toBe("failed");
  });

  it("returns 'missing' post-clear: cloudStatus 'missing' + stale failed batch history (REGRESSION B1)", () => {
    // After clearDatasetCloudStorage runs, the storage blob and
    // sync-state are gone (cloudStatus "missing") but failed
    // solarRecImportBatches rows are intentionally retained as
    // audit. Without the cloudStatus gate the dataset card would
    // stay stuck at "failed" forever after the user clears — which
    // contradicts the workflow this PR exists to enable.
    expect(
      derivePopulationStatus(
        input({
          cloudStatus: "missing",
          hasActiveBatch: false,
          latestBatchFailed: true,
        })
      )
    ).toBe("missing");
  });

  it("returns 'missing' when no blob and no failed batch (never ingested)", () => {
    expect(
      derivePopulationStatus(
        input({
          cloudStatus: "missing",
          hasActiveBatch: false,
          latestBatchFailed: false,
        })
      )
    ).toBe("missing");
  });

  it("returns 'missing' when blob present but latest batch did NOT fail (still in progress / not yet ingested)", () => {
    // E.g. a freshly uploaded blob that hasn't been ingested yet,
    // or whose latest batch is `done` but somehow no active version
    // — pathological but not "failed".
    expect(
      derivePopulationStatus(
        input({
          cloudStatus: "synced",
          hasActiveBatch: false,
          latestBatchFailed: false,
        })
      )
    ).toBe("missing");
  });
});
