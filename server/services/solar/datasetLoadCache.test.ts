/**
 * Tests for the build-scoped dataset-load cache (2026-05-22).
 *
 * The memo logic is pure (loader injected), so isolation / dedup /
 * passthrough / rejection-eviction are pinned without any DB.
 */
import { describe, expect, it, vi } from "vitest";
import {
  beginDatasetLoadCache,
  runWithDatasetLoadCache,
  memoizeDatasetLoad,
  hasActiveDatasetLoadCache,
  isCacheableDatasetTable,
} from "./datasetLoadCache";

describe("datasetLoadCache", () => {
  it("is a passthrough with no active cache (single-request behavior)", async () => {
    const loader = vi.fn(async () => ["a"]);
    expect(hasActiveDatasetLoadCache()).toBe(false);
    await memoizeDatasetLoad("k", loader);
    await memoizeDatasetLoad("k", loader);
    expect(loader).toHaveBeenCalledTimes(2); // no dedup outside a cache
  });

  it("dedupes identical keys within one cache scope", async () => {
    const loader = vi.fn(async () => ["a"]);
    await runWithDatasetLoadCache(async () => {
      expect(hasActiveDatasetLoadCache()).toBe(true);
      const a = await memoizeDatasetLoad("k", loader);
      const b = await memoizeDatasetLoad("k", loader);
      expect(a).toBe(b);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys (e.g. different scope/batch/table) separate", async () => {
    const loader = vi.fn(async (v: string) => [v]);
    await runWithDatasetLoadCache(async () => {
      await memoizeDatasetLoad("scopeA|b1|abpReport", () => loader("A"));
      await memoizeDatasetLoad("scopeB|b1|abpReport", () => loader("B"));
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight loads of the same key", async () => {
    const loader = vi.fn(
      () => new Promise<string[]>((r) => setTimeout(() => r(["x"]), 5))
    );
    await runWithDatasetLoadCache(async () => {
      const [a, b] = await Promise.all([
        memoizeDatasetLoad("k", loader),
        memoizeDatasetLoad("k", loader),
      ]);
      expect(a).toBe(b);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected load (sibling can retry)", async () => {
    let attempt = 0;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return ["ok"];
    });
    await runWithDatasetLoadCache(async () => {
      await expect(memoizeDatasetLoad("k", loader)).rejects.toThrow("transient");
      const retry = await memoizeDatasetLoad("k", loader);
      expect(retry).toEqual(["ok"]);
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("isolates separate cache scopes from each other", async () => {
    const loader = vi.fn(async () => ["a"]);
    await runWithDatasetLoadCache(async () => {
      await memoizeDatasetLoad("k", loader);
    });
    await runWithDatasetLoadCache(async () => {
      await memoizeDatasetLoad("k", loader);
    });
    expect(loader).toHaveBeenCalledTimes(2); // each scope has its own map
  });

  it("beginDatasetLoadCache is a no-op when the flag is unset (dormant default)", async () => {
    const prev = process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED;
    delete process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED;
    try {
      const loader = vi.fn(async () => ["a"]);
      await (async () => {
        beginDatasetLoadCache();
        await memoizeDatasetLoad("k", loader);
        await memoizeDatasetLoad("k", loader);
      })();
      // No flag → no cache established → no dedup → loader runs each call.
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined)
        delete process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED;
      else process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED = prev;
    }
  });

  it("beginDatasetLoadCache activates the cache when the flag is 'true'", async () => {
    const prev = process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED;
    process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED = "true";
    try {
      const loader = vi.fn(async () => ["a"]);
      await (async () => {
        beginDatasetLoadCache();
        await memoizeDatasetLoad("k", loader);
        await memoizeDatasetLoad("k", loader);
      })();
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined)
        delete process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED;
      else process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED = prev;
    }
  });
});

describe("isCacheableDatasetTable — memory-safety allowlist", () => {
  it("allows the one medium high-repeat table (srDsAbpReport)", () => {
    expect(isCacheableDatasetTable("srDsAbpReport")).toBe(true);
  });

  it("NEVER allows the multi-million-row giants (2026-05-22 OOM guard)", () => {
    // Pinning any of these for a whole build is what spiked heap to
    // the 2 GB reject ceiling. They must stay GC-eligible per-builder.
    expect(isCacheableDatasetTable("srDsConvertedReads")).toBe(false);
    expect(isCacheableDatasetTable("srDsTransferHistory")).toBe(false);
    expect(isCacheableDatasetTable("srDsAccountSolarGeneration")).toBe(false);
  });

  it("rejects unknown / unlisted tables by default", () => {
    expect(isCacheableDatasetTable("srDsSolarApplications")).toBe(false);
    expect(isCacheableDatasetTable("srDsDeliverySchedule")).toBe(false);
    expect(isCacheableDatasetTable("")).toBe(false);
  });
});
