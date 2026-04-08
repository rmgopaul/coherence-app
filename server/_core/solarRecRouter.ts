import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import {
  authenticateSolarRecRequest,
  type SolarRecAuthenticatedUser,
} from "./solarRecAuth";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SolarRecContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: SolarRecAuthenticatedUser | null;
  userId: number;
};

export async function createSolarRecContext(
  opts: CreateExpressContextOptions
): Promise<SolarRecContext> {
  const user = await authenticateSolarRecRequest(opts.req);

  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Solar REC authentication required",
    });
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    userId: user.id,
  };
}

// ---------------------------------------------------------------------------
// tRPC instance & permission middleware
// ---------------------------------------------------------------------------

const t = initTRPC.context<SolarRecContext>().create({
  transformer: superjson,
});

// Any authenticated user
const solarRecViewerProcedure = t.procedure;

// Requires owner, admin, or operator role
const solarRecOperatorProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user || !["owner", "admin", "operator"].includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Operator access required",
    });
  }
  return next();
});

// Requires owner or admin role
const solarRecAdminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user || !["owner", "admin"].includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  return next();
});

// ---------------------------------------------------------------------------
// Dashboard sub-router (existing functionality, preserved)
// ---------------------------------------------------------------------------

const dashboardRouter = t.router({
  getState: solarRecViewerProcedure.query(async ({ ctx }) => {
    const key = `solar-rec-dashboard/${ctx.userId}/state.json`;
    const dbStorageKey = "state";

    try {
      const { getSolarRecDashboardPayload } = await import("../db");
      const payload = await getSolarRecDashboardPayload(ctx.userId, dbStorageKey);
      if (payload) return { key, payload };
    } catch {
      // Fall back to storage proxy.
    }

    try {
      const { storageGet } = await import("../storage");
      const { url } = await storageGet(key);
      const response = await fetch(url);
      if (!response.ok) return null;
      const payload = await response.text();
      if (!payload) return null;
      return { key, payload };
    } catch {
      return null;
    }
  }),

  saveState: solarRecOperatorProcedure
    .input(z.object({ payload: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const key = `solar-rec-dashboard/${ctx.userId}/state.json`;
      const dbStorageKey = "state";
      let persistedToDatabase = false;

      try {
        const { saveSolarRecDashboardPayload } = await import("../db");
        persistedToDatabase = await saveSolarRecDashboardPayload(
          ctx.userId,
          dbStorageKey,
          input.payload
        );
      } catch {
        persistedToDatabase = false;
      }

      try {
        const { storagePut } = await import("../storage");
        await storagePut(key, input.payload, "application/json");
        return { success: true, key, persistedToDatabase, storageSynced: true };
      } catch (storageError) {
        if (persistedToDatabase) {
          return {
            success: true,
            key,
            persistedToDatabase,
            storageSynced: false,
          };
        }
        throw storageError;
      }
    }),

  getDataset: solarRecViewerProcedure
    .input(z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }))
    .mutation(async ({ ctx, input }) => {
      const key = `solar-rec-dashboard/${ctx.userId}/datasets/${input.key}.json`;
      const dbStorageKey = `dataset:${input.key}`;

      try {
        const { getSolarRecDashboardPayload } = await import("../db");
        const payload = await getSolarRecDashboardPayload(
          ctx.userId,
          dbStorageKey
        );
        if (payload) return { key, payload };
      } catch {
        // Fall back to storage proxy.
      }

      try {
        const { storageGet } = await import("../storage");
        const { url } = await storageGet(key);
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.text();
        if (!payload) return null;
        return { key, payload };
      } catch {
        return null;
      }
    }),

  saveDataset: solarRecOperatorProcedure
    .input(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        payload: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const key = `solar-rec-dashboard/${ctx.userId}/datasets/${input.key}.json`;
      const dbStorageKey = `dataset:${input.key}`;
      let persistedToDatabase = false;

      try {
        const { saveSolarRecDashboardPayload } = await import("../db");
        persistedToDatabase = await saveSolarRecDashboardPayload(
          ctx.userId,
          dbStorageKey,
          input.payload
        );
      } catch {
        persistedToDatabase = false;
      }

      try {
        const { storagePut } = await import("../storage");
        await storagePut(key, input.payload, "application/json");
        return { success: true, key, persistedToDatabase, storageSynced: true };
      } catch (storageError) {
        if (persistedToDatabase) {
          return {
            success: true,
            key,
            persistedToDatabase,
            storageSynced: false,
          };
        }
        throw storageError;
      }
    }),
});

// ---------------------------------------------------------------------------
// Users sub-router
// ---------------------------------------------------------------------------

const usersRouter = t.router({
  me: solarRecViewerProcedure.query(({ ctx }) => {
    return ctx.user;
  }),

  list: solarRecAdminProcedure.query(async () => {
    const { listSolarRecUsers } = await import("../db");
    const users = await listSolarRecUsers();
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      avatarUrl: u.avatarUrl,
      lastSignedIn: u.lastSignedIn,
      createdAt: u.createdAt,
    }));
  }),

  invite: solarRecAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "operator", "viewer"]).default("operator"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { createSolarRecInvite, getSolarRecUserByEmail } = await import("../db");

      // Check if user already exists
      const existing = await getSolarRecUserByEmail(input.email);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with this email already exists",
        });
      }

      const { token, expiresAt } = await createSolarRecInvite({
        email: input.email,
        role: input.role,
        createdBy: ctx.userId,
      });

      return { email: input.email, role: input.role, expiresAt, token };
    }),

  listInvites: solarRecAdminProcedure.query(async () => {
    const { listSolarRecInvites } = await import("../db");
    return listSolarRecInvites();
  }),

  deleteInvite: solarRecAdminProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ input }) => {
      const { deleteSolarRecInvite } = await import("../db");
      await deleteSolarRecInvite(input.inviteId);
      return { success: true };
    }),

  updateRole: solarRecAdminProcedure
    .input(
      z.object({
        userId: z.number(),
        role: z.enum(["admin", "operator", "viewer"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot change your own role",
        });
      }
      const { updateSolarRecUserRole, getSolarRecUserById } = await import("../db");
      const target = await getSolarRecUserById(input.userId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      if (target.role === "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot change owner role" });
      }
      await updateSolarRecUserRole(input.userId, input.role);
      return { success: true };
    }),

  deactivate: solarRecAdminProcedure
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot deactivate yourself",
        });
      }
      const { deactivateSolarRecUser, getSolarRecUserById } = await import("../db");
      const target = await getSolarRecUserById(input.userId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      if (target.role === "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot deactivate owner" });
      }
      await deactivateSolarRecUser(input.userId);
      return { success: true };
    }),
});

// ---------------------------------------------------------------------------
// Team Credentials sub-router
// ---------------------------------------------------------------------------

const credentialsRouter = t.router({
  list: solarRecOperatorProcedure.query(async () => {
    const { listSolarRecTeamCredentials } = await import("../db");
    const creds = await listSolarRecTeamCredentials();
    // Strip sensitive tokens for non-admin views
    return creds.map((c) => ({
      id: c.id,
      provider: c.provider,
      connectionName: c.connectionName,
      hasAccessToken: !!c.accessToken,
      hasRefreshToken: !!c.refreshToken,
      expiresAt: c.expiresAt,
      metadata: c.metadata, // Contains non-sensitive config like baseUrl
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }),

  connect: solarRecAdminProcedure
    .input(
      z.object({
        id: z.string().optional(),
        provider: z.string(),
        connectionName: z.string().optional(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        metadata: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { upsertSolarRecTeamCredential } = await import("../db");
      const id = await upsertSolarRecTeamCredential({
        id: input.id,
        provider: input.provider,
        connectionName: input.connectionName,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        metadata: input.metadata,
        createdBy: ctx.userId,
      });
      return { id };
    }),

  disconnect: solarRecAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const { deleteSolarRecTeamCredential } = await import("../db");
      await deleteSolarRecTeamCredential(input.id);
      return { success: true };
    }),
});

// ---------------------------------------------------------------------------
// Monitoring sub-router
// ---------------------------------------------------------------------------

const monitoringRouter = t.router({
  getGrid: solarRecViewerProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ input }) => {
      const { getMonitoringGrid } = await import("../db");
      return getMonitoringGrid(input.startDate, input.endDate);
    }),

  getRunDetail: solarRecViewerProcedure
    .input(
      z.object({
        provider: z.string(),
        siteId: z.string(),
        dateKey: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { getMonitoringRunDetail } = await import("../db");
      return getMonitoringRunDetail(input.provider, input.siteId, input.dateKey);
    }),

  getHealthSummary: solarRecViewerProcedure.query(async () => {
    const { getMonitoringHealthSummary } = await import("../db");
    return getMonitoringHealthSummary();
  }),

  getBatchStatus: solarRecViewerProcedure
    .input(z.object({ batchId: z.string() }))
    .query(async ({ input }) => {
      const { getMonitoringBatchRun } = await import("../db");
      return getMonitoringBatchRun(input.batchId);
    }),

  runAll: solarRecOperatorProcedure
    .input(z.object({ anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { createMonitoringBatchRun } = await import("../db");
      const dateKey = input.anchorDate ?? new Date().toISOString().slice(0, 10);
      const batchId = await createMonitoringBatchRun({
        dateKey,
        triggeredBy: ctx.userId,
      });

      // Fire-and-forget: run the batch in background
      import("../solar/monitoring.service").then((mod) =>
        mod.executeMonitoringBatch(batchId, dateKey, ctx.userId).catch((err) =>
          console.error("[MonitoringBatch] Failed:", err)
        )
      );

      return { batchId, dateKey };
    }),

  runProvider: solarRecOperatorProcedure
    .input(
      z.object({
        provider: z.string(),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dateKey = input.anchorDate ?? new Date().toISOString().slice(0, 10);

      // Fire-and-forget: run single provider
      import("../solar/monitoring.service").then((mod) =>
        mod
          .executeProviderRun(input.provider, dateKey, ctx.userId)
          .catch((err) =>
            console.error(`[MonitoringProvider:${input.provider}] Failed:`, err)
          )
      );

      return { provider: input.provider, dateKey };
    }),

  getOverview: solarRecViewerProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ input }) => {
      const { getMonitoringGrid } = await import("../db");
      const { listSolarRecTeamCredentials } = await import("../db");

      const [runs, creds] = await Promise.all([
        getMonitoringGrid(input.startDate, input.endDate),
        listSolarRecTeamCredentials(),
      ]);

      // Build credential label lookup
      const credLabelMap = new Map<string, { name: string; provider: string }>();
      for (const c of creds) {
        let label = c.connectionName ?? "";
        if (!label && c.metadata) {
          try {
            const meta = JSON.parse(c.metadata);
            label =
              meta.username ??
              meta.account ??
              meta.connectionName ??
              (meta.apiKey ? `Key ...${String(meta.apiKey).slice(-6)}` : "");
          } catch {
            /* ignore */
          }
        }
        if (!label && c.accessToken) {
          label = `...${c.accessToken.slice(-6)}`;
        }
        credLabelMap.set(c.id, { name: label || "Unnamed", provider: c.provider });
      }

      return { runs, credentials: Array.from(credLabelMap.entries()).map(([id, v]) => ({ id, ...v })) };
    }),
});

// ---------------------------------------------------------------------------
// Auth compat router — so existing meter read pages that call
// trpc.auth.me / trpc.auth.logout work in the solar-rec context.
// ---------------------------------------------------------------------------

const authRouter = t.router({
  me: solarRecViewerProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    return {
      id: ctx.user.id,
      openId: ctx.user.email, // compat shim
      name: ctx.user.name,
      email: ctx.user.email,
      role: ctx.user.role,
      loginMethod: "google",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      twoFactorEnabled: false,
      twoFactorPending: false,
    };
  }),

  logout: solarRecViewerProcedure.mutation(({ ctx }) => {
    // Clear the solar-rec session cookie
    ctx.res.clearCookie("solar_rec_session", {
      path: "/solar-rec/",
      sameSite: "lax",
    });
    return { success: true };
  }),
});

// ---------------------------------------------------------------------------
// Compose root router
// ---------------------------------------------------------------------------

export const solarRecAppRouter = t.router({
  solarRecDashboard: dashboardRouter,
  auth: authRouter,
  users: usersRouter,
  credentials: credentialsRouter,
  monitoring: monitoringRouter,
});

export type SolarRecAppRouter = typeof solarRecAppRouter;
