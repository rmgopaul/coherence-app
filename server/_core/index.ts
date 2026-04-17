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
// NOTE: "solarRecDashboard" was removed from this set on 2026-04-10
// because the dashboardRouter inside _core/solarRecRouter.ts is dead
// code — no client calls solarRecTrpc.solarRecDashboard.*. Any legacy
// request to /solar-rec/api/trpc/solarRecDashboard.* now routes to
// server/routers.ts (the live copy), matching the modern solar-rec
// client which goes through /solar-rec/api/main-trpc. See the
// 2026-04-10 entry in SESSIONS_POSTMORTEM.md and
// productivity-hub/docs/server-routing.md for the full story.
// 2026-04-15: "auth" and "enphaseV2" removed alongside their dead
// sub-routers in _core/solarRecRouter.ts. The solar-rec standalone
// client never called solarRecTrpc.auth.* or solarRecTrpc.enphaseV2.*
// — main-app pages use the main appRouter's auth/enphaseV2 routers
// via the primary trpc client, not solarRecTrpc. Any legacy request
// that happens to hit /solar-rec/api/trpc/{auth,enphaseV2}.* now
// falls through this dispatcher to the main appRouter.
const SOLAR_REC_ROUTER_ROOTS = new Set([
  "users",
  "credentials",
  "monitoring",
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
  startNightlySnapshotScheduler();
  startMonitoringScheduler();

  // Mark any MonitoringBatchRun rows left in "running" state by the prior
  // Node process (killed by deploy, crash, OOM) as "failed" so the client
  // dashboard stops polling them forever. Fire-and-forget — don't block
  // server startup if this fails.
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

  const app = express();
  const server = createServer(app);

  // Startup housekeeping: any compute_run left in "running" state is
  // by definition orphaned (killed mid-compute by a Render restart,
  // OOM, or deploy) — clear them so new requests don't have to wait
  // 10 minutes for the self-heal threshold. Fire and forget; the DB
  // layer is retryable and startup shouldn't block on this.
  void (async () => {
    try {
      const { clearOrphanedComputeRunsOnStartup } = await import(
        "../db/solarRecDatasets"
      );
      const cleared = await clearOrphanedComputeRunsOnStartup();
      if (cleared > 0) {
        console.log(
          `[startup] cleared ${cleared} orphaned solar-rec compute run(s)`
        );
      }
    } catch (err) {
      console.warn("[startup] could not clear orphaned compute runs:", err);
    }
  })();

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

  // Solar REC dataset upload endpoint (Step 2 of server-side migration).
  // Accepts CSV text as the request body (Content-Type: text/csv or text/plain).
  // NOT tRPC — Express route for direct file upload without base64 encoding.
  app.post(
    "/solar-rec/api/datasets/upload",
    // 500MB covers the largest expected dataset (~300-col × 35k-row CSVs).
    // Larger than that should use the chunked/async path described in the
    // plan (not yet implemented).
    express.text({ limit: "500mb", type: ["text/csv", "text/plain"] }),
    async (req, res) => {
      try {
        const solarRecUser = await authenticateSolarRecRequest(req);
        if (!solarRecUser) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const datasetKey = req.query.datasetKey as string;
        const fileName = (req.query.fileName as string) || "upload.csv";
        const mode = (req.query.mode as string) === "append" ? "append" : "replace";

        if (!datasetKey) {
          res.status(400).json({ error: "datasetKey query parameter is required" });
          return;
        }

        const csvText = typeof req.body === "string" ? req.body : "";
        if (!csvText) {
          res.status(400).json({ error: "Request body must contain CSV text" });
          return;
        }

        const scopeId = await resolveSolarRecScopeId();
        const ownerUserId = await resolveSolarRecOwnerUserId();

        // Ensure scope exists
        const { getOrCreateScope } = await import("../db");
        await getOrCreateScope(scopeId, ownerUserId);

        const { ingestDataset } = await import("../services/solar/datasetIngestion");
        const result = await ingestDataset(
          scopeId,
          datasetKey,
          csvText,
          fileName,
          mode as "replace" | "append",
          ownerUserId
        );

        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        console.error("[Solar REC Upload]", message);
        res.status(500).json({ error: message });
      }
    }
  );

  // Solar REC dataset CHUNKED upload endpoint.
  // For datasets too large to fit in a single request (multi-million row
  // CSVs). Each chunk is a standalone CSV with headers; the first chunk
  // creates a processing batch, subsequent chunks append rows to it,
  // and the caller sets ?finalize=true on the last chunk to activate it.
  app.post(
    "/solar-rec/api/datasets/upload-chunk",
    express.text({ limit: "50mb", type: ["text/csv", "text/plain"] }),
    async (req, res) => {
      try {
        const solarRecUser = await authenticateSolarRecRequest(req);
        if (!solarRecUser) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const datasetKey = req.query.datasetKey as string;
        const fileName = (req.query.fileName as string) || "upload.csv";
        const batchId = (req.query.batchId as string) || null;
        const finalize = req.query.finalize === "true";

        if (!datasetKey) {
          res.status(400).json({ error: "datasetKey query parameter is required" });
          return;
        }

        const csvText = typeof req.body === "string" ? req.body : "";
        if (!csvText) {
          res.status(400).json({ error: "Request body must contain CSV text" });
          return;
        }

        const scopeId = await resolveSolarRecScopeId();
        const ownerUserId = await resolveSolarRecOwnerUserId();

        const { getOrCreateScope } = await import("../db");
        await getOrCreateScope(scopeId, ownerUserId);

        const { ingestDatasetChunk } = await import(
          "../services/solar/datasetIngestion"
        );
        const result = await ingestDatasetChunk(
          scopeId,
          datasetKey,
          csvText,
          fileName,
          batchId,
          finalize,
          ownerUserId
        );

        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Chunk upload failed";
        console.error("[Solar REC ChunkUpload]", message);
        res.status(500).json({ error: message });
      }
    }
  );

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
