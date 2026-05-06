# Phase 5e handoff — Solar REC Dashboard refactor continuation

> **Written:** 2026-04-29 end of session, by Claude Opus 4.7 (1M context).
> **Audience:** the next Claude session (Opus 4.7 + 1M ctx).
> **Tone:** assume the reader has read `CLAUDE.md` and skimmed
> `docs/server-side-dashboard-refactor.md`. This file fills in
> the on-the-ground state at the moment Phase 5e shipped, the
> open follow-ups, and the gotchas that bit me.

---

## Read order before touching anything

1. `CLAUDE.md` — especially "READ THIS FIRST" (dual-router boundary)
   and "READ THIS SECOND" (verification + tooling).
2. `docs/server-side-dashboard-refactor.md` — the plan of record.
3. `docs/server-routing.md` — URL → router file map.
4. This file.

If any of those contradict each other, the file later in this list
is older. As of 2026-04-29, the canonical state is what `CLAUDE.md`
last said (it was refreshed in PR #277).

---

## Where we are: 9 PRs shipped this session (#271–#279)

### The Phase 5d salvage trio (already merged)

PR #267 was a 4-files-at-once "Phase 5d PR 4" that the user reverted
27 minutes after merge because it shipped 4 unrelated changes
together. I split the salvage into three independent PRs:

| PR | What it does |
|---|---|
| **#271** "Salvage A — hoist helpers" | +395 LOC additive. Moved `PerformanceSourceRow`, `ScheduleYearEntry`, `RecPerformanceThreeYearValues` types, `parseDateOnlineAsMidMonth`, `resolveLastMeterReadRawValue`, `buildAnnualProductionByTrackingId`, `buildGenerationBaselineByTrackingId`, `buildGeneratorDateOnlineByTrackingId`, `buildDeliveryYearLabel`, `buildRecReviewDeliveryYearLabel`, `deriveRecPerformanceThreeYearValues`, `buildScheduleYearEntries`, plus three private constants, into `shared/solarRecPerformanceRatio.ts`. Server `loadPerformanceRatioInput.ts` keeps re-exports for back-compat. |
| **#272** "Salvage B — drop fallback memos" | −661 LOC. Removed `_clientFallbackPerformanceRatioResult`, `_clientFallbackForecastProjections`, `_clientFallbackFinancialProfitData` plus 6 props from `<PerformanceRatioTabLazy>`, 4 from `<ForecastTabLazy>`, parent's `generatorDateOnlineByTrackingId` / `portalMonitoringCandidates` / `performanceRatioMatchIndexes` / `deferredConvertedReads`. Client tabs read exclusively from `getDashboardPerformanceRatio` / `getDashboardForecast` / `getDashboardFinancials` queries from PRs #263 / #265 / #266. |
| **#273** "Salvage C — Schedule B auto-apply hybrid" | +53 LOC. Made the auto-apply effect in `ScheduleBImport.tsx` write to BOTH the server (via `applyScheduleBToDeliveryObligations.mutateAsync`) AND the client `datasets.deliveryScheduleBase.rows` (via `onApply(rows)`). Populates `lastServerApply` so the user sees the receipt panel update. **Hybrid kept on purpose** — `performanceSourceRows` was still client-only and would have gone stale. PR #278 made it server-only, so the `onApply` side effect can now be dropped (see Followup #1 below). |

### Phase 5e cleanup sweep (already merged)

| PR | What it does |
|---|---|
| **#274** "PR D — drop spine-helper duplicates" | −190 LOC. Replaced byte-identical bodies in `client/src/solar-rec-dashboard/lib/helpers/{system,recPerformance}.ts` with re-exports from `@shared/solarRecPerformanceRatio`. Kept client-local: `resolveContractValueAmount`/`resolveValueGapAmount` (depend on client `SystemRecord`), `buildDeliveryYearLabel`/`buildRecReviewDeliveryYearLabel` (intentional locale-formatted vs ISO fallback divergence — see Followup #6 below if you ever want to unify). |
| **#275** "PR E — delete IDB-serialization chain + lazyDataset" | −491 LOC. Whole `client/src/solar-rec-dashboard/lib/lazyDataset.ts` (172 LOC) + `lazyDataset.test.ts` (145 LOC) DELETED. From `SolarRecDashboard.tsx`: `SerializedCsvDataset` + `SerializedDatasetsManifest` types, `deserializeDatasetRecord`/`deserializeDatasets`/`serializeDatasetRecord`/`serializeDatasets`/`loadLegacyDatasetsFromLocalStorage` functions. From `constants.ts`: `LEGACY_DATASETS_STORAGE_KEY` + 6 `DASHBOARD_DB_*` keys. From `hydrationErrors.ts`: `HYDRATE_LOG_PREFIX_IDB`. All transitively dead post-Phase-5a/b/c. |
| **#276** "PR F — drop orphaned tracking-ID memos" | −8 LOC. The parent's `annualProductionByTrackingId` and `generationBaselineByTrackingId` useMemos went orphaned when Salvage B dropped their consumer props. tsc didn't catch them because variable declarations without reads are legal. Also dropped the now-unused `isPerformanceRatioTabActive` flag and 4 imports. |
| **#277** docs PR | +35 / −10. CLAUDE.md refresh — bumped "Last updated", expanded the "Solar REC Dashboard data flow" section header to mention Phases 5d + 5e, added 3 rows to the "Tabs migration" table, added two paragraphs summarizing the Salvage trio + dead-code sweep. |
| **#278** "PR H — performanceSourceRows server aggregator" | +658 / −110. THE Phase 5e core. New `server/services/solar/buildPerformanceSourceRows.ts` (pure aggregator + `getOrBuildPerformanceSourceRows` cache wrapper, superjson serde), 10-test `.test.ts`, new `getDashboardPerformanceSourceRows` proc on `solarRecDashboardRouter.ts`, `SnapshotSystem.systemName: string` field added to `aggregatorHelpers.ts`. Client `SolarRecDashboard.tsx`: replaced the `performanceSourceRows` useMemo with a tab-gated `useQuery` + `EMPTY_PERFORMANCE_SOURCE_ROWS` singleton, dropped 3 orphaned upstream memos (`eligibleTrackingIds`, parent `systemsByTrackingId`, local `buildScheduleYearEntries`). |
| **#279** "PR I — transferLookup case-sensitivity fix" | +105 / −33. Latent prod bug fix flagged in #278's body. `getDeliveredForYear` in `aggregatorHelpers.ts` now lowercases `trackingId` internally — the server payload is built with lowercase keys (`buildTransferDeliveryLookup.ts:242`) but 3 aggregators were passing raw mixed-case row data and silently returning 0 deliveries on every match in production. Bumped 4 runner versions to invalidate caches: `CONTRACT_VINTAGE_RUNNER_VERSION` @1→@2, `FORECAST_RUNNER_VERSION` `phase-5d-pr2-forecast@1`→`@2`, `TREND_DELIVERY_PACE_RUNNER_VERSION` @1→@2, `PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION` @1→@2. Test fixtures across contract-vintage, trend-delivery-pace, aggregatorHelpers updated to use lowercase keys (matches prod). New regression test `is case-insensitive on the trackingId` in `aggregatorHelpers.test.ts`. **Deploy carefully** — the recompute will produce different numbers from currently-cached zeros. |

**Cumulative session impact:** 9 PRs, **net −107 LOC** (−902 cleanup,
+795 from #278's additive aggregator + #279's regression-test fix),
while shipping 1 user-facing feature (Schedule B server-write hybrid),
1 architectural migration (`performanceSourceRows` server-driven),
1 silent-prod-bug correctness fix (transferLookup case mismatch).

---

## Followups (priority order)

### #1 — Drop ScheduleBImport's `onApply` client write (collapse the hybrid)

**Status:** Was unblocked by PR #278. Was deferred from PR #273
deliberately because `performanceSourceRows` was client-only at the
time.

**What to change:**

`client/src/solar-rec-dashboard/components/ScheduleBImport.tsx` —
both the auto-apply effect (around L504–L597 — search for
"Hybrid auto-apply") AND the manual `handleApply` (around L881)
currently call `onApply(rows)` to keep `datasets.deliveryScheduleBase.rows`
fresh in the parent's React state.

**The blocker:** there are still TWO consumers of
`datasets.deliveryScheduleBase.rows` in `SolarRecDashboard.tsx`:

1. `existingDeliverySchedule={datasets.deliveryScheduleBase?.rows ?? null}`
   — prop pass-through to `<ScheduleBImport>` itself, used to render
   "Dataset has: N rows" on the card. Trivially replaceable with
   `getDatasetSummariesAll`'s rowCount or a new
   `getDashboardDeliveryScheduleSummary` query.
2. The CSV merge upload handler (~L6618 — search for
   "beforeRowCount = datasets.deliveryScheduleBase"). This walks
   `datasets.deliveryScheduleBase?.rows` to merge against existing
   rows when the user uploads a delivery-schedule CSV directly.
   This is the harder one — the merge logic needs the full
   row set, not just a count.

**Recommended approach:**

Two-step migration:

1. **Step 1** — Replace card display + `existingDeliverySchedule`
   prop with row count from `getDatasetSummariesAll`. This is
   small and ships independently. After this, `datasets.deliveryScheduleBase.rows`
   only has one consumer (the CSV merge handler).

2. **Step 2** — Migrate the CSV merge handler to fetch the existing
   rows from server on demand (e.g. via `getDatasetRowsPage`). For
   full user downloads, use `startDashboardCsvExport({ exportType:
   "datasetCsv" })`. Then drop `onApply` from both auto-apply and
   `handleApply`. Drop the parent's `setDatasets` calls for
   `deliveryScheduleBase`.

Don't try to do both steps in one PR. Step 2 has subtle
correctness implications (the merge dedup logic uses a custom
`makeDeliveryRowKey` against in-memory rows; switching to async
server reads changes the timing).

### #2 — Forecast aggregator: replace its private `buildPerformanceSourceRows` with import from the new shared module

**Status:** ✅ DONE 2026-04-29 in [#281](https://github.com/rmgopaul/coherence-app/pull/281).

`server/services/solar/buildForecastAggregates.ts` has a private
`buildPerformanceSourceRows` (around L141–L220) that's now
duplicated in `server/services/solar/buildPerformanceSourceRows.ts`
(PR #278). The two are functionally identical at the row-build
level. The Forecast version uses its own `SnapshotSystemForForecast`
type which is a strict subset of `SnapshotSystem` (no
`stateApplicationRefId`).

**What to change:**

1. `import { buildPerformanceSourceRows } from "./buildPerformanceSourceRows";`
2. Delete the private function in Forecast.
3. The caller in Forecast at L586+ already calls
   `extractSnapshotSystems(snapshot.systems)` for eligibility —
   reuse that for the `systemsByTrackingId` map too (instead of
   the inline validator at L540–L568).
4. Bump `FORECAST_RUNNER_VERSION` `@2`→`@3` (the consolidation
   doesn't change behavior post-#279, but the cache key bundles
   the version — bump for traceability).

### #3 — Force-Load multi-append skip cleanup

**Status:** ✅ DONE 2026-04-29 in [#283](https://github.com/rmgopaul/coherence-app/pull/283) (path b — dropped `accountSolarGeneration`/`transferHistory` from tab priority lists) and [#287](https://github.com/rmgopaul/coherence-app/pull/287) (dropped `convertedReads` once SystemDetailSheet migrated in [#286](https://github.com/rmgopaul/coherence-app/pull/286)).

`SolarRecDashboard.tsx :: MULTI_APPEND_DATASET_KEYS` is
`new Set(["accountSolarGeneration", "convertedReads", "transferHistory"])`.
The set is used in 3 places:

1. **Append-mode upload validation** (~L2595) — verify the latest
   manifest before merging on append. Genuine append-mode logic.
2. **Cloud-fallback hydration multi-source dedup** (~L4321) —
   special handling for these 3 datasets which can have multiple
   source files. Genuine multi-append logic.
3. **Force-Load skip** (~L4505) — the 502 / OOM hotfix. Skips
   downloading these 3 during force-load.

After PRs #272, #273, #276, #278, the only client-side row reader
for any of these 3 is `SystemDetailSheet`, which reads
`convertedReads.rows` for the per-system "Recent Meter Reads"
table. Two of the three (`accountSolarGeneration`, `transferHistory`)
have ZERO remaining client row consumers.

**Two paths:**

(a) **Remove `accountSolarGeneration` + `transferHistory` from the
skip set.** Force-load downloads them but nothing reads them →
wasted bandwidth. No behavior change.

(b) **Exclude them from `keysToLoad` entirely** (in the cloud-fallback
hydration pipeline). Saves the bandwidth. Risk: a future
consumer assumes the dataset is in `datasets[k]` and finds it
missing.

I lean toward (b) but only AFTER you grep the entire
`client/src/solar-rec-dashboard/` tree one more time for
`datasets.accountSolarGeneration` / `datasets.transferHistory`
reads (excluding useMemo dep arrays — those are slot-existence
checks, harmless when slot is always undefined).

`convertedReads` MUST stay in the skip set until SystemDetailSheet
migrates to a server query (`getSystemRecentMeterReads(systemKey)`).

### #4 — Cloud-fallback hydration path retirement (the big one)

**Status:** Steps 1–3 shipped. Step 4 (the actual delete) is **NOT
unblocked yet** — a 2026-04-30 re-audit found three additional
client-side memo chains that still read `datasets[k].rows`. The
original handoff missed them. See the audit table below for what's
left.

`SolarRecDashboard.tsx` has ~500 LOC of cloud-fallback hydration
logic (`loadRemoteDatasets`, `deserializeRemoteDatasetPayload`,
the per-tab priority loaders, the chunk-pointer reassembly,
`HYDRATE_LOG_PREFIX_CLOUD`). This path is what populates
`datasets[k]` from the chunked-CSV blob storage when the user
either:

- Clicks Force Load All, OR
- Activates a tab whose
  `TAB_PRIORITY_DATASETS` mapping includes a dataset that
  hasn't been loaded yet.

#### Step status

1. ✅ Empty-state checks driven by summaries — [#285](https://github.com/rmgopaul/coherence-app/pull/285)
2. ✅ SystemDetailSheet's recent reads via server query — [#286](https://github.com/rmgopaul/coherence-app/pull/286)
3. ✅ Followup #1 step 2 — `onApply` parallel client merge dropped — [#290](https://github.com/rmgopaul/coherence-app/pull/290)
4. 🚧 **Blocked.** Three more client-row-reader chains discovered in the 2026-04-30 audit (below). Each is its own PR.

#### Remaining `datasets[k].rows` consumers (2026-04-30 audit)

| Chain | Source | Tab/consumer | Server equivalent | Migration shape |
|---|---|---|---|---|
| `part2VerifiedAbpRows` (+~20 downstream memos) | `datasets.abpReport.rows` (`SolarRecDashboard.tsx:2918`) | Many — eligibility maps, summary, application-pipeline derivations, OfflineMonitoring chain | Partial — `buildPart2EligibilityMaps` (server) covers the eligibility set; downstream client derivations don't have direct server equivalents yet | Heavy. Migrate downstream consumers tab-by-tab; the memo can only retire when its last client reader is gone. |
| `monitoringDetailsBySystemKey` | `datasets.solarApplications.rows` (`SolarRecDashboard.tsx:3568`) | OfflineMonitoringTab | Yes — `buildMonitoringDetailsBySystemKey` already on server in `loadPerformanceRatioInput.ts:175` | Add `getDashboardOfflineMonitoring` aggregator returning the 4 tab inputs; drop client memos. ~250 LOC. **Smallest wedge — recommended next.** |
| `financialCsgIds` + `financialProfitDebug` | `datasets.abpCsgSystemMapping.rows` + `datasets.abpIccReport3Rows.rows` (`SolarRecDashboard.tsx:5443` + `:5577`) | FinancialsTab | Partial — `getDashboardFinancials` (#266) exists; these two memos drive a `contractScanResults` query + a debug panel that aren't covered | Extend `getDashboardFinancials` (or add a sibling proc) to surface the CSG-ID list + profit-debug aggregate. ~150 LOC. |

The empty-state checks were already migrated to `getDatasetSummariesAll`
counts in #285. Per-card slot-existence reads
(`!datasets.x ? "Not uploaded" : ...`) come from the summaries
query, not from cloud-fallback hydration.

Once the three chains above are server-backed, the entire
cloud-fallback hydration pipeline can be deleted. Probably another
400+ LOC reduction plus a `parseCsvFileAsync` / `parseCsvTextAsync`
cleanup.

**Don't try to do this in one PR.** Updated stage list:
1. ✅ Migrate empty-state checks to summaries query (#285)
2. ✅ Migrate SystemDetailSheet's recent reads to a server query (#286)
3. ✅ Followup #1 (CSV merge handler / `onApply` drop) (#290)
4. 🚧 PR-A — `getDashboardOfflineMonitoring` aggregator + drop 4 client memos (smallest wedge)
5. 🚧 PR-B — extend `getDashboardFinancials` to cover `financialCsgIds` + `financialProfitDebug`
6. 🚧 PR-C — trace `part2VerifiedAbpRows` chain, migrate remaining client consumers
7. 🚧 PR-D — delete the cloud-fallback hydration code itself

### #5 — Force Load All button removal

**Status:** Blocked by #4. Once cloud-fallback is gone, the
Force Load button has nothing to drive — it goes too. Plus the
2026-04-29 "skip multi-append on force-load" hotfix comment +
`MULTI_APPEND_DATASET_KEYS` set become deletable.

### #6 — `buildDeliveryYearLabel` divergence

**Status:** Low priority. Documented intentional divergence.

Client `recPerformance.ts` defines `buildDeliveryYearLabel` /
`buildRecReviewDeliveryYearLabel` with a `formatDate(start)` (locale-formatted)
fallback for the path-4 branch. Shared `solarRecPerformanceRatio.ts`
has a `start.toISOString().slice(0, 10)` fallback. The path-4
branch fires when `start` is parsed but `startRaw` is empty —
theoretical (never happens with normal Schedule B data).

If anyone wants to unify: don't change shared (server aggregators
shouldn't emit locale strings). Move the locale-formatted display
into the call site. PR #274's commit message documented this.

### #7 — Audit other latent transferLookup case bugs

**Status:** ✅ DONE 2026-04-30. Audit clean — no findings. Five
sites checked: `buildPerformanceSourceRows.ts:119`,
`buildTransferDeliveryLookup.ts:243`, `aggregatorHelpers.ts:296`,
`server/routers/helpers/scheduleB.ts:474`, and
`client/src/lib/scheduleBScanner.ts:457`. All lowercase consistently
on both write and read sides. The convention established by #279 is
solid.

(Wider Map-style lookups like `systemsByTrackingId` and
`eligibleTrackingIds` use the same source-of-truth case on set
and get sides — the audit was scoped to the transferLookup-payload
shape per the original ask.)

### Lower-priority cleanup list (no urgency, ship opportunistically)

- `parseCsv*` direct reduction once cloud-fallback is gone
- `csvParser.worker.ts` web worker — still used by upload paths
  but check if it's reachable from the upload v2 flow (probably yes)
- `lib/csvParsing.ts :: parseTabularFile` — same; still used by
  cloud-fallback for `.xlsx` rows in `abpIccReport2Rows`/`abpIccReport3Rows`
- The big JSDoc block at the top of `SolarRecDashboard.tsx` may
  still reference IDB / lazyDataset — grep for stale comments

---

## Critical context (don't relearn this the hard way)

### The dual-router boundary

`server/routers.ts` is the personal router. `server/_core/solarRecRouter.ts`
+ its sub-routers (`solarRecDashboardRouter.ts`, etc.) are the
team router. Solar REC Dashboard procs go on
`solarRecDashboardRouter.ts`. **Never add a solar-rec proc to
`server/routers.ts`.** See `CLAUDE.md` "READ THIS FIRST" for
the full story.

### The verification recipe

```
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/vitest run
./node_modules/.bin/vite build --logLevel warn
```

Default `tsc` lies (incremental cache). Always pass
`--incremental false`. As of #279: 95 test files / 1299 tests.

### The `_runnerVersion` discipline

Every server aggregator response carries `_runnerVersion`. Bump
it on logic changes so caches invalidate. Format established in
this session: `phase-5X-prY-NAME@N` (PR #278) or
`data-flow-pr5_13_NAME@N` (older). Cache keys bundle the runner
version explicitly, so a bump invalidates every cached entry on
next read.

### The aggregator template

The canonical template is `buildContractVintageAggregates.ts`:
1. Top-level pure function `build<Name>Aggregates(input)` taking
   already-derived inputs (not raw datasets).
2. `compute<Name>InputHash(scopeId)` that returns
   `{ hash, ...batchIds }` + bumps a runner version into the
   sha256 input.
3. `getOrBuild<Name>(scopeId)` cached entrypoint using
   `withArtifactCache` with `superjsonSerde` (if the output has
   any Date | null fields) or `jsonSerde` (if pure JSON).
4. tRPC proc on `solarRecDashboardRouter.ts` gated on
   `requirePermission("solar-rec-dashboard", "read")`, returns
   the aggregator output spread + `_runnerVersion`.

Look at `buildContractVintageAggregates.ts` (multi-dataset,
joins through snapshot eligibility) or `buildPerformanceSourceRows.ts`
(my Phase 5e addition, simpler) when you need a recipe.

### The case-insensitivity convention (post-PR #279)

All `transferDeliveryLookup` lookups go through
`getDeliveredForYear` which lowercases internally. Test fixtures
use lowercase keys. New aggregators that touch `byTrackingId`
directly must lowercase the lookup key. This is the single
source of the contract.

### The two-app shell rule

`SolarRecDashboard.tsx` mounts at `/solar-rec/`, served by the
team SPA. The personal SPA is at `/`. They share the same
service worker (scope=`/`). Anything that touches client-shell
infrastructure (SW, asset caching, route fallbacks, lazy
boundaries) must be smoke-tested on BOTH apps. PR #223 (PWA
shell) is the canonical "did not do this" disaster.

### Tab-active gating

The 3-deferred-tabs (PerformanceRatio, Forecast, Financials) plus
the Phase 5e additions (PerformanceSourceRows) all gate their
queries on `isXTabActive` flags so the cache only warms when
needed. `isPerformanceEvalTabActive` covers BOTH `performance-eval`
AND `snapshot-log` tabs (single flag, two activeTab values).

---

## Worktree state at session end

```
/Users/rhettgopaul/Documents/New project/productivity-hub
  └── main (origin/main, fast-forwarded through PR #279)

/private/tmp/zendesk-migration  (git worktree)
  └── docs/phase-5e-handoff (this file's branch)
```

Other worktrees per `git worktree list`:
- `/private/tmp/coh-bigpr` — `feat/daily-rituals-and-nudges`
- `/private/tmp/coh-insights` — `feat/cross-domain-insights`
- `/private/tmp/coh-reflhist` — `feat/reflection-history`
- `/private/tmp/coh-restock` — `fix/supplements-restock-decrement`
- Two Codex hotfix worktrees in the main project dir

The user has 5–15 dirty worktrees at any time. **Always check
`git status --short` and `git worktree list` before assuming you
can edit a file.** See `SESSIONS_POSTMORTEM.md` for sessions
that ate hours from this oversight.

---

## User-communication patterns

Confirmed across this session:

- **`mc`** = "merged, continue" — the user has merged the open PR
  and wants me to pick the next item autonomously.
- **Auto mode is on continuously.** User prefers action over
  planning. No need to `EnterPlanMode` for routine work.
- **The user merges via squash** — every PR becomes one commit on
  main. PR commit messages should still be detailed; the squash
  preserves the body.
- **PRs ship one focused change at a time.** PR #267 was reverted
  for bundling 4 changes; the salvage trio shipped them as 3 PRs.
  Match this discipline.
- **Per `feedback_merge_authority` memory:** docs-only PRs are
  merge-authorized; code/schema/CI changes stop for review. This
  PR (the handoff doc) qualifies as docs-only.

---

## What NOT to do

- **Don't add procs to `server/routers.ts`** — solar-rec features
  go on `solarRecDashboardRouter.ts`.
- **Don't remove `_runnerVersion` from any response shape.** It's
  the only way to verify "is my code actually running" without
  local repro.
- **Don't trust `tsc --noEmit` alone.** The incremental cache
  produces persistent false positives. Always
  `--incremental false`.
- **Don't bundle "drive-by" fixes.** PR #267 is the cautionary
  tale. If a change is unrelated to the PR's stated scope, ship
  it separately.
- **Don't read `datasets[k].rows` from a new tab.** Use the
  per-tab aggregator query or the summaries query for counts.
- **Don't read `datasets[k].rows` from a new tab.** Use the
  per-tab aggregator query or the summaries query for counts.
  (Old guidance about Forecast's divergent private
  `buildPerformanceSourceRows` is obsolete — #281 consolidated it.)

---

## Recommended next move (post 2026-04-30 audit)

**Step 4 PR-A** — `getDashboardOfflineMonitoring` server aggregator.

Why this one:
- Smallest single-tab wedge among the remaining `datasets[k].rows`
  consumers (see #4 audit table above).
- 80% of the server-side work already exists — `buildPart2EligibilityMaps`
  in `buildContractVintageAggregates.ts` covers the eligibility set;
  `buildMonitoringDetailsBySystemKey` is in
  `loadPerformanceRatioInput.ts:175` waiting to be promoted to a
  shared helper.
- One PR, ~250 LOC across server + tests + client. Mirrors the
  `buildContractVintageAggregates.ts` template (multi-input, joins
  through the system snapshot's eligibility filter).
- Drops 4 client useMemos + 4 prop forwards from
  `SolarRecDashboard.tsx` → `<OfflineMonitoringTab>`.
- Tab-active gated on `isOfflineMonitoringTabActive` (already
  declared, currently used to gate other queries).

After PR-A lands, PR-B (extend `getDashboardFinancials` for
`financialCsgIds` / `financialProfitDebug`) is the next wedge,
followed by the heavier PR-C (the `part2VerifiedAbpRows` chain).
Only after C is the cloud-fallback delete (PR-D) genuinely
unblocked.

---

## Session log

| Session | Date | What shipped |
|---|---|---|
| #271–#279 | 2026-04-29 | Phase 5d salvage trio + Phase 5e dead-code sweep + performanceSourceRows server aggregator + transferLookup case fix |
| #280 | 2026-04-29 | This handoff doc (initial version) |
| #281–#287 | 2026-04-29/30 | Followups #2, #1 step 1, #3, ErrorBoundary, #4 step 1, #4 step 2, dropped convertedReads from priorities |
| #289 | 2026-04-30 | OOM hotfix — Performance Ratio convertedReads streaming |
| #290 | 2026-04-30 | Followup #1 step 2 — dropped `onApply` parallel client merge |
| (current) | 2026-04-30 | This refresh: marked #2/#3/#7 ✅, expanded #4 with the real audit table, bumped recommended next move to "PR-A `getDashboardOfflineMonitoring`" |
