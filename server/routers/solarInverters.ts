import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import { formatTodayKey } from "@shared/dateKey";
import { mapWithConcurrency } from "../services/core/concurrency";
import { maskApiKey } from "./solarConnectionFactory";
import {
  IntegrationNotConnectedError,
  toNonEmptyString,
  parseEnphaseV4Metadata,
  parseSolarEdgeMetadata,
  serializeSolarEdgeMetadata,
  parseFroniusMetadata,
  serializeFroniusMetadata,
  getEnphaseV4Context,
  getSolarEdgeContext,
  getFroniusContext,
  ENPHASE_V4_PROVIDER,
  SOLAR_EDGE_PROVIDER,
  FRONIUS_PROVIDER,
} from "./helpers";
import type {
  SolarEdgeConnectionConfig,
  FroniusConnectionConfig,
} from "./helpers";
import {
  deleteIntegration,
  getIntegrationByProvider,
  upsertIntegration,
} from "../db";
// Enphase V4 service (aliased imports)
import {
  listSystems as listSystemsEnphaseV4,
  getSystemSummary as getSystemSummaryEnphaseV4,
  getSystemEnergyLifetime as getSystemEnergyLifetimeEnphaseV4,
  getSystemRgmStats as getSystemRgmStatsEnphaseV4,
  getSystemProductionMeterTelemetry,
  getSystemProductionSnapshot as getSystemProductionSnapshotEnphaseV4,
  exchangeEnphaseV4AuthorizationCode,
} from "../services/solar/enphaseV4";
// SolarEdge service (aliased imports)
import {
  listSites as listSitesSolarEdge,
  getSiteOverview,
  getSiteDetails,
  getSiteEnergy,
  getSiteEnergyDetails,
  getSiteMeters,
  getSiteInverterProduction,
  getSiteProductionSnapshot as getSiteProductionSnapshotSolarEdge,
  getSiteMeterSnapshot,
  getSiteInverterSnapshot,
} from "../services/solar/solarEdge";
// Fronius service
import {
  listPvSystems,
  getPvSystemDetails,
  getPvSystemDevices,
  getAggrData,
  getFlowData,
  getPvSystemProductionSnapshot,
  extractPvSystems,
  getPvSystemDeviceSnapshot,
} from "../services/solar/fronius";

// ---------------------------------------------------------------------------
// enphaseV4
// ---------------------------------------------------------------------------
export const enphaseV4Router = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
    const metadata = parseEnphaseV4Metadata(integration?.metadata);
    return {
      connected: Boolean(integration?.accessToken && metadata.apiKey && metadata.clientId),
      hasRefreshToken: Boolean(integration?.refreshToken),
      expiresAt: integration?.expiresAt ? new Date(integration.expiresAt).toISOString() : null,
      clientId: metadata.clientId,
      baseUrl: metadata.baseUrl,
      redirectUri: metadata.redirectUri,
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().min(1),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        authorizationCode: z.string().min(1),
        redirectUri: z.string().optional(),
        baseUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const tokenData = await exchangeEnphaseV4AuthorizationCode({
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        authorizationCode: input.authorizationCode.trim(),
        redirectUri: input.redirectUri,
      });

      const metadata = JSON.stringify({
        apiKey: input.apiKey.trim(),
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        redirectUri: toNonEmptyString(input.redirectUri),
        baseUrl: toNonEmptyString(input.baseUrl),
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ENPHASE_V4_PROVIDER,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? null,
        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
        scope: tokenData.scope ?? null,
        metadata,
      });

      return {
        success: true,
        hasRefreshToken: Boolean(tokenData.refresh_token),
        expiresInSeconds: tokenData.expires_in,
      };
    }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  listSystems: protectedProcedure.query(async ({ ctx }) => {
    const context = await getEnphaseV4Context(ctx.user.id);
    return listSystemsEnphaseV4(context);
  }),
  getSummary: protectedProcedure
    .input(
      z.object({
        systemId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      return getSystemSummaryEnphaseV4(context, input.systemId.trim());
    }),
  getEnergyLifetime: protectedProcedure
    .input(
      z.object({
        systemId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      return getSystemEnergyLifetimeEnphaseV4(context, input.systemId.trim(), input.startDate, input.endDate);
    }),
  getRgmStats: protectedProcedure
    .input(
      z.object({
        systemId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      return getSystemRgmStatsEnphaseV4(context, input.systemId.trim(), input.startDate, input.endDate);
    }),
  getProductionMeterReadings: protectedProcedure
    .input(
      z.object({
        systemId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      return getSystemProductionMeterTelemetry(
        context,
        input.systemId.trim(),
        input.startDate,
        input.endDate
      );
    }),
  getProductionSnapshots: protectedProcedure
    .input(
      z.object({
        systemIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      const uniqueSystemIds = Array.from(
        new Set(input.systemIds.map((id) => id.trim()).filter((id) => id.length > 0))
      );

      const anchorDate = input.anchorDate ?? formatTodayKey();

      // Fetch system names once upfront.
      const nameMap = new Map<string, string>();
      try {
        const { systems } = await listSystemsEnphaseV4(context);
        for (const sys of systems) {
          nameMap.set(sys.systemId, sys.systemName);
        }
      } catch {
        // Non-critical — proceed without names.
      }

      const rows = await mapWithConcurrency(uniqueSystemIds, 4, async (systemId: string) => {
        const snapshot = await getSystemProductionSnapshotEnphaseV4(
          context,
          systemId,
          anchorDate,
          nameMap.get(systemId) ?? null
        );
        return snapshot;
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        rows,
      };
    }),
});

// ---------------------------------------------------------------------------
// solarEdge
// ---------------------------------------------------------------------------
export const solarEdgeRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
    const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
    const activeConnection =
      metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];

    return {
      connected: metadata.connections.length > 0,
      baseUrl: activeConnection?.baseUrl ?? metadata.baseUrl,
      activeConnectionId: activeConnection?.id ?? null,
      connections: metadata.connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        apiKeyMasked: maskApiKey(connection.apiKey),
        updatedAt: connection.updatedAt,
        isActive: connection.id === activeConnection?.id,
      })),
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().min(1),
        connectionName: z.string().optional(),
        baseUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const existingMetadata = parseSolarEdgeMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
      const nowIso = new Date().toISOString();
      const newConnection: SolarEdgeConnectionConfig = {
        id: nanoid(),
        name:
          toNonEmptyString(input.connectionName) ??
          `SolarEdge API ${existingMetadata.connections.length + 1}`,
        apiKey: input.apiKey.trim(),
        baseUrl: toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const connections = [newConnection, ...existingMetadata.connections];
      const activeConnectionId = newConnection.id;
      const metadata = serializeSolarEdgeMetadata(
        connections,
        activeConnectionId,
        newConnection.baseUrl ?? existingMetadata.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: SOLAR_EDGE_PROVIDER,
        accessToken: newConnection.apiKey,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        activeConnectionId,
        totalConnections: connections.length,
      };
    }),
  setActiveConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      if (!integration) {
        throw new IntegrationNotConnectedError("SolarEdge");
      }
      const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
      const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
      if (!activeConnection) {
        throw new Error("Selected SolarEdge API profile was not found.");
      }

      const metadata = serializeSolarEdgeMetadata(
        metadataState.connections,
        activeConnection.id,
        activeConnection.baseUrl ?? metadataState.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: SOLAR_EDGE_PROVIDER,
        accessToken: activeConnection.apiKey,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        activeConnectionId: activeConnection.id,
      };
    }),
  removeConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      if (!integration) {
        throw new IntegrationNotConnectedError("SolarEdge");
      }
      const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
      const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

      if (nextConnections.length === 0) {
        if (integration.id) {
          await deleteIntegration(integration.id);
        }
        return {
          success: true,
          connected: false,
          activeConnectionId: null,
          totalConnections: 0,
        };
      }

      const nextActiveConnection =
        nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
      const metadata = serializeSolarEdgeMetadata(
        nextConnections,
        nextActiveConnection.id,
        nextActiveConnection.baseUrl ?? metadataState.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: SOLAR_EDGE_PROVIDER,
        accessToken: nextActiveConnection.apiKey,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        connected: true,
        activeConnectionId: nextActiveConnection.id,
        totalConnections: nextConnections.length,
      };
    }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  listSites: protectedProcedure.query(async ({ ctx }) => {
    const context = await getSolarEdgeContext(ctx.user.id);
    return listSitesSolarEdge(context);
  }),
  getOverview: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteOverview(context, input.siteId.trim());
    }),
  getDetails: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteDetails(context, input.siteId.trim());
    }),
  getEnergy: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteEnergy(context, input.siteId.trim(), input.startDate, input.endDate, input.timeUnit);
    }),
  getProductionMeterReadings: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteEnergyDetails(
        context,
        input.siteId.trim(),
        input.startDate,
        input.endDate,
        input.timeUnit,
        "PRODUCTION"
      );
    }),
  getMeters: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteMeters(context, input.siteId.trim(), input.startDate, input.endDate);
    }),
  getInverterProduction: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteInverterProduction(context, input.siteId.trim(), input.startDate, input.endDate);
    }),
  getProductionSnapshot: protectedProcedure
    .input(
      z.object({
        siteId: z.string().min(1),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return getSiteProductionSnapshotSolarEdge(context, input.siteId.trim(), input.anchorDate);
    }),
  getProductionSnapshots: protectedProcedure
    .input(
      z.object({
        siteIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniqueSiteIds = Array.from(
        new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("SolarEdge");
      }

      const activeConnection =
        allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
      const targetConnections = scope === "all" ? allConnections : [activeConnection];

      const rows = await mapWithConcurrency(uniqueSiteIds, 4, async (siteId) => {
        let selectedSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshotSolarEdge>> | null = null;
        let selectedConnection: (typeof targetConnections)[number] | null = null;
        let firstError: string | null = null;
        let fallbackSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshotSolarEdge>> | null = null;
        const profileStatuses: Array<{
          connectionId: string;
          connectionName: string;
          status: "Found" | "Not Found" | "Error";
        }> = [];
        let foundInConnections = 0;

        for (const connection of targetConnections) {
          const snapshot = await getSiteProductionSnapshotSolarEdge(
            {
              apiKey: connection.apiKey,
              baseUrl: connection.baseUrl ?? metadata.baseUrl,
            },
            siteId,
            input.anchorDate
          );

          if (!fallbackSnapshot) {
            fallbackSnapshot = snapshot;
          }

          profileStatuses.push({
            connectionId: connection.id,
            connectionName: connection.name,
            status: snapshot.status,
          });

          if (snapshot.status === "Found") {
            foundInConnections += 1;
            if (!selectedSnapshot) {
              selectedSnapshot = snapshot;
              selectedConnection = connection;
            }
            continue;
          }

          if (snapshot.status === "Error" && !firstError) {
            firstError = snapshot.error ?? "Unknown API error.";
          }
        }

        const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
        const monthlyStartDate =
          selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
        const weeklyStartDate =
          selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";
        const mtdStartDate = selectedSnapshot?.mtdStartDate ?? fallbackSnapshot?.mtdStartDate ?? input.anchorDate ?? "";
        const previousCalendarMonthStartDate =
          selectedSnapshot?.previousCalendarMonthStartDate ??
          fallbackSnapshot?.previousCalendarMonthStartDate ??
          input.anchorDate ??
          "";
        const previousCalendarMonthEndDate =
          selectedSnapshot?.previousCalendarMonthEndDate ??
          fallbackSnapshot?.previousCalendarMonthEndDate ??
          input.anchorDate ??
          "";
        const last12MonthsStartDate =
          selectedSnapshot?.last12MonthsStartDate ?? fallbackSnapshot?.last12MonthsStartDate ?? input.anchorDate ?? "";

        if (selectedSnapshot && selectedConnection) {
          return {
            ...selectedSnapshot,
            matchedConnectionId: selectedConnection.id,
            matchedConnectionName: selectedConnection.name,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }

        const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
        return {
          siteId,
          status: notFoundStatus,
          found: false,
          siteName: null,
          lifetimeKwh: null,
          hourlyProductionKwh: null,
          monthlyProductionKwh: null,
          mtdProductionKwh: null,
          previousCalendarMonthProductionKwh: null,
          last12MonthsProductionKwh: null,
          weeklyProductionKwh: null,
          dailyProductionKwh: null,
          anchorDate,
          monthlyStartDate,
          weeklyStartDate,
          mtdStartDate,
          previousCalendarMonthStartDate,
          previousCalendarMonthEndDate,
          last12MonthsStartDate,
          inverterLifetimes: null,
          meterLifetimeKwh: null,
          error: firstError,
          matchedConnectionId: null,
          matchedConnectionName: null,
          checkedConnections: targetConnections.length,
          foundInConnections,
          profileStatusSummary: profileStatuses
            .map((row) => `${row.connectionName}:${row.status}`)
            .join(" | "),
        };
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
  getMeterSnapshots: protectedProcedure
    .input(
      z.object({
        siteIds: z.array(z.string().min(1)).min(1).max(200),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniqueSiteIds = Array.from(
        new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("SolarEdge");
      }

      const activeConnection =
        allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
      const targetConnections = scope === "all" ? allConnections : [activeConnection];

      const rows = await mapWithConcurrency(uniqueSiteIds, 4, async (siteId) => {
        let selectedSnapshot: Awaited<ReturnType<typeof getSiteMeterSnapshot>> | null = null;
        let selectedConnection: (typeof targetConnections)[number] | null = null;
        let firstError: string | null = null;
        const profileStatuses: Array<{
          connectionId: string;
          connectionName: string;
          status: "Found" | "Not Found" | "Error";
        }> = [];
        let foundInConnections = 0;

        for (const connection of targetConnections) {
          const snapshot = await getSiteMeterSnapshot(
            {
              apiKey: connection.apiKey,
              baseUrl: connection.baseUrl ?? metadata.baseUrl,
            },
            siteId
          );

          profileStatuses.push({
            connectionId: connection.id,
            connectionName: connection.name,
            status: snapshot.status,
          });

          if (snapshot.status === "Found") {
            foundInConnections += 1;
            if (!selectedSnapshot) {
              selectedSnapshot = snapshot;
              selectedConnection = connection;
            }
            continue;
          }

          if (snapshot.status === "Error" && !firstError) {
            firstError = snapshot.error ?? "Unknown API error.";
          }
        }

        if (selectedSnapshot && selectedConnection) {
          return {
            ...selectedSnapshot,
            matchedConnectionId: selectedConnection.id,
            matchedConnectionName: selectedConnection.name,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }

        const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
        return {
          siteId,
          status: notFoundStatus,
          found: false,
          meterCount: null,
          productionMeterCount: null,
          consumptionMeterCount: null,
          meterTypes: [],
          error: firstError,
          matchedConnectionId: null,
          matchedConnectionName: null,
          checkedConnections: targetConnections.length,
          foundInConnections,
          profileStatusSummary: profileStatuses
            .map((row) => `${row.connectionName}:${row.status}`)
            .join(" | "),
        };
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
  getInverterSnapshots: protectedProcedure
    .input(
      z.object({
        siteIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniqueSiteIds = Array.from(
        new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("SolarEdge");
      }

      const activeConnection =
        allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
      const targetConnections = scope === "all" ? allConnections : [activeConnection];

      let processedCount = 0;
      let errorCount = 0;
      let circuitBroken = false;

      const rows = await mapWithConcurrency(uniqueSiteIds, 20, async (siteId) => {
        if (circuitBroken) {
          return {
            siteId,
            status: "Error" as const,
            found: false,
            inverterCount: null,
            invertersWithTelemetry: null,
            inverterFailures: null,
            totalLatestPowerW: null,
            totalLatestEnergyWh: null,
            firstTelemetryAt: null,
            lastTelemetryAt: null,
            error: "Aborted: API failure rate too high in this batch.",
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections: 0,
            profileStatusSummary: "",
          };
        }

        let selectedSnapshot: Awaited<ReturnType<typeof getSiteInverterSnapshot>> | null = null;
        let selectedConnection: (typeof targetConnections)[number] | null = null;
        let firstError: string | null = null;
        const profileStatuses: Array<{
          connectionId: string;
          connectionName: string;
          status: "Found" | "Not Found" | "Error";
        }> = [];
        let foundInConnections = 0;

        for (const connection of targetConnections) {
          const snapshot = await getSiteInverterSnapshot(
            {
              apiKey: connection.apiKey,
              baseUrl: connection.baseUrl ?? metadata.baseUrl,
            },
            siteId,
            input.anchorDate
          );

          profileStatuses.push({
            connectionId: connection.id,
            connectionName: connection.name,
            status: snapshot.status,
          });

          if (snapshot.status === "Found") {
            foundInConnections += 1;
            if (!selectedSnapshot) {
              selectedSnapshot = snapshot;
              selectedConnection = connection;
            }
            continue;
          }

          if (snapshot.status === "Error" && !firstError) {
            firstError = snapshot.error ?? "Unknown API error.";
          }
        }

        if (selectedSnapshot && selectedConnection) {
          processedCount += 1;
          return {
            ...selectedSnapshot,
            matchedConnectionId: selectedConnection.id,
            matchedConnectionName: selectedConnection.name,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }

        const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
        processedCount += 1;
        if (notFoundStatus === "Error") errorCount += 1;
        if (processedCount >= 15 && errorCount / processedCount > 0.8) {
          circuitBroken = true;
        }

        return {
          siteId,
          status: notFoundStatus,
          found: false,
          inverterCount: null,
          invertersWithTelemetry: null,
          inverterFailures: null,
          totalLatestPowerW: null,
          totalLatestEnergyWh: null,
          firstTelemetryAt: null,
          lastTelemetryAt: null,
          error: firstError,
          matchedConnectionId: null,
          matchedConnectionName: null,
          checkedConnections: targetConnections.length,
          foundInConnections,
          profileStatusSummary: profileStatuses
            .map((row) => `${row.connectionName}:${row.status}`)
            .join(" | "),
        };
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
});

// ---------------------------------------------------------------------------
// fronius
// ---------------------------------------------------------------------------
export const froniusRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
    const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
    const activeConnection =
      metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];

    return {
      connected: metadata.connections.length > 0,
      activeConnectionId: activeConnection?.id ?? null,
      connections: metadata.connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        accessKeyIdMasked: maskApiKey(connection.accessKeyId),
        accessKeyValueMasked: maskApiKey(connection.accessKeyValue),
        updatedAt: connection.updatedAt,
        isActive: connection.id === activeConnection?.id,
      })),
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        accessKeyId: z.string().min(1),
        accessKeyValue: z.string().min(1),
        connectionName: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      const existingMetadata = parseFroniusMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
      const nowIso = new Date().toISOString();
      const newConnection: FroniusConnectionConfig = {
        id: nanoid(),
        name:
          toNonEmptyString(input.connectionName) ??
          `Fronius API ${existingMetadata.connections.length + 1}`,
        accessKeyId: input.accessKeyId.trim(),
        accessKeyValue: input.accessKeyValue.trim(),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const connections = [newConnection, ...existingMetadata.connections];
      const activeConnectionId = newConnection.id;
      const metadata = serializeFroniusMetadata(connections, activeConnectionId);

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: FRONIUS_PROVIDER,
        accessToken: newConnection.accessKeyId,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        activeConnectionId,
        totalConnections: connections.length,
      };
    }),
  setActiveConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      if (!integration) {
        throw new IntegrationNotConnectedError("Fronius");
      }
      const metadataState = parseFroniusMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
      const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
      if (!activeConnection) {
        throw new Error("Selected Fronius API profile was not found.");
      }

      const metadata = serializeFroniusMetadata(metadataState.connections, activeConnection.id);

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: FRONIUS_PROVIDER,
        accessToken: activeConnection.accessKeyId,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        activeConnectionId: activeConnection.id,
      };
    }),
  removeConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      if (!integration) {
        throw new IntegrationNotConnectedError("Fronius");
      }
      const metadataState = parseFroniusMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
      const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

      if (nextConnections.length === 0) {
        if (integration.id) {
          await deleteIntegration(integration.id);
        }
        return {
          success: true,
          connected: false,
          activeConnectionId: null,
          totalConnections: 0,
        };
      }

      const nextActiveConnection =
        nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
      const metadata = serializeFroniusMetadata(nextConnections, nextActiveConnection.id);

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: FRONIUS_PROVIDER,
        accessToken: nextActiveConnection.accessKeyId,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        connected: true,
        activeConnectionId: nextActiveConnection.id,
        totalConnections: nextConnections.length,
      };
    }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  listPvSystems: protectedProcedure.query(async ({ ctx }) => {
    const context = await getFroniusContext(ctx.user.id);
    return listPvSystems(context);
  }),
  getPvSystemDetails: protectedProcedure
    .input(
      z.object({
        pvSystemId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getFroniusContext(ctx.user.id);
      return getPvSystemDetails(context, input.pvSystemId.trim());
    }),
  getDevices: protectedProcedure
    .input(
      z.object({
        pvSystemId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getFroniusContext(ctx.user.id);
      return getPvSystemDevices(context, input.pvSystemId.trim());
    }),
  getAggData: protectedProcedure
    .input(
      z.object({
        pvSystemId: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
        period: z.enum(["Total", "Years", "Months", "Days"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getFroniusContext(ctx.user.id);
      return getAggrData(context, input.pvSystemId.trim(), input.from, input.to);
    }),
  getFlowData: protectedProcedure
    .input(
      z.object({
        pvSystemId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getFroniusContext(ctx.user.id);
      return getFlowData(context, input.pvSystemId.trim());
    }),
  getProductionSnapshot: protectedProcedure
    .input(
      z.object({
        pvSystemId: z.string().min(1),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getFroniusContext(ctx.user.id);
      let systemName: string | null = null;
      try {
        const details = await getPvSystemDetails(context, input.pvSystemId.trim());
        const systems = extractPvSystems(Array.isArray(details) ? details : [details]);
        systemName = systems[0]?.name ?? null;
      } catch {
        // Non-critical — proceed without name
      }
      return getPvSystemProductionSnapshot(context, input.pvSystemId.trim(), input.anchorDate, systemName);
    }),
  getProductionSnapshots: protectedProcedure
    .input(
      z.object({
        pvSystemIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniquePvSystemIds = Array.from(
        new Set(input.pvSystemIds.map((id) => id.trim()).filter((id) => id.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("Fronius");
      }

      const activeConnection =
        allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
      const targetConnections = scope === "all" ? allConnections : [activeConnection];

      // Fetch system names once upfront to include in snapshot results
      const nameMap = new Map<string, string>();
      try {
        const { pvSystems } = await listPvSystems({
          accessKeyId: activeConnection.accessKeyId,
          accessKeyValue: activeConnection.accessKeyValue,
        });
        for (const sys of pvSystems) {
          nameMap.set(sys.pvSystemId, sys.name);
        }
      } catch {
        // Non-critical — proceed without names if the list call fails
      }

      const rows = await mapWithConcurrency(uniquePvSystemIds, 4, async (pvSystemId: string) => {
        let selectedSnapshot: Awaited<ReturnType<typeof getPvSystemProductionSnapshot>> | null = null;
        let selectedConnection: (typeof targetConnections)[number] | null = null;
        let firstError: string | null = null;
        let fallbackSnapshot: Awaited<ReturnType<typeof getPvSystemProductionSnapshot>> | null = null;
        const profileStatuses: Array<{
          connectionId: string;
          connectionName: string;
          status: "Found" | "Not Found" | "Error";
        }> = [];
        let foundInConnections = 0;

        for (const connection of targetConnections) {
          const snapshot = await getPvSystemProductionSnapshot(
            {
              accessKeyId: connection.accessKeyId,
              accessKeyValue: connection.accessKeyValue,
            },
            pvSystemId,
            input.anchorDate,
            nameMap.get(pvSystemId) ?? null
          );

          if (!fallbackSnapshot) {
            fallbackSnapshot = snapshot;
          }

          profileStatuses.push({
            connectionId: connection.id,
            connectionName: connection.name,
            status: snapshot.status,
          });

          if (snapshot.status === "Found") {
            foundInConnections += 1;
            if (!selectedSnapshot) {
              selectedSnapshot = snapshot;
              selectedConnection = connection;
            }
            continue;
          }

          if (snapshot.status === "Error" && !firstError) {
            firstError = snapshot.error ?? "Unknown API error.";
          }
        }

        const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
        const monthlyStartDate =
          selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
        const weeklyStartDate =
          selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";
        const mtdStartDate = selectedSnapshot?.mtdStartDate ?? fallbackSnapshot?.mtdStartDate ?? input.anchorDate ?? "";
        const previousCalendarMonthStartDate =
          selectedSnapshot?.previousCalendarMonthStartDate ??
          fallbackSnapshot?.previousCalendarMonthStartDate ??
          input.anchorDate ??
          "";
        const previousCalendarMonthEndDate =
          selectedSnapshot?.previousCalendarMonthEndDate ??
          fallbackSnapshot?.previousCalendarMonthEndDate ??
          input.anchorDate ??
          "";
        const last12MonthsStartDate =
          selectedSnapshot?.last12MonthsStartDate ?? fallbackSnapshot?.last12MonthsStartDate ?? input.anchorDate ?? "";

        if (selectedSnapshot && selectedConnection) {
          return {
            ...selectedSnapshot,
            matchedConnectionId: selectedConnection.id,
            matchedConnectionName: selectedConnection.name,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }

        const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
        return {
          pvSystemId,
          name: nameMap.get(pvSystemId) ?? null,
          status: notFoundStatus,
          found: false,
          lifetimeKwh: null,
          hourlyProductionKwh: null,
          monthlyProductionKwh: null,
          mtdProductionKwh: null,
          previousCalendarMonthProductionKwh: null,
          last12MonthsProductionKwh: null,
          weeklyProductionKwh: null,
          dailyProductionKwh: null,
          anchorDate,
          monthlyStartDate,
          weeklyStartDate,
          mtdStartDate,
          previousCalendarMonthStartDate,
          previousCalendarMonthEndDate,
          last12MonthsStartDate,
          lifetimeChannelName: null,
          lifetimeChannelUnit: null,
          lifetimeChannelSelection: null,
          dailyChannelName: null,
          dailyChannelUnit: null,
          dailyChannelSelection: null,
          monthlyChannelName: null,
          monthlyChannelUnit: null,
          monthlyChannelSelection: null,
          error: firstError,
          matchedConnectionId: null,
          matchedConnectionName: null,
          checkedConnections: targetConnections.length,
          foundInConnections,
          profileStatusSummary: profileStatuses
            .map((row) => `${row.connectionName}:${row.status}`)
            .join(" | "),
        };
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
  getDeviceSnapshots: protectedProcedure
    .input(
      z.object({
        pvSystemIds: z.array(z.string().min(1)).min(1).max(200),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniquePvSystemIds = Array.from(
        new Set(input.pvSystemIds.map((id) => id.trim()).filter((id) => id.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("Fronius");
      }

      const activeConnection =
        allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
      const targetConnections = scope === "all" ? allConnections : [activeConnection];

      // Fetch system names once upfront to include in snapshot results
      const nameMap = new Map<string, string>();
      try {
        const { pvSystems } = await listPvSystems({
          accessKeyId: activeConnection.accessKeyId,
          accessKeyValue: activeConnection.accessKeyValue,
        });
        for (const sys of pvSystems) {
          nameMap.set(sys.pvSystemId, sys.name);
        }
      } catch {
        // Non-critical — proceed without names if the list call fails
      }

      const rows = await mapWithConcurrency(uniquePvSystemIds, 4, async (pvSystemId: string) => {
        let selectedSnapshot: Awaited<ReturnType<typeof getPvSystemDeviceSnapshot>> | null = null;
        let selectedConnection: (typeof targetConnections)[number] | null = null;
        let firstError: string | null = null;
        const profileStatuses: Array<{
          connectionId: string;
          connectionName: string;
          status: "Found" | "Not Found" | "Error";
        }> = [];
        let foundInConnections = 0;

        for (const connection of targetConnections) {
          const snapshot = await getPvSystemDeviceSnapshot(
            {
              accessKeyId: connection.accessKeyId,
              accessKeyValue: connection.accessKeyValue,
            },
            pvSystemId,
            nameMap.get(pvSystemId) ?? null
          );

          profileStatuses.push({
            connectionId: connection.id,
            connectionName: connection.name,
            status: snapshot.status,
          });

          if (snapshot.status === "Found") {
            foundInConnections += 1;
            if (!selectedSnapshot) {
              selectedSnapshot = snapshot;
              selectedConnection = connection;
            }
            continue;
          }

          if (snapshot.status === "Error" && !firstError) {
            firstError = snapshot.error ?? "Unknown API error.";
          }
        }

        if (selectedSnapshot && selectedConnection) {
          return {
            ...selectedSnapshot,
            matchedConnectionId: selectedConnection.id,
            matchedConnectionName: selectedConnection.name,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }

        const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
        return {
          pvSystemId,
          name: nameMap.get(pvSystemId) ?? null,
          status: notFoundStatus,
          found: false,
          error: firstError,
          matchedConnectionId: null,
          matchedConnectionName: null,
          checkedConnections: targetConnections.length,
          foundInConnections,
          profileStatusSummary: profileStatuses
            .map((row) => `${row.connectionName}:${row.status}`)
            .join(" | "),
        };
      });

      return {
        total: rows.length,
        found: rows.filter((row) => row.status === "Found").length,
        notFound: rows.filter((row) => row.status === "Not Found").length,
        errored: rows.filter((row) => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
});
