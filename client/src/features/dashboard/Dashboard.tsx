/**
 * Dashboard — route switcher.
 *
 * Behaviour:
 * - If `VITE_FRONT_PAGE_ENABLED` is truthy, render the new front-page
 *   layout (`FrontPageDashboard`).
 * - Otherwise render the legacy dashboard unchanged.
 *
 * The legacy view also stays reachable at `/dashboard-legacy` for 60
 * days after Phase B flips default-on. See `handoff/web-spec.md`.
 *
 * Phase B commit 1: flag is always off until `FrontPageDashboard` lands
 * in commit 2. For now this file is a thin re-export of the legacy
 * component — no behaviour change.
 */
import DashboardLegacy from "./DashboardLegacy";

const FRONT_PAGE_ENABLED =
  import.meta.env.VITE_FRONT_PAGE_ENABLED === "true" ||
  import.meta.env.VITE_FRONT_PAGE_ENABLED === "1";

export default function Dashboard() {
  if (FRONT_PAGE_ENABLED) {
    // FrontPageDashboard ships in commit 2. Until then, honour the flag
    // but fall through to legacy so the route is never broken.
    return <DashboardLegacy />;
  }
  return <DashboardLegacy />;
}
