/**
 * Regression rail for the 2026-05-12 "Data Quality always Stale"
 * bug. See the JSDoc on `pickNewestTimestamp` for the full failure
 * mode.
 */

import { describe, it, expect } from "vitest";
import { pickNewestTimestamp } from "./datasetSummaryTimestamp";

describe("pickNewestTimestamp", () => {
  it("returns null when every candidate is null/undefined", () => {
    expect(pickNewestTimestamp([null, undefined, null])).toBeNull();
    expect(pickNewestTimestamp([])).toBeNull();
  });

  it("returns the ISO string of a single valid timestamp", () => {
    const d = new Date("2026-05-12T18:24:02.000Z");
    expect(pickNewestTimestamp([d])).toBe("2026-05-12T18:24:02.000Z");
    expect(pickNewestTimestamp([null, d, undefined])).toBe(
      "2026-05-12T18:24:02.000Z"
    );
  });

  it("picks the NEWEST when multiple candidates are valid", () => {
    const v1Sync = new Date("2026-04-28T23:16:47.000Z");
    const v2Created = new Date("2026-05-12T18:20:00.000Z");
    const v2Completed = new Date("2026-05-12T18:24:02.000Z");

    expect(pickNewestTimestamp([v1Sync, v2Created, v2Completed])).toBe(
      "2026-05-12T18:24:02.000Z"
    );
    // Order-independent
    expect(pickNewestTimestamp([v2Completed, v1Sync, v2Created])).toBe(
      "2026-05-12T18:24:02.000Z"
    );
  });

  it("reproduces the prod 2026-05-12 case: v2 upload wins over v1 sync row", () => {
    // The exact scenario observed on prod for `accountSolarGeneration`:
    // syncRow.updatedAt (legacy) is 2 weeks older than the v2 batch's
    // uploadCompletedAt. The old cascade returned the older value;
    // the fix returns the newer one.
    const syncRowUpdatedAt = new Date("2026-04-28T23:16:47.000Z");
    const activeBatchUploadCompletedAt = new Date("2026-05-12T18:24:02.000Z");
    const activeBatchCompletedAt = new Date("2026-05-12T18:24:02.000Z");
    const activeBatchCreatedAt = new Date("2026-05-12T18:20:00.000Z");

    const result = pickNewestTimestamp([
      syncRowUpdatedAt,
      activeBatchUploadCompletedAt,
      activeBatchCompletedAt,
      activeBatchCreatedAt,
    ]);

    expect(result).toBe("2026-05-12T18:24:02.000Z");
  });

  it("treats invalid Dates (NaN-valued) as null", () => {
    const invalid = new Date("not a date");
    expect(Number.isNaN(invalid.getTime())).toBe(true);

    expect(pickNewestTimestamp([invalid])).toBeNull();
    expect(pickNewestTimestamp([invalid, null, undefined])).toBeNull();
    // Mix with a valid one — the invalid one is skipped, the valid one wins
    const valid = new Date("2026-05-12T00:00:00.000Z");
    expect(pickNewestTimestamp([invalid, valid])).toBe(
      "2026-05-12T00:00:00.000Z"
    );
  });

  it("preserves sub-second precision in the returned ISO string", () => {
    const precise = new Date("2026-05-12T18:24:02.123Z");
    expect(pickNewestTimestamp([precise])).toBe("2026-05-12T18:24:02.123Z");
  });

  it("handles two timestamps that tie — returns the same ISO string either order", () => {
    const a = new Date("2026-05-12T18:24:02.000Z");
    const b = new Date("2026-05-12T18:24:02.000Z");
    expect(pickNewestTimestamp([a, b])).toBe("2026-05-12T18:24:02.000Z");
    expect(pickNewestTimestamp([b, a])).toBe("2026-05-12T18:24:02.000Z");
  });
});
