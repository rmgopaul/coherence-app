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
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
