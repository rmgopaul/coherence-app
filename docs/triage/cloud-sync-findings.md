# Cross-browser / Cross-user Solar REC Cloud Sync — Triage Findings

> Task 1.2a per `docs/execution-plan.md`. Findings only — no fix attempted.
> Author: Claude (investigation). Date: 2026-04-23.

## TL;DR

- **Cloud-persisted metadata, lazy row hydration.** Datasets are stored in cloud (DB + S3-compatible storage) with `CLOUD VERIFIED` badges reflecting metadata-level sync status. Actual row data only loads into client state when the user clicks into that dataset's tab.
- **Fresh-browser "populated dashboard with no data" illusion is by design.** Dashboard tiles show row counts (from server-side snapshot over the `srDs*` tables) even though client-side `datasets` state is still empty.
- **Cross-user visibility blocked.** Cloud storage paths are keyed by `userId`, not `scopeId`. User A's upload lives at `solar-rec-dashboard/userA/…`; user B in the same team scope queries `solar-rec-dashboard/userB/…` and sees nothing. **Hard blocker for Phase 5.**
- **Typed `srDs*` tables do carry full rows** with `scopeId` — so cross-user visibility is already possible at the database layer, but the JSON-manifest hydration path that drives the editable `Step 1` panels is per-user only.
- **"CLOUD VERIFIED" semantic.** Badge means "metadata present in cloud, chunks recoverable," not "rows accessible without further action." Label mismatch is the user-facing part of the bug.

## Data flow per dataset type

All three flavors share the same client-side lazy-hydration pattern; they differ in how rows are produced on the server.

### Single-file datasets (Solar Applications, ABP Report, etc.)

1. **Upload.** CSV parsed in-browser; split into chunks (≤ `REMOTE_DATASET_CHUNK_CHAR_LIMIT` ~ 500 KB). A top-level manifest lists chunk pointers.
2. **Persist.** Chunks uploaded to cloud storage; DB row written in `solarRecDashboardStorage`; `solarRecDatasetSyncState` flips `storageSynced=true` / `dbPersisted=true`.
3. **Hydrate on dashboard open.** `remoteDashboardStateQuery` runs (staleTime 5 min, no window-focus refetch). IndexedDB loads the local cached copy if any.
4. **Hydrate on tab open.** When the user clicks a tab, `loadRemoteDatasets` useEffect fetches chunks via `getRemoteDataset.mutateAsync()`, reassembles them, and populates `datasets` state. **Row data does not reach the client until this click.**

### Multi-file append datasets (Account Solar Generation, Transfer History)

1. **Upload.** Each file parsed; rows deduped per `rowKeyFields`. Chunks stored separately; manifest updated with a new source entry.
2. **Persist.** Same as single-file. DB + storage sync, `storageSynced` flag set.
3. **Hydrate.** Same lazy-on-tab-open pattern.

### Shared-settlement datasets (Delivery Schedule / Schedule B)

1. **Upload.** Server-side PDF scanner writes rows directly to `srDsDeliverySchedule`. No client upload path.
2. **Persist.** Rows live in the typed `srDs*` table; the client cloud-manifest may not exist.
3. **Hydrate.** Server snapshot (`getSystemSnapshot`) returns rows from `srDsDeliverySchedule`. Client does not hydrate from cloud manifest for this dataset type.

## Dataset behavior matrix

| Dataset | Cloud-persisted? | Auto-loads on dashboard open? | Loads on tab open? | Fresh-browser expected behavior |
|---|---|---|---|---|
| Solar Applications | Metadata + chunks in cloud/DB; rows in `srDsSolarApplications` | No — IDB only on mount | Yes — via mutation | Tiles show cloud badge + count from server snapshot; editable rows empty until tab opened |
| ABP Report | Metadata + chunks + `srDsAbpReport` rows | No | Yes | Same as above |
| Generation Entry | Metadata + chunks + `srDsGenerationEntry` | No | Yes | Same as above |
| Account Solar Generation | Metadata + chunks + `srDsAccountSolarGeneration` | No | Yes | Same as above |
| Contracted Date | Metadata + chunks + `srDsContractedDate` | No | Yes | Same as above |
| Delivery Schedule | Rows only in `srDsDeliverySchedule` (server PDF scanner); no client cloud manifest | No — server snapshot is authoritative | Server query only | Server returns rows via `getSystemSnapshot`; no client cloud fetch |
| Transfer History | Metadata + chunks + `srDsTransferHistory` | No | Yes | Same as Solar Applications row |

"Metadata + chunks" = JSON manifest (with chunk pointers) in cloud storage + DB row; `datasets[key].rows` remains `[]` on the client until hydration runs.

## Findings

### F1 — Client row hydration is lazy-on-tab-open, not eager-on-mount
**Confidence:** **HIGH**
**Evidence:** `client/src/features/solar-rec/SolarRecDashboard.tsx:2097-2115` (`remoteDashboardStateQuery` with `staleTime: 5min`, `refetchOnWindowFocus: false`); lines 2527-2574 (mount-time useEffect computes hashes, no fetch); lines 5045-5360 (the `loadRemoteDatasets` loop that actually fetches chunks, triggered only on tab-change or explicit "Load All").
**Implication:** A teammate on a fresh browser sees tiles with row counts and "CLOUD VERIFIED" badges, but the `Step 1` editable panel is empty until they click into a tab that uses the dataset. For users who don't immediately open their landing tab, the dashboard appears populated but isn't.

### F2 — "CLOUD VERIFIED" badge reflects metadata cloud-sync, not row-data accessibility
**Confidence:** **HIGH**
**Evidence:** `server/routers/solarRecDashboard.ts:475-495` (`getDatasetCloudStatuses`); `server/services/solar/datasetCloudStatus.ts:164-248` (`getRawDatasetCloudStatuses`). Badge fires when (a) top-level payload recoverable from DB or storage AND (b) all referenced chunks recoverable. No check that client-side rows have been hydrated.
**Implication:** The label is technically correct but users reasonably read it as "data is ready to use." Until rows hydrate on tab-open, it isn't.

### F3 — Typed `srDs*` tables hold full rows; client state does not persist them
**Confidence:** **HIGH**
**Evidence:** `drizzle/schemas/solar.ts:545-737` — seven `srDs*` tables, each with `scopeId` and `batchId`. `server/services/solar/datasetRowPersistence.ts` persists rows via chunked inserts. Client state in `SolarRecDashboard.tsx:2020` initializes `datasets` as empty; rows populate only when `loadRemoteDatasets` runs at line 5045+.
**Implication:** Server has full row data keyed by `scopeId` (good for cross-user access); client discards it unless a tab is opened (bad for fresh-browser UX). No "preload all rows on scope mount" path exists on the client.

### F4 — Cross-user visibility gap: cloud-dataset paths keyed by `userId`, not `scopeId`
**Confidence:** **HIGH**
**Evidence:**
- `server/routers/solarRecDashboard.ts:425-432` — `getState` reads from `solar-rec-dashboard/${ctx.user.id}/state.json`
- Line 467 — `getDataset` resolves storage via `resolveDatasetUserId(input.key, ctx.user.id)`
- Line 606 — `saveDataset` same pattern
- `drizzle/schemas/solar.ts:44-91` — `solarRecDashboardStorage` has `userId` column, no `scopeId`
- `solarRecDatasetSyncState` (line 68-94) — same: `userId`, no `scopeId`

Only the 7 `srDs*` tables have `scopeId`.
**Implication:** User A uploads → `solar-rec-dashboard/userA/datasets/solarApplications.json`. User B (same scope) calls `getDataset({ key: "solarApplications" })` → server looks in `solar-rec-dashboard/userB/…` → empty. **Phase 5's "all teammates see all data in that scope" requirement is not met today** by the cloud-manifest hydration path; it IS met by server-computed `srDs*` queries like `getSystemSnapshot`. The editable `Step 1` panels use the broken path.

### F5 — Only core datasets sync to typed `srDs*` tables; non-core datasets stay as JSON manifests
**Confidence:** **HIGH**
**Evidence:** `client/src/features/solar-rec/SolarRecDashboard.tsx:2296-2399` (`triggerCoreDatasetSrDsSync` fires only for keys in `CORE_DATASET_KEYS_FOR_SNAPSHOT` at lines 2168-2180); `server/routers/solarRecDashboard.ts:330-345` (`syncCoreDatasetFromStorage` starts a background job).
**Implication:** For the 7 core datasets, server eventually populates `srDs*` rows, so server-side snapshots work. For non-core datasets (e.g. `convertedReads`, ICC Reports), no normalized table exists — they live only as cloud JSON manifests, and the cross-user gap (F4) is uncloseable without a schema change.

### F6 — Dashboard tile row counts come from server snapshot, not client state
**Confidence:** **HIGH**
**Evidence:** `server/routers/solarRecDashboard.ts:2250-2270` (`getSystemSnapshot` returns computed rows from `srDs*`); tile UI reads from that snapshot, not from `datasets[key].rows.length`.
**Implication:** Tiles can show "47 Solar Applications" even though client `datasets.solarApplications.rows` is `[]`. This is the mechanism behind the "populated dashboard, no data" illusion.

### F7 — Tab-priority hydration is declared but not actually prioritized
**Confidence:** **HIGH**
**Evidence:** `TAB_PRIORITY_DATASETS` (lines 451-484) is referenced only in `buildHydrationPriorityKeys()` at mount to seed the priority list; the actual fetch loop at 5045+ loads all hydration keys in parallel with bounded concurrency, without re-ordering by the currently active tab.
**Implication:** Tab-switch hydration is slower than necessary. A user landing on Performance Ratio waits for ~15 datasets to hydrate before their tab is responsive, even though only a subset is needed.

## Root-cause analysis

The "CLOUD VERIFIED, but no data on fresh browser" gap has five layered causes:

1. **Lazy client hydration is architectural.** Cloud path was designed for fast IDB cache on warm browsers; cold hydration of 15+ datasets was considered too slow for mount. Tab-open fetches are the intended "cold path."
2. **Tile counts come from server snapshot, decoupling "count shown" from "rows hydrated."** Users can see counts without rows ever existing in client state.
3. **IndexedDB empty on fresh browser.** No warm cache; nothing to show until cloud hydration runs. And cloud hydration is lazy (per F1).
4. **Cloud storage paths are per-user.** Even if we fix the lazy-hydration issue for user A, user B still won't see user A's datasets because they're stored at different paths (F4).
5. **Badge labels misrepresent state.** "CLOUD VERIFIED" suggests readiness, not "tap to load."

## Cross-user visibility gap (Phase 5 prerequisite)

**Critical.** Three tRPC procedures (`getState`, `getDataset`, `saveDataset`) all key on `ctx.user.id`. No team-wide hydration path exists for the JSON-manifest cloud storage.

- `server/routers/solarRecDashboard.ts:425-432` — `getState` hardcodes `ctx.user.id`
- `server/routers/solarRecDashboard.ts:467` — `getDataset` calls `resolveDatasetUserId(input.key, ctx.user.id)`
- `server/routers/solarRecDashboard.ts:606` — `saveDataset` same pattern
- `drizzle/schemas/solar.ts:44-91` — `solarRecDashboardStorage` and `solarRecDatasetSyncState` have `userId`, not `scopeId`

Migrating the cloud-manifest path to `scopeId` requires:
- Schema migration on `solarRecDashboardStorage` and `solarRecDatasetSyncState` (add `scopeId`, backfill, drop `userId` or keep as audit).
- Storage-path rewrite from `solar-rec-dashboard/${userId}/…` to `solar-rec-dashboard/${scopeId}/…`, with a one-time migration of existing files.
- Procedure rewrites so `getState` / `getDataset` / `saveDataset` resolve by scope.

## Open questions / data I couldn't access

- **Live fresh-browser test** on the deployed instance. This investigation is code-level; would confirm tile counts appear before rows do.
- **`TAB_PRIORITY_DATASETS` intent.** Was it meant to stream tab-specific datasets first? Answer would tell us whether fixing F7 is a bug fix or a never-enabled feature.
- **Cross-user scenario test.** Seed a second user in the same scope; confirm the empty-state behavior directly.

## Proposed fix direction (NOT yet written)

### (i) Make the UI label truthful (smallest, first)
Change "CLOUD VERIFIED" to "Cloud Synced (tap to load)" or similar; add tooltip explaining tab-open hydration. UI-only; low risk; un-fakes the populated-dashboard illusion immediately.

### (ii) Make cross-browser loading actually work (client refactor)
Add eager hydration on dashboard mount for datasets whose cloud status is verified — fetch chunks immediately into `datasets` state. Add "Eager Load All" toggle for users who want to opt in per-session. Medium effort; client-only.

### (iii) Make cross-user loading work (Phase 5 prerequisite — critical)
Migrate cloud-manifest storage from per-user to per-scope:
- Schema migration: add `scopeId` to `solarRecDashboardStorage` and `solarRecDatasetSyncState`; backfill to `ownerUserId`'s scope; drop or audit-retain `userId`.
- Storage-path migration: move existing files from `solar-rec-dashboard/${userId}/…` to `solar-rec-dashboard/${scopeId}/…`; update resolver.
- Procedure rewrites: `getState` / `getDataset` / `saveDataset` to resolve by `ctx.scopeId` (or equivalent).
- Client: no change needed once server paths are scope-keyed.

Large refactor, but it's the only path that unblocks Phase 5. Fix (i) and (ii) can ship ahead of (iii); (iii) should be its own gated PR.

## What happens next

Task 1.2b (fix PR) follows, contingent on user acknowledgement of this report. Recommended sequence:
1. Ack findings.
2. Decide whether to ship (i), (ii), and (iii) together or separately. Recommendation: (i) + (ii) together, (iii) as its own PR due to migration complexity.
3. Open 1.2b as the first of these fix PRs.
