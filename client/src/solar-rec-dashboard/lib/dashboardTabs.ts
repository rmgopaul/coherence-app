/**
 * Dashboard tab id resolution helpers.
 *
 * 2026-05-09 — Extracted out of `SolarRecDashboard.tsx` (Bug #2 fix
 * from the prod QA walk) so the URL → state path can be unit-tested
 * without spinning up the full dashboard component. The parent
 * imports `getTabFromSearch` from this module.
 *
 * The actual Bug #2 fix is **alias resolution** — accept verbose
 * forms of canonical tab slugs (e.g. `application-pipeline` →
 * `app-pipeline`) so deep-links typed by humans land on the
 * expected tab. Verbose forms do not appear in any link the
 * dashboard itself generates; they exist purely to be tolerant of
 * bookmarks / shared URLs the user typed manually.
 *
 * Post-merge review note (2026-05-09): an earlier draft of this
 * module also exported `resolveInitialDashboardTab` to "sidestep a
 * wouter `useSearch()` cold-mount race". Wouter's `useSearch()`
 * uses `useSyncExternalStore` over `window.location.search`, so
 * the snapshot fn returns the search string synchronously on the
 * first render — there is no race to sidestep. The helper was
 * dead-weight defensive code with a misleading rationale; review
 * caught it and the helper is gone. The single remaining
 * responsibility (alias resolution) is the actual Bug #2 fix.
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
 *
 * **Domain-side hygiene** (post-merge review): a verbose key MUST
 * NOT also be a canonical id. The `resolveTabAlias` short-circuit
 * checks `isDashboardTabId(value)` first, so aliasing a canonical
 * key would be a silent no-op — but the test guard at
 * `dashboardTabs.test.ts` asserts every codomain id IS canonical
 * AND no alias maps to itself. Adding a third invariant
 * (`!isDashboardTabId(verboseKey)`) would be redundant in practice
 * but cheap to add if the alias map ever grows past one entry.
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
