/**
 * Phase E (2026-04-28) — Service worker registration + update flow.
 *
 * Both entry points (main.tsx + solar-rec-main.tsx) call this on
 * boot. It:
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
    // The SW lives at `/service-worker.js` (the file is shipped from
    // `client/public/service-worker.js` to the build root). Scope
    // defaults to the directory of the script — `/` here, which
    // covers both the personal app and the standalone solar-rec
    // bundle since they share an origin.
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((registration) => {
        // If a SW is already controlling the page and a new one
        // is being installed, show the update banner once the
        // new SW reaches the `installed` state. It'll wait until
        // we tell it to take over (or every tab closes).
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

        // If a worker is already in `waiting` at registration time
        // (e.g. tab reopened after a deploy), surface the prompt
        // immediately.
        if (registration.waiting && navigator.serviceWorker.controller) {
          promptForReload(registration);
        }
      })
      .catch((err) => {
        // Don't toast — the user shouldn't see a SW registration
        // failure (offline support is best-effort). Log for
        // debuggability via devtools.
        // eslint-disable-next-line no-console
        console.warn("[sw] registration failed:", err);
      });

    // When the controlling SW changes (because the user clicked
    // "Refresh now" and we sent SKIP_WAITING), reload the page so
    // the new bundle takes effect immediately.
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
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
        // The SW will activate, fire `controllerchange`, and our
        // listener above reloads the page.
      },
    },
  });
}
