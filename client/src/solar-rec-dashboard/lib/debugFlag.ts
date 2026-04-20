/**
 * Window-scoped debug flag for solar-rec diagnostics.
 *
 * Flipping the flag in devtools takes effect on the next code path
 * that reads it — no rebuild, no state change needed.
 *
 *   > window.__solarRecDebug = true;   // enable
 *   > window.__solarRecDebug = false;  // disable
 *
 * Used by the hydration pipeline to emit per-dataset timing logs.
 * Future diagnostic code (network probing, memo cost tracking, etc.)
 * should read from the same flag so a single toggle enables all
 * solar-rec debug output.
 */

declare global {
  interface Window {
    __solarRecDebug?: boolean;
  }
}

export function isSolarRecDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.__solarRecDebug === true;
}
