import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import {
  authRouter,
  twoFactorRouter,
  integrationsRouter,
  oauthCredsRouter,
  preferencesRouter,
  marketDashboardRouter,
  sportsRouter,
  feedbackRouter,
} from "./routers/auth";
// Task 5.5 (2026-04-26): solarRecDashboard moved to the standalone
// Solar REC router (server/_core/solarRecDashboardRouter.ts). It is
// no longer mounted on the main /api/trpc tree — every call now goes
// through /solar-rec/api/trpc/solarRecDashboard.* via the dispatcher
// in _core/index.ts.
// Task 5.11 PR-A (2026-04-27): zendeskRouter migrated to the
// standalone Solar REC router (server/_core/solarRecZendeskRouter
// .ts). Every call now goes through /solar-rec/api/trpc/zendesk.*
// via the dispatcher in _core/index.ts. server/routers/solarMisc.ts
// is deleted in this PR — it had no other exports left after the
// 2026-04-26 cleanup (#109).
// Task 5.9 PR-A (2026-04-27): csgPortalRouter + abpSettlementRouter
// migrated to the standalone Solar REC router (server/_core/
// solarRecCsgPortalRouter.ts + server/_core/solarRecAbpSettlement
// Router.ts). Every call now goes through /solar-rec/api/trpc/
// {csgPortal,abpSettlement}.* via the dispatcher in _core/index.ts.
// Task 5.8 PR-B (2026-04-27): dinScrapeRouter migrated to the
// standalone Solar REC router (server/_core/solarRecDinScrape
// Router.ts). Every call now goes through /solar-rec/api/trpc/
// dinScrape.* via the dispatcher. server/routers/jobRunners.ts is
// deleted in this PR — it had no other exports left after the
// Task 5.9 PR-A cleanup.
import {
  clockifyRouter,
  todoistRouter,
  conversationsRouter,
  openaiRouter,
  googleRouter,
  whoopRouter,
  samsungHealthRouter,
} from "./routers/productivity";
import {
  metricsRouter,
  searchRouter,
  supplementsRouter,
  habitsRouter,
  sleepRouter,
  notesRouter,
  dataExportRouter,
  dockRouter,
  engagementRouter,
  anthropicRouter,
  solarReadingsRouter,
} from "./routers/personalData";
import { kingOfDayRouter } from "./routers/kingOfDay";
import { weatherRouter } from "./routers/weather";
import { newsRouter } from "./routers/news";

// ---------------------------------------------------------------------------
// App Router — thin composition of all sub-routers
// ---------------------------------------------------------------------------

export const appRouter = router({
  system: systemRouter,

  // Auth & user management
  auth: authRouter,
  twoFactor: twoFactorRouter,
  integrations: integrationsRouter,
  oauthCreds: oauthCredsRouter,
  preferences: preferencesRouter,
  marketDashboard: marketDashboardRouter,
  sports: sportsRouter,
  feedback: feedbackRouter,

  // Solar REC dashboard — migrated in Task 5.5 (2026-04-26) to
  // server/_core/solarRecDashboardRouter.ts. Composed under
  // solarRecAppRouter; reachable via /solar-rec/api/trpc/
  // solarRecDashboard.* through the dispatcher in _core/index.ts.

  // Job runners (csgPortal, abpSettlement, dinScrape) all migrated to
  // the standalone Solar REC router by Task 5.8 PR-B + Task 5.9 PR-A
  // (2026-04-27). server/routers/jobRunners.ts is deleted; see the
  // import comment block above for the rationale and target files.

  // Productivity integrations
  clockify: clockifyRouter,
  todoist: todoistRouter,
  conversations: conversationsRouter,
  openai: openaiRouter,
  google: googleRouter,
  whoop: whoopRouter,
  samsungHealth: samsungHealthRouter,

  // Personal data & tracking
  metrics: metricsRouter,
  search: searchRouter,
  supplements: supplementsRouter,
  habits: habitsRouter,
  sleep: sleepRouter,
  notes: notesRouter,
  dataExport: dataExportRouter,
  dock: dockRouter,
  engagement: engagementRouter,
  anthropic: anthropicRouter,
  solarReadings: solarReadingsRouter,

  // Front-page
  kingOfDay: kingOfDayRouter,
  weather: weatherRouter,
  news: newsRouter,
});

export type AppRouter = typeof appRouter;
