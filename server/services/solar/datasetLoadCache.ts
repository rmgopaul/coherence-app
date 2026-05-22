/**
 * Build-scoped dataset-load cache.
 *
 * A single dashboard build (`runDashboardBuildJob`) runs ~5 fact-build
 * steps in sequence, and several of them independently call
 * `loadDatasetRows(scopeId, batchId, srDs*)` for the SAME dataset — most
 * expensively `srDsAbpReport` (full batch, ~189K rows incl. `rawRow`).
 * On a cold rebuild every step re-scans the same batch, which the
 * slow-query log showed as the single largest Request-Unit consumer.
 *
 * This module provides an `AsyncLocalStorage`-backed memo so that, for
 * the duration of one build, identical `(scopeId, batchId, table)` loads
 * resolve to ONE shared promise instead of N independent scans.
 *
 * Safety properties:
 *   - **Scoped to one build.** The store is established per build via
 *     `beginDatasetLoadCache()` (or `runWithDatasetLoadCache()`), so it
 *     never lives longer than the build's async tree and is GC'd after.
 *     There is no global/cross-request cache, so no staleness window.
 *   - **No cross-scope bleed.** The cache key includes `scopeId`; and
 *     because a build runs for exactly one scope, the store only ever
 *     holds that scope's data anyway.
 *   - **Opt-in.** With no active store (e.g. a single tab-aggregate
 *     request), `memoizeDatasetLoad` is a passthrough — behavior is
 *     identical to today.
 *   - **Rejections are not cached.** A failed load is evicted so a
 *     sibling caller can retry rather than inheriting the failure.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type DatasetLoadCache = Map<string, Promise<unknown>>;

const datasetLoadCacheStore = new AsyncLocalStorage<DatasetLoadCache>();

/**
 * Establish a fresh build-scoped cache for the current async context
 * and everything it awaits. Uses `enterWith` (not `run`) so the caller
 * does NOT have to wrap its body in a closure — important where the
 * surrounding code relies on early `return`s (e.g. the build runner's
 * step loop).
 */
export function beginDatasetLoadCache(): void {
  datasetLoadCacheStore.enterWith(new Map());
}

/**
 * Callback form of {@link beginDatasetLoadCache} for call sites that
 * prefer an explicit scope boundary (e.g. a future per-request wrap).
 */
export function runWithDatasetLoadCache<T>(fn: () => Promise<T>): Promise<T> {
  return datasetLoadCacheStore.run(new Map(), fn);
}

/** True when a build-scoped cache is active on the current context. */
export function hasActiveDatasetLoadCache(): boolean {
  return datasetLoadCacheStore.getStore() !== undefined;
}

/**
 * Return the shared promise for `key` if one is already in flight /
 * resolved within the active build cache; otherwise run `loader`, store
 * its promise, and return it. With no active cache this is a plain
 * passthrough to `loader`.
 */
export function memoizeDatasetLoad<T>(
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const cache = datasetLoadCacheStore.getStore();
  if (!cache) return loader();

  const existing = cache.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = loader();
  cache.set(key, pending);
  // Don't let a failed load poison the rest of the build — evict so a
  // sibling can retry. The returned `pending` still rejects for this
  // caller; this `.catch` only handles eviction.
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}
