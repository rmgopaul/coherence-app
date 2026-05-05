# Local Dev Pointing at Prod DB — Prod-Mutation Surface Findings

> Concern #4 from the [PRs 366-383 review](https://github.com/rmgopaul/coherence-app/pull/384) recap. Findings only — no fix attempted.
> Author: Claude (investigation). Date: 2026-05-05.

## TL;DR

- **PR #377's `shouldRunSolarRecStartupCleanup` env guard covers only 3 of the prod-mutation write paths a local dev server triggers.** The guard is correct for what it does (gates 3 startup-time housekeeping ops on `RENDER` env or explicit opt-in), but **8 other prod-mutation entry points** are unconditional today.
- **Most-dangerous unconditional path: 3 schedulers boot at every server start.** `startNightlySnapshotScheduler` + `startMonitoringScheduler` + `startDatasetUploadStaleJobSweeper` all start ticking on `pnpm dev` regardless of whether the DB target is local or prod. The monitoring scheduler is the highest-impact: its scheduled tick fetches 17 vendor APIs and writes to `monitoringApiRuns` + `srDsAccountSolarGeneration` + `srDsConvertedReads` for the active scope — including overwriting prod batches if the date matches the schedule.
- **Second class of unconditional path: orphan-batch + monitoring cleanup runs at every start, outside the #377 guard.** `failOrphanedRunningBatches` (lines 165-177 of `server/_core/index.ts`) marks any "running" `MonitoringBatchRun` row left from a prior process as `failed`. A local dev server, on boot, will mark every prod monitoring run that's currently in flight as failed.
- **Third class: every tRPC mutation is unconditional.** Once a user navigates to `localhost:<port>` in their browser, every action they take writes to prod (re-uploads, snapshot saves, settings changes). The user's recent re-upload workflow exercised this path intentionally; the same path can fire unintentionally if a dev forgets they're pointed at prod.
- **Recommended fix shape: a single environment-target check at the boot/auth layer** that:
  1. Detects the `DATABASE_URL` host as prod.
  2. Refuses to start the schedulers + orphan cleanup unless `RENDER` (or explicit `ALLOW_LOCAL_TO_PROD_WRITES=true`) is set.
  3. (Optional / harder) Marks tRPC mutations as either "read-only" or "writes allowed" based on the same gate, so the browser path is also protected.

## Existing guard scope (PR #377)

`server/_core/startupCleanupPolicy.ts`:

```ts
export function shouldRunSolarRecStartupCleanup(env = process.env): boolean {
  const explicitOptIn = env.SOLAR_REC_STARTUP_DB_CLEANUP?.trim().toLowerCase();
  return (
    Boolean(env.RENDER) ||
    explicitOptIn === "1" ||
    explicitOptIn === "true" ||
    explicitOptIn === "yes"
  );
}
```

The guard wraps **only** this block in `server/_core/index.ts:194`:

```ts
if (shouldRunSolarRecStartupCleanup()) {
  void (async () => {
    const { clearOrphanedComputeRunsOnStartup,
            clearOrphanedImportBatchesOnStartup,
            archiveSupersededImportBatchesOnStartup } = await import("../db/solarRecDatasets");
    await clearOrphanedImportBatchesOnStartup();
    await archiveSupersededImportBatchesOnStartup();
    await clearOrphanedComputeRunsOnStartup();
  })();
}
```

3 ops protected. Everything else listed below is NOT protected.

## Inventory of unprotected prod-mutation paths

### A. Always-on at boot (no guard)

| # | Symbol | Location | Mutation |
|---|---|---|---|
| A1 | `startNightlySnapshotScheduler()` | `server/_core/index.ts:157` | Schedules daily personal-app snapshot writes (`dailyReflections`, weekly review insertion). Writes `userInsights` + related tables. |
| A2 | `startMonitoringScheduler()` | `server/_core/index.ts:158` | Schedules monthly solar-rec monitoring runs. **On schedule fire**: hits 17 vendor APIs (uses `solarRecTeamCredentials` for prod tokens), writes `monitoringApiRuns`, `srDsAccountSolarGeneration`, `srDsConvertedReads`, etc. |
| A3 | `startDatasetUploadStaleJobSweeper()` | `server/_core/index.ts:159` | Boot sweep + recurring timer. Marks v2 dataset upload jobs older than the stale threshold as `failed`. **Marks prod's currently-in-flight uploads as failed** if the dev server's "now" disagrees with the upload's `claimedAt`. |
| A4 | `failOrphanedRunningBatches()` (fire-and-forget block) | `server/_core/index.ts:165-177` | Marks every `MonitoringBatchRun` row currently in `running` state as `failed`. **Wipes the in-flight monitoring runs from the prod dashboard's polling.** No env gate. |

### B. Always-on per-tRPC-request (writes triggered by browser)

These only fire when an actual request hits the server. A local dev server with no client connections is dormant. But the moment the operator opens `localhost:<port>` in a browser, every mutation runs against the configured DB.

| # | Surface | Mutation classes |
|---|---|---|
| B1 | tRPC mutations on `server/routers.ts` (personal app) | DropDock items, supplements, habits, health metrics, user insights, weekly reviews, settings, integrations |
| B2 | tRPC mutations on `server/_core/solarRecRouter.ts` + sibling sub-routers | Dataset uploads, schedule B imports, contract scans, DIN scrapes, ABP settlement runs, monitoring scheduler triggers, system-detail edits, permission changes, scope settings |
| B3 | OAuth callback handlers on `server/oauth-routes.ts` | Token refresh writes, integration row upserts, Samsung webhook payload archive (gated by sync-key, not env) |
| B4 | tRPC procs that run cleanup as a side-effect of `read` ops | E.g. `getCsvExportJobStatus` opportunistically fires `sweepStaleAndPruned()` on every status read — DOES mutate `dashboardCsvExportJobs` rows when stale. Local dev hitting prod via the dashboard would prune prod's job rows. |

### C. Periodic timers spawned by request-driven code

| # | Symbol | Location | Mutation |
|---|---|---|---|
| C1 | `setInterval(...)` heartbeat in dashboard CSV export runner | `server/services/solar/dashboardCsvExportJobs.ts:422` | Updates `dashboardCsvExportJobs.claimedAt` every 30 s while a job runs. Only fires AFTER a tRPC mutation kicks off a job; the timer itself is not boot-time. |
| C2 | `setInterval(...)` heartbeat in Tesla Powerhub production-jobs runner | `server/services/solar/teslaPowerhubProductionJobs.ts:430` | Same shape as C1 for `teslaPowerhubProductionJobs`. |
| C3 | `setInterval(...)` jobRunnerState reaper | `server/routers/helpers/jobRunnerState.ts:110` | In-process timer; cleans up local job-runner state. Doesn't touch the DB but does evict local entries. |

C1/C2 are fine — they only run when a job is in flight on this process. C3 is in-memory only.

## Risk gradient

Ordered most → least dangerous if a local dev server points at prod:

1. **A4 — `failOrphanedRunningBatches`.** Unconditional, runs on every server start. Marks every `MonitoringBatchRun.status = 'running'` row as `failed`, instantly. The prod dashboard's monitoring polling will see all in-flight batches collapse to `failed`.
2. **A3 — stale-job sweeper boot run.** Marks v2 upload jobs as failed if their `updatedAt` predates the threshold. On a local dev server's first boot of the day, this can mark a real upload-in-progress as failed mid-stream.
3. **A2 — monitoring scheduler tick.** Doesn't fire on server boot; fires on schedule (per `getMonthlyScheduleTokens()`). But once the local dev server has been running long enough to cross a scheduled tick, it WILL fetch all 17 vendor APIs against prod credentials and write to prod tables.
4. **B-class mutations (browser-driven).** Fires only on actual user action. The user's recent re-upload workflow used this path intentionally; the risk is forgetting which DB target is configured.
5. **B4 — read-time sweeps.** Subtle. Reads to the dashboard CSV export status endpoint mutate the dashboard CSV export jobs table opportunistically.
6. **A1 — nightly snapshot.** Personal-app only; writes Rhett's data. Lowest blast radius (single user).
7. **C-class timers.** Only run when a job is mid-flight on this process; bounded.

## Why PR #377 was correct but incomplete

The 3 ops PR #377 guards (`clearOrphanedComputeRunsOnStartup`, `clearOrphanedImportBatchesOnStartup`, `archiveSupersededImportBatchesOnStartup`) were the immediate trigger for the bug PR #377 fixed (a local dev server marking prod's in-flight Part II compute as orphaned, surfacing as the "Summary unavailable" state in PR #377).

The fix is correct for that specific incident: those 3 ops should be Render-only.

But the same operator ergonomics that made the original bug possible (local dev with prod `DATABASE_URL`) also expose the 4 entry points in section A and the 3+ classes in section B. None of those are protected. The next outage of this class will come from one of them, not from the originally-patched 3 ops.

## Recommended mitigations (sketch only — implementation TBD)

### Mitigation 1: lift the env check to a `runtimeTarget` module

Create `server/_core/runtimeTarget.ts`:

```ts
export type RuntimeTarget = "hosted-prod" | "local-dev" | "test";

export function detectRuntimeTarget(env = process.env): RuntimeTarget {
  if (env.NODE_ENV === "test") return "test";
  if (env.RENDER) return "hosted-prod";
  return "local-dev";
}

export function allowsLocalProdWrites(env = process.env): boolean {
  const explicit = env.ALLOW_LOCAL_TO_PROD_WRITES?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "yes";
}
```

Then gate every entry in section A on `detectRuntimeTarget() === "hosted-prod" || allowsLocalProdWrites()`. `shouldRunSolarRecStartupCleanup` becomes a thin wrapper over the same.

### Mitigation 2: schedule-fire safety net (defense in depth)

Inside `startMonitoringScheduler` itself, guard the actual scheduler tick callback (not just the `start*` registration). Even if a future PR forgets to gate the registration in `startServer()`, the tick callback short-circuits in local-dev unless explicitly opted in. Same shape for `startNightlySnapshotScheduler` and the stale-job sweeper.

### Mitigation 3: DB-level read-only role for local dev (architectural)

Provide a documented `LOCAL_DEV_DATABASE_URL` that points at a TiDB user with `SELECT` only — no `INSERT`, `UPDATE`, `DELETE`. Local dev pointed at this URL can read prod data freely but cannot mutate. This eliminates the entire class without per-write-path gates. Cost: TiDB Cloud user/permission management; not free, but durable.

### Mitigation 4: detect-and-warn (fast, low-leverage)

On boot, if `detectRuntimeTarget() === "local-dev"` AND the configured `DATABASE_URL` host matches a known prod cluster (e.g., `*.tidbcloud.com`), log a loud `console.warn` banner and require an explicit `--allow-prod-writes` CLI flag. Doesn't block — but reduces accidental mutation.

## Open questions for the operator

1. **Acceptable to require `RENDER` env or explicit opt-in for ALL section-A schedulers?** This mirrors PR #377's pattern but applied broadly. Tradeoff: local dev would no longer auto-sweep stale upload jobs even on intentional dev-against-local-DB workflows. Mitigated by `ALLOW_LOCAL_TO_PROD_WRITES=true` opt-in env.
2. **Is a read-only TiDB user feasible for the team's prod cluster?** TiDB Cloud serverless supports user creation; the question is whether the operator wants to manage another credential. Highest-leverage long-term fix if yes.
3. **Should B-class (tRPC mutations) be guarded too?** Realistically no — local dev pointing at prod is the user's chosen workflow when intentional (e.g., debugging an aggregator against real data). Gating tRPC mutations would break that. The defense should remain at the schedulers + boot-time housekeeping.

## Suggested fix sequence (post-acknowledgment)

1. **Implementation PR 1: `runtimeTarget` module + lift `shouldRunSolarRecStartupCleanup` to use it.** Pure refactor, no behavior change. Establishes the canonical gate.
2. **Implementation PR 2: gate the 3 always-on schedulers + `failOrphanedRunningBatches` block on `runtimeTarget`.** This closes the highest-risk paths (A1-A4).
3. **Implementation PR 3 (optional, follow-up): in-tick safety net** for each scheduler. Cheap, narrow, defends against future registration regressions.
4. **Implementation PR 4 (optional, requires operator action): TiDB read-only user + documented `LOCAL_DEV_DATABASE_URL`.** Long-term durable fix.

Each PR is independent — do not require sequencing if priorities shift.
