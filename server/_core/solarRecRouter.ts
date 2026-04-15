import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import {
  authenticateSolarRecRequest,
  resolveSolarRecOwnerUserId,
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
  sourceConnectionId: string;
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

/** Derive a human-readable label from a credential row. Used by monitoring procedures. */
function credentialLabel(cred: {
  id: string;
  provider: string;
  connectionName?: string | null;
  accessToken?: string | null;
  metadata?: string | null;
}): string {
  const fromName = toNonEmptyString(cred.connectionName);
  if (fromName) return fromName;
  const meta = parseMetadataRecord(cred.metadata);
  const fromMeta =
    toNonEmptyString(meta.username) ??
    toNonEmptyString(meta.account) ??
    toNonEmptyString(meta.clientId) ??
    toNonEmptyString(meta.connectionName) ??
    toNonEmptyString(meta.baseUrl) ??
    toNonEmptyString(meta.groupId) ??
    (typeof meta.apiKey === "string" && meta.apiKey.length > 6
      ? `Key ...${meta.apiKey.slice(-6)}`
      : null);
  if (fromMeta) return fromMeta;
  if (cred.accessToken) return `...${cred.accessToken.slice(-6)}`;
  return `${cred.provider}:${cred.id.slice(-6)}`;
}

function getConnectionRows(
  metadata: Record<string, unknown>
): Array<Record<string, unknown>> {
  const rawConnections = Array.isArray(metadata.connections)
    ? metadata.connections
    : [];
  return rawConnections.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object"
  );
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

function buildSourceMetadata(
  data: Record<string, unknown>,
  mainProvider: string,
  sourceConnectionId: string
): string {
  return serializeMetadata({
    ...data,
    _sourceProvider: mainProvider,
    _sourceConnectionId: sourceConnectionId,
  });
}

function extractMigrationPayloads(
  integration: MainIntegrationRecord
): Array<{ solarProvider: string; payload: MigrationPayload }> {
  const metadata = parseMetadataRecord(integration.metadata);
  const connections = getConnectionRows(metadata);
  const expiresAt = toOptionalDate(integration.expiresAt);

  switch (integration.provider) {
    case "solaredge-monitoring": {
      const payloads = connections
        .map((connection, index) => {
          const apiKey = toNonEmptyString(connection.apiKey);
          if (!apiKey) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `solaredge-${index + 1}`;
          const baseUrl =
            toNonEmptyString(connection.baseUrl) ??
            toNonEmptyString(metadata.baseUrl);
          return {
            solarProvider: "solaredge",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `SolarEdge ${index + 1} (Migrated)`,
              accessToken: apiKey,
              metadata: buildSourceMetadata(
                { apiKey, baseUrl },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;

      if (payloads.length > 0) return payloads;

      const legacyApiKey =
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!legacyApiKey) return [];
      return [
        {
          solarProvider: "solaredge",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "SolarEdge (Migrated)",
            accessToken: legacyApiKey,
            metadata: buildSourceMetadata(
              {
                apiKey: legacyApiKey,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "enphase-v4": {
      const accessToken = toNonEmptyString(integration.accessToken);
      const apiKey = toNonEmptyString(metadata.apiKey);
      if (!accessToken || !apiKey) return [];
      const baseUrl = toNonEmptyString(metadata.baseUrl);
      const clientId = toNonEmptyString(metadata.clientId);
      const clientSecret = toNonEmptyString(metadata.clientSecret);
      return [
        {
          solarProvider: "enphase-v4",
          payload: {
            sourceConnectionId: "primary",
            connectionName: "Enphase V4 (Migrated)",
            accessToken,
            refreshToken: toNonEmptyString(integration.refreshToken) ?? undefined,
            expiresAt,
            metadata: buildSourceMetadata(
              {
                accessToken,
                apiKey,
                clientId,
                clientSecret,
                baseUrl,
              },
              integration.provider,
              "primary"
            ),
          },
        },
      ];
    }

    case "fronius-solar": {
      const payloads = connections
        .map((connection, index) => {
          const accessKeyId = toNonEmptyString(connection.accessKeyId);
          const accessKeyValue = toNonEmptyString(connection.accessKeyValue);
          if (!accessKeyId || !accessKeyValue) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `fronius-${index + 1}`;
          return {
            solarProvider: "fronius",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Fronius ${index + 1} (Migrated)`,
              accessToken: accessKeyId,
              metadata: buildSourceMetadata(
                {
                  accessKeyId,
                  accessKeyValue,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const accessKeyId =
        toNonEmptyString(metadata.accessKeyId) ??
        toNonEmptyString(integration.accessToken);
      const accessKeyValue = toNonEmptyString(metadata.accessKeyValue);
      if (!accessKeyId || !accessKeyValue) return [];
      return [
        {
          solarProvider: "fronius",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Fronius (Migrated)",
            accessToken: accessKeyId,
            metadata: buildSourceMetadata(
              {
                accessKeyId,
                accessKeyValue,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "generac-pwrfleet": {
      const payloads = connections
        .map((connection, index) => {
          const apiKey = toNonEmptyString(connection.apiKey);
          if (!apiKey) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `generac-${index + 1}`;
          return {
            solarProvider: "generac",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Generac ${index + 1} (Migrated)`,
              accessToken: apiKey,
              metadata: buildSourceMetadata(
                {
                  apiKey,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const apiKey =
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!apiKey) return [];
      return [
        {
          solarProvider: "generac",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Generac (Migrated)",
            accessToken: apiKey,
            metadata: buildSourceMetadata(
              { apiKey, baseUrl: toNonEmptyString(metadata.baseUrl) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "hoymiles-smiles": {
      const payloads = connections
        .map((connection, index) => {
          const username = toNonEmptyString(connection.username);
          const password = toNonEmptyString(connection.password);
          if (!username || !password) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `hoymiles-${index + 1}`;
          return {
            solarProvider: "hoymiles",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Hoymiles ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  username,
                  password,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const username = toNonEmptyString(metadata.username);
      const password = toNonEmptyString(metadata.password);
      if (!username || !password) return [];
      return [
        {
          solarProvider: "hoymiles",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Hoymiles (Migrated)",
            metadata: buildSourceMetadata(
              { username, password, baseUrl: toNonEmptyString(metadata.baseUrl) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "goodwe-sems": {
      const payloads = connections
        .map((connection, index) => {
          const account = toNonEmptyString(connection.account);
          const password = toNonEmptyString(connection.password);
          if (!account || !password) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `goodwe-${index + 1}`;
          return {
            solarProvider: "goodwe",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `GoodWe ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  account,
                  password,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const account = toNonEmptyString(metadata.account);
      const password = toNonEmptyString(metadata.password);
      if (!account || !password) return [];
      return [
        {
          solarProvider: "goodwe",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "GoodWe (Migrated)",
            metadata: buildSourceMetadata(
              { account, password, baseUrl: toNonEmptyString(metadata.baseUrl) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "solis-cloud": {
      const payloads = connections
        .map((connection, index) => {
          const apiKey = toNonEmptyString(connection.apiKey);
          const apiSecret = toNonEmptyString(connection.apiSecret);
          if (!apiKey || !apiSecret) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `solis-${index + 1}`;
          return {
            solarProvider: "solis",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Solis ${index + 1} (Migrated)`,
              accessToken: apiKey,
              metadata: buildSourceMetadata(
                {
                  apiKey,
                  apiSecret,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const apiKey =
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      const apiSecret = toNonEmptyString(metadata.apiSecret);
      if (!apiKey || !apiSecret) return [];
      return [
        {
          solarProvider: "solis",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Solis (Migrated)",
            accessToken: apiKey,
            metadata: buildSourceMetadata(
              { apiKey, apiSecret, baseUrl: toNonEmptyString(metadata.baseUrl) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "locus-energy": {
      const payloads = connections
        .map((connection, index) => {
          const clientId = toNonEmptyString(connection.clientId);
          const clientSecret = toNonEmptyString(connection.clientSecret);
          const partnerId = toNonEmptyString(connection.partnerId);
          if (!clientId || !clientSecret || !partnerId) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `locus-${index + 1}`;
          return {
            solarProvider: "locus",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Locus Energy ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  clientId,
                  clientSecret,
                  partnerId,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const clientId = toNonEmptyString(metadata.clientId);
      const clientSecret = toNonEmptyString(metadata.clientSecret);
      const partnerId = toNonEmptyString(metadata.partnerId);
      if (!clientId || !clientSecret || !partnerId) return [];
      return [
        {
          solarProvider: "locus",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Locus Energy (Migrated)",
            metadata: buildSourceMetadata(
              {
                clientId,
                clientSecret,
                partnerId,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "apsystems-ema": {
      const payloads = connections
        .map((connection, index) => {
          const appId =
            toNonEmptyString(connection.appId) ??
            toNonEmptyString(connection.apiKey);
          if (!appId) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `apsystems-${index + 1}`;
          const appSecret = toNonEmptyString(connection.appSecret);
          return {
            solarProvider: "apsystems",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `APsystems ${index + 1} (Migrated)`,
              accessToken: appId,
              metadata: buildSourceMetadata(
                {
                  appId,
                  appSecret,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const appId =
        toNonEmptyString(metadata.appId) ??
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!appId) return [];
      return [
        {
          solarProvider: "apsystems",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "APsystems (Migrated)",
            accessToken: appId,
            metadata: buildSourceMetadata(
              {
                appId,
                appSecret: toNonEmptyString(metadata.appSecret),
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "solar-log": {
      const payloads = connections
        .map((connection, index) => {
          const baseUrl =
            toNonEmptyString(connection.baseUrl) ??
            toNonEmptyString(metadata.baseUrl) ??
            toNonEmptyString(metadata.deviceUrl);
          if (!baseUrl) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `solarlog-${index + 1}`;
          return {
            solarProvider: "solarlog",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Solar-Log ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  baseUrl,
                  password:
                    toNonEmptyString(connection.password) ??
                    toNonEmptyString(metadata.password),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const baseUrl =
        toNonEmptyString(metadata.baseUrl) ??
        toNonEmptyString(metadata.deviceUrl);
      if (!baseUrl) return [];
      return [
        {
          solarProvider: "solarlog",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Solar-Log (Migrated)",
            metadata: buildSourceMetadata(
              { baseUrl, password: toNonEmptyString(metadata.password) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "growatt-server": {
      const payloads = connections
        .map((connection, index) => {
          const username = toNonEmptyString(connection.username);
          const password = toNonEmptyString(connection.password);
          if (!username || !password) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `growatt-${index + 1}`;
          return {
            solarProvider: "growatt",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `Growatt ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  username,
                  password,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const username = toNonEmptyString(metadata.username);
      const password = toNonEmptyString(metadata.password);
      if (!username || !password) return [];
      return [
        {
          solarProvider: "growatt",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "Growatt (Migrated)",
            metadata: buildSourceMetadata(
              { username, password, baseUrl: toNonEmptyString(metadata.baseUrl) },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "egauge-monitoring": {
      const payloads = connections
        .map((connection, index) => {
          const baseUrl =
            toNonEmptyString(connection.baseUrl) ??
            toNonEmptyString(metadata.baseUrl);
          if (!baseUrl) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `egauge-${index + 1}`;
          return {
            solarProvider: "egauge",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `eGauge ${index + 1} (Migrated)`,
              metadata: buildSourceMetadata(
                {
                  baseUrl,
                  accessType:
                    toNonEmptyString(connection.accessType) ??
                    toNonEmptyString(metadata.accessType),
                  username:
                    toNonEmptyString(connection.username) ??
                    toNonEmptyString(metadata.username),
                  password:
                    toNonEmptyString(connection.password) ??
                    toNonEmptyString(metadata.password) ??
                    toNonEmptyString(integration.accessToken),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter((item) => item !== null) as Array<{ solarProvider: string; payload: MigrationPayload }>;
      if (payloads.length > 0) return payloads;

      const baseUrl = toNonEmptyString(metadata.baseUrl);
      if (!baseUrl) return [];
      return [
        {
          solarProvider: "egauge",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "eGauge (Migrated)",
            metadata: buildSourceMetadata(
              {
                baseUrl,
                accessType: toNonEmptyString(metadata.accessType),
                username: toNonEmptyString(metadata.username),
                password:
                  toNonEmptyString(metadata.password) ??
                  toNonEmptyString(integration.accessToken),
              },
              integration.provider,
              "legacy"
            ),
          },
        },
      ];
    }

    case "tesla-powerhub": {
      const clientId = toNonEmptyString(metadata.clientId);
      const clientSecret =
        toNonEmptyString(metadata.clientSecret) ??
        toNonEmptyString(integration.accessToken);
      if (!clientId || !clientSecret) return [];

      const sourceConnectionId =
        toNonEmptyString(metadata.groupId) ?? "primary";
      return [
        {
          solarProvider: "tesla-powerhub",
          payload: {
            sourceConnectionId,
            connectionName:
              toNonEmptyString(metadata.connectionName) ??
              "Tesla Powerhub (Migrated)",
            accessToken: clientSecret,
            metadata: buildSourceMetadata(
              {
                clientId,
                clientSecret,
                groupId: toNonEmptyString(metadata.groupId),
                tokenUrl: toNonEmptyString(metadata.tokenUrl),
                apiBaseUrl: toNonEmptyString(metadata.apiBaseUrl),
                portalBaseUrl: toNonEmptyString(metadata.portalBaseUrl),
                endpointUrl: toNonEmptyString(metadata.endpointUrl),
                signal: toNonEmptyString(metadata.signal),
              },
              integration.provider,
              sourceConnectionId
            ),
          },
        },
      ];
    }

    default:
      return [];
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

  getSiteIds: solarRecOperatorProcedure
    .input(z.object({ credentialId: z.string() }))
    .query(async ({ input }) => {
      const { getSolarRecTeamCredential } = await import("../db");
      const cred = await getSolarRecTeamCredential(input.credentialId);
      if (!cred) return { siteIds: [] };
      const meta = parseMetadataRecord(cred.metadata);
      const raw = Array.isArray(meta.siteIds) ? meta.siteIds : [];
      type RawSiteEntry = { siteId?: string | number; id?: string | number; name?: string };
      const siteIds = raw
        .filter((s: unknown): s is RawSiteEntry =>
          typeof s === "object" && s !== null && (
            (s as RawSiteEntry).siteId !== undefined ||
            (s as RawSiteEntry).id !== undefined
          )
        )
        .map((s: RawSiteEntry) => ({
          siteId: String(s.siteId ?? s.id).trim(),
          name: typeof s.name === "string" ? s.name : null,
        }));
      return { siteIds };
    }),

  setSiteIds: solarRecOperatorProcedure
    .input(
      z.object({
        credentialId: z.string(),
        siteIds: z.array(
          z.object({
            siteId: z.string().min(1),
            name: z.string().optional(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSolarRecTeamCredential, upsertSolarRecTeamCredential } =
        await import("../db");
      const cred = await getSolarRecTeamCredential(input.credentialId);
      if (!cred) throw new Error("Credential not found.");

      // Merge siteIds into existing metadata, preserving all other fields
      const existing = parseMetadataRecord(cred.metadata);
      const merged = {
        ...existing,
        siteIds: input.siteIds.map((s) => ({
          siteId: s.siteId,
          name: s.name ?? null,
        })),
      };

      await upsertSolarRecTeamCredential({
        id: cred.id,
        provider: cred.provider,
        connectionName: cred.connectionName ?? undefined,
        accessToken: cred.accessToken ?? undefined,
        refreshToken: cred.refreshToken ?? undefined,
        metadata: JSON.stringify(merged),
        createdBy: ctx.userId,
      });

      return { count: input.siteIds.length };
    }),

  migrateFromMain: solarRecAdminProcedure.mutation(async ({ ctx }) => {
    const {
      getUserIntegrations,
      listSolarRecTeamCredentials,
      upsertSolarRecTeamCredential,
    } = await import("../db");

    const ownerUserId = await resolveSolarRecOwnerUserId();
    const sourceIntegrations = (
      await getUserIntegrations(ownerUserId)
    ) as MainIntegrationRecord[];
    const existingCreds = await listSolarRecTeamCredentials();
    const existingByProvider = new Map<string, typeof existingCreds>();
    for (const cred of existingCreds) {
      const list = existingByProvider.get(cred.provider) ?? [];
      list.push(cred);
      existingByProvider.set(cred.provider, list);
    }
    const existingBySource = new Map<string, (typeof existingCreds)[number]>();
    for (const cred of existingCreds) {
      const metadata = parseMetadataRecord(cred.metadata);
      const sourceProvider = toNonEmptyString(metadata._sourceProvider);
      const sourceConnectionId = toNonEmptyString(metadata._sourceConnectionId);
      if (!sourceProvider || !sourceConnectionId) continue;
      existingBySource.set(
        `${cred.provider}::${sourceProvider}::${sourceConnectionId}`,
        cred
      );
    }

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
      "tesla-powerhub",
    ] as const;

    let created = 0;
    let updated = 0;
    const usedExistingIds = new Set<string>();
    const results: Array<{
      mainProvider: string;
      solarProvider: string | null;
      status: "created" | "updated" | "skipped";
      reason?: string;
      connectionName?: string;
      sourceConnectionId?: string;
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

      const extractedPayloads = extractMigrationPayloads(integration);
      if (extractedPayloads.length === 0) {
        results.push({
          mainProvider,
          solarProvider: null,
          status: "skipped",
          reason: "Integration exists but required credential fields are missing",
        });
        continue;
      }

      for (let index = 0; index < extractedPayloads.length; index += 1) {
        const extracted = extractedPayloads[index];
        const sourceKey = `${extracted.solarProvider}::${mainProvider}::${extracted.payload.sourceConnectionId}`;
        let existing = existingBySource.get(sourceKey);

        if (existing && usedExistingIds.has(existing.id)) {
          existing = undefined;
        }

        if (!existing) {
          const providerExisting = (existingByProvider.get(extracted.solarProvider) ?? []).filter(
            (cred) => !usedExistingIds.has(cred.id)
          );

          existing =
            providerExisting.find(
              (cred) =>
                (cred.connectionName ?? "").trim().toLowerCase() ===
                extracted.payload.connectionName.trim().toLowerCase()
            ) ??
            (index === 0 ? providerExisting[0] : undefined);
        }

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
          usedExistingIds.add(existing.id);
        } else {
          created += 1;
        }

        results.push({
          mainProvider,
          solarProvider: extracted.solarProvider,
          status: existing ? "updated" : "created",
          connectionName: extracted.payload.connectionName,
          sourceConnectionId: extracted.payload.sourceConnectionId,
          credentialId,
        });
      }
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

  getConfiguredProviders: solarRecViewerProcedure.query(async () => {
    const { listSolarRecTeamCredentials } = await import("../db");
    const credentials = await listSolarRecTeamCredentials();
    return Array.from(new Set(credentials.map((credential) => credential.provider)))
      .filter((provider) => provider.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  }),

  getConfiguredCredentials: solarRecViewerProcedure.query(async () => {
    const { listSolarRecTeamCredentials } = await import("../db");
    const credentials = await listSolarRecTeamCredentials();
    return credentials
      .map((credential) => ({
        id: credential.id,
        provider: credential.provider,
        connectionName: credential.connectionName ?? null,
        label: credentialLabel(credential),
      }))
      .sort((a, b) =>
        a.provider === b.provider
          ? a.label.localeCompare(b.label)
          : a.provider.localeCompare(b.provider)
      );
  }),

  runAll: solarRecOperatorProcedure
    .input(
      z.object({
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        providers: z.array(z.string().min(1)).optional(),
        credentialIds: z.array(z.string().min(1)).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { createMonitoringBatchRun } = await import("../db");
      // Use America/Chicago (project timezone) for dateKey so reads run after
      // 6 PM CT are still stamped with today's date locally, not tomorrow's UTC.
      const dateKey =
        input.anchorDate ??
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chicago",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
      const selectedProviders = Array.from(
        new Set((input.providers ?? []).map((provider) => provider.trim()).filter((provider) => provider.length > 0))
      );
      const selectedCredentialIds = Array.from(
        new Set((input.credentialIds ?? []).map((credentialId) => credentialId.trim()).filter((credentialId) => credentialId.length > 0))
      );
      const batchId = await createMonitoringBatchRun({
        dateKey,
        triggeredBy: ctx.userId,
      });

      // Fire-and-forget: run the batch in background
      import("../solar/monitoring.service").then((mod) =>
        mod.executeMonitoringBatch(batchId, dateKey, ctx.userId, selectedProviders, selectedCredentialIds).catch((err) =>
          console.error("[MonitoringBatch] Failed:", err)
        )
      );

      return { batchId, dateKey, selectedProviders, selectedCredentialIds };
    }),

  /**
   * Force-mark a MonitoringBatchRun as failed. Used to unstick the UI when
   * a batch row is still in "running" status but the server process that
   * was executing it has died (deploy, restart, crash). Does NOT cancel
   * any actively-running process — only updates the DB row so the client
   * dashboard stops polling.
   */
  markBatchFailed: solarRecOperatorProcedure
    .input(z.object({ batchId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { updateMonitoringBatchRun, getMonitoringBatchRun } = await import("../db");
      const existing = await getMonitoringBatchRun(input.batchId);
      if (!existing) {
        throw new Error(`Batch ${input.batchId} not found.`);
      }
      if (existing.status !== "running") {
        return { ok: false, previousStatus: existing.status, message: "Batch is not running — nothing to mark failed." };
      }
      await updateMonitoringBatchRun(input.batchId, {
        status: "failed",
        currentProvider: null,
        currentCredentialName: null,
        completedAt: new Date(),
      });
      return { ok: true, previousStatus: existing.status };
    }),

  /**
   * Wipes the server-side `dataset:convertedReads` payload. Used to clean up
   * a corrupted dataset before re-running meter-read APIs. Client-side
   * IndexedDB must be cleared separately by the caller.
   */
  clearConvertedReads: solarRecOperatorProcedure.mutation(async () => {
    const { saveSolarRecDashboardPayload } = await import("../db");
    const ownerUserId = await resolveSolarRecOwnerUserId();
    // Writing an empty string is how the dashboard's auto-sync signals "cleared"
    // (see SolarRecDashboard.tsx:6208 area).
    const ok = await saveSolarRecDashboardPayload(
      ownerUserId,
      "dataset:convertedReads",
      ""
    );
    return { cleared: ok, ownerUserId };
  }),

  /**
   * Debug endpoint — dumps the raw `dataset:convertedReads` payload from the
   * server DB so we can see exactly what the monitoring bridge has written.
   * Returns metadata + a sample of rows matching today's date.
   *
   * Handles three payload shapes:
   *   1. Full dataset JSON: { uploadedAt, rows, csvText, sources, ... }
   *   2. Chunk pointer: { _chunkedDataset: true, chunkKeys: [...] } — when
   *      the dashboard's auto-sync split a large payload into multiple rows.
   *      We fetch each chunk and reassemble, then parse the combined JSON.
   *   3. Empty/missing: no dataset stored.
   *
   * Also returns the latest MonitoringBatchRun status so we can see if an
   * active batch is actually making progress or stalled.
   */
  debugConvertedReadsState: solarRecOperatorProcedure.query(async () => {
    const { getSolarRecDashboardPayload, getLatestMonitoringBatchRun } = await import("../db");
    const ownerUserId = await resolveSolarRecOwnerUserId();

    // Today in America/Chicago (project timezone)
    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [yy, mm, dd] = todayIso.split("-");
    const todayLocal = `${Number(mm)}/${Number(dd)}/${yy}`;

    // Pull the latest batch status so the UI can tell whether a running
    // batch is actually progressing or has been silently stuck.
    let latestBatch: {
      id: string;
      status: string;
      providersTotal: number;
      providersCompleted: number;
      totalSites: number;
      successCount: number;
      errorCount: number;
      noDataCount: number;
      currentProvider: string | null;
      currentCredentialName: string | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
      ageSeconds: number | null;
    } | null = null;
    try {
      const row = await getLatestMonitoringBatchRun();
      if (row) {
        const createdAt = row.createdAt ? new Date(row.createdAt).toISOString() : null;
        latestBatch = {
          id: row.id,
          status: row.status,
          providersTotal: row.providersTotal ?? 0,
          providersCompleted: row.providersCompleted ?? 0,
          totalSites: row.totalSites ?? 0,
          successCount: row.successCount ?? 0,
          errorCount: row.errorCount ?? 0,
          noDataCount: row.noDataCount ?? 0,
          currentProvider: row.currentProvider ?? null,
          currentCredentialName: row.currentCredentialName ?? null,
          startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
          completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
          createdAt,
          ageSeconds: createdAt
            ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
            : null,
        };
      }
    } catch (err) {
      console.warn("[debugConvertedReadsState] latest batch lookup failed:", err);
    }

    const DB_STORAGE_KEY = "dataset:convertedReads";
    const payloadRaw = await getSolarRecDashboardPayload(ownerUserId, DB_STORAGE_KEY);
    if (!payloadRaw) {
      return {
        ownerUserId,
        todayIso,
        todayLocal,
        exists: false,
        chunked: false,
        chunkKeys: [] as string[],
        uploadedAt: null,
        totalRows: 0,
        todayRowCount: 0,
        sampleRows: [] as Array<Record<string, string>>,
        lastRows: [] as Array<Record<string, string>>,
        sources: [] as Array<{ fileName: string; uploadedAt: string; rowCount: number }>,
        rawPayloadBytes: 0,
        latestBatch,
      };
    }

    // Check if the payload is a chunk pointer (dashboard's auto-sync format
    // for large datasets). If so, follow the chunk keys and reassemble.
    let effectivePayload = payloadRaw;
    let chunked = false;
    let chunkKeys: string[] = [];
    let combinedBytes = payloadRaw.length;
    try {
      const maybePointer = JSON.parse(payloadRaw) as { _chunkedDataset?: unknown; chunkKeys?: unknown };
      if (maybePointer && maybePointer._chunkedDataset === true && Array.isArray(maybePointer.chunkKeys)) {
        chunked = true;
        chunkKeys = maybePointer.chunkKeys.filter((k): k is string => typeof k === "string");
        const parts: string[] = [];
        for (const chunkKey of chunkKeys) {
          const chunkPayload = await getSolarRecDashboardPayload(ownerUserId, `dataset:${chunkKey}`);
          if (chunkPayload) parts.push(chunkPayload);
        }
        effectivePayload = parts.join("");
        combinedBytes = effectivePayload.length;
      }
    } catch {
      // Not a JSON pointer — assume it's the full dataset JSON below.
    }

    let parsed: {
      uploadedAt?: string;
      rows?: Array<Record<string, string>>;
      csvText?: string;
      headers?: string[];
      sources?: Array<{ fileName: string; uploadedAt: string; rowCount: number }>;
    } = {};
    try {
      parsed = JSON.parse(effectivePayload);
    } catch {
      return {
        ownerUserId,
        todayIso,
        todayLocal,
        exists: true,
        chunked,
        chunkKeys,
        uploadedAt: null,
        totalRows: 0,
        todayRowCount: 0,
        sampleRows: [],
        lastRows: [],
        sources: [],
        rawPayloadBytes: combinedBytes,
        parseError: "Stored payload is not valid JSON",
        latestBatch,
      };
    }

    // Some payloads (e.g. client auto-sync) write only `csvText`, not `rows`.
    // Fall back to parsing csvText with the shared CSV parser.
    let rows: Array<Record<string, string>> = Array.isArray(parsed.rows) ? parsed.rows : [];
    if (rows.length === 0 && typeof parsed.csvText === "string" && parsed.csvText.trim().length > 0) {
      const { parseCsvText } = await import("../routers/helpers");
      rows = parseCsvText(parsed.csvText).rows;
    }

    const todayRows = rows.filter(
      (r) =>
        r.read_date === todayLocal ||
        r.read_date === todayIso ||
        (typeof r.read_date === "string" && r.read_date.startsWith(todayIso))
    );

    return {
      ownerUserId,
      todayIso,
      todayLocal,
      exists: true,
      chunked,
      chunkKeys,
      uploadedAt: parsed.uploadedAt ?? null,
      totalRows: rows.length,
      todayRowCount: todayRows.length,
      sampleRows: todayRows.slice(0, 10),
      lastRows: rows.slice(-5),
      sources: parsed.sources ?? [],
      rawPayloadBytes: combinedBytes,
      latestBatch,
    };
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

      const credentials = creds.map((c) => ({
        id: c.id,
        name: credentialLabel(c),
        provider: c.provider,
      }));

      return { runs, credentials };
    }),
});

// ---------------------------------------------------------------------------
// Compose root router
// ---------------------------------------------------------------------------
//
// 2026-04-15: authRouter and enphaseV2Router were removed from this file.
// No client ever called solarRecTrpc.auth.* or solarRecTrpc.enphaseV2.*
// (main-app pages use the primary trpc client, which hits the main
// appRouter's auth/enphaseV2 sub-routers in server/routers/*.ts).
// The "auth" and "enphaseV2" roots were also dropped from
// SOLAR_REC_ROUTER_ROOTS in _core/index.ts so any legacy request that
// happens to arrive at /solar-rec/api/trpc/{auth,enphaseV2}.* now falls
// through the dispatcher to the main appRouter instead of 404-ing here.

export const solarRecAppRouter = t.router({
  users: usersRouter,
  credentials: credentialsRouter,
  monitoring: monitoringRouter,
});

export type SolarRecAppRouter = typeof solarRecAppRouter;
