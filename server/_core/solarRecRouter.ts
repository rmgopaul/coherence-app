import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import {
  authenticateSolarRecRequest,
  getSolarRecOwnerUserId,
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
// Credential migration helpers
// ---------------------------------------------------------------------------

type MainIntegrationRecord = {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | string | null;
  metadata: string | null;
};

type MigrationPayload = {
  connectionName: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  metadata?: string;
};

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseMetadataRecord(
  metadata: string | null | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getActiveConnection(
  metadata: Record<string, unknown>
): Record<string, unknown> | null {
  const rawConnections = Array.isArray(metadata.connections)
    ? metadata.connections
    : [];
  const connections = rawConnections.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object"
  );

  if (connections.length === 0) return null;

  const activeConnectionId = toNonEmptyString(metadata.activeConnectionId);
  if (activeConnectionId) {
    const match = connections.find(
      (connection) => toNonEmptyString(connection.id) === activeConnectionId
    );
    if (match) return match;
  }

  return connections[0];
}

function toOptionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function serializeMetadata(data: Record<string, unknown>): string {
  const compact = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  );
  return JSON.stringify(compact);
}

function extractMigrationPayload(
  integration: MainIntegrationRecord
): { solarProvider: string; payload: MigrationPayload } | null {
  const metadata = parseMetadataRecord(integration.metadata);
  const activeConnection = getActiveConnection(metadata) ?? {};
  const expiresAt = toOptionalDate(integration.expiresAt);

  switch (integration.provider) {
    case "solaredge-monitoring": {
      const apiKey =
        toNonEmptyString(activeConnection.apiKey) ??
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!apiKey) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "solaredge",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "SolarEdge (Migrated)",
          accessToken: apiKey,
          metadata: serializeMetadata({ apiKey, baseUrl }),
        },
      };
    }

    case "enphase-v4": {
      const accessToken = toNonEmptyString(integration.accessToken);
      const apiKey =
        toNonEmptyString(activeConnection.apiKey) ??
        toNonEmptyString(metadata.apiKey);
      if (!accessToken || !apiKey) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      const clientId = toNonEmptyString(metadata.clientId);
      const clientSecret = toNonEmptyString(metadata.clientSecret);
      return {
        solarProvider: "enphase-v4",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Enphase V4 (Migrated)",
          accessToken,
          refreshToken: toNonEmptyString(integration.refreshToken) ?? undefined,
          expiresAt,
          metadata: serializeMetadata({
            accessToken,
            apiKey,
            clientId,
            clientSecret,
            baseUrl,
          }),
        },
      };
    }

    case "fronius-solar": {
      const accessKeyId =
        toNonEmptyString(activeConnection.accessKeyId) ??
        toNonEmptyString(metadata.accessKeyId) ??
        toNonEmptyString(integration.accessToken);
      const accessKeyValue =
        toNonEmptyString(activeConnection.accessKeyValue) ??
        toNonEmptyString(metadata.accessKeyValue);
      if (!accessKeyId || !accessKeyValue) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "fronius",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Fronius (Migrated)",
          accessToken: accessKeyId,
          metadata: serializeMetadata({ accessKeyId, accessKeyValue, baseUrl }),
        },
      };
    }

    case "generac-pwrfleet": {
      const apiKey =
        toNonEmptyString(activeConnection.apiKey) ??
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!apiKey) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "generac",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Generac (Migrated)",
          accessToken: apiKey,
          metadata: serializeMetadata({ apiKey, baseUrl }),
        },
      };
    }

    case "hoymiles-smiles": {
      const username =
        toNonEmptyString(activeConnection.username) ??
        toNonEmptyString(metadata.username);
      const password =
        toNonEmptyString(activeConnection.password) ??
        toNonEmptyString(metadata.password);
      if (!username || !password) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "hoymiles",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Hoymiles (Migrated)",
          metadata: serializeMetadata({ username, password, baseUrl }),
        },
      };
    }

    case "goodwe-sems": {
      const account =
        toNonEmptyString(activeConnection.account) ??
        toNonEmptyString(metadata.account);
      const password =
        toNonEmptyString(activeConnection.password) ??
        toNonEmptyString(metadata.password);
      if (!account || !password) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "goodwe",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "GoodWe (Migrated)",
          metadata: serializeMetadata({ account, password, baseUrl }),
        },
      };
    }

    case "solis-cloud": {
      const apiKey =
        toNonEmptyString(activeConnection.apiKey) ??
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      const apiSecret =
        toNonEmptyString(activeConnection.apiSecret) ??
        toNonEmptyString(metadata.apiSecret);
      if (!apiKey || !apiSecret) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "solis",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Solis (Migrated)",
          accessToken: apiKey,
          metadata: serializeMetadata({ apiKey, apiSecret, baseUrl }),
        },
      };
    }

    case "locus-energy": {
      const clientId =
        toNonEmptyString(activeConnection.clientId) ??
        toNonEmptyString(metadata.clientId);
      const clientSecret =
        toNonEmptyString(activeConnection.clientSecret) ??
        toNonEmptyString(metadata.clientSecret);
      const partnerId =
        toNonEmptyString(activeConnection.partnerId) ??
        toNonEmptyString(metadata.partnerId);
      if (!clientId || !clientSecret || !partnerId) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "locus",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Locus Energy (Migrated)",
          metadata: serializeMetadata({
            clientId,
            clientSecret,
            partnerId,
            baseUrl,
          }),
        },
      };
    }

    case "apsystems-ema": {
      const appId =
        toNonEmptyString(activeConnection.appId) ??
        toNonEmptyString(activeConnection.apiKey) ??
        toNonEmptyString(metadata.appId) ??
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      const appSecret =
        toNonEmptyString(activeConnection.appSecret) ??
        toNonEmptyString(metadata.appSecret);
      if (!appId) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "apsystems",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "APsystems (Migrated)",
          accessToken: appId,
          metadata: serializeMetadata({ appId, appSecret, baseUrl }),
        },
      };
    }

    case "solar-log": {
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl) ??
        toNonEmptyString(metadata.deviceUrl);
      if (!baseUrl) return null;
      const password =
        toNonEmptyString(activeConnection.password) ??
        toNonEmptyString(metadata.password);
      return {
        solarProvider: "solarlog",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Solar-Log (Migrated)",
          metadata: serializeMetadata({ baseUrl, password }),
        },
      };
    }

    case "growatt-server": {
      const username =
        toNonEmptyString(activeConnection.username) ??
        toNonEmptyString(metadata.username);
      const password =
        toNonEmptyString(activeConnection.password) ??
        toNonEmptyString(metadata.password);
      if (!username || !password) return null;
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      return {
        solarProvider: "growatt",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "Growatt (Migrated)",
          metadata: serializeMetadata({ username, password, baseUrl }),
        },
      };
    }

    case "egauge-monitoring": {
      const baseUrl =
        toNonEmptyString(activeConnection.baseUrl) ??
        toNonEmptyString(metadata.baseUrl);
      if (!baseUrl) return null;
      const accessType =
        toNonEmptyString(activeConnection.accessType) ??
        toNonEmptyString(metadata.accessType);
      const username =
        toNonEmptyString(activeConnection.username) ??
        toNonEmptyString(metadata.username);
      const password =
        toNonEmptyString(activeConnection.password) ??
        toNonEmptyString(metadata.password) ??
        toNonEmptyString(integration.accessToken);
      return {
        solarProvider: "egauge",
        payload: {
          connectionName:
            toNonEmptyString(activeConnection.name) ?? "eGauge (Migrated)",
          metadata: serializeMetadata({ baseUrl, accessType, username, password }),
        },
      };
    }

    default:
      return null;
  }
}

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

  migrateFromMain: solarRecAdminProcedure.mutation(async ({ ctx }) => {
    const {
      getUserIntegrations,
      listSolarRecTeamCredentials,
      upsertSolarRecTeamCredential,
    } = await import("../db");

    const ownerUserId = getSolarRecOwnerUserId();
    const sourceIntegrations = (
      await getUserIntegrations(ownerUserId)
    ) as MainIntegrationRecord[];
    const existingCreds = await listSolarRecTeamCredentials();
    const existingByProvider = new Map(
      existingCreds.map((cred) => [cred.provider, cred] as const)
    );

    const supportedMainProviders = [
      "solaredge-monitoring",
      "enphase-v4",
      "fronius-solar",
      "generac-pwrfleet",
      "hoymiles-smiles",
      "goodwe-sems",
      "solis-cloud",
      "locus-energy",
      "apsystems-ema",
      "solar-log",
      "growatt-server",
      "egauge-monitoring",
    ] as const;

    let created = 0;
    let updated = 0;
    const results: Array<{
      mainProvider: string;
      solarProvider: string | null;
      status: "created" | "updated" | "skipped";
      reason?: string;
      connectionName?: string;
      credentialId?: string;
    }> = [];

    for (const mainProvider of supportedMainProviders) {
      const integration =
        sourceIntegrations.find((item) => item.provider === mainProvider) ?? null;
      if (!integration) {
        results.push({
          mainProvider,
          solarProvider: null,
          status: "skipped",
          reason: "No main-branch integration found",
        });
        continue;
      }

      const extracted = extractMigrationPayload(integration);
      if (!extracted) {
        results.push({
          mainProvider,
          solarProvider: null,
          status: "skipped",
          reason: "Integration exists but required credential fields are missing",
        });
        continue;
      }

      const existing = existingByProvider.get(extracted.solarProvider);
      const credentialId = await upsertSolarRecTeamCredential({
        id: existing?.id,
        provider: extracted.solarProvider,
        connectionName: extracted.payload.connectionName,
        accessToken: extracted.payload.accessToken,
        refreshToken: extracted.payload.refreshToken,
        expiresAt: extracted.payload.expiresAt,
        metadata: extracted.payload.metadata,
        createdBy: ctx.userId,
      });

      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }

      results.push({
        mainProvider,
        solarProvider: extracted.solarProvider,
        status: existing ? "updated" : "created",
        connectionName: extracted.payload.connectionName,
        credentialId,
      });
    }

    const skipped = results.filter((item) => item.status === "skipped").length;
    return {
      ownerUserId,
      created,
      updated,
      skipped,
      total: results.length,
      results,
    };
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
});

// ---------------------------------------------------------------------------
// Compose root router
// ---------------------------------------------------------------------------

export const solarRecAppRouter = t.router({
  solarRecDashboard: dashboardRouter,
  users: usersRouter,
  credentials: credentialsRouter,
  monitoring: monitoringRouter,
});

export type SolarRecAppRouter = typeof solarRecAppRouter;
