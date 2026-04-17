/**
 * Feature flag for server-side storage (Phase 8.3b+).
 *
 * The flag controls whether the dashboard pulls SystemRecord[] from
 * the server snapshot (via useSystemSnapshot) or falls back to an
 * empty array. All migration logic has been removed — the one-way
 * transition from IndexedDB to server-side storage is complete, and
 * the on-flag path is the only supported runtime.
 *
 * The flag stays in localStorage so the useSystemSnapshot escape
 * hatch (and any future parity/debug tooling) can still read it
 * synchronously from non-React code.
 */

const FEATURE_FLAG_KEY = "solarRec:serverSideStorage";

/**
 * Check if server-side storage is enabled.
 * Synchronous — safe from non-React code (e.g. inside a useQuery
 * enabled predicate).
 */
export function isServerSideStorageEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(FEATURE_FLAG_KEY) === "true";
}
