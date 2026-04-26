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
import { zendeskRouter } from "./routers/solarMisc";
import {
  csgPortalRouter,
  abpSettlementRouter,
  dinScrapeRouter,
} from "./routers/jobRunners";
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

  // Solar misc monitoring
  zendesk: zendeskRouter,

  // Job runners
  csgPortal: csgPortalRouter,
  abpSettlement: abpSettlementRouter,
  dinScrape: dinScrapeRouter,

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
