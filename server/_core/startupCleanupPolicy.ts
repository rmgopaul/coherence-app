/**
 * Should the Solar REC startup-time housekeeping (orphaned compute
 * runs, orphaned import batches, superseded-batch archive) actually
 * run on this process?
 *
 * Now delegates to the canonical `runtimeTarget` module
 * (`./runtimeTarget`) so the gate is consistent with the rest of
 * the Concern #4 fix sequence. The legacy
 * `SOLAR_REC_STARTUP_DB_CLEANUP` env var is preserved as an
 * additional opt-in path — operators with existing scripts that
 * set it keep working unchanged.
 *
 * Truthy paths:
 *   - `RENDER` env truthy (canonical hosted-prod marker) → true
 *   - `ALLOW_LOCAL_TO_PROD_WRITES=true|yes|1` (canonical
 *     local-dev opt-in) → true
 *   - `SOLAR_REC_STARTUP_DB_CLEANUP=true|yes|1` (legacy opt-in,
 *     same truthy semantics) → true
 *   - else → false
 *
 * Test runs (`NODE_ENV=test`) return false unless one of the
 * opt-in flags is also set; vitest runs never trip this gate.
 */
import { detectRuntimeTarget, allowsLocalProdWrites } from "./runtimeTarget";

type StartupCleanupEnv = Record<string, string | undefined>;

export function shouldRunSolarRecStartupCleanup(
  env: StartupCleanupEnv = process.env
): boolean {
  if (detectRuntimeTarget(env) === "hosted-prod") return true;
  if (allowsLocalProdWrites(env)) return true;

  // Legacy opt-in path — kept for back-compat with operator
  // scripts that already set this var. New code should prefer
  // `ALLOW_LOCAL_TO_PROD_WRITES`.
  const legacy = env.SOLAR_REC_STARTUP_DB_CLEANUP?.trim().toLowerCase();
  return legacy === "1" || legacy === "true" || legacy === "yes";
}
