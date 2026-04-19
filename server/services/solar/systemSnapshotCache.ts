/**
 * Cache layer for computed SystemRecord[] snapshots.
 *
 * Persists the full SystemRecord[] array as a JSON blob keyed by the
 * input version hash, so that a getSystemSnapshot call can return
 * immediately when the hash matches a cached result — without
 * re-loading 1M+ rows out of srDs* tables and rerunning
 * buildSystems on every request.
 *
 * Storage: piggy-backs on the existing solarRecDashboardStorage
 * chunked-row table (same API used by dataset payloads) so we don't
 * need a new schema migration. Entries are namespaced under
 * `snapshot:system:${hash}` and keyed by the Solar REC owner user
 * (one tenant per scope for now).
 */

import {
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
} from "../../db";

const CACHE_KEY_PREFIX = "snapshot:system:";

function cacheKey(hash: string): string {
  return `${CACHE_KEY_PREFIX}${hash}`;
}

/**
 * Return a cached SystemRecord[] for the given hash, or null.
 * The caller is responsible for supplying the userId (typically
 * the Solar REC owner for the scope).
 */
export async function readCachedSnapshot(
  userId: number,
  hash: string
): Promise<unknown[] | null> {
  const payload = await getSolarRecDashboardPayload(userId, cacheKey(hash));
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a computed SystemRecord[] under the given hash.
 * Failures are swallowed (returns false) — the caller can still
 * return the in-memory result to the user; the cache is best-effort.
 */
export async function writeCachedSnapshot(
  userId: number,
  hash: string,
  systems: unknown[]
): Promise<boolean> {
  try {
    const payload = JSON.stringify(systems);
    return await writeSerializedCachedSnapshot(userId, hash, payload);
  } catch {
    return false;
  }
}

export async function writeSerializedCachedSnapshot(
  userId: number,
  hash: string,
  payload: string
): Promise<boolean> {
  try {
    return await saveSolarRecDashboardPayload(userId, cacheKey(hash), payload);
  } catch {
    return false;
  }
}
