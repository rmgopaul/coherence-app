/**
 * Service worker registration + update flow.
 *
 * Both entry points (`main.tsx` + `solar-rec-main.tsx`) call this
 * on boot. It:
 *
 *   1. No-ops in development (`import.meta.env.DEV`) so the SW
 *      doesn't shadow Vite's HMR + ESM-graph logic.
 *   2. No-ops when navigator.serviceWorker is missing (SSR, older
 *      browsers, file://).
 *   3. Registers `/service-worker.js` from the root scope on
 *      `window.load` so the registration doesn't compete with
 *      first-paint critical resources.
 *   4. Reloads once when the controlling SW changes (a freshly
 *      activated worker claimed the page).
 *   5. Listens for `BUILD_ID_MISMATCH` messages from the SW (v3).
 *      The SW posts this when it detects the live shell HTML's
 *      `<meta name="build-id">` doesn't match the SW's baked-in
 *      `BUILD_ID`. By the time the message arrives, the SW has
 *      already self-unregistered — so a `location.reload()` here
 *      bypasses the SW entirely and pulls fresh HTML + chunks.
 *
 * **No update toast (removed 2026-05-19).** v1/v2 surfaced a
 * "New version available — Refresh now" toast when a new worker
 * reached `installed` while an old one still controlled the page.
 * v3 (2026-04-30) added `BUILD_ID_MISMATCH`, which already
 * auto-reloads on the next navigation after *any* deploy (the SW
 * script only varies by its baked `BUILD_ID`, so a new waiting
 * worker and a shell build-id mismatch are the same event). That
 * left the toast strictly redundant: it fired in the racy window
 * right before the BUILD_ID_MISMATCH reload, and — because it was
 * re-prompted on every `register()` call whenever a waiting worker
 * existed, with no de-dupe — it nagged on *almost every load* until
 * the user happened to click it. BUILD_ID_MISMATCH is now the
 * single update mechanism; it covers both the personal (`/`) and
 * solar-rec (`/solar-rec/`) shells (the build-id check runs for any
 * text/html navigation regardless of offline-cache eligibility).
 *
 * v2 (PR #235) — re-enabled after the v1 hotfix (#234) disabled it.
 * The v2 SW is dual-app aware: solar-rec navigations get a
 * `/solar-rec/` shell on offline fallback (vs v1's incorrect `/`).
 *
 * v3 (Phase 1.1 of the dashboard foundation repair, 2026-04-30) —
 * solar-rec HTML is network-only, build-id mismatch detection
 * triggers a one-shot reload.
 *
 * All steps are wrapped so a SW failure never bricks the app —
 * the page works fine without one.
 */

let alreadyRegistered = false;

export function registerServiceWorker(): void {
  if (alreadyRegistered) return;
  alreadyRegistered = true;

  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  const onLoad = () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[sw] registration failed:", err);
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
      // SW v3 build-id mismatch — the SW has already self-
      // unregistered, so this reload bypasses it entirely.
      // Guard with the same `reloading` flag so a concurrent
      // controllerchange + BUILD_ID_MISMATCH only reloads once.
      if (event.data?.type === "BUILD_ID_MISMATCH") {
        if (reloading) return;
        reloading = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[sw] BUILD_ID_MISMATCH; reloading to pick up new build",
          event.data
        );
        window.location.reload();
      }
    });
  };

  if (document.readyState === "complete") {
    onLoad();
  } else {
    window.addEventListener("load", onLoad, { once: true });
  }
}
