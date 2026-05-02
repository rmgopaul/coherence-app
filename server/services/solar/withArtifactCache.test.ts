import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB helpers so we can drive cache hit / miss / corrupt-row /
// write-failure paths deterministically without a real connection.

const mocks = vi.hoisted(() => ({
  getComputedArtifact: vi.fn(),
  upsertComputedArtifact: vi.fn(),
}));

vi.mock("../../db/solarRecDatasets", async () => {
  const actual =
    await vi.importActual<typeof import("../../db/solarRecDatasets")>(
      "../../db/solarRecDatasets"
    );
  return {
    ...actual,
    getComputedArtifact: mocks.getComputedArtifact,
    upsertComputedArtifact: mocks.upsertComputedArtifact,
  };
});

import {
  __clearInFlightForTests,
  __getInFlightKeysForTests,
  jsonSerde,
  superjsonSerde,
  withArtifactCache,
} from "./withArtifactCache";

const SCOPE_ID = "scope-test";
const ARTIFACT = "test-artifact";
const HASH = "deadbeef0001";

beforeEach(() => {
  mocks.getComputedArtifact.mockReset();
  mocks.upsertComputedArtifact.mockReset().mockResolvedValue(undefined);
  __clearInFlightForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInFlightForTests();
});

/** Build a recompute that resolves with `value` only when `release` is called. */
function deferredRecompute<T>(value: T) {
  let resolve!: () => void;
  const released = new Promise<void>((r) => {
    resolve = r;
  });
  const recompute = vi.fn(async () => {
    await released;
    return value;
  });
  return { recompute, release: resolve };
}

describe("withArtifactCache (json serde)", () => {
  it("cache hit: parses payload, returns fromCache=true, skips recompute", async () => {
    mocks.getComputedArtifact.mockResolvedValue({
      payload: JSON.stringify({ count: 7 }),
    });
    const recompute = vi.fn();

    const out = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 0,
      recompute,
    });

    expect(out).toEqual({ result: { count: 7 }, fromCache: true });
    expect(recompute).not.toHaveBeenCalled();
    expect(mocks.upsertComputedArtifact).not.toHaveBeenCalled();
  });

  it("cache miss: runs recompute, writes back, returns fromCache=false", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const recompute = vi.fn().mockResolvedValue({ count: 3 });

    const out = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: (v) => v.count,
      recompute,
    });

    expect(out).toEqual({ result: { count: 3 }, fromCache: false });
    expect(recompute).toHaveBeenCalledOnce();
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledWith({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      payload: JSON.stringify({ count: 3 }),
      rowCount: 3,
    });
  });

  it("corrupt cache row: parse throws → falls through to recompute", async () => {
    mocks.getComputedArtifact.mockResolvedValue({ payload: "{not-json" });
    const recompute = vi.fn().mockResolvedValue({ count: 1 });

    const out = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 1,
      recompute,
    });

    expect(out.fromCache).toBe(false);
    expect(out.result).toEqual({ count: 1 });
    expect(recompute).toHaveBeenCalledOnce();
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledOnce();
  });

  it("cache-write failure: swallowed and warned (best-effort)", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    mocks.upsertComputedArtifact.mockRejectedValue(new Error("DB hiccup"));
    const recompute = vi.fn().mockResolvedValue({ count: 1 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 1,
      recompute,
    });

    // Result still returned despite the cache-write failure.
    expect(out).toEqual({ result: { count: 1 }, fromCache: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`cache write failed for ${ARTIFACT}`),
      "DB hiccup"
    );
  });
});

describe("withArtifactCache (in-process single-flight)", () => {
  it("12 concurrent cold-cache callers run recompute exactly once", async () => {
    // This is the regression rail for docs/triage/dashboard-502-findings.md §2:
    // 12 concurrent getDashboardOverviewSummary opens previously ran 12
    // parallel recompute() calls, each materializing its own ~28k abp rows.
    mocks.getComputedArtifact.mockResolvedValue(null);
    const { recompute, release } = deferredRecompute({ count: 99 });

    const results = Promise.all(
      Array.from({ length: 12 }, () =>
        withArtifactCache<{ count: number }>({
          scopeId: SCOPE_ID,
          artifactType: ARTIFACT,
          inputVersionHash: HASH,
          serde: jsonSerde<{ count: number }>(),
          rowCount: () => 0,
          recompute,
        })
      )
    );

    // All 12 callers should be parked on the same in-flight Promise.
    // Yield once so cache reads + map.set() complete for every caller.
    await Promise.resolve();
    await Promise.resolve();
    expect(__getInFlightKeysForTests()).toHaveLength(1);

    release();
    const settled = await results;

    expect(recompute).toHaveBeenCalledOnce();
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(12);
    for (const r of settled) {
      expect(r.result).toEqual({ count: 99 });
      expect(r.fromCache).toBe(false);
    }
    expect(__getInFlightKeysForTests()).toHaveLength(0);
  });

  it("clears the in-flight entry after success so the next call recomputes when cache is empty", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const recompute = vi
      .fn<() => Promise<{ count: number }>>()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: (v) => v.count,
      recompute,
    });
    expect(__getInFlightKeysForTests()).toHaveLength(0);

    const second = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: (v) => v.count,
      recompute,
    });

    expect(recompute).toHaveBeenCalledTimes(2);
    expect(second.result).toEqual({ count: 2 });
    expect(__getInFlightKeysForTests()).toHaveLength(0);
  });

  it("clears the in-flight entry after recompute throws (failures are retryable)", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const recompute = vi
      .fn<() => Promise<{ count: number }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ count: 5 });

    await expect(
      withArtifactCache<{ count: number }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ count: number }>(),
        rowCount: (v) => v.count,
        recompute,
      })
    ).rejects.toThrow("boom");

    expect(__getInFlightKeysForTests()).toHaveLength(0);

    // Next call after the failure should retry, not be poisoned by the
    // prior in-flight entry.
    const second = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: (v) => v.count,
      recompute,
    });
    expect(second.result).toEqual({ count: 5 });
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("propagates the same error to every concurrent waiter when recompute throws", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    let reject!: (err: unknown) => void;
    const failed = new Promise<{ count: number }>((_, r) => {
      reject = r;
    });
    const recompute = vi.fn(() => failed);

    const calls = Array.from({ length: 4 }, () =>
      withArtifactCache<{ count: number }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ count: number }>(),
        rowCount: () => 0,
        recompute,
      })
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(__getInFlightKeysForTests()).toHaveLength(1);

    reject(new Error("recompute fail"));

    for (const call of calls) {
      await expect(call).rejects.toThrow("recompute fail");
    }
    expect(recompute).toHaveBeenCalledOnce();
    expect(__getInFlightKeysForTests()).toHaveLength(0);
  });

  it("does not dedup across distinct keys (scope, artifactType, or hash)", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const a = deferredRecompute({ tag: "A" });
    const b = deferredRecompute({ tag: "B" });
    const c = deferredRecompute({ tag: "C" });
    const d = deferredRecompute({ tag: "D" });

    const calls = Promise.all([
      withArtifactCache<{ tag: string }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: a.recompute,
      }),
      withArtifactCache<{ tag: string }>({
        scopeId: "other-scope",
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: b.recompute,
      }),
      withArtifactCache<{ tag: string }>({
        scopeId: SCOPE_ID,
        artifactType: "other-artifact",
        inputVersionHash: HASH,
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: c.recompute,
      }),
      withArtifactCache<{ tag: string }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: "feedface0002",
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: d.recompute,
      }),
    ]);

    await Promise.resolve();
    await Promise.resolve();
    expect(__getInFlightKeysForTests()).toHaveLength(4);

    a.release();
    b.release();
    c.release();
    d.release();

    const [r1, r2, r3, r4] = await calls;
    expect(r1.result).toEqual({ tag: "A" });
    expect(r2.result).toEqual({ tag: "B" });
    expect(r3.result).toEqual({ tag: "C" });
    expect(r4.result).toEqual({ tag: "D" });
    expect(a.recompute).toHaveBeenCalledOnce();
    expect(b.recompute).toHaveBeenCalledOnce();
    expect(c.recompute).toHaveBeenCalledOnce();
    expect(d.recompute).toHaveBeenCalledOnce();
  });

  it("a caller arriving after another's cache miss but before its compute settles joins the in-flight Promise", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const { recompute, release } = deferredRecompute({ count: 7 });

    const first = withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 0,
      recompute,
    });

    // Let the first caller's cache read resolve and reach Map.set().
    await Promise.resolve();
    await Promise.resolve();
    expect(__getInFlightKeysForTests()).toHaveLength(1);

    const second = withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 0,
      recompute, // would also resolve with { count: 7 } if invoked
    });

    release();
    const [a, b] = await Promise.all([first, second]);
    expect(recompute).toHaveBeenCalledOnce();
    expect(a.result).toEqual({ count: 7 });
    expect(b.result).toEqual({ count: 7 });
    expect(__getInFlightKeysForTests()).toHaveLength(0);
  });

  it("cache hit by-passes the single-flight registry entirely", async () => {
    // Once the first call has populated the cache, subsequent callers
    // hit the cache and never enter the single-flight code path.
    mocks.getComputedArtifact.mockResolvedValue({
      payload: JSON.stringify({ count: 11 }),
    });
    const recompute = vi.fn();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withArtifactCache<{ count: number }>({
          scopeId: SCOPE_ID,
          artifactType: ARTIFACT,
          inputVersionHash: HASH,
          serde: jsonSerde<{ count: number }>(),
          rowCount: () => 0,
          recompute,
        })
      )
    );

    expect(recompute).not.toHaveBeenCalled();
    for (const r of results) {
      expect(r).toEqual({ result: { count: 11 }, fromCache: true });
    }
    expect(__getInFlightKeysForTests()).toHaveLength(0);
  });
});

describe("withArtifactCache (superjson serde)", () => {
  it("preserves Date fields through cache round-trip", async () => {
    type Payload = { when: Date; n: number };
    const recompute = vi
      .fn<() => Promise<Payload>>()
      .mockResolvedValue({ when: new Date("2025-03-15"), n: 42 });
    mocks.getComputedArtifact.mockResolvedValue(null);

    // First call: cache miss → recompute + write.
    const first = await withArtifactCache<Payload>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: superjsonSerde<Payload>(),
      rowCount: () => 1,
      recompute,
    });
    expect(first.result.when).toBeInstanceOf(Date);

    // Second call: cache hit (we pass the payload that was written
    // back). The serde should round-trip the Date.
    const writtenPayload = mocks.upsertComputedArtifact.mock.calls[0][0]
      .payload as string;
    mocks.getComputedArtifact.mockResolvedValue({ payload: writtenPayload });

    const second = await withArtifactCache<Payload>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: superjsonSerde<Payload>(),
      rowCount: () => 1,
      recompute: vi.fn(),
    });

    expect(second.fromCache).toBe(true);
    expect(second.result.when).toBeInstanceOf(Date);
    expect(second.result.when.toISOString()).toBe(
      first.result.when.toISOString()
    );
    expect(second.result.n).toBe(42);
  });
});
