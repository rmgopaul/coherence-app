/**
 * Unit tests for the snapshot-log recovery primitives.
 *
 * Pure functions only — no DB / no IO. The corresponding tRPC proc
 * (`solarRecDashboard.getSnapshotLogs`) wires these into the
 * dashboard storage layer; the proc-level test is the source rail
 * in `dashboardResponseGuard.test.ts` that pins it as a
 * `dashboardProcedure`.
 */

import { describe, expect, it } from "vitest";
import {
  composeSnapshotLogRecovery,
  dedupeById,
  paginateSnapshotLogRecovery,
  parseSnapshotLogPayload,
  reassembleOrphanChunks,
  sortNewestFirst,
  type SnapshotLogEntryLike,
} from "./snapshotLogRecovery";

function entry(
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {}
): SnapshotLogEntryLike {
  return { id, createdAt, ...extra };
}

describe("parseSnapshotLogPayload", () => {
  it("returns empty + no warnings for null/empty payloads", () => {
    expect(parseSnapshotLogPayload(null)).toEqual({ entries: [], warnings: [] });
    expect(parseSnapshotLogPayload("")).toEqual({ entries: [], warnings: [] });
    expect(parseSnapshotLogPayload("   ")).toEqual({
      entries: [],
      warnings: [],
    });
  });

  it("returns entries for a well-formed JSON array", () => {
    const result = parseSnapshotLogPayload(
      JSON.stringify([
        entry("a", "2026-04-01T00:00:00Z"),
        entry("b", "2026-04-02T00:00:00Z"),
      ])
    );
    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("warns and returns empty when the payload is invalid JSON", () => {
    const result = parseSnapshotLogPayload("{not json");
    expect(result.entries).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/JSON\.parse failed/);
  });

  it("warns and returns empty when the root is not an array", () => {
    const result = parseSnapshotLogPayload(JSON.stringify({ foo: 1 }));
    expect(result.entries).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/expected array/);
  });

  it("skips entries missing id or createdAt and warns about them", () => {
    const result = parseSnapshotLogPayload(
      JSON.stringify([
        entry("a", "2026-04-01T00:00:00Z"),
        { id: "b" }, // missing createdAt
        { createdAt: "2026-04-03T00:00:00Z" }, // missing id
        { id: 42, createdAt: "x" }, // wrong types
        entry("e", "2026-04-05T00:00:00Z"),
      ])
    );
    expect(result.entries.map((e) => e.id)).toEqual(["a", "e"]);
    expect(result.warnings[0]).toMatch(/3 entries skipped/);
  });

  it("preserves arbitrary extra fields per entry", () => {
    const result = parseSnapshotLogPayload(
      JSON.stringify([
        entry("a", "2026-04-01T00:00:00Z", { totalSystems: 100, custom: true }),
      ])
    );
    expect(result.entries[0]).toMatchObject({
      id: "a",
      createdAt: "2026-04-01T00:00:00Z",
      totalSystems: 100,
      custom: true,
    });
  });
});

describe("reassembleOrphanChunks", () => {
  it("returns null payload + no warnings when there are no rows", () => {
    expect(reassembleOrphanChunks([])).toEqual({
      payload: null,
      warnings: [],
      chunkCount: 0,
    });
  });

  it("concatenates valid _chunk_NNNN rows in numeric chunk-suffix order", () => {
    const result = reassembleOrphanChunks([
      { storageKey: "snapshot_logs_v1_chunk_0001", payload: "BBB" },
      { storageKey: "snapshot_logs_v1_chunk_0000", payload: "AAA" },
      { storageKey: "snapshot_logs_v1_chunk_0002", payload: "CCC" },
    ]);
    expect(result.payload).toBe("AAABBBCCC");
    expect(result.chunkCount).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it("drops rows whose storageKey doesn't match _chunk_NNNN and warns", () => {
    const result = reassembleOrphanChunks([
      { storageKey: "snapshot_logs_v1_chunk_0000", payload: "OK" },
      { storageKey: "snapshot_logs_v1_NOT_a_chunk", payload: "DROPPED" },
      { storageKey: "snapshot_logs_v1_chunk_xx", payload: "DROPPED-2" },
    ]);
    expect(result.payload).toBe("OK");
    expect(result.chunkCount).toBe(1);
    expect(result.warnings[0]).toMatch(/2 chunk rows dropped/);
  });

  it("treats a null payload as empty string (continues, doesn't crash)", () => {
    const result = reassembleOrphanChunks([
      { storageKey: "k_chunk_0000", payload: null },
      { storageKey: "k_chunk_0001", payload: "tail" },
    ]);
    expect(result.payload).toBe("tail");
    expect(result.chunkCount).toBe(2);
  });

  it("handles 5-digit chunk suffixes for forward compatibility", () => {
    const result = reassembleOrphanChunks([
      { storageKey: "k_chunk_00012", payload: "B" },
      { storageKey: "k_chunk_00010", payload: "A" },
      { storageKey: "k_chunk_00011", payload: "AA" },
    ]);
    expect(result.payload).toBe("A" + "AA" + "B");
  });
});

describe("dedupeById", () => {
  it("keeps a single entry per id, preferring the latest createdAt", () => {
    const result = dedupeById([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-02T00:00:00Z"),
      entry("a", "2026-04-05T00:00:00Z"),
      entry("b", "2026-04-01T00:00:00Z"),
    ]);
    const aEntry = result.unique.find((e) => e.id === "a");
    const bEntry = result.unique.find((e) => e.id === "b");
    expect(aEntry?.createdAt).toBe("2026-04-05T00:00:00Z");
    expect(bEntry?.createdAt).toBe("2026-04-02T00:00:00Z");
    expect(result.duplicates).toBe(2);
  });
});

describe("sortNewestFirst", () => {
  it("sorts by createdAt descending (ISO-8601 lexicographic)", () => {
    const sorted = sortNewestFirst([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-05T00:00:00Z"),
      entry("c", "2026-04-03T00:00:00Z"),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });
});

describe("composeSnapshotLogRecovery", () => {
  it("returns source=none with empty payload + empty orphans", () => {
    const result = composeSnapshotLogRecovery({
      mainPayload: null,
      orphanRows: [],
    });
    expect(result.source).toBe("none");
    expect(result.entries).toEqual([]);
    expect(result.uniqueEntries).toBe(0);
  });

  it("returns source=main when main has entries and orphans add nothing", () => {
    const main = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-02T00:00:00Z"),
    ]);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [],
    });
    expect(result.source).toBe("main");
    expect(result.uniqueEntries).toBe(2);
    expect(result.mainPayloadEntries).toBe(2);
    expect(result.orphanedChunkEntries).toBeNull();
  });

  it("returns source=orphaned-chunks when only orphans have entries", () => {
    const orphan = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-02T00:00:00Z"),
    ]);
    const result = composeSnapshotLogRecovery({
      mainPayload: null,
      orphanRows: [{ storageKey: "k_chunk_0000", payload: orphan }],
    });
    expect(result.source).toBe("orphaned-chunks");
    expect(result.uniqueEntries).toBe(2);
    expect(result.mainPayloadEntries).toBeNull();
    expect(result.orphanedChunkEntries).toBe(2);
  });

  it("PRODUCTION SCENARIO: 1-entry main + multi-entry orphans → main-plus-orphaned-chunks (orphans win the union)", () => {
    // This is the exact shape Codex flagged on prod 2026-05-04: the
    // main key has a single recent snapshot (the most recent local
    // save by the active dashboard), and orphan chunks contain the
    // historical 21-entry log from a prior chunked write.
    const main = JSON.stringify([
      entry("most-recent", "2026-04-19T22:24:24.892Z"),
    ]);
    const orphanSnapshots = Array.from({ length: 21 }, (_, i) =>
      entry(`historical-${i}`, `2026-03-${String(12 + i).padStart(2, "0")}T00:00:00Z`)
    );
    const orphanPayload = JSON.stringify(orphanSnapshots);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [
        { storageKey: "snapshot_logs_v1_chunk_0000", payload: orphanPayload },
      ],
    });
    expect(result.source).toBe("main-plus-orphaned-chunks");
    expect(result.uniqueEntries).toBe(22); // 1 main + 21 historical
    expect(result.entries[0].id).toBe("most-recent"); // newest-first
    expect(result.mainPayloadEntries).toBe(1);
    expect(result.orphanedChunkEntries).toBe(21);
  });

  it("does NOT prefer orphans when their entry count <= main's (guards against legitimate clears)", () => {
    // If a future write legitimately cleared the snapshot history
    // down to a single entry, the orphans must NOT silently
    // un-clear that. The "more entries" threshold is strictly
    // greater than.
    const main = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-02T00:00:00Z"),
    ]);
    const orphan = JSON.stringify([entry("c", "2026-04-03T00:00:00Z")]);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [{ storageKey: "k_chunk_0000", payload: orphan }],
    });
    expect(result.source).toBe("main");
    expect(result.uniqueEntries).toBe(2);
    expect(result.entries.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("dedupes overlap between main and orphans by id", () => {
    const main = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"),
    ]);
    const orphan = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"), // duplicate of main
      entry("b", "2026-04-02T00:00:00Z"),
      entry("c", "2026-04-03T00:00:00Z"),
    ]);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [{ storageKey: "k_chunk_0000", payload: orphan }],
    });
    expect(result.source).toBe("main-plus-orphaned-chunks");
    expect(result.uniqueEntries).toBe(3);
    expect(result.duplicateEntries).toBe(1);
  });

  it("collects warnings without crashing when orphan payloads are corrupt", () => {
    const main = JSON.stringify([entry("a", "2026-04-01T00:00:00Z")]);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [
        { storageKey: "k_chunk_0000", payload: "{not json" },
      ],
    });
    expect(result.source).toBe("main");
    expect(result.uniqueEntries).toBe(1);
    expect(result.warnings.some((w) => /JSON\.parse failed/.test(w))).toBe(true);
  });

  it("populates newest/oldestCreatedAt from the sorted result", () => {
    const main = JSON.stringify([
      entry("a", "2026-04-01T00:00:00Z"),
      entry("b", "2026-04-05T00:00:00Z"),
      entry("c", "2026-04-03T00:00:00Z"),
    ]);
    const result = composeSnapshotLogRecovery({
      mainPayload: main,
      orphanRows: [],
    });
    expect(result.newestCreatedAt).toBe("2026-04-05T00:00:00Z");
    expect(result.oldestCreatedAt).toBe("2026-04-01T00:00:00Z");
  });
});

describe("paginateSnapshotLogRecovery", () => {
  function buildResult(count: number) {
    const entries: SnapshotLogEntryLike[] = Array.from({ length: count }, (_, i) =>
      entry(`id-${i}`, `2026-04-${String(28 - i).padStart(2, "0")}T00:00:00Z`)
    );
    return composeSnapshotLogRecovery({
      mainPayload: JSON.stringify(entries),
      orphanRows: [],
    });
  }

  it("returns the whole list when count <= limit and no cursor", () => {
    const r = buildResult(5);
    const page = paginateSnapshotLogRecovery(r, { limit: 50 });
    expect(page.entries).toHaveLength(5);
    expect(page.nextCursorCreatedAt).toBeNull();
  });

  it("caps at the limit and surfaces a cursor for the next page", () => {
    const r = buildResult(7);
    const page = paginateSnapshotLogRecovery(r, { limit: 3 });
    expect(page.entries).toHaveLength(3);
    expect(page.nextCursorCreatedAt).toBe(page.entries[2].createdAt);
  });

  it("returns entries strictly older than the cursor", () => {
    const r = buildResult(7);
    const firstPage = paginateSnapshotLogRecovery(r, { limit: 3 });
    const secondPage = paginateSnapshotLogRecovery(r, {
      limit: 3,
      cursorCreatedAt: firstPage.nextCursorCreatedAt!,
    });
    expect(secondPage.entries).toHaveLength(3);
    // No overlap with first page.
    const firstIds = new Set(firstPage.entries.map((e) => e.id));
    for (const e of secondPage.entries) {
      expect(firstIds.has(e.id)).toBe(false);
    }
  });
});
