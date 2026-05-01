# Solar REC Dashboard — 502 root-cause findings

**Status:** investigation, no code changes (Phase 1.3a of the dashboard foundation repair).
**Date:** 2026-04-30.
**Scope:** `solarRecDashboard.getDashboardOverviewSummary` and `solarRecDashboard.getDashboardOfflineMonitoring` returning HTTP 502 under load.
**Outcome:** identified four compounding failure modes from static analysis. Three of them can be confirmed at code level alone; the fourth (Render OOM vs. proxy timeout) needs a live measurement on production. Phase 1.3b will pick the worst-offender to patch as a stop-gap before Phase 2's foundation builder lands.

---

## TL;DR

Both 502'ing procedures have **all four** of these problems at once:

1. **Response payload exceeds the 1 MB hard rule** in CLAUDE.md "Wire payload contracts." `getDashboardOverviewSummary` ships `ownershipRows: OwnershipOverviewExportRow[]` — one ~17-field row per Part-II-verified system (~21k rows on prod) with `Date | null` fields requiring superjson — back-of-envelope **5–15 MB uncompressed.** `getDashboardOfflineMonitoring` ships several `Record<systemKey, …>` lookup objects keyed by ~21k systems, likely **2–5 MB**. Both procedures are the only ones in the dashboard data path that produce per-system row arrays/maps in the response.
2. **`withArtifactCache` has no single-flight protection.** N concurrent cold-cache requests produce N parallel `recompute()` runs, each holding its own ~28k-row abpReport copy in memory plus paying the snapshot build's heap cost. The `solarRecComputeRuns` claim row that protects `getOrBuildSystemSnapshot` is one layer below — the per-tab aggregator wrappers don't share that protection.
3. **`loadDatasetRows()` returns unbounded row arrays** in JS heap. Snapshot's cold path materializes 7 datasets totaling ~1.18M rows simultaneously (`Promise.all` at `buildSystemSnapshot.ts:625`); accountSolarGeneration alone is 405k rows and transferHistory 633k. The `skipRawRow` trick at line 184 saves ~500 MB on the wire but the row count itself is unbounded.
4. **Cold-snapshot race writes empty cached summaries.** `getOrBuildOverviewSummary` calls `getOrBuildSystemSnapshot` synchronously, but the snapshot returns `{ systems: [], building: true }` while the background compute runs. The summary aggregator does not check `building`; it builds a summary over an empty systems array → caches an "all zeros" summary against the same `inputVersionHash` the snapshot uses → future callers get the empty summary from cache until the dataset version changes. This plausibly explains the user's "Overview shows zeros / Size+Reporting shows real numbers" symptom, which has been the loudest data-quality bug under test.

The 502 itself is most likely (1) — Render rejects responses above its proxy size limit before they reach the user. (2)+(3) compound it under concurrent load (OOM kills the dyno, mid-flight requests 502). (4) is a separate correctness bug that surfaces alongside.

---

## Investigation questions, in scope order

### 1. Response sizes vs. the 1 MB hard rule

> "No tRPC response in the dashboard data path exceeds 1 MB uncompressed." — CLAUDE.md, "Wire payload contracts" table.

**`getDashboardOverviewSummary` — likely violates.** The result type at `server/services/solar/buildOverviewSummaryAggregates.ts:112-139` includes:

```ts
ownershipRows: OwnershipOverviewExportRow[];
```

`OwnershipOverviewExportRow` (line 56-77) has 17 fields per row including 3 `Date | null` fields (`latestReportingDate`, `contractedDate`, `zillowSoldDate`). superjson serialization of `Date | null` adds ~50 bytes per cell vs. plain JSON. Estimated row size: 600–1000 bytes JSON, 750–1200 bytes superjson. With ~21k Part-II-verified systems on prod (per the user's testing — exact number is `summaryCounts.part2Verified` after Phase 2 ships), **estimated payload: 5–15 MB uncompressed.**

The CLAUDE.md table lists `getDashboard<TabName>Aggregates` as "~10–500 KB" — the existing entry under-counts Overview by an order of magnitude.

**`getDashboardOfflineMonitoring` — likely violates.** Result includes (from `buildOfflineMonitoringAggregates.ts:452-461`'s `rowCount` helper, which sums every output's length):

- `abpApplicationIdBySystemKey: Record<string, string>` — 21k entries
- `monitoringDetailsBySystemKey: Record<string, …>` — 21k entries with multi-field values
- `abpAcSizeKwBySystemKey: Record<string, number>` — 21k entries
- `abpAcSizeKwByApplicationId: Record<string, number>` — 21k entries
- `abpPart2VerificationDateByApplicationId: Record<string, …>` — 21k entries
- `eligiblePart2ApplicationIds: string[]` — 21k strings
- `eligiblePart2PortalSystemIds: string[]` — 21k strings
- `eligiblePart2TrackingIds: string[]` — 21k strings
- `part2VerifiedSystemIds: string[]` — 21k strings

**Estimated payload: 2–5 MB uncompressed.** The `rowCount` helper itself returns `agg.…length + agg.…length + …` totaling **~190k summed entries across all the maps and arrays**, which the cache layer writes to `solarRecComputedArtifacts.rowCount` — that column already records that this aggregator is by far the largest in the dashboard.

**Live measurement to confirm:**

```
# In devtools Network tab on a successful (200) call:
$ curl -s "https://app.coherence-rmg.com/solar-rec/api/trpc/solarRecDashboard.getDashboardOverviewSummary" \
  -X POST -H "..." -H "content-type: application/json" --compressed -d '{...}' \
  | wc -c

# Or from the response panel: "Size: 4.2 MB transferred / 14.8 MB resource"
```

Pull both numbers from a recent green prod call and confirm against the 1 MB rule.

---

### 2. Single-flight protection at the aggregator wrapper

`getOrBuildSystemSnapshot` (`buildSystemSnapshot.ts:382-508`) **has** cross-process single-flight via the `solarRecComputeRuns` table:

- `claimComputeRun()` does `INSERT IGNORE … (scopeId, artifactType, inputVersionHash)`. First caller wins; losers re-read the cache and return `{ building: true, systems: [] }` if still empty.
- Background `runComputeInline` writes the cache, marks the run done.

This is the right shape for the foundation builder Phase 2 will introduce.

But `withArtifactCache` (`server/services/solar/withArtifactCache.ts:82-130`) — used by every per-tab aggregator including overview and offline — has **no** single-flight protection:

```ts
const cached = await getComputedArtifact(scopeId, artifactType, inputVersionHash);
if (cached) { /* return parsed */ }
const result = await recompute();   // ← N concurrent callers all run this
try { await upsertComputedArtifact({ … }) } catch { /* warn */ }
return { result, fromCache: false };
```

Twelve simultaneous cold-cache `getDashboardOverviewSummary` callers will run twelve parallel `recompute()`. Each `recompute()`:

- Fan-outs `getOrBuildSystemSnapshot(scopeId)` (single-flighted at *that* layer — only one snapshot build, others return building) **and**
- Independently calls `loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport)` — **not** single-flighted; each caller materializes its own ~28k-row copy.

So twelve concurrent overview requests = twelve × 28k ABP rows in JS heap = ~336k row objects, each carrying a `rawRow` JSON string. Plus snapshot's background `runComputeInline` itself materializing 7 datasets totaling ~1.18M rows. Heap ceiling on Render is `--max-old-space-size=3584` MB (per `package.json:start`), so headroom isn't infinite once the response payload (also retained until streaming completes) is added on top.

**Live measurement to confirm:** capture process RSS / `process.memoryUsage()` snapshots during an artificial load test (10 parallel cold-cache opens). Or simpler — Render's per-dyno memory dashboard during a 502 event. If Render logs show SIGKILL with OOM signature, this is confirmed.

---

### 3. Unbounded `loadDatasetRows` on the cold path

`loadDatasetRows` (`server/services/solar/buildSystemSnapshot.ts:160-214`) has **no LIMIT and no streaming**. It does `db.select().from(table).where(scope+batch)` and returns the entire result set as `CsvRow[]`. Mitigation at line 186 — for large tables (`accountSolarGeneration`, `transferHistory`) it omits the `rawRow` column — avoids ~500 MB of wire transfer but does not cap row count.

`buildSystemSnapshot.runComputeInline` (line 617-648) materializes 7 of these arrays in parallel:

| Dataset | Row count (prod, per user's testing) | rawRow skipped? |
|---|---|---|
| solarApplications | 32,696 | no |
| abpReport | 28,344 | no |
| generationEntry | 24,711 | no |
| accountSolarGeneration | 405,220 | yes |
| contractedDate | 32,407 | no |
| deliveryScheduleBase | 23,960 | no |
| transferHistory | 633,831 | yes |

**Total: ~1.18M row objects in JS heap during a snapshot build.** Even with `rawRow` skipped on the two big datasets, each row is still a several-hundred-byte object with normalized columns. Conservative estimate: ~250–500 MB peak heap, plus whatever the `buildSystems()` walk allocates downstream.

**The CLAUDE.md hard rule** ("No tRPC procedure is allowed to materialize a full `CsvRow[]` greater than 5,000 rows in memory for wire-payload purposes") is technically about wire payloads, not internal memory — but the intent of "no big arrays in memory" is being violated by ~200×. Phase 2's foundation builder must use chunked DB scans (`loadDatasetRowsPage` pattern at line 268) instead of bulk `loadDatasetRows`.

---

### 4. Snapshot/summary code-share — cold-cache empty-summary trap

The summary aggregator (`buildOverviewSummaryAggregates.ts:608-642`) sources `systems` from `getOrBuildSystemSnapshot` and abpReport from `loadDatasetRows` in parallel:

```ts
const [snapshot, abpReportRows] = await Promise.all([
  getOrBuildSystemSnapshot(scopeId),
  loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
]);
const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);
const systems = extractSnapshotSystemsForSummary(snapshot.systems);
return buildOverviewSummary({ part2VerifiedAbpRows, systems });
```

There is **no check on `snapshot.building`.** When the snapshot is mid-build (cache miss), `getOrBuildSystemSnapshot` returns `{ systems: [], building: true, inputVersionHash }`. The summary aggregator then runs over an empty systems array, produces an "all zeros" summary, and `withArtifactCache` writes that empty result back keyed by the same `inputVersionHash` that the snapshot will later use when it finishes.

`computeOverviewSummaryInputHash` (line 605) bundles `abpReport batch + system snapshot hash`. Both are derived from input dataset versions, not from output content — so the hash is stable across "snapshot empty (building)" → "snapshot full (built)". The empty cached summary persists until the user uploads new data and the dataset versions tick.

**This is plausibly the "Overview shows zeros while Size+Reporting shows real numbers" symptom** the user reported during testing. Same inputs, two procedures, two answers — because one was unlucky enough to recompute against an empty mid-build snapshot and cached the result.

The same pattern likely affects every aggregator that uses `withArtifactCache` and consumes `getOrBuildSystemSnapshot`'s output without checking `building`. Quick grep:

```
$ grep -rln "getOrBuildSystemSnapshot" server/services/solar/
buildSystemSnapshot.ts                  ← defines it
buildOverviewSummaryAggregates.ts       ← Bug 4 confirmed
buildPerformanceSourceRows.ts           ← needs check
buildContractVintageAggregates.ts       ← needs check
... (likely others)
```

Phase 2's foundation builder collapses this — all tab aggregates read a single foundation artifact whose construction completes synchronously from the caller's view (or returns a `building` flag the wrapper and tabs both honor).

---

## Recommended Phase 1.3b stop-gap

In priority order — pick whichever is fastest to ship safely. Phase 2's foundation work makes all of these obsolete in ~2.5 days, so the stop-gap should be **minimal** (no architectural change) and **reversible**.

**Option A: Cap `ownershipRows` in `getDashboardOverviewSummary` payload.** Move it behind a separate paginated procedure (`getDashboardOverviewOwnershipRows({ cursor, limit })`) and drop it from the main response. Most callers don't need the full row array — only the CSV export does. Estimated effort: ~1 day. Drops payload from 5–15 MB to ~10 KB; addresses (1) directly. Does not fix (2)/(3)/(4).

**Option B: Add in-process Promise registry to `withArtifactCache`.** Same dyno's concurrent callers share one in-flight `recompute` Promise per `(scopeId, artifactType, inputVersionHash)` key. Doesn't help across dynos but Render runs single-dyno on the relevant plan. ~3 hours. Addresses (2). Does not fix (1)/(3)/(4).

**Option C: Honor `building` in `getOrBuildOverviewSummary`.** When the snapshot returns `building: true`, throw or return a `{ building: true }` shape rather than caching an empty summary. ~2 hours. Addresses (4). Does not fix (1)/(2)/(3).

**My recommendation for Phase 1.3b:** ship **A + C**. (A) is the user-visible fix for the 502 (the response actually fits). (C) prevents the empty-summary cache trap that's been driving the "Overview shows zeros" complaints. (B) and the row-count cap are subsumed by Phase 2 within a week; not worth the churn. Total stop-gap effort: ~1.5 days.

---

## Live measurements I cannot run from here, but can confirm with you

These are the empirical numbers needed to lock the diagnosis. I have read-only access to the source tree but not to Render or production logs. Please capture and share — they take ~15 minutes total — and I'll fold them into Phase 1.3b's PR description.

1. **Render service log around the most recent 502 event.** Filter for `getDashboardOverviewSummary` or `getDashboardOfflineMonitoring`. Look for `SIGKILL`, `out of memory`, or `Worker exceeded memory limit`. If present → confirms (2)+(3) are the proximate cause.
2. **DevTools Network → Size column** on a successful `getDashboardOverviewSummary` call. Report both "transferred" and "resource" (uncompressed) sizes. If "resource" > 1 MB → confirms (1).
3. **DevTools Network → Time** on a cold-cache `getDashboardOverviewSummary` call (clear browser cache, hard reload). Note p50 and p99 over 10 trials. If p99 > 30 s → confirms a Render proxy-timeout angle.
4. **`process.memoryUsage().heapUsed`** logged at the top + bottom of `runComputeInline`. The `console.log` already at line 650-654 reports `loadMs / totalMs` but not heap. If we can capture both from the same log line, we'll know whether the snapshot build itself is OOMing. (This is a one-line change in Phase 1.3b's PR.)

---

## What this finding does NOT cover

- **The chunk-load and per-tab-error-boundary symptoms** — both already shipped in Phase 1.1 (PR #308) and Phase 1.2 (PR #309).
- **The 4-different-Reporting-counts and Part II off-by-one bugs** — those are downstream of this same architectural gap, but Phase 2's foundation builder is the clean fix; band-aiding them in Phase 1.3b would diverge from the locked v3 plan.
- **`getSystemSnapshot` 502s** — the user's testing did not report this procedure 502'ing; it has correct single-flight via `solarRecComputeRuns` and a cap'd ~200 KB wire payload. The bug here is downstream of the snapshot, not in it.

---

## Citations (file paths verified 2026-04-30 against `main` at `f3e5f87`)

- `server/_core/solarRecDashboardRouter.ts:2660` — `getSystemSnapshot`
- `server/_core/solarRecDashboardRouter.ts:2946` — `getDashboardOverviewSummary`
- `server/_core/solarRecDashboardRouter.ts:2985` — `getDashboardOfflineMonitoring`
- `server/services/solar/buildSystemSnapshot.ts:160-214` — `loadDatasetRows`
- `server/services/solar/buildSystemSnapshot.ts:382-508` — `getOrBuildSystemSnapshot` (single-flight via `solarRecComputeRuns`)
- `server/services/solar/buildSystemSnapshot.ts:601-656` — `runComputeInline` (the 7-dataset parallel load)
- `server/services/solar/buildOverviewSummaryAggregates.ts:112-139` — `OverviewSummaryAggregate` shape
- `server/services/solar/buildOverviewSummaryAggregates.ts:608-642` — `getOrBuildOverviewSummary` (no `building` check)
- `server/services/solar/buildOfflineMonitoringAggregates.ts:440-485` — `getOrBuildOfflineMonitoringAggregates`
- `server/services/solar/withArtifactCache.ts:82-130` — `withArtifactCache` (no single-flight)
- `package.json:start` — `node --max-old-space-size=3584`

---

## Next step

Ship Phase 1.3b with the A+C stop-gap once the live measurements above confirm the diagnosis. Then proceed to Phase 2 (foundation + locked definitions).
