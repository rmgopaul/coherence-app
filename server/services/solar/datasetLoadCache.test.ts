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

  it("beginDatasetLoadCache activates the cache for the running context", async () => {
    const loader = vi.fn(async () => ["a"]);
    await (async () => {
      beginDatasetLoadCache();
      await memoizeDatasetLoad("k", loader);
      await memoizeDatasetLoad("k", loader);
    })();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
