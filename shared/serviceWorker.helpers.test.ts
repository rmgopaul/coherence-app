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
  isPwaStandaloneMode,
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
