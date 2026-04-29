/**
 * Per-dataset hydration error mapping + user-facing message
 * translation.
 *
 * Error sources include DOMException (IDB), SyntaxError
 * (JSON.parse on corrupt payloads), AbortError (fetch timeout),
 * QuotaExceededError (IDB full). `error.message` from any of these
 * is accurate but not actionable to a user. We translate to a short,
 * user-facing string; the original error still goes to the debug
 * console under window.__solarRecDebug.
 */

import type { DatasetKey } from "../state/types";

export type PerDatasetErrorMap = Partial<Record<DatasetKey, string>>;

/**
 * Log-prefix constant used by the hydration pipeline's debug output.
 * Exported so future log-reader / test-grep tooling has one
 * authoritative source.
 *
 * Phase 5e (2026-04-29): `HYDRATE_LOG_PREFIX_IDB` deleted along with
 * the IDB hydration path. The cloud-only hydration path is the only
 * remaining consumer of these prefixes.
 */
export const HYDRATE_LOG_PREFIX_CLOUD = "[hydrate:cloud]";

export function toUserFacingHydrationMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Could not load this dataset. Try refreshing the page.";
  }
  // Name-based classification covers the realistic catch-block
  // sources. Falls through to a generic message for anything else.
  switch (error.name) {
    case "AbortError":
      return "Timed out reading this dataset. Check your connection and retry.";
    case "SyntaxError":
      return "Saved copy is corrupt. Re-upload this dataset to fix.";
    case "QuotaExceededError":
      return "Browser storage is full. Clear space and reload.";
    case "DataError":
    case "DataCloneError":
      return "Saved copy is unreadable. Re-upload this dataset to fix.";
    case "NotFoundError":
      return "Saved copy has been removed. Re-upload to restore.";
    case "InvalidStateError":
      return "Browser storage is unavailable. Reload the tab.";
    default:
      return "Could not load this dataset. Try refreshing the page.";
  }
}
