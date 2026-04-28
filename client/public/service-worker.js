/* eslint-disable no-restricted-globals */
/**
 * Phase E (2026-04-28) — Coherence Service Worker.
 *
 * Hand-rolled (no workbox) so the cache strategy stays
 * obvious and the bundle stays free of an SW build dependency.
 *
 * Caching contract (per route family):
 *
 *   - HTML navigations       → network-first, fall back to the cached
 *                              shell when offline. Keeps the user on
 *                              the most recent build whenever the
 *                              network is reachable.
 *   - /assets/*              → cache-first. Vite emits hashed
 *                              filenames so each URL is content-
 *                              addressed; once cached, never refetch.
 *   - Other static (svg/png) → stale-while-revalidate. Render the
 *                              cached copy immediately, refresh in
 *                              the background.
 *   - /api/* + /solar-rec/api/* + /trpc → never cached. Auth state
 *                              and live data must always hit the
 *                              network.
 *
 * Version bump: when this file changes, increment CACHE_VERSION.
 * The activate handler removes every cache that doesn't match,
 * so the previous-build chunks are reclaimed on next start.
 */

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "coherence";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

// URLs precached on install. Keep this list small — the runtime
// fetch handler picks up everything else as the user navigates,
// so we only seed the entry points that need to render offline.
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
  // skipWaiting so a new SW takes over without waiting for every
  // tab to close. Combined with the `controllerchange` toast on
  // the client, the user sees "new version available — refresh"
  // and decides when to actually swap the page.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Use a forgiving addAll: a single 404 (e.g. missing icon)
      // shouldn't block the whole SW install. We loop and ignore
      // failures so the install still completes.
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
      // Take control of any uncontrolled clients (e.g. the page
      // that triggered the SW install).
      await self.clients.claim();
    })()
  );
});

/**
 * Classify a request URL into a strategy. Pure — extracted so the
 * client tests can verify the routing logic without spinning up a
 * service worker context.
 */
function strategyFor(url) {
  // Same-origin only. Cross-origin (fonts.googleapis.com,
  // analytics) bypasses the SW entirely.
  if (url.origin !== self.location.origin) return "passthrough";

  const path = url.pathname;

  // API + tRPC — never cache. Includes both the personal app's
  // `/api/trpc` and the standalone solar-rec mount at
  // `/solar-rec/api/trpc`. The legacy `/trpc` prefix is also
  // covered for any older paths that may still exist.
  if (
    path.startsWith("/api/") ||
    path.startsWith("/solar-rec/api/") ||
    path.startsWith("/trpc/")
  ) {
    return "passthrough";
  }

  // Vite-emitted hashed assets. Filename includes a content hash
  // so cache-first is safe — a different content always means a
  // different URL.
  if (path.startsWith("/assets/")) return "cache-first";

  // Everything else is either an HTML route or a static asset
  // (SVGs, PNGs, manifest, favicon, etc.). Distinguish by the
  // request's Accept header at the call site (we can't see headers
  // in this pure helper).
  return "network-first-or-stale-while-revalidate";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only intercept GET — POST/PUT/DELETE bypass the SW entirely so
  // mutations always hit the network. (We already passthrough
  // /api/*, but a stray GET-like request via fetch would still be
  // safe to intercept; non-GETs we leave to the browser.)
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

  // network-first-or-stale-while-revalidate: HTML navigations get
  // network-first (so a fresh deploy is always picked up when the
  // network is reachable). Other static assets get
  // stale-while-revalidate.
  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithShellFallback(request));
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
  // Both miss; let the caller see the failure.
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

async function networkFirstWithShellFallback(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Only cache HTML responses; an unexpected redirect to a
      // login page or an API JSON shouldn't take over the shell
      // slot. The caller's request is for a navigation so we
      // expect text/html here.
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        cache.put(request, response.clone()).catch(() => {});
      }
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Offline + no cached HTML for this URL — fall back to the
    // root shell. Wouter handles client-side routing, so once the
    // app boots it'll figure out the location.
    const fallback =
      (await cache.match("/")) ?? (await cache.match("/dashboard"));
    if (fallback) return fallback;
    throw err;
  }
}

// Allow the page to ask the SW to apply a pending update
// immediately (the "Refresh now" button on the update toast).
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
