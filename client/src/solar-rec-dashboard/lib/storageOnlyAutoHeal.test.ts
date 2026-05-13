/**
 * Regression rail for the 2026-05-12 "Saved in cloud / Not in tabs"
 * discrepancy. See `storageOnlyAutoHeal.ts` JSDoc for the full
 * failure mode.
 */

import { describe, it, expect } from "vitest";
import {
  isStorageOnlySummary,
  pickStorageOnlyDatasetKeys,
  type DatasetSummary,
} from "./storageOnlyAutoHeal";

const makeSummary = (overrides: Partial<DatasetSummary>): DatasetSummary => ({
  datasetKey: "test",
  cloudStatus: "synced",
  populationStatus: "populated",
  byteCount: 1000,
  ...overrides,
});

describe("isStorageOnlySummary", () => {
  it("returns true for the canonical storage-only shape", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "synced",
          populationStatus: "missing",
          byteCount: 4_762_423,
        })
      )
    ).toBe(true);
  });

  it("returns false when the dataset is populated (everything's fine)", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "synced",
          populationStatus: "populated",
          byteCount: 4_762_423,
        })
      )
    ).toBe(false);
  });

  it("returns false when the dataset is genuinely empty (active batch + 0 rows)", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "synced",
          populationStatus: "empty",
          byteCount: 100,
        })
      )
    ).toBe(false);
  });

  it("returns false when the cloud sync failed (separate repair path)", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "failed",
          populationStatus: "missing",
          byteCount: 1000,
        })
      )
    ).toBe(false);
  });

  it("returns false when there's no cloud blob at all", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "missing",
          populationStatus: "missing",
          byteCount: 0,
        })
      )
    ).toBe(false);
  });

  it("returns false when byteCount is 0 — guards against stale client responses", () => {
    // The server should mark a 0-byte sync row as cloudStatus="missing",
    // but this guard protects against a stale cached client response
    // from before the server fix landed.
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "synced",
          populationStatus: "missing",
          byteCount: 0,
        })
      )
    ).toBe(false);
  });

  it("returns false when byteCount is null (treated as 0)", () => {
    expect(
      isStorageOnlySummary(
        makeSummary({
          cloudStatus: "synced",
          populationStatus: "missing",
          byteCount: null,
        })
      )
    ).toBe(false);
  });
});

describe("pickStorageOnlyDatasetKeys", () => {
  it("filters to storage-only datasets and returns sorted keys", () => {
    const summaries: DatasetSummary[] = [
      makeSummary({
        datasetKey: "abpReport",
        cloudStatus: "synced",
        populationStatus: "populated",
      }),
      makeSummary({
        datasetKey: "abpQuickBooksRows",
        cloudStatus: "synced",
        populationStatus: "missing",
        byteCount: 4_762_423,
      }),
      makeSummary({
        datasetKey: "abpProjectApplicationRows",
        cloudStatus: "synced",
        populationStatus: "missing",
        byteCount: 1_207_777,
      }),
      makeSummary({
        datasetKey: "abpPortalInvoiceMapRows",
        cloudStatus: "missing",
        populationStatus: "missing",
        byteCount: 0,
      }),
    ];

    const result = pickStorageOnlyDatasetKeys(summaries);

    // alphabetical
    expect(result).toEqual([
      "abpProjectApplicationRows",
      "abpQuickBooksRows",
    ]);
  });

  it("returns an empty array when nothing is storage-only", () => {
    const summaries: DatasetSummary[] = [
      makeSummary({ cloudStatus: "synced", populationStatus: "populated" }),
      makeSummary({ cloudStatus: "missing", populationStatus: "missing", byteCount: 0 }),
    ];
    expect(pickStorageOnlyDatasetKeys(summaries)).toEqual([]);
  });

  it("returns stable output across calls (sorted)", () => {
    // The auto-fire effect uses the output as a dependency; a stable
    // order across renders is important so the effect doesn't churn
    // for orderless changes.
    const a = makeSummary({
      datasetKey: "z",
      cloudStatus: "synced",
      populationStatus: "missing",
      byteCount: 1,
    });
    const b = makeSummary({
      datasetKey: "a",
      cloudStatus: "synced",
      populationStatus: "missing",
      byteCount: 1,
    });
    expect(pickStorageOnlyDatasetKeys([a, b])).toEqual(["a", "z"]);
    expect(pickStorageOnlyDatasetKeys([b, a])).toEqual(["a", "z"]);
  });
});
