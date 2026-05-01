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
 *   4. Listens for an updated SW: when a new worker reaches
 *      `installed` while another is already controlling the page,
 *      we surface an "update available" toast with a "Refresh now"
 *      action. Clicking it tells the waiting SW to skip waiting
 *      and reloads after `controllerchange` fires.
 *   5. Listens for `BUILD_ID_MISMATCH` messages from the SW (v3+).
 *      The SW posts this when it detects the live shell HTML's
 *      `<meta name="build-id">` doesn't match the SW's baked-in
 *      `BUILD_ID`. By the time the message arrives, the SW has
 *      already self-unregistered — so a `location.reload()` here
 *      bypasses the SW entirely and pulls fresh HTML + chunks.
 *
 * v2 (PR #235) — re-enabled after the v1 hotfix (#234) disabled it.
 * The v2 SW is dual-app aware: solar-rec navigations get a
 * `/solar-rec/` shell on offline fallback (vs v1's incorrect `/`).
 *
 * v3 (Phase 1.1 of the dashboard foundation repair, 2026-04-30) —
 * solar-rec HTML is network-only, build-id mismatch detection
 * triggers a one-shot reload. No client-side change needed for the
 * caching behavior; the new BUILD_ID_MISMATCH listener is the only
 * surface here.
 *
 * All steps are wrapped in a try/catch — a SW failure should never
 * brick the app. The page works fine without one.
 */

import { toast } from "sonner";

let alreadyRegistered = false;

export function registerServiceWorker(): void {
  if (alreadyRegistered) return;
  alreadyRegistered = true;

  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  const onLoad = () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              promptForReload(registration);
            }
          });
        });

        if (registration.waiting && navigator.serviceWorker.controller) {
          promptForReload(registration);
        }
      })
      .catch((err) => {
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

function promptForReload(registration: ServiceWorkerRegistration) {
  toast("New version available", {
    description: "Reload to pick up the latest build.",
    duration: 30_000,
    action: {
      label: "Refresh now",
      onClick: () => {
        const target = registration.waiting ?? registration.installing;
        target?.postMessage({ type: "SKIP_WAITING" });
        // The SW activates, fires `controllerchange`, and our
        // listener above reloads the page.
      },
    },
  });
}
