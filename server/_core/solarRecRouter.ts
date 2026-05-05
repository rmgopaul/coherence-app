import { TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { z } from "zod";
import {
  authenticateSolarRecRequest,
  resolveSolarRecOwnerUserId,
  resolveSolarRecScopeId,
  type SolarRecAuthenticatedUser,
} from "./solarRecAuth";
import {
  MODULE_KEYS,
  MODULES,
  type ModuleKey,
  type PermissionLevel,
} from "../../shared/solarRecModules";
import {
  t,
  solarRecViewerProcedure,
  MODULE_KEY_ZOD,
  PERMISSION_LEVEL_ZOD,
  NON_NONE_LEVEL_ZOD,
  requirePermission,
  permissionUserIdentity,
  type SolarRecContext,
} from "./solarRecBase";
import { solarRecDashboardRouter } from "./solarRecDashboardRouter";
import { solarRecContractScanRouter } from "./solarRecContractScanRouter";
import { solarRecZendeskRouter } from "./solarRecZendeskRouter";
import { solarRecAbpSettlementRouter } from "./solarRecAbpSettlementRouter";
import { solarRecCsgPortalRouter } from "./solarRecCsgPortalRouter";
import { solarRecDinScrapeRouter } from "./solarRecDinScrapeRouter";
import { solarRecJobsRouter } from "./solarRecJobsRouter";
import { solarRecSystemsRouter } from "./solarRecSystemsRouter";
import { solarRecWorksetsRouter } from "./solarRecWorksetsRouter";
import { sanitizeApiKey as solarEdgeSanitizeApiKey } from "../services/solar/solarEdge";

// ---------------------------------------------------------------------------
// Context — `createSolarRecContext` stays here because `_core/index.ts`
// imports it from this file. Type + tRPC instance + permission helpers
// live in `./solarRecBase` so sibling sub-router files can import them
// without circular deps.
// ---------------------------------------------------------------------------

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

  const scopeId = await resolveSolarRecScopeId();

  return {
    req: opts.req,
    res: opts.res,
    user,
    userId: user.id,
    scopeId,
  };
}

// ---------------------------------------------------------------------------
// Users sub-router
// ---------------------------------------------------------------------------

const usersRouter = t.router({
  me: solarRecViewerProcedure.query(({ ctx }) => {
    return ctx.user;
  }),

  list: requirePermission("team-permissions", "admin").query(async () => {
    const { listSolarRecUsers } = await import("../db");
    const users = await listSolarRecUsers();
    return users.map(u => ({
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

  invite: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "operator", "viewer"]).default("operator"),
        // Task 5.2 — optional preset to snapshot onto the invitee on
        // accept. Validated against the current scope so cross-scope IDs
        // can't be used.
        presetId: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        createSolarRecInvite,
        getSolarRecUserByEmail,
        getSolarRecPermissionPreset,
      } = await import("../db");

      // Check if user already exists
      const existing = await getSolarRecUserByEmail(input.email);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with this email already exists",
        });
      }

      if (input.presetId) {
        const preset = await getSolarRecPermissionPreset(input.presetId);
        if (!preset || preset.scopeId !== ctx.scopeId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Preset not found in this scope",
          });
        }
      }

      const { token, expiresAt } = await createSolarRecInvite({
        email: input.email,
        role: input.role,
        createdBy: ctx.userId,
        presetId: input.presetId ?? null,
      });

      return {
        email: input.email,
        role: input.role,
        presetId: input.presetId ?? null,
        expiresAt,
        token,
      };
    }),

  listInvites: requirePermission("team-permissions", "admin").query(
    async () => {
      const { listSolarRecInvites } = await import("../db");
      return listSolarRecInvites();
    }
  ),

  deleteInvite: requirePermission("team-permissions", "admin")
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ input }) => {
      const { deleteSolarRecInvite } = await import("../db");
      await deleteSolarRecInvite(input.inviteId);
      return { success: true };
    }),

  updateRole: requirePermission("team-permissions", "admin")
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
      const { updateSolarRecUserRole, getSolarRecUserById } =
        await import("../db");
      const target = await getSolarRecUserById(input.userId);
      if (!target)
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      if (target.role === "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot change owner role",
        });
      }
      await updateSolarRecUserRole(input.userId, input.role);
      return { success: true };
    }),

  deactivate: requirePermission("team-permissions", "admin")
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot deactivate yourself",
        });
      }
      const { deactivateSolarRecUser, getSolarRecUserById } =
        await import("../db");
      const target = await getSolarRecUserById(input.userId);
      if (!target)
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      if (target.role === "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot deactivate owner",
        });
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
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function isSensitiveCredentialMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "apikey" ||
    normalized === "apisecret" ||
    normalized === "appsecret" ||
    normalized === "clientsecret" ||
    normalized === "password" ||
    normalized === "passphrase" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "accesskeyvalue" ||
    normalized === "token" ||
    normalized === "secret"
  );
}

function redactCredentialMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialMetadataValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      isSensitiveCredentialMetadataKey(key)
        ? "[redacted]"
        : redactCredentialMetadataValue(nested),
    ])
  );
}

function redactCredentialMetadata(
  metadata: string | null | undefined
): string | null {
  if (!metadata) return null;
  const parsed = parseMetadataRecord(metadata);
  return serializeMetadata(
    redactCredentialMetadataValue(parsed) as Record<string, unknown>
  );
}

function compactCredentialMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata)
      .map(
        ([key, value]) =>
          [key, typeof value === "string" ? value.trim() : value] as const
      )
      .filter(([, value]) => value !== "")
  );
}

function normalizeCredentialConnectInput(input: {
  provider: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  metadata?: string;
}): {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  metadata: string;
} {
  const provider = input.provider.trim().toLowerCase();
  const metadata = compactCredentialMetadata(
    parseMetadataRecord(input.metadata)
  );
  let accessToken = toNonEmptyString(input.accessToken) ?? undefined;
  let refreshToken = toNonEmptyString(input.refreshToken) ?? undefined;
  let expiresAt =
    toOptionalDate(input.expiresAt) ?? toOptionalDate(metadata.expiresAt);

  if (provider === "tesla-powerhub") {
    accessToken =
      accessToken ?? toNonEmptyString(metadata.clientSecret) ?? undefined;
    delete metadata.clientSecret;
  }

  if (provider === "enphase-v4") {
    accessToken =
      accessToken ?? toNonEmptyString(metadata.accessToken) ?? undefined;
    refreshToken =
      refreshToken ?? toNonEmptyString(metadata.refreshToken) ?? undefined;
    expiresAt = expiresAt ?? toOptionalDate(metadata.expiresAt);
    delete metadata.accessToken;
    delete metadata.refreshToken;
    delete metadata.expiresAt;
  }

  if (provider === "generac") {
    accessToken =
      accessToken ??
      toNonEmptyString(metadata.accessToken) ??
      toNonEmptyString(metadata.apiKey) ??
      undefined;
    if (accessToken && !toNonEmptyString(metadata.apiKey)) {
      metadata.apiKey = accessToken;
    }
    delete metadata.accessToken;
  }

  if (provider === "solaredge") {
    // Strip zero-width / BOM chars that survive `.trim()` so a paste
    // from the SolarEdge admin portal cannot break URL-encoded auth.
    const apiKeyMeta = toNonEmptyString(metadata.apiKey);
    const sanitizedFromMeta = apiKeyMeta
      ? solarEdgeSanitizeApiKey(apiKeyMeta)
      : null;
    if (sanitizedFromMeta) metadata.apiKey = sanitizedFromMeta;
    const sanitizedFromAccessToken = accessToken
      ? solarEdgeSanitizeApiKey(accessToken)
      : null;
    accessToken = sanitizedFromAccessToken || sanitizedFromMeta || accessToken;
    if (accessToken && !toNonEmptyString(metadata.apiKey)) {
      metadata.apiKey = accessToken;
    }
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    metadata: serializeMetadata(metadata),
  };
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;

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
            refreshToken:
              toNonEmptyString(integration.refreshToken) ?? undefined,
            expiresAt,
            metadata: buildSourceMetadata(
              {
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
              {
                username,
                password,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
              {
                account,
                password,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
              {
                apiKey,
                apiSecret,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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

    case "ekm-encompass": {
      const payloads = connections
        .map((connection, index) => {
          const apiKey = toNonEmptyString(connection.apiKey);
          if (!apiKey) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `ekm-${index + 1}`;
          return {
            solarProvider: "ekm",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `EKM ${index + 1} (Migrated)`,
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
      if (payloads.length > 0) return payloads;

      const apiKey =
        toNonEmptyString(metadata.apiKey) ??
        toNonEmptyString(integration.accessToken);
      if (!apiKey) return [];
      return [
        {
          solarProvider: "ekm",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "EKM (Migrated)",
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

    case "ennexos-monitoring": {
      const payloads = connections
        .map((connection, index) => {
          const accessToken =
            toNonEmptyString(connection.accessToken) ??
            toNonEmptyString(connection.accessKeyId);
          if (!accessToken) return null;
          const sourceConnectionId =
            toNonEmptyString(connection.id) ?? `ennexos-${index + 1}`;
          return {
            solarProvider: "ennexos",
            payload: {
              sourceConnectionId,
              connectionName:
                toNonEmptyString(connection.name) ??
                `ennexOS ${index + 1} (Migrated)`,
              accessToken,
              metadata: buildSourceMetadata(
                {
                  accessToken,
                  baseUrl:
                    toNonEmptyString(connection.baseUrl) ??
                    toNonEmptyString(connection.accessKeyValue) ??
                    toNonEmptyString(metadata.baseUrl),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
      if (payloads.length > 0) return payloads;

      const accessToken =
        toNonEmptyString(metadata.accessToken) ??
        toNonEmptyString(metadata.accessKeyId) ??
        toNonEmptyString(integration.accessToken);
      if (!accessToken) return [];
      return [
        {
          solarProvider: "ennexos",
          payload: {
            sourceConnectionId: "legacy",
            connectionName: "ennexOS (Migrated)",
            accessToken,
            metadata: buildSourceMetadata(
              {
                accessToken,
                baseUrl:
                  toNonEmptyString(metadata.baseUrl) ??
                  toNonEmptyString(metadata.accessKeyValue),
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
              {
                username,
                password,
                baseUrl: toNonEmptyString(metadata.baseUrl),
              },
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
                  meterId:
                    toNonEmptyString(connection.meterId) ??
                    toNonEmptyString(metadata.meterId),
                },
                integration.provider,
                sourceConnectionId
              ),
            },
          };
        })
        .filter(item => item !== null) as Array<{
        solarProvider: string;
        payload: MigrationPayload;
      }>;
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
                meterId: toNonEmptyString(metadata.meterId),
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
  list: requirePermission("solar-rec-settings", "read").query(async () => {
    const { listSolarRecTeamCredentials } = await import("../db");
    const creds = await listSolarRecTeamCredentials();
    return creds.map(c => ({
      id: c.id,
      provider: c.provider,
      connectionName: c.connectionName,
      hasAccessToken: !!c.accessToken,
      hasRefreshToken: !!c.refreshToken,
      expiresAt: c.expiresAt,
      metadata: redactCredentialMetadata(c.metadata),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }),

  connect: requirePermission("solar-rec-settings", "admin")
    .input(
      z.object({
        id: z.string().optional(),
        provider: z.string(),
        connectionName: z.string().optional(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        expiresAt: z.string().optional(),
        metadata: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { upsertSolarRecTeamCredential } = await import("../db");
      const normalized = normalizeCredentialConnectInput(input);
      const id = await upsertSolarRecTeamCredential({
        id: input.id,
        provider: input.provider.trim(),
        connectionName: input.connectionName,
        accessToken: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        metadata: normalized.metadata,
        createdBy: ctx.userId,
      });
      return { id };
    }),

  disconnect: requirePermission("solar-rec-settings", "admin")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const { deleteSolarRecTeamCredential } = await import("../db");
      await deleteSolarRecTeamCredential(input.id);
      return { success: true };
    }),

  getSiteIds: requirePermission("monitoring-overview", "edit")
    .input(z.object({ credentialId: z.string() }))
    .query(async ({ input }) => {
      const { getSolarRecTeamCredential } = await import("../db");
      const cred = await getSolarRecTeamCredential(input.credentialId);
      if (!cred) return { siteIds: [] };
      const meta = parseMetadataRecord(cred.metadata);
      const raw = Array.isArray(meta.siteIds) ? meta.siteIds : [];
      type RawSiteEntry = {
        siteId?: string | number;
        id?: string | number;
        name?: string;
      };
      const siteIds = raw
        .filter(
          (s: unknown): s is RawSiteEntry =>
            typeof s === "object" &&
            s !== null &&
            ((s as RawSiteEntry).siteId !== undefined ||
              (s as RawSiteEntry).id !== undefined)
        )
        .map((s: RawSiteEntry) => ({
          siteId: String(s.siteId ?? s.id).trim(),
          name: typeof s.name === "string" ? s.name : null,
        }));
      return { siteIds };
    }),

  setSiteIds: requirePermission("monitoring-overview", "edit")
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
        siteIds: input.siteIds.map(s => ({
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

  migrateFromMain: requirePermission("solar-rec-settings", "admin").mutation(
    async ({ ctx }) => {
      const {
        getUserIntegrations,
        listSolarRecTeamCredentials,
        upsertSolarRecTeamCredential,
      } = await import("../db");

      const ownerUserId = await resolveSolarRecOwnerUserId();
      const sourceIntegrations = (await getUserIntegrations(
        ownerUserId
      )) as MainIntegrationRecord[];
      const existingCreds = await listSolarRecTeamCredentials();
      const existingByProvider = new Map<string, typeof existingCreds>();
      for (const cred of existingCreds) {
        const list = existingByProvider.get(cred.provider) ?? [];
        list.push(cred);
        existingByProvider.set(cred.provider, list);
      }
      const existingBySource = new Map<
        string,
        (typeof existingCreds)[number]
      >();
      for (const cred of existingCreds) {
        const metadata = parseMetadataRecord(cred.metadata);
        const sourceProvider = toNonEmptyString(metadata._sourceProvider);
        const sourceConnectionId = toNonEmptyString(
          metadata._sourceConnectionId
        );
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
        "ekm-encompass",
        "ennexos-monitoring",
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
          sourceIntegrations.find(item => item.provider === mainProvider) ??
          null;
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
            reason:
              "Integration exists but required credential fields are missing",
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
            const providerExisting = (
              existingByProvider.get(extracted.solarProvider) ?? []
            ).filter(cred => !usedExistingIds.has(cred.id));

            existing =
              providerExisting.find(
                cred =>
                  (cred.connectionName ?? "").trim().toLowerCase() ===
                  extracted.payload.connectionName.trim().toLowerCase()
              ) ?? (index === 0 ? providerExisting[0] : undefined);
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

      const skipped = results.filter(item => item.status === "skipped").length;
      return {
        ownerUserId,
        created,
        updated,
        skipped,
        total: results.length,
        results,
      };
    }
  ),
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
    .query(async ({ ctx, input }) => {
      const { getMonitoringGrid } = await import("../db");
      return getMonitoringGrid(ctx.scopeId, input.startDate, input.endDate);
    }),

  getGridPage: solarRecViewerProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        search: z.string().max(255).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getMonitoringGridPage } = await import("../db");
      return getMonitoringGridPage(
        ctx.scopeId,
        input.startDate,
        input.endDate,
        {
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        }
      );
    }),

  exportGridCsv: solarRecViewerProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { exportMonitoringGridCsv } = await import("../db");
      const csv = await exportMonitoringGridCsv(
        ctx.scopeId,
        input.startDate,
        input.endDate
      );
      return {
        fileName: `monitoring-${input.endDate}.csv`,
        csv,
      };
    }),

  getHealthSummary: solarRecViewerProcedure.query(async ({ ctx }) => {
    const { getMonitoringHealthSummary } = await import("../db");
    return getMonitoringHealthSummary(ctx.scopeId);
  }),

  getOverviewStats: solarRecViewerProcedure.query(async ({ ctx }) => {
    const { getMonitoringOverviewStats } = await import("../db");
    const todayDateKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const toDateKey = (daysBack: number) => {
      const date = new Date(`${todayDateKey}T00:00:00`);
      date.setDate(date.getDate() - daysBack);
      return date.toISOString().slice(0, 10);
    };
    return getMonitoringOverviewStats(
      ctx.scopeId,
      todayDateKey,
      toDateKey(3),
      toDateKey(30)
    );
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
    return Array.from(
      new Set(credentials.map(credential => credential.provider))
    )
      .filter(provider => provider.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  }),

  getConfiguredCredentials: requirePermission(
    "monitoring-overview",
    "edit"
  ).query(async () => {
    const { listSolarRecTeamCredentials } = await import("../db");
    const credentials = await listSolarRecTeamCredentials();
    return credentials
      .map(credential => ({
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

  /**
   * Read-only view of the cron-style monitoring scheduler. Returns the
   * configured run hour, the configured day-of-month tokens (defaults
   * `1, 12, 15, last`, override via `SOLAR_REC_MONITOR_DAYS`), whether
   * today is a scheduled day, and the next scheduled date — so the
   * MonitoringDashboard can show "today is/isn't a run day, next: …"
   * without needing an admin to read env vars.
   */
  getSchedulerStatus: requirePermission("monitoring-overview", "read").query(
    async () => {
      const {
        getScheduledHour,
        getMonthlyScheduleTokens,
        shouldRunMonthlyMonitoring,
        nextScheduledDateKey,
      } = await import("../solar/monitoringScheduler");
      const { toDateKey } = await import("@shared/dateKey");
      const dateKey = toDateKey(new Date(), "America/Chicago");
      const tokens = getMonthlyScheduleTokens();
      return {
        configuredHour: getScheduledHour(),
        configuredDays: tokens,
        isDailyMode: tokens.includes("daily"),
        todayDateKey: dateKey,
        todayIsScheduledDay: shouldRunMonthlyMonitoring(dateKey),
        nextScheduledDateKey: nextScheduledDateKey(dateKey),
      };
    }
  ),

  /**
   * Manually fire the monitoring batch through the scheduler's exact code
   * path, ignoring the day-of-month gate. Lets an admin verify the
   * scheduled run end-to-end on demand without waiting until the next
   * configured day. Functionally equivalent to `runAll` (no provider
   * filter, no anchor-date override) but tagged with the user that
   * triggered it AND surfaces `wouldRunNormally` so the response makes
   * clear today's actual schedule status.
   */
  testScheduledRun: requirePermission("monitoring-overview", "edit").mutation(
    async ({ ctx }) => {
      const { startScheduledMonitoringBatchManually } =
        await import("../solar/monitoringScheduler");
      return startScheduledMonitoringBatchManually(ctx.userId);
    }
  ),

  runAll: requirePermission("monitoring-overview", "edit")
    .input(
      z.object({
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
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
        new Set(
          (input.providers ?? [])
            .map(provider => provider.trim())
            .filter(provider => provider.length > 0)
        )
      );
      const selectedCredentialIds = Array.from(
        new Set(
          (input.credentialIds ?? [])
            .map(credentialId => credentialId.trim())
            .filter(credentialId => credentialId.length > 0)
        )
      );
      const batchId = await createMonitoringBatchRun({
        scopeId: ctx.scopeId,
        dateKey,
        triggeredBy: ctx.userId,
      });

      // Fire-and-forget: run the batch in background
      const batchScopeId = ctx.scopeId;
      import("../solar/monitoring.service").then(mod =>
        mod
          .executeMonitoringBatch(
            batchId,
            batchScopeId,
            dateKey,
            ctx.userId,
            selectedProviders,
            selectedCredentialIds
          )
          .catch(err => console.error("[MonitoringBatch] Failed:", err))
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
  markBatchFailed: requirePermission("monitoring-overview", "edit")
    .input(z.object({ batchId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { updateMonitoringBatchRun, getMonitoringBatchRun } =
        await import("../db");
      const existing = await getMonitoringBatchRun(input.batchId);
      if (!existing) {
        throw new Error(`Batch ${input.batchId} not found.`);
      }
      if (existing.status !== "running") {
        return {
          ok: false,
          previousStatus: existing.status,
          message: "Batch is not running — nothing to mark failed.",
        };
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
  clearConvertedReads: requirePermission(
    "monitoring-overview",
    "edit"
  ).mutation(async () => {
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
  debugConvertedReadsState: requirePermission(
    "monitoring-overview",
    "edit"
  ).query(async ({ ctx }) => {
    const { getSolarRecDashboardPayload, getLatestMonitoringBatchRun } =
      await import("../db");
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
      const row = await getLatestMonitoringBatchRun(ctx.scopeId);
      if (row) {
        const createdAt = row.createdAt
          ? new Date(row.createdAt).toISOString()
          : null;
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
          startedAt: row.startedAt
            ? new Date(row.startedAt).toISOString()
            : null,
          completedAt: row.completedAt
            ? new Date(row.completedAt).toISOString()
            : null,
          createdAt,
          ageSeconds: createdAt
            ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
            : null,
        };
      }
    } catch (err) {
      console.warn(
        "[debugConvertedReadsState] latest batch lookup failed:",
        err
      );
    }

    const DB_STORAGE_KEY = "dataset:convertedReads";
    const payloadRaw = await getSolarRecDashboardPayload(
      ownerUserId,
      DB_STORAGE_KEY
    );
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
        sources: [] as Array<{
          fileName: string;
          uploadedAt: string;
          rowCount: number;
        }>,
        rawPayloadBytes: 0,
        rawPayloadPreview: "",
        topLevelKeys: [] as string[],
        isSourceManifest: false,
        manifestSourceCount: 0,
        latestBatch,
      };
    }

    // Check if the payload is a chunk pointer (dashboard's auto-sync format
    // for large datasets). If so, follow the chunk keys and reassemble.
    let effectivePayload = payloadRaw;
    let chunked = false;
    let chunkKeys: string[] = [];
    let combinedBytes = payloadRaw.length;
    type ManifestSource = {
      id: string;
      fileName: string;
      uploadedAt: string;
      rowCount: number;
      sizeBytes?: number;
      storageKey: string;
      chunkKeys?: string[];
    };
    let sourceManifest: { sources: ManifestSource[] } | null = null;
    try {
      const maybeWrapper = JSON.parse(payloadRaw) as {
        _chunkedDataset?: unknown;
        _rawSourcesV1?: unknown;
        chunkKeys?: unknown;
        sources?: unknown;
      };
      if (
        maybeWrapper &&
        maybeWrapper._chunkedDataset === true &&
        Array.isArray(maybeWrapper.chunkKeys)
      ) {
        chunked = true;
        chunkKeys = maybeWrapper.chunkKeys.filter(
          (k): k is string => typeof k === "string"
        );
        const parts: string[] = [];
        for (const chunkKey of chunkKeys) {
          const chunkPayload = await getSolarRecDashboardPayload(
            ownerUserId,
            `dataset:${chunkKey}`
          );
          if (chunkPayload) parts.push(chunkPayload);
        }
        effectivePayload = parts.join("");
        combinedBytes = effectivePayload.length;
      } else if (
        maybeWrapper &&
        maybeWrapper._rawSourcesV1 === true &&
        Array.isArray(maybeWrapper.sources)
      ) {
        // Source-manifest format: main key is a pointer to individual source
        // files stored under src_convertedReads_<id>_chunk_NNNN. Fetch each
        // source's chunks, reassemble as CSV text, and count rows.
        sourceManifest = {
          sources: maybeWrapper.sources as ManifestSource[],
        };
      }
    } catch {
      // Not a JSON pointer — assume it's the full dataset JSON below.
    }

    // If source-manifest format, walk all sources, fetch their chunks,
    // parse each as CSV, and aggregate into a single row count + sample.
    if (sourceManifest) {
      const { parseCsvText } = await import("../routers/helpers");
      const aggregatedRows: Array<Record<string, string>> = [];
      const sourcesSummary: Array<{
        fileName: string;
        uploadedAt: string;
        rowCount: number;
      }> = [];
      let totalSourceBytes = payloadRaw.length;
      let lastUploadedAt: string | null = null;

      for (const source of sourceManifest.sources) {
        sourcesSummary.push({
          fileName: source.fileName,
          uploadedAt: source.uploadedAt,
          rowCount: source.rowCount,
        });
        if (!lastUploadedAt || source.uploadedAt > lastUploadedAt) {
          lastUploadedAt = source.uploadedAt;
        }

        // Fetch each chunk for this source and concatenate
        const chunkKeyList = Array.isArray(source.chunkKeys)
          ? source.chunkKeys
          : [];
        const parts: string[] = [];
        for (const ck of chunkKeyList) {
          const p = await getSolarRecDashboardPayload(
            ownerUserId,
            `dataset:${ck}`
          );
          if (p) parts.push(p);
        }
        const sourcePayload = parts.join("");
        totalSourceBytes += sourcePayload.length;

        if (!sourcePayload) continue;
        // Each source payload may itself be JSON-wrapped or raw CSV text.
        // Try JSON first (utf8 encoding wraps with fileName metadata in some
        // versions); fall back to treating it as CSV text directly.
        let csvText = sourcePayload;
        try {
          const maybeJson = JSON.parse(sourcePayload);
          if (
            maybeJson &&
            typeof maybeJson === "object" &&
            typeof maybeJson.csvText === "string"
          ) {
            csvText = maybeJson.csvText;
          } else if (typeof maybeJson === "string") {
            csvText = maybeJson;
          }
        } catch {
          // Not JSON — use as-is
        }

        try {
          const parsed = parseCsvText(csvText);
          aggregatedRows.push(...parsed.rows);
        } catch {
          // Ignore parse failures
        }
      }

      const todayRowsFromManifest = aggregatedRows.filter(
        r =>
          r.read_date === todayLocal ||
          r.read_date === todayIso ||
          (typeof r.read_date === "string" && r.read_date.startsWith(todayIso))
      );

      return {
        ownerUserId,
        todayIso,
        todayLocal,
        exists: true,
        chunked: false,
        chunkKeys: [],
        uploadedAt: lastUploadedAt,
        totalRows: aggregatedRows.length,
        todayRowCount: todayRowsFromManifest.length,
        sampleRows: todayRowsFromManifest.slice(0, 10),
        lastRows: aggregatedRows.slice(-5),
        sources: sourcesSummary,
        rawPayloadBytes: totalSourceBytes,
        rawPayloadPreview: payloadRaw.slice(0, 400),
        topLevelKeys: ["_rawSourcesV1", "sources"],
        isSourceManifest: true,
        manifestSourceCount: sourceManifest.sources.length,
        latestBatch,
      };
    }

    let parsed: {
      uploadedAt?: string;
      rows?: Array<Record<string, string>>;
      csvText?: string;
      headers?: string[];
      sources?: Array<{
        fileName: string;
        uploadedAt: string;
        rowCount: number;
      }>;
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
        rawPayloadPreview: payloadRaw.slice(0, 400),
        topLevelKeys: [] as string[],
        isSourceManifest: false,
        manifestSourceCount: 0,
        parseError: "Stored payload is not valid JSON",
        latestBatch,
      };
    }

    // Some payloads (e.g. client auto-sync) write only `csvText`, not `rows`.
    // Fall back to parsing csvText with the shared CSV parser.
    let rows: Array<Record<string, string>> = Array.isArray(parsed.rows)
      ? parsed.rows
      : [];
    if (
      rows.length === 0 &&
      typeof parsed.csvText === "string" &&
      parsed.csvText.trim().length > 0
    ) {
      const { parseCsvText } = await import("../routers/helpers");
      rows = parseCsvText(parsed.csvText).rows;
    }

    const todayRows = rows.filter(
      r =>
        r.read_date === todayLocal ||
        r.read_date === todayIso ||
        (typeof r.read_date === "string" && r.read_date.startsWith(todayIso))
    );

    // Capture first N chars of the raw (main-key) payload for diagnostic
    // preview — helps diagnose "mystery payload" cases where the debug
    // endpoint reports 0 rows but a non-trivial byte count.
    const rawPayloadPreview = payloadRaw.slice(0, 400);
    const topLevelKeys = Object.keys(parsed).slice(0, 20);

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
      rawPayloadPreview,
      topLevelKeys,
      isSourceManifest: false,
      manifestSourceCount: 0,
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
    .query(async ({ ctx, input }) => {
      const { getMonitoringOverview, listSolarRecTeamCredentials } =
        await import("../db");

      const [overview, creds] = await Promise.all([
        getMonitoringOverview(ctx.scopeId, input.startDate, input.endDate),
        listSolarRecTeamCredentials(),
      ]);

      const credentials = creds.map(c => ({
        id: c.id,
        name: credentialLabel(c),
        provider: c.provider,
      }));

      return { ...overview, credentials };
    }),

  /**
   * Task 7.1 (2026-04-28). Per-site daily overview anchored at
   * `dateKey` (defaults to today in America/Chicago, matching the
   * project's dateKey convention). Returns one row per
   * (provider, connectionId, siteId) triple seen in the last 30 days,
   * with yesterday status / 7d / 30d rollups / last run / last error.
   *
   * Wired into MonitoringOverview.tsx as a per-site detail card below
   * the existing per-connection daily-grid view. The
   * "Re-run failed sites" button on that card derives unique
   * (provider, connectionId) pairs from the failed rows and calls
   * the existing `runAll` mutation filtered to those — coarser than
   * a per-site re-run (the underlying `executeMonitoringBatch`
   * doesn't take a per-site filter today) but ships the value
   * without needing to thread a siteIdFilter through every provider
   * adapter.
   *
   * Always returns `_runnerVersion` per the CLAUDE.md observability
   * rule for solar-rec data-flow procedures.
   */
  getDailyOverview: solarRecViewerProcedure
    .input(
      z.object({
        dateKey: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const {
        getMonitoringDailyOverview,
        MONITORING_DAILY_OVERVIEW_RUNNER_VERSION,
      } = await import("../db");
      const dateKey =
        input.dateKey ??
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chicago",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

      const sites = await getMonitoringDailyOverview(ctx.scopeId, dateKey);
      return {
        _runnerVersion: MONITORING_DAILY_OVERVIEW_RUNNER_VERSION,
        dateKey,
        sites,
      };
    }),
});

// ---------------------------------------------------------------------------
// Permissions sub-router
// ---------------------------------------------------------------------------
//
// Task 5.1. Read-only endpoints are available to any authenticated user so
// the client can know what it can render; write endpoints require admin on
// `team-permissions` (which also implicitly resolves to scope-owner /
// scope-admin via the middleware).

const permissionsRouter = t.router({
  /**
   * Every module the client knows about, plus metadata for the matrix UI.
   */
  listModules: solarRecViewerProcedure.query(() => {
    return MODULES.map(m => ({
      key: m.key,
      label: m.label,
      description: m.description,
      maxLevel: m.maxLevel,
    }));
  }),

  /**
   * The caller's own effective permission on each module. Fast path the
   * UI uses to disable/hide write controls.
   */
  getMyPermissions: solarRecViewerProcedure.query(async ({ ctx }) => {
    const { resolveEffectivePermission } = await import("../db");
    const entries = await Promise.all(
      MODULE_KEYS.map(async moduleKey => {
        const eff = await resolveEffectivePermission(
          ctx.userId,
          ctx.scopeId,
          moduleKey,
          { user: permissionUserIdentity(ctx.user!) }
        );
        return [moduleKey, eff.level] as const;
      })
    );
    return {
      scopeId: ctx.scopeId,
      isScopeAdmin: ctx.user!.isScopeAdmin,
      permissions: Object.fromEntries(entries) as Record<
        ModuleKey,
        PermissionLevel
      >,
    };
  }),

  /**
   * Full matrix for the scope. Used by the Settings UI. Requires admin on
   * `team-permissions`.
   */
  listScopePermissions: requirePermission("team-permissions", "admin").query(
    async ({ ctx }) => {
      const { listSolarRecUserModulePermissions, listSolarRecUsers } =
        await import("../db");
      const [rows, users] = await Promise.all([
        listSolarRecUserModulePermissions(ctx.scopeId),
        listSolarRecUsers(),
      ]);
      return {
        scopeId: ctx.scopeId,
        users: users.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          isActive: u.isActive,
          isScopeAdmin: u.isScopeAdmin,
        })),
        permissions: rows.map(r => ({
          userId: r.userId,
          moduleKey: r.moduleKey as ModuleKey,
          permission: r.permission as PermissionLevel,
          updatedAt: r.updatedAt,
        })),
      };
    }
  ),

  /**
   * Update a single cell of the matrix. Admin-only.
   */
  setUserPermission: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        userId: z.number().int().positive(),
        moduleKey: MODULE_KEY_ZOD,
        permission: PERMISSION_LEVEL_ZOD,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { upsertSolarRecUserModulePermission } = await import("../db");
      await upsertSolarRecUserModulePermission({
        userId: input.userId,
        scopeId: ctx.scopeId,
        moduleKey: input.moduleKey,
        permission: input.permission,
      });
      return { ok: true };
    }),

  /**
   * Overwrite a user's full set of permissions (used by the preset
   * "apply" button in the Settings UI). Admin-only.
   */
  replaceUserPermissions: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        userId: z.number().int().positive(),
        permissions: z.array(
          z.object({
            moduleKey: MODULE_KEY_ZOD,
            permission: NON_NONE_LEVEL_ZOD,
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { replaceSolarRecUserModulePermissions } = await import("../db");
      await replaceSolarRecUserModulePermissions({
        userId: input.userId,
        scopeId: ctx.scopeId,
        permissions: input.permissions,
      });
      return { ok: true, count: input.permissions.length };
    }),

  /**
   * Toggle scope-admin on another user. Requires admin on
   * `team-permissions`, AND the caller themselves must be the scope owner
   * or an existing scope-admin — otherwise a regular admin could grant
   * themselves scope-admin. Lockout prevention: the server prevents
   * removing the scope-admin flag from the scope owner's own row.
   */
  setUserScopeAdmin: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        userId: z.number().int().positive(),
        isScopeAdmin: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        getSolarRecScope,
        isSolarRecScopeOwnerUser,
        setSolarRecUserScopeAdmin,
      } = await import("../db");
      const scope = await getSolarRecScope(ctx.scopeId);
      // Only scope owner / existing scope-admins may flip this flag.
      const callerIsOwner = await isSolarRecScopeOwnerUser(
        scope,
        permissionUserIdentity(ctx.user!)
      );
      if (!callerIsOwner && !ctx.user!.isScopeAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only scope owner or scope-admin may manage scope-admin flags",
        });
      }
      // Lockout prevention: never let the owner lose scope-admin bypass.
      const targetIsOwner = await isSolarRecScopeOwnerUser(scope, input.userId);
      if (targetIsOwner && input.isScopeAdmin === false) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot remove scope-admin from the scope owner",
        });
      }
      await setSolarRecUserScopeAdmin(input.userId, input.isScopeAdmin);
      return { ok: true };
    }),

  /**
   * List named presets for the current scope. Admin-only so the preset
   * manager stays tied to the Team & Permissions tab.
   */
  listPresets: requirePermission("team-permissions", "admin").query(
    async ({ ctx }) => {
      const { listSolarRecPermissionPresets } = await import("../db");
      return listSolarRecPermissionPresets(ctx.scopeId);
    }
  ),

  createPreset: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).nullish(),
        permissions: z.array(
          z.object({
            moduleKey: MODULE_KEY_ZOD,
            permission: PERMISSION_LEVEL_ZOD,
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { createSolarRecPermissionPreset } = await import("../db");
      const id = await createSolarRecPermissionPreset({
        scopeId: ctx.scopeId,
        name: input.name,
        description: input.description ?? null,
        permissions: input.permissions,
        createdBy: ctx.userId,
      });
      return { id };
    }),

  updatePreset: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).nullish(),
        permissions: z
          .array(
            z.object({
              moduleKey: MODULE_KEY_ZOD,
              permission: PERMISSION_LEVEL_ZOD,
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSolarRecPermissionPreset, updateSolarRecPermissionPreset } =
        await import("../db");
      const existing = await getSolarRecPermissionPreset(input.id);
      if (!existing || existing.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Preset not found",
        });
      }
      await updateSolarRecPermissionPreset({
        id: input.id,
        name: input.name,
        description:
          input.description === undefined
            ? undefined
            : (input.description ?? null),
        permissions: input.permissions,
      });
      return { ok: true };
    }),

  deletePreset: requirePermission("team-permissions", "admin")
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getSolarRecPermissionPreset, deleteSolarRecPermissionPreset } =
        await import("../db");
      const existing = await getSolarRecPermissionPreset(input.id);
      if (!existing || existing.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Preset not found",
        });
      }
      await deleteSolarRecPermissionPreset(input.id);
      return { ok: true };
    }),

  /**
   * Apply a preset to a user: overwrites their matrix rows to match the
   * preset's entries, including setting `none` on any module the preset
   * explicitly marks as `none`. Modules not mentioned in the preset are
   * left as `none` too (via replaceSolarRecUserModulePermissions, which
   * deletes rows not in the payload).
   */
  applyPreset: requirePermission("team-permissions", "admin")
    .input(
      z.object({
        presetId: z.string().min(1),
        userId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        getSolarRecPermissionPreset,
        replaceSolarRecUserModulePermissions,
      } = await import("../db");
      const preset = await getSolarRecPermissionPreset(input.presetId);
      if (!preset || preset.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Preset not found",
        });
      }
      const nonNone = preset.permissions.filter(
        entry => entry.permission !== "none"
      );
      await replaceSolarRecUserModulePermissions({
        userId: input.userId,
        scopeId: ctx.scopeId,
        permissions: nonNone,
      });
      return {
        ok: true,
        applied: nonNone.length,
        presetName: preset.name,
      };
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

// ---------------------------------------------------------------------------
// Task 5.4 — per-vendor meter-read routers (scope-aware, team-credential-backed).
//
// First vendor: Generac (PWRview). Credentials come from
// `solarRecTeamCredentials[provider='generac']` via the existing team-
// credentials admin UI in SolarRecSettings. The meter-reads page on
// solar-rec only exposes RUN operations (list systems, single-system
// snapshot) — credential lifecycle is managed in Settings, not here.
//
// Gating:
//   - reads     → requirePermission("meter-reads", "read")
//   - snapshots → requirePermission("meter-reads", "edit") (they run
//                 the vendor API and bill against the team's quota)
// ---------------------------------------------------------------------------

type GeneracTeamContext = {
  apiKey: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseGeneracTeamMetadata(
  raw: string | null
): GeneracTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const apiKey =
      typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0
        ? parsed.apiKey.trim()
        : null;
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the active Generac team credential for a scope. Returns the
 * first credential whose metadata parses cleanly; later we'll layer an
 * explicit activeConnectionId here when a scope has more than one.
 */
async function resolveGeneracTeamContext(
  scopeId: string
): Promise<GeneracTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("generac");
  for (const cred of credentials) {
    const parsed = parseGeneracTeamMetadata(cred.metadata);
    if (parsed) {
      return {
        ...parsed,
        baseUrl: parsed.baseUrl,
        credentialId: cred.id,
      };
    }
    const fallbackApiKey = cred.accessToken?.trim();
    if (fallbackApiKey) {
      return { apiKey: fallbackApiKey, baseUrl: null, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Generac team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const generacRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("generac");
    const active = credentials.find(
      cred =>
        parseGeneracTeamMetadata(cred.metadata) !== null ||
        (cred.accessToken?.trim().length ?? 0) > 0
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listSystems: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listSystems } = await import("../services/solar/generac");
      const context = await resolveGeneracTeamContext(ctx.scopeId);
      return listSystems({ apiKey: context.apiKey, baseUrl: context.baseUrl });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        systemId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSystemProductionSnapshot } =
        await import("../services/solar/generac");
      const context = await resolveGeneracTeamContext(ctx.scopeId);
      return getSystemProductionSnapshot(
        { apiKey: context.apiKey, baseUrl: context.baseUrl },
        input.systemId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 2/16 — Solis (SolisCloud). Same shape as Generac: team
// credential → { apiKey, apiSecret, baseUrl } → single-station reads.
// ---------------------------------------------------------------------------

type SolisTeamContext = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseSolisTeamMetadata(raw: string | null): SolisTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const apiKey =
      typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0
        ? parsed.apiKey.trim()
        : null;
    const apiSecret =
      typeof parsed?.apiSecret === "string" &&
      parsed.apiSecret.trim().length > 0
        ? parsed.apiSecret.trim()
        : null;
    if (!apiKey || !apiSecret) return null;
    return {
      apiKey,
      apiSecret,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveSolisTeamContext(
  scopeId: string
): Promise<SolisTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("solis");
  for (const cred of credentials) {
    const parsed = parseSolisTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Solis team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const solisRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("solis");
    const active = credentials.find(
      cred => parseSolisTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listStations: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listStations } = await import("../services/solar/solis");
      const context = await resolveSolisTeamContext(ctx.scopeId);
      return listStations({
        apiKey: context.apiKey,
        apiSecret: context.apiSecret,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        stationId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getStationProductionSnapshot } =
        await import("../services/solar/solis");
      const context = await resolveSolisTeamContext(ctx.scopeId);
      return getStationProductionSnapshot(
        {
          apiKey: context.apiKey,
          apiSecret: context.apiSecret,
          baseUrl: context.baseUrl,
        },
        input.stationId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 3/16 — GoodWe SEMS. Team credential stores
// `{account, password, baseUrl}`; single-station reads.
// ---------------------------------------------------------------------------

type GoodWeTeamContext = {
  account: string;
  password: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseGoodWeTeamMetadata(raw: string | null): GoodWeTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const account =
      typeof parsed?.account === "string" && parsed.account.trim().length > 0
        ? parsed.account.trim()
        : null;
    const password =
      typeof parsed?.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
    if (!account || !password) return null;
    return {
      account,
      password,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveGoodWeTeamContext(
  scopeId: string
): Promise<GoodWeTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("goodwe");
  for (const cred of credentials) {
    const parsed = parseGoodWeTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No GoodWe team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const goodweRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("goodwe");
    const active = credentials.find(
      cred => parseGoodWeTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listStations: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listStations } = await import("../services/solar/goodwe");
      const context = await resolveGoodWeTeamContext(ctx.scopeId);
      return listStations({
        account: context.account,
        password: context.password,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        stationId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getStationProductionSnapshot } =
        await import("../services/solar/goodwe");
      const context = await resolveGoodWeTeamContext(ctx.scopeId);
      return getStationProductionSnapshot(
        {
          account: context.account,
          password: context.password,
          baseUrl: context.baseUrl,
        },
        input.stationId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 4/16 — Hoymiles (S-Miles Cloud). Team credential
// stores `{username, password, baseUrl}`; single-station reads.
// ---------------------------------------------------------------------------

type HoymilesTeamContext = {
  username: string;
  password: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseHoymilesTeamMetadata(
  raw: string | null
): HoymilesTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const username =
      typeof parsed?.username === "string" && parsed.username.trim().length > 0
        ? parsed.username.trim()
        : null;
    const password =
      typeof parsed?.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
    if (!username || !password) return null;
    return {
      username,
      password,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveHoymilesTeamContext(
  scopeId: string
): Promise<HoymilesTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("hoymiles");
  for (const cred of credentials) {
    const parsed = parseHoymilesTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Hoymiles team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const hoymilesRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("hoymiles");
    const active = credentials.find(
      cred => parseHoymilesTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listStations: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listStations } = await import("../services/solar/hoymiles");
      const context = await resolveHoymilesTeamContext(ctx.scopeId);
      return listStations({
        username: context.username,
        password: context.password,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        stationId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getStationProductionSnapshot } =
        await import("../services/solar/hoymiles");
      const context = await resolveHoymilesTeamContext(ctx.scopeId);
      return getStationProductionSnapshot(
        {
          username: context.username,
          password: context.password,
          baseUrl: context.baseUrl,
        },
        input.stationId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 5/16 — Locus Energy. Team credential stores
// `{clientId, clientSecret, partnerId, baseUrl}`; single-site reads.
// ---------------------------------------------------------------------------

type LocusTeamContext = {
  clientId: string;
  clientSecret: string;
  partnerId: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseLocusTeamMetadata(raw: string | null): LocusTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const clientId =
      typeof parsed?.clientId === "string" && parsed.clientId.trim().length > 0
        ? parsed.clientId.trim()
        : null;
    const clientSecret =
      typeof parsed?.clientSecret === "string" &&
      parsed.clientSecret.trim().length > 0
        ? parsed.clientSecret.trim()
        : null;
    const partnerId =
      typeof parsed?.partnerId === "string" &&
      parsed.partnerId.trim().length > 0
        ? parsed.partnerId.trim()
        : null;
    if (!clientId || !clientSecret || !partnerId) return null;
    return {
      clientId,
      clientSecret,
      partnerId,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveLocusTeamContext(
  scopeId: string
): Promise<LocusTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("locus");
  for (const cred of credentials) {
    const parsed = parseLocusTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Locus Energy team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const locusRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("locus");
    const active = credentials.find(
      cred => parseLocusTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listSites: requirePermission("meter-reads", "read").query(async ({ ctx }) => {
    const { listSites } = await import("../services/solar/locus");
    const context = await resolveLocusTeamContext(ctx.scopeId);
    return listSites({
      clientId: context.clientId,
      clientSecret: context.clientSecret,
      partnerId: context.partnerId,
      baseUrl: context.baseUrl,
    });
  }),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        siteId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSiteProductionSnapshot } =
        await import("../services/solar/locus");
      const context = await resolveLocusTeamContext(ctx.scopeId);
      return getSiteProductionSnapshot(
        {
          clientId: context.clientId,
          clientSecret: context.clientSecret,
          partnerId: context.partnerId,
          baseUrl: context.baseUrl,
        },
        input.siteId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 6/16 — APsystems (EMA). Team credential stores
// `{appId, appSecret, baseUrl}`; single-system reads.
// ---------------------------------------------------------------------------

type APsystemsTeamContext = {
  appId: string;
  appSecret: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseAPsystemsTeamMetadata(
  raw: string | null
): APsystemsTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const appId =
      typeof parsed?.appId === "string" && parsed.appId.trim().length > 0
        ? parsed.appId.trim()
        : null;
    const appSecret =
      typeof parsed?.appSecret === "string" &&
      parsed.appSecret.trim().length > 0
        ? parsed.appSecret.trim()
        : null;
    if (!appId || !appSecret) return null;
    return {
      appId,
      appSecret,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveAPsystemsTeamContext(
  scopeId: string
): Promise<APsystemsTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("apsystems");
  for (const cred of credentials) {
    const parsed = parseAPsystemsTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No APsystems team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const apsystemsRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("apsystems");
    const active = credentials.find(
      cred => parseAPsystemsTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listSystems: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listSystems } = await import("../services/solar/apsystems");
      const context = await resolveAPsystemsTeamContext(ctx.scopeId);
      return listSystems({
        appId: context.appId,
        appSecret: context.appSecret,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        systemId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSystemProductionSnapshot } =
        await import("../services/solar/apsystems");
      const context = await resolveAPsystemsTeamContext(ctx.scopeId);
      return getSystemProductionSnapshot(
        {
          appId: context.appId,
          appSecret: context.appSecret,
          baseUrl: context.baseUrl,
        },
        input.systemId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 7/16 — SolarLog (device-local). Team credential stores
// `{baseUrl|deviceUrl, password}`; lists devices on the connected
// SolarLog appliance and runs single-device snapshots.
// ---------------------------------------------------------------------------

type SolarLogTeamContext = {
  baseUrl: string;
  password: string | null;
  credentialId: string;
};

function parseSolarLogTeamMetadata(
  raw: string | null
): SolarLogTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // The Settings UI stores either `baseUrl` or the legacy alias
    // `deviceUrl`; the monitoring batch adapter accepts both, so we
    // do too.
    const candidate =
      typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
        ? parsed.baseUrl.trim()
        : typeof parsed?.deviceUrl === "string" &&
            parsed.deviceUrl.trim().length > 0
          ? parsed.deviceUrl.trim()
          : null;
    if (!candidate) return null;
    const password =
      typeof parsed?.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
    return { baseUrl: candidate, password, credentialId: "" };
  } catch {
    return null;
  }
}

async function resolveSolarLogTeamContext(
  scopeId: string
): Promise<SolarLogTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("solarlog");
  for (const cred of credentials) {
    const parsed = parseSolarLogTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No SolarLog team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const solarlogRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("solarlog");
    const active = credentials.find(
      cred => parseSolarLogTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listDevices: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listDevices } = await import("../services/solar/solarLog");
      const context = await resolveSolarLogTeamContext(ctx.scopeId);
      return listDevices({
        baseUrl: context.baseUrl,
        password: context.password,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        deviceId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getDeviceProductionSnapshot } =
        await import("../services/solar/solarLog");
      const context = await resolveSolarLogTeamContext(ctx.scopeId);
      return getDeviceProductionSnapshot(
        { baseUrl: context.baseUrl, password: context.password },
        input.deviceId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 8/16 — Growatt (OpenAPI). Team credential stores
// `{username, password, baseUrl}`; lists plants and runs single-plant
// snapshots.
// ---------------------------------------------------------------------------

type GrowattTeamContext = {
  username: string;
  password: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseGrowattTeamMetadata(
  raw: string | null
): GrowattTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const username =
      typeof parsed?.username === "string" && parsed.username.trim().length > 0
        ? parsed.username.trim()
        : null;
    const password =
      typeof parsed?.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
    if (!username || !password) return null;
    return {
      username,
      password,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveGrowattTeamContext(
  scopeId: string
): Promise<GrowattTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("growatt");
  for (const cred of credentials) {
    const parsed = parseGrowattTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Growatt team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const growattRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("growatt");
    const active = credentials.find(
      cred => parseGrowattTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listPlants: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listPlants } = await import("../services/solar/growatt");
      const context = await resolveGrowattTeamContext(ctx.scopeId);
      return listPlants({
        username: context.username,
        password: context.password,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        plantId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getPlantProductionSnapshot } =
        await import("../services/solar/growatt");
      const context = await resolveGrowattTeamContext(ctx.scopeId);
      return getPlantProductionSnapshot(
        {
          username: context.username,
          password: context.password,
          baseUrl: context.baseUrl,
        },
        input.plantId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 9/16 — EKM (push API). Team credential stores
// `{apiKey, baseUrl}`; single-meter snapshots only (vendor has no
// list-meters endpoint, so the user supplies the meter number).
// ---------------------------------------------------------------------------

type EkmTeamContext = {
  apiKey: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseEkmTeamMetadata(raw: string | null): EkmTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const apiKey =
      typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0
        ? parsed.apiKey.trim()
        : null;
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveEkmTeamContext(scopeId: string): Promise<EkmTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("ekm");
  for (const cred of credentials) {
    const parsed = parseEkmTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No EKM team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const ekmRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("ekm");
    const active = credentials.find(
      cred => parseEkmTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        meterNumber: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getMeterProductionSnapshot } =
        await import("../services/solar/ekm");
      const context = await resolveEkmTeamContext(ctx.scopeId);
      return getMeterProductionSnapshot(
        { apiKey: context.apiKey, baseUrl: context.baseUrl },
        input.meterNumber.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 10/16 — Fronius (Solar.web). Team credential stores
// `{accessKeyId, accessKeyValue, baseUrl}`; lists PV systems and runs
// single-system snapshots.
// ---------------------------------------------------------------------------

type FroniusTeamContext = {
  accessKeyId: string;
  accessKeyValue: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseFroniusTeamMetadata(
  raw: string | null
): FroniusTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const accessKeyId =
      typeof parsed?.accessKeyId === "string" &&
      parsed.accessKeyId.trim().length > 0
        ? parsed.accessKeyId.trim()
        : null;
    const accessKeyValue =
      typeof parsed?.accessKeyValue === "string" &&
      parsed.accessKeyValue.trim().length > 0
        ? parsed.accessKeyValue.trim()
        : null;
    if (!accessKeyId || !accessKeyValue) return null;
    return {
      accessKeyId,
      accessKeyValue,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveFroniusTeamContext(
  scopeId: string
): Promise<FroniusTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("fronius");
  for (const cred of credentials) {
    const parsed = parseFroniusTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Fronius team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const froniusRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("fronius");
    const active = credentials.find(
      cred => parseFroniusTeamMetadata(cred.metadata) !== null
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listPvSystems: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listPvSystems } = await import("../services/solar/fronius");
      const context = await resolveFroniusTeamContext(ctx.scopeId);
      return listPvSystems({
        accessKeyId: context.accessKeyId,
        accessKeyValue: context.accessKeyValue,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        pvSystemId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getPvSystemProductionSnapshot } =
        await import("../services/solar/fronius");
      const context = await resolveFroniusTeamContext(ctx.scopeId);
      return getPvSystemProductionSnapshot(
        {
          accessKeyId: context.accessKeyId,
          accessKeyValue: context.accessKeyValue,
          baseUrl: context.baseUrl,
        },
        input.pvSystemId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 11/16 — EnnexOS (SMA Sandbox/Cloud). Team credential
// stores `{accessToken, baseUrl}`; lists plants and runs single-plant
// snapshots.
// ---------------------------------------------------------------------------

type EnnexOsTeamContext = {
  accessToken: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseEnnexOsTeamMetadata(
  raw: string | null
): EnnexOsTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const accessToken =
      typeof parsed?.accessToken === "string" &&
      parsed.accessToken.trim().length > 0
        ? parsed.accessToken.trim()
        : null;
    if (!accessToken) return null;
    return {
      accessToken,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

async function resolveEnnexOsTeamContext(
  scopeId: string
): Promise<EnnexOsTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("ennexos");
  for (const cred of credentials) {
    const parsed = parseEnnexOsTeamMetadata(cred.metadata);
    if (parsed) {
      return { ...parsed, credentialId: cred.id };
    }
    // Fall back to top-level accessToken (the credential row's column,
    // not metadata) so admins who pasted the token via the generic
    // "accessToken" field still authenticate.
    const fallback = cred.accessToken?.trim();
    if (fallback) {
      return { accessToken: fallback, baseUrl: null, credentialId: cred.id };
    }
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No EnnexOS team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const ennexOsRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("ennexos");
    const active = credentials.find(
      cred =>
        parseEnnexOsTeamMetadata(cred.metadata) !== null ||
        (cred.accessToken?.trim().length ?? 0) > 0
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
    };
  }),

  listPlants: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listPlants } = await import("../services/solar/ennexos");
      const context = await resolveEnnexOsTeamContext(ctx.scopeId);
      return listPlants({
        accessToken: context.accessToken,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        plantId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getPlantProductionSnapshot } =
        await import("../services/solar/ennexos");
      const context = await resolveEnnexOsTeamContext(ctx.scopeId);
      return getPlantProductionSnapshot(
        { accessToken: context.accessToken, baseUrl: context.baseUrl },
        input.plantId.trim(),
        input.anchorDate
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 12/16 — Enphase V4 (OAuth refresh). Team credential
// stores `{apiKey, clientId, clientSecret, baseUrl}` in metadata + the
// row's accessToken / refreshToken / expiresAt columns. Differs from
// every other vendor migrated so far because the access token expires
// and must be refreshed inline before each call. Refreshed tokens are
// persisted back to the credential row so the next request gets the
// fresh token without re-running the refresh.
// ---------------------------------------------------------------------------

type EnphaseV4TeamMetadata = {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string | null;
};

type EnphaseV4TeamContext = {
  accessToken: string;
  apiKey: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseEnphaseV4TeamMetadata(
  raw: string | null
): EnphaseV4TeamMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const apiKey =
      typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0
        ? parsed.apiKey.trim()
        : null;
    const clientId =
      typeof parsed?.clientId === "string" && parsed.clientId.trim().length > 0
        ? parsed.clientId.trim()
        : null;
    const clientSecret =
      typeof parsed?.clientSecret === "string" &&
      parsed.clientSecret.trim().length > 0
        ? parsed.clientSecret.trim()
        : null;
    if (!apiKey || !clientId || !clientSecret) return null;
    return {
      apiKey,
      clientId,
      clientSecret,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
    };
  } catch {
    return null;
  }
}

const ENPHASE_V4_REFRESH_LEAD_TIME_MS = 5 * 60 * 1000;

async function persistRefreshedEnphaseV4Tokens(
  credentialId: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date }
): Promise<void> {
  const { getDb, withDbRetry } = await import("../db");
  const db = await getDb();
  if (!db) return;
  const { eq } = await import("drizzle-orm");
  const { solarRecTeamCredentials } = await import("../../drizzle/schema");
  await withDbRetry("update enphase v4 team credential tokens", async () => {
    await db
      .update(solarRecTeamCredentials)
      .set({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })
      .where(eq(solarRecTeamCredentials.id, credentialId));
  });
}

async function resolveEnphaseV4TeamContext(
  scopeId: string
): Promise<EnphaseV4TeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("enphase-v4");
  for (const cred of credentials) {
    const meta = parseEnphaseV4TeamMetadata(cred.metadata);
    const accessToken = cred.accessToken?.trim();
    if (!meta || !accessToken) continue;

    const now = Date.now();
    const expiresAt = cred.expiresAt
      ? new Date(cred.expiresAt).getTime()
      : null;
    const needsRefresh =
      !expiresAt || expiresAt - now < ENPHASE_V4_REFRESH_LEAD_TIME_MS;

    if (!needsRefresh) {
      return {
        accessToken,
        apiKey: meta.apiKey,
        baseUrl: meta.baseUrl,
        credentialId: cred.id,
      };
    }

    if (!cred.refreshToken) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Enphase V4 access token has expired and no refresh token is stored. An admin must re-connect the credential in Solar REC Settings.",
      });
    }

    const { refreshEnphaseV4AccessToken } =
      await import("../services/solar/enphaseV4");
    const refreshed = await refreshEnphaseV4AccessToken({
      clientId: meta.clientId,
      clientSecret: meta.clientSecret,
      refreshToken: cred.refreshToken,
    });
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await persistRefreshedEnphaseV4Tokens(cred.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || cred.refreshToken,
      expiresAt: newExpiresAt,
    });

    return {
      accessToken: refreshed.access_token,
      apiKey: meta.apiKey,
      baseUrl: meta.baseUrl,
      credentialId: cred.id,
    };
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Enphase V4 team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

const enphaseV4Router = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials =
      await getSolarRecTeamCredentialsByProvider("enphase-v4");
    const active = credentials.find(
      cred =>
        parseEnphaseV4TeamMetadata(cred.metadata) !== null &&
        (cred.accessToken?.trim().length ?? 0) > 0
    );
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
      hasRefreshToken: !!active?.refreshToken,
      expiresAt: active?.expiresAt
        ? new Date(active.expiresAt).toISOString()
        : null,
    };
  }),

  listSystems: requirePermission("meter-reads", "read").query(
    async ({ ctx }) => {
      const { listSystems } = await import("../services/solar/enphaseV4");
      const context = await resolveEnphaseV4TeamContext(ctx.scopeId);
      return listSystems({
        accessToken: context.accessToken,
        apiKey: context.apiKey,
        baseUrl: context.baseUrl,
      });
    }
  ),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        systemId: z.string().min(1),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        systemName: z.string().nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSystemProductionSnapshot } =
        await import("../services/solar/enphaseV4");
      const context = await resolveEnphaseV4TeamContext(ctx.scopeId);
      return getSystemProductionSnapshot(
        {
          accessToken: context.accessToken,
          apiKey: context.apiKey,
          baseUrl: context.baseUrl,
        },
        input.systemId.trim(),
        input.anchorDate,
        input.systemName ?? null
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 13/16 — SolarEdge. Team credential stores
// `{apiKey, baseUrl}`; in addition to the standard production snapshot,
// SolarEdge exposes per-site meter and inverter snapshots that the
// legacy meter-reads page uses when reconciling fleet data. Three
// snapshot procedures here mirror that fleet-data UX.
// ---------------------------------------------------------------------------

type SolarEdgeTeamContext = {
  apiKey: string;
  baseUrl: string | null;
  credentialId: string;
};

function parseSolarEdgeTeamMetadata(
  raw: string | null
): SolarEdgeTeamContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const sanitized =
      typeof parsed?.apiKey === "string"
        ? solarEdgeSanitizeApiKey(parsed.apiKey)
        : "";
    if (!sanitized) return null;
    return {
      apiKey: sanitized,
      baseUrl:
        typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl.trim()
          : null,
      credentialId: "",
    };
  } catch {
    return null;
  }
}

type SolarEdgeCredentialRow = {
  id: string;
  connectionName: string | null;
  context: SolarEdgeTeamContext;
};

async function loadSolarEdgeCredentialRows(): Promise<
  SolarEdgeCredentialRow[]
> {
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("solaredge");
  const out: SolarEdgeCredentialRow[] = [];
  for (const cred of credentials) {
    const parsed = parseSolarEdgeTeamMetadata(cred.metadata);
    if (parsed) {
      out.push({
        id: cred.id,
        connectionName: cred.connectionName ?? null,
        context: { ...parsed, credentialId: cred.id },
      });
      continue;
    }
    const fallbackKey = solarEdgeSanitizeApiKey(cred.accessToken ?? "");
    if (fallbackKey) {
      out.push({
        id: cred.id,
        connectionName: cred.connectionName ?? null,
        context: {
          apiKey: fallbackKey,
          baseUrl: null,
          credentialId: cred.id,
        },
      });
    }
  }
  return out;
}

async function resolveSolarEdgeTeamContext(
  scopeId: string,
  connectionId?: string | null
): Promise<SolarEdgeTeamContext> {
  void scopeId;
  const rows = await loadSolarEdgeCredentialRows();
  if (connectionId) {
    const match = rows.find(row => row.id === connectionId);
    if (match) return match.context;
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Selected SolarEdge connection not found.",
    });
  }
  if (rows.length > 0) return rows[0].context;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No SolarEdge team credential found. An admin must add one in Solar REC Settings → Credentials.",
  });
}

type SolarEdgeBulkProductionRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  siteName: string | null;
  lifetimeKwh: number | null;
  hourlyProductionKwh: number | null;
  monthlyProductionKwh: number | null;
  mtdProductionKwh: number | null;
  previousCalendarMonthProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  weeklyProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string | null;
  error: string | null;
};

type SolarEdgeBulkMeterRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  meterCount: number | null;
  productionMeterCount: number | null;
  consumptionMeterCount: number | null;
  meterTypes: string[];
  error: string | null;
};

type SolarEdgeBulkInverterRow = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  matchedConnectionId: string | null;
  matchedConnectionName: string | null;
  checkedConnections: number;
  foundInConnections: number;
  inverterCount: number | null;
  invertersWithTelemetry: number | null;
  inverterFailures: number | null;
  inverterLatestPowerKw: number | null;
  inverterLatestEnergyKwh: number | null;
  firstTelemetryAt: string | null;
  lastTelemetryAt: string | null;
  error: string | null;
};

function selectSolarEdgeContexts(
  rows: SolarEdgeCredentialRow[],
  scope: "active" | "all",
  connectionId?: string | null
): SolarEdgeCredentialRow[] {
  if (scope === "all") return rows;
  if (connectionId) {
    const match = rows.find(row => row.id === connectionId);
    if (match) return [match];
  }
  return rows.length > 0 ? [rows[0]] : [];
}

async function runSolarEdgeBulk<
  T extends { status: "Found" | "Not Found" | "Error"; error: string | null },
>(
  rows: SolarEdgeCredentialRow[],
  siteIds: string[],
  scope: "active" | "all",
  connectionId: string | null | undefined,
  fetchOne: (row: SolarEdgeCredentialRow, siteId: string) => Promise<T>,
  toBulk: (
    siteId: string,
    matched: SolarEdgeCredentialRow | null,
    payload: T | null,
    err: string | null,
    checkedConnections: number,
    foundInConnections: number
  ) => unknown
): Promise<{
  total: number;
  found: number;
  notFound: number;
  errored: number;
  rows: unknown[];
}> {
  const candidates = selectSolarEdgeContexts(rows, scope, connectionId);
  if (candidates.length === 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No SolarEdge team credential available.",
    });
  }
  const { mapWithConcurrency } = await import("../services/core/concurrency");
  const out: unknown[] = [];
  let found = 0;
  let notFound = 0;
  let errored = 0;
  const results = await mapWithConcurrency(
    siteIds,
    4,
    async (siteId: string) => {
      let matched: SolarEdgeCredentialRow | null = null;
      let lastError: string | null = null;
      let lastPayload: T | null = null;
      let foundIn = 0;
      let checked = 0;
      for (const row of candidates) {
        checked += 1;
        try {
          const payload = await fetchOne(row, siteId);
          lastPayload = payload;
          if (payload.status === "Found") {
            matched = row;
            foundIn += 1;
            if (scope === "active") break;
          } else if (payload.status === "Error") {
            lastError = payload.error;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      const finalStatus: "Found" | "Not Found" | "Error" =
        matched !== null ? "Found" : lastError ? "Error" : "Not Found";
      return toBulk(siteId, matched, lastPayload, lastError, checked, foundIn);
    }
  );
  for (const row of results) {
    out.push(row);
    const status = (row as { status: string }).status;
    if (status === "Found") found += 1;
    else if (status === "Not Found") notFound += 1;
    else errored += 1;
  }
  return { total: siteIds.length, found, notFound, errored, rows: out };
}

const SOLAREDGE_BULK_MAX = 200;
const solaredgeBulkInputBase = z.object({
  siteIds: z.array(z.string().min(1)).min(1).max(SOLAREDGE_BULK_MAX),
  connectionId: z.string().optional(),
  connectionScope: z.enum(["active", "all"]).optional(),
});

const solaredgeRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const rows = await loadSolarEdgeCredentialRows();
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials = await getSolarRecTeamCredentialsByProvider("solaredge");
    return {
      connected: rows.length > 0,
      connectionCount: credentials.length,
      activeConnectionId: rows[0]?.id ?? null,
      connections: rows.map(row => ({
        id: row.id,
        name: row.connectionName,
        baseUrl: row.context.baseUrl,
      })),
    };
  }),

  // Returns a fingerprint of every stored SolarEdge credential and the
  // outcome of a `/sites/list` probe — surfaces the SolarEdge response
  // body verbatim so an admin can tell "valid key, account API access
  // not enabled" apart from "we corrupted the key in storage".
  debugCredential: requirePermission("meter-reads", "edit")
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      void ctx;
      const rows = await loadSolarEdgeCredentialRows();
      const target = input?.connectionId
        ? rows.find(r => r.id === input.connectionId)
        : rows[0];
      if (!target) {
        return {
          ok: false as const,
          reason: "no-credential" as const,
          message: "No SolarEdge credential is registered for this scope.",
          connections: rows.length,
        };
      }
      const apiKey = target.context.apiKey;
      const codepoints = Array.from(apiKey).map(c => c.charCodeAt(0));
      const hasNonAscii = codepoints.some(c => c > 0x7e || c < 0x20);
      const fingerprint = {
        connectionId: target.id,
        connectionName: target.connectionName,
        apiKeyLength: apiKey.length,
        apiKeyPreview:
          apiKey.length <= 8
            ? "***"
            : `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
        apiKeyHasNonAscii: hasNonAscii,
        baseUrlOverride: target.context.baseUrl,
      };
      const { listSites, SOLAR_EDGE_DEFAULT_BASE_URL } =
        await import("../services/solar/solarEdge");
      try {
        const probe = await listSites({
          apiKey: target.context.apiKey,
          baseUrl: target.context.baseUrl,
        });
        return {
          ok: true as const,
          fingerprint,
          effectiveBaseUrl:
            target.context.baseUrl ?? SOLAR_EDGE_DEFAULT_BASE_URL,
          siteCount: probe.sites.length,
          sample: probe.sites.slice(0, 3).map(s => ({
            siteId: s.siteId,
            siteName: s.siteName,
          })),
        };
      } catch (err) {
        return {
          ok: false as const,
          reason: "probe-failed" as const,
          fingerprint,
          effectiveBaseUrl:
            target.context.baseUrl ?? SOLAR_EDGE_DEFAULT_BASE_URL,
          message: err instanceof Error ? err.message : "Unknown probe error.",
        };
      }
    }),

  listSites: requirePermission("meter-reads", "read")
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { listSites } = await import("../services/solar/solarEdge");
      const context = await resolveSolarEdgeTeamContext(
        ctx.scopeId,
        input?.connectionId
      );
      return listSites({ apiKey: context.apiKey, baseUrl: context.baseUrl });
    }),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        siteId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        connectionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSiteProductionSnapshot } =
        await import("../services/solar/solarEdge");
      const context = await resolveSolarEdgeTeamContext(
        ctx.scopeId,
        input.connectionId
      );
      return getSiteProductionSnapshot(
        { apiKey: context.apiKey, baseUrl: context.baseUrl },
        input.siteId.trim(),
        input.anchorDate
      );
    }),

  getMeterSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        siteId: z.string().min(1),
        connectionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSiteMeterSnapshot } =
        await import("../services/solar/solarEdge");
      const context = await resolveSolarEdgeTeamContext(
        ctx.scopeId,
        input.connectionId
      );
      return getSiteMeterSnapshot(
        { apiKey: context.apiKey, baseUrl: context.baseUrl },
        input.siteId.trim()
      );
    }),

  getInverterSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        siteId: z.string().min(1),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        connectionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getSiteInverterSnapshot } =
        await import("../services/solar/solarEdge");
      const context = await resolveSolarEdgeTeamContext(
        ctx.scopeId,
        input.connectionId
      );
      return getSiteInverterSnapshot(
        { apiKey: context.apiKey, baseUrl: context.baseUrl },
        input.siteId.trim(),
        input.anchorDate
      );
    }),

  getProductionSnapshots: requirePermission("meter-reads", "edit")
    .input(
      solaredgeBulkInputBase.extend({
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { getSiteProductionSnapshot } =
        await import("../services/solar/solarEdge");
      const rows = await loadSolarEdgeCredentialRows();
      const scope = input.connectionScope ?? "active";
      return runSolarEdgeBulk(
        rows,
        input.siteIds.map(s => s.trim()).filter(Boolean),
        scope,
        input.connectionId,
        async (row, siteId) =>
          getSiteProductionSnapshot(
            { apiKey: row.context.apiKey, baseUrl: row.context.baseUrl },
            siteId,
            input.anchorDate
          ),
        (
          siteId,
          matched,
          payload,
          err,
          checkedConnections,
          foundInConnections
        ): SolarEdgeBulkProductionRow => ({
          siteId,
          status: matched !== null ? "Found" : err ? "Error" : "Not Found",
          matchedConnectionId: matched?.id ?? null,
          matchedConnectionName: matched?.connectionName ?? null,
          checkedConnections,
          foundInConnections,
          siteName: payload?.name ?? null,
          lifetimeKwh: payload?.lifetimeKwh ?? null,
          hourlyProductionKwh: payload?.hourlyProductionKwh ?? null,
          monthlyProductionKwh: payload?.monthlyProductionKwh ?? null,
          mtdProductionKwh: payload?.mtdProductionKwh ?? null,
          previousCalendarMonthProductionKwh:
            payload?.previousCalendarMonthProductionKwh ?? null,
          last12MonthsProductionKwh: payload?.last12MonthsProductionKwh ?? null,
          weeklyProductionKwh: payload?.weeklyProductionKwh ?? null,
          dailyProductionKwh: payload?.dailyProductionKwh ?? null,
          anchorDate: payload?.anchorDate ?? input.anchorDate ?? null,
          error: err,
        })
      );
    }),

  getMeterSnapshots: requirePermission("meter-reads", "edit")
    .input(solaredgeBulkInputBase)
    .mutation(async ({ input }) => {
      const { getSiteMeterSnapshot } =
        await import("../services/solar/solarEdge");
      const rows = await loadSolarEdgeCredentialRows();
      const scope = input.connectionScope ?? "active";
      return runSolarEdgeBulk(
        rows,
        input.siteIds.map(s => s.trim()).filter(Boolean),
        scope,
        input.connectionId,
        async (row, siteId) =>
          getSiteMeterSnapshot(
            { apiKey: row.context.apiKey, baseUrl: row.context.baseUrl },
            siteId
          ),
        (
          siteId,
          matched,
          payload,
          err,
          checkedConnections,
          foundInConnections
        ): SolarEdgeBulkMeterRow => ({
          siteId,
          status: matched !== null ? "Found" : err ? "Error" : "Not Found",
          matchedConnectionId: matched?.id ?? null,
          matchedConnectionName: matched?.connectionName ?? null,
          checkedConnections,
          foundInConnections,
          meterCount: payload?.meterCount ?? null,
          productionMeterCount: payload?.productionMeters ?? null,
          consumptionMeterCount: payload?.consumptionMeters ?? null,
          meterTypes: payload?.meterTypes ?? [],
          error: err,
        })
      );
    }),

  getInverterSnapshots: requirePermission("meter-reads", "edit")
    .input(
      solaredgeBulkInputBase.extend({
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { getSiteInverterSnapshot } =
        await import("../services/solar/solarEdge");
      const rows = await loadSolarEdgeCredentialRows();
      const scope = input.connectionScope ?? "active";
      return runSolarEdgeBulk(
        rows,
        input.siteIds.map(s => s.trim()).filter(Boolean),
        scope,
        input.connectionId,
        async (row, siteId) =>
          getSiteInverterSnapshot(
            { apiKey: row.context.apiKey, baseUrl: row.context.baseUrl },
            siteId,
            input.anchorDate
          ),
        (
          siteId,
          matched,
          payload,
          err,
          checkedConnections,
          foundInConnections
        ): SolarEdgeBulkInverterRow => ({
          siteId,
          status: matched !== null ? "Found" : err ? "Error" : "Not Found",
          matchedConnectionId: matched?.id ?? null,
          matchedConnectionName: matched?.connectionName ?? null,
          checkedConnections,
          foundInConnections,
          inverterCount: payload?.inverterCount ?? null,
          invertersWithTelemetry: payload?.invertersWithTelemetry ?? null,
          inverterFailures: payload?.inverterFailures ?? null,
          inverterLatestPowerKw: payload?.inverterLatestPowerKw ?? null,
          inverterLatestEnergyKwh: payload?.inverterLatestEnergyKwh ?? null,
          firstTelemetryAt: payload?.firstTelemetryAt ?? null,
          lastTelemetryAt: payload?.lastTelemetryAt ?? null,
          error: err,
        })
      );
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 14/16 — Tesla Powerhub. Different shape from every
// other vendor: production reads are best handled as a background bulk job,
// while connection probes and single-site snapshots use lightweight/direct
// paths to avoid foreground proxy timeouts.
//
// Team credential row stores:
//   - accessToken column → clientSecret
//   - metadata           → {clientId, groupId, tokenUrl, apiBaseUrl,
//                          portalBaseUrl, signal?}
// ---------------------------------------------------------------------------

type TeslaPowerhubTeamMetadata = {
  clientId: string;
  groupId: string | null;
  tokenUrl: string | null;
  apiBaseUrl: string | null;
  portalBaseUrl: string | null;
  endpointUrl: string | null;
  signal: string | null;
};

type TeslaPowerhubTeamContext = {
  apiContext: {
    clientId: string;
    clientSecret: string;
    tokenUrl: string | null;
    apiBaseUrl: string | null;
    portalBaseUrl: string | null;
  };
  groupId: string | null;
  endpointUrl: string | null;
  signal: string | null;
  credentialId: string;
};

function normalizeTeslaPowerhubGroupId(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  const match = trimmed.match(/\/group\/([a-zA-Z0-9-]+)/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseTeslaPowerhubTeamMetadata(
  raw: string | null
): TeslaPowerhubTeamMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const clientId =
      typeof parsed?.clientId === "string" && parsed.clientId.trim().length > 0
        ? parsed.clientId.trim()
        : null;
    const groupId =
      typeof parsed?.groupId === "string" && parsed.groupId.trim().length > 0
        ? parsed.groupId.trim()
        : null;
    if (!clientId) return null;
    return {
      clientId,
      groupId,
      tokenUrl:
        typeof parsed?.tokenUrl === "string" &&
        parsed.tokenUrl.trim().length > 0
          ? parsed.tokenUrl.trim()
          : null,
      apiBaseUrl:
        typeof parsed?.apiBaseUrl === "string" &&
        parsed.apiBaseUrl.trim().length > 0
          ? parsed.apiBaseUrl.trim()
          : null,
      portalBaseUrl:
        typeof parsed?.portalBaseUrl === "string" &&
        parsed.portalBaseUrl.trim().length > 0
          ? parsed.portalBaseUrl.trim()
          : null,
      endpointUrl:
        typeof parsed?.endpointUrl === "string" &&
        parsed.endpointUrl.trim().length > 0
          ? parsed.endpointUrl.trim()
          : null,
      signal:
        typeof parsed?.signal === "string" && parsed.signal.trim().length > 0
          ? parsed.signal.trim()
          : null,
    };
  } catch {
    return null;
  }
}

async function resolveTeslaPowerhubTeamContext(
  scopeId: string
): Promise<TeslaPowerhubTeamContext> {
  void scopeId;
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials =
    await getSolarRecTeamCredentialsByProvider("tesla-powerhub");
  for (const cred of credentials) {
    const meta = parseTeslaPowerhubTeamMetadata(cred.metadata);
    const clientSecret = cred.accessToken?.trim();
    if (!meta || !clientSecret) continue;
    return {
      apiContext: {
        clientId: meta.clientId,
        clientSecret,
        tokenUrl: meta.tokenUrl,
        apiBaseUrl: meta.apiBaseUrl,
        portalBaseUrl: meta.portalBaseUrl,
      },
      groupId: meta.groupId,
      endpointUrl: meta.endpointUrl,
      signal: meta.signal,
      credentialId: cred.id,
    };
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Tesla Powerhub team credential found. An admin must add clientId + clientSecret in Solar REC Settings → Credentials.",
  });
}

const teslaPowerhubRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const { getSolarRecTeamCredentialsByProvider } = await import("../db");
    const credentials =
      await getSolarRecTeamCredentialsByProvider("tesla-powerhub");
    const active = credentials.find(
      cred =>
        parseTeslaPowerhubTeamMetadata(cred.metadata) !== null &&
        (cred.accessToken?.trim().length ?? 0) > 0
    );
    const meta = active
      ? parseTeslaPowerhubTeamMetadata(active.metadata)
      : null;
    return {
      connected: !!active,
      connectionCount: credentials.length,
      activeConnectionId: active?.id ?? null,
      groupId: meta?.groupId ?? null,
      endpointUrl: meta?.endpointUrl ?? null,
      signal: meta?.signal ?? null,
    };
  }),

  getServerEgressIpv4: requirePermission("meter-reads", "read")
    .input(z.object({ forceRefresh: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const { fetchTeslaPowerhubServerEgressIpv4 } =
        await import("../services/solar/teslaPowerhubEgress");
      return fetchTeslaPowerhubServerEgressIpv4({
        forceRefresh: Boolean(input?.forceRefresh),
      });
    }),

  refreshServerEgressIpv4: requirePermission("meter-reads", "read").mutation(
    async () => {
      const { fetchTeslaPowerhubServerEgressIpv4 } =
        await import("../services/solar/teslaPowerhubEgress");
      return fetchTeslaPowerhubServerEgressIpv4({ forceRefresh: true });
    }
  ),

  listSites: requirePermission("meter-reads", "read").query(async ({ ctx }) => {
    const { listTeslaPowerhubSites } =
      await import("../services/solar/teslaPowerhub");
    const team = await resolveTeslaPowerhubTeamContext(ctx.scopeId);
    const result = await listTeslaPowerhubSites(team.apiContext, {
      groupId: team.groupId,
      endpointUrl: team.endpointUrl,
    });
    return {
      sites: result.sites.map(site => ({
        siteId: site.siteId,
        siteName: site.siteName ?? site.siteExternalId ?? site.siteId,
        siteExternalId: site.siteExternalId,
      })),
    };
  }),

  startGroupProductionMetricsJob: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        groupId: z.string().min(1).optional(),
        endpointUrl: z.string().optional(),
        signal: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { startTeslaPowerhubProductionJob } =
        await import("../services/solar/teslaPowerhubProductionJobs");
      const team = await resolveTeslaPowerhubTeamContext(ctx.scopeId);
      const groupId = normalizeTeslaPowerhubGroupId(
        input.groupId ?? team.groupId
      );
      const job = startTeslaPowerhubProductionJob({
        scopeId: ctx.scopeId,
        createdBy: ctx.userId,
        apiContext: team.apiContext,
        groupId: groupId || null,
        endpointUrl: input.endpointUrl?.trim() || team.endpointUrl,
        signal: input.signal?.trim() || team.signal,
      });
      return {
        jobId: job.id,
        status: job.status,
        _runnerVersion: job._runnerVersion,
      };
    }),

  getGroupProductionMetricsJob: requirePermission("meter-reads", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getTeslaPowerhubProductionJobSnapshot } =
        await import("../services/solar/teslaPowerhubProductionJobs");
      const job = getTeslaPowerhubProductionJobSnapshot(
        ctx.scopeId,
        input.jobId.trim()
      );
      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Tesla Powerhub production job not found.",
        });
      }
      return job;
    }),

  debugProductionJobRaw: requirePermission("meter-reads", "edit").query(
    async ({ ctx }) => {
      const { debugTeslaPowerhubProductionJobs } =
        await import("../services/solar/teslaPowerhubProductionJobs");
      return debugTeslaPowerhubProductionJobs(ctx.scopeId);
    }
  ),

  getSiteSnapshot: requirePermission("meter-reads", "edit")
    .input(z.object({ siteId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getTeslaPowerhubSiteSnapshot } =
        await import("../services/solar/teslaPowerhub");
      const team = await resolveTeslaPowerhubTeamContext(ctx.scopeId);
      return getTeslaPowerhubSiteSnapshot(team.apiContext, {
        siteId: input.siteId,
        groupId: team.groupId,
        endpointUrl: team.endpointUrl,
        signal: team.signal,
      });
    }),
});

// ---------------------------------------------------------------------------
// Task 5.4 vendor 15/16 — SunPower. Different from every credential-backed
// vendor: there is no upstream API. Production readings are submitted by
// the SunPower Reader Expo app to the main router's
// `solarReadings.submit` endpoint (HMAC-signed, hardcoded URL in the
// mobile app — must NOT move) and stored in `productionReadings`.
//
// What moves: the dashboard read path. `summary` and `list` were on the
// main router; the new solar-rec page calls them through the standalone
// router behind the `meter-reads` permission gate. The legacy main
// router still exposes the same procedures so existing personal
// dashboards keep working until Phase 5.5 deprecates them.
// ---------------------------------------------------------------------------

const sunpowerRouter = t.router({
  summary: requirePermission("meter-reads", "read").query(async () => {
    const { getProductionReadingSummary } = await import("../db");
    return getProductionReadingSummary();
  }),

  list: requirePermission("meter-reads", "read")
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).optional(),
          email: z.string().optional(),
          nonId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const { listProductionReadings } = await import("../db");
      return listProductionReadings(input ?? undefined);
    }),
});

// ---------------------------------------------------------------------------
// eGauge meter reads.
//
// eGauge has two valid modes. Meter mode talks directly to one meter URL.
// Portfolio mode logs into the eGuard portal and lists every system visible
// to that account through /eguard/data/. The Solar REC migration stores each
// saved profile as one team credential row, so this router adapts the original
// eGauge feature surface to team credentials rather than personal integrations.
// ---------------------------------------------------------------------------

type EgaugeAccessType =
  | "public"
  | "user_login"
  | "site_login"
  | "portfolio_login";

type EgaugeTeamMetadata = {
  baseUrl: string;
  accessType: EgaugeAccessType;
  username: string | null;
  password: string | null;
  meterId: string | null;
};

type EgaugeCredentialRow = {
  id: string;
  connectionName: string;
  context: {
    baseUrl: string;
    accessType: EgaugeAccessType;
    username: string | null;
    password: string | null;
  };
  meterId: string | null;
};

function isEgaugeAccessType(value: unknown): value is EgaugeAccessType {
  return (
    value === "public" ||
    value === "user_login" ||
    value === "site_login" ||
    value === "portfolio_login"
  );
}

function looksLikeEgaugePortalUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`
    );
    const host = parsed.hostname.toLowerCase();
    return host === "egauge.net" || host === "www.egauge.net";
  } catch {
    return false;
  }
}

function deriveEgaugeMeterIdFromUrl(value: string | null): string | null {
  if (!value || looksLikeEgaugePortalUrl(value)) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`
    );
    const label = parsed.hostname.split(".")[0]?.trim();
    return label && /^[A-Za-z0-9._-]+$/.test(label) ? label : null;
  } catch {
    const host = value
      .replace(/^https?:\/\//i, "")
      .split(/[/?#]/)[0]
      ?.trim();
    const label = host?.split(".")[0]?.trim();
    return label && /^[A-Za-z0-9._-]+$/.test(label) ? label : null;
  }
}

function buildEgaugeMeterUrl(meterId: string | null): string | null {
  if (!meterId) return null;
  return `https://${meterId}.d.egauge.net`;
}

function parseEgaugeTeamMetadata(
  raw: string | null,
  accessToken?: string | null
): EgaugeTeamMetadata | null {
  const parsed = parseMetadataRecord(raw);
  const explicitMeterId = toNonEmptyString(parsed.meterId);
  const baseUrl =
    toNonEmptyString(parsed.baseUrl) ??
    toNonEmptyString(parsed.deviceUrl) ??
    buildEgaugeMeterUrl(explicitMeterId);
  if (!baseUrl) return null;

  const username = toNonEmptyString(parsed.username);
  const password =
    toNonEmptyString(parsed.password) ?? toNonEmptyString(accessToken);
  const explicitAccessType = toNonEmptyString(parsed.accessType)?.toLowerCase();
  const accessType = isEgaugeAccessType(explicitAccessType)
    ? explicitAccessType
    : username && password && looksLikeEgaugePortalUrl(baseUrl)
      ? "portfolio_login"
      : username && password
        ? "user_login"
        : "public";
  const meterId =
    explicitMeterId ??
    (accessType === "portfolio_login"
      ? null
      : deriveEgaugeMeterIdFromUrl(baseUrl));

  return {
    baseUrl,
    accessType,
    username,
    password,
    meterId,
  };
}

async function loadEgaugeCredentialRows(): Promise<EgaugeCredentialRow[]> {
  const { getSolarRecTeamCredentialsByProvider } = await import("../db");
  const credentials = await getSolarRecTeamCredentialsByProvider("egauge");
  const rows: EgaugeCredentialRow[] = [];
  for (const cred of credentials) {
    const meta = parseEgaugeTeamMetadata(cred.metadata, cred.accessToken);
    if (!meta) continue;
    rows.push({
      id: cred.id,
      connectionName:
        toNonEmptyString(cred.connectionName) ?? `eGauge ${rows.length + 1}`,
      context: {
        baseUrl: meta.baseUrl,
        accessType: meta.accessType,
        username: meta.username,
        password: meta.password,
      },
      meterId: meta.meterId,
    });
  }
  return rows;
}

function selectEgaugeCredential(
  rows: EgaugeCredentialRow[],
  connectionId?: string | null
): EgaugeCredentialRow | null {
  const requested = toNonEmptyString(connectionId);
  if (requested) return rows.find(row => row.id === requested) ?? null;
  return rows[0] ?? null;
}

async function resolveEgaugeCredential(
  connectionId?: string | null
): Promise<EgaugeCredentialRow> {
  const rows = await loadEgaugeCredentialRows();
  const selected = selectEgaugeCredential(rows, connectionId);
  if (!selected) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: connectionId
        ? "Selected eGauge profile was not found."
        : "No eGauge team credential found. An admin must add one in Solar REC Settings -> Credentials.",
    });
  }
  return selected;
}

function requireCompleteEgaugeCredential(row: EgaugeCredentialRow): void {
  if (
    row.context.accessType !== "public" &&
    (!row.context.username || !row.context.password)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "eGauge login is incomplete for the selected profile. Save username and password in Solar REC Settings.",
    });
  }
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildEgaugeMissingSnapshotRow(
  meterId: string,
  anchorDate: string,
  status: "Not Found" | "Error",
  error: string
) {
  return {
    meterId,
    meterName: null,
    siteName: null,
    status,
    found: false,
    lifetimeKwh: null,
    hourlyProductionKwh: null,
    monthlyProductionKwh: null,
    mtdProductionKwh: null,
    previousCalendarMonthProductionKwh: null,
    last12MonthsProductionKwh: null,
    weeklyProductionKwh: null,
    dailyProductionKwh: null,
    yearlyProductionKwh: null,
    anchorDate,
    monthlyStartDate: anchorDate,
    weeklyStartDate: anchorDate,
    mtdStartDate: anchorDate,
    previousCalendarMonthStartDate: anchorDate,
    previousCalendarMonthEndDate: anchorDate,
    last12MonthsStartDate: anchorDate,
    group: null,
    job: null,
    owner: null,
    model: null,
    firmware: null,
    online: null,
    availabilityPercent: null,
    temperatureC: null,
    proxyHost: null,
    error,
  };
}

function countEgaugeRows<T extends { status: "Found" | "Not Found" | "Error" }>(
  rows: T[]
): { found: number; notFound: number; errored: number } {
  return {
    found: rows.filter(row => row.status === "Found").length,
    notFound: rows.filter(row => row.status === "Not Found").length,
    errored: rows.filter(row => row.status === "Error").length,
  };
}

const egaugeRouter = t.router({
  getStatus: requirePermission("meter-reads", "read").query(async () => {
    const rows = await loadEgaugeCredentialRows();
    return {
      connected: rows.length > 0,
      connectionCount: rows.length,
      activeConnectionId: rows[0]?.id ?? null,
      profiles: rows.map(row => ({
        id: row.id,
        credentialId: row.id,
        name: row.connectionName,
        baseUrl: row.context.baseUrl,
        accessType: row.context.accessType,
        username: row.context.username,
        hasPassword: Boolean(row.context.password),
        defaultMeterId: row.meterId,
        isPortfolio: row.context.accessType === "portfolio_login",
      })),
    };
  }),

  getSystemInfo: requirePermission("meter-reads", "read")
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(input?.connectionId);
      requireCompleteEgaugeCredential(row);
      if (row.context.accessType === "portfolio_login") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "System Info is meter-level. Use Fetch Portfolio Systems for portfolio access.",
        });
      }
      const { getEgaugeSystemInfo } = await import("../services/solar/egauge");
      return getEgaugeSystemInfo(row.context);
    }),

  getLocalData: requirePermission("meter-reads", "read")
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(input?.connectionId);
      requireCompleteEgaugeCredential(row);
      if (row.context.accessType === "portfolio_login") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Local Data is meter-level. Use Fetch Portfolio Systems for portfolio access.",
        });
      }
      const { getEgaugeLocalData } = await import("../services/solar/egauge");
      return getEgaugeLocalData(row.context);
    }),

  getRegisterLatest: requirePermission("meter-reads", "read")
    .input(
      z
        .object({
          connectionId: z.string().optional(),
          register: z.string().optional(),
          includeRate: z.boolean().optional(),
        })
        .optional()
    )
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(input?.connectionId);
      requireCompleteEgaugeCredential(row);
      if (row.context.accessType === "portfolio_login") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Register Latest is meter-level. Use Fetch Portfolio Systems for portfolio access.",
        });
      }
      const { getEgaugeRegisterLatest } =
        await import("../services/solar/egauge");
      return getEgaugeRegisterLatest(row.context, {
        register: input?.register,
        includeRate: input?.includeRate,
      });
    }),

  getRegisterHistory: requirePermission("meter-reads", "read")
    .input(
      z.object({
        connectionId: z.string().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        intervalMinutes: z.number().int().min(1).max(1440).optional(),
        register: z.string().optional(),
        includeRate: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(input.connectionId);
      requireCompleteEgaugeCredential(row);
      if (row.context.accessType === "portfolio_login") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Register History is meter-level. Use Fetch Portfolio Systems for portfolio access.",
        });
      }
      const { getEgaugeRegisterHistory } =
        await import("../services/solar/egauge");
      return getEgaugeRegisterHistory(row.context, {
        startDate: input.startDate,
        endDate: input.endDate,
        intervalMinutes: input.intervalMinutes ?? 15,
        register: input.register,
        includeRate: input.includeRate,
      });
    }),

  getPortfolioSystems: requirePermission("meter-reads", "read")
    .input(
      z
        .object({
          connectionId: z.string().optional(),
          filter: z.string().optional(),
          groupId: z.string().optional(),
          anchorDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .optional()
    )
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(input?.connectionId);
      requireCompleteEgaugeCredential(row);
      if (row.context.accessType !== "portfolio_login") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Switch to a Portfolio Login profile, then run Fetch Portfolio Systems.",
        });
      }
      const { getEgaugePortfolioSystems } =
        await import("../services/solar/egauge");
      const result = await getEgaugePortfolioSystems(row.context, {
        filter: input?.filter,
        groupId: input?.groupId,
        anchorDate: input?.anchorDate,
      });
      return {
        connectionId: row.id,
        connectionName: row.connectionName,
        meterId: row.meterId,
        ...result,
      };
    }),

  getProductionSnapshot: requirePermission("meter-reads", "edit")
    .input(
      z.object({
        connectionId: z.string().min(1).optional(),
        credentialId: z.string().min(1).optional(),
        meterId: z.string().min(1).optional(),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        filter: z.string().optional(),
        groupId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const row = await resolveEgaugeCredential(
        input.connectionId ?? input.credentialId
      );
      requireCompleteEgaugeCredential(row);
      const anchorDate = input.anchorDate ?? todayIsoDate();
      const meterId = input.meterId?.trim() || row.meterId;
      if (!meterId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Provide a meter ID, or set a default meter ID on the eGauge credential.",
        });
      }

      if (row.context.accessType === "portfolio_login") {
        const { getEgaugePortfolioSystems } =
          await import("../services/solar/egauge");
        const portfolioResult = await getEgaugePortfolioSystems(row.context, {
          filter: input.filter,
          groupId: input.groupId,
          anchorDate,
        });
        const matched = portfolioResult.rows.find(
          candidate =>
            candidate.meterId.trim().toLowerCase() === meterId.toLowerCase()
        );
        return (
          matched ??
          buildEgaugeMissingSnapshotRow(
            meterId,
            anchorDate,
            "Not Found",
            `Meter ID "${meterId}" was not returned by the portfolio site list.`
          )
        );
      }

      const { getMeterProductionSnapshot } =
        await import("../services/solar/egauge");
      return getMeterProductionSnapshot(
        row.context,
        meterId,
        row.connectionName,
        anchorDate
      );
    }),

  getProductionSnapshots: requirePermission("meter-reads", "edit")
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
          credentialId: z.string().min(1).optional(),
          meterIds: z.array(z.string().min(1)).max(5000).optional(),
          anchorDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          autoFetchPortfolioIds: z.boolean().optional(),
          filter: z.string().optional(),
          groupId: z.string().optional(),
        })
        .refine(
          value =>
            Boolean(value.autoFetchPortfolioIds) ||
            (value.meterIds?.length ?? 0) > 0,
          {
            message:
              "Provide at least one meter ID or enable portfolio auto-fetch.",
            path: ["meterIds"],
          }
        )
    )
    .mutation(async ({ input }) => {
      const rows = await loadEgaugeCredentialRows();
      if (rows.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No eGauge team credential available.",
        });
      }
      const requested = selectEgaugeCredential(
        rows,
        input.connectionId ?? input.credentialId
      );
      if (!requested) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Selected eGauge profile was not found.",
        });
      }
      requireCompleteEgaugeCredential(requested);

      const anchorDate = input.anchorDate ?? todayIsoDate();
      const uniqueMeterIds = Array.from(
        new Map(
          (input.meterIds ?? [])
            .map(id => id.trim())
            .filter(Boolean)
            .map(id => [id.toLowerCase(), id])
        ).values()
      );
      const usePortfolioBulk =
        requested.context.accessType === "portfolio_login" ||
        Boolean(input.autoFetchPortfolioIds);

      if (usePortfolioBulk) {
        if (requested.context.accessType !== "portfolio_login") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Portfolio auto-fetch requires the selected eGauge profile to use Portfolio Login.",
          });
        }
        const { getEgaugePortfolioSystems } =
          await import("../services/solar/egauge");
        const portfolioResult = await getEgaugePortfolioSystems(
          requested.context,
          {
            filter: input.filter,
            groupId: input.groupId,
            anchorDate,
          }
        );
        const byMeterId = new Map(
          portfolioResult.rows.map(row => [
            row.meterId.trim().toLowerCase(),
            row,
          ])
        );
        const resultRows =
          uniqueMeterIds.length > 0
            ? uniqueMeterIds.map(meterId => {
                const matched = byMeterId.get(meterId.toLowerCase());
                return (
                  matched ??
                  buildEgaugeMissingSnapshotRow(
                    meterId,
                    anchorDate,
                    "Not Found",
                    `Meter ID "${meterId}" was not returned by the portfolio site list.`
                  )
                );
              })
            : portfolioResult.rows;
        const counts = countEgaugeRows(resultRows);
        return {
          total: resultRows.length,
          ...counts,
          source: "portfolio" as const,
          connectionId: requested.id,
          connectionName: requested.connectionName,
          meterIdsUsed: resultRows.map(row => row.meterId),
          rows: resultRows,
        };
      }

      if (uniqueMeterIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Provide at least one meter ID.",
        });
      }

      const nonPortfolioByMeterId = new Map(
        rows
          .filter(
            row => row.context.accessType !== "portfolio_login" && row.meterId
          )
          .map(row => [row.meterId!.toLowerCase(), row])
      );
      const { getMeterProductionSnapshot } =
        await import("../services/solar/egauge");
      const { mapWithConcurrency } =
        await import("../services/core/concurrency");
      const resultRows = await mapWithConcurrency(
        uniqueMeterIds,
        4,
        async meterId => {
          const row = nonPortfolioByMeterId.get(meterId.toLowerCase());
          if (!row) {
            return buildEgaugeMissingSnapshotRow(
              meterId,
              anchorDate,
              "Not Found",
              `No saved eGauge meter profile was found for meter ID "${meterId}".`
            );
          }
          requireCompleteEgaugeCredential(row);
          const snapshot = await getMeterProductionSnapshot(
            row.context,
            meterId,
            row.connectionName,
            anchorDate
          );
          return {
            ...snapshot,
            siteName: null,
            group: null,
            job: null,
            owner: null,
            model: null,
            firmware: null,
            online: null,
            availabilityPercent: null,
            temperatureC: null,
            proxyHost: null,
            monthlyProductionKwh: null,
            mtdProductionKwh: null,
            previousCalendarMonthProductionKwh: null,
            last12MonthsProductionKwh: null,
            weeklyProductionKwh: null,
            dailyProductionKwh: null,
            yearlyProductionKwh: null,
            hourlyProductionKwh: null,
          };
        }
      );
      const counts = countEgaugeRows(resultRows);
      return {
        total: resultRows.length,
        ...counts,
        source: "saved_connections" as const,
        meterIdsUsed: uniqueMeterIds,
        rows: resultRows,
      };
    }),

  getAllPortfolioSnapshots: requirePermission("meter-reads", "edit")
    .input(
      z
        .object({
          filter: z.string().optional(),
          groupId: z.string().optional(),
          anchorDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .optional()
    )
    .mutation(async ({ input }) => {
      const rows = await loadEgaugeCredentialRows();
      const portfolioRows = rows.filter(
        row =>
          row.context.accessType === "portfolio_login" &&
          row.context.username &&
          row.context.password
      );
      if (portfolioRows.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No Portfolio Login eGauge profiles found. Add one in Solar REC Settings first.",
        });
      }

      const { getEgaugePortfolioSystems } =
        await import("../services/solar/egauge");
      const seenMeterIds = new Set<string>();
      const mergedRows: Array<
        Record<string, unknown> & { status: "Found" | "Not Found" | "Error" }
      > = [];
      const portfolioResults: Array<{
        connectionId: string;
        connectionName: string;
        username: string | null;
        total: number;
        found: number;
        error: string | null;
      }> = [];

      for (const row of portfolioRows) {
        try {
          const result = await getEgaugePortfolioSystems(row.context, {
            filter: input?.filter,
            groupId: input?.groupId,
            anchorDate: input?.anchorDate,
          });
          portfolioResults.push({
            connectionId: row.id,
            connectionName: row.connectionName,
            username: row.context.username,
            total: result.total,
            found: result.found,
            error: null,
          });
          for (const snapshot of result.rows) {
            const key = snapshot.meterId.trim().toLowerCase();
            if (!key || seenMeterIds.has(key)) continue;
            seenMeterIds.add(key);
            mergedRows.push({
              ...snapshot,
              portfolioAccount: row.context.username,
              portfolioConnectionId: row.id,
              portfolioConnectionName: row.connectionName,
            });
          }
        } catch (err) {
          portfolioResults.push({
            connectionId: row.id,
            connectionName: row.connectionName,
            username: row.context.username,
            total: 0,
            found: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (
        mergedRows.length === 0 &&
        portfolioResults.length > 0 &&
        portfolioResults.every(result => result.error)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `All eGauge portfolio snapshots failed: ${portfolioResults
            .map(result => `${result.connectionName}: ${result.error}`)
            .join(" | ")}`,
        });
      }

      const counts = countEgaugeRows(mergedRows);
      return {
        portfolioCount: portfolioRows.length,
        portfolioResults,
        total: mergedRows.length,
        ...counts,
        rows: mergedRows,
      };
    }),
});

export const solarRecAppRouter = t.router({
  users: usersRouter,
  credentials: credentialsRouter,
  monitoring: monitoringRouter,
  permissions: permissionsRouter,
  generac: generacRouter,
  solis: solisRouter,
  goodwe: goodweRouter,
  hoymiles: hoymilesRouter,
  locus: locusRouter,
  apsystems: apsystemsRouter,
  solarlog: solarlogRouter,
  growatt: growattRouter,
  ekm: ekmRouter,
  fronius: froniusRouter,
  ennexos: ennexOsRouter,
  enphaseV4: enphaseV4Router,
  solaredge: solaredgeRouter,
  teslaPowerhub: teslaPowerhubRouter,
  sunpower: sunpowerRouter,
  egauge: egaugeRouter,
  solarRecDashboard: solarRecDashboardRouter,
  contractScan: solarRecContractScanRouter,
  zendesk: solarRecZendeskRouter,
  abpSettlement: solarRecAbpSettlementRouter,
  csgPortal: solarRecCsgPortalRouter,
  dinScrape: solarRecDinScrapeRouter,
  jobs: solarRecJobsRouter,
  systems: solarRecSystemsRouter,
  worksets: solarRecWorksetsRouter,
});

export type SolarRecAppRouter = typeof solarRecAppRouter;
