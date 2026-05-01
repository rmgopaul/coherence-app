/**
 * Phase E (2026-04-28) — tests for the SW route classification.
 *
 * These tests guard the strategy table in `client/public/service-
 * worker.js` — any change here should be mirrored there. Both
 * implementations are intentionally short so a side-by-side diff
 * during review is the source of truth.
 */
import { describe, expect, it } from "vitest";
import {
  classifyServiceWorkerRequest,
  extractBuildIdFromHtml,
  isPwaStandaloneMode,
  selectShellFallback,
  shouldCacheHtmlForOffline,
} from "./serviceWorker.helpers";

const ORIGIN = "https://app.example.com";

describe("classifyServiceWorkerRequest", () => {
  it("passes cross-origin URLs through", () => {
    expect(
      classifyServiceWorkerRequest(
        "https://fonts.googleapis.com/css2?foo=bar",
        ORIGIN
      )
    ).toBe("passthrough");
    expect(
      classifyServiceWorkerRequest(
        "https://analytics.example.net/umami",
        ORIGIN
      )
    ).toBe("passthrough");
  });

  it("returns passthrough for unparseable URLs", () => {
    expect(classifyServiceWorkerRequest("not-a-url", ORIGIN)).toBe(
      "passthrough"
    );
    expect(classifyServiceWorkerRequest("", ORIGIN)).toBe("passthrough");
  });

  it("never caches /api/* — auth state must be live", () => {
    expect(
      classifyServiceWorkerRequest(`${ORIGIN}/api/trpc/auth.me`, ORIGIN)
    ).toBe("passthrough");
    expect(
      classifyServiceWorkerRequest(`${ORIGIN}/api/health`, ORIGIN)
    ).toBe("passthrough");
  });

  it("never caches /solar-rec/api/* — same reason", () => {
    expect(
      classifyServiceWorkerRequest(
        `${ORIGIN}/solar-rec/api/trpc/users.list`,
        ORIGIN
      )
    ).toBe("passthrough");
  });

  it("never caches the legacy /trpc/ prefix", () => {
    expect(
      classifyServiceWorkerRequest(`${ORIGIN}/trpc/foo`, ORIGIN)
    ).toBe("passthrough");
  });

  it("returns cache-first for hashed Vite assets", () => {
    expect(
      classifyServiceWorkerRequest(
        `${ORIGIN}/assets/main-DAa12bC3.js`,
        ORIGIN
      )
    ).toBe("cache-first");
    expect(
      classifyServiceWorkerRequest(
        `${ORIGIN}/assets/Health-u7XzJze1.js`,
        ORIGIN
      )
    ).toBe("cache-first");
  });

  it("returns network-first-or-stale-while-revalidate for everything else same-origin", () => {
    // HTML navigation
    expect(classifyServiceWorkerRequest(`${ORIGIN}/dashboard`, ORIGIN)).toBe(
      "network-first-or-stale-while-revalidate"
    );
    // Static asset (favicon etc.)
    expect(classifyServiceWorkerRequest(`${ORIGIN}/favicon.png`, ORIGIN)).toBe(
      "network-first-or-stale-while-revalidate"
    );
    // Manifest itself
    expect(
      classifyServiceWorkerRequest(`${ORIGIN}/manifest.webmanifest`, ORIGIN)
    ).toBe("network-first-or-stale-while-revalidate");
    // Solar REC HTML root
    expect(classifyServiceWorkerRequest(`${ORIGIN}/solar-rec/`, ORIGIN)).toBe(
      "network-first-or-stale-while-revalidate"
    );
  });

  it("does not confuse /assets-foo with /assets/", () => {
    // A future route at `/assets-archive` (or similar) should NOT
    // be cache-first — only `/assets/<...>` (the hashed bundle
    // directory) qualifies.
    expect(
      classifyServiceWorkerRequest(`${ORIGIN}/assets-archive/x`, ORIGIN)
    ).toBe("network-first-or-stale-while-revalidate");
  });

  it("treats a query string as part of the URL but routes by path", () => {
    expect(
      classifyServiceWorkerRequest(
        `${ORIGIN}/assets/main.js?v=foo`,
        ORIGIN
      )
    ).toBe("cache-first");
    expect(
      classifyServiceWorkerRequest(
        `${ORIGIN}/api/health?check=true`,
        ORIGIN
      )
    ).toBe("passthrough");
  });
});

describe("isPwaStandaloneMode", () => {
  it("returns false when no matchMedia is available", () => {
    expect(isPwaStandaloneMode(null)).toBe(false);
  });

  it("returns true when (display-mode: standalone) matches", () => {
    const fakeMatch = (query: string) => ({
      matches: query === "(display-mode: standalone)",
    });
    expect(isPwaStandaloneMode(fakeMatch)).toBe(true);
  });

  it("returns false when standalone does not match", () => {
    const fakeMatch = () => ({ matches: false });
    expect(isPwaStandaloneMode(fakeMatch)).toBe(false);
  });
});

describe("selectShellFallback", () => {
  it("returns / for the personal app's root", () => {
    expect(selectShellFallback("/")).toBe("/");
  });

  it("returns / for personal-app pages", () => {
    expect(selectShellFallback("/dashboard")).toBe("/");
    expect(selectShellFallback("/notes")).toBe("/");
    expect(selectShellFallback("/habits")).toBe("/");
    expect(selectShellFallback("/widget/todoist")).toBe("/");
    expect(selectShellFallback("/settings")).toBe("/");
    expect(selectShellFallback("/feedback")).toBe("/");
  });

  it("returns null for solar-rec pages — SW v3 disables shell fallback for the team app", () => {
    // Solar-rec is multi-user team UI behind backend; serving stale
    // shell HTML when offline is worse UX than the browser's native
    // error page (the cached HTML can reference deleted Vite chunks
    // after a deploy → blank page with chunk-404 in the network
    // panel rather than an honest "no internet" message).
    expect(selectShellFallback("/solar-rec/")).toBeNull();
    expect(selectShellFallback("/solar-rec/dashboard")).toBeNull();
    expect(selectShellFallback("/solar-rec/monitoring")).toBeNull();
    expect(selectShellFallback("/solar-rec/system/CSG-12345")).toBeNull();
    expect(selectShellFallback("/solar-rec/meter-reads/enphase-v4")).toBeNull();
  });

  it("treats /solar-rec (no trailing slash) as solar-rec too", () => {
    // Edge case — Wouter normalizes URLs but a hard navigation
    // typed in the URL bar can land here.
    expect(selectShellFallback("/solar-rec")).toBeNull();
  });

  it("does NOT confuse /solar-rec-prefixed siblings", () => {
    // A future personal-app route at /solar-rec-archive (or similar)
    // would NOT be a solar-rec navigation — only `/solar-rec/<...>`
    // and the bare `/solar-rec` qualify.
    expect(selectShellFallback("/solar-rec-archive")).toBe("/");
    expect(selectShellFallback("/solar-recap")).toBe("/");
  });

  it("returns / defensively on non-string input", () => {
    // Hardening: any future caller passing something exotic gets
    // the personal shell rather than throwing. The runtime SW
    // already type-narrows pathnames, so this is belt-and-
    // suspenders.
    expect(
      selectShellFallback(null as unknown as string)
    ).toBe("/");
    expect(
      selectShellFallback(undefined as unknown as string)
    ).toBe("/");
  });
});

describe("shouldCacheHtmlForOffline", () => {
  it("caches personal-app HTML so offline navigation has a shell", () => {
    expect(shouldCacheHtmlForOffline("/")).toBe(true);
    expect(shouldCacheHtmlForOffline("/dashboard")).toBe(true);
    expect(shouldCacheHtmlForOffline("/notes")).toBe(true);
    expect(shouldCacheHtmlForOffline("/widget/todoist")).toBe(true);
  });

  it("does NOT cache solar-rec HTML — network-only by design (SW v3)", () => {
    expect(shouldCacheHtmlForOffline("/solar-rec/")).toBe(false);
    expect(shouldCacheHtmlForOffline("/solar-rec/dashboard")).toBe(false);
    expect(shouldCacheHtmlForOffline("/solar-rec/monitoring")).toBe(false);
    expect(shouldCacheHtmlForOffline("/solar-rec/system/CSG-12345")).toBe(
      false
    );
  });

  it("treats bare /solar-rec as solar-rec too", () => {
    expect(shouldCacheHtmlForOffline("/solar-rec")).toBe(false);
  });

  it("does NOT confuse /solar-rec-prefixed siblings", () => {
    // Same edge-case shape as selectShellFallback — a hypothetical
    // personal-app route at /solar-rec-archive should still cache.
    expect(shouldCacheHtmlForOffline("/solar-rec-archive")).toBe(true);
    expect(shouldCacheHtmlForOffline("/solar-recap")).toBe(true);
  });

  it("returns false defensively on non-string input", () => {
    expect(shouldCacheHtmlForOffline(null as unknown as string)).toBe(false);
    expect(shouldCacheHtmlForOffline(undefined as unknown as string)).toBe(
      false
    );
  });
});

describe("extractBuildIdFromHtml", () => {
  it("extracts the build-id meta tag content", () => {
    const html = `<!doctype html><html><head>
      <meta name="build-id" content="1730000000000-abc1234" />
    </head><body></body></html>`;
    expect(extractBuildIdFromHtml(html)).toBe("1730000000000-abc1234");
  });

  it("matches single-quoted attributes", () => {
    const html = `<meta name='build-id' content='dev'>`;
    expect(extractBuildIdFromHtml(html)).toBe("dev");
  });

  it("matches mixed-quote attributes (real-world Vite output)", () => {
    const html = `<meta name="build-id" content='1730000000000-abc1234'>`;
    expect(extractBuildIdFromHtml(html)).toBe("1730000000000-abc1234");
  });

  it("is case-insensitive on the META tag and attribute name", () => {
    const html = `<META NAME="Build-Id" CONTENT="upper-case">`;
    expect(extractBuildIdFromHtml(html)).toBe("upper-case");
  });

  it("returns null when no build-id meta tag exists", () => {
    const html = `<!doctype html><html><head>
      <meta name="theme-color" content="#000" />
    </head></html>`;
    expect(extractBuildIdFromHtml(html)).toBeNull();
  });

  it("returns null when content is missing", () => {
    // A malformed `<meta name="build-id">` without content is not a
    // useful signal — return null rather than empty string.
    expect(extractBuildIdFromHtml(`<meta name="build-id">`)).toBeNull();
  });

  it("returns null on non-string input", () => {
    expect(extractBuildIdFromHtml(null as unknown as string)).toBeNull();
    expect(extractBuildIdFromHtml(undefined as unknown as string)).toBeNull();
  });

  it("does not match a build-id-like comment", () => {
    // Belt-and-suspenders: only real meta tags should match.
    expect(
      extractBuildIdFromHtml(`<!-- build-id: 1730000000000-abc1234 -->`)
    ).toBeNull();
  });
});
