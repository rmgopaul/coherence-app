/**
 * Dashboard — front-page layout (post-Phase-B).
 *
 * Renders `FrontPageDashboard` directly. The legacy view (kept
 * behind a `VITE_FRONT_PAGE_ENABLED` feature flag during the Phase B
 * rollout) was retired on 2026-04-28 once the team confirmed nobody
 * was hitting `/dashboard-legacy` anymore. The flag, the legacy
 * file, and the legacy route in `App.tsx` were all removed in the
 * same change. See `docs/execution-plan.md` Phase E backlog
 * "Retire `DashboardLegacy.tsx`".
 */
import FrontPageDashboard from "./FrontPageDashboard";

export default function Dashboard() {
  return <FrontPageDashboard />;
}
