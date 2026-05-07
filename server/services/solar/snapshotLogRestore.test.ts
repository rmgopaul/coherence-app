import { describe, it, expect, vi } from "vitest";
import {
  runSnapshotLogRestore,
  serializeSnapshotLogEntries,
  extractIdSetFromPayload,
  SNAPSHOT_LOG_RESTORE_RUNNER_VERSION,
  SNAPSHOT_LOG_RESTORE_KEYS,
  type SnapshotLogRestoreDeps,
} from "./snapshotLogRestore";

describe("SNAPSHOT_LOG_RESTORE_KEYS prefix (regression rail)", () => {
  // Cloud writes go through `saveDataset`, which prepends `dataset:`
  // to the caller key (see solarRecDashboardRouter.ts `saveDataset`
  // proc). The actual storage rows therefore live under
  // `dataset:snapshot_logs_v1` (and `dataset:snapshot_logs_v1_chunk_*`).
  // PR #353/#354/#356 shipped the recovery proc without the
  // `dataset:` prefix, making it a silent no-op. PR-A's guard and
  // PR-B's restore mutation both inherited the bug because they
  // built on top of the same prefix. This rail pins the corrected
  // values so a future "simplification" cannot reintroduce the
  // regression.
  it("includes the dataset: prefix on the main key", () => {
    expect(SNAPSHOT_LOG_RESTORE_KEYS.mainKey).toBe("dataset:snapshot_logs_v1");
  });

  it("includes the dataset: prefix on the chunk prefix", () => {
    expect(SNAPSHOT_LOG_RESTORE_KEYS.chunkPrefix).toBe(
      "dataset:snapshot_logs_v1_chunk_"
    );
  });
});

function entry(id: string, createdAt: string) {
  return { id, createdAt, payload: { foo: id } };
}

function buildDeps(overrides: Partial<SnapshotLogRestoreDeps>): {
  deps: SnapshotLogRestoreDeps;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const deps: SnapshotLogRestoreDeps = {
    readMainPayload: vi.fn(async () => {
      callOrder.push("readMainPayload");
      return null;
    }),
    readOrphanRows: vi.fn(async () => {
      callOrder.push("readOrphanRows");
      return [];
    }),
    writeMainPayload: vi.fn(async () => {
      callOrder.push("writeMainPayload");
      return true;
    }),
    deleteStorageKeys: vi.fn(async () => {
      callOrder.push("deleteStorageKeys");
      return 0;
    }),
    ...overrides,
  };
  return { deps, callOrder };
}

describe("runSnapshotLogRestore", () => {
  it("idempotent no-op when source === 'main' (already consolidated)", async () => {
    const main = JSON.stringify([entry("a", "2026-05-01T00:00:00Z")]);
    const { deps, callOrder } = buildDeps({
      readMainPayload: vi.fn(async () => main),
      readOrphanRows: vi.fn(async () => []),
    });
    const result = await runSnapshotLogRestore(deps);
    expect(result.alreadyConsolidated).toBe(true);
    expect(result.entriesRestored).toBe(1);
    expect(result.orphanRowsPruned).toBe(0);
    expect(result.chunksConsolidated).toBe(0);
    expect(callOrder).not.toContain("writeMainPayload");
    expect(callOrder).not.toContain("deleteStorageKeys");
  });

  it("idempotent no-op when source === 'none' (both sides empty)", async () => {
    const { deps, callOrder } = buildDeps({});
    const result = await runSnapshotLogRestore(deps);
    expect(result.alreadyConsolidated).toBe(true);
    expect(result.entriesRestored).toBe(0);
    expect(callOrder).not.toContain("writeMainPayload");
    expect(callOrder).not.toContain("deleteStorageKeys");
  });

  it("consolidates orphan chunks back into main when source === 'orphaned-chunks'", async () => {
    // 1-entry main + 2-chunk orphan that reassembles to 3 entries
    // → all 3 should land on main, both chunks pruned.
    const main = JSON.stringify([entry("a", "2026-05-01T00:00:00Z")]);
    const orphanA = JSON.stringify([
      entry("b", "2026-04-01T00:00:00Z"),
      entry("c", "2026-04-02T00:00:00Z"),
    ]);
    let writtenPayload: string | null = null;
    const { deps, callOrder } = buildDeps({
      readMainPayload: vi.fn(async () => {
        if (writtenPayload !== null) return writtenPayload;
        return main;
      }),
      readOrphanRows: vi.fn(async () => [
        { storageKey: "dataset:snapshot_logs_v1_chunk_0001", payload: orphanA },
      ]),
      writeMainPayload: vi.fn(async (payload: string) => {
        callOrder.push("writeMainPayload");
        writtenPayload = payload;
        return true;
      }),
      deleteStorageKeys: vi.fn(async (keys: string[]) => {
        callOrder.push("deleteStorageKeys");
        expect(keys).toEqual(["dataset:snapshot_logs_v1_chunk_0001"]);
        return keys.length;
      }),
    });
    const result = await runSnapshotLogRestore(deps);
    expect(result.alreadyConsolidated).toBe(false);
    expect(result.entriesRestored).toBe(3);
    expect(result.chunksConsolidated).toBe(1);
    expect(result.orphanRowsPruned).toBe(1);
    // Verify-then-delete order: write must come BEFORE delete.
    const writeIdx = callOrder.indexOf("writeMainPayload");
    const deleteIdx = callOrder.indexOf("deleteStorageKeys");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(writeIdx);
  });

  it("verify-then-delete: write comes before delete, with a read-back in between", async () => {
    const main = JSON.stringify([entry("a", "2026-05-01T00:00:00Z")]);
    const orphanA = JSON.stringify([entry("b", "2026-04-01T00:00:00Z")]);
    let writtenPayload: string | null = null;
    const callOrder: string[] = [];
    let readMainCallCount = 0;
    const deps: SnapshotLogRestoreDeps = {
      readMainPayload: vi.fn(async () => {
        readMainCallCount++;
        callOrder.push(`readMainPayload#${readMainCallCount}`);
        // First call → pre-restore (returns original main).
        // Second call → post-write verify (returns the freshly-
        // written payload).
        if (readMainCallCount === 1) return main;
        return writtenPayload;
      }),
      readOrphanRows: vi.fn(async () => {
        callOrder.push("readOrphanRows");
        return [{ storageKey: "dataset:snapshot_logs_v1_chunk_0001", payload: orphanA }];
      }),
      writeMainPayload: vi.fn(async (payload: string) => {
        callOrder.push("writeMainPayload");
        writtenPayload = payload;
        return true;
      }),
      deleteStorageKeys: vi.fn(async (keys: string[]) => {
        callOrder.push("deleteStorageKeys");
        return keys.length;
      }),
    };
    await runSnapshotLogRestore(deps);
    // Sequence: initial reads (main+orphan parallel), then write,
    // then verify read, then delete.
    const writeIdx = callOrder.indexOf("writeMainPayload");
    const verifyReadIdx = callOrder.indexOf(
      "readMainPayload#2",
      writeIdx + 1
    );
    const deleteIdx = callOrder.indexOf("deleteStorageKeys");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(verifyReadIdx).toBeGreaterThan(writeIdx);
    expect(deleteIdx).toBeGreaterThan(verifyReadIdx);
  });

  it("verify failed → abort BEFORE orphan delete (the safety property)", async () => {
    // Simulate a write that succeeds but the read-back returns
    // a payload missing one of the expected ids. The restore must
    // throw BEFORE calling deleteStorageKeys.
    const orphanA = JSON.stringify([
      entry("b", "2026-04-01T00:00:00Z"),
      entry("c", "2026-04-02T00:00:00Z"),
    ]);
    const callOrder: string[] = [];
    let readCount = 0;
    const deps: SnapshotLogRestoreDeps = {
      readMainPayload: vi.fn(async () => {
        readCount++;
        if (readCount === 1) return null;
        // Verify read-back: corrupt — only one of the two
        // expected ids made it.
        return JSON.stringify([entry("b", "2026-04-01T00:00:00Z")]);
      }),
      readOrphanRows: vi.fn(async () => [
        { storageKey: "dataset:snapshot_logs_v1_chunk_0001", payload: orphanA },
      ]),
      writeMainPayload: vi.fn(async () => {
        callOrder.push("writeMainPayload");
        return true;
      }),
      deleteStorageKeys: vi.fn(async () => {
        callOrder.push("deleteStorageKeys");
        return 0;
      }),
    };
    await expect(runSnapshotLogRestore(deps)).rejects.toThrow(/verify failed/);
    expect(callOrder).toContain("writeMainPayload");
    expect(callOrder).not.toContain("deleteStorageKeys");
  });

  it("write failure (returns false) aborts BEFORE orphan delete", async () => {
    const orphanA = JSON.stringify([entry("b", "2026-04-01T00:00:00Z")]);
    const callOrder: string[] = [];
    const deps: SnapshotLogRestoreDeps = {
      readMainPayload: vi.fn(async () => null),
      readOrphanRows: vi.fn(async () => [
        { storageKey: "dataset:snapshot_logs_v1_chunk_0001", payload: orphanA },
      ]),
      writeMainPayload: vi.fn(async () => {
        callOrder.push("writeMainPayload");
        return false;
      }),
      deleteStorageKeys: vi.fn(async () => {
        callOrder.push("deleteStorageKeys");
        return 0;
      }),
    };
    await expect(runSnapshotLogRestore(deps)).rejects.toThrow(
      /writeMainPayload returned false/
    );
    expect(callOrder).not.toContain("deleteStorageKeys");
  });

  it("only deletes storageKeys with the snapshot_logs_v1_chunk_ prefix (defense against accidentally deleting unrelated rows)", async () => {
    const orphanA = JSON.stringify([entry("b", "2026-04-01T00:00:00Z")]);
    let writtenPayload: string | null = null;
    let readCount = 0;
    const deletedKeys: string[][] = [];
    const deps: SnapshotLogRestoreDeps = {
      readMainPayload: vi.fn(async () => {
        readCount++;
        if (readCount === 1) return null;
        return writtenPayload;
      }),
      readOrphanRows: vi.fn(async () => [
        // Real orphan
        { storageKey: "dataset:snapshot_logs_v1_chunk_0001", payload: orphanA },
        // Defensive guard: a row that listSolarRecDashboardStorageByPrefix
        // returned but whose storageKey does NOT match the canonical
        // prefix shape (shouldn't happen in practice but the helper
        // must filter it).
        { storageKey: "totally_unrelated_key", payload: "irrelevant" },
      ]),
      writeMainPayload: vi.fn(async (p: string) => {
        writtenPayload = p;
        return true;
      }),
      deleteStorageKeys: vi.fn(async (keys: string[]) => {
        deletedKeys.push(keys);
        return keys.length;
      }),
    };
    await runSnapshotLogRestore(deps);
    expect(deletedKeys).toHaveLength(1);
    expect(deletedKeys[0]).toEqual(["dataset:snapshot_logs_v1_chunk_0001"]);
  });

  it("returns _runnerVersion on every outcome", async () => {
    const { deps } = buildDeps({});
    const result = await runSnapshotLogRestore(deps);
    expect(result._runnerVersion).toBe(SNAPSHOT_LOG_RESTORE_RUNNER_VERSION);
  });
});

describe("extractIdSetFromPayload", () => {
  it("returns empty set for null/empty/whitespace", () => {
    expect(extractIdSetFromPayload(null).size).toBe(0);
    expect(extractIdSetFromPayload("").size).toBe(0);
    expect(extractIdSetFromPayload("   ").size).toBe(0);
  });

  it("returns empty set for malformed JSON", () => {
    expect(extractIdSetFromPayload("{not json").size).toBe(0);
  });

  it("returns empty set for non-array root", () => {
    expect(extractIdSetFromPayload('{"id":"a"}').size).toBe(0);
  });

  it("collects ids from valid array entries; skips items without string id", () => {
    const payload = JSON.stringify([
      { id: "a", createdAt: "x" },
      { id: "b" },
      { noId: true },
      { id: 123 }, // numeric id rejected
      null,
      "string-not-object",
    ]);
    const ids = extractIdSetFromPayload(payload);
    expect(ids.size).toBe(2);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });
});

describe("serializeSnapshotLogEntries", () => {
  it("produces a JSON array round-trippable by extractIdSetFromPayload", () => {
    const entries = [entry("a", "2026-05-01"), entry("b", "2026-05-02")];
    const payload = serializeSnapshotLogEntries(entries);
    const ids = extractIdSetFromPayload(payload);
    expect(ids.size).toBe(2);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });

  it("returns '[]' for an empty list", () => {
    expect(serializeSnapshotLogEntries([])).toBe("[]");
  });
});
