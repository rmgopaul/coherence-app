import { describe, it, expect } from "vitest";
import {
  computeSnapshotLogChunkKeysToPrune,
  SNAPSHOT_LOG_PRUNE_RUNNER_VERSION,
} from "./snapshotLogPrune";

const PREFIX = "dataset:snapshot_logs_v1_chunk_";

describe("computeSnapshotLogChunkKeysToPrune", () => {
  it("returns the on-disk set minus the keep set", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [
        `${PREFIX}0000`,
        `${PREFIX}0001`,
        `${PREFIX}0002`,
        `${PREFIX}0003`,
      ],
      keepKeysFull: [`${PREFIX}0000`, `${PREFIX}0001`],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([`${PREFIX}0002`, `${PREFIX}0003`]);
  });

  it("single-chunk write (keepKeysFull=[]) marks every on-disk chunk for prune (the 2026-04 orphan recurrence path)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0000`, `${PREFIX}0001`, `${PREFIX}0002`],
      keepKeysFull: [],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([
      `${PREFIX}0000`,
      `${PREFIX}0001`,
      `${PREFIX}0002`,
    ]);
  });

  it("returns [] when nothing on disk", () => {
    expect(
      computeSnapshotLogChunkKeysToPrune({
        onDiskKeys: [],
        keepKeysFull: [`${PREFIX}0000`],
        requireOnDiskPrefix: PREFIX,
      })
    ).toEqual([]);
  });

  it("returns [] when keep set covers everything on disk (steady state)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0000`, `${PREFIX}0001`],
      keepKeysFull: [`${PREFIX}0000`, `${PREFIX}0001`],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([]);
  });

  it("ignores on-disk keys that don't match the prefix (defensive scope guard)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [
        `${PREFIX}0000`,
        "dataset:something_else",
        `${PREFIX}0001`,
        "totally_unrelated_key",
      ],
      keepKeysFull: [],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([`${PREFIX}0000`, `${PREFIX}0001`]);
  });

  it("dedupes repeated on-disk keys (defensive — listing helper should never duplicate but the math must not double-delete)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0000`, `${PREFIX}0000`, `${PREFIX}0001`],
      keepKeysFull: [],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([`${PREFIX}0000`, `${PREFIX}0001`]);
  });

  it("respects a keepKeyFull that doesn't currently exist on disk (no-op for that key)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0000`],
      keepKeysFull: [`${PREFIX}0000`, `${PREFIX}0001`],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([]);
  });

  it("returns [] when requireOnDiskPrefix is empty string (defensive — should never happen from the live caller)", () => {
    expect(
      computeSnapshotLogChunkKeysToPrune({
        onDiskKeys: [`${PREFIX}0000`],
        keepKeysFull: [],
        requireOnDiskPrefix: "",
      })
    ).toEqual([]);
  });

  it("preserves on-disk listing order (makes log lines reproducible)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0009`, `${PREFIX}0001`, `${PREFIX}0005`],
      keepKeysFull: [],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([
      `${PREFIX}0009`,
      `${PREFIX}0001`,
      `${PREFIX}0005`,
    ]);
  });

  it("a keepKey that doesn't match the require prefix is harmless (doesn't break math, just doesn't help)", () => {
    const result = computeSnapshotLogChunkKeysToPrune({
      onDiskKeys: [`${PREFIX}0000`],
      keepKeysFull: ["totally_unrelated_keep_key"],
      requireOnDiskPrefix: PREFIX,
    });
    expect(result).toEqual([`${PREFIX}0000`]);
  });
});

describe("SNAPSHOT_LOG_PRUNE_RUNNER_VERSION", () => {
  it("exports a stable version marker", () => {
    expect(SNAPSHOT_LOG_PRUNE_RUNNER_VERSION).toBe("snapshot-logs-prune-v1");
  });
});
