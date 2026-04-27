import { describe, it, expect } from "vitest";
import { isChildKeyRecoverable } from "./datasetCloudStatus";
import type { SolarRecDatasetSyncStateRecord } from "../../db";

/**
 * PR-2 contract test: a sync record's `dbPersisted=true` is required
 * for `isChildKeyRecoverable` to return true. Storage-only state
 * (`storageSynced=true` with `dbPersisted=false`) used to return true
 * — and that's the LOCAL-ONLY-NEVER-PERSISTS bug. After this PR,
 * storage-only state must surface as not-recoverable so the UI
 * renders "Cloud sync failed" instead of falsely claiming "Cloud
 * verified".
 *
 * The "no sync record" branch is covered by an integration smoke
 * elsewhere — testing it here would require DB mocking, which the
 * existing test stack avoids.
 */
describe("isChildKeyRecoverable (PR-2 badge contract)", () => {
  const baseRecord: SolarRecDatasetSyncStateRecord = {
    storageKey: "dataset:abpReport",
    payloadSha256: "deadbeef",
    payloadBytes: 1024,
    dbPersisted: true,
    storageSynced: true,
    updatedAt: new Date("2026-04-26T00:00:00Z"),
  };

  it("returns true when dbPersisted=true and payload has bytes", async () => {
    const result = await isChildKeyRecoverable(1, "abpReport", baseRecord);
    expect(result).toBe(true);
  });

  it("returns false when payloadBytes is 0 even with dbPersisted=true", async () => {
    const result = await isChildKeyRecoverable(1, "abpReport", {
      ...baseRecord,
      payloadBytes: 0,
    });
    expect(result).toBe(false);
  });

  it("returns false when dbPersisted=false even if storageSynced=true", async () => {
    // This is the regression-prevention case. Pre-PR-2 the function
    // returned true here because storage existence was treated as a
    // valid substitute for DB persistence. That meant a dataset whose
    // DB write silently failed showed as "Cloud verified" — and the
    // user could never get out of LOCAL-ONLY because retrying would
    // hit the same silent DB failure.
    const result = await isChildKeyRecoverable(1, "abpReport", {
      ...baseRecord,
      dbPersisted: false,
      storageSynced: true,
    });
    expect(result).toBe(false);
  });

  it("returns false when neither dbPersisted nor storageSynced", async () => {
    const result = await isChildKeyRecoverable(1, "abpReport", {
      ...baseRecord,
      dbPersisted: false,
      storageSynced: false,
    });
    expect(result).toBe(false);
  });
});
