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
import { registerSolarRecAuth, authenticateSolarRecRequest, getSolarRecOwnerUserId } from "./solarRecAuth";
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
  app.use(
    "/solar-rec/api/trpc",
    createExpressMiddleware({
      router: solarRecAppRouter,
      createContext: createSolarRecContext,
    })
  );
  // Main app router mounted under /solar-rec too, so reused meter-read pages
  // can call provider routes (enphaseV4.*, solarEdge.*, etc.) while using
  // the Solar REC auth cookie.
  app.use(
    "/solar-rec/api/main-trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async (opts) => {
        try {
          const ctx = await createContext(opts);
          if (ctx.user) return ctx;
        } catch {
          // Fall through to Solar REC auth mapping.
        }

        const solarRecUser = await authenticateSolarRecRequest(opts.req);
        if (!solarRecUser) {
          return { req: opts.req, res: opts.res, user: null, twoFactorVerified: true };
        }

        const now = new Date();
        return {
          req: opts.req,
          res: opts.res,
          user: {
            id: getSolarRecOwnerUserId(),
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
      },
    })
  );
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
