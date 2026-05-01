/* eslint-disable no-restricted-globals */
/**
 * Coherence Service Worker — v3 (Phase 1.1 of the dashboard
 * foundation repair, 2026-04-30).
 *
 * v3 fixes the stale-shell / orphaned-chunk failure mode that
 * surfaced under the v2 SW (which itself fixed the v1 dual-app
 * crash from PR #223). The symptom: a user opens the dashboard,
 * a deploy happens, the user reloads or navigates, and the SW
 * either serves a cached HTML whose `<script src>` references
 * deleted Vite chunks (because `build.emptyOutDir: true` wiped
 * them) or — at minimum — has no way to detect the staleness.
 *
 * v3 changes vs v2:
 *
 *   - **Solar-rec HTML is network-only.** Removed `/solar-rec/`
 *     from PRECACHE_URLS; `cache.put` is gated on
 *     `shouldCacheHtmlForOffline(pathname)` which returns false
 *     for solar-rec paths; on network failure the SW throws
 *     instead of falling back to a stale shell. Solar-rec is a
 *     multi-user team app behind login — offline isn't a
 *     feature, and a blank-with-chunk-404 page is worse than
 *     the browser's native "no internet" page.
 *
 *   - **Build-id mismatch detection.** Each shell HTML carries
 *     `<meta name="build-id" content="...">` (injected by the
 *     Vite plugin in vite.config.ts). The SW bakes its own
 *     `BUILD_ID` constant from the same plugin. On every
 *     successful HTML fetch, the SW (best-effort, non-blocking)
 *     extracts the live shell's build-id; on mismatch it wipes
 *     the HTML cache, posts `BUILD_ID_MISMATCH` to all
 *     controlled clients, and self-unregisters. The clients'
 *     `registerServiceWorker.ts` listener receives the message
 *     and `location.reload()`s — the reload bypasses the
 *     unregistered SW and pulls fresh HTML + chunks.
 *
 *   - **CACHE_VERSION bumped to v3.** The activate handler
 *     wipes any cache that doesn't match — v2 caches are
 *     evicted on first activation of v3.
 *
 *   - **Helpers mirrored from `shared/serviceWorker.helpers.ts`.**
 *     Two new pure functions are duplicated here for runtime use:
 *     `shouldCacheHtmlForOffline()` and `extractBuildIdFromHtml()`.
 *     Tests in `shared/serviceWorker.helpers.test.ts` are the
 *     source of truth — keep both implementations in lockstep.
 *
 * Caching contract by route family (unchanged conceptually):
 *
 *   - HTML navigations       → network-first; per-prefix shell
 *                              fallback for personal app only;
 *                              network-only for solar-rec.
 *   - /assets/*              → cache-first (hashed = stable).
 *   - Other static (svg/png) → stale-while-revalidate.
 *   - /api/* + /solar-rec/api/* + /trpc → never cached.
 */

// `__BUILD_ID__` is replaced at build time by the buildIdPlugin in
// vite.config.ts. In dev (where the SW isn't registered anyway —
// `registerServiceWorker.ts` no-ops on import.meta.env.DEV) the
// literal placeholder is harmless because the SW never runs.
const BUILD_ID = "__BUILD_ID__";

const CACHE_VERSION = "v3";
const CACHE_PREFIX = "coherence";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

// URLs precached on install. v3: `/solar-rec/` is intentionally
// absent — solar-rec HTML is network-only (see header comment).
const PRECACHE_URLS = [
  "/",
  "/dashboard",
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
 * fallback for `pathname`, or `null` to disable fallback entirely.
 *
 * v3 returns `null` for solar-rec paths — see header comment for
 * rationale. Mirrored in `shared/serviceWorker.helpers.ts`
 * (`selectShellFallback`).
 */
function shellFallbackFor(pathname) {
  if (pathname.startsWith("/solar-rec/") || pathname === "/solar-rec") {
    return null;
  }
  return "/";
}

/**
 * True when an HTML response for `pathname` should be `cache.put`'d
 * to the SW's static cache for offline fallback. Solar-rec HTML is
 * not cached — see header comment. Mirrored in
 * `shared/serviceWorker.helpers.ts` (`shouldCacheHtmlForOffline`).
 */
function shouldCacheHtmlForOffline(pathname) {
  if (pathname.startsWith("/solar-rec/") || pathname === "/solar-rec") {
    return false;
  }
  return true;
}

/**
 * Extract the value of `<meta name="build-id" content="...">` from
 * a fully-rendered HTML string, or null if no such tag exists.
 * Mirrored in `shared/serviceWorker.helpers.ts`
 * (`extractBuildIdFromHtml`).
 */
function extractBuildIdFromHtml(html) {
  if (typeof html !== "string") return null;
  const match = html.match(
    /<meta\s+name=["']build-id["']\s+content=["']([^"']*)["']/i
  );
  return match ? match[1] : null;
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
        // v3: only cache HTML that's eligible for offline fallback.
        // Solar-rec HTML is intentionally not cached.
        if (shouldCacheHtmlForOffline(url.pathname)) {
          cache.put(request, response.clone()).catch(() => {});
        }
        // v3: best-effort build-id mismatch detection. Runs async
        // and never blocks the response. The clone here is what
        // we read in `maybeReportBuildIdMismatch` — the original
        // response goes back to the page untouched.
        maybeReportBuildIdMismatch(response.clone(), url.pathname).catch(
          () => {}
        );
      }
    }
    return response;
  } catch (err) {
    // 1. Try the exact-URL cached HTML (works if the user has
    // navigated here before).
    const cached = await cache.match(request);
    if (cached) return cached;
    // 2. Per-prefix shell fallback. v3: returns null for solar-rec,
    // so solar-rec navigations skip the fallback and bubble the
    // error up to the browser.
    const shellUrl = shellFallbackFor(url.pathname);
    if (shellUrl === null) {
      throw err;
    }
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

/**
 * Compare the live network shell's `build-id` meta to this SW's
 * baked-in `BUILD_ID`. On mismatch: wipe HTML cache, post
 * `BUILD_ID_MISMATCH` to every controlled client, self-unregister.
 * Best-effort — any failure here is swallowed so a build-id check
 * never breaks navigation.
 *
 * Skipped when `BUILD_ID === "__BUILD_ID__"` (the un-replaced
 * placeholder, which can only happen if the Vite build-id plugin
 * didn't run — e.g., legacy builds, dev mode, or a deploy of a
 * branch without the plugin).
 */
async function maybeReportBuildIdMismatch(response, pathname) {
  if (BUILD_ID === "__BUILD_ID__") return;
  const text = await response.text();
  const liveBuildId = extractBuildIdFromHtml(text);
  if (!liveBuildId || liveBuildId === BUILD_ID) return;

  // eslint-disable-next-line no-console
  console.warn(
    `[sw] build-id mismatch: SW=${BUILD_ID} live=${liveBuildId} (path=${pathname})`
  );

  // Wipe HTML cache so future navigations refetch fresh shells.
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    PRECACHE_URLS.filter(
      (u) => u === "/" || u === "/dashboard" || u.endsWith(".html")
    ).map((u) => cache.delete(u))
  );

  // Tell every controlled client to reload. The unregister below
  // means the reload bypasses this SW and pulls fresh HTML +
  // chunks straight from the network.
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: "BUILD_ID_MISMATCH",
      expected: BUILD_ID,
      found: liveBuildId,
    });
  }

  await self.registration.unregister();
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
