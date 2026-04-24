# Productivity Hub — Execution Plan (v4)

## What Changed from v3

- **Permission model changed from flat role to per-module ACL matrix.** All teammates get access to all *data* on solar-rec (single team scope, team-wide visibility), but each user has a separate permission on each module: `none` / `read` / `edit` / `admin`. Set from the solar-rec Settings page.
- **Admin-buildable permission presets.** Rhett (or any user with admin on `team-permissions`) builds named presets in Settings. Presets are reusable at invite time and applicable to existing users. Presets are templates, not live bindings — editing a preset does not retroactively change previously-assigned users.
- **Phase 5 restructured.** Old Task 5.0 (onboarding with a single role) is replaced by two tasks: new Task 5.1 (permission matrix infrastructure + preset manager) and new Task 5.2 (onboarding that uses it). Migration tasks renumbered to 5.3–5.11.
- **Migration mechanics updated.** Every migrated procedure must be wrapped with `.requirePermission(moduleKey, level)`. Every migrated page must gate write controls by the viewer's permission.
- **Phase 9 clarified.** Portfolio workbench is its own module; permissions apply.

## What Changed from v2 (for reference)

- **New Phase 1 inserted** for two user-blocking issues: Health Connect data flow and cross-browser cloud sync.
- **All other phases renumbered** by +1.
- **Phase 4 gained three tasks**: Enphase V2 removal, shared "Ask AI about this data" component, Todoist-from-Notebook hotkey.
- **Ground Rules**: investigation-first tasks produce findings before fixes.
- **Architectural direction**: CSG ID canonical from Solar Applications; vendor API tokens team-wide via `solarRecTeamCredentials`.

---

## Purpose

This plan combines the highest-confidence findings from two independent code reviews (Agent A and Agent B), sequenced so that earlier work protects or accelerates later work. It reflects the architectural split along a single seam: **main stays single-user and personal; `/solar-rec/*` becomes the multi-user business surface.**

This is not a suggestion list. It is a sequenced plan with explicit gates. Do not reorder phases. Do not skip verification. Do not mark an item done until its Definition of Done is met on the running application.

---

## Architectural Direction

The app has two homes, and every feature belongs to exactly one:

**Main app (`/`) — single-user, personal productivity.** Owner: Rhett only. Keeps front-page dashboard and all view variants, legacy dashboard, King of the Day, DropDock, Canvas, Notebook, Supplements, Habits, Health, Sleep Notes, Clockify timer, Global Feedback widget, Settings (personal), and all feed sources that serve the personal dashboard: Todoist, Gmail, Calendar, Drive, WHOOP, Samsung Health / Health Connect, markets/stocks, weather, news, sports, ChatGPT, daily/weekly brief.

**Solar-REC app (`/solar-rec/*`) — multi-user, team business surface.** Owners: Rhett's team (Amy, Natalie, Ericka, Bethany, Ben, Jassi, Leticia, Brissa, Ivan, and future hires), with role-based access per `solarRecUsers` / `solarRecInvites` / `solarRecScopes`. Holds the Solar REC Dashboard and all its tabs, the daily monitoring scheduler, all 17 (soon 16 — Enphase V2 is deprecated) solar vendor adapters, all meter-read pages, `monitoringApiRuns`, all four job runners (contract scan, DIN scrape, Schedule B, CSG Schedule B), ABP Invoice Settlement, Early Payment, Invoice Match, Address Checker, Zendesk Ticket Metrics, Contract Scanner, Deep Update Synthesizer.

**Canonical system key.** The `CSG ID` is the canonical identifier for every system in the portfolio. It comes from the **Solar Applications** dataset (described in the dashboard as "Main system list with system size, price, and contract status"). The ABP ID is a secondary identifier created after the CSG ID and may or may not exist on a given system. Every workbench view, every mapping, every drill-in in Phase 9 keys off the CSG ID from Solar Applications.

**Vendor API tokens.** Shared team-wide, stored in `solarRecTeamCredentials`. Everyone on the team uses the same monitoring tokens. Credential rotation by one person affects everyone — that's an accepted tradeoff. Per-user vendor credentials are not supported on solar-rec.

**Team data visibility.** All teammates are in a single shared scope and can see all data in that scope. There is no data-level partitioning within the team — if two users are on the same team, they see the same Solar REC datasets, the same ABP settlement runs, the same contract scan results. This is intentional: operators need to pick up each other's work mid-stream.

**Per-module permissions.** What differs per user is *what they can do* in each module, not *what data they can see*. Every solar-rec feature is registered as a module with a `moduleKey`. Each user has a permission per module: `none` (not in sidebar), `read` (view only), `edit` (view + run jobs + modify), `admin` (edit + module-level settings). Rhett sets this matrix from the solar-rec Settings page. A scope owner (`solarRecScopes.ownerUserId`) has implicit admin on every module including the permissions module itself — this prevents accidental lockout. Users with `isScopeAdmin=true` also have implicit admin everywhere, for delegation.

**Consequences of the split:**

- The CLAUDE.md "dual-router trap" warning becomes a "dual-router boundary" rule: business features go in `server/_core/solarRecRouter.ts`; personal features go in `server/routers.ts`. Confusion between the two was always the real bug.
- The Samsung webhook single-shared-key design on main is fine permanently; annotate, don't fix.
- `solarRecScopes` is the multi-tenant axis; every migrated business table needs a `scopeId` (or equivalent). Some already have it; most do not.
- The standalone solar-rec Google OAuth is the team auth path. Rhett's personal Google tokens stay on main and never mingle with team credentials.
- The standalone solar-rec app's current three monitoring pages become the kernel of a much larger app.

**Update CLAUDE.md as part of Task 4.1 to reflect all of the above.**

---

## Ground Rules for the Executing Agent

1. **Read `CLAUDE.md` in full before touching any code.** Re-read the routing section before modifying anything under `server/`. Know which router you are editing and why before you edit.

2. **Verify TypeScript with `./node_modules/.bin/tsc --noEmit --incremental false` after every task.** The incremental cache lies. If tsc is not clean, the task is not done.

3. **Check for a dirty worktree before starting each task.** `git status --short`. If there are uncommitted changes that are not yours, stop and ask.

4. **One task, one commit, one PR.** Each task has a clear Definition of Done; each PR satisfies exactly one.

5. **Verify every claim before fixing it.** The reviews these tasks came from are high quality but not infallible. For each bug claim, open the cited file and confirm the bug exists as described *before* writing a fix. If the bug is not as described, stop and report — do not invent a different bug to fix.

6. **Definition of Done requires evidence.** Every task must close with: the exact tsc command output showing 0 errors, a description of the manual test, expected and actual behavior, and — where applicable — before/after log output or screenshots. No evidence, not done.

7. **Investigation-first tasks produce findings before any fix.** Any task marked `[INVESTIGATE-FIRST]` requires two deliverables: first a findings report, then a separate PR that fixes based on findings. Do not write fix code before the findings report is acknowledged.

8. **If uncertain, stop and ask.** If intent is genuinely unclear and reading more code cannot resolve it, pause and ask rather than guess.

9. **Do not refuse unless it is malware.** If a task as written seems wrong, propose an alternative and ask — do not silently skip it.

10. **Use `_checkpoint` and `_runnerVersion` markers on anything job-like**, per CLAUDE.md. New long-running jobs must expose a raw-state debug endpoint.

11. **Know which side you're on.** Before editing a file under `client/src/` or `server/`, state explicitly in the PR description: "This change lives on [main / solar-rec] because [reason]." This prevents architectural drift.

---

## Phase 0 — Intake

Produce a short intake report confirming:

- CLAUDE.md has been read and summarized (one paragraph).
- Current branch, current `git status --short`, current tsc state on `main`.
- For each bug claimed in Phase 2 below, one line confirming or rejecting the bug based on actually opening the cited file. If any Phase 2 bug is rejected ("the code does not behave as the review claims"), stop and ask before proceeding.
- Inventory of files relevant to Phase 1 triage items so the agent knows the code surface it's about to investigate.

**Gate:** Do not begin Phase 1 until the intake report is delivered and acknowledged.

---

## Phase 1 — Urgent User-Blocking Triage `[INVESTIGATE-FIRST]`

Both items here are active problems with unknown causes. Each splits into an investigation task (findings only) and a fix task (after findings are acknowledged). Do not skip the separation.

### Task 1.1a — Investigate Health Connect / Samsung Health data gap
- **Problem.** Rhett has not received Health Connect data in weeks. The Android app (or Samsung Health integration) repeatedly hits a rate limit that locks the sync for ~24 hours. When the window opens, sync fails again almost immediately, producing the same lockout.
- **Investigation scope.**
  1. Identify the actual code paths involved. Candidates: Android app that reads Health Connect (may or may not be in this repo); `sunpower-reader` Expo app; `server/oauth-routes.ts` Samsung webhook handler at line ~440; `server/_core/pinGate.ts:45` allow-list for webhook paths; any `/webhooks/samsung-health*` handlers; the `samsungSyncPayloads` table.
  2. Determine *which* rate limit is tripping. Samsung Health API quota? Google Health Connect API quota? Server-side `express-rate-limit` on the webhook endpoint? Helmet / CORS rejection masquerading as rate limiting?
  3. Determine push frequency: how often does the mobile app POST to the webhook? Is it per-metric-change, per-minute, per-sync-cycle? Is there retry-on-failure that amplifies the rate once the limit is hit (classic feedback-loop failure)?
  4. Check server logs: look at `samsungSyncPayloads` rows over the last 30 days. When did the last successful payload arrive? What HTTP response codes are the mobile app seeing? If no mobile app logs exist, note that as a finding.
  5. Determine whether this affects `dailyHealthMetrics` write path; if Samsung Health is the sole source for certain metrics, those metrics have been stale for weeks.
- **Deliverable (one PR with no code changes, just a markdown findings report at `docs/triage/health-connect-findings.md`).**
  - A data-flow diagram from device → mobile app → server → DB.
  - The exact rate limit being hit, with evidence (log excerpt, response code, rate-limit header if present).
  - Root cause hypothesis with confidence level.
  - Proposed fix, or — if the fix requires a change in a repo Agent B doesn't have access to — explicit note of that.
- **Do not write a fix in this task.**

### Task 1.1b — Fix Health Connect data flow
- **Prerequisite.** Task 1.1a's findings report acknowledged.
- **Fix.** Based on findings. Likely candidates: lower push frequency, add exponential backoff on 429, batch multiple metrics per POST, add circuit breaker that goes quiet for N minutes on rate-limit to avoid amplifying the lockout, switch from push to pull (server polls Health Connect API), or fix a bug in the retry loop.
- **Definition of Done.** (a) Sync resumes within 1 hour of fix deployment. (b) `samsungSyncPayloads` shows a normal cadence of successful payloads over the subsequent 24 hours. (c) `dailyHealthMetrics` resumes being populated. (d) Rate-limit lockouts do not recur in a 7-day observation window.
- **Evidence.** 24-hour row counts of `samsungSyncPayloads` before fix / after fix. HTTP response code distribution before / after.

### Task 1.2a — Investigate cross-browser Solar REC dataset loading
- **Problem.** On a fresh browser (or any browser that doesn't have local IndexedDB/localStorage cache), the Solar REC Dashboard shows dataset tiles with row counts, "CLOUD VERIFIED" badges, and last-updated timestamps — but the data does not actually load until that dataset's tab is opened. Some data appears to not load at all. This means a teammate logging in for the first time may see a "populated" dashboard that has no actual data behind it. **This is a blocker for Phase 5 (the team migration).**
- **Investigation scope.**
  1. Map the actual data flow from CSV upload → cloud storage → retrieval. Candidate files: `server/services/solarRec/` storage handlers; `solarRecDashboardStorage`, `solarRecDatasetSyncState`, `solarRecImportBatches`, `solarRecImportFiles`, `solarRecActiveDatasetVersions`, and the seven normalized `srDs*` tables in `drizzle/schemas/solar.ts`; `client/src/features/.../SolarRecDashboard.tsx`.
  2. Specifically determine: is the "CLOUD VERIFIED" badge reflecting (a) metadata-only cloud persistence with rows local-only, (b) full cloud persistence with lazy client-side hydration, or (c) full cloud persistence with a bug in the hydration path?
  3. Trace the tab-switch behavior. The UI says "Full rows reload when this dataset's tab is opened" — confirm that's accurate and identify which datasets, if any, never reload.
  4. Test with a fresh browser: open the app with cleared storage, log in, observe what loads and what doesn't. Document every dataset's behavior.
  5. Identify every place the word "cloud" or "CLOUD_VERIFIED" appears as a UI label and confirm whether each instance means what users think it means.
- **Deliverable.** Markdown findings report at `docs/triage/cloud-sync-findings.md` covering:
  - Data flow diagram per dataset type (single-file datasets, multi-file append datasets, shared-settlement datasets).
  - A table of every dataset in the dashboard with columns: Cloud persisted? | Auto-loads on dashboard open? | Loads on tab open? | Observed behavior on fresh browser.
  - Root cause of the gap between "CLOUD VERIFIED" and "data actually accessible to a new user."
  - Proposed fix strategy, scoped separately for: (i) make the UI label truthful, (ii) make cross-browser loading actually work, (iii) make cross-user loading work (this is the Phase 5 prerequisite).
- **Do not write a fix in this task.**

### Task 1.2b — Fix cross-browser / cross-user cloud sync
- **Prerequisite.** Task 1.2a's findings report acknowledged.
- **Fix.** Based on findings. Likely includes: making the hydration path eager on dashboard open rather than lazy on tab open; fixing any broken cloud persistence for specific dataset types; correcting misleading UI labels; and — critically — ensuring that data persisted by user A is retrievable by user B when both users are in the same `solarRecScope`.
- **Definition of Done.**
  1. Rhett can log in on a browser with no prior storage and see every "CLOUD VERIFIED" dataset populate without re-uploading.
  2. A seeded second user in the same scope can log in, see the same datasets, and open the Performance Ratio tab without any upload step.
  3. UI labels match behavior: if a dataset is metadata-only-cloud (unlikely to remain the case after this fix, but possible), the label says so.
- **Evidence.** Screen recording of the two-user test on fresh browsers. Network panel capture of the hydration calls.

**Gate.** After Phase 1, Rhett's health data is flowing again and the cloud sync model is both truthful and cross-user. Do not begin Phase 2 until this is acknowledged.

---

## Phase 2 — Immediate Bug Fixes

Small, high-confidence, user-visible bugs on the main app (where they currently live). Each its own PR. Ship before the architectural migration so value lands immediately.

### Task 2.1 — [A] DropDock Sheets title enrichment mismatch *(stays on main)*
- **Problem.** Client emits `spreadsheetId` in dock item metadata; server reads `sheetId`. Every pasted Google Sheets URL has been failing to enrich its title.
- **Files.** `shared/dropdock.helpers.ts:137`, `server/routers/personalData.ts:2293`.
- **Fix.** Accept both keys server-side; standardize on `spreadsheetId` going forward.
- **Definition of Done.** Freshly pasted Sheets URL gets correct title; existing dock rows still load; tsc clean.
- **Evidence.** Before/after screenshot.

### Task 2.2 — [A] DropDock Calendar enrichment fails for non-primary calendars *(stays on main)*
- **Problem.** Server decodes only the event ID from `eid` and always fetches from `calendars/primary`.
- **Files.** `server/routers/personalData.ts:2262`, `2274`.
- **Fix.** Decode both tokens (event ID + calendar ID); pass calendar ID to Calendar API. Fall back to `primary` only when absent.
- **Definition of Done.** A Calendar link from a non-primary calendar enriches correctly.

### Task 2.3 — [A] ABP Settlement manual overrides cross-month contamination *(migrates to solar-rec in Phase 5)*
- **Problem.** Overrides initialize from current `monthKey`, but changing the month input doesn't reload overrides before persistence writes to the new key.
- **Files.** `AbpInvoiceSettlement.tsx` around 283, 2286, 2422.
- **Fix.** Replace direct `setMonthKey` with a handler that flushes pending writes, clears in-memory state, then loads overrides for the incoming month.
- **Definition of Done.** Manual test: month A → set value → month B → set different value → back to A → original preserved.

### Task 2.4 — [B] Google token refresh race *(stays on main)*
- **Problem.** `server/helpers/tokenRefresh.ts:36-62`. Concurrent requests in the 5-min refresh window both hit Google, second upsert writes a token Google has already invalidated.
- **Verify first.** Confirm no existing coordination exists in the file.
- **Fix.** In-memory single-flight `Map<string, Promise<string>>` keyed by `${userId}:${provider}`; clear on settle.
- **Definition of Done.** Vitest test proves 10 concurrent calls produce one `refreshFn` invocation. tsc clean.

### Task 2.5 — [B] `todayKey` lag across midnight *(stays on main)*
- **Problem.** `useDashboardData.ts:36`. Recomputed per render; nothing forces a render at midnight.
- **Fix.** `useSyncExternalStore` subscribed to `setTimeout(msUntilMidnight)` (or a 60-second tick).
- **Definition of Done.** Mocked-clock test advances past midnight; component observes new key without refetch.

### Task 2.6 — [B] DropDock canonicalization preserves auth-bearing params *(stays on main)*
- **Problem.** `shared/dropdock.helpers.ts:35-63`. Strips `utm_*`, `gclid`, etc., but not `token`, `access_token`, `code`, `state`, `sig`, `auth`, `key`.
- **Fix.** Add `SENSITIVE_PARAMS` set. Strip in canonicalization. UI warns on paste.
- **Definition of Done.** Unit test per sensitive param. Manual test with `?token=FAKE123`.

### Task 2.7 — [CLOSED] Samsung webhook per-device HMAC
- **Decision.** Main is permanently single-user by design. Single shared sync key is acceptable forever.
- **Action.** Add a comment at `server/oauth-routes.ts:440` and `server/_core/pinGate.ts:45`: `// Main is single-user by design; this webhook is scoped to SAMSUNG_HEALTH_USER_ID. Do not generalize without rethinking auth.`
- **Definition of Done.** Comments in place.

**Gate.** After Phase 2, report back.

---

## Phase 3 — Infrastructure Hardening

### Task 3.1 — [B] Scheduler refactor with distributed claim *(shell is shared; will serve both apps)*
- **Problem.** `monitoringScheduler.ts` and nightly snapshot use `setInterval(fn, 60_000)` with `hour===X && minute===0`. Restart inside the target minute eats the run; `lastRunDateKey` lives in-process, so multi-instance deploys double-fire.
- **Fix.**
  1. New table `dailyJobClaims(dateKey, runKey, claimedAt, status)` with unique `(dateKey, runKey)`.
  2. Extract `scheduleDaily({ hour, runKey, run })` into `server/_core/scheduleDaily.ts`.
  3. Gate: `currentHour >= targetHour AND no claim row yet`. Claim via `INSERT IGNORE`.
  4. Replace `setInterval` with `setTimeout` that recomputes `nextRunAt` (handles DST).
  5. Migrate both existing schedulers. Monitoring scheduler moves with Phase 5.
- **Definition of Done.** Restart test (kill at 07:59:55, restart at 08:00:10 — still runs). Two-instance test (only one fires).

### Task 3.2 — [B] `monitoringApiRuns` retention prune
- **Fix.** `pruneMonitoringApiRuns(cutoffDateKey)`. Nightly prune deletes > 365 days.
- **Definition of Done.** Manual run on seeded test DB.

### Task 3.3 — [B] Gmail waiting-on server-side cache *(stays on main)*
- **Fix.** `gmailWaitingOnCache(userId, queryHash, payload, expiresAt)` with 15-min TTL.
- **Definition of Done.** Two tabs open → one Gmail fetch per 15-min window.

### Task 3.4 — [B] WHOOP refetch cadence *(stays on main)*
- **Fix.** `staleTime: 20 * 60 * 1000`, `refetchInterval: 30 * 60 * 1000` on WHOOP queries.

### Task 3.5 — [B] DropDock enrichment race *(stays on main)*
- **Fix.** Disable input while mutation in flight; 200ms paste debounce.

**Gate.** After Phase 3, report back.

---

## Phase 4 — Consolidations, Cleanups, and Cross-Cutting Feature Adds

### Task 4.1 — [REVERSED from original plan] Establish solar-rec as the business-functions home
- **Context.** Original plan called for retiring `solarRecRouter.ts`. Architectural decision reverses that.
- **Fix.**
  1. **Update CLAUDE.md.** Rewrite "dual-router trap" as "dual-router boundary":
     - `server/routers.ts` = personal features only (main `/`, single-user).
     - `server/_core/solarRecRouter.ts` = business features only (solar-rec `/solar-rec/*`, multi-user, scope-aware).
     - List features on the wrong side and mark "pending migration (Phase 5)."
     - Document CSG ID as the canonical system key, sourced from Solar Applications dataset.
  2. **Create `docs/architectural-split.md`** covering the split, scope-aware vs user-aware tables, and decision rules for where a new feature belongs.
  3. **Add a lint/precommit rule** that warns on cross-imports (a procedure in `server/routers.ts` importing from `server/db/monitoring.ts`, `solarRec*`, etc.).
  4. Do not migrate features yet — that's Phase 5.
- **Definition of Done.** CLAUDE.md updated. `docs/architectural-split.md` exists and is cross-referenced. Lint rule triggers on a seeded cross-import.

### Task 4.2 — Remove Enphase V2 code *(prerequisite for Task 4.6)*
- **Problem.** Enphase V2 is deprecated. Shipping it to `/solar-rec/*` would be shipping dead code.
- **Scope.** Identify everything referencing Enphase V2: `EnphaseV2MeterReads.tsx`, any `enphaseV2` routes in `server/routers/`, any adapter in `server/solar/`, any provider constants, any schema/enum values, any `integrations` rows with provider="enphaseV2".
- **Fix.**
  1. Grep for `EnphaseV2`, `enphaseV2`, `enphase_v2`, `enphaseV2MeterReads`; produce an exhaustive list.
  2. Delete the files and routes.
  3. For schema enum values / constant lists, leave the string value in place if any historical data rows reference it, but remove it from active-provider lists (otherwise historical `monitoringApiRuns` rows become orphaned).
  4. Migrate any users currently on Enphase V2 to Enphase V4 by flagging their integration row; surface a one-time UI banner.
  5. Remove Enphase V2 from the Settings integrations list.
- **Definition of Done.** Grep for Enphase V2 in active code returns zero hits. Historical rows remain intact. tsc clean. The `/meter-reads/enphase-v2` route returns 404 or redirects to `/meter-reads/enphase-v4`.
- **Evidence.** Grep output before/after; count of migrated users; screenshot of the banner.

### Task 4.3 — [Both] Command palette global search wiring *(stays on main)*
- **Fix.** Debounced (200ms) `search.global` query in the palette. Split results into "Commands" and "Search Results." Secondary actions per result: open / dock / create note / pin as king.
- **Definition of Done.** Typing three characters produces results from notes, Todoist, Calendar. Secondary actions work.

### Task 4.4 — [B] Consolidate date-key helpers *(shared)*
- **Fix.** `shared/dateKey.ts` with `toDateKey(date, tz?)`, `formatTodayKey(tz?)`, `formatDateInput(date)`. Migrate all 19 call sites.
- **Definition of Done.** Grep for manual YYYY-MM-DD patterns returns zero hits outside the new module.

### Task 4.5 — [NEW, Rhett] Shared "Ask AI about this data" component
- **Context.** The pattern already exists on the Solar REC Dashboard's Performance Ratio tab ("Ask AI about this data" collapsible). The request is to generalize and deploy across every module on both apps.
- **Fix.**
  1. Extract into `shared/ui/AskAiPanel.tsx` (or `client/src/components/ui/AskAiPanel.tsx` if truly cross-app). Props: `title`, `contextGetter: () => string | object`, `moduleKey: string`.
  2. Model selection: dropdown with the Claude models available via the Anthropic router. Persist the user's last choice in `userPreferences` per-module (so Rhett can default different modules to different models).
  3. Uses the existing Anthropic integration; conversations persist to the `conversations` / `messages` tables with `source: `ask-ai:${moduleKey}``.
  4. Deploy across: every Solar REC Dashboard tab (Overview, Size+Reporting, REC Value, Utility Contracts, Annual REC Review, REC Performance Eval, Change of Ownership, Ownership Status, Offline by Monitoring, Meter Reads, Performance Ratio, Snapshot Log, Application Pipeline, Trends, Forecast, Alerts, Comparisons, Financials, Data Quality, Delivery Tracker), the ABP Invoice Settlement page, Early Payment, Invoice Match, Contract Scanner, DIN Scrape Manager, Zendesk Metrics, plus on main: the Notebook, Supplements Insights, Habits Insights, Health, and Dashboard.
  5. Each deployment passes its own `contextGetter` that returns whatever on-screen data is relevant (filtered rows, selected system, current month, etc.).
- **Definition of Done.** Panel renders on every listed page. Asking a question with a different model produces a different response. Conversation history is retrievable from the Notebook's linked conversations.
- **Pace.** One or two deployments per PR after the shared component lands. Not a single big bang.
- **Evidence.** Screenshots from three modules showing the panel in use.

### Task 4.6 — [NEW, Rhett] Todoist task from Notebook text selection
- **Context.** Notebook uses Tiptap 3. The existing `noteLinks` table already supports linking a note to a Todoist task.
- **Fix.**
  1. Add a Tiptap extension that listens for `Cmd+Alt+T` (Mac) / `Ctrl+Alt+T` (Win/Linux) when there's a non-empty text selection. **Do not use plain `Cmd+T` / `Ctrl+T`** — Chrome captures those at the browser level (new tab) before the page sees the keydown, and `event.preventDefault()` in the ProseMirror handler cannot override that. The same constraint applies to `Cmd+W`, `Cmd+N`, `Cmd+Shift+T`. Detection should check `event.code === "KeyT"` (not `event.key`) because `Option+T` on Mac produces `†` in `event.key`.
  2. On trigger: capture the selected text, open a small modal: task content (pre-filled with selection, editable), project/label selector (Todoist projects already fetched by the existing router), due date optional.
  3. On submit: call `todoist.createTask`. On success, create a `noteLinks` row linking the current note to the new task (`linkType: "todoist_task"`, `externalId: <Todoist task id>`).
  4. Also add a UI button in the Tiptap toolbar that does the same thing (equivalent affordance for users who don't use the hotkey).
  5. Small toast on success with a link to the task.
- **Definition of Done.** (a) Select text in a note, press Cmd+Alt+T, confirm modal, task appears in Todoist with selected text. (b) Toolbar button produces the same result. (c) The note shows a linked-task indicator (builds on Task 10.3's reverse note-link rendering when that ships).
- **Evidence.** Screen recording.

### Task 4.7 — [Both, Rhett] MeterReadsPage migration *(prerequisite for Phase 5)*
- **Problem.** Shared `MeterReadsPage.tsx` drives 8 vendors via ~80-line configs. 9 vendors (after Enphase V2 removal) are still hand-rolled: Fronius (1,651), SolarEdge (1,613), EnnexOs (1,584), eGauge (1,570), APsystems (1,349), Hoymiles (1,321), TeslaPowerhub (824), EnphaseV4 (695), TeslaSolar (396). Every fix lands 9 times or only where remembered.
- **Order.** SolarEdge → Fronius → APsystems → Hoymiles → TeslaSolar → TeslaPowerhub → EnnexOs → eGauge (needs `noBulkFetch` flag) → EnphaseV4 (needs optional `authRenderer` slot).
- **Fix per vendor.** Produce a config file following `GrowattMeterReads.tsx` / `EkmMeterReads.tsx` shape. Delete the old page. Update routes.
- **Definition of Done per vendor.** Page renders identically. Connect, bulk snapshot, CSV export, push all work. Old file deleted. tsc clean. No duplicate CSV builder remains.
- **Pace.** One vendor per PR.

**Gate.** After Phase 4, report back. The architecture is formalized, Enphase V2 is gone, meter-reads are one page, and the cross-cutting AI panel is deployable.

---

## Phase 5 — Business Functions Migration to `/solar-rec/*`

**Prerequisites.** Task 1.2b (cross-user cloud sync works) must be done. Task 4.1 (architectural boundary documented) and 4.7 (MeterReadsPage consolidated) must be done.

### Task 5.1 — [NEW, Rhett] Permission matrix infrastructure
- **Context.** Every solar-rec feature is a module. Every teammate has a permission per module: `none` / `read` / `edit` / `admin`. This task builds the data model, the enforcement middleware, and the Settings UI to manage the matrix. It must land before migrations so that Task 5.3 onward can attach `.requirePermission` wrappers as features move in.
- **Fix.**
  1. **Data model.** New table `solarRecUserModulePermissions(userId, scopeId, moduleKey, permission, createdAt, updatedAt)` with unique `(userId, scopeId, moduleKey)` and permission enum `['none','read','edit','admin']`. Add `ownerUserId` to `solarRecScopes` (backfill Rhett as owner of his scope). Add `isScopeAdmin BOOLEAN DEFAULT FALSE` to `solarRecUsers`.
  2. **Module enumeration.** Create `shared/solarRecModules.ts` exporting the canonical module keys and display metadata. Initial list (all features migrating in Phase 5 plus the standalone pages already on solar-rec):
     - `solar-rec-dashboard` (Solar REC Dashboard, all tabs)
     - `monitoring-overview` (the Phase 7 page)
     - `meter-reads` (all vendor pages, treated as one module)
     - `schedule-b` (Schedule B import + CSG Schedule B import)
     - `contract-scanner` (PDF upload scanner)
     - `contract-scrape-manager` (CSG portal scraper)
     - `din-scrape-manager`
     - `abp-invoice-settlement`
     - `early-payment`
     - `invoice-match`
     - `address-checker`
     - `zendesk-metrics`
     - `deep-update-synthesizer`
     - `jobs` (unified jobs page from Phase 8)
     - `portfolio-workbench` (Phase 9 system detail + worksets)
     - `team-permissions` (the matrix itself — admin required to manage)
     - `solar-rec-settings` (solar-rec's settings page, not personal Settings)
  3. **Permission semantics.**
     - `none`: module hidden in sidebar, all procedures return 403.
     - `read`: module visible, read procedures allowed, write procedures 403.
     - `edit`: read + write/mutation procedures allowed (run jobs, upload files, modify records).
     - `admin`: edit + module-level settings (e.g., change default scheduler settings, delete data, adjust module configuration).
     - Scope owner (`ownerUserId`) and `isScopeAdmin=true` users have implicit admin on every module regardless of matrix. This prevents lockout.
  4. **tRPC middleware.** Add `.requirePermission(moduleKey: ModuleKey, minLevel: 'read'|'edit'|'admin')` as a procedure builder in the solar-rec router tree. Usage: `protectedProcedure.requirePermission('contract-scanner', 'edit').mutation(...)`. The middleware reads the caller's permission row (or scope-admin flag) and gates the call.
  5. **Client-side helpers.** Add `useSolarRecPermission(moduleKey)` hook returning `{ canRead, canEdit, canAdmin }`. Pages use it to disable/hide write-y controls. Sidebar uses it to hide modules where the user has `none`.
  6. **Settings UI.** New tab in solar-rec Settings: "Team & Permissions." Two sub-sections:
     - **User matrix.** Grid with users on rows, modules on columns, dropdown per cell `[none, read, edit, admin]`. Scope owner and scope-admin flags editable on the user row. Saving writes to `solarRecUserModulePermissions`.
     - **Permission presets.** Admin-buildable library. Admins create named presets (e.g., "Monitoring Operator," "Compliance Lead," "Read-Only Observer"), each preset is a named bundle of `{moduleKey: permission}` pairs. Presets are reusable at invite time (Task 5.2) and can also be bulk-applied to an existing user from the user matrix with one click ("Apply preset → Monitoring Operator → overwrite current permissions? [confirm]"). Stored in new table `solarRecPermissionPresets(id, scopeId, name, description, permissionsJson, createdByUserId, createdAt, updatedAt)`. Presets are scope-scoped (each team builds its own library). Editing a preset does NOT retroactively change users who were previously assigned it — presets are templates, not live bindings. Deleting a preset leaves already-applied user permissions untouched.
     - Only users with `admin` on `team-permissions` (or scope owner / scope admin) see this tab.
  7. **Apply to existing standalone solar-rec pages.** The three monitoring pages that already exist at `/solar-rec/*` (Monitoring, Settings, Team) need to adopt the permission system retroactively. Pre-Phase-5 users (just Rhett) default to admin on every module.
- **Definition of Done.**
  - Rhett, as scope owner, sees "Team & Permissions" and can set a permission for any user on any module.
  - Rhett can create a preset (e.g., "Monitoring Operator" = `read` on `solar-rec-dashboard`, `edit` on `monitoring-overview` + `meter-reads`, `none` on everything else), save it, and re-use it.
  - Applying a preset to an existing user overwrites their permissions to match the preset.
  - A seeded test user with `read` on `contract-scanner` can open the page and view results but the "Start Job" button is disabled; `edit` enables the button; `none` hides the module entirely.
  - Direct API calls bypassing the UI are blocked server-side by the middleware (try to call a mutation procedure with curl and a `none` user's token — it 403s).
  - Rhett cannot lock himself out — even if he sets his own `team-permissions` to `none`, his scope-owner status preserves access.
  - tsc clean; new tests cover the middleware, lockout-prevention, and preset application.
- **Evidence.** Screen recording of Rhett building a preset, applying it to a test user, and that user's sidebar changing accordingly. cURL showing 403 on denied mutation.

### Task 5.2 — [NEW, Rhett] Team onboarding flow
- **Prerequisite.** Task 5.1 must be done.
- **Context.** Teammates need a path from "Rhett wants to onboard Amy" to "Amy is logged in and has the permissions Rhett assigned." Uses `solarRecInvites` schema.
- **Fix.**
  1. **Invite flow.** In "Team & Permissions" settings, an "Invite teammate" form: email, optional preset selector (choose from the admin-built library created in Task 5.1; empty preset means "all `none`, I'll set manually"), optional message. Creates `solarRecInvites` row with one-use token and the chosen preset reference; sends invite email.
  2. **Accept flow.** Invitee clicks email link → `/solar-rec/invite/:token` → Google OAuth → creates `solarRecUsers` row in Rhett's scope → applies the preset's permissions snapshot to `solarRecUserModulePermissions` (snapshot, not live binding — if the preset later changes, the user's permissions do not).
  3. **First-login experience.** Fresh user sees the sidebar filtered to modules where they have at least `read`. Dashboard loads the team's cloud-synced data (depends on Task 1.2b).
  4. **Scope switcher.** Sidebar control for users in multiple scopes. Future-proofing; most users will be in one.
  5. **Revocation.** Scope owner / scope admin can revoke; soft-delete the `solarRecUsers` row, invalidate auth tokens on next request.
- **Definition of Done.**
  - Rhett invites a seeded test user with a "Monitoring + Contract Scanner (edit)" preset.
  - Test user accepts, lands in solar-rec, sidebar shows only Monitoring and Contract Scanner, can run a contract scan but cannot see ABP Settlement.
  - Rhett changes the user's ABP Settlement permission to `read`; after a reload, the test user sees ABP Settlement in read-only mode.
  - Revocation locks out on next request.
- **Evidence.** Screen recording of the full invite → accept → permission-adjust → revoke flow.

### Migration mechanics (apply to every task from Task 5.3 onward)

For each feature moving from main to solar-rec:

1. **Client.** Move the page from `client/src/features/...` to `client/src/solar-rec/pages/...`. Update imports. Register the route in `SolarRecApp.tsx`. Remove the route from `App.tsx`. Update sidebars. Gate write controls by `useSolarRecPermission(moduleKey).canEdit`.
2. **Server.** Move the router or sub-router into the solar-rec router tree; update `solarRecRouter.ts` composition. **Wrap every procedure with `.requirePermission(moduleKey, level)`** — read procedures require `read`, mutations require `edit`, destructive / config changes require `admin`. Client call site switches to the solar-rec tRPC client.
3. **Auth.** Replace `ctx.userId` with `ctx.solarRecUserId` where applicable. No per-user data scoping (team-wide visibility); scope attribution goes via `ctx.scopeId` for multi-scope future-proofing.
4. **Data.** Add `scopeId` via Drizzle migration if the table isn't already scope-aware; backfill to Rhett's scope. No `userId` partitioning of business data.
5. **Vendor credentials.** Where a feature reads vendor API tokens from per-user `integrations`, migrate the read to `solarRecTeamCredentials` (team-shared).
6. **Redirect.** Old main-app URL returns 302 to the new solar-rec URL for 30 days.
7. **Definition of Done per migration.** Feature works for Rhett (scope owner, implicit admin). Feature works for a seeded test user with `edit` on the module. Feature blocks a seeded test user with `read` from writing. Feature is hidden from a seeded test user with `none`. Old URL redirects. Lint from Task 4.1 passes. tsc clean.

### Task 5.3 — Migrate monitoring scheduler + `monitoringApiRuns`
Schedulers first (headless). Add `scopeId` to `monitoringApiRuns`, `monitoringBatchRuns`. The `scheduleDaily` shell from Task 3.1 moves with it. ModuleKey: `monitoring-overview` (even though schedulers are headless, any admin UI for them lives under this module).

### Task 5.4 — Migrate the 9 meter-read pages (consolidated under `MeterReadsPage`)
Easy because Task 4.7 collapsed them. Routes move from `/meter-reads/:vendor` on main to `/solar-rec/meter-reads/:vendor`. Credentials now read from `solarRecTeamCredentials`. ModuleKey: `meter-reads`.

### Task 5.5 — Migrate Solar REC Dashboard
Big page with 11+ tabs. Most tables already use `solarRecScopes` — the scope model is there. ModuleKey: `solar-rec-dashboard`. Inside the dashboard, the "Team & Permissions" settings link appears only for users with `admin` on `team-permissions`.

### Task 5.6 — Migrate Schedule B import + CSG Schedule B import
Two of four job runners. Add `scopeId` to `scheduleBImportJobs`, `...CsgIds`, `...Results`, `...Files`. ModuleKey: `schedule-b`.

### Task 5.7 — Migrate contract scan job runner + ContractScanner + ContractScrapeManager
Add `scopeId` to `contractScanJobs`, `...CsgIds`, `...Results`. ModuleKeys: `contract-scanner` (the PDF upload tool) and `contract-scrape-manager` (the CSG portal scraper) — treated as separate modules because they can plausibly be used by different team members with different trust levels.

### Task 5.8 — Migrate DIN scrape job runner + DinScrapeManager
ModuleKey: `din-scrape-manager`.

### Task 5.9 — Migrate ABP Invoice Settlement
The big one — 4,070 LOC. Its `monthKey`-scoped local data moves into `scopeId`-keyed DB tables. Task 2.3's override fix migrates with it. ModuleKey: `abp-invoice-settlement`. Light structural pass to extract obvious helpers after moving.

### Task 5.10 — Migrate Early Payment + Invoice Match Dashboard
Move together — they share utilities. ModuleKeys: `early-payment`, `invoice-match`.

### Task 5.11 — Migrate Address Checker, Zendesk Metrics, Deep Update Synthesizer
Smaller utilities. ModuleKeys: `address-checker`, `zendesk-metrics`, `deep-update-synthesizer`. Batch into one PR if scope migration + permission wrapping is trivial for each; otherwise one per utility.

**Gate after Phase 5.** Main sidebar shows only personal features. Solar-rec sidebar respects per-user per-module permissions. A seeded `read`-only test user sees all data but cannot mutate anything. A seeded `edit` test user on a subset of modules sees only that subset. The permission matrix is editable by the scope owner from Settings. Lint from Task 4.1 reports zero cross-imports.

---

## Phase 6 — Pre-computed Correlations *(main)*

### Task 6.1 — [B] Nightly correlation compute + dashboard surface
- **Fix.**
  1. New table `supplementCorrelations(userId, supplementId, metric, windowDays, computedAt, cohensD, pearsonR, onN, offN, onMean, offMean)`.
  2. In nightly snapshot, call `analyzeCorrelation` for each active-and-locked supplement × `{recoveryScore, sleepHours, dayStrain, hrvMs}` at `{30, 90}` day windows.
  3. New procedure `supplements.getTopSignals(limit=5)`.
  4. Replace `SupplementsFeedCell` adherence display with top-signals card.
- **Definition of Done.** After one nightly run, dashboard card shows real data.

Phase 6 can interleave with later phases.

---

## Phase 7 — Monitoring Overview *(solar-rec)*

### Task 7.1 — [B] `/solar-rec/monitoring-overview`
Starts from the existing `MonitoringOverview.tsx` shell.
- **Fix.** New procedure `monitoring.getDailyOverview({ scopeId, dateKey, windowDays: 7 })`. Columns: Provider · Site · Yesterday · 7d · 30d · Status · Last error · Last run. "Re-run failed sites" button calls `executeMonitoringBatch` filtered to `status IN ('error','no_data')`.
- **Definition of Done.** Page loads under 1s for a scope with 50+ sites.

---

## Phase 8 — Unified `/solar-rec/jobs` Surface

### Task 8.1 — Job runner contract extraction
Extract `runJobWithAtomicCounters<TInput, TResult>` into `server/services/core/jobRunner.ts`. Migrate all four runners. Bump each `_runnerVersion`.

### Task 8.2 — `/solar-rec/jobs` index page
Sidebar entry "Jobs" under solar-rec. Live + recent jobs across all four runners. 3-second polling while active. Row-click opens specific manager.

---

## Phase 9 — Portfolio Workbench *(solar-rec)*

**Canonical key.** Every surface in this phase keys off `CSG ID`. The Solar Applications dataset is the source of truth for what systems exist, their size, price, and contract status. ABP ID is stored as a secondary identifier where known, from the `ABP CSG-System Mapping` dataset.

**Permission module.** The entire workbench (Tasks 9.2–9.5) is the `portfolio-workbench` module from Task 5.1. Worksets are `edit` territory (creating / appending / deleting); viewing worksets and detail pages is `read`. Cross-module data shown in the detail page (contract scan, DIN, Schedule B) is visible as long as the user has `read` on `portfolio-workbench` — the workbench is a composed view, so its permission gates everything it shows. Users without `read` on `portfolio-workbench` cannot access `/solar-rec/system/:csgId` even if they have `read` on the underlying modules.

### Task 9.1 — Solar Applications as the system registry
- **Fix.** Before building the workbench, ensure the Solar Applications dataset is queryable as a first-class resource. New procedure `systems.getByCsgId(csgId)` returning `{ csgId, abpId?, systemSize, price, contractStatus, contractedDate?, installer?, ... }` by joining Solar Applications with ABP CSG-System Mapping and Contracted Date datasets.
- **Definition of Done.** Given any CSG ID from the current 32,664-row Solar Applications dataset, the procedure returns the correct joined record.

### Task 9.2 — Saved ID worksets (MVP)
- **Fix.** Scope-aware table `idWorksets(id, scopeId, createdByUserId, name, csgIds[], createdAt, updatedAt)`. Worksets hold CSG IDs only. Procedures: `worksets.create/list/get/update/delete/append`. Team-visible within scope.
- **Definition of Done.** Create a workset of 10 CSG IDs; retrieve; append; delete. Second user in same scope sees the same worksets.

### Task 9.3 — Workset selector in each job page
Replace paste-IDs textareas in Invoice Match, Contract Scanner, Contract Scrape Manager, DIN Scrape Manager, Schedule B Import, Early Payment, Solar REC Dashboard's Schedule B import with dual control: "Paste IDs" OR "Load workset." Save-as-workset after paste.

### Task 9.4 — System detail page (MVP) — `/solar-rec/system/:csgId`
- **Context.** Driven by the canonical system registry from Task 9.1. One page per system, keyed by CSG ID.
- **Sections (initial).**
  - **Header.** CSG ID, ABP ID if present, system size, price, contract status, installer — from Solar Applications.
  - **Contract.** Latest contract scan result.
  - **DINs.** Inverter / meter DINs from `dinScrapeDins`.
  - **Schedule B / Delivery.** From `scheduleBImportResults` + `solarRecComputedArtifacts`.
  - Each section shows "last updated" and "re-run" if applicable.
- **Definition of Done.** Given a CSG ID with contract-scan, DIN, and Schedule B data, all four sections render. Missing-data states are clear. Page loads under 1s.

### Task 9.5 — Detail page growth
One PR per added section: meter-read status → invoice status → address verification → REC value → ownership → monitoring history. After each, pause for team use before the next.

---

## Phase 10 — Dashboard as Composer *(main)*

Can interleave with Phases 5–9.

### Task 10.1 — Uniform signal-row action menu
`<SignalActions row={...} />`: Drop to Dock · Pin as King · Create Todoist Task · Archive (Gmail) · Defer (Todoist). Wire into every feed cell.

### Task 10.2 — King of the Day extended candidate sources
Pinned dock items → score 50. Waiting-on >7d → score 35. Auto-unpin completed Todoist king.

### Task 10.3 — Reverse note-link rendering
`notes.listForExternal({ linkType, externalId })`. "📎 N linked notes" on every Todoist task and Calendar event. Interoperates with Task 4.6's Notebook→Todoist feature — the forward link from that feature shows up as a reverse link here.

### Task 10.4 — Headline deep-link
OneThing headline becomes a link: Todoist web URL when `taskId`; Calendar deep-link when `eventId`.

---

## Phase E — Backlog (unscheduled)

Do not begin without explicit "do this next."

- AI Weekly Review (cron over `dailySnapshots`). Main.
- Personal CRM overlay from Gmail/Calendar/dock. Main.
- Mobile PWA shell. Main.
- Feedback review dashboard. Main.
- Dock item `dueAt` → reminders. Main.
- Auto-archive dock items >30d not on canvas. Main.
- Habit history bulk endpoint. Main.
- Meter-read "Test Connection" probe. Solar-rec.
- Supplements "Log all AM" batch. Main.
- Cmd+C copies dock chip URL. Main.
- Retire `DashboardLegacy.tsx`. Main.
- Settings split into tabs — main Settings only; solar-rec Settings grows organically from Phase 5.

---

## Global Definition of Done

1. Code merged.
2. `./node_modules/.bin/tsc --noEmit --incremental false` clean.
3. Existing tests pass; new tests exist where specified.
4. Manual acceptance test run.
5. Evidence bundle produced.
6. Long-running jobs expose `_runnerVersion` and raw-state debug endpoint.
7. Schema changes include Drizzle migration.
8. `CHANGES.md` appended.
9. PR description states: "This change lives on [main / solar-rec] because [reason]."
10. Investigation-first tasks: findings report delivered separately from fix PR.

---

## Reporting Cadence

Per task: 5-line PR summary — what, why, how tested, regressions, follow-ups.
Per phase: consolidated report with evidence. Stop and wait for acknowledgment.
Contradictions with this plan → stop and report, do not improvise.
