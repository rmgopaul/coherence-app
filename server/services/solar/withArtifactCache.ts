/**
 * Generic cache wrapper for the Task 5.13 server-side aggregators.
 *
 * Each aggregator's "cache hit → parse → return; else compute → write
 * back" state machine used to be copy-pasted three times (PR-1, PR-2,
 * PR-3). Three things were inconsistent across copies:
 *
 *   1. **Error handling on cache write** — PR-1 + PR-2 propagated
 *      `upsertComputedArtifact` errors; PR-3 swallowed them with a
 *      `console.warn`. Best-effort is correct (cache write failure is
 *      a perf hit, not a data-loss bug; matches `buildSystemSnapshot`'s
 *      existing pattern). This wrapper makes that uniform.
 *   2. **Serde** — PR-1/PR-3 use `superjson` to round-trip Date fields
 *      through the cache; PR-2 uses plain `JSON` because its result
 *      has no Date fields. Caller picks via the `serde` option.
 *   3. **Lazy vs top-level superjson import** — PR-3 lazy-loaded
 *      superjson inside the function for no good reason. Now the
 *      shared `superjsonSerde` constant captures the import once at
 *      the top of the wrapper file.
 *
 * Note: this wrapper is for *cache*, not data persistence. The
 * CLAUDE.md hard rule "no silent error swallowing in persistence
 * paths" governs `saveDataset` etc., where a failed write is a
 * data-loss surface. Cache writes are an optimization; failure
 * means the next call recomputes. Logging at `warn` (not `error`)
 * is intentional.
 */

import superjson from "superjson";
import {
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";

export type ArtifactSerde<T> = {
  parse: (payload: string) => T;
  stringify: (value: T) => string;
};

/** Plain JSON serde — for results without `Date` / `Map` / `Set` / `undefined`. */
export const jsonSerde = <T>(): ArtifactSerde<T> => ({
  parse: (payload: string) => JSON.parse(payload) as T,
  stringify: (value: T) => JSON.stringify(value),
});

/**
 * superjson serde — preserves `Date`, `Map`, `Set`, `undefined`,
 * `bigint`, regexp through the cache layer (matches tRPC's superjson
 * transformer downstream so values look the same on either side of
 * the wire).
 */
export const superjsonSerde = <T>(): ArtifactSerde<T> => ({
  parse: (payload: string) => superjson.parse<T>(payload),
  stringify: (value: T) => superjson.stringify(value),
});

export type WithArtifactCacheInput<T> = {
  scopeId: string;
  /** `solarRecComputedArtifacts.artifactType` — namespace per aggregator. */
  artifactType: string;
  /** Hex hash bundling every input version; cache invalidation key. */
  inputVersionHash: string;
  serde: ArtifactSerde<T>;
  /** Compute the result fresh on cache miss. */
  recompute: () => Promise<T>;
  /** How to populate `solarRecComputedArtifacts.rowCount` for a given result. */
  rowCount: (result: T) => number;
};

/**
 * Cache-or-compute helper.
 *
 *   1. Look up `solarRecComputedArtifacts(scopeId, artifactType, hash)`.
 *   2. On hit, parse via the serde and return — cache miss falls
 *      through if the parse throws (corrupt payload).
 *   3. On miss, run `recompute`, write the result back to the cache
 *      (best-effort), and return.
 *
 * Returns the result plus a `fromCache` flag so callers can surface
 * the hit/miss state to clients (we already do via tRPC responses).
 */
export async function withArtifactCache<T>(
  input: WithArtifactCacheInput<T>
): Promise<{ result: T; fromCache: boolean }> {
  const {
    scopeId,
    artifactType,
    inputVersionHash,
    serde,
    recompute,
    rowCount,
  } = input;

  const cached = await getComputedArtifact(
    scopeId,
    artifactType,
    inputVersionHash
  );
  if (cached) {
    try {
      const parsed = serde.parse(cached.payload);
      return { result: parsed, fromCache: true };
    } catch {
      // Corrupt payload — fall through to recompute. The bad row will
      // be overwritten by the upsert below, healing on its own.
    }
  }

  const result = await recompute();

  // Best-effort cache write. Cache failure ≠ data-loss; logging at
  // `warn` (not `error`) so it doesn't trigger error-tracking alerts
  // for transient DB hiccups.
  try {
    await upsertComputedArtifact({
      scopeId,
      artifactType,
      inputVersionHash,
      payload: serde.stringify(result),
      rowCount: rowCount(result),
    });
  } catch (error) {
    console.warn(
      `[withArtifactCache] cache write failed for ${artifactType}:`,
      error instanceof Error ? error.message : error
    );
  }

  return { result, fromCache: false };
}
