import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_TAB_ALIASES,
  getTabFromSearch,
  isDashboardTabId,
  resolveInitialDashboardTab,
  resolveTabAlias,
} from "./dashboardTabs";
import { DASHBOARD_TAB_VALUES } from "./constants";

describe("isDashboardTabId", () => {
  it("returns true for every canonical tab value", () => {
    for (const tab of DASHBOARD_TAB_VALUES) {
      expect(isDashboardTabId(tab)).toBe(true);
    }
  });

  it("returns false for unknown values", () => {
    expect(isDashboardTabId("not-a-tab")).toBe(false);
    expect(isDashboardTabId("")).toBe(false);
    // Verbose alias strings are NOT canonical — they go through
    // `resolveTabAlias` instead.
    expect(isDashboardTabId("application-pipeline")).toBe(false);
  });
});

describe("resolveTabAlias", () => {
  it("returns canonical tabs unchanged", () => {
    expect(resolveTabAlias("overview")).toBe("overview");
    expect(resolveTabAlias("app-pipeline")).toBe("app-pipeline");
    expect(resolveTabAlias("snapshot-log")).toBe("snapshot-log");
  });

  it("resolves verbose aliases to their canonical form", () => {
    // The motivating case from the prod walk: a deep-link to
    // `?tab=application-pipeline` lands on Overview pre-fix
    // because the canonical slug is `app-pipeline`.
    expect(resolveTabAlias("application-pipeline")).toBe("app-pipeline");
  });

  it("returns null for genuinely unknown inputs", () => {
    expect(resolveTabAlias("bogus")).toBeNull();
    expect(resolveTabAlias("")).toBeNull();
  });
});

describe("getTabFromSearch", () => {
  it("parses the canonical short slug", () => {
    expect(getTabFromSearch("?tab=app-pipeline")).toBe("app-pipeline");
    expect(getTabFromSearch("tab=app-pipeline")).toBe("app-pipeline");
  });

  it("resolves verbose aliases via the alias table", () => {
    expect(getTabFromSearch("?tab=application-pipeline")).toBe(
      "app-pipeline"
    );
  });

  it("returns null when the tab param is missing or invalid", () => {
    expect(getTabFromSearch("")).toBeNull();
    expect(getTabFromSearch("?other=value")).toBeNull();
    expect(getTabFromSearch("?tab=invalid-slug")).toBeNull();
  });

  it("ignores other params and uses only `tab`", () => {
    expect(
      getTabFromSearch("?other=foo&tab=performance-ratio&another=bar")
    ).toBe("performance-ratio");
  });

  it("strips the leading ? if present (and works without it)", () => {
    expect(getTabFromSearch("?tab=overview")).toBe("overview");
    expect(getTabFromSearch("tab=overview")).toBe("overview");
  });
});

// resolveInitialDashboardTab — exercises both the `window`-present
// branch (deep-link cold-mount race) and the SSR-fallback branch.
describe("resolveInitialDashboardTab", () => {
  // jsdom isn't loaded for this test file (vitest config = node); we
  // simulate a window object on globalThis for the integration shape
  // without polyfilling the full DOM.
  const originalWindow = (globalThis as { window?: { location: { search: string } } }).window;

  function setWindowSearch(search: string) {
    (globalThis as { window?: { location: { search: string } } }).window = {
      location: { search },
    };
  }

  function clearWindow() {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }

  beforeEach(() => {
    clearWindow();
  });

  afterEach(() => {
    clearWindow();
  });

  it("prefers the `window.location.search` value when both populated", () => {
    setWindowSearch("?tab=performance-ratio");
    // Wouter would supply `tab=overview` here on cold mount; the
    // helper should still pick up the URL's actual tab.
    expect(resolveInitialDashboardTab("?tab=overview")).toBe(
      "performance-ratio"
    );
  });

  it("falls back to the wouter `search` param when `window.location.search` has no tab", () => {
    setWindowSearch("");
    expect(resolveInitialDashboardTab("?tab=snapshot-log")).toBe(
      "snapshot-log"
    );
  });

  it("returns null when neither source has a valid tab", () => {
    setWindowSearch("?other=foo");
    expect(resolveInitialDashboardTab("?other=bar")).toBeNull();
  });

  it("uses the supplied search when window is unavailable (SSR path)", () => {
    clearWindow();
    expect(resolveInitialDashboardTab("?tab=trends")).toBe("trends");
  });

  it("resolves verbose aliases on the `window` branch (Bug #2 happy path)", () => {
    setWindowSearch("?tab=application-pipeline");
    expect(resolveInitialDashboardTab("")).toBe("app-pipeline");
  });
});

describe("DASHBOARD_TAB_ALIASES", () => {
  it("only contains entries whose codomain is a canonical tab id", () => {
    // Defense against typos in alias declarations: every aliased
    // value must round-trip through `isDashboardTabId`.
    for (const target of Object.values(DASHBOARD_TAB_ALIASES)) {
      expect(isDashboardTabId(target)).toBe(true);
    }
  });

  it("never aliases a string to itself (would be a noop entry)", () => {
    for (const [verbose, canonical] of Object.entries(DASHBOARD_TAB_ALIASES)) {
      expect(verbose).not.toBe(canonical);
    }
  });
});
