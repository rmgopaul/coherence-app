/**
 * Runtime-target detection — what kind of environment is this
 * Node process running in?
 *
 * Concern #4 from the PRs 366-383 review (findings doc:
 * `docs/triage/local-dev-prod-mutation-findings.md`): a local dev
 * server pointed at the prod `DATABASE_URL` can mutate prod state
 * through 8+ entry points the existing `shouldRunSolarRecStartupCleanup`
 * env guard does not cover. This module is the canonical "where am
 * I?" check that future fix-sequence PRs build on:
 *
 *   - PR-1 (this file) — establish the module + lift
 *     `shouldRunSolarRecStartupCleanup` to use it. Pure refactor;
 *     no behavior change.
 *   - PR-2 — gate `failOrphanedRunningBatches` + the 3 schedulers
 *     in `startServer()` on the same predicate. Behavior change;
 *     requires operator acknowledgment of the findings doc's
 *     open questions.
 *   - PR-3 — in-tick safety net inside each scheduler.
 *   - PR-4 — TiDB read-only role for `LOCAL_DEV_DATABASE_URL`
 *     (architectural).
 *
 * Detection rules (cheap and explicit; no DB host parsing):
 *   - `NODE_ENV === "test"` → `"test"`. Matches vitest runs and
 *     any explicit `NODE_ENV=test` boot.
 *   - `RENDER` truthy → `"hosted-prod"`. Render injects this on
 *     every container. Other hosting providers (Fly, Railway) can
 *     opt in via the `ALLOW_LOCAL_TO_PROD_WRITES` flag.
 *   - else → `"local-dev"`.
 *
 * The env-arg form is for testability (and for callers that need to
 * detect against a non-`process.env` source — e.g. a request-scoped
 * shim). All call sites should default to `process.env`.
 */
export type RuntimeTarget = "hosted-prod" | "local-dev" | "test";

type RuntimeEnv = Record<string, string | undefined>;

export function detectRuntimeTarget(
  env: RuntimeEnv = process.env
): RuntimeTarget {
  if (env.NODE_ENV === "test") return "test";
  if (env.RENDER) return "hosted-prod";
  return "local-dev";
}

/**
 * Explicit opt-in for local-dev processes that DO want to mutate
 * prod state (e.g., the operator running a backfill script against
 * `DATABASE_URL=prod` from local). Truthy values: `1`, `true`,
 * `yes` (case-insensitive, trimmed). Anything else — including
 * unset — returns `false`.
 *
 * Companion to `detectRuntimeTarget`: a caller that wants to write
 * to prod from local-dev should check
 * `detectRuntimeTarget(env) === "hosted-prod" || allowsLocalProdWrites(env)`.
 *
 * Same truthy-value semantics as the legacy
 * `SOLAR_REC_STARTUP_DB_CLEANUP` env var so existing operator
 * scripts keep working.
 */
export function allowsLocalProdWrites(
  env: RuntimeEnv = process.env
): boolean {
  const raw = env.ALLOW_LOCAL_TO_PROD_WRITES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Convenience: should this process mutate prod state at all?
 *
 *   - hosted-prod (Render): yes.
 *   - local-dev with explicit opt-in: yes.
 *   - local-dev without opt-in: no.
 *   - test: no — vitest runs are pure-function only and never
 *     mutate any DB; if a future test needs to hit a real DB, the
 *     test should set `ALLOW_LOCAL_TO_PROD_WRITES=true` and a
 *     separate `LOCAL_DEV_DATABASE_URL`.
 */
export function shouldMutateProdState(
  env: RuntimeEnv = process.env
): boolean {
  if (detectRuntimeTarget(env) === "hosted-prod") return true;
  if (detectRuntimeTarget(env) === "test") return false;
  return allowsLocalProdWrites(env);
}

/**
 * In-tick safety net for prod-mutating scheduler callbacks
 * (Concern #4 PR-3, defense in depth).
 *
 * Returns `true` if the tick may proceed; returns `false` (after
 * logging once per scheduler-name per process) if the tick should
 * short-circuit because this process is not authorised to mutate
 * prod state.
 *
 * The boot-time gate in `startServer()` (PR-2) already prevents
 * the schedulers from being registered at all on local-dev
 * without `ALLOW_LOCAL_TO_PROD_WRITES`. This per-tick guard is
 * the second layer: even if a future PR accidentally registers a
 * scheduler outside the boot-time gate, the tick callback will
 * still short-circuit. Each scheduler-name logs at most once per
 * process to keep log volume bounded for chatty schedulers (e.g.
 * the dataset-upload sweeper firing every 5 min).
 *
 * Usage:
 *   async function tick(...) {
 *     if (!schedulerTickAllowed("monitoring-batch")) return;
 *     // ...mutations
 *   }
 */
const _schedulerSkipLogged = new Set<string>();

export function schedulerTickAllowed(
  schedulerName: string,
  env: RuntimeEnv = process.env
): boolean {
  if (shouldMutateProdState(env)) return true;
  if (!_schedulerSkipLogged.has(schedulerName)) {
    _schedulerSkipLogged.add(schedulerName);
    // eslint-disable-next-line no-console
    console.warn(
      `[runtimeTarget] In-tick safety net engaged for scheduler ` +
        `'${schedulerName}' — process is not in hosted-prod and ` +
        `ALLOW_LOCAL_TO_PROD_WRITES is not set. Skipping this tick ` +
        `(and any future ticks). Logged once per process.`
    );
  }
  return false;
}

/**
 * Test-only: reset the per-scheduler logged-once memo. Lets each
 * test assert its own log line without leaking state across the
 * suite. Not exported from the public surface (callers shouldn't
 * need this in production).
 */
export function __resetSchedulerSkipLoggedForTests(): void {
  _schedulerSkipLogged.clear();
}
