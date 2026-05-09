import { describe, expect, it } from "vitest";
import {
  DASHBOARD_TAB_ALIASES,
  getTabFromSearch,
  isDashboardTabId,
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

  it("URLSearchParams.get returns the FIRST value when `tab` appears multiple times", () => {
    // Defensive: a duplicate `?tab=` from a malformed bookmark.
    // URLSearchParams.get returns the first occurrence; this test
    // pins the semantic so a future move to URLSearchParams.getAll
    // (or similar) is a deliberate choice, not an accident.
    expect(getTabFromSearch("?tab=overview&tab=size")).toBe("overview");
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

  it("verbose keys are NEVER themselves canonical tab ids", () => {
    // If a verbose form happened to match a canonical id (e.g. the
    // user added `"app-pipeline": "trends"`), `resolveTabAlias`
    // would short-circuit on the canonical check and never honor
    // the alias — silent dead-config. Lock the invariant.
    for (const verbose of Object.keys(DASHBOARD_TAB_ALIASES)) {
      expect(isDashboardTabId(verbose)).toBe(false);
    }
  });
});
