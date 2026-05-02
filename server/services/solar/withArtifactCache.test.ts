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
  jsonSerde,
  superjsonSerde,
  withArtifactCache,
} from "./withArtifactCache";

const SCOPE_ID = "scope-test";
const ARTIFACT = "test-artifact";
const HASH = "deadbeef0001";

const SINGLE_FLIGHT_ENV = "WITH_ARTIFACT_CACHE_SINGLE_FLIGHT_ENABLED";
let envSnapshot: string | undefined;

beforeEach(() => {
  mocks.getComputedArtifact.mockReset();
  mocks.upsertComputedArtifact.mockReset().mockResolvedValue(undefined);
  __clearInFlightForTests();
  envSnapshot = process.env[SINGLE_FLIGHT_ENV];
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInFlightForTests();
  if (envSnapshot === undefined) delete process.env[SINGLE_FLIGHT_ENV];
  else process.env[SINGLE_FLIGHT_ENV] = envSnapshot;
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

    expect(out).toEqual({ result: { count: 1 }, fromCache: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`cache write failed for ${ARTIFACT}`),
      "DB hiccup"
    );
  });
});

describe("withArtifactCache (in-process single-flight)", () => {
  it("12 concurrent cold-cache callers run recompute exactly once and all receive the same result", async () => {
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

    release();
    const settled = await results;

    expect(recompute).toHaveBeenCalledOnce();
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(12);
    for (const r of settled) {
      expect(r.result).toEqual({ count: 99 });
      expect(r.fromCache).toBe(false);
    }
  });

  it("retryable: a successful call after a previous failure recomputes with empty cache", async () => {
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

    reject(new Error("recompute fail"));

    for (const call of calls) {
      await expect(call).rejects.toThrow("recompute fail");
    }
    expect(recompute).toHaveBeenCalledOnce();
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

  it("treats the single-flight key as collision-free even with pipe characters in components", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    const a = deferredRecompute({ tag: "A" });
    const b = deferredRecompute({ tag: "B" });

    const calls = Promise.all([
      withArtifactCache<{ tag: string }>({
        scopeId: "a|b",
        artifactType: "c",
        inputVersionHash: HASH,
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: a.recompute,
      }),
      withArtifactCache<{ tag: string }>({
        scopeId: "a",
        artifactType: "b|c",
        inputVersionHash: HASH,
        serde: jsonSerde<{ tag: string }>(),
        rowCount: () => 0,
        recompute: b.recompute,
      }),
    ]);

    a.release();
    b.release();
    const [r1, r2] = await calls;

    expect(a.recompute).toHaveBeenCalledOnce();
    expect(b.recompute).toHaveBeenCalledOnce();
    expect(r1.result).toEqual({ tag: "A" });
    expect(r2.result).toEqual({ tag: "B" });
  });

  it("warns once on cache-write failure even with concurrent waiters", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    mocks.upsertComputedArtifact.mockRejectedValue(new Error("DB hiccup"));
    const recompute = vi.fn().mockResolvedValue({ count: 42 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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

    expect(recompute).toHaveBeenCalledOnce();
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.result).toEqual({ count: 42 });
      expect(r.fromCache).toBe(false);
    }
  });

  it("cache hit by-passes the single-flight registry entirely", async () => {
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
  });
});

// ---------------------------------------------------------------------------
// Synchronous-throw regression rail.
//
// Earlier implementations built the in-flight promise via
// `(async () => { try { await recompute(); } finally { delete } })()`
// and `set(key, computation)` AFTER the IIFE returned. If `recompute`
// threw synchronously (e.g. caller passed `() => { throw }`), the
// IIFE body — including the `finally` — ran during construction,
// BEFORE the outer `set`. The `delete` no-op'd; then `set` installed
// the rejected promise permanently. Subsequent callers would join
// the rejected promise and every retry failed.
//
// The fix wraps recompute in `Promise.resolve().then(...)` so the
// body runs on a microtask after `set`. This test pins that fix.
// ---------------------------------------------------------------------------

describe("withArtifactCache (synchronous recompute throw)", () => {
  it("clears the in-flight entry when recompute throws synchronously and the next call retries cleanly", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    let calls = 0;
    const recompute = vi.fn(((): Promise<{ count: number }> => {
      calls += 1;
      if (calls === 1) {
        // SYNCHRONOUS throw — not a rejected promise.
        throw new Error("sync boom");
      }
      // Subsequent calls succeed.
      return Promise.resolve({ count: 7 });
    }) as () => Promise<{ count: number }>);

    await expect(
      withArtifactCache<{ count: number }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ count: number }>(),
        rowCount: () => 0,
        recompute,
      })
    ).rejects.toThrow("sync boom");

    // The next call must NOT inherit the rejected promise from the
    // map. Without the fix, this call would reject with "sync boom"
    // because it would join the stranded entry.
    const second = await withArtifactCache<{ count: number }>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: jsonSerde<{ count: number }>(),
      rowCount: () => 0,
      recompute,
    });
    expect(second.result).toEqual({ count: 7 });
    expect(calls).toBe(2);
  });

  it("propagates a synchronous throw to every concurrent waiter exactly once", async () => {
    mocks.getComputedArtifact.mockResolvedValue(null);
    let calls = 0;
    const recompute = vi.fn(((): Promise<{ count: number }> => {
      calls += 1;
      throw new Error("sync boom");
    }) as () => Promise<{ count: number }>);

    const calls4 = Array.from({ length: 4 }, () =>
      withArtifactCache<{ count: number }>({
        scopeId: SCOPE_ID,
        artifactType: ARTIFACT,
        inputVersionHash: HASH,
        serde: jsonSerde<{ count: number }>(),
        rowCount: () => 0,
        recompute,
      })
    );

    for (const call of calls4) {
      await expect(call).rejects.toThrow("sync boom");
    }
    // All 4 should join the same in-flight promise — exactly one
    // sync-throw, propagated to every waiter.
    expect(calls).toBe(1);
  });
});

describe("withArtifactCache (single-flight kill switch)", () => {
  it("WITH_ARTIFACT_CACHE_SINGLE_FLIGHT_ENABLED=0 disables dedup; concurrent cold-cache callers each recompute", async () => {
    process.env[SINGLE_FLIGHT_ENV] = "0";
    mocks.getComputedArtifact.mockResolvedValue(null);
    const recompute = vi.fn().mockResolvedValue({ count: 1 });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withArtifactCache<{ count: number }>({
          scopeId: SCOPE_ID,
          artifactType: ARTIFACT,
          inputVersionHash: HASH,
          serde: jsonSerde<{ count: number }>(),
          rowCount: () => 1,
          recompute,
        })
      )
    );

    expect(recompute).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
  });

  it.each(["false", "off", "no", "FALSE", "Off"])(
    "treats '%s' as disabled",
    async (raw) => {
      process.env[SINGLE_FLIGHT_ENV] = raw;
      mocks.getComputedArtifact.mockResolvedValue(null);
      const recompute = vi.fn().mockResolvedValue({ count: 1 });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          withArtifactCache<{ count: number }>({
            scopeId: SCOPE_ID,
            artifactType: ARTIFACT,
            inputVersionHash: HASH,
            serde: jsonSerde<{ count: number }>(),
            rowCount: () => 1,
            recompute,
          })
        )
      );

      expect(recompute).toHaveBeenCalledTimes(3);
    }
  );

  it("any other value (including unset) leaves single-flight enabled", async () => {
    delete process.env[SINGLE_FLIGHT_ENV];
    mocks.getComputedArtifact.mockResolvedValue(null);
    const { recompute, release } = deferredRecompute({ count: 1 });

    const results = Promise.all(
      Array.from({ length: 3 }, () =>
        withArtifactCache<{ count: number }>({
          scopeId: SCOPE_ID,
          artifactType: ARTIFACT,
          inputVersionHash: HASH,
          serde: jsonSerde<{ count: number }>(),
          rowCount: () => 1,
          recompute,
        })
      )
    );

    release();
    await results;

    expect(recompute).toHaveBeenCalledOnce();
  });
});

describe("withArtifactCache (superjson serde)", () => {
  it("preserves Date fields through cache round-trip", async () => {
    type Payload = { when: Date; n: number };
    const recompute = vi
      .fn<() => Promise<Payload>>()
      .mockResolvedValue({ when: new Date("2025-03-15"), n: 42 });
    mocks.getComputedArtifact.mockResolvedValue(null);

    const first = await withArtifactCache<Payload>({
      scopeId: SCOPE_ID,
      artifactType: ARTIFACT,
      inputVersionHash: HASH,
      serde: superjsonSerde<Payload>(),
      rowCount: () => 1,
      recompute,
    });
    expect(first.result.when).toBeInstanceOf(Date);

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
