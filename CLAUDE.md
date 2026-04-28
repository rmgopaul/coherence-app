# Productivity Hub

> **Last updated:** 2026-04-27

Full-stack personal productivity dashboard integrating Google Calendar, Gmail, Drive, Todoist, ChatGPT, health tracking (Whoop, Samsung Health), and 25+ solar energy monitoring systems.

---

## Current roadmap

- **[docs/execution-plan.md](docs/execution-plan.md)** — phased plan of record (currently v4). Do not reorder phases or skip gates without approval.
- **[docs/execution-log.md](docs/execution-log.md)** — append-only log of task completions against the plan.

---

## 🚨 READ THIS FIRST — the dual tRPC router boundary

**Used to be called "the trap" because new code kept landing on the wrong
side and losing hours. It's now a rule: personal vs. business features
live on different routers, and features on the wrong side are scheduled
to migrate in Phase 5. Before editing any tRPC procedure, know which
router you are editing and why. See `SESSIONS_POSTMORTEM.md` for the
2026-04-10 story that made this explicit.**

See `docs/architectural-split.md` for the full split, `scopeId`-vs-
`userId` decision rules, and the feature-by-feature inventory of where
every procedure lives today and where it's going.

### The rule

- `productivity-hub/server/routers.ts` = **main (`/`), personal,
  single-user features only.** This is the router for the front-page
  dashboard and every feed/widget it composes — Todoist, Gmail,
  Calendar, Drive, WHOOP, Samsung Health, supplements, habits, health,
  sleep notes, notebook, DropDock, Canvas, King of the Day, Clockify,
  feedback, markets, weather, news, personal settings.

- `productivity-hub/server/_core/solarRecRouter.ts` = **solar-rec
  (`/solar-rec/*`), business, multi-user, scope-aware features only.**
  Everything the team uses: Solar REC Dashboard and tabs, daily
  monitoring scheduler, all 16 solar vendor adapters (Enphase V2 is
  deprecated — see Task 4.2), meter-read pages, `monitoringApiRuns`,
  job runners (contract scan, DIN scrape, Schedule B, CSG Schedule B),
  ABP Invoice Settlement, Early Payment, Invoice Match, Address
  Checker, Zendesk Ticket Metrics, Contract Scanner, Deep Update
  Synthesizer.

**Decision for a new feature:** who uses it? Just Rhett → `server/
routers.ts`. The whole team → `server/_core/solarRecRouter.ts`.

### Wrong-side features (Phase 5 migration history)

As of 2026-04-27, every feature on the original Phase 5 wrong-side
list has been migrated. The entries below are kept as historical
context — they record the order in which migrations shipped, the
shape of each one, and what to grep for if you're reading old
code that still references the pre-migration paths. Do **not** add
new sub-procedures to `server/routers.ts` for solar-rec features —
they belong on `server/_core/solarRecRouter.ts` (or a sibling sub-
router file).

- ~~`solarRecDashboard.*` (Solar REC Dashboard + Schedule B scanner)
  — migrates in Task 5.5~~ **DONE 2026-04-26.** Lives at
  `server/_core/solarRecDashboardRouter.ts`; reachable from clients
  via `solarRecTrpc.solarRecDashboard.*`.
- ~~monitoring scheduler + `monitoringApiRuns` — Task 5.3~~ **DONE
  2026-04-24** (#80).
- ~~9 meter-read pages (consolidated to `MeterReadsPage`) — Task 5.4~~
  **DONE 2026-04-26** (16/16 vendors migrated, #81–#102).
- ~~Schedule B import + CSG Schedule B import — Task 5.6~~
  **DONE 2026-04-26.** PR-A reclassified the 13 procedures to
  `requirePermission("schedule-b", level)` (#113). PR-B added
  `scopeId` to the 4 `scheduleBImport*` tables, backfilled via
  `scope-user-${userId}` UPDATE…JOIN, and switched
  `getLatestScheduleBImportJob` /
  `getOrCreateLatestScheduleBImportJob` to filter by scope.
- ~~Contract scan runner + ContractScanner + ContractScrapeManager —
  Task 5.7~~ **DONE 2026-04-26.** PR-A scope-keyed the 3
  `contractScan*` tables (#117). PR-B moved the 11 db/result/override
  procs from main `abpSettlementRouter` into a new standalone
  `solarRecContractScanRouter.ts` (module key
  `contract-scrape-manager`, 7 read / 3 edit / 1 admin), moved both
  pages to `client/src/solar-rec/pages/`, and retired the legacy
  `/contract-scanner` + `/contract-scrape-manager` URLs with Wouter
  redirects. ContractScanner page (PDF parser, no procs) gates on
  `contract-scanner`. Cross-tenant safety on `getContractScanJob`
  ownership checks switched from `userId` to `scopeId`.
- ~~DIN scrape runner + DinScrapeManager — Task 5.8~~
  **DONE 2026-04-27.** PR-A added `scopeId` to all 4 `dinScrape*`
  tables, backfilled, switched DB helpers + procs to filter by scope.
  PR-B moved the 10 `dinScrape.*` procs from the main `dinScrapeRouter`
  in `server/routers/jobRunners.ts` to a new standalone
  `server/_core/solarRecDinScrapeRouter.ts` (gated on
  `requirePermission("din-scrape-manager", level)` — 6 read / 3 edit
  / 1 admin (`deleteJob`)). Cross-tenant safety: ownership checks
  switched from `job.userId !== ctx.user.id` to
  `job.scopeId !== ctx.scopeId`. `DinScrapeManager.tsx` (931 LOC)
  moved to `client/src/solar-rec/pages/` with the standard aliased
  `solarRecTrpc as trpc` import. Legacy `/din-scrape-manager` URL
  kept as Wouter `<Redirect />`. **`server/routers/jobRunners.ts`
  deleted entirely** — `dinScrapeRouter` was its last export after
  the Task 5.9 PR-A cleanup.
- ~~ABP Invoice Settlement — Task 5.9~~ **DONE 2026-04-27 (PR-A).**
  Procs moved to `solarRecAbpSettlementRouter.ts` (7 procs:
  `startContractScanJob`, `getJobStatus`, `cleanMailingData`,
  `verifyAddresses`, `saveRun`, `getRun`, `listRuns`) +
  `solarRecCsgPortalRouter.ts` (3 procs: `status`, `saveCredentials`,
  `testConnection`). Two module gates: `abp-invoice-settlement` for
  the main settlement procs, `solar-rec-settings` for CSG portal
  credentials (credentials are settings, not settlement state).
  Storage layer (`saveRun`/`getRun`/`listRuns`) keeps the existing
  `readPayloadWithFallback`/`writePayloadWithFallback` helpers but
  passes `resolveSolarRecOwnerUserId()` so every team member sees
  the same runs in single-tenant prod. Cross-scope safety on
  `getJobStatus` switched from `userId` to comparing the job's owner
  against the resolved owner. Storage rewrite to `scopeId`-keyed keys
  is deferred to a follow-up. `csgPortalRouter` + `abpSettlementRouter`
  deleted from `server/routers/jobRunners.ts`; only `dinScrapeRouter`
  remains there (Task 5.8 PR-B). Page `AbpInvoiceSettlement.tsx`
  (4117 LOC) moved to `client/src/solar-rec/pages/` and switched from
  the dual-import (`trpc` for abp/csg + `solarRecTrpc` for dashboard)
  to a single aliased `solarRecTrpc as trpc` import. Legacy
  `/abp-invoice-settlement` URL kept as Wouter `<Redirect />`.
  **Task 2.3 (cross-month contamination override) shipped separately
  on 2026-04-27** in a focused fix PR — added `isCompleteMonthKey`
  helper to `lib/abpSettlement/utils/dateUtils.ts`, guarded the
  persistence `useEffect` against mid-typing keystrokes, and wrapped
  `setMonthKey` in a handler that flushes overrides under the
  previous month and loads the destination month's stored data
  before swapping state.
- ~~Address Checker — Task 5.11 PR-B~~ **DONE 2026-04-27 (with PR-A).**
  Unblocked by Task 5.9 the moment `abpSettlement.*` procs migrated
  to standalone. Pure file move + import swap + permission gate
  (`<PermissionGate moduleKey="address-checker">`). Page calls only
  `abpSettlement.cleanMailingData` and `verifyAddresses`, both now
  on `solarRecAppRouter`. Legacy `/address-checker` URL kept as
  Wouter `<Redirect />` to `/solar-rec/address-checker`.
- ~~Early Payment + Invoice Match Dashboard — Task 5.10~~
  **DONE 2026-04-27.** Pure file moves + permission gates + Wouter
  redirects. Both pages had no procs left on the main router by the
  time this task ran: `EarlyPayment` already called
  `solarRecTrpc.solarRecDashboard.*` (Task 5.5) and
  `solarRecTrpc.abpSettlement.*` (Task 5.9 PR-A compat shim from
  #133); `InvoiceMatchDashboard` is a pure client-side page (no
  trpc — file parsing + match logic only). The dual-import shim in
  `EarlyPayment.tsx` collapsed into the standard
  `solarRecTrpc as trpc` alias. The co-located `invoiceMatch/`
  helper directory moved alongside `InvoiceMatchDashboard.tsx`.
  Module keys: `early-payment` and `invoice-match` (both already
  registered in `shared/solarRecModules.ts`).
- Task 5.11 — split into 3 PRs because each utility has a different
  blocker:
  - ~~Zendesk Metrics — Task 5.11 PR-A~~ **DONE 2026-04-27.** Procs
    moved to `solarRecZendeskRouter.ts` with `requirePermission(
    "zendesk-metrics", level)`. Page moved to
    `client/src/solar-rec/pages/`. `server/routers/solarMisc.ts` (the
    zendesk-only file after #109's cleanup) deleted.
  - ~~Address Checker — Task 5.11 PR-B~~ — see Task 5.9 entry above
    (shipped together with the abpSettlement migration).
  - ~~Deep Update Synthesizer — Task 5.11 PR-C~~ **DONE 2026-04-27.**
    Page moved to `client/src/solar-rec/pages/`. Already used
    `solarRecTrpc` after Task 5.5 so no proc swap was needed —
    purely a file move + `<PermissionGate moduleKey=
    "deep-update-synthesizer">` + Wouter redirect. The data-flow
    PR-2 (#121) saveDataset signature change is backward-compatible
    (added `dbError: string | null`); existing call sites continue
    to work and show the actual error when one surfaces.

### Consequences of the split

- **Vendor API tokens on solar-rec are team-wide**, stored in
  `solarRecTeamCredentials`. Rhett's personal Google tokens stay on
  main and never mingle with team credentials. A credential rotation
  on solar-rec affects everyone on the team — accepted tradeoff.
- **Every migrated business table needs a `scopeId`** (or equivalent)
  for multi-tenant isolation within a single team. Some solar tables
  already have it (e.g. the 7 `srDs*` row tables); most do not yet.
- **Data visibility is team-wide within a scope.** Team members see
  each other's uploads, runs, results. What differs per user is
  *what they can do*, not *what they can see* — see the
  `dailyJobClaims`-style per-module permission model in Task 5.1.

### Canonical system key: CSG ID

The `CSG ID` is the single identifier for every system in the
portfolio. It comes from the **Solar Applications** dataset ("Main
system list with system size, price, and contract status"). The ABP ID
is a secondary identifier created after the CSG ID and may not exist
on a given system. Every workbench view, every mapping, every drill-in
keys off the CSG ID from Solar Applications. Vendor site IDs are
per-vendor, not canonical.

### Before editing any tRPC procedure

1. **Grep for the procedure name.** If it shows up in both
   `server/routers.ts` AND `server/_core/solarRecRouter.ts`, stop.
2. **Open `docs/server-routing.md`** and use the decision tree to
   figure out which file is live for your caller.
3. **Add a `_checkpoint: "unique-string"` field to the response** as
   your first change. Deploy. Verify the string appears in the
   browser devtools Network response. If it doesn't, the code isn't
   running — debug the deployment/routing, not the feature.
4. **Every long-running server job must have a version marker AND a
   raw-state debug endpoint** surfaced in the UI. Before debugging
   "why doesn't my fix work", the user should be able to click a
   button that dumps the raw DB state for the affected tables.

### Rule of thumb for editing (reflects today's wrong-side state)

- **Editing `solarRecDashboard.*`** → edit
  `server/_core/solarRecDashboardRouter.ts` (migrated 2026-04-26 in
  Task 5.5). Procedures use `requirePermission("solar-rec-dashboard",
  level)` with `t` from `_core/solarRecBase`. Clients call via
  `solarRecTrpc.solarRecDashboard.*`. The legacy
  `server/routers/solarRecDashboard.ts` no longer exists.
- **Editing `monitoring.*`, `users.*`, `auth.*`, `credentials.*`, or
  `enphaseV2.*` that's called from `client/src/solar-rec/pages/`** →
  edit `_core/solarRecRouter.ts`.
- **Anything else personal** → edit `server/routers.ts`.
- **New team/business feature** → edit `_core/solarRecRouter.ts` (or
  a new sibling sub-router file like `solarRecDashboardRouter.ts`,
  importing `t` and `requirePermission` from `_core/solarRecBase`).
  Do not pile onto `server/routers.ts`.

See `docs/server-routing.md` for the full URL → file map, the
dispatcher logic, and the verification recipe.

---

## READ THIS SECOND — verification, tooling, reuse

### Verification — the incremental tsc cache lies

`tsc --noEmit` uses `"incremental": true` and produces **persistent
false-positive errors** when files are saved mid-run. The only
reliable check:

```bash
./node_modules/.bin/tsc --noEmit --incremental false
```

If that shows zero errors, the codebase is clean — do not debug
further. For tests: `./node_modules/.bin/vitest run`.

### Always check `git status --short` before editing

The user runs phased refactors and typically has 5–15 dirty files.
Anything marked `M` or `??` is active WIP — **ask before touching**.

### Grep before implementing — these already exist

- **`fetchJson`** (`server/services/core/httpClient.ts`): timeout,
  retries on 429/5xx, backoff, structured errors. Do NOT write a
  new retry loop.
- **`solarConnectionFactory`** (`server/routers/solarConnectionFactory.ts`):
  9 cloud vendors use it. New vendors go through the factory.
- **Solar helpers** (`server/services/solar/helpers.ts`):
  `firstDayOfMonth`, `lastDayOfPreviousMonth`, `asDateKey`,
  `parseIsoDate`, `formatIsoDate`, `shiftIsoDate`, `toNullableString`,
  `safeRound`, `sumKwh`, and more. Import — do not redefine.
- **DB barrel** (`server/db.ts`): 38-line barrel over 26 domain
  modules in `server/db/`. New queries go in the right domain file.
- **tRPC index** (`server/routers.ts`): 110-line composition.
  Procedures live in `server/routers/*.ts` — never add directly
  to `routers.ts`.

### Split patterns

- **Server > ~1000 LOC**: barrel + domain modules (see `server/db.ts`).
- **React features**: extract to `feature.helpers.ts` +
  `feature.constants.ts` + `feature.types.ts` beside the component.

### Before deleting code

1. Grep `client/`, `server/`, `shared/`, `packages/`.
2. **Also grep aliased imports** — e.g., `solarRecTrpc` is imported
   as `trpc` in `client/src/solar-rec/pages/*.tsx`.
3. Recent `git log` activity = assume it's active, ask first.

### Stale references

Any LOC count, line number, or "inline at line N" in docs is likely
stale. Verify with `wc -l` / `grep` before acting on it. See
`SESSIONS_POSTMORTEM.md` for examples of sessions derailed by
stale references.

### Contemplate practical execution before writing code

`tsc --noEmit --incremental false` clean + tests passing means the
code is syntactically correct. It does **not** mean the code works.
Before you start typing a non-trivial change, spend 30 seconds
walking the actual runtime:

1. **Where does this run, and what intercepts events upstream?**
   OS shortcuts beat browser beat page. Chrome captures
   `Cmd+T` / `Cmd+W` / `Cmd+N` / `Cmd+Shift+T` at the browser level
   — page scripts never see the keydown, and `preventDefault()`
   cannot override them. If you need a keybind, add `Alt`/`Option`
   so the combo isn't reserved. The Task 4.6 Cmd+T bug
   shipped with clean tsc + tests because this check was skipped.
2. **Does the dev environment have the dependencies this assumes?**
   OAuth tokens (Google, WHOOP, Todoist), seeded rows,
   `samsungSyncPayloads` history, solar vendor credentials — most
   of these are absent in a fresh dev env. A feature that looks
   "working" in preview because the page renders is not verified
   if the underlying API call returned empty. Say so in the PR
   description; don't write "tested manually" when you only got to
   first paint.
3. **Real cadence and quotas.** Gmail's per-user rate limit,
   WHOOP's hourly cap, Samsung Health's Health Connect quota,
   solar vendor budgets. A 60-second poll feels fine until you
   multiply it by 17 vendors × 100 sites.
4. **Deployment boundaries.** Multi-instance deploys, rolling
   restarts, schema drift, feature flags defaulting off. Code that
   assumes one process on a warm cache is brittle. `dailyJobClaims`
   exists because the old in-process `lastRunDateKey` didn't
   survive this question.

When the answer to any of these is "I'm not sure," figure it out or
flag it in the PR description. Shipping on "it compiles" is how
user-facing bugs land.

### Schema migration safety — run before merging, not after

Merging a PR that touches `drizzle/schemas/*.ts` deploys code that
assumes the new column/table exists. **Drizzle's `select().from(t)`
enumerates every column declared in the schema**, so a missing
column on the live DB returns "Unknown column" on *every* call site
that reads that table — not just the new code path. This is how the
2026-04-24 auth outage happened: PR 1 added `solarRecUsers.isScopeAdmin`
and deployed to TiDB before migration 0031 was applied, which broke
`getSolarRecUserById` for every solar-rec request.

Migrations do **not** run automatically on deploy. Before merging a
PR that adds a migration:

1. Generate the migration locally: `pnpm db:push` (or
   `./node_modules/.bin/drizzle-kit generate --name <slug>`).
2. **Verify the migration file lands in `drizzle/NNNN_*.sql`** and a
   matching entry appears in `drizzle/meta/_journal.json`. If
   `drizzle-kit generate` picks a filename that collides with an
   existing migration, rename both the `.sql` and the corresponding
   snapshot file (`drizzle/meta/NNNN_snapshot.json`) to the next free
   integer, then update the `tag` in `_journal.json`.
3. **Run the migration against prod DATABASE_URL BEFORE merging the
   code PR**: `./node_modules/.bin/drizzle-kit migrate`. Confirm the
   table/column exists with a direct query (e.g.
   `SHOW COLUMNS FROM solarRecUsers LIKE 'isScopeAdmin'`).
4. If `drizzle-kit migrate` fails silently (exits non-zero with no
   error, or reports success but leaves the DB unchanged), apply the
   statements directly via `mysql2` and insert a row into
   `__drizzle_migrations` with the sha256 of the `.sql` file so
   future runs remain idempotent. The 2026-04-24 0031 application is
   the canonical example.
5. Only then is it safe to merge the code PR.

Corollary: **never split a schema change across two PRs** (e.g. "PR 1
adds schema + migration, PR 2 uses the column"). Once PR 1 deploys,
the column is in the Drizzle schema and every read of that table
fails until the migration applies. Either include the migration in
the PR that first uses the column, or apply the migration to prod
*before* merging the schema PR.

---

## Project Structure

```
.
├── productivity-hub/              # Main web app (git repo)
│   ├── client/src/                # React 19 frontend
│   │   ├── main.tsx               # Main app entry (URL: /)
│   │   ├── solar-rec-main.tsx     # Solar REC standalone entry (URL: /solar-rec/*)
│   │   ├── features/              # ~45 route pages, organized by domain
│   │   │   ├── _shared/           # Cross-feature helpers (insights/, etc.)
│   │   │   ├── dashboard/         # Home, Dashboard, widgets, AbpInvoiceSettlement, AddressChecker, EarlyPayment, InvoiceMatchDashboard, DinScrapeManager, etc.
│   │   │   ├── habits/            # Habits.tsx + sub-panels (protocol, today, history, insights, sleep)
│   │   │   ├── health/            # Health.tsx + sub-panels (today, trends, sleep, insights)
│   │   │   ├── notebook/          # Notebook.tsx
│   │   │   ├── settings/          # Settings.tsx
│   │   │   ├── solar-rec/         # SolarRecDashboard.tsx
│   │   │   └── supplements/       # Supplements.tsx + sub-panels (today, protocol, adherence, cost, insights, restock, experiments, prices)
│   │   ├── workers/               # Web workers (csvParser)
│   │   ├── solar-rec/             # Solar REC standalone-only components
│   │   │   ├── SolarRecApp.tsx    # Wouter router for the standalone app
│   │   │   ├── solarRecTrpc.ts    # solarRecTrpc client (NOT the main trpc)
│   │   │   └── pages/             # MonitoringDashboard, MonitoringOverview, SolarRecSettings, ContractScanner, ContractScrapeManager, DeepUpdateSynthesizer, ZendeskTicketMetrics, meter-reads/ (16 per-vendor pages)
│   │   ├── solar-rec-dashboard/   # Extracted modules for SolarRecDashboard.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── contexts/
│   │   └── lib/
│   │       └── trpc.ts            # Main trpc client, typed against server/routers.ts
│   ├── server/
│   │   ├── routers.ts             # MAIN tRPC router (see warning above)
│   │   ├── _core/
│   │   │   ├── index.ts           # Express setup, tRPC mount points, dispatcher
│   │   │   ├── solarRecRouter.ts  # Standalone solar-rec tRPC router (see warning above)
│   │   │   ├── solarRecBase.ts    # Shared `t` and `requirePermission` for solar-rec sub-routers
│   │   │   ├── solarRecDashboardRouter.ts   # Solar REC dashboard sub-router (Task 5.5)
│   │   │   ├── solarRecContractScanRouter.ts # Solar REC contract-scan sub-router
│   │   │   ├── solarRecZendeskRouter.ts     # Zendesk ticket metrics sub-router (Task 5.11)
│   │   │   ├── solarRecAuth.ts    # /solar-rec/api/auth/* endpoints
│   │   │   ├── vite.ts            # Serves the right HTML for main vs /solar-rec/
│   │   │   └── ...                # security, pinGate, env, sdk, schedulers, misc infrastructure
│   │   ├── db.ts                  # Database client & query helpers
│   │   ├── services/              # 30+ external API integrations + job runners
│   │   │   ├── core/              # Job runners, contract scanners, address cleaning
│   │   │   ├── integrations/      # Google, Todoist, Clockify, etc.
│   │   │   ├── notifications/     # Notification services
│   │   │   ├── solar/             # 15 vendor adapters (APSystems, eGauge, EKM, eNNexos, EnphaseV4, Fronius, Generac, GoodWE, Growatt, Hoymiles, Locus, SolarEdge, SolarLog, Solis, TeslaPowerhub) + dataset/snapshot helpers
│   │   │   └── supplements/       # Supplement correlation & price-watcher services
│   │   ├── scripts/               # Migration & reconciliation utilities
│   │   └── helpers/
│   ├── shared/
│   ├── drizzle/                   # DB migrations, schema.ts (root-level)
│   ├── docs/
│   │   └── server-routing.md      # Canonical URL → router file map
│   └── drizzle.config.ts
├── packages/
│   └── scripts/                   # Root-level utility scripts (Python/Node meter-read converters)
├── SESSIONS_POSTMORTEM.md         # Symlink → productivity-hub/docs/SESSIONS_POSTMORTEM.md
├── CLAUDE.md                      # This file
└── sunpower-reader/               # Expo React Native app (solar monitoring)
```

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Tailwind CSS 4, shadcn/ui (Radix), Wouter (routing), TanStack React Query, Framer Motion, Recharts, Tiptap
- **Backend**: Express 4, tRPC 11 (type-safe API), Node.js 22+
- **Database**: MySQL/TiDB via Drizzle ORM (mysql2 driver)
- **Auth**: Manus OAuth + custom OAuth flows (Google, Microsoft, Todoist)
- **Storage**: AWS S3-compatible
- **Package Manager**: pnpm

## Commands

All commands run from `productivity-hub/`:

```bash
pnpm dev                    # Start dev server (tsx watch, port 3000)
pnpm build                  # Build client (Vite) + server (esbuild)
pnpm start                  # Run production build
pnpm check                  # TypeScript type check
pnpm format                 # Prettier format
pnpm test                   # Vitest (server tests only)
pnpm db:push                # Generate + run Drizzle migrations
pnpm scheduleb:reconcile    # Reconcile Schedule B import state
pnpm solarrec:migrate-scope # Backfill scopeId on solar-rec dashboard tables
```

## Environment

Copy `productivity-hub/.env.example` to `.env`. Key variables:

- `DATABASE_URL` - MySQL connection string
- `JWT_SECRET` - Session signing key
- `PORT` - Server port (default 3000)
- `DEV_BYPASS_AUTH` - Skip auth in development

Most API keys (Google, Todoist, OpenAI) are stored per-user in the database via the Settings UI.

## Code Conventions

- **Formatting**: Prettier - 2 spaces, double quotes, semicolons, 80-char width
- **Path aliases**: `@/*` -> `client/src/*`, `@shared/*` -> `shared/*`, `@client/*` -> `client/src/*`, `@server/*` -> `server/*`
- **DB columns**: snake_case; JS variables: camelCase
- **API**: tRPC procedures (`publicProcedure`, `protectedProcedure`, `adminProcedure`)
- **State**: React Query for server state, React Context for theme only - no Redux/Zustand
- **Routing**: Wouter (lightweight), lazy-loaded pages with Suspense
- **Validation**: Zod schemas for runtime validation

## Architecture Notes

- **tRPC routing**: see the warning section above and
  `productivity-hub/docs/server-routing.md`. Do NOT assume a
  `server/_core/*.ts` file is framework code until you've checked
  whether any live URLs route to it.
- **Long-running server jobs** (contract scraper, Schedule B PDF
  import, etc.) must expose a `_runnerVersion` marker in their
  status endpoint AND a debug endpoint that returns the raw DB
  state. See `server/routers.ts` `getScheduleBImportStatus` and
  `debugScheduleBImportRaw` for the canonical pattern. These are
  the ONLY way to verify "is my code actually running" without
  local reproduction.
- **Canonical job-runner pattern**: see
  `server/services/contractScanJobRunner.ts`. Atomic counter
  columns on the job row. Concurrent worker pool via
  `mapWithConcurrency`. Every processed item writes a result row
  BEFORE incrementing the counter. No file-status derived counts.
  The Schedule B runner
  (`server/services/scheduleBImportJobRunner.ts`) mirrors this
  pattern after the 2026-04-10 rewrite.
- OAuth tokens for integrations are stored in the `integrations`
  DB table and refreshed via `tokenRefresh.ts`.
- Solar integrations span 15 vendor adapters in
  `server/services/solar/`: APSystems, eGauge, EKM, eNNexos,
  EnphaseV4, Fronius, Generac, GoodWE, Growatt, Hoymiles, Locus,
  SolarEdge, SolarLog, Solis, Tesla Powerhub. Enphase V2 was
  deprecated; SunPower and Tesla Solar are read via CSV/manual
  meter-read pages, not a server-side adapter.
- Tests run in Node env with timezone America/Chicago. Server tests:
  `server/**/*.test.ts`. Shared tests: `shared/**/*.test.ts`. Client
  pure-function tests: `client/src/solar-rec-dashboard/**/*.test.ts`
  plus selected feature dirs (`client/src/features/dashboard/**`,
  `supplements/**`, `habits/**`, `health/**`). See `vitest.config.ts`
  for the exact include list.

## Testing

Vitest config: `productivity-hub/vitest.config.ts`
- Node environment, no jsdom
- Server tests: `server/**/*.test.ts`, `server/**/*.spec.ts`
- Shared tests: `shared/**/*.test.ts`
- Client pure-function tests:
  `client/src/solar-rec-dashboard/**/*.test.ts`,
  `client/src/features/dashboard/*.test.ts` plus the
  `frontpage/`, `river/`, `canvas/`, `command/` subtrees, and
  `client/src/features/{supplements,habits,health}/**/*.test.ts`
- TZ=America/Chicago

## Before shipping any server-side fix

A checklist distilled from painful experience (see
`SESSIONS_POSTMORTEM.md`):

1. **Read the working equivalent first.** If a similar feature works
   elsewhere in the codebase, read its code BEFORE editing the
   broken one. Compare the structural patterns.
2. **Verify the procedure's live path.** Use the dual-router checklist
   above. Add a `_checkpoint` string on your first deploy.
3. **Don't treat stderr warnings as cause.** pdfjs emits
   `TT: undefined function: 32` and similar for any PDF with
   embedded TrueType fonts. The Contract Scraper hits them too and
   parses fine. Verify warnings actually affect behavior before
   chasing them.
4. **Write down the plan.** Multi-commit fixes are a smell. If the
   plan takes more than 2 commits to ship, you probably don't
   understand the problem yet. Stop and investigate before
   patching.
5. **Don't delete files from `_core/` without auditing first.** Some
   `_core/*.ts` files are legitimate framework infrastructure (Express
   setup, auth middleware). Others are dead copies. `grep` for
   imports + trace all the URL mount points before touching
   anything in that directory.

---

## Solar REC Dashboard data flow (canonical, post 2026-04-27 — Tasks 5.12 + 5.13 + 5.14 complete)

This section locks down the architecture established by PRs #120–#175
(the data-flow series + Task 5.12 + Task 5.13 + Task 5.14). Read this
before adding any new tRPC procedure that touches dashboard data,
before changing how rows are loaded, or before extending
`getSystemSnapshot`.

### Source of truth per dataset

**All 18 dashboard datasets are row-backed.** Task 5.12 (PRs 1–10)
migrated the 11 non-row-backed datasets that the original data-flow
series didn't cover; Task 5.13 (PRs 1–5) moved every dashboard tab
off raw `datasets[k].rows` arrays. The split between "row-backed"
and "non-row-backed" no longer exists.

For every dataset:

→ **`srDs*` row tables are canonical.**
→ The chunked-CSV blob in `solarRecDashboardStorage` + S3 is a
  derived artifact (rebuilt on demand from rows; never authored
  directly). The dashboard's cold-cache hydration reads it via the
  per-key `getDataset` route (chunk-bounded by
  `REMOTE_DATASET_CHUNK_CHAR_LIMIT = 250 KB`) — the legacy
  `getDatasetAssembled` batch procedure was removed in Task 5.14
  PR-6 (#175). The blob still backs `convertedReadsBridge.ts` +
  `serverSideMigration.ts` + Schedule B import, and remains the
  authoritative input for the per-key + chunk-pointer reassembly
  path.
→ Active version is pinned by `solarRecActiveDatasetVersions`.
→ "Cloud verified" REQUIRES `solarRecDatasetSyncState.dbPersisted = true`
  (data-flow PR-2). Storage existence alone never qualifies.

The 18 dataset keys (`DatasetKey` union in
`client/src/solar-rec-dashboard/state/types.ts`):

`solarApplications`, `abpReport`, `generationEntry`,
`accountSolarGeneration`, `annualProductionEstimates`,
`contractedDate`, `convertedReads`, `deliveryScheduleBase`,
`transferHistory`, `generatorDetails`, `abpCsgSystemMapping`,
`abpProjectApplicationRows`, `abpPortalInvoiceMapRows`,
`abpCsgPortalDatabaseRows`, `abpQuickBooksRows`,
`abpUtilityInvoiceRows`, `abpIccReport2Rows`, `abpIccReport3Rows`.

Each maps 1:1 to a `srDs*` table in `drizzle/schemas/solar.ts`.

### Wire payload contracts (max sizes the server will ship)

| Endpoint | Returns | Max size |
|---|---|---|
| `getSystemSnapshot` | Pre-computed system records | ~200 KB |
| `getDatasetSummariesAll` | Counts + metadata for all 18 datasets | ~5 KB |
| `getDatasetRowsPage` | One page of `srDs*` rows | ~30-300 KB |
| `getDatasetCsv` | Server-built CSV from paginated reads | ≤25 MB |
| `getDataset` (per-key chunk-pointer reader) | One chunk of a chunked-CSV blob | ≤250 KB per call |
| `getDatasetCloudStatuses` | Recoverability per dataset | ~10 KB |
| `debugDatasetPersistenceRaw` | Raw rows from every layer + verdict | ~2 KB |
| `getDashboard<TabName>Aggregates` (DeliveryTracker / TrendDeliveryPace / TrendsProduction / ContractVintage / AppPipelineMonthly / AppPipelineCashFlow) | Per-tab aggregate result | ~10–500 KB |

**No tRPC response in the dashboard data path exceeds 1 MB
uncompressed.** The 50–150 MB responses that caused the 2026-04-26
Chrome tab OOM are eliminated. The legacy `getDatasetAssembled`
batch procedure (the only codepath that could exceed the cap) was
removed in Task 5.14 PR-6 (#175); cold-cache hydration now always
takes the per-key `getDataset` route, capped at 250 KB per chunk.

### Tabs migration — DONE

All 6 dashboard tabs scheduled in Task 5.13 are off raw rows:

| Tab | PR | Server aggregator |
|---|---|---|
| DeliveryTrackerTab | #142 (PR-1) | `buildDeliveryTrackerData.ts` |
| AlertsTab | #144 (PR-2, shared) | `buildTrendDeliveryPace.ts` |
| TrendsTab (delivery pace) | #144 (PR-2, shared) | `buildTrendDeliveryPace.ts` |
| TrendsTab (production) | #153 (PR-4) | `buildTrendsProduction.ts` |
| ContractsTab | #146 (PR-3, shared) | `buildContractVintageAggregates.ts` |
| AnnualReviewTab | #146 (PR-3, shared) | `buildContractVintageAggregates.ts` |
| ApplicationPipelineTab | #156 (PR-5) | `buildAppPipelineMonthly.ts` + `buildAppPipelineCashFlow.ts` |

Pattern for any new tab aggregate:
- Aggregates → extend `getSystemSnapshot` to include the per-tab
  pre-aggregate (monthly bucket map, alert list, etc.) OR add a
  dedicated `getDashboard<TabName>Aggregates` query backed by a
  shared aggregator + `solarRecComputedArtifacts` cache. The
  canonical templates are `buildDeliveryTrackerData.ts` (single-
  dataset, Date round-trip via superjson) and
  `buildContractVintageAggregates.ts` (multi-dataset, joins through
  the system snapshot's eligibility filter).
- Detail rows → use `getDatasetRowsPage` infinite-query pattern

### Persistence write contract

Every dataset upload must end with EITHER:

- All three layers consistent: `solarRecDashboardStorage` row written
  + S3 blob written + `solarRecDatasetSyncState.dbPersisted=true`,
  `storageSynced=true` + active batch in
  `solarRecActiveDatasetVersions` with `rowCount > 0` in srDs*; OR
- A surfaced error that the client UI shows. **No silent partial-success.**

`saveDataset` returns `dbError: string | null` (data-flow PR-2). When
non-null, the client should render the actual message — not a generic
"synced" badge. The badge logic itself (`isChildKeyRecoverable` in
`datasetCloudStatus.ts`) requires `dbPersisted=true`.

The `convertedReads` monitoring bridge
(`server/solar/convertedReadsBridge.ts`) writes via the chunked-CSV
manifest path (multi-source `_rawSourcesV1` semantics) and then
schedules a fire-and-forget `startSyncJob(scopeId, "convertedReads",
…)` so `srDsConvertedReads` reaches consistency without blocking the
bridge call. Single-flight in `coreDatasetSyncJobs` coalesces
multiple bridge writes (e.g., the 17-vendor monitoring batch) into
one sync job per scope.

### Diagnostic surface

- **`debugDatasetPersistenceRaw(datasetKey)`** — raw row from every
  persistence layer + verdict (`consistent` / `storage-only` /
  `db-only` / `row-table-stale` / `no-active-batch` / `missing`).
  Use this BEFORE chasing a hypothesis about why a dataset shows
  "LOCAL-ONLY" or "Cloud sync failed."
- **`debugDatasetSyncStateRaw(datasetKey)`** — chunk-level walk of
  the chunked-CSV manifest for cases where the row-table verdict is
  `consistent` but the legacy hydration path looks wrong.
- **`_runnerVersion`** appears on every saveDataset /
  getDataset / getDatasetCloudStatuses /
  getDatasetSummariesAll / getDatasetRowsPage / getDatasetCsv /
  debugDatasetPersistenceRaw / getDashboard<TabName>Aggregates
  response. Verify it matches what you just deployed before
  assuming the new code is running.

### Hard rules

1. **No tRPC procedure is allowed to materialize a full `CsvRow[]`
   greater than 5,000 rows in memory** for wire-payload purposes.
   Use `loadDatasetRowsPage` for pagination or `loadDatasetRows`
   only when the result is consumed in-process by an aggregator
   that itself returns a small result. The grandfather clause for
   `getDatasetAssembled` is gone — the procedure was removed in
   Task 5.14 PR-6 (#175). Cold-cache hydration now reads chunks via
   the per-key `getDataset` route (250 KB cap per call).
2. **No client tab is allowed to read `datasets[key].rows` or
   `datasets[key].rows.length` for ANY of the 18 dataset keys.** Use
   `getDatasetSummariesAll` for counts, `getDatasetRowsPage` /
   `getDatasetCsv` for detail rows, or
   `getDashboard<TabName>Aggregates` for tab-level rollups. Reading
   `datasets[key].uploadedAt` for staleness checks is still allowed
   for tabs that haven't migrated their per-dataset metadata
   readouts (DataQualityTab, AlertsTab) — that path comes from the
   summaries query, not the legacy hydration.
3. **No new procedure that returns rows is allowed to omit a
   `_runnerVersion` marker.** Future deploys depend on it.
4. **No silent error swallowing in persistence paths.** `console.warn`
   is for normal-but-noteworthy events; persistence failures are
   `console.error` and surface to the client response.
