# Handoff — Phase 2.7 + 3.1 of the Solar REC Dashboard foundation repair

**Last session:** 2026-04-30 → 2026-05-01. Shipped Phase 1 + Phase 2 of the foundation repair (8 PRs across two days).
**Next up:** Phase 2.7 (foundation reporting + ownership extension) → Phase 3.1 (migrate Overview / Offline Monitoring / Change of Ownership tabs).
**Why this handoff exists:** the prior session ran long; rather than start Phase 2.7 with depleted context, this doc captures everything the next session needs to ship cleanly.

---

## TL;DR

Phase 2 shipped a canonical dashboard foundation artifact, but **deferred reporting + ownership status** (the builder sets `isReporting: false`, `ownershipStatus: null`, `summaryCounts.reporting: 0` across the board). Phase 3.1 wants to migrate the three loudest tabs to consume the foundation, but their headline metrics include "Reporting" and "Transferred and Reporting" counts — which would all read 0 until the foundation extension ships.

So the order is:

1. **Phase 2.7** — extend the foundation builder to compute `isReporting`, `anchorMonthIso`, `ownershipStatus`, `reportingCsgIds`, `summaryCounts.reporting`, `summaryCounts.part2VerifiedAndReporting`. Mirror the legacy reporting + ownership semantics from `client/src/solar-rec-dashboard/lib/buildSystems.ts` so production numbers don't drift, except for the **anchor change** noted below.
2. **Phase 3.1** — rewrite `buildOverviewSummaryAggregates`, `buildOfflineMonitoringAggregates`, `buildChangeOwnershipAggregates` to read from `FoundationArtifactPayload` instead of re-deriving from raw `srDs*` rows.

Estimated total: **5 hours focused work, 2 PRs**.

---

## Repo state at handoff

- **Branch:** `main` (clean, up to date with origin)
- **HEAD:** `55f79ad feat(solar-rec): Loaded → Populated rename + real rowCount in foundation (Phase 2.6) (#315)`
- **Last 8 commits on main:**
  - `55f79ad` Phase 2.6 — Loaded → Populated rename + real rowCount (#315)
  - `70c60de` Phase 2.5 — warmFoundation mutation + page-mount (#314)
  - `e949328` Phase 2.3 — runner + getFoundationArtifact (#313)
  - `59fe094` Phase 2.2 + 2.4 — builder + dedupe (#312)
  - `3b3db6f` Phase 2.1 — artifact contract (#311)
  - `9532b40` Phase 1.3a — 502 findings (#310)
  - `f3e5f87` Phase 1.2 — per-tab error boundary (#309)
  - `5c48bba` Phase 1.1 — SW + manifest hardening (#308)
- **`tsc --noEmit --incremental false`** — clean on `main`.
- **Test count** — 591/591 passing across 31 server/solar + shared test files.
- **Plan file:** `/Users/rhettgopaul/.claude/plans/create-implementation-plan-model-delightful-bonbon.md` (v3 plan; canonical source of phase definitions).

---

## Phase 2.7 — foundation reporting + ownership extension

### What ships

Extend `server/services/solar/buildFoundationArtifact.ts` to populate the deferred fields in `FoundationCanonicalSystem` + `FoundationArtifactPayload`:

| Field | Type | What to compute |
|---|---|---|
| `system.isReporting` | boolean | True when the system has a positive generation reading inside the reporting window. |
| `system.anchorMonthIso` | string \| null | First day of the anchor month, `yyyy-mm-01` format. **Same value across every system in a scope.** |
| `system.ownershipStatus` | `"active" \| "transferred" \| "change-of-ownership" \| "terminated" \| null` | Lifecycle bucket — see decision tree below. |
| `system.lastMeterReadDateIso` | string \| null | Newest meter-read date (across `srDsAccountSolarGeneration` + `srDsGenerationEntry`). |
| `system.lastMeterReadKwh` | number \| null | The kWh value associated with `lastMeterReadDateIso`. |
| `payload.reportingAnchorDateIso` | string \| null | Same as `system.anchorMonthIso` (denormalized for callers that don't iterate systems). |
| `payload.reportingCsgIds` | string[] | Sorted, deduped CSG IDs where `isReporting && !isTerminated`. |
| `payload.summaryCounts.reporting` | number | `=== reportingCsgIds.length`. |
| `payload.summaryCounts.part2VerifiedAndReporting` | number | Intersection: `isPart2Verified && isReporting && !isTerminated`. |

`gatsId`, `monitoringPlatform`, `contractedDateIso`, `energyYear` can stay deferred — Phase 3.1 doesn't need them.

### Locked Reporting definition (from the v3 plan + legacy semantics)

```
Reporting = positive generation reading in
            [firstDayOfAnchorMonth − 2 calendar months 00:00:00 America/Chicago,
             firstDayOfAnchorMonth + 1 calendar month     00:00:00 America/Chicago)

Anchor    = newest valid generation date across
              srDsAccountSolarGeneration ∪ srDsGenerationEntry
            where the row's kWh value is > 0.

Transfer History never affects reporting status.
Zero-production rows do not count.
```

**This differs from the legacy logic in `buildSystems.ts:546-559`.** The legacy code uses `new Date()` (today) as the anchor and goes 3 months back. The v3 def uses the **newest data point** as anchor and goes 2 months back. This is a **deliberate behavior change** — without it, a 6-month-old fixture would report 0% reporting because nothing falls in "the last 90 days from today."

When implementing, verify with a fixture: feed in generation data anchored at "2024-06-01" → assertion `payload.reportingAnchorDateIso === "2024-06-01"`.

### Locked Ownership Status state machine

The legacy `buildSystems.ts:592-633` produces 6 combined states (`Terminated and Reporting`, `Transferred and Reporting`, etc.). The v3 foundation provides **lifecycle-only** ownership status; tabs combine it with `isReporting` themselves:

```
contract type → {Active | Transferred | Terminated}
zillowSoldDate > contractedDate → "change-of-ownership" candidate
transferSeen (any transferHistory row mentioning this system) → "transferred"

Decision tree:
  if isContractTerminated  → "terminated"
  else if isContractTransferred OR transferSeen → "transferred"
  else if hasZillowConfirmedOwnershipChange → "change-of-ownership"
  else → "active"
```

`isContractTerminated` and `isContractTransferred` come from the `contract_type` column in `srDsSolarApplications.rawRow`. The constants `IL_ABP_TERMINATED_CONTRACT_TYPE` / `IL_ABP_TRANSFERRED_CONTRACT_TYPE` live in `client/src/solar-rec-dashboard/lib/constants.ts` — **do not import from client; mirror the strings inline as Phase 2.2 already did for the terminated check**. The Phase 6 cleanup task hoists them to `shared/`.

`zillowSoldDate` and `zillowStatus` live in `srDsSolarApplications.rawRow` JSON. Field names: `zillowData.status` / `Zillow_Status` / `Zillow_Sold_Date`.

### Data linkage chain

The three generation tables don't share a CSG ID column. The link is via the **tracking-system-ref-id** on Solar Applications, which appears under different names in each generation table:

| Table | Column carrying the tracking ref | Drizzle name |
|---|---|---|
| `srDsSolarApplications` | `tracking_system_ref_id` (also `trackingSystemRefId` typed) | `trackingSystemRefId` |
| `srDsAccountSolarGeneration` | `GATS Gen ID` (CSV) → `gats_gen_id` → `gatsGenId` typed | `gatsGenId` |
| `srDsGenerationEntry` | `Unit ID` (CSV) → `unit_id` → `unitId` typed | `unitId` |
| `srDsTransferHistory` | `Unit ID` → `unitId` typed | `unitId` |

So the foundation builder needs to:

1. Build `Map<trackingSystemRefId, csgId>` from solarApplications rows.
2. Iterate accountSolarGenerationRows, key by `gatsGenId`. For each, look up CSG via the tracking map and accumulate `latestGenerationDate` + `latestMeterReadKwh` per system.
3. Iterate generationEntryRows, key by `unitId`. Same pattern. Generation entry's date is `lastMonthOfGen` (canonical) with fallbacks to `effectiveDate` and `monthOfGeneration`.
4. Iterate transferHistoryRows, key by `unitId`. For each, mark the affected system as `transferSeen = true` (drives `ownershipStatus = "transferred"` if the contract type isn't already terminated).

A system without a `trackingSystemRefId` (some legacy entries) cannot link to generation data → `isReporting: false`. Surface as no integrity warning (it's a known data gap, not a builder bug).

### Files to touch

- `server/services/solar/buildFoundationArtifact.ts` — extend `FoundationBuilderInputs`, add `generationEntry`, `accountSolarGeneration`, `transferHistory` arrays. Extend `buildFoundationFromInputs` to compute the new fields. Update `buildFoundationArtifact` (DB-bound) to load the new tables via the existing `loadAllRowsByPage` helper.
- `server/services/solar/buildFoundationArtifact.test.ts` — add fixtures + tests for the new fields. Suggested test cases:
  - "anchor is the newest valid generation date, not today" (data-relative, deterministic)
  - "system with positive generation in window → isReporting=true"
  - "system with zero-production rows only → isReporting=false"
  - "system with no generation rows at all → isReporting=false"
  - "system with reading just outside windowEnd → isReporting=false (half-open)"
  - "ownershipStatus=terminated takes priority over transferred"
  - "transferHistory row linked via unitId flips ownershipStatus to transferred"
  - "reportingCsgIds excludes terminated systems even if they have recent generation"
  - `summaryCounts.part2VerifiedAndReporting` matches the intersection
- `shared/solarRecFoundation.ts` — no type changes (the fields are already declared, just unpopulated). Update the docstring on `FoundationCanonicalSystem.isReporting` to remove the "deferred" caveat.

### Testing

The pure `buildFoundationFromInputs` is the testable surface. Construct fixture inputs:

```ts
const inputs = makeInputs({
  solarApplications: [
    makeSolar("CSG-1", { contractType: "IL ABP - Active", trackingSystemRefIdInRawRow: "TSR-1" }),
  ],
  abpReport: [makeAbpReport("ABP-1", "2024-06-01")],
  abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
  // NEW:
  accountSolarGeneration: [
    { gatsGenId: "TSR-1", monthOfGeneration: "2024-04-01", lastMeterReadKwh: "1500" },
  ],
  generationEntry: [],
  transferHistory: [],
});

// Anchor = 2024-04 (newest valid date). Window = [2024-02-01, 2024-05-01).
// CSG-1's only reading is 2024-04 within window with kWh > 0 → isReporting=true.
const payload = buildFoundationFromInputs(inputs, FIXED_BUILT_AT);
expect(payload.canonicalSystemsByCsgId["CSG-1"].isReporting).toBe(true);
expect(payload.reportingAnchorDateIso).toBe("2024-04-01");
```

The current `makeSolar` in `buildFoundationArtifact.test.ts` doesn't carry tracking-ref state; you'll need to extend it. Add a `trackingSystemRefId` field on `FoundationSolarApplicationInput` and thread it through.

### Definition of Done

1. tsc clean (`./node_modules/.bin/tsc --noEmit --incremental false`).
2. Foundation tests pass (target: 60+ tests in `buildFoundationArtifact.test.ts`).
3. New invariant in `assertFoundationInvariants`: `summaryCounts.part2VerifiedAndReporting <= Math.min(summaryCounts.part2Verified, summaryCounts.reporting)` — this already exists in `shared/solarRecFoundation.ts:296` (invariant #12), no new code needed; just add a fixture test that exercises it.
4. Foundation built against a synthetic 100-system scope produces a stable `reportingAnchorDateIso` matching the newest fixture date (regression guard for the data-relative anchor).
5. Bumped `FOUNDATION_RUNNER_VERSION` from `"foundation-v1"` to `"foundation-v2"` if the artifact's persisted shape changes meaningfully (it doesn't — fields go from null → real values, schema is unchanged. So `FOUNDATION_DEFINITION_VERSION` bumps from `1` to `2` to invalidate cached v1 artifacts that have stale `isReporting: false` everywhere).

### Risks / pitfalls

- **Accidentally inheriting the legacy `today − 3 months` anchor.** The legacy `buildSystems.ts:546-551` is the wrong reference for anchor logic (only the per-system reporting check is). Use the v3 def: anchor = newest valid generation date in the data.
- **Timezone drift.** Window math is America/Chicago. Use the `firstDayOfMonth` / `shiftIsoDate` helpers in `server/services/solar/helpers.ts` (already imported in other foundation files; do not redefine).
- **`trackingSystemRefId` from solarApplications is a typed column** (`trackingSystemRefId`), but for some rows it's only in `rawRow`. The Phase 2.2 builder reads typed columns only. For Phase 2.7, it might need to also read from rawRow. Check during implementation; if rare, log + skip.
- **Multiple Solar Applications rows per CSG ID** — Phase 2.2's builder keeps the first one. If the first row's `trackingSystemRefId` is null but a later row has it, the system will be unlinkable from generation data. Consider falling back to the first non-null `trackingSystemRefId` across all rows for that CSG.

---

## Phase 3.1 — migrate Overview / Offline Monitoring / Change of Ownership

### What ships

For each of the three tab aggregator builders, **replace its private re-derivation of canonical state with reads from the foundation**:

- `server/services/solar/buildOverviewSummaryAggregates.ts`
- `server/services/solar/buildOfflineMonitoringAggregates.ts`
- `server/services/solar/buildChangeOwnershipAggregates.ts`

### Concretely, the replacement looks like

**Before (current):**
```ts
export async function getOrBuildOverviewSummary(scopeId: string) {
  const { hash, abpReportBatchId } = await computeOverviewSummaryInputHash(scopeId);
  return withArtifactCache({
    /* ... */
    recompute: async () => {
      const [snapshot, abpReportRows] = await Promise.all([
        getOrBuildSystemSnapshot(scopeId),
        loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport),
      ]);
      const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);
      const systems = extractSnapshotSystemsForSummary(snapshot.systems);
      return buildOverviewSummary({ part2VerifiedAbpRows, systems });
    },
  });
}
```

**After:**
```ts
export async function getOrBuildOverviewSummary(scopeId: string) {
  const { payload: foundation } = await getOrBuildFoundation(scopeId);
  return withArtifactCache({
    scopeId,
    artifactType: "overview-summary-v2",
    inputVersionHash: foundation.foundationHash, // reuse the foundation's hash
    serde: superjsonSerde(),
    rowCount: (agg) => agg.ownershipRows.length,
    recompute: async () => buildOverviewSummary(foundation),
  });
}
```

Two key points:

1. **The aggregator's input is the foundation, not raw rows.** Every Part II / reporting / ownership / canonical-CSG question has a single answer that lives in `foundation.canonicalSystemsByCsgId` + `foundation.summaryCounts`.
2. **The aggregator's cache key reuses `foundation.foundationHash`.** When the foundation invalidates (new dataset upload), the per-tab caches naturally invalidate too.

### Per-tab specifics

#### 3.1a — Overview (`buildOverviewSummaryAggregates.ts`)

`OverviewSummaryAggregate` keeps its existing shape (line 112-139 of the file). The tab UI already consumes `summary.totalSystems`, `summary.reportingSystems`, etc. — the aggregator just sources these from the foundation now:

```ts
function buildOverviewSummary(foundation: FoundationArtifactPayload): OverviewSummaryAggregate {
  const systems = Object.values(foundation.canonicalSystemsByCsgId).filter(s => !s.isTerminated);

  const reportingSystems = systems.filter(s => s.isReporting).length;
  const reportingPercent = systems.length > 0 ? reportingSystems / systems.length : null;
  const smallSystems = systems.filter(s => (s.sizeKwAc ?? 0) <= 10).length;
  // ...

  // ownershipRows is one row per Part-II-verified system.
  const ownershipRows = foundation.part2EligibleCsgIds.map((csgId) => {
    const sys = foundation.canonicalSystemsByCsgId[csgId];
    return {
      key: sys.csgId,
      part2ProjectName: sys.csgId, // TODO: pull from solarApplications projectName when foundation surfaces it
      // ... derive each field from the foundation row + tab-specific concatenation rules
      ownershipStatus: combineOwnership(sys.ownershipStatus, sys.isReporting),
      isReporting: sys.isReporting,
      isTransferred: sys.ownershipStatus === "transferred",
      isTerminated: sys.isTerminated,
      // etc.
    };
  });

  return { /* ... */ };
}

function combineOwnership(
  base: FoundationCanonicalSystem["ownershipStatus"],
  isReporting: boolean
): OwnershipStatus {
  if (base === "terminated") return isReporting ? "Terminated and Reporting" : "Terminated and Not Reporting";
  if (base === "transferred") return isReporting ? "Transferred and Reporting" : "Transferred and Not Reporting";
  return isReporting ? "Not Transferred and Reporting" : "Not Transferred and Not Reporting";
}
```

**Bump `_runnerVersion` to `"overview-summary-v2"`** so the foundation-backed cache row is keyed separately from the legacy. Old `overview-summary-v1` cache rows can be left alone (they'll naturally age out).

#### 3.1b — Offline Monitoring (`buildOfflineMonitoringAggregates.ts`)

Same pattern. The tab needs `eligiblePart2ApplicationIds` / `eligiblePart2PortalSystemIds` / `eligiblePart2TrackingIds` arrays + the per-system maps (`abpApplicationIdBySystemKey`, `monitoringDetailsBySystemKey`).

The Part II eligibility set comes from `foundation.part2EligibleCsgIds`. Per-system maps need fields the foundation doesn't yet surface (`monitoringPlatform`, `gatsId`). For Phase 3.1, **either**:

- (a) Keep the per-system map derivations in the aggregator, but feed them the foundation's `part2EligibleCsgIds` as the eligibility filter. Defers Phase 2.7's GATS / monitoring-platform extension.
- (b) Extend Phase 2.7 to surface `gatsId` + `monitoringPlatform` per system, and have the aggregator project them out of `foundation.canonicalSystemsByCsgId`.

(a) is faster to ship. Choose based on time available.

The 62.6 MB response-size bloat (per `docs/triage/dashboard-502-findings.md`) gets a separate fix in **Phase 3.1c follow-up**: paginate `monitoringDetailsBySystemKey` into a cursor-based read. For Phase 3.1's core migration, keep the response shape and accept the size — it doesn't get worse than today.

#### 3.1c — Change of Ownership (`buildChangeOwnershipAggregates.ts`)

The "Transferred and Reporting" / "Change of Ownership" counts come from `foundation.canonicalSystemsByCsgId` filtered by `ownershipStatus !== "active" && !isTerminated`. The legacy `changeOwnershipStatus` field maps from the foundation's `ownershipStatus` + `isReporting` via the same `combineOwnership` helper as Overview.

### Files to touch

- `server/services/solar/buildOverviewSummaryAggregates.ts` — full rewrite of `getOrBuildOverviewSummary` body + the `buildOverviewSummary` helper.
- `server/services/solar/buildOfflineMonitoringAggregates.ts` — same.
- `server/services/solar/buildChangeOwnershipAggregates.ts` — same.
- `server/_core/solarRecDashboardRouter.ts` — bump procedure `_runnerVersion` strings to `"v2-foundation"` / equivalent so the new responses are verifiable via the CLAUDE.md deploy recipe.
- Existing tests for each aggregator (`buildOverviewSummaryAggregates.test.ts`, etc.) need updating — fixtures now go through the foundation. Use `buildFoundationFromInputs` in test setup to produce the foundation argument.

### Definition of Done

1. tsc clean.
2. Existing tab-aggregator tests pass with their fixtures rewritten to feed through `buildFoundationFromInputs`.
3. Cross-tab parity: a fixture with N=100 systems produces identical "Reporting" counts on Overview, Offline Monitoring, and Change of Ownership. (This is the headline cross-tab consistency fix the v3 plan promised.)
4. Production smoke: deploy to staging, open the dashboard, verify Overview's "Reporting" count matches Offline Monitoring's "Part II Verified" count for the same data — no more 21,038/21,065/21,050 drift.

### Out of scope for Phase 3.1

- The 62.6 MB Offline Monitoring response payload bloat. Defer to a follow-up that paginates the per-system maps.
- Phase 3 tabs 3.2–3.7 (other tab clusters, chart hardening, slug audit, integrity warnings UI). Each is its own PR.
- Tab UI changes. The aggregators continue to produce the same output shape; only the input source changes.

---

## Critical context — read this BEFORE typing code

1. **Read `CLAUDE.md` in full** before touching server code. The "Solar REC Dashboard data flow (canonical, post 2026-04-29)" section locks rules around payload sizes (1 MB cap), `_runnerVersion` markers, and the dual-router boundary.

2. **Verify TypeScript with `./node_modules/.bin/tsc --noEmit --incremental false` after every task.** The incremental cache lies. Per CLAUDE.md.

3. **`git status --short` before each task.** If there are uncommitted changes that aren't yours, stop and ask — there are usually 5–15 dirty files on the user's tree.

4. **One task, one commit, one PR.** Phase 2.7 = one PR, Phase 3.1 = one PR (or three if size warrants).

5. **The lazy-import map is correct** in `client/src/features/solar-rec/SolarRecDashboard.tsx:35-102`. Don't touch it. The "wrong chunk fetched" symptom from the original test session was a SW/cache artifact, fixed in PR #308.

6. **Foundation invariants throw on inconsistency.** The pure builder calls `assertFoundationInvariants` before returning; if a code change makes the artifact self-inconsistent (e.g., sumartmaCounts.reporting !== reportingCsgIds.length), the build throws and the cache write never happens. Fixture tests catch this in CI.

7. **The CLAUDE.md "two-app shell" rule applies to anything touching `client/public/service-worker.js` or the HTML files.** Phase 2.7 + 3.1 don't touch shell — but if a subsequent phase needs to, smoke-test on `/` AND `/solar-rec/` per PR #223 → #234 lessons.

---

## File paths verified at handoff time

| Path | What |
|---|---|
| `shared/solarRecFoundation.ts` | Foundation type contract + invariants. `EMPTY_FOUNDATION_ARTIFACT` (frozen), `FoundationCanonicalSystem`, `FoundationArtifactPayload`, `assertFoundationInvariants`. |
| `shared/solarRecFoundation.test.ts` | 26 tests. Touchpoint when the schema invariants change. |
| `server/services/solar/buildFoundationArtifact.ts` | Pure `buildFoundationFromInputs` + DB-bound `buildFoundationArtifact`. Helpers: `computeFoundationHash`, `loadInputVersions`, `loadAllRowsByPage`. |
| `server/services/solar/buildFoundationArtifact.test.ts` | 32 tests. Phase 2.7 adds reporting + ownership cases here. |
| `server/services/solar/foundationRunner.ts` | `getOrBuildFoundation` (cache-or-compute), `projectFoundationSummary` (slim wire view). Phase 3.1 calls `getOrBuildFoundation` from each migrated tab aggregator. |
| `server/services/solar/foundationRunner.test.ts` | 14 tests. |
| `server/services/solar/aggregatorHelpers.ts` | `isPart2VerifiedSystem`, `isPart2BlockingStatus`, `clean`, `parseDate`, `parseNumber`, `parsePart2VerificationDate`, `roundMoney`, `parseDateOnlineAsMidMonth`. The legacy `isPart2VerifiedAbpRow` is still here for backward compat — Phase 3 callers stop using it. |
| `server/services/solar/buildOverviewSummaryAggregates.ts` | Phase 3.1a target. Currently reads `srDsAbpReport` rows directly. |
| `server/services/solar/buildOfflineMonitoringAggregates.ts` | Phase 3.1b target. |
| `server/services/solar/buildChangeOwnershipAggregates.ts` | Phase 3.1c target. |
| `server/services/solar/helpers.ts` | `firstDayOfMonth`, `lastDayOfPreviousMonth`, `asDateKey`, `parseIsoDate`, `formatIsoDate`, `shiftIsoDate`, `toNullableString`, `safeRound`, `sumKwh`. **Import — do not redefine.** Per CLAUDE.md. |
| `client/src/solar-rec-dashboard/lib/buildSystems.ts` | Legacy reference for reporting + ownership semantics. Phase 2.7 mirrors the per-system logic here (lines 540–650 are the relevant block). |
| `drizzle/schemas/solar.ts` | All `srDs*` schemas. Foundation-relevant: `srDsSolarApplications:630`, `srDsAbpReport:674`, `srDsGenerationEntry:705`, `srDsAccountSolarGeneration:738`, `srDsContractedDate:768`, `srDsTransferHistory:824`, `srDsAbpCsgSystemMapping:894`. `solarRecActiveDatasetVersions:555`, `solarRecComputeRuns:568`, `solarRecComputedArtifacts:595`. |
| `server/_core/solarRecDashboardRouter.ts` | Dashboard procedures. `getFoundationArtifact` (Phase 2.3, line ~2680), `warmFoundation` (Phase 2.5), `getDatasetSummariesAll` (line ~3325, has `populationStatus` since Phase 2.6), `getSystemSnapshot` (line 2660 — legacy, will be retired in Phase 6 cleanup). |

---

## Verification recipe

```bash
# From productivity-hub/
git checkout main
git pull --ff-only origin main
./node_modules/.bin/tsc --noEmit --incremental false  # → 0 errors
./node_modules/.bin/vitest run                         # → 591/591 passing

# Confirm the foundation surface compiles:
./node_modules/.bin/vitest run \
  shared/solarRecFoundation.test.ts \
  server/services/solar/buildFoundationArtifact.test.ts \
  server/services/solar/foundationRunner.test.ts
# → 72/72 passing
```

After Phase 2.7 ships:

```bash
# Cross-tab consistency check (manual, on staging or local with prod-shape fixture):
# 1. Open /solar-rec/dashboard in devtools.
# 2. Network panel → look for `getFoundationArtifact` response.
# 3. Expand the response → verify summaryCounts.reporting > 0 (was 0 in Phase 2.6).
# 4. Verify reportingAnchorDateIso is set to a real date (e.g., "2026-04-01").
# 5. Verify ownershipStatus on at least one system is non-null.
```

After Phase 3.1 ships:

```bash
# Cross-tab parity:
# 1. Click Overview tab, note Reporting count.
# 2. Click Offline Monitoring tab, note "Part II Verified" count.
# 3. Click Change of Ownership tab, note "Transferred and Reporting" count.
# 4. They should agree (counted from the same foundation).
```

---

## Starter prompt for the next session

Copy-paste this into a fresh Claude session in this repo:

> I'm continuing work on the Solar REC Dashboard foundation repair. Phase 1 + 2 already shipped (8 PRs, see `docs/handoff-phase-2.7-and-3.1.md` for full state). Read that handoff in full before doing anything else — it captures the legacy reporting/ownership logic, data linkages, and gotchas you'll need.
>
> Today: ship **Phase 2.7** (foundation reporting + ownership extension) as one PR, then **Phase 3.1** (migrate Overview / Offline Monitoring / Change of Ownership tabs to consume the foundation) as a second PR.
>
> Plan file: `/Users/rhettgopaul/.claude/plans/create-implementation-plan-model-delightful-bonbon.md` (v3, canonical).
>
> Start with Phase 2.7. Read the handoff's "Phase 2.7" section, then `client/src/solar-rec-dashboard/lib/buildSystems.ts:540-650` for the legacy reference, then begin extending `server/services/solar/buildFoundationArtifact.ts`.

---

## Open questions for the next session to resolve

1. **`FOUNDATION_DEFINITION_VERSION` bump.** Phase 2.7 fills in fields that Phase 2 set to `null` / `false`. The artifact shape is unchanged, but the *meaning* of cached v1 artifacts is wrong (they say "no system is reporting" because the field was never computed). Bumping `FOUNDATION_DEFINITION_VERSION: 1 → 2` in `shared/solarRecFoundation.ts` invalidates every cached v1 artifact on first access. Recommended: **yes, bump to 2**. The hash-keyed cache will rebuild for every scope on the first dashboard load after the deploy.
2. **Phase 3.1b — defer GATS / monitoring-platform extension or include in 2.7?** The Offline Monitoring per-system maps need these fields. Two options:
   - Include in Phase 2.7 → bigger PR, simpler 3.1.
   - Keep deferred → Phase 3.1b passes through the legacy map derivations, reading only `part2EligibleCsgIds` from the foundation. Cleaner per-PR scope.
   - Recommendation: **defer** to keep Phase 2.7 surgical. Phase 3.1b's aggregator can join `monitoringPlatform` from raw rows itself.
3. **Phase 3.1's response-size bloat.** Offline Monitoring currently ships 62.6 MB per `docs/triage/dashboard-502-findings.md`. Phase 3.1's "consume the foundation" migration doesn't change the response shape, so it doesn't make this worse. But it also doesn't fix it. The plan v3 says payload pagination is **out of scope for Phase 3.1** — defer to a 3.1c follow-up. Confirm with the user before shipping 3.1; they may want to bundle the cap.
