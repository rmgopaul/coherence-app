import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { buildDashboardResponseMeta } from "./dashboardResponseMeta";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import oauthRouter from "../oauth-routes";
import { assertServerRuntimeSafety } from "./env";
import { serveStatic, setupVite } from "./vite";
import { startNightlySnapshotScheduler } from "./nightlySnapshotScheduler";
import { startMonitoringScheduler } from "../solar/monitoringScheduler";
import { startDatasetUploadStaleJobSweeper } from "../services/core/datasetUploadStaleJobSweeper";
import { startDashboardLoadSemaphoreObservability } from "./solarRecDashboardRouter";
import { startDashboardBuildStaleJobSweeper } from "../services/solar/dashboardBuildJobs";
import { startDashboardCsvExportStaleJobSweeper } from "../services/solar/dashboardCsvExportJobs";
import { registerMonitoringDetailsBuildStep } from "../services/solar/buildDashboardMonitoringDetailsFacts";
import { registerChangeOwnershipBuildStep } from "../services/solar/buildDashboardChangeOwnershipFacts";
import { registerOwnershipBuildStep } from "../services/solar/buildDashboardOwnershipFacts";
import { registerSystemBuildStep } from "../services/solar/buildDashboardSystemFacts";
import { registerPerformanceRatioBuildStep } from "../services/solar/buildDashboardPerformanceRatioFacts";
import { registerPinGate } from "./pinGate";
import { registerSecurityMiddleware } from "./security";
import {
  installFetchBandwidthDiagnostics,
  largeResponseLogger,
} from "./bandwidthDiagnostics";
import { shouldRunSolarRecStartupCleanup } from "./startupCleanupPolicy";
import { shouldMutateProdState } from "./runtimeTarget";
import {
  registerSolarRecAuth,
  authenticateSolarRecRequest,
  resolveSolarRecOwnerUserId,
  resolveSolarRecScopeId,
} from "./solarRecAuth";
import { solarRecAppRouter, createSolarRecContext } from "./solarRecRouter";
import {
  SOLAR_REC_ROUTER_ROOTS,
  assertSolarRecRouterRootsInSync,
} from "./solarRecRouterRoots";
import { getLocalStorageRoot, isStorageProxyConfigured, LOCAL_STORAGE_ROUTE_PREFIX } from "../storage";

// Boot-time guard: crash loud if SOLAR_REC_ROUTER_ROOTS has drifted
// from solarRecAppRouter. See the JSDoc in solarRecRouterRoots.ts
// for the failure mode this prevents.
assertSolarRecRouterRootsInSync(solarRecAppRouter);

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

// `SOLAR_REC_ROUTER_ROOTS` + `assertSolarRecRouterRootsInSync` live in
// `./solarRecRouterRoots.ts`. The set is the dispatcher's allowlist
// (used by the route below); the assertion runs at module load
// (top of file) to crash boot if the set drifts from the actual
// router. See that module's JSDoc for the full failure-mode history
// (2026-04-10 / 2026-04-15 / 2026-04-26 / 2026-05-12).

function getTrpcProcedureRoots(pathname: string): string[] {
  const normalized = decodeURIComponent(pathname).replace(/^\/+/, "").trim();
  if (!normalized) return [];
  return normalized
    .split(",")
    .map((entry) => entry.split(".")[0]?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

async function createSolarRecMainContext(
  opts: Parameters<typeof createContext>[0]
) {
  // Prefer Solar REC auth first so this endpoint never accidentally uses
  // a separate main-app browser session tied to a different user.
  const solarRecUser = await authenticateSolarRecRequest(opts.req);
  if (solarRecUser) {
    const now = new Date();
    const ownerUserId = await resolveSolarRecOwnerUserId();
    const scopeId = await resolveSolarRecScopeId();
    return {
      req: opts.req,
      res: opts.res,
      scopeId,
      user: {
        id: ownerUserId,
        openId: `solar-rec:${solarRecUser.id}`,
        name: solarRecUser.name,
        email: solarRecUser.email,
        loginMethod: "google",
        role:
          solarRecUser.role === "owner" || solarRecUser.role === "admin"
            ? ("admin" as const)
            : ("user" as const),
        createdAt: now,
        updatedAt: now,
        lastSignedIn: now,
      },
      twoFactorVerified: true,
    };
  }

  // Fallback for direct non-solar-rec usage.
  try {
    const ctx = await createContext(opts);
    if (ctx.user) return ctx;
  } catch {
    // ignore
  }

  return { req: opts.req, res: opts.res, user: null, twoFactorVerified: true };
}

async function startServer() {
  assertServerRuntimeSafety();
  installFetchBandwidthDiagnostics();

  // Phase 2 PR-C-2 / PR-D-2 (OOM rebuild) — register the dashboard
  // build steps. The build runner is reactive (only fires when a
  // tRPC mutation invokes `startDashboardBuild`), not periodic, so
  // this registration is independent of `shouldMutateProdState()` —
  // there's a human gate (the explicit "rebuild" action) that
  // protects local-dev from accidental writes. Idempotent:
  // subsequent server restarts re-register the same steps without
  // duplicating. Order: monitoringDetails → changeOwnership →
  // ownership → system → performanceRatio (each step writes to
  // a distinct fact table; no dependency between them).
  void registerMonitoringDetailsBuildStep();
  void registerChangeOwnershipBuildStep();
  void registerOwnershipBuildStep();
  void registerSystemBuildStep();
  void registerPerformanceRatioBuildStep();

  // Concern #4 PR-2 (per docs/triage/local-dev-prod-mutation-findings.md):
  // schedulers + the orphan-batch cleanup mutate prod state on every
  // boot/tick. Gating them on `shouldMutateProdState()` keeps a local
  // dev server pointed at `DATABASE_URL=prod` from accidentally
  // marking real in-flight monitoring runs as failed (the most
  // dangerous unguarded path the findings doc enumerated) or running
  // a scheduled monitoring sweep against prod credentials.
  //
  // Local dev with intentional dev-against-prod workflows can opt in
  // via `ALLOW_LOCAL_TO_PROD_WRITES=true` (see PR #391's
  // `runtimeTarget.ts`). Test runs (NODE_ENV=test) are always gated
  // off — vitest never starts schedulers regardless of opt-in.
  if (shouldMutateProdState()) {
    startNightlySnapshotScheduler();
    startMonitoringScheduler();
    startDatasetUploadStaleJobSweeper();
    // 2026-05-09 (post-merge review of #496) — wrapped in a start
    // function so test imports of the dashboard router don't
    // trigger a 30s setInterval. Production boot calls it under
    // the same prod-state gate as the other schedulers.
    startDashboardLoadSemaphoreObservability();
    // 2026-05-09 (post-merge audit follow-up) — both dashboard-job
    // modules' sweeps used to run ONLY opportunistically on a
    // status read. If the worker died after claim AND the client
    // moved on (page reload, tab close, started a new build), the
    // orphan `running` row sat forever. Production evidence:
    // bld-312c41a266cf… stuck for ~24 h on prod after a deploy.
    // Boot-time periodic sweepers mirror startDatasetUploadStaleJobSweeper.
    startDashboardBuildStaleJobSweeper();
    startDashboardCsvExportStaleJobSweeper();

    // Mark any MonitoringBatchRun rows left in "running" state by the
    // prior Node process (killed by deploy, crash, OOM) as "failed"
    // so the client dashboard stops polling them forever. Fire-and-
    // forget — don't block server startup if this fails. Same gate
    // as the schedulers above: a local dev server pointed at prod
    // would otherwise wipe every prod monitoring batch's in-flight
    // status on boot.
    void (async () => {
      try {
        const { failOrphanedRunningBatches } = await import("../db");
        const count = await failOrphanedRunningBatches();
        if (count > 0) {
          console.log(
            `[Monitoring] Marked ${count} orphaned "running" batch${count === 1 ? "" : "es"} as failed on startup.`
          );
        }
      } catch (err) {
        console.error("[Monitoring] Orphan cleanup failed on startup:", err);
      }
    })();
  } else {
    console.warn(
      "[startServer] Skipping schedulers + orphan-batch cleanup: not on " +
        "hosted-prod and `ALLOW_LOCAL_TO_PROD_WRITES` not set. Set the env " +
        "var to opt in if this local-dev process intentionally targets " +
        "prod DATABASE_URL."
    );
  }

  const app = express();

  // Trust the first proxy hop so req.ip (and express-rate-limit) see
  // the real client IP rather than Render's load balancer. Set to 1
  // for a single-hop reverse proxy; local dev keeps the default.
  if (process.env.RENDER) {
    app.set("trust proxy", 1);
  }

  const server = createServer(app);

  // Startup housekeeping mutates Solar REC job state. Run it in the
  // hosted Render process, or in local/dev only when explicitly opted
  // in, so a local server pointed at the production DB cannot mark a
  // live production compute as orphaned.
  if (shouldRunSolarRecStartupCleanup()) {
    void (async () => {
      try {
        const {
          clearOrphanedComputeRunsOnStartup,
          clearOrphanedImportBatchesOnStartup,
          archiveSupersededImportBatchesOnStartup,
        } = await import(
          "../db/solarRecDatasets"
        );
        const clearedBatches = await clearOrphanedImportBatchesOnStartup();
        if (clearedBatches > 0) {
          console.log(
            `[startup] cleared ${clearedBatches} orphaned solar-rec import batch${clearedBatches === 1 ? "" : "es"}`
          );
        }
        const archived = await archiveSupersededImportBatchesOnStartup();
        if (archived.archivedBatches > 0) {
          console.log(
            `[startup] archived ${archived.archivedBatches} superseded solar-rec batch${archived.archivedBatches === 1 ? "" : "es"} and purged ${archived.purgedRows} retained row${archived.purgedRows === 1 ? "" : "s"}`
          );
        }
        const cleared = await clearOrphanedComputeRunsOnStartup();
        if (cleared > 0) {
          console.log(
            `[startup] cleared ${cleared} orphaned solar-rec compute run(s)`
          );
        }
      } catch (err) {
        console.warn(
          "[startup] could not clear orphaned solar-rec jobs:",
          err
        );
      }
    })();
  }

  // Security middleware (helmet, CORS, rate limiting) — must come first
  registerSecurityMiddleware(app);
  app.use(largeResponseLogger());

  // Allow larger dashboard dataset payloads (large CSV-derived uploads) while still bounded.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(LOCAL_STORAGE_ROUTE_PREFIX, express.static(getLocalStorageRoot()));
  if (!isStorageProxyConfigured()) {
    console.warn(
      `Storage proxy credentials are not configured; using local upload storage at ${getLocalStorageRoot()}`
    );
  }
  registerPinGate(app);
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Custom OAuth routes for integrations (Google, Todoist, WHOOP, Samsung webhook)
  app.use("/api", oauthRouter);
  // Solar REC standalone auth + tRPC (must be before main tRPC)
  registerSolarRecAuth(app);

  // allowMethodOverride: true is REQUIRED because the client's httpLink
  // instances (client/src/main.tsx + client/src/solar-rec-main.tsx) all
  // use `methodOverride: "POST"`. Without this flag the tRPC server
  // rejects POST to query procedures with
  // "Unsupported POST-request to query procedure at path ...".
  // See commit a6a1186 (2026-04-10) for the client-side change this
  // pairs with.
  const solarRecTrpcHandler = createExpressMiddleware({
    router: solarRecAppRouter,
    createContext: createSolarRecContext,
    allowMethodOverride: true,
    onError: ({ error }) => {
      // Silence NOT_FOUND errors to avoid noise from fallback routing
      if (error.code !== "NOT_FOUND") {
        console.error("[SolarRecTRPC]", error.message);
      }
    },
    // 2026-05-09 — Bug #1 (502 cascade) resilience. The dashboard
    // middleware (`dashboardResponseGuard.ts`) throws
    // `TRPCError({ code: "TOO_MANY_REQUESTS" })` on heap pressure,
    // which tRPC translates to HTTP 429. Add a `Retry-After: 5`
    // header so retry-aware clients pick the suggested delay
    // instead of a generic backoff. Render's LB may strip the
    // header today; the semantic is correct regardless and a
    // future LB tuning / direct-to-origin path benefits.
    responseMeta: ({ errors }) => buildDashboardResponseMeta({ errors }),
  });
  const solarRecMainTrpcHandler = createExpressMiddleware({
    router: appRouter,
    createContext: createSolarRecMainContext,
    allowMethodOverride: true,
  });

  // Compatibility dispatcher for older Solar REC bundles that still call
  // /solar-rec/api/trpc for provider procedures (solarEdge.*, apsystems.*, etc.).
  app.use("/solar-rec/api/trpc", (req, res, next) => {
    const roots = getTrpcProcedureRoots(req.path);
    if (roots.length === 0 || roots.every((root) => SOLAR_REC_ROUTER_ROOTS.has(root))) {
      return solarRecTrpcHandler(req, res, next);
    }
    return solarRecMainTrpcHandler(req, res, next);
  });

  // Primary endpoint for provider procedures from Solar REC.
  app.use("/solar-rec/api/main-trpc", solarRecMainTrpcHandler);
  // tRPC API
  // allowMethodOverride: true — see the comment on solarRecTrpcHandler
  // above. Main app's splitLink sends solarRecDashboard.* as POST via
  // httpLink(methodOverride: "POST"); httpBatchLink branch is unaffected
  // because enabling method override only widens the accepted methods.
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      allowMethodOverride: true,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
