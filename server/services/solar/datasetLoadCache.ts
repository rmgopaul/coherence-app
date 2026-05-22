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
 * Tables the build-scoped cache is allowed to pin. Deliberately tiny.
 *
 * 2026-05-22 incident: the first cut cached EVERY `loadDatasetRows`
 * call for a build's duration. A build loads the multi-million-row
 * giants (`srDsConvertedReads` ~1M, `srDsTransferHistory` ~22M,
 * `srDsAccountSolarGeneration` ~18M) plus the system snapshot's 7
 * datasets — pinning them all spiked heap to the 2 GB reject ceiling
 * and the breaker shed dashboard reads.
 *
 * `srDsAbpReport` is the one worth pinning: ~189K rows, read by ~8
 * builders per build (the single largest repeat-read, ~29% of heavy
 * Request Units in the slow-query sample). One pinned copy of a
 * medium dataset is bounded; the giants must stay GC-eligible
 * per-builder. To add a table, confirm it's (a) read by multiple
 * builders in one build AND (b) small enough that one pinned copy is
 * safe, then re-validate heap with the flag on.
 */
const CACHEABLE_DATASET_TABLES = new Set<string>(["srDsAbpReport"]);

/**
 * Whether a dataset table is safe to memoize in the build cache. Only
 * allowlisted (small, high-repeat) tables qualify; the multi-million-
 * row giants never do. See {@link CACHEABLE_DATASET_TABLES}.
 */
export function isCacheableDatasetTable(tableName: string): boolean {
  return CACHEABLE_DATASET_TABLES.has(tableName);
}

/**
 * Whether the build-scoped dataset-load cache is enabled. Defaults
 * OFF so merging this code is a no-op in prod — the optimization is
 * opt-in and instantly reversible: set
 * `DASHBOARD_BUILD_DATASET_CACHE_ENABLED=true` to turn it on, set it
 * back to anything else (or unset) to turn it off, no redeploy needed
 * since the env is read at call time. Mirrors the Phase-H
 * `DASHBOARD_HEAP_PRESSURE_REJECT_BYTES` env-toggle pattern.
 *
 * Why dormant-by-default: the cache pins allowlisted datasets
 * (currently just `srDsAbpReport`) in memory for a build's duration,
 * and the heap impact can only be validated on prod-shape data.
 * Shipping it off lets that validation happen behind a flag instead of
 * as a deploy-time behavior change.
 */
export function isDatasetLoadCacheEnabled(): boolean {
  return process.env.DASHBOARD_BUILD_DATASET_CACHE_ENABLED === "true";
}

/**
 * Establish a fresh build-scoped cache for the current async context
 * and everything it awaits. **No-op unless
 * `DASHBOARD_BUILD_DATASET_CACHE_ENABLED=true`** (dormant by default).
 * Uses `enterWith` (not `run`) so the caller does NOT have to wrap its
 * body in a closure — important where the surrounding code relies on
 * early `return`s (e.g. the build runner's step loop).
 */
export function beginDatasetLoadCache(): void {
  if (!isDatasetLoadCacheEnabled()) return;
  datasetLoadCacheStore.enterWith(new Map());
}

/**
 * Callback-scoped form: runs `fn` with a fresh store via `run()`, which
 * — unlike `beginDatasetLoadCache`'s `enterWith` — fully bounds the
 * store to `fn` and does NOT persist into sibling async work. Use this
 * where precise scoping matters: notably unit tests, where `enterWith`
 * would leak the store into the next sequentially-run test (it sets the
 * store for the rest of the current async context, not just a callback).
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
