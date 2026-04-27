# Architectural split — main vs. solar-rec

> Companion to `CLAUDE.md`'s **dual tRPC router boundary** section.
> CLAUDE.md has the operational rules (checklist, edit-what-where);
> this doc has the design rationale + the feature/table inventory.

## One-line summary

**Main (`/`)** is Rhett's single-user personal productivity surface.
**Solar-rec (`/solar-rec/*`)** is the team's multi-user business
surface. Every feature belongs to exactly one.

## Why two surfaces

Main grew up as a personal dashboard. Solar-rec grew up inside of it
as business tooling Rhett happened to need alongside his dashboard.
The mix worked when Rhett was the only user. It stops working when
teammates come on board, because:

- **Auth model** — main uses Rhett's personal Google tokens; solar-rec
  needs a team auth path (standalone OAuth, per-user `solarRecUsers`
  rows, optional PIN gate).
- **Data visibility** — main is "everything is mine"; solar-rec needs
  "everything in this scope is ours" plus per-module permissions
  ("Amy can run contract scans but can't touch ABP settlement").
- **Credential sharing** — main stores per-user integration rows;
  solar-rec stores team-wide vendor API tokens in
  `solarRecTeamCredentials` so everyone on the team uses the same
  Enphase/SolarEdge/etc. credentials.
- **Feature surface** — main's feeds (Gmail, WHOOP, markets) are
  personal by nature and never make sense to share; solar-rec's jobs
  (Schedule B import, contract scan, ABP settlement) are team
  workflows where operators pick up each other's work mid-stream.

The two can't be merged without either giving teammates Rhett's
personal tokens, or forcing Rhett to use a multi-user scope for his
own dashboard. Neither is acceptable.

## Decision rule for a new feature

| Question | If yes → main (`/`) | If yes → solar-rec (`/solar-rec/*`) |
|---|---|---|
| Does only Rhett use it? | ✅ | |
| Does a teammate need to see the data or take actions on it? | | ✅ |
| Does it consume a per-user personal credential (WHOOP, Samsung Health, Rhett's personal Google)? | ✅ | |
| Does it consume a shared vendor token (solar APIs)? | | ✅ |
| Is it a feed/widget on the personal dashboard? | ✅ | |
| Is it a job runner, import pipeline, or multi-person operator workflow? | | ✅ |

If more than one "yes" splits between columns, **lean solar-rec** and
carve the personal slice out as a thin main-side wrapper.

## Where things live today (and where they're going)

### Main (`server/routers.ts`) — correct placement

Personal productivity. No migration planned.

- Front-page dashboard and all view variants
- Legacy dashboard
- King of the Day
- DropDock
- Canvas
- Notebook
- Supplements (definitions, logs, adherence, cost, insights, restock,
  experiments, prices)
- Habits (definitions, today, history, insights, categories)
- Health (WHOOP summary, trends, sleep, insights)
- Sleep notes
- Clockify timer
- Global feedback widget
- Personal settings
- Feed sources: Todoist, Gmail, Calendar, Drive, WHOOP, Samsung Health
  / Health Connect, markets/stocks, weather, news, sports, ChatGPT,
  daily/weekly brief
- Preferences, OAuth creds storage for personal integrations

### Main today, solar-rec tomorrow (`server/routers.ts` → pending
migration)

These sit on `server/routers.ts` for historical reasons. They belong
on solar-rec. Don't extend them without checking the migration timing.

| Feature | Migrates in |
|---|---|
| ~~`solarRecDashboard.*` (dashboard + Schedule B scanner inside it)~~ | ~~Task 5.5~~ ✅ done |
| Daily monitoring scheduler + `monitoringApiRuns` + `monitoringBatchRuns` | Task 5.3 |
| 9 meter-read pages (Fronius, SolarEdge, EnnexOs, eGauge, APsystems, Hoymiles, TeslaPowerhub, EnphaseV4, TeslaSolar) — consolidated into `MeterReadsPage` by Task 4.7 first | Task 5.4 |
| ~~Schedule B import + CSG Schedule B import~~ | ~~Task 5.6~~ ✅ done (folded into 5.5 since the procs lived in `solarRecDashboardRouter`) |
| ~~Contract scan runner + ContractScanner + ContractScrapeManager~~ | ~~Task 5.7~~ ✅ done |
| ~~DIN scrape runner + DinScrapeManager~~ | ~~Task 5.8~~ ✅ done |
| ~~ABP Invoice Settlement (4,070 LOC)~~ | ~~Task 5.9~~ ✅ done |
| Early Payment + Invoice Match Dashboard (EarlyPayment has a compat shim post-5.9) | Task 5.10 |
| ~~Address Checker, Zendesk Metrics, Deep Update Synthesizer~~ | ~~Task 5.11~~ ✅ done (PR-A 5.11 zendesk; PR-B 5.11 address checker shipped with 5.9; PR-C 5.11 deep update) |

### Solar-rec (`server/_core/solarRecRouter.ts`) — correct placement

Already on the solar-rec router. These are the kernel that the Phase 5
migration grows around.

- `monitoring.*` — monitoring overview + exec
- `users.*` — solar-rec user directory
- `auth.*` — solar-rec OAuth + session
- `credentials.*` — team-shared vendor tokens (`solarRecTeamCredentials`)
- `enphaseV2.*` — legacy pre-Phase-5 holdover; Task 4.2 removes it

## Scope-aware vs. user-aware tables

Multi-tenant isolation on solar-rec uses `scopeId` (a scope row per
team). The distinction matters for every migrated table.

### Already scope-aware

- `solarRecScopes`
- The 7 normalized dataset row tables (`srDsSolarApplications`,
  `srDsAbpReport`, `srDsGenerationEntry`, `srDsAccountSolarGeneration`,
  `srDsContractedDate`, `srDsDeliverySchedule`, `srDsTransferHistory`)
- `solarRecComputedArtifacts`
- `solarRecUsers` / `solarRecInvites` (joined via `scopeId`)

### Still user-aware (needs migration)

- `solarRecDashboardStorage` — currently keyed by `userId`; blocker for
  cross-user Phase 5. See [cloud-sync-findings](triage/cloud-sync-findings.md).
- `solarRecDatasetSyncState` — same.
- `monitoringApiRuns` / `monitoringBatchRuns` — migrate with Task 5.3.
- `contractScanJobs`, `dinScrapeJobs`, `scheduleBImportJobs` — migrate
  with the respective Phase 5 tasks (5.7 / 5.8 / 5.6).

### Intentionally user-aware (stays on main)

Anything tied to a personal credential or personal productivity state:
`dailyHealthMetrics`, `samsungSyncPayloads`, `integrations` (for
personal Google/WHOOP/Todoist), `dockItems`, `userKingOfDay`,
`habitDefinitions`, `supplementDefinitions`, `noteLinks`, etc.

## Canonical system key: CSG ID

Every system in the portfolio has a **CSG ID**, sourced from the
**Solar Applications** dataset. Any view that talks about "a system"
keys off CSG ID. The **ABP ID** is a secondary identifier created
downstream and may not exist on every system. Vendor site IDs are
per-vendor and not canonical.

When building a new workbench view or join, start from
`srDsSolarApplications.csgId` and join outward. Don't derive a
system's identity from a vendor's site ID — it won't work for systems
on a different vendor and won't survive monitoring-provider migrations.

## Permissions (Phase 5 Task 5.1)

On solar-rec, every module has a `moduleKey` and each user has a
permission per module: `none` / `read` / `edit` / `admin`. Data
visibility is team-wide; permissions gate *actions*, not *reads*.
Details are in the execution plan's Task 5.1 section — this doc
doesn't try to re-specify that design.

## References

- `CLAUDE.md` — the operational "edit what, where" rules.
- `docs/execution-plan.md` — phased plan of record; Phase 5 Tasks
  5.1–5.11 carry out the migrations referenced here.
- `docs/server-routing.md` — URL → file map + dispatcher logic.
- `docs/triage/cloud-sync-findings.md` — why the user-to-scope
  migration (Phase 5 prerequisite) is non-trivial.
- `docs/SESSIONS_POSTMORTEM.md` — history of incidents that shaped
  these rules.
