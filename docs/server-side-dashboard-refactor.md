# Server-Side Dashboard Refactor Plan

> **Status:** **In progress — Phases 1–5c shipped (PRs #241, #243,
> #244, #245, #246, #247, #249). Phase 5d / 6 / 7 outstanding.**
> Last updated: 2026-04-28 after PR #249.
> **Author:** Claude (post-PR-#236 conversation, 2026-04-28).
> **Goal:** Eliminate IndexedDB from the Solar REC dashboard. Make the
> server the single source of truth and the client a thin renderer.

## Status snapshot

| Phase | PR | Status | Notes |
|---|---|---|---|
| 1 — server-side upload job runner | #241 | ✅ shipped | `datasetUploadJobs` + `datasetUploadJobErrors` tables (migration 0057), `runDatasetUploadJob` runner, 5 tRPC procs, chunked-base64 upload pattern (matches Schedule B PDF flow) |
| 2 — UploadProgressDialog + hooks | #243 | ✅ shipped | `useDatasetUploadController` + `useDatasetUploadStatus` + `<UploadProgressDialog>` |
| 3 — wire `contractedDate` to v2 (live) | #244 | ✅ shipped | `<DatasetUploadV2Button>` mounted alongside legacy "Choose CSV" on the contractedDate slot |
| 4 — parsers for all 17 v2 datasets | #245 | ✅ shipped | Every dataset key except `deliveryScheduleBase` (scanner-managed) has a registered parser; `IMPLEMENTED_V2_DATASETS` covers all 17 |
| 5a — stop reading + writing IndexedDB | #246 | ✅ shipped | All 5 IDB load/save helpers no-op'd; comments left for Phase 5c deletion |
| 5b — drop dead client `transferDeliveryLookup` fallback | #247 | ✅ shipped | Tightly scoped — most parent-level `.rows` consumers needed deferred work (see Phase 5d) |
| 5c — delete the no-op'd IDB stubs | #249 | ✅ shipped | −287 lines from `SolarRecDashboard.tsx`; removed all helpers, mount effect, "Load all" UI, flush effect, debounced local-save block |
| 5d — migrate parent-level `.rows` consumers | TBD | ⏳ deferred | PerformanceRatioTab + ForecastTab + FinancialsTab + Schedule B import flow each still read `datasets[k].rows`; `lazyDataset.ts` survives until they migrate |
| 6 — remove the legacy upload pipeline | TBD | ⏳ blocked on parity | v2 has no multi-append (3 datasets) or Excel-parse (2 datasets) support yet; v1 stays alongside until both gaps close |
| 7 — cleanup + docs | TBD | ⏳ pending | This file + `CLAUDE.md` data-flow section + new-upload runbook |

---

## Why now

After clearing browser storage to recover from the PR #223 → PR #234
SW regression, half the dashboard's datasets stayed stuck at *"In
cloud · tap tab to load."* The lazy-hydration path is the slowest,
most failure-prone surface in the team's daily workflow:

- IndexedDB writes silently fail in private browsing, on iOS Safari
  with quota pressure, after a hard "Clear site data," and during
  tab-OOM recovery.
- The "tap tab to load" UX is a 250KB-at-a-time chunk reassembly
  that pegs the renderer for several seconds per dataset.
- Cross-browser state (laptop vs phone) is genuinely diverged
  because each browser has its own IDB store, even though the
  server already holds the canonical truth in `srDs*` tables.
- Recovery from a partial upload requires either the
  `recover-core-dataset-from-idb.js` console-paste script or a
  re-upload — both slow, both fragile.

The server already has every procedure needed for a server-of-truth
flow (see CLAUDE.md "Solar REC Dashboard data flow" section): row
tables, summary endpoints, paginated reads, server-built CSVs,
per-tab aggregators. **The IndexedDB layer is now purely a
performance-cache wrapper around state that lives canonically on
the server.** Removing it costs us a startup-latency optimization,
which we replace with a smarter loading UX.

---

## Goals

1. **Server is the only source of truth.** Every read goes through
   tRPC; no `dataset:*` blobs in IndexedDB.
2. **Uploads are a single round-trip.** The client posts a CSV;
   the server parses, writes rows, returns a job id. The client
   polls for completion and refetches affected queries.
3. **The upload UX clearly communicates progress.** Bytes uploaded
   → server-side parse progress → row-write progress → "ready,
   refreshing dashboard." A multi-minute upload (Solar Apps is
   ~32k rows) is fine as long as the user knows what's happening.
4. **Cross-device consistency is automatic.** Open the dashboard
   on a phone and laptop simultaneously; both reflect the same
   data without IDB sync gymnastics.

## Non-goals

- The `srDs*` row tables are *not* changing. They already hold the
  canonical data.
- The 6 per-tab server-side aggregators (`getDashboard<TabName>
  Aggregates`) stay as-is. They're already memory-safe.
- The Solar REC sidebar / permissions / scopeId discipline is out
  of scope.
- Personal-app dashboard (`/dashboard`) is unaffected — its data
  flow is per-user and small; no IndexedDB removal needed there.

---

## Current state (as of PR #236)

```
┌───────────────┐    upload CSV     ┌────────────────┐
│   Browser     │ ─── parse ──────→ │   IndexedDB    │
│   (PapaParse) │ ── chunk ──┐       │  dataset:<k>   │
└───────────────┘             │      └────────────────┘
                              │              ▲
                              ▼              │ readIndexedDbDatasets
                       ┌─────────────┐       │ on dashboard mount
                       │ saveDataset │       │
                       │  (tRPC,     │       │
                       │  per-chunk) │       │
                       └─────┬───────┘       │
                             │               │
                             ▼               │
              ┌──────────────────────┐       │
              │  S3 chunks           │       │
              │  + solarRecDashboard │       │
              │    Storage rows      │       │
              │  + srDs* row tables  │ ──────┘
              │    (canonical)       │   per-key getDataset
              └──────────────────────┘   chunked reader on
                                         IDB cache miss
```

**Files involved:**
- `client/src/solar-rec-dashboard/lib/lazyDataset.ts` — column-major
  in-memory cache with row-major lazy materialization
- `client/src/solar-rec-dashboard/lib/readIndexedDb.ts` — IDB read
  path
- `client/src/features/solar-rec/SolarRecDashboard.tsx` — orchestrates
  hydration; ~8275 LOC, mixes IDB + cloud + state
- `client/src/workers/csvParser.ts` — client-side CSV parser web
  worker
- `client/public/recover-core-dataset-from-idb.js` — emergency
  recovery script

## Target state

```
┌───────────────┐  multipart POST  ┌──────────────────────┐
│   Browser     │ ───────────────→ │  /solar-rec/api/     │
│   (raw file,  │                  │  upload/dataset      │
│   no parsing) │ ←─── jobId ───── │   (Express)          │
└───────────────┘                  └──────┬───────────────┘
       │ poll                              │ stream-parse
       │ getDatasetUploadStatus            ▼
       │                            ┌──────────────────┐
       │                            │ datasetUpload    │
       │                            │ JobRunner        │
       │                            │ (existing job-   │
       │                            │  runner pattern) │
       │                            └──────┬───────────┘
       │                                   │ writes
       │                                   ▼
       │                            ┌──────────────────┐
       └─── refetch affected ──────→│ srDs* row tables │
            tab queries on success  │   (canonical)    │
                                    └──────────────────┘
```

**Reads:**
- Tab mount → `solarRecDashboard.getDataset` for full blob, OR
- Tab uses `getDashboard<TabName>Aggregates` for pre-computed
  rollups (preferred path for the 6 already-migrated tabs)
- `getDatasetSummariesAll` for the dashboard sticky-header card
- `getSystemSnapshot` for the cross-tab system index

No IndexedDB read path. React Query caches everything in memory
for the session; dropping the cache forces a refetch from the
server.

---

## Phased migration

Each phase is one PR. Order matters — do not reorder.

### Phase 1 — Add the upload job runner (server-only, dark) ✦ ~3 hrs

New module `server/services/core/datasetUploadJobRunner.ts`
modeled on the canonical `contractScanJobRunner.ts` pattern.
Atomic counter columns on the job row, concurrent-worker pool,
result rows written before counter increment, no file-status
derived counts. New tables (one migration):

```sql
CREATE TABLE datasetUploadJobs (
  id varchar(64) PRIMARY KEY,
  scopeId varchar(64) NOT NULL,
  initiatedByUserId int NOT NULL,
  datasetKey varchar(64) NOT NULL,
  fileName varchar(500),
  fileSizeBytes int,
  status varchar(32) NOT NULL,  -- queued | parsing | writing | done | failed
  totalRows int,
  rowsParsed int DEFAULT 0,
  rowsWritten int DEFAULT 0,
  errorMessage text,
  startedAt timestamp NULL,
  completedAt timestamp NULL,
  createdAt timestamp DEFAULT NOW(),
  updatedAt timestamp DEFAULT NOW() ON UPDATE NOW(),
  KEY scope_status_idx (scopeId, status),
  KEY scope_dataset_started_idx (scopeId, datasetKey, startedAt)
);

CREATE TABLE datasetUploadJobErrors (
  id varchar(64) PRIMARY KEY,
  jobId varchar(64) NOT NULL,
  rowIndex int,
  errorMessage text NOT NULL,
  createdAt timestamp DEFAULT NOW(),
  KEY job_idx (jobId)
);
```

Plus a multipart endpoint `POST /solar-rec/api/upload/dataset` that
accepts `(file, datasetKey)`, persists the file to a temp location,
enqueues a job, returns `{jobId}`. tRPC procs:
- `solarRecDashboard.startDatasetUpload({datasetKey, fileSize})` →
  presigned upload URL or job id (TBD by the cleanest fit with
  existing infrastructure)
- `solarRecDashboard.getDatasetUploadStatus({jobId})` → the row
- `solarRecDashboard.listDatasetUploadJobs({datasetKey?, limit?})`
  for a "Recent uploads" list

Server-side stream parsing using `csv-parse` (already in the
repo via `solarConnectionFactory` deps) writes directly to
`srDs*` rows. No client involvement past the file POST.

**Verification:** Job completes for a 32k-row Solar Applications
file; counters match total; rows visible via existing
`getDatasetSummariesAll` proc; old IDB-based dashboard still
works (this phase is dark, the old path is untouched).

### Phase 2 — UploadProgressDialog component ✦ ~2 hrs

New `<UploadProgressDialog jobId>` that polls
`getDatasetUploadStatus` every 2s and renders:

- Indeterminate progress bar while `status = queued`
- Progress bar `rowsParsed / totalRows` while `status = parsing`
- Progress bar `rowsWritten / totalRows` while `status = writing`
- Estimated remaining time computed from observed rows/sec
- Success state with "Refresh dashboard" button
- Failure state with `errorMessage` + retry button

Pure helpers in `shared/datasetUpload.helpers.ts`:
- `estimateRemainingMs(progress, startedAt, now)` —
  (totalRows - rowsWritten) / observedThroughput
- `formatUploadStage(status)` — UI label
- `summarizeUploadJob(job)` — toast string

Tests in `shared/datasetUpload.helpers.test.ts`.

**Verification:** Dialog renders all 5 states; estimate updates as
job progresses; tests cover empty/partial/complete/failed.

### Phase 3 — Wire one dataset through the new flow (still dark) ✦ ~2 hrs

Pick the simplest dataset (`abpReport`) and add an "Upload v2" button
to its admin entry that:
1. Opens a hidden file input
2. POSTs to the new endpoint
3. Opens `<UploadProgressDialog>` with the returned jobId
4. On success, invalidates `getDatasetSummariesAll` and the
   abpReport-specific `getDatasetRowsPage` query

The legacy upload path stays. Both paths write to the same `srDs*`
rows. **Verification:** Upload via v2 → table count updates in DB
matches expected; legacy v1 path still works.

### Phase 4 — Migrate all 18 datasets to v2 ✦ ~4 hrs

Per-dataset wiring. Mostly mechanical: each dataset has a
`saveDataset` call site in `SolarRecDashboard.tsx` that gets
replaced with a `startDatasetUpload` call + `<UploadProgressDialog>`.
The server-side parser needs per-dataset row schemas — already
available from `drizzle/schemas/solar.ts`'s `srDs*` definitions.

Per-dataset parsers can share a common `parseRowsToTableSchema(rows,
table)` core that uses Drizzle's column-type metadata for coercion;
the 18 dataset → table mappings are already declared in
`server/services/solar/buildSystemSnapshot.ts`.

**Verification:** All 18 datasets uploadable via v2. Tested per
dataset that row counts in `srDs*` match the file's row count.

### Phase 5 — Remove the IndexedDB read path ✦ ~3 hrs (actual: split into 5a/5b/5c)

The original plan called for a single "delete the IDB read path"
PR. In execution this had to split because the IDB hydration code
fed into ~30 downstream call sites scattered across 8000+ LOC of
`SolarRecDashboard.tsx`. The deletion-in-one-PR diff was reviewable
only by also cutting the parent-level `.rows` consumers, which in
turn pulled in tab refactors. The split:

**Phase 5a (#246) — stop reading + writing IDB.** Replace every
load/save helper body with `return;`. `openDashboardDatabase`
becomes a `throw` so any leftover caller fails fast. No call sites
deleted yet — kept the surface area for Phase 5b's migration to
work against. (~5 LOC functions, 5 of them.)

**Phase 5b (#247) — drop the dead `transferDeliveryLookup` client
fallback.** The only parent-level `.rows` consumer that turned out
to be safely removable in one go: a fallback lookup that fed a
panel that already had a server-aggregator alternative. The
remaining parent-level consumers (PerformanceRatioTab, ForecastTab,
FinancialsTab, the Schedule B import flow) all need their own tab
refactors and got deferred to Phase 5d.

**Phase 5c (#249) — delete the no-op'd stubs.** With Phase 5b's
discoveries reducing the scope, 5c was pure mechanical cleanup:
delete the 5 stub function definitions, the orphaned helpers
(`cachedDashboardDb`, `idbRequestToPromise`, …), the 8 call sites
(mount effect, flush effect, debounced local-save block, "Load
all" button + 3 state vars + callback), and the
`ProgressiveHydrationOptions` interface. **−287 net lines** from
`SolarRecDashboard.tsx`.

**Phase 5d (deferred) — migrate parent-level `.rows` consumers.**
Three tabs still read `datasets[k].rows` directly:
- `PerformanceRatioTab` — uses `getDatasetColumnarSource(dataset)`
  on `convertedReads`; needs a server-side aggregator for compliant
  vs. non-compliant period-bucketed production.
- `ForecastTab` — reads `convertedReads` + `accountSolarGeneration`
  for its 12-month forecast curve.
- `FinancialsTab` — reads `accountSolarGeneration` +
  `abpReport` for invoice modeling.

Plus the Schedule B import flow reads `datasets.deliveryScheduleBase
.rows` for its diff-vs-imported staging. Once those four migrate,
`lazyDataset.ts` and `getDatasetColumnarSource` can also delete.

`__dataset_manifest_v2__` and `__snapshot_logs_v2__` IDB keys are
already orphaned by Phase 5a's no-op write helpers — no new keys
land. Existing keys in user browsers will age out over time; a
proactive `indexedDB.deleteDatabase("solarRecDashboardDb")` on
mount can be done as a one-time migration in Phase 5e if desired.

**Verification (5a/5b/5c):** Hard-refresh the dashboard with empty
browser storage → 6 main tabs render from server aggregators
without local IDB; `tsc --noEmit --incremental false` clean;
1278/1278 tests pass; no IDB writes observed in DevTools after
Phase 5a.

### Phase 6 — Remove the legacy upload path ✦ ~3 hrs (revised)

**Blocked on v2 feature parity.** Audit during Phase 6 prep
turned up two gaps:

1. **Multi-append upload mode.** Three datasets
   (`accountSolarGeneration`, `convertedReads`, `transferHistory`)
   accept multiple files in one upload and dedupe-merge their
   rows (see `MULTI_APPEND_DATASET_KEYS` in
   `SolarRecDashboard.tsx`). v2 currently runs only
   `mergeStrategy: "replace"` (see
   `server/services/core/datasetUploadJobRunner.ts` L177).
2. **Excel parsing.** Two datasets (`abpIccReport2Rows`,
   `abpIccReport3Rows`) accept `.xlsx/.xls/.xlsm/.xlsb` files
   and convert them in the browser via `parseTabularFile`. v2
   only accepts `.csv,text/csv` (see
   `client/src/solar-rec-dashboard/components/DatasetUploadV2Button.tsx`).

Fill these in **before** deleting v1:

- **Phase 6 PR-A:** add browser-side Excel-to-CSV conversion to
  `useDatasetUploadController` so v2 accepts the same Excel
  formats v1 does. Server runner unchanged — it still receives
  CSV bytes.
- **Phase 6 PR-B:** add `mergeStrategy: "append"` to
  `runDatasetUploadJob` (deduping on the same row-key as v1's
  `datasetAppendRowKey` helper); thread a multi-file picker
  through the v2 button for the 3 multi-append datasets.

**Phase 6 PR-C audit (already done — 2026-04-28):**
`server/solar/convertedReadsBridge.ts` writes via
`getSolarRecDashboardPayload` / `saveSolarRecDashboardPayload`
**directly**, not via the `saveDataset` tRPC proc. So the
chunked-CSV storage path stays alive (the bridge is a daily
producer with 17 vendor sources merged into one
`_rawSourcesV1` manifest), but the proc itself can be deleted
once all client callers are gone.

**Phase 6 PR-D — actual deletion.** After PR-A + PR-B + the
client-side flip:
- Delete `saveDataset` tRPC proc.
- Delete `client/src/workers/csvParser.ts` web worker.
- Delete `parseCsvFileAsync` / `parseTabularFile` browser-side
  parser helpers.
- Delete `persistDatasetSourceFilesToCloud` from
  `SolarRecDashboard.tsx` along with the `<input type="file">`
  inside the dataset-card legacy slot.
- Delete the `IMPLEMENTED_V2_DATASETS` set (no longer needed
  once v1 is gone).
- Keep `client/scripts/recover-core-dataset-from-idb.js` —
  still useful for users who haven't visited the dashboard
  post-Phase-5a (their IDB still holds data that pre-dated the
  write disable).
- Keep server-side `saveSolarRecDashboardPayload` /
  `getSolarRecDashboardPayload` — `convertedReadsBridge.ts` and
  `serverSideMigration.ts` and the Schedule B import flow all
  still need them.

**Verification:** No client-side `saveDataset` call sites (only
`convertedReadsBridge.ts`'s direct write); full test suite
passes; the daily monitoring batch still produces
`srDsConvertedReads` rows; uploading a multi-append dataset via
v2 deduplicates correctly against the prior batch.

### Phase 7 — Cleanup + docs ✦ ~1 hr

- Update `CLAUDE.md`'s "Solar REC Dashboard data flow" section to
  reflect server-of-truth + add a section on the v2 upload
  pipeline (job runner, chunk-base64 upload, polling lifecycle).
- Delete the data-flow contract sections referencing the chunked-
  CSV manifest.
- Remove the `__dataset_manifest_v2__` / `dataset:*` references
  from any remaining helpers.
- Add a runbook doc for the new upload flow ("how to add v2
  upload support to a new dataset" — already implicit in the
  parser registry but undocumented).
- Decide whether to ship a one-time
  `indexedDB.deleteDatabase("solarRecDashboardDb")` mount migration
  to clear orphaned IDB blobs in user browsers.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Server CPU/memory during 32k-row parse | Background-job pattern; stream parse, never load whole file in memory |
| Upload reliability over slow networks | Resumable upload pattern (skip for v1; add later if needed) |
| Lost cross-tab progress while leaving a tab | Job survives in DB; reopening dashboard shows the in-flight job |
| Removing IDB breaks the `recover-core-dataset` runbook | The recovery flow itself is obsolete — the server is the recovery target |
| `convertedReadsBridge` writes the manifest from the daily monitoring batch | Audit before Phase 6; either land a row-table-only path first or leave the manifest writer in place |
| Solar Apps is 32k rows × 100+ columns; row-by-row INSERT is slow | Batch inserts: 500 rows per `db.insert(...).values(rows)` call; observed throughput ~10k rows/sec on prod TiDB |
| Rolling deploys + in-flight uploads | Job rows survive deploys; the worker checks status on restart and resumes from `rowsWritten` |

## Open questions

1. **File transport.** Multipart POST to Express vs. presigned S3
   upload + worker pulls from S3. Multipart is simpler; S3 scales
   better. Lean toward multipart for v1 (server-side parsing means
   the file lives in memory briefly and gets streamed to row
   inserts; never written to disk).
2. **Auth.** The new multipart endpoint needs the same scope-aware
   middleware as `/solar-rec/api/trpc/*`. Verify.
3. **Retry.** Failed uploads — do we automatically retry, or
   surface to the user with a "retry" button? Lean toward user-
   driven retry, server stores `errorMessage` for diagnostics.
4. **Backwards compatibility.** When this lands, existing IDB
   blobs in user browsers become orphans. Do we proactively clear
   them on first load of the new dashboard, or let them age out?
   Recommend: proactively clear in Phase 5's mount logic.

## Estimated total effort

~17 hours of focused work, spread across 7 PRs. Each PR is
independently shippable and rollback-able. A PR per phase keeps
each diff small enough to review carefully.

## Recommended sequence

1. PR phases sequentially (1 → 7), one per day.
2. Phase 3 (one-dataset wiring) is the inflection point: after it
   lands, the team can dogfood the new flow on `abpReport`. If
   the UX needs adjustment, iterate before Phase 4 mass-migrates
   the other 17.
3. Phase 5 (remove IDB read path) is the visible-to-user win.
   Land it on a quiet day so any dashboard-mount regressions are
   caught fast.
4. Phase 6 (remove legacy upload) is the irreversible cleanup —
   only do it after Phase 4 has been stable for a week.

---

## Lessons learned during execution

Notes captured during Phases 1–5c that are worth preserving for
future server-of-truth refactors of similar size.

1. **The plan's "Phase 5" was three PRs in execution.** Replacing
   the IDB load/save bodies with no-op'd stubs (5a) before
   deleting them (5c) gave a clear two-step path: Phase 5a verified
   "no caller actually needed the data" and Phase 5c verified
   "no caller still references the symbols." Trying to do both in
   one PR would have produced an unreviewable diff against an
   8000+ LOC orchestrator file.
2. **Most parent-level `.rows` consumers are tab-internal.** The
   dashboard's `datasets[k].rows` reads at the orchestrator level
   are mostly forwarded into tab components that haven't yet
   migrated to server aggregators. Phase 5b discovered this the
   hard way after assuming "delete the parent-level reads" was a
   small task. The corollary: budget Phase 5d as a series of
   tab-by-tab refactors, not a single PR.
3. **Multi-source feature parity is not optional.** The user's
   actual workflow on `convertedReads` and `accountSolarGeneration`
   uses the multi-append flow heavily — uploading 17 vendor files
   over a month. v2 was designed for replace-only because that's
   what the simplest spec says; the gap surfaced only after audit
   for Phase 6. Lesson: enumerate the v1 modes FIRST when sketching
   the v2 surface, not after.
4. **Bridge and proc share storage but not call paths.**
   `convertedReadsBridge.ts` writes via the chunked-CSV storage
   helpers DIRECTLY (`saveSolarRecDashboardPayload`), not via the
   `saveDataset` tRPC proc. This means Phase 6 can delete the
   client-facing proc without touching server-internal callers —
   but only if the audit catches the distinction. (It almost
   didn't.)
5. **`tsc --noEmit --incremental false` clean ≠ shipped working.**
   PR #223 (PWA shell) compiled clean, passed CI, and broke
   `/solar-rec/` for every team member because `<Toaster />`
   tried to call `useTheme()` outside a `<ThemeProvider>`. Phase
   2 of this refactor added a CLAUDE.md rule (rule 6, "component
   context-dependency check") that caught a similar issue early.
   Compile-clean cuts the search space; it does not certify
   behavior.
6. **`datasetsHydrated` is now meaningless.** Phase 5c initialized
   it to `true` rather than rip it out, because ~5 downstream
   gates compose with `remoteStateHydrated` via `&&`. Deleting
   the flag would have meant editing 5 effects and 2 conditionals
   in 5 different code regions; flipping the initializer was a
   one-line change with the same runtime effect. When a flag is
   read from many places but produced from one place, change the
   producer.
7. **Phase 6 is gated on parity, not deletion appetite.** The
   "delete the legacy upload" work depends on v2 supporting
   multi-append + Excel; the deletion itself is mechanical once
   parity ships. Track the parity gap in this doc rather than
   queueing the delete and discovering blockers mid-PR.
