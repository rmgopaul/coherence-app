import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import oauthRouter from "../oauth-routes";
import { assertServerRuntimeSafety } from "./env";
import { serveStatic, setupVite } from "./vite";
import { startNightlySnapshotScheduler } from "./nightlySnapshotScheduler";
import { startMonitoringScheduler } from "../solar/monitoringScheduler";
import { startDatasetUploadStaleJobSweeper } from "../services/core/datasetUploadStaleJobSweeper";
import { registerMonitoringDetailsBuildStep } from "../services/solar/buildDashboardMonitoringDetailsFacts";
import { registerChangeOwnershipBuildStep } from "../services/solar/buildDashboardChangeOwnershipFacts";
import { registerOwnershipBuildStep } from "../services/solar/buildDashboardOwnershipFacts";
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
import { getLocalStorageRoot, isStorageProxyConfigured, LOCAL_STORAGE_ROUTE_PREFIX } from "../storage";

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

// Roots that belong to the standalone Solar REC tRPC router
// (server/_core/solarRecRouter.ts). Any request to /solar-rec/api/trpc
// whose procedure root is in this set gets handled by that router;
// anything else falls through to the main router in server/routers.ts.
//
// HISTORY:
// 2026-04-10: "solarRecDashboard" was removed from this set because
//   the in-_core dashboardRouter was dead code — no client called
//   solarRecTrpc.solarRecDashboard.*. Legacy traffic to
//   /solar-rec/api/trpc/solarRecDashboard.* fell through to the
//   main router in server/routers.ts (the live copy at the time).
// 2026-04-15: "auth" and "enphaseV2" removed alongside their dead
//   sub-routers. Main-app pages use the main appRouter's auth /
//   enphaseV2 routers via the primary trpc client, not solarRecTrpc.
// 2026-04-26 (Task 5.5): "solarRecDashboard" RE-ADDED. The router
//   has been migrated from server/routers/solarRecDashboard.ts to
//   server/_core/solarRecDashboardRouter.ts and is now composed
//   into solarRecAppRouter with `requirePermission("solar-rec-
//   dashboard", level)` middleware on every procedure. The old
//   main-router mount has been removed; main-app /api/trpc/
//   solarRecDashboard.* requests would now 404. The legacy
//   /solar-rec-dashboard URL on App.tsx has been retired in favor
//   of the /solar-rec/dashboard route on SolarRecApp.tsx.
const SOLAR_REC_ROUTER_ROOTS = new Set([
  "users",
  "credentials",
  "monitoring",
  "permissions",
  "generac",
  "solis",
  "goodwe",
  "hoymiles",
  "locus",
  "apsystems",
  "solarlog",
  "growatt",
  "ekm",
  "fronius",
  "ennexos",
  "enphaseV4",
  "solaredge",
  "teslaPowerhub",
  "sunpower",
  "egauge",
  "solarRecDashboard",
  "contractScan",
  "zendesk",
  "abpSettlement",
  "csgPortal",
  "dinScrape",
]);

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
  // ownership (each step writes to a distinct fact table; no
  // dependency between them).
  void registerMonitoringDetailsBuildStep();
  void registerChangeOwnershipBuildStep();
  void registerOwnershipBuildStep();

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
