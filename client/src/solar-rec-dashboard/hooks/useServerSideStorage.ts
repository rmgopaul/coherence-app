/**
 * Feature flag for server-side storage (Phase 8.3b+).
 *
 * The flag controls whether the dashboard pulls SystemRecord[] from
 * the server snapshot (via useSystemSnapshot) or falls back to an
 * empty array. All migration logic has been removed — the one-way
 * transition from IndexedDB to server-side storage is complete, and
 * the on-flag path is the only supported runtime.
 *
 * Default: ON. The previous default (OFF, requiring an explicit
 * "true" string in localStorage) left freshly-provisioned sessions
 * with an empty `systems` snapshot — every Part II / Forecast /
 * Performance Eval / Ownership tab rendered empty because all of
 * them depend on `systems`. Since the off-path is dead code per the
 * Phase 8.3b+ note above, the only thing the previous default
 * achieved was a silent production outage.
 *
 * Opt-out remains: set localStorage["solarRec:serverSideStorage"]
 * to the literal string "false" to force the empty-snapshot path,
 * e.g. for parity diff tooling.
 */

const FEATURE_FLAG_KEY = "solarRec:serverSideStorage";

/**
 * Check if server-side storage is enabled.
 * Synchronous — safe from non-React code (e.g. inside a useQuery
 * enabled predicate).
 */
export function isServerSideStorageEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem(FEATURE_FLAG_KEY);
  // Explicit "false" → off. Everything else (null, "true", missing key,
  // unrecognized value) → on. This preserves the opt-out escape hatch
  // for parity/debug tooling while defaulting to the supported runtime.
  return raw !== "false";
}
