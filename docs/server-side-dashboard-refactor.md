# Server-Side Dashboard Refactor Plan

> **Status:** Draft, awaiting approval.
> **Author:** Claude (post-PR-#236 conversation, 2026-04-28).
> **Goal:** Eliminate IndexedDB from the Solar REC dashboard. Make the
> server the single source of truth and the client a thin renderer.

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

### Phase 5 — Remove the IndexedDB read path ✦ ~3 hrs

Delete:
- `client/src/solar-rec-dashboard/lib/readIndexedDb.ts`
- `client/src/solar-rec-dashboard/lib/lazyDataset.ts` (column-major
  cache no longer needed when nothing is hydrated client-side)
- IDB read calls in `SolarRecDashboard.tsx`
- The `dataset:*` IDB writes from the legacy upload path
- The `__dataset_manifest_v2__` and `__snapshot_logs_v2__` keys

Replace dashboard mount logic with eager `getDatasetSummariesAll`
+ `getSystemSnapshot` queries; tabs hydrate their own data via
existing aggregator queries.

`SolarRecDashboard.tsx` should drop ~500 LOC of hydration glue.

**Verification:** Hard-refresh the dashboard with empty browser
storage → all 18 dataset summaries populate from the server within
~2s; tabs render correctly when clicked; no IDB writes observed in
DevTools.

### Phase 6 — Remove the legacy upload path ✦ ~2 hrs

Delete:
- `saveDataset` tRPC proc (rename to `saveDatasetLegacy` for one
  release as a kill-switch; remove next release)
- `client/src/workers/csvParser.ts` web worker
- `client/public/recover-core-dataset-from-idb.js`
- The chunked-CSV manifest write path (server-side)
- `convertedReadsBridge.ts`'s chunked-CSV manifest write —
  **CHECK**: this is used by the monitoring batch and writes 17
  vendors per day. Need to verify it has a row-table-only
  alternative. Defer this sub-step if not.

**Verification:** No remaining `saveDataset` call sites; full test
suite passes; daily monitoring batch still produces
`srDsConvertedReads` rows.

### Phase 7 — Cleanup + docs ✦ ~1 hr

- Update `CLAUDE.md`'s "Solar REC Dashboard data flow" section to
  reflect server-of-truth.
- Delete the data-flow contract sections referencing the chunked-
  CSV manifest.
- Remove the `__dataset_manifest_v2__` / `dataset:*` references
  from any remaining helpers.
- Add a runbook doc for the new upload flow.

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
