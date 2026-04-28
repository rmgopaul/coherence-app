/**
 * Service worker registration — DISABLED in this build (2026-04-28
 * hotfix). Two PR #223 regressions came together:
 *
 *   1. Stale cached HTML referencing dead chunks. The SW caches
 *      `/solar-rec/*` HTML on first hit; subsequent deploys delete
 *      the old hashed JS those HTMLs reference (Vite emptyOutDir),
 *      so the cached HTML can't bootstrap and the page renders
 *      blank.
 *   2. The shell-fallback path returned the personal app's
 *      `index.html` for `/solar-rec/*` navigations on network
 *      failure, dropping users into a `<NotFound>` at a solar-rec
 *      URL.
 *
 * Until the dual-app strategy lands (per-prefix shell fallback,
 * navigation strategy rework, cache-version bump), this helper
 * actively unregisters every existing service worker so users on
 * a previous build return to a network-only path on next visit.
 *
 * Original implementation preserved below in git history at PR
 * #223 + the doc-PR #231 reference. PR-B (forthcoming) restores
 * the registration with a fixed cache strategy.
 */

let alreadyDisabled = false;

export function registerServiceWorker(): void {
  if (alreadyDisabled) return;
  alreadyDisabled = true;

  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  // Best-effort cleanup: every previously-registered SW under this
  // origin is told to unregister. Any cached fetches the old SW had
  // queued continue, but no new request will be intercepted, and
  // on next page load the browser will not find an active SW.
  // Wrapped in a try/catch — a SW registration failure should never
  // surface to the user.
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().catch(() => {});
      }
    })
    .catch(() => {});

  // Also clear the SW-managed Cache Storage so a stale cached
  // `/solar-rec/*` HTML can't outlive the unregister. Any future
  // cache (when PR-B re-enables the SW) will start fresh.
  if (typeof caches !== "undefined" && typeof caches.keys === "function") {
    caches
      .keys()
      .then((keys) => {
        for (const key of keys) {
          if (key.startsWith("coherence-")) {
            caches.delete(key).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
}
