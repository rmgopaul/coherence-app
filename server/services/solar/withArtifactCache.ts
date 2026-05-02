/**
 * Cache wrapper for the Task 5.13 server-side aggregators.
 *
 * On every call:
 *   1. Read `solarRecComputedArtifacts(scopeId, artifactType, hash)`.
 *      Cache hit → parse via the caller-supplied serde and return.
 *      Corrupt payloads fall through to recompute and self-heal on
 *      the next upsert.
 *   2. Cache miss → in-process single-flight: if another caller is
 *      already recomputing this key, share their Promise. Otherwise
 *      run `recompute`, write the cache (best-effort, warn on
 *      failure), and return.
 *
 * Single-flight scope is per-Node-process. Multi-instance deploys
 * still risk N parallel recomputes; cross-process dedup via
 * `solarRecComputeRuns` (mirroring `getOrBuildSystemSnapshot`) is the
 * next phase. Disable with
 * `WITH_ARTIFACT_CACHE_SINGLE_FLIGHT_ENABLED=0` if it ever misbehaves
 * in prod.
 *
 * Cache writes are an optimization, not persistence. Failed writes
 * log at `warn` (not `error`) and the next call recomputes — see
 * `saveDataset` etc. for the persistence-path contract.
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

// ---------------------------------------------------------------------------
// In-process single-flight registry
// ---------------------------------------------------------------------------

const inFlightRecomputes = new Map<string, Promise<unknown>>();

function singleFlightKey(
  scopeId: string,
  artifactType: string,
  inputVersionHash: string
): string {
  // JSON.stringify of a tuple is collision-free regardless of what
  // characters appear in the components.
  return JSON.stringify([scopeId, artifactType, inputVersionHash]);
}

function isSingleFlightEnabled(): boolean {
  const raw =
    process.env.WITH_ARTIFACT_CACHE_SINGLE_FLIGHT_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Test-only: clear the in-flight registry between cases. Module-level
 * state needs an explicit reset hook for test isolation; clearing it
 * in production would only cause a duplicate recompute on the next
 * call (no data corruption).
 */
export function __clearInFlightForTests(): void {
  inFlightRecomputes.clear();
}

// ---------------------------------------------------------------------------
// withArtifactCache
// ---------------------------------------------------------------------------

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

  // Cache reads are NOT single-flighted. On a warm cache, N concurrent
  // callers each pay one indexed DB SELECT against
  // `solarRecComputedArtifacts`. Acceptable since the cache hit path
  // is cheap; the stampede this guard exists to prevent is the cold-
  // miss recompute that materializes ~28k+ row arrays.
  const cached = await getComputedArtifact(
    scopeId,
    artifactType,
    inputVersionHash
  );
  if (cached) {
    try {
      return { result: serde.parse(cached.payload), fromCache: true };
    } catch {
      // Corrupt payload — fall through to recompute. The bad row will
      // be overwritten by the upsert below, healing on its own.
    }
  }

  if (!isSingleFlightEnabled()) {
    return runRecomputeAndCache(input);
  }

  // In-process single-flight: if another caller is already recomputing
  // this key, share their Promise rather than running a parallel
  // recompute. The Map.get / Map.set window is synchronous so a caller
  // arriving immediately after another's cache miss will see the
  // in-flight entry the previous caller just wrote.
  const key = singleFlightKey(scopeId, artifactType, inputVersionHash);
  const inFlight = inFlightRecomputes.get(key) as Promise<T> | undefined;
  if (inFlight) {
    return { result: await inFlight, fromCache: false };
  }

  const computation = (async (): Promise<T> => {
    try {
      const { result } = await runRecomputeAndCache(input);
      return result;
    } finally {
      // Always clear the in-flight entry, even on recompute failure —
      // failures are retryable: the next caller starts fresh.
      inFlightRecomputes.delete(key);
    }
  })();

  inFlightRecomputes.set(key, computation);

  return { result: await computation, fromCache: false };
}

async function runRecomputeAndCache<T>(
  input: WithArtifactCacheInput<T>
): Promise<{ result: T; fromCache: false }> {
  const result = await input.recompute();

  try {
    await upsertComputedArtifact({
      scopeId: input.scopeId,
      artifactType: input.artifactType,
      inputVersionHash: input.inputVersionHash,
      payload: input.serde.stringify(result),
      rowCount: input.rowCount(result),
    });
  } catch (error) {
    console.warn(
      `[withArtifactCache] cache write failed for ${input.artifactType}:`,
      error instanceof Error ? error.message : error
    );
  }

  return { result, fromCache: false };
}
