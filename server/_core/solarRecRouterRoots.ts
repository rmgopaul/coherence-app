/**
 * Single source of truth for the `/solar-rec/api/trpc/*` dispatcher
 * allowlist + the regression rail that keeps it honest.
 *
 * The dispatcher in `_core/index.ts` consults `SOLAR_REC_ROUTER_ROOTS`
 * on every request to decide whether the call belongs to
 * `solarRecAppRouter` or should fall through to the main `appRouter`.
 * When the allowlist drifts from the actual router definition (a new
 * sub-router lands in `solarRecAppRouter` but the allowlist isn't
 * updated), every request to the missing root silently 404s with
 * "No procedure found on path …" because the dispatcher forwards it
 * to the main router, which has no idea what it is.
 *
 * Keep this Set in sync with the top-level keys of
 * `solarRecAppRouter` in `solarRecRouter.ts`. The boot-time assertion
 * below + the vitest at `solarRecRouterRootsAllowlist.test.ts` will
 * yell if you forget.
 *
 * HISTORY (kept here for institutional context — every entry is a
 * past failure mode worth remembering):
 *
 *   2026-04-10: "solarRecDashboard" was removed from this set because
 *     the in-_core dashboardRouter was dead code — no client called
 *     `solarRecTrpc.solarRecDashboard.*`. Legacy traffic to
 *     `/solar-rec/api/trpc/solarRecDashboard.*` fell through to the
 *     main router (the live copy at the time).
 *   2026-04-15: "auth" and "enphaseV2" removed alongside their dead
 *     sub-routers. Main-app pages use the main appRouter's auth /
 *     enphaseV2 routers via the primary trpc client, not solarRecTrpc.
 *   2026-04-26 (Task 5.5): "solarRecDashboard" RE-ADDED. The router
 *     migrated from `server/routers/solarRecDashboard.ts` to
 *     `server/_core/solarRecDashboardRouter.ts` and is now composed
 *     into `solarRecAppRouter` with `requirePermission(
 *     "solar-rec-dashboard", level)`. The old main-router mount was
 *     removed; main-app `/api/trpc/solarRecDashboard.*` requests
 *     would now 404. The legacy `/solar-rec-dashboard` URL on
 *     App.tsx has been retired in favor of `/solar-rec/dashboard`
 *     on SolarRecApp.tsx.
 *   2026-05-12: "jobs" (PR #167, 2026-04-27), "systems" (PR #171,
 *     2026-04-27), and "worksets" (PR #173, 2026-04-27) were added
 *     to `solarRecAppRouter` but never to this set — every request
 *     to those roots silently 404'd for ~2 weeks until the Jobs
 *     Index page surfaced the failure. Drift = silent 404. The
 *     `assertSolarRecRouterRootsInSync` rail + the unit test were
 *     added in the same fix to prevent recurrence.
 */

import type { AnyRouter } from "@trpc/server";

export const SOLAR_REC_ROUTER_ROOTS = new Set<string>([
  "users",
  "credentials",
  "monitoring",
  "permissions",
  "generac",
  "solis",
  "goodwe",
  "hoymiles",
  "locus",
  "apsystems",
  "solarlog",
  "growatt",
  "ekm",
  "fronius",
  "ennexos",
  "enphaseV4",
  "solaredge",
  "teslaPowerhub",
  "sunpower",
  "egauge",
  "solarRecDashboard",
  "contractScan",
  "zendesk",
  "abpSettlement",
  "csgPortal",
  "dinScrape",
  "jobs",
  "systems",
  "worksets",
]);

/**
 * Extract the top-level root segment of every procedure path on a
 * tRPC v11 router. The router stores its full dotted procedure paths
 * under `_def.procedures` (e.g. `"solarRecDashboard.getDashboardSummary"`);
 * the root is the segment before the first `.`.
 */
export function extractTopLevelRouterRoots(router: AnyRouter): Set<string> {
  const procedures = router._def.procedures ?? {};
  const roots = new Set<string>();
  for (const path of Object.keys(procedures)) {
    const root = path.split(".")[0];
    if (root) roots.add(root);
  }
  return roots;
}

/**
 * Boot-time assertion: fail loud if `SOLAR_REC_ROUTER_ROOTS` is
 * missing any top-level root that exists on the router. Throw is
 * deliberate — Render's health check will fail and the deploy
 * rolls back, which is louder (and safer) than a silent 404 in
 * production.
 *
 * `_core/index.ts` invokes this at module load with
 * `solarRecAppRouter` as the argument; the unit test invokes it
 * with the same router to catch drift in CI before deploy.
 */
export function assertSolarRecRouterRootsInSync(router: AnyRouter): void {
  const routerRoots = extractTopLevelRouterRoots(router);
  const missing: string[] = [];
  routerRoots.forEach((root) => {
    if (!SOLAR_REC_ROUTER_ROOTS.has(root)) missing.push(root);
  });
  if (missing.length > 0) {
    throw new Error(
      `SOLAR_REC_ROUTER_ROOTS is missing top-level solarRecAppRouter ` +
        `keys: ${missing.sort().join(", ")}. Add them to the Set in ` +
        `server/_core/solarRecRouterRoots.ts (the source of truth). ` +
        `The dispatcher in server/_core/index.ts uses this Set to ` +
        `route /solar-rec/api/trpc/* — drift = silent 404.`
    );
  }
}
