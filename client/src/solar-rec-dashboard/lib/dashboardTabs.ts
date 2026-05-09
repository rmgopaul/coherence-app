/**
 * Dashboard tab id resolution helpers.
 *
 * 2026-05-09 — Extracted out of `SolarRecDashboard.tsx` (Bug #2 fix
 * from the prod QA walk) so the URL → state path can be unit-tested
 * without spinning up the full dashboard component. The parent imports
 * `getTabFromSearch` / `resolveInitialDashboardTab` from this module.
 *
 * Two responsibilities:
 *
 * 1. **Alias resolution** — accept verbose forms of canonical tab
 *    slugs (e.g. `application-pipeline` → `app-pipeline`) so deep-
 *    links typed by humans land on the expected tab. Verbose forms
 *    do not appear in any link the dashboard itself generates;
 *    they exist purely to be tolerant of bookmarks / shared URLs.
 *
 * 2. **Cold-mount race tolerance** — `resolveInitialDashboardTab`
 *    reads `window.location.search` directly rather than relying on
 *    wouter's `useSearch()` hook, which can return empty for one
 *    render on cold mount before the store hydrates. The wouter
 *    value is still used as a fallback (e.g. SSR or an environment
 *    where `window` is unavailable mid-test).
 */
import {
  DASHBOARD_TAB_VALUES,
  DASHBOARD_TAB_VALUE_SET,
} from "./constants";

export type DashboardTabId = (typeof DASHBOARD_TAB_VALUES)[number];

export function isDashboardTabId(value: string): value is DashboardTabId {
  return DASHBOARD_TAB_VALUE_SET.has(value);
}

/**
 * Map intuitive verbose tab forms to the canonical short slug. Keep
 * the codomain typed as `DashboardTabId` so a typo on the right-hand
 * side fails to compile rather than silently mapping to a phantom tab.
 *
 * Add new entries when a user reports a deep-link they expected to
 * work that didn't. Resist the temptation to alias every plausible
 * spelling proactively — the URL is a contract, and aliases are a
 * compatibility shim, not a brand of canonical names. The smaller
 * the surface, the simpler the mental model.
 */
export const DASHBOARD_TAB_ALIASES: Record<string, DashboardTabId> = {
  "application-pipeline": "app-pipeline",
};

export function resolveTabAlias(value: string): DashboardTabId | null {
  if (isDashboardTabId(value)) return value;
  const aliased = DASHBOARD_TAB_ALIASES[value];
  return aliased ?? null;
}

export function getTabFromSearch(search: string): DashboardTabId | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  const tab = params.get("tab");
  if (!tab) return null;
  return resolveTabAlias(tab);
}

/**
 * Synchronous, SSR-safe initial-tab resolution. Reads
 * `window.location.search` directly instead of relying on wouter's
 * `useSearch()` — on cold mount with a deep-link URL the
 * `useSearch()` value can be empty for a render before the wouter
 * store hydrates, which lands the user on the default tab even
 * when the URL says otherwise (Bug #2 root cause). Reading
 * `window.location.search` avoids that race.
 *
 * Falls back to the supplied wouter `search` value when `window` is
 * unavailable (SSR / Node test env). The fallback also catches the
 * theoretical case where wouter and `window.location` disagree —
 * if `window.location.search` returns no tab but the wouter value
 * has one, honor wouter's view.
 */
export function resolveInitialDashboardTab(
  fallbackSearch: string
): DashboardTabId | null {
  if (typeof window === "undefined") {
    return getTabFromSearch(fallbackSearch);
  }
  const fromWindow = getTabFromSearch(window.location.search);
  if (fromWindow) return fromWindow;
  return getTabFromSearch(fallbackSearch);
}
