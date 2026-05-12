/**
 * Regression rail for the 2026-05-12 incident.
 *
 * `server/_core/index.ts` mounts `solarRecAppRouter` on
 * `/solar-rec/api/trpc/*` via a dispatcher that consults
 * `SOLAR_REC_ROUTER_ROOTS` to decide whether a given request belongs
 * to the solar-rec router or should fall through to the main app
 * router. When the allowlist drifts from the router definition
 * (i.e. a new sub-router lands in `solarRecAppRouter` but the
 * allowlist isn't updated), every request to the missing root
 * silently 404s with "No procedure found on path …" because the
 * dispatcher forwards it to the main router, which has no idea what
 * it is.
 *
 * That's exactly how `jobs.getJobsIndex` (added in PR #167), plus
 * `systems.*` and `worksets.*`, ended up un-routable on prod despite
 * being correctly mounted in `solarRecAppRouter`. Boot-time
 * assertion in `_core/index.ts` is the runtime guard; this test is
 * the CI guard so the failure surfaces before deploy.
 */

import { describe, it, expect } from "vitest";
import { solarRecAppRouter } from "./solarRecRouter";

// Re-implement the parse here so this test doesn't import
// `_core/index.ts` (which has side effects: starts a server).
function extractTopLevelRouterRoots(router: unknown): Set<string> {
  const procedures =
    (router as { _def?: { procedures?: Record<string, unknown> } })._def
      ?.procedures ?? {};
  const roots = new Set<string>();
  for (const path of Object.keys(procedures)) {
    const root = path.split(".")[0];
    if (root) roots.add(root);
  }
  return roots;
}

// Mirror of `SOLAR_REC_ROUTER_ROOTS` in `server/_core/index.ts`. If
// you bump one, bump the other; if a future refactor extracts the
// constant to a shared module, import it here instead of duplicating.
const SOLAR_REC_ROUTER_ROOTS_MIRROR = new Set([
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

describe("SOLAR_REC_ROUTER_ROOTS dispatcher allowlist", () => {
  it("includes every top-level key of solarRecAppRouter", () => {
    const routerRoots = extractTopLevelRouterRoots(solarRecAppRouter);
    const missingFromAllowlist: string[] = [];
    routerRoots.forEach((root) => {
      if (!SOLAR_REC_ROUTER_ROOTS_MIRROR.has(root))
        missingFromAllowlist.push(root);
    });
    expect(missingFromAllowlist.sort()).toEqual([]);
  });

  // Inverse check — guards against the mirror getting out of sync with
  // the production allowlist. If a root is removed from the router
  // (e.g. a sub-router moves to a new path), the allowlist should
  // shed it too; otherwise it's vestigial noise.
  it("does not list roots that no longer exist on solarRecAppRouter", () => {
    const routerRoots = extractTopLevelRouterRoots(solarRecAppRouter);
    const vestigial: string[] = [];
    SOLAR_REC_ROUTER_ROOTS_MIRROR.forEach((root) => {
      if (!routerRoots.has(root)) vestigial.push(root);
    });
    expect(vestigial.sort()).toEqual([]);
  });
});
