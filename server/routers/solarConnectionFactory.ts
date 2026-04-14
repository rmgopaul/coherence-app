import { protectedProcedure } from "../_core/trpc";
import { z } from "zod";
import {
  getIntegrationByProvider,
  upsertIntegration,
  deleteIntegration,
} from "../db";
import { nanoid } from "nanoid";
import { toNonEmptyString } from "../services/core/addressCleaning";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function maskApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) return "";
  if (normalized.length <= 6)
    return `${"*".repeat(Math.max(0, normalized.length - 2))}${normalized.slice(-2)}`;
  return `${normalized.slice(0, 3)}${"*".repeat(Math.max(0, normalized.length - 6))}${normalized.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type BaseConnectionConfig = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ParsedMetadata<TConn> = {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: TConn[];
};

export type SolarConnectionFactoryConfig<
  TConn extends BaseConnectionConfig,
  TStatus extends Record<string, unknown>,
> = {
  /** DB provider key, e.g. "goodwe-sems" */
  providerKey: string;
  /** Human-readable name, e.g. "GoodWe" */
  displayName: string;
  /** Zod schema for the `connect` mutation input */
  credentialSchema: z.ZodObject<any>;
  /**
   * Parse the raw metadata JSON string (and optional fallback token)
   * into the typed connection list.
   */
  parseMetadata: (
    raw: string | null | undefined,
    fallbackToken?: string | null
  ) => ParsedMetadata<TConn>;
  /**
   * Serialize connections, active ID, and baseUrl back into a JSON
   * string for the DB `metadata` column.
   */
  serializeMetadata: (
    connections: TConn[],
    activeId: string | null,
    baseUrl: string | null
  ) => string;
  /**
   * Build a new TConn from the validated connect input, existing
   * metadata state, a pre-generated nanoid, and the current ISO
   * timestamp.
   */
  buildNewConnection: (
    input: Record<string, unknown>,
    existing: ParsedMetadata<TConn>,
    connId: string,
    nowIso: string
  ) => TConn;
  /** Extract the value to store in the DB `accessToken` column. */
  getAccessToken: (conn: TConn) => string;
  /**
   * Map a single connection to the status fields returned by
   * `getStatus`.  `isActive` is true when this connection is the
   * currently-selected one.
   */
  mapConnectionStatus: (conn: TConn, isActive: boolean) => TStatus;
  /**
   * If true, `getStatus` will include a top-level `baseUrl` field
   * sourced from the active connection or the parsed metadata.
   */
  includeBaseUrlInStatus?: boolean;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSolarConnectionRouter<
  TConn extends BaseConnectionConfig,
  TStatus extends Record<string, unknown> = Record<string, unknown>,
>(config: SolarConnectionFactoryConfig<TConn, TStatus>) {
  const {
    providerKey,
    displayName,
    credentialSchema,
    parseMetadata,
    serializeMetadata,
    buildNewConnection,
    getAccessToken,
    mapConnectionStatus,
    includeBaseUrlInStatus,
  } = config;

  return {
    // -----------------------------------------------------------------------
    // getStatus
    // -----------------------------------------------------------------------
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        providerKey
      );
      const metadata = parseMetadata(
        integration?.metadata,
        toNonEmptyString(integration?.accessToken)
      );
      const activeConnection =
        metadata.connections.find(
          (c) => c.id === metadata.activeConnectionId
        ) ?? metadata.connections[0];

      const connections = metadata.connections.map((c) =>
        mapConnectionStatus(c, c.id === activeConnection?.id)
      );

      if (includeBaseUrlInStatus) {
        return {
          connected: metadata.connections.length > 0,
          activeConnectionId: activeConnection?.id ?? null,
          connections,
          baseUrl: activeConnection
            ? ((activeConnection as any).baseUrl ?? metadata.baseUrl) as string | null
            : metadata.baseUrl,
        };
      }

      return {
        connected: metadata.connections.length > 0,
        activeConnectionId: activeConnection?.id ?? null,
        connections,
      };
    }),

    // -----------------------------------------------------------------------
    // connect
    // -----------------------------------------------------------------------
    connect: protectedProcedure
      .input(credentialSchema)
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(
          ctx.user.id,
          providerKey
        );
        const existingMetadata = parseMetadata(
          existing?.metadata,
          toNonEmptyString(existing?.accessToken)
        );
        const nowIso = new Date().toISOString();
        const connId = nanoid();
        const newConn = buildNewConnection(
          input as Record<string, unknown>,
          existingMetadata,
          connId,
          nowIso
        );
        const connections = [newConn, ...existingMetadata.connections];
        const newBaseUrl =
          (newConn as any).baseUrl ?? existingMetadata.baseUrl;

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: providerKey,
          accessToken: getAccessToken(newConn),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: serializeMetadata(
            connections,
            newConn.id,
            newBaseUrl
          ),
        });

        return {
          success: true as const,
          activeConnectionId: newConn.id,
          totalConnections: connections.length,
        };
      }),

    // -----------------------------------------------------------------------
    // setActiveConnection
    // -----------------------------------------------------------------------
    setActiveConnection: protectedProcedure
      .input(z.object({ connectionId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(
          ctx.user.id,
          providerKey
        );
        if (!integration)
          throw new Error(`${displayName} is not connected.`);

        const ms = parseMetadata(
          integration.metadata,
          toNonEmptyString(integration.accessToken)
        );
        const ac = ms.connections.find(
          (c) => c.id === input.connectionId
        );
        if (!ac)
          throw new Error(
            `Selected ${displayName} profile was not found.`
          );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: providerKey,
          accessToken: getAccessToken(ac),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: serializeMetadata(
            ms.connections,
            ac.id,
            (ac as any).baseUrl ?? ms.baseUrl
          ),
        });

        return { success: true as const, activeConnectionId: ac.id };
      }),

    // -----------------------------------------------------------------------
    // removeConnection
    // -----------------------------------------------------------------------
    removeConnection: protectedProcedure
      .input(z.object({ connectionId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(
          ctx.user.id,
          providerKey
        );
        if (!integration)
          throw new Error(`${displayName} is not connected.`);

        const ms = parseMetadata(
          integration.metadata,
          toNonEmptyString(integration.accessToken)
        );
        const next = ms.connections.filter(
          (c) => c.id !== input.connectionId
        );

        if (next.length === 0) {
          if (integration.id) await deleteIntegration(integration.id);
          return {
            success: true as const,
            connected: false as const,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nac =
          next.find((c) => c.id === ms.activeConnectionId) ?? next[0];

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: providerKey,
          accessToken: getAccessToken(nac),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: serializeMetadata(
            next,
            nac.id,
            (nac as any).baseUrl ?? ms.baseUrl
          ),
        });

        return {
          success: true as const,
          connected: true as const,
          activeConnectionId: nac.id,
          totalConnections: next.length,
        };
      }),

    // -----------------------------------------------------------------------
    // disconnect
    // -----------------------------------------------------------------------
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        providerKey
      );
      if (integration?.id) await deleteIntegration(integration.id);
      return { success: true as const };
    }),
  };
}
