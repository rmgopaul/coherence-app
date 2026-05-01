/**
 * Phase E (2026-04-28) — pure helpers for the PWA service worker.
 *
 * The service worker itself lives at `client/public/service-worker.js`
 * (plain JS so the browser can `register()` it directly without a
 * compile step). This module re-implements the route-classification
 * logic in TypeScript so it can be unit-tested + reused by the
 * registration code in `main.tsx` (e.g. to decide whether a
 * particular pathname should bypass the SW for diagnostic reasons).
 *
 * Keep the strategy table in lockstep with `service-worker.js` —
 * any change here should be mirrored there or the SW will diverge
 * from what the tests claim.
 */

export type SwStrategy =
  | "passthrough"
  | "cache-first"
  | "network-first-or-stale-while-revalidate";

const SAME_ORIGIN_API_PREFIXES = [
  "/api/",
  "/solar-rec/api/",
  "/trpc/",
];

/**
 * Classify a same-origin GET URL into the SW strategy that should
 * handle it. Pure.
 *
 * `selfOrigin` is the SW's own origin (the page origin in the
 * browser). When the request URL is cross-origin, we always
 * passthrough — the SW shouldn't try to cache fonts.googleapis.com
 * or analytics endpoints.
 */
export function classifyServiceWorkerRequest(
  requestUrl: string,
  selfOrigin: string
): SwStrategy {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    // Unparseable URL → safest to passthrough.
    return "passthrough";
  }
  if (url.origin !== selfOrigin) return "passthrough";

  const path = url.pathname;
  for (const prefix of SAME_ORIGIN_API_PREFIXES) {
    if (path.startsWith(prefix)) return "passthrough";
  }

  if (path.startsWith("/assets/")) return "cache-first";

  return "network-first-or-stale-while-revalidate";
}

/**
 * True when the running page is under PWA "standalone" display
 * mode (i.e. installed and launched as an app, not from a
 * browser tab). Pure — accepts an injectable matcher for testing
 * outside a real browser.
 */
export function isPwaStandaloneMode(
  matchMedia: ((query: string) => { matches: boolean }) | null = null
): boolean {
  const fn =
    matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null);
  if (!fn) return false;
  return Boolean(fn("(display-mode: standalone)").matches);
}

/**
 * Pick the shell URL whose cached HTML should serve as the offline
 * fallback for `pathname`. The origin serves two SPAs from the same
 * domain — `/` (personal) and `/solar-rec/` (team) — so a
 * `/solar-rec/*` navigation must fall back to `/solar-rec/` and not
 * `/`. Mirrored in `client/public/service-worker.js` —
 * `shellFallbackFor()` there is the source of truth at runtime;
 * this is the testable surface so the routing logic can't drift.
 *
 * v1 of the SW (PR #223) collapsed this to `/`-or-`/dashboard`
 * regardless of pathname, which crashed the solar-rec app when an
 * offline navigation hit the fallback path. PR #235 splits them.
 *
 * SW v3 (Phase 1.1 of the dashboard foundation repair) returns
 * `null` for solar-rec paths — solar-rec is a multi-user team app
 * that requires the backend, so a stale-shell offline fallback is
 * worse UX than the browser's native error page (the cached HTML
 * could reference deleted chunks after a deploy, producing a blank
 * screen with a 404 in the network panel rather than an honest
 * "no internet" message).
 *
 * Pure.
 */
export function selectShellFallback(pathname: string): "/" | null {
  if (typeof pathname !== "string") return "/";
  if (pathname.startsWith("/solar-rec/")) return null;
  if (pathname === "/solar-rec") return null;
  return "/";
}

/**
 * True when an HTML response for `pathname` should be `cache.put`'d
 * to the SW's static cache for offline fallback. Solar-rec HTML is
 * not cached for the same reason `selectShellFallback` returns null
 * for it: serving stale solar-rec HTML after a deploy can reference
 * deleted Vite chunks (`build.emptyOutDir: true`) and crash the app.
 *
 * Mirrored in `client/public/service-worker.js`. Pure.
 */
export function shouldCacheHtmlForOffline(pathname: string): boolean {
  if (typeof pathname !== "string") return false;
  if (pathname.startsWith("/solar-rec/")) return false;
  if (pathname === "/solar-rec") return false;
  return true;
}

/**
 * Extract the value of `<meta name="build-id" content="...">` from
 * a fully-rendered HTML string. Returns `null` if no such tag exists
 * (e.g. dev mode, before the build-id Vite plugin lands, or when the
 * page is served from a non-build source).
 *
 * Used by the SW to detect mismatches between the SW's baked-in
 * `BUILD_ID` and the live network shell's `build-id`. On mismatch,
 * the SW self-unregisters and posts `BUILD_ID_MISMATCH` to its
 * controlled clients so they can `location.reload()` once.
 *
 * Mirrored in `client/public/service-worker.js`. Pure.
 */
export function extractBuildIdFromHtml(html: string): string | null {
  if (typeof html !== "string") return null;
  const match = html.match(
    /<meta\s+name=["']build-id["']\s+content=["']([^"']*)["']/i
  );
  return match ? match[1] : null;
}
