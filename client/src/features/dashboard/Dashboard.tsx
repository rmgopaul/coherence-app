/**
 * Dashboard — route switcher.
 *
 * Behaviour:
 * - If `VITE_FRONT_PAGE_ENABLED` is truthy, render the new front-page
 *   layout (`FrontPageDashboard`).
 * - Otherwise render the legacy dashboard unchanged.
 *
 * The legacy view also stays reachable at `/dashboard-legacy` for 60
 * days after flipping default-on. See `handoff/web-spec.md`.
 */
import DashboardLegacy from "./DashboardLegacy";
import FrontPageDashboard from "./FrontPageDashboard";

const FRONT_PAGE_ENABLED =
  import.meta.env.VITE_FRONT_PAGE_ENABLED === "true" ||
  import.meta.env.VITE_FRONT_PAGE_ENABLED === "1";

export default function Dashboard() {
  if (FRONT_PAGE_ENABLED) {
    return <FrontPageDashboard />;
  }
  return <DashboardLegacy />;
}
