import { describe, it, expect } from "vitest";
import { shouldSkipSnapshotLogSyncForUnsafeShrink } from "./snapshotLogSyncGuard";

describe("shouldSkipSnapshotLogSyncForUnsafeShrink", () => {
  it("skips when local has strictly fewer entries than cloud (the 2026-05 incident shape: 1 local vs 21 cloud)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 1,
        serverUniqueIdCount: 21,
      })
    ).toBe(true);
  });

  it("allows when local matches cloud exactly (idempotent re-sync)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 21,
        serverUniqueIdCount: 21,
      })
    ).toBe(false);
  });

  it("allows when local has more entries than cloud (legitimate growth)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 22,
        serverUniqueIdCount: 21,
      })
    ).toBe(false);
  });

  it("allows when both sides are empty (clean state)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 0,
        serverUniqueIdCount: 0,
      })
    ).toBe(false);
  });

  it("skips a 0-local against a populated cloud (refuses to clear cloud history)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 0,
        serverUniqueIdCount: 5,
      })
    ).toBe(true);
  });

  it("allows when server count is unknown (null) — guard does not block on missing data", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 1,
        serverUniqueIdCount: null,
      })
    ).toBe(false);
  });

  it("allows on non-finite local count (defensive — caller should never pass NaN)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: Number.NaN,
        serverUniqueIdCount: 21,
      })
    ).toBe(false);
  });

  it("allows on non-finite server count (defensive)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 21,
        serverUniqueIdCount: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
  });

  it("allows on negative counts (defensive — should never happen but cannot block sync)", () => {
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: -1,
        serverUniqueIdCount: 21,
      })
    ).toBe(false);
    expect(
      shouldSkipSnapshotLogSyncForUnsafeShrink({
        localCount: 1,
        serverUniqueIdCount: -1,
      })
    ).toBe(false);
  });
});
