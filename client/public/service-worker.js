/* eslint-disable no-restricted-globals */
/**
 * Coherence Service Worker — v2 (2026-04-28 hotfix follow-up).
 *
 * v2 fixes the dual-app shell bug from v1 (PR #223 → PR #234):
 *
 *   - **Per-prefix shell fallback.** v1 fell back to `/` or
 *     `/dashboard` for ANY navigation that failed network — so a
 *     `/solar-rec/*` navigation that hit the fallback loaded the
 *     personal app's `index.html` and crashed on a missing route.
 *     v2 picks the shell by URL prefix: `/solar-rec/` for
 *     `/solar-rec/*` navigations, `/` otherwise.
 *
 *   - **No auto-skipWaiting.** v1 called `self.skipWaiting()` on
 *     install, so a fresh SW took over without waiting for the
 *     user to click "Refresh now." Combined with auto-reload on
 *     `controllerchange`, the page would flash-reload silently
 *     after a deploy. v2 only skips waiting when the page sends
 *     `{type: "SKIP_WAITING"}` (i.e., the user clicked the toast).
 *
 *   - **CACHE_VERSION bumped to v2.** The activate handler wipes
 *     every cache that doesn't match the current version, so any
 *     v1 caches users still have get cleared on first activation.
 *
 *   - **HTML navigation strategy unchanged conceptually**
 *     (network-first), but the cache update is moved to the
 *     STATIC_CACHE so it doesn't compete with hashed-asset cache
 *     entries; and the cache update is gated on `text/html`
 *     content-type so a redirect to a login page (text/plain or
 *     application/json) doesn't take over the shell slot.
 *
 *   - **Hashed assets remain cache-first.** Filename includes a
 *     content hash so each URL is content-addressed; once cached,
 *     never refetch.
 *
 * Caching contract by route family:
 *
 *   - HTML navigations       → network-first, fall back to a
 *                              prefix-correct cached shell when
 *                              offline.
 *   - /assets/*              → cache-first (hashed = stable).
 *   - Other static (svg/png) → stale-while-revalidate.
 *   - /api/* + /solar-rec/api/* + /trpc → never cached.
 */

const CACHE_VERSION = "v2";
const CACHE_PREFIX = "coherence";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

// URLs precached on install. Both shell entry points are precached
// so the offline-shell fallback below can serve the *correct* HTML
// for whichever app the user navigated to.
const PRECACHE_URLS = [
  "/",
  "/dashboard",
  "/solar-rec/",
  "/manifest.webmanifest",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/logo-c-crown.png",
];

self.addEventListener("install", (event) => {
  // NOTE: deliberately no `self.skipWaiting()` here — the new SW
  // sits in `installed` state until the page sends a
  // `{type: "SKIP_WAITING"}` message (triggered by the user clicking
  // "Refresh now" on the update toast). This is the canonical
  // service-worker update flow and avoids silent flash-reloads
  // after a deploy.
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn("[sw] precache failed:", url, err);
          })
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(`${CACHE_PREFIX}-`))
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Classify a request URL into a strategy. Mirrored in
 * `shared/serviceWorker.helpers.ts` for unit testing — keep both in
 * lockstep.
 */
function strategyFor(url) {
  if (url.origin !== self.location.origin) return "passthrough";

  const path = url.pathname;

  if (
    path.startsWith("/api/") ||
    path.startsWith("/solar-rec/api/") ||
    path.startsWith("/trpc/")
  ) {
    return "passthrough";
  }

  if (path.startsWith("/assets/")) return "cache-first";

  return "network-first-or-stale-while-revalidate";
}

/**
 * Pick the shell URL whose cached HTML should serve as the offline
 * fallback for `pathname`. For `/solar-rec/*` we use `/solar-rec/`
 * so the user lands on the team-app entry rather than the personal
 * app's `index.html` (which would hand `/solar-rec/...` to a Wouter
 * tree that has no matching route).
 *
 * Mirrored in `shared/serviceWorker.helpers.ts` — keep in lockstep.
 */
function shellFallbackFor(pathname) {
  if (pathname.startsWith("/solar-rec/") || pathname === "/solar-rec") {
    return "/solar-rec/";
  }
  return "/";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  const strategy = strategyFor(url);
  if (strategy === "passthrough") return;

  if (strategy === "cache-first") {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithShellFallback(request, url));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const network = await networkPromise;
  if (network) return network;
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

async function networkFirstWithShellFallback(request, url) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        cache.put(request, response.clone()).catch(() => {});
      }
    }
    return response;
  } catch (err) {
    // 1. Try the exact-URL cached HTML (works if the user has
    // navigated here before).
    const cached = await cache.match(request);
    if (cached) return cached;
    // 2. Per-prefix shell fallback. Critical bug fix vs v1: solar-
    // rec navigations fall back to /solar-rec/, not /.
    const shellUrl = shellFallbackFor(url.pathname);
    const shell = await cache.match(shellUrl);
    if (shell) return shell;
    // 3. Last-ditch fallback to root shell so the user at least
    // sees something (this is preserved from v1 — but reachable
    // only when the per-prefix shell ALSO didn't precache for
    // some reason).
    const rootShell = await cache.match("/");
    if (rootShell) return rootShell;
    throw err;
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
