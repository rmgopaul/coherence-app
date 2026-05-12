/**
 * Regression rail for the 2026-05-12 incident.
 *
 * `server/_core/index.ts` mounts `solarRecAppRouter` on
 * `/solar-rec/api/trpc/*` via a dispatcher that consults
 * `SOLAR_REC_ROUTER_ROOTS` (defined in `./solarRecRouterRoots.ts`)
 * to decide whether a given request belongs to the solar-rec router
 * or should fall through to the main app router. When the allowlist
 * drifts from the router definition (a new sub-router lands in
 * `solarRecAppRouter` but the allowlist isn't updated), every
 * request to the missing root silently 404s with "No procedure
 * found on path …" because the dispatcher forwards it to the main
 * router, which has no idea what it is.
 *
 * That's exactly how `jobs.getJobsIndex` (added in PR #167), plus
 * `systems.*` and `worksets.*`, ended up un-routable on prod despite
 * being correctly mounted in `solarRecAppRouter`. The boot-time
 * assertion in `solarRecRouterRoots.ts` is the runtime guard; this
 * test is the CI guard so the failure surfaces before deploy.
 *
 * Imports the real `SOLAR_REC_ROUTER_ROOTS` (no local mirror) so a
 * future contributor can only break the contract by bumping the
 * router without bumping the allowlist — there's nowhere to "forget
 * to update the mirror" anymore.
 */

import { describe, it, expect } from "vitest";
import { solarRecAppRouter } from "./solarRecRouter";
import {
  SOLAR_REC_ROUTER_ROOTS,
  extractTopLevelRouterRoots,
  assertSolarRecRouterRootsInSync,
} from "./solarRecRouterRoots";

describe("SOLAR_REC_ROUTER_ROOTS dispatcher allowlist", () => {
  it("includes every top-level key of solarRecAppRouter", () => {
    const routerRoots = extractTopLevelRouterRoots(solarRecAppRouter);
    const missingFromAllowlist: string[] = [];
    routerRoots.forEach((root) => {
      if (!SOLAR_REC_ROUTER_ROOTS.has(root)) missingFromAllowlist.push(root);
    });
    expect(missingFromAllowlist.sort()).toEqual([]);
  });

  // Inverse check — guards against the allowlist getting out of sync
  // with the router in the OTHER direction. If a root is removed
  // from the router (e.g. a sub-router moves to a new path), the
  // allowlist should shed it too; otherwise it's vestigial noise.
  it("does not list roots that no longer exist on solarRecAppRouter", () => {
    const routerRoots = extractTopLevelRouterRoots(solarRecAppRouter);
    const vestigial: string[] = [];
    SOLAR_REC_ROUTER_ROOTS.forEach((root) => {
      if (!routerRoots.has(root)) vestigial.push(root);
    });
    expect(vestigial.sort()).toEqual([]);
  });

  // Round-trip the boot-time assertion to confirm it doesn't throw
  // against the current router. If a contributor bumps the router
  // and forgets the allowlist, this is the test that will fail.
  it("assertSolarRecRouterRootsInSync passes against the current router", () => {
    expect(() => assertSolarRecRouterRootsInSync(solarRecAppRouter)).not.toThrow();
  });
});
