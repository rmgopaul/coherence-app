# Productivity Hub

> **Last updated:** 2026-04-20

Full-stack personal productivity dashboard integrating Google Calendar, Gmail, Drive, Todoist, ChatGPT, health tracking (Whoop, Samsung Health), and 25+ solar energy monitoring systems.

---

## Current roadmap

- **[docs/execution-plan.md](docs/execution-plan.md)** — phased plan of record (currently v4). Do not reorder phases or skip gates without approval.
- **[docs/execution-log.md](docs/execution-log.md)** — append-only log of task completions against the plan.

---

## 🚨 READ THIS FIRST — the dual tRPC router trap

**If you skip this section and start editing tRPC procedures, you will
lose hours. This has already happened. Read
`SESSIONS_POSTMORTEM.md` at the project root for the 2026-04-10
story.**

This repo has **two** tRPC routers with overlapping sub-router names:

- `productivity-hub/server/routers.ts` — `appRouter`, the **live** router
  for everything the main productivity dashboard + the
  SolarRecDashboard page (and its Schedule B scanner) call.
- `productivity-hub/server/_core/solarRecRouter.ts` — `solarRecAppRouter`,
  a mostly-separate router used only by 3 pages under
  `client/src/solar-rec/pages/` (MonitoringDashboard,
  MonitoringOverview, SolarRecSettings). Its `solarRecDashboard`
  sub-router is **dead code** — no client calls it — but the file
  itself is NOT dead (it serves `monitoring.*`, `users.*`, `auth.*`,
  `credentials.*`, `enphaseV2.*` for the 3 pages above).

**Before editing ANY tRPC procedure, do this checklist:**

1. **Grep for the procedure name.** If it shows up in both
   `server/routers.ts` AND `server/_core/solarRecRouter.ts`, stop.
2. **Open `productivity-hub/docs/server-routing.md`** and use the
   decision tree to figure out which file is live for your caller.
3. **Add a `_checkpoint: "unique-string"` field to the response** as
   your first change. Deploy. Verify the string appears in the
   browser devtools Network response. If it doesn't, the code isn't
   running — debug the deployment/routing, not the feature.
4. **Every long-running server job must have a version marker AND a
   raw-state debug endpoint** surfaced in the UI. Before debugging
   "why doesn't my fix work", the user should be able to click a
   button that dumps the raw DB state for the affected tables.

**Rule of thumb for editing**:
- **Editing `solarRecDashboard.*`, or anything used from
  `client/src/features/`** → edit `server/routers.ts`. Leave
  `_core/solarRecRouter.ts` alone.
- **Editing `monitoring.*`, `users.*`, `auth.*`, `credentials.*`, or
  `enphaseV2.*` that's called from `client/src/solar-rec/pages/`** →
  edit `_core/solarRecRouter.ts`.
- **Anything else** → edit `server/routers.ts`.

See `productivity-hub/docs/server-routing.md` for the full URL →
file map, the dispatcher logic, and the verification recipe.

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
- **DB barrel** (`server/db.ts`): 31-line barrel over 19 domain
  modules in `server/db/`. New queries go in the right domain file.
- **tRPC index** (`server/routers.ts`): 134-line composition.
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

---

## Project Structure

```
.
├── productivity-hub/              # Main web app (git repo)
│   ├── client/src/                # React 19 frontend
│   │   ├── main.tsx               # Main app entry (URL: /)
│   │   ├── solar-rec-main.tsx     # Solar REC standalone entry (URL: /solar-rec/*)
│   │   ├── features/              # ~41 route pages, organized by domain
│   │   │   ├── dashboard/         # Home, Dashboard, widgets, ContractScanner, etc.
│   │   │   ├── habits/            # Habits.tsx + sub-panels (protocol, today, history, insights, sleep)
│   │   │   ├── health/            # Health.tsx + sub-panels (today, trends, sleep, insights)
│   │   │   ├── notebook/          # Notebook.tsx
│   │   │   ├── settings/          # Settings.tsx
│   │   │   ├── solar-readings/    # Per-vendor meter read pages (18 files; 17 vendors, Enphase has 2 pages: V2, V4)
│   │   │   ├── solar-rec/         # SolarRecDashboard.tsx
│   │   │   └── supplements/       # Supplements.tsx + sub-panels (today, protocol, adherence, cost, insights, restock, experiments, prices)
│   │   ├── workers/               # Web workers (csvParser, systems)
│   │   ├── solar-rec/             # Solar REC standalone-only components
│   │   │   ├── SolarRecApp.tsx    # Wouter router for the standalone app
│   │   │   ├── solarRecTrpc.ts    # solarRecTrpc client (NOT the main trpc)
│   │   │   └── pages/             # MonitoringDashboard, MonitoringOverview, Settings
│   │   ├── solar-rec-dashboard/   # Extracted modules for SolarRecDashboard.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── contexts/
│   │   └── lib/
│   │       ├── trpc.ts            # Main trpc client, typed against server/routers.ts
│   │       └── solarRecTrpc.ts    # (legacy re-export; prefer solar-rec/solarRecTrpc.ts)
│   ├── server/
│   │   ├── routers.ts             # MAIN tRPC router (see warning above)
│   │   ├── _core/
│   │   │   ├── index.ts           # Express setup, tRPC mount points, dispatcher
│   │   │   ├── solarRecRouter.ts  # Standalone solar-rec tRPC router (see warning above)
│   │   │   ├── solarRecAuth.ts    # /solar-rec/api/auth/* endpoints
│   │   │   ├── vite.ts            # Serves the right HTML for main vs /solar-rec/
│   │   │   └── ...                # security, pinGate, env, sdk, misc infrastructure
│   │   ├── db.ts                  # Database client & query helpers
│   │   ├── services/              # 30+ external API integrations + job runners
│   │   │   ├── core/              # Job runners, contract scanners, address cleaning
│   │   │   ├── integrations/      # Google, Todoist, Clockify, etc.
│   │   │   ├── notifications/     # Notification services
│   │   │   ├── solar/             # 17 vendor APIs (Enphase, SolarEdge, eGauge, etc.)
│   │   │   └── supplements/       # Supplement correlation & price-watcher services
│   │   ├── scripts/               # Migration & reconciliation utilities
│   │   └── helpers/
│   ├── shared/
│   ├── packages/
│   │   └── config/                # Shared configuration package (@config/*)
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
- **Path aliases**: `@/*` -> `client/src/*`, `@shared/*` -> `shared/*`, `@client/*` -> `client/src/*`, `@server/*` -> `server/*`, `@config/*` -> `packages/config/src/*`
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
- Solar integrations span 17 vendor APIs: APSystems, eGauge, EKM,
  eNNexos, Enphase (V2, V4), Fronius, Generac, GoodWE, Growatt,
  Hoymiles, Locus, SolarEdge, SolarLog, Solis, SunPower, Tesla
  Powerhub, Tesla Solar.
- Tests run in Node env with timezone America/Chicago. Server tests:
  `server/**/*.test.ts`. Client pure-function tests:
  `client/src/solar-rec-dashboard/**/*.test.ts`.

## Testing

Vitest config: `productivity-hub/vitest.config.ts`
- Node environment, no jsdom
- Server tests: `server/**/*.test.ts`
- Client pure-function tests: `client/src/solar-rec-dashboard/**/*.test.ts`
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
