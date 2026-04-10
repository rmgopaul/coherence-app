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
import { registerPinGate } from "./pinGate";
import { registerSecurityMiddleware } from "./security";
import {
  registerSolarRecAuth,
  authenticateSolarRecRequest,
  resolveSolarRecOwnerUserId,
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
// NOTE: "solarRecDashboard" was removed from this set on 2026-04-10
// because the dashboardRouter inside _core/solarRecRouter.ts is dead
// code — no client calls solarRecTrpc.solarRecDashboard.*. Any legacy
// request to /solar-rec/api/trpc/solarRecDashboard.* now routes to
// server/routers.ts (the live copy), matching the modern solar-rec
// client which goes through /solar-rec/api/main-trpc. See the
// 2026-04-10 entry in SESSIONS_POSTMORTEM.md and
// productivity-hub/docs/server-routing.md for the full story.
const SOLAR_REC_ROUTER_ROOTS = new Set([
  "auth",
  "users",
  "credentials",
  "monitoring",
  "enphaseV2",
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
    return {
      req: opts.req,
      res: opts.res,
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
  startNightlySnapshotScheduler();
  startMonitoringScheduler();

  const app = express();
  const server = createServer(app);

  // Security middleware (helmet, CORS, rate limiting) — must come first
  registerSecurityMiddleware(app);

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
  const solarRecTrpcHandler = createExpressMiddleware({
    router: solarRecAppRouter,
    createContext: createSolarRecContext,
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
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
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
