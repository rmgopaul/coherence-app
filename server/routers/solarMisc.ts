import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import { formatTodayKey } from "@shared/dateKey";
import { mapWithConcurrency } from "../services/core/concurrency";
import {
  deleteIntegration,
  getIntegrationByProvider,
  upsertIntegration,
} from "../db";
import {
  IntegrationNotConnectedError,
  toNonEmptyString,
  ENNEX_OS_PROVIDER,
  ZENDESK_PROVIDER,
  EGAUGE_PROVIDER,
  parseEnnexOsMetadata,
  serializeEnnexOsMetadata,
  parseZendeskMetadata,
  serializeZendeskMetadata,
  parseEgaugeMetadata,
  serializeEgaugeMetadata,
  getEnnexOsContext,
  getZendeskContext,
  getEgaugeContext,
  getTodayDateKey,
  deriveEgaugeMeterId,
} from "./helpers";
import type {
  EnnexOsConnectionConfig,
  EgaugeAccessType,
  EgaugeConnectionConfig,
} from "./helpers";
import { maskApiKey } from "./solarConnectionFactory";
import {
  listPlants as listPlantsEnnexos,
  getPlantDetails,
  getPlantDevices,
  getPlantMeasurements,
  getPlantProductionSnapshot as getPlantProductionSnapshotEnnexos,
  getPlantDeviceSnapshot,
} from "../services/solar/ennexos";
import {
  getEgaugeLocalData,
  getEgaugePortfolioSystems,
  getEgaugeRegisterHistory,
  getEgaugeRegisterLatest,
  getEgaugeSystemInfo,
  getMeterProductionSnapshot as getMeterProductionSnapshotEgauge,
  normalizeEgaugeBaseUrl,
  normalizeEgaugePortfolioBaseUrl,
} from "../services/solar/egauge";
import {
  normalizeZendeskSubdomainInput,
  getZendeskTicketMetricsByAssignee,
} from "../services/integrations/zendesk";

export const ennexOsRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      ENNEX_OS_PROVIDER
    );
    const metadata = parseEnnexOsMetadata(
      integration?.metadata,
      toNonEmptyString(integration?.accessToken)
    );
    const activeConnection =
      metadata.connections.find(
        connection => connection.id === metadata.activeConnectionId
      ) ?? metadata.connections[0];

    return {
      connected: metadata.connections.length > 0,
      baseUrl: activeConnection?.baseUrl ?? metadata.baseUrl,
      activeConnectionId: activeConnection?.id ?? null,
      connections: metadata.connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        accessTokenMasked: maskApiKey(connection.accessToken),
        accessKeyIdMasked: maskApiKey(connection.accessToken),
        accessKeyValueMasked: connection.baseUrl,
        updatedAt: connection.updatedAt,
        isActive: connection.id === activeConnection?.id,
      })),
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        accessToken: z.string().optional(),
        accessKeyId: z.string().optional(),
        baseUrl: z.string().optional(),
        accessKeyValue: z.string().optional(),
        connectionName: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const accessToken =
        toNonEmptyString(input.accessToken) ??
        toNonEmptyString(input.accessKeyId);
      if (!accessToken) {
        throw new Error("Access token is required.");
      }

      const existing = await getIntegrationByProvider(
        ctx.user.id,
        ENNEX_OS_PROVIDER
      );
      const existingMetadata = parseEnnexOsMetadata(
        existing?.metadata,
        toNonEmptyString(existing?.accessToken)
      );
      const nowIso = new Date().toISOString();
      const newConnection: EnnexOsConnectionConfig = {
        id: nanoid(),
        name:
          toNonEmptyString(input.connectionName) ??
          `ennexOS API ${existingMetadata.connections.length + 1}`,
        accessToken,
        baseUrl:
          toNonEmptyString(input.baseUrl) ??
          toNonEmptyString(input.accessKeyValue) ??
          existingMetadata.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const connections = [newConnection, ...existingMetadata.connections];
      const activeConnectionId = newConnection.id;
      const metadata = serializeEnnexOsMetadata(
        connections,
        activeConnectionId,
        newConnection.baseUrl ?? existingMetadata.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ENNEX_OS_PROVIDER,
        accessToken: newConnection.accessToken,
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
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ENNEX_OS_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("ennexOS");
      }
      const metadataState = parseEnnexOsMetadata(
        integration.metadata,
        toNonEmptyString(integration.accessToken)
      );
      const activeConnection = metadataState.connections.find(
        connection => connection.id === input.connectionId
      );
      if (!activeConnection) {
        throw new Error("Selected ennexOS API profile was not found.");
      }

      const metadata = serializeEnnexOsMetadata(
        metadataState.connections,
        activeConnection.id,
        activeConnection.baseUrl ?? metadataState.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ENNEX_OS_PROVIDER,
        accessToken: activeConnection.accessToken,
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
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ENNEX_OS_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("ennexOS");
      }
      const metadataState = parseEnnexOsMetadata(
        integration.metadata,
        toNonEmptyString(integration.accessToken)
      );
      const nextConnections = metadataState.connections.filter(
        connection => connection.id !== input.connectionId
      );

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
        nextConnections.find(
          connection => connection.id === metadataState.activeConnectionId
        ) ?? nextConnections[0];
      const metadata = serializeEnnexOsMetadata(
        nextConnections,
        nextActiveConnection.id,
        nextActiveConnection.baseUrl ?? metadataState.baseUrl
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ENNEX_OS_PROVIDER,
        accessToken: nextActiveConnection.accessToken,
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
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      ENNEX_OS_PROVIDER
    );
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  listPlants: protectedProcedure.query(async ({ ctx }) => {
    const context = await getEnnexOsContext(ctx.user.id);
    return listPlantsEnnexos(context);
  }),
  getPlantDetails: protectedProcedure
    .input(
      z.object({
        plantId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      return getPlantDetails(context, input.plantId.trim());
    }),
  getDevices: protectedProcedure
    .input(
      z.object({
        plantId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      return getPlantDevices(context, input.plantId.trim());
    }),
  getAggData: protectedProcedure
    .input(
      z.object({
        plantId: z.string().min(1),
        from: z.string().optional(),
        to: z.string().optional(),
        period: z.enum(["Total", "Years", "Months", "Days"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      const normalizedPeriod =
        input.period === "Years"
          ? "Year"
          : input.period === "Months" || input.period === "Total"
            ? "Month"
            : "Day";
      const dateArg =
        toNonEmptyString(input.to) ?? toNonEmptyString(input.from) ?? null;
      const raw = await getPlantMeasurements(
        context,
        input.plantId.trim(),
        "EnergyBalance",
        normalizedPeriod,
        dateArg
      );
      return {
        plantId: input.plantId.trim(),
        measurementSet: "EnergyBalance",
        period: normalizedPeriod,
        from: input.from ?? null,
        to: input.to ?? null,
        date: dateArg,
        raw,
      };
    }),
  getFlowData: protectedProcedure
    .input(
      z.object({
        plantId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      const raw = await getPlantMeasurements(
        context,
        input.plantId.trim(),
        "EnergyBalance",
        "Day",
        getTodayDateKey()
      );
      return {
        plantId: input.plantId.trim(),
        measurementSet: "EnergyBalance",
        period: "Day",
        date: getTodayDateKey(),
        raw,
      };
    }),
  getMeasurements: protectedProcedure
    .input(
      z.object({
        plantId: z.string().min(1),
        measurementSet: z.string().optional(),
        period: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      return getPlantMeasurements(
        context,
        input.plantId.trim(),
        toNonEmptyString(input.measurementSet) ?? "EnergyBalance",
        toNonEmptyString(input.period) ?? "Day",
        input.date
      );
    }),
  getProductionSnapshot: protectedProcedure
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
      const context = await getEnnexOsContext(ctx.user.id);
      return getPlantProductionSnapshotEnnexos(
        context,
        input.plantId.trim(),
        input.anchorDate
      );
    }),
  getProductionSnapshots: protectedProcedure
    .input(
      z.object({
        plantIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniquePlantIds = Array.from(
        new Set(input.plantIds.map(id => id.trim()).filter(id => id.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ENNEX_OS_PROVIDER
      );
      const metadata = parseEnnexOsMetadata(
        integration?.metadata,
        toNonEmptyString(integration?.accessToken)
      );

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("ennexOS");
      }

      const activeConnection =
        allConnections.find(
          connection => connection.id === metadata.activeConnectionId
        ) ?? allConnections[0];
      const targetConnections =
        scope === "all" ? allConnections : [activeConnection];

      // Fetch plant names once upfront to include in snapshot results.
      const plantNameMap = new Map<string, string>();
      try {
        const { plants } = await listPlantsEnnexos({
          accessToken: activeConnection.accessToken,
          baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
        });
        for (const plant of plants) {
          plantNameMap.set(plant.plantId, plant.name);
        }
      } catch {
        // Non-critical — proceed without names if the list call fails.
      }

      const rows = await mapWithConcurrency(
        uniquePlantIds,
        4,
        async (plantId: string) => {
          let selectedSnapshot: Awaited<
            ReturnType<typeof getPlantProductionSnapshotEnnexos>
          > | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null =
            null;
          let firstError: string | null = null;
          let fallbackSnapshot: Awaited<
            ReturnType<typeof getPlantProductionSnapshotEnnexos>
          > | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPlantProductionSnapshotEnnexos(
              {
                accessToken: connection.accessToken,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              plantId,
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

          const anchorDate =
            selectedSnapshot?.anchorDate ??
            fallbackSnapshot?.anchorDate ??
            input.anchorDate ??
            "";
          const monthlyStartDate =
            selectedSnapshot?.monthlyStartDate ??
            fallbackSnapshot?.monthlyStartDate ??
            input.anchorDate ??
            "";
          const weeklyStartDate =
            selectedSnapshot?.weeklyStartDate ??
            fallbackSnapshot?.weeklyStartDate ??
            input.anchorDate ??
            "";
          const mtdStartDate =
            selectedSnapshot?.mtdStartDate ??
            fallbackSnapshot?.mtdStartDate ??
            input.anchorDate ??
            "";
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
            selectedSnapshot?.last12MonthsStartDate ??
            fallbackSnapshot?.last12MonthsStartDate ??
            input.anchorDate ??
            "";

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              name: plantNameMap.get(plantId) ?? null,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map(row => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError
            ? "Error"
            : "Not Found";
          return {
            plantId,
            name: plantNameMap.get(plantId) ?? null,
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
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map(row => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }
      );

      return {
        total: rows.length,
        found: rows.filter(row => row.status === "Found").length,
        notFound: rows.filter(row => row.status === "Not Found").length,
        errored: rows.filter(row => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
  getDeviceSnapshots: protectedProcedure
    .input(
      z.object({
        plantIds: z.array(z.string().min(1)).min(1).max(200),
        anchorDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        connectionScope: z.enum(["active", "all"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniquePlantIds = Array.from(
        new Set(input.plantIds.map(id => id.trim()).filter(id => id.length > 0))
      );

      const scope = input.connectionScope ?? "active";
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ENNEX_OS_PROVIDER
      );
      const metadata = parseEnnexOsMetadata(
        integration?.metadata,
        toNonEmptyString(integration?.accessToken)
      );

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("ennexOS");
      }

      const activeConnection =
        allConnections.find(
          connection => connection.id === metadata.activeConnectionId
        ) ?? allConnections[0];
      const targetConnections =
        scope === "all" ? allConnections : [activeConnection];

      const rows = await mapWithConcurrency(
        uniquePlantIds,
        4,
        async (plantId: string) => {
          let selectedSnapshot: Awaited<
            ReturnType<typeof getPlantDeviceSnapshot>
          > | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null =
            null;
          let firstError: string | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPlantDeviceSnapshot(
              {
                accessToken: connection.accessToken,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              plantId,
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
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map(row => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError
            ? "Error"
            : "Not Found";
          return {
            plantId,
            status: notFoundStatus,
            found: false,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map(row => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        }
      );

      return {
        total: rows.length,
        found: rows.filter(row => row.status === "Found").length,
        notFound: rows.filter(row => row.status === "Not Found").length,
        errored: rows.filter(row => row.status === "Error").length,
        scope,
        checkedConnections: targetConnections.length,
        rows,
      };
    }),
});

export const zendeskRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      ZENDESK_PROVIDER
    );
    const metadata = parseZendeskMetadata(integration?.metadata);

    return {
      connected: Boolean(
        toNonEmptyString(integration?.accessToken) &&
        metadata.subdomain &&
        metadata.email
      ),
      subdomain: metadata.subdomain,
      email: metadata.email,
      trackedUsers: metadata.trackedUsers,
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        subdomain: z.string().min(1),
        email: z.string().email(),
        apiToken: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existingIntegration = await getIntegrationByProvider(
        ctx.user.id,
        ZENDESK_PROVIDER
      );
      const existingMetadata = parseZendeskMetadata(
        existingIntegration?.metadata
      );

      const normalizedSubdomain = normalizeZendeskSubdomainInput(
        input.subdomain
      );
      if (!normalizedSubdomain) {
        throw new Error("Zendesk subdomain is invalid.");
      }

      const metadata = serializeZendeskMetadata({
        subdomain: normalizedSubdomain,
        email: input.email.trim().toLowerCase(),
        trackedUsers: existingMetadata.trackedUsers,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ZENDESK_PROVIDER,
        accessToken: input.apiToken.trim(),
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return { success: true };
    }),
  saveTrackedUsers: protectedProcedure
    .input(
      z.object({
        users: z.array(z.string().min(1).max(200)).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ZENDESK_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("Zendesk");
      }
      const metadata = parseZendeskMetadata(integration.metadata);
      if (!metadata.subdomain || !metadata.email) {
        throw new Error("Zendesk metadata is incomplete. Reconnect first.");
      }

      const nextMetadata = serializeZendeskMetadata({
        subdomain: metadata.subdomain,
        email: metadata.email,
        trackedUsers: input.users,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: ZENDESK_PROVIDER,
        accessToken: integration.accessToken,
        refreshToken: integration.refreshToken,
        expiresAt: integration.expiresAt,
        scope: integration.scope,
        metadata: nextMetadata,
      });

      return {
        success: true,
        trackedUsers: parseZendeskMetadata(nextMetadata).trackedUsers,
      };
    }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      ZENDESK_PROVIDER
    );
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  getTicketMetrics: protectedProcedure
    .input(
      z
        .object({
          maxTickets: z.number().int().min(100).max(50000).optional(),
          periodStartDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          periodEndDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          trackedUsersOnly: z.boolean().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        ZENDESK_PROVIDER
      );
      const metadata = parseZendeskMetadata(integration?.metadata);
      const zendeskContext = await getZendeskContext(ctx.user.id);
      return getZendeskTicketMetricsByAssignee(zendeskContext, {
        maxTickets: input?.maxTickets ?? 10000,
        periodStartDate: input?.periodStartDate,
        periodEndDate: input?.periodEndDate,
        trackedUsers: input?.trackedUsersOnly
          ? metadata.trackedUsers
          : undefined,
      });
    }),
});

export const egaugeRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      EGAUGE_PROVIDER
    );
    const metadata = parseEgaugeMetadata(
      integration?.metadata,
      toNonEmptyString(integration?.accessToken)
    );
    const activeConnection =
      metadata.connections.find(
        connection => connection.id === metadata.activeConnectionId
      ) ?? metadata.connections[0];
    const requiresCredentials = activeConnection
      ? activeConnection.accessType !== "public"
      : false;

    return {
      connected: metadata.connections.length > 0,
      baseUrl: activeConnection?.baseUrl ?? null,
      accessType: activeConnection?.accessType ?? null,
      username: activeConnection?.username ?? null,
      hasPassword: Boolean(activeConnection?.password),
      requiresCredentials,
      activeConnectionId: activeConnection?.id ?? null,
      connections: metadata.connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        meterId: connection.meterId,
        baseUrl: connection.baseUrl,
        accessType: connection.accessType,
        username: connection.username,
        hasPassword: Boolean(connection.password),
        updatedAt: connection.updatedAt,
        isActive: connection.id === activeConnection?.id,
      })),
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        connectionName: z.string().optional(),
        meterId: z.string().optional(),
        baseUrl: z.string().min(1),
        accessType: z.enum(["public", "user_login", "portfolio_login"]),
        username: z.string().optional(),
        password: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const accessType: EgaugeAccessType = input.accessType;
      const username = toNonEmptyString(input.username);
      const password = toNonEmptyString(input.password);

      const normalizedBaseUrl =
        accessType === "portfolio_login"
          ? normalizeEgaugePortfolioBaseUrl(input.baseUrl)
          : normalizeEgaugeBaseUrl(input.baseUrl);
      const resolvedUsernameForId =
        toNonEmptyString(input.username)
          ?.toLowerCase()
          .replace(/[^a-z0-9._-]/g, "_") ?? "unknown";
      const normalizedMeterId =
        toNonEmptyString(input.meterId)?.toLowerCase() ??
        (accessType === "portfolio_login"
          ? `portfolio-${resolvedUsernameForId}`
          : deriveEgaugeMeterId(normalizedBaseUrl).toLowerCase());

      const existing = await getIntegrationByProvider(
        ctx.user.id,
        EGAUGE_PROVIDER
      );
      const metadataState = parseEgaugeMetadata(
        existing?.metadata,
        toNonEmptyString(existing?.accessToken)
      );
      const nowIso = new Date().toISOString();
      const existingConnection = metadataState.connections.find(
        connection => connection.meterId === normalizedMeterId
      );
      const resolvedUsername =
        accessType === "public"
          ? null
          : (username ?? existingConnection?.username ?? null);

      const usernameChanged =
        existingConnection &&
        resolvedUsername &&
        existingConnection.username &&
        resolvedUsername.toLowerCase() !==
          existingConnection.username.toLowerCase();

      const resolvedPassword =
        accessType === "public"
          ? null
          : (password ??
            (usernameChanged ? null : (existingConnection?.password ?? null)));

      if (accessType !== "public" && (!resolvedUsername || !resolvedPassword)) {
        throw new Error(
          usernameChanged
            ? "Password is required when changing the username. Please enter the password for the new account."
            : "Username and password are required for credentialed login."
        );
      }

      let nextConnections: EgaugeConnectionConfig[];
      let activeConnectionId: string;
      if (existingConnection) {
        const updatedConnection: EgaugeConnectionConfig = {
          ...existingConnection,
          name:
            toNonEmptyString(input.connectionName) ?? existingConnection.name,
          meterId: normalizedMeterId,
          baseUrl: normalizedBaseUrl,
          accessType,
          username: resolvedUsername,
          password: resolvedPassword,
          updatedAt: nowIso,
        };
        nextConnections = [
          updatedConnection,
          ...metadataState.connections.filter(
            c => c.id !== existingConnection.id
          ),
        ];
        activeConnectionId = updatedConnection.id;
      } else {
        const newConnection: EgaugeConnectionConfig = {
          id: nanoid(),
          name:
            toNonEmptyString(input.connectionName) ??
            (accessType === "portfolio_login"
              ? `eGauge Portfolio (${toNonEmptyString(input.username) ?? "unknown"})`
              : `eGauge ${normalizedMeterId}`),
          meterId: normalizedMeterId,
          baseUrl: normalizedBaseUrl,
          accessType,
          username: resolvedUsername,
          password: resolvedPassword,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextConnections = [newConnection, ...metadataState.connections];
        activeConnectionId = newConnection.id;
      }

      const activeConnection =
        nextConnections.find(
          connection => connection.id === activeConnectionId
        ) ?? nextConnections[0];
      const metadata = serializeEgaugeMetadata(
        nextConnections,
        activeConnection.id
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: EGAUGE_PROVIDER,
        accessToken: activeConnection.password,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        activeConnectionId: activeConnection.id,
        totalConnections: nextConnections.length,
        meterId: activeConnection.meterId,
      };
    }),
  setActiveConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        EGAUGE_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("eGauge");
      }
      const metadataState = parseEgaugeMetadata(
        integration.metadata,
        toNonEmptyString(integration.accessToken)
      );
      const activeConnection = metadataState.connections.find(
        connection => connection.id === input.connectionId
      );
      if (!activeConnection) {
        throw new Error("Selected eGauge profile was not found.");
      }

      const metadata = serializeEgaugeMetadata(
        metadataState.connections,
        activeConnection.id
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: EGAUGE_PROVIDER,
        accessToken: activeConnection.password,
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
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        EGAUGE_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("eGauge");
      }

      const metadataState = parseEgaugeMetadata(
        integration.metadata,
        toNonEmptyString(integration.accessToken)
      );
      const nextConnections = metadataState.connections.filter(
        connection => connection.id !== input.connectionId
      );
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
        nextConnections.find(
          connection => connection.id === metadataState.activeConnectionId
        ) ?? nextConnections[0];
      const metadata = serializeEgaugeMetadata(
        nextConnections,
        nextActiveConnection.id
      );

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: EGAUGE_PROVIDER,
        accessToken: nextActiveConnection.password,
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
    const integration = await getIntegrationByProvider(
      ctx.user.id,
      EGAUGE_PROVIDER
    );
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  getSystemInfo: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEgaugeContext(ctx.user.id, input?.connectionId);
      if (context.accessType === "portfolio_login") {
        throw new Error(
          "System Info is meter-level. Use Fetch Portfolio Systems for portfolio access."
        );
      }
      return getEgaugeSystemInfo(context);
    }),
  getLocalData: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEgaugeContext(ctx.user.id, input?.connectionId);
      if (context.accessType === "portfolio_login") {
        throw new Error(
          "Local Data is meter-level. Use Fetch Portfolio Systems for portfolio access."
        );
      }
      return getEgaugeLocalData(context);
    }),
  getRegisterLatest: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
          register: z.string().optional(),
          includeRate: z.boolean().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEgaugeContext(ctx.user.id, input?.connectionId);
      if (context.accessType === "portfolio_login") {
        throw new Error(
          "Register Latest is meter-level. Use Fetch Portfolio Systems for portfolio access."
        );
      }
      return getEgaugeRegisterLatest(context, {
        register: input?.register,
        includeRate: input?.includeRate,
      });
    }),
  getRegisterHistory: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        intervalMinutes: z.number().int().min(1).max(1440).optional(),
        register: z.string().optional(),
        includeRate: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEgaugeContext(ctx.user.id, input.connectionId);
      if (context.accessType === "portfolio_login") {
        throw new Error(
          "Register History is meter-level. Use Fetch Portfolio Systems for portfolio access."
        );
      }
      return getEgaugeRegisterHistory(context, {
        startDate: input.startDate,
        endDate: input.endDate,
        intervalMinutes: input.intervalMinutes ?? 15,
        register: input.register,
        includeRate: input.includeRate,
      });
    }),
  getPortfolioSystems: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
          filter: z.string().optional(),
          groupId: z.string().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getEgaugeContext(ctx.user.id, input?.connectionId);
      if (context.accessType !== "portfolio_login") {
        throw new Error(
          "Switch access type to Portfolio Login, then run Fetch Portfolio Systems."
        );
      }
      const result = await getEgaugePortfolioSystems(context, {
        filter: input?.filter,
        groupId: input?.groupId,
      });
      return {
        connectionId: context.connectionId,
        connectionName: context.connectionName,
        meterId: context.meterId,
        ...result,
      };
    }),
  getProductionSnapshots: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
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
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        EGAUGE_PROVIDER
      );
      const metadata = parseEgaugeMetadata(
        integration?.metadata,
        toNonEmptyString(integration?.accessToken)
      );

      const allConnections = metadata.connections;
      if (allConnections.length === 0) {
        throw new IntegrationNotConnectedError("eGauge");
      }
      const requestedConnection =
        (toNonEmptyString(input.connectionId)
          ? allConnections.find(
              connection => connection.id === input.connectionId
            )
          : undefined) ??
        allConnections.find(
          connection => connection.id === metadata.activeConnectionId
        ) ??
        allConnections[0];
      if (!requestedConnection) {
        throw new IntegrationNotConnectedError("eGauge");
      }
      if (
        toNonEmptyString(input.connectionId) &&
        requestedConnection.id !== input.connectionId
      ) {
        throw new Error("Selected eGauge profile was not found.");
      }

      const anchorDate = input.anchorDate ?? formatTodayKey();

      const requestedMeterIds = (input.meterIds ?? [])
        .map(id => id.trim())
        .filter(id => id.length > 0);
      const uniqueMeterIdsByKey = new Map<string, string>();
      requestedMeterIds.forEach(meterId => {
        const key = meterId.toLowerCase();
        if (!uniqueMeterIdsByKey.has(key)) {
          uniqueMeterIdsByKey.set(key, meterId);
        }
      });
      const uniqueMeterIds = Array.from(uniqueMeterIdsByKey.values());

      const usePortfolioBulk =
        requestedConnection.accessType === "portfolio_login" ||
        Boolean(input.autoFetchPortfolioIds);

      if (usePortfolioBulk) {
        if (requestedConnection.accessType !== "portfolio_login") {
          throw new Error(
            "Portfolio auto-fetch requires the selected eGauge profile to use Portfolio Login."
          );
        }

        const portfolioResult = await getEgaugePortfolioSystems(
          {
            baseUrl: requestedConnection.baseUrl,
            accessType: requestedConnection.accessType,
            username: requestedConnection.username,
            password: requestedConnection.password,
          },
          {
            filter: input.filter,
            groupId: input.groupId,
            anchorDate,
          }
        );

        const portfolioRowsByMeterId = new Map(
          portfolioResult.rows.map(row => [
            row.meterId.trim().toLowerCase(),
            row,
          ])
        );

        const rows =
          uniqueMeterIds.length > 0
            ? uniqueMeterIds.map(meterId => {
                const matchedRow = portfolioRowsByMeterId.get(
                  meterId.toLowerCase()
                );
                if (matchedRow) return matchedRow;
                return {
                  meterId,
                  meterName: null,
                  status: "Not Found" as const,
                  found: false,
                  lifetimeKwh: null,
                  anchorDate,
                  error: `Meter ID "${meterId}" was not returned by the portfolio site list.`,
                };
              })
            : portfolioResult.rows;

        return {
          total: rows.length,
          found: rows.filter(row => row.status === "Found").length,
          notFound: rows.filter(row => row.status === "Not Found").length,
          errored: rows.filter(row => row.status === "Error").length,
          source: "portfolio" as const,
          connectionId: requestedConnection.id,
          connectionName: requestedConnection.name,
          meterIdsUsed: rows.map(row => row.meterId),
          rows,
        };
      }

      // Build map from meterId to non-portfolio meter connections for quick lookup.
      const connectionByMeterId = new Map(
        allConnections
          .filter(conn => conn.accessType !== "portfolio_login")
          .map(conn => [conn.meterId.toLowerCase(), conn])
      );

      if (uniqueMeterIds.length === 0) {
        throw new Error("Provide at least one meter ID.");
      }

      const rows = await mapWithConcurrency(
        uniqueMeterIds,
        4,
        async (meterId: string) => {
          const conn = connectionByMeterId.get(meterId.toLowerCase());
          if (!conn) {
            return {
              meterId,
              meterName: null,
              status: "Not Found" as const,
              found: false,
              lifetimeKwh: null,
              anchorDate,
              error: `No saved connection for meter ID "${meterId}".`,
            };
          }

          return getMeterProductionSnapshotEgauge(
            {
              baseUrl: conn.baseUrl,
              accessType: conn.accessType,
              username: conn.username,
              password: conn.password,
            },
            meterId,
            conn.name,
            anchorDate
          );
        }
      );

      return {
        total: rows.length,
        found: rows.filter(row => row.status === "Found").length,
        notFound: rows.filter(row => row.status === "Not Found").length,
        errored: rows.filter(row => row.status === "Error").length,
        source: "saved_connections" as const,
        meterIdsUsed: uniqueMeterIds,
        rows,
      };
    }),
  getAllPortfolioSnapshots: protectedProcedure
    .input(
      z
        .object({
          filter: z.string().optional(),
          groupId: z.string().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        EGAUGE_PROVIDER
      );
      const metadata = parseEgaugeMetadata(
        integration?.metadata,
        toNonEmptyString(integration?.accessToken)
      );

      const portfolioConnections = metadata.connections.filter(
        c => c.accessType === "portfolio_login" && c.username && c.password
      );

      if (portfolioConnections.length === 0) {
        throw new Error(
          "No portfolio login connections found. Save at least one Portfolio Login profile first."
        );
      }

      const portfolioResults: Array<{
        connectionId: string;
        connectionName: string;
        username: string | null;
        total: number;
        found: number;
        error: string | null;
      }> = [];
      const seenMeterIds = new Set<string>();
      const mergedRows: Array<Record<string, unknown>> = [];

      for (const conn of portfolioConnections) {
        try {
          const result = await getEgaugePortfolioSystems(
            {
              baseUrl: conn.baseUrl,
              accessType: conn.accessType,
              username: conn.username,
              password: conn.password,
            },
            {
              filter: input?.filter,
              groupId: input?.groupId,
            }
          );

          portfolioResults.push({
            connectionId: conn.id,
            connectionName: conn.name,
            username: conn.username,
            total: result.total,
            found: result.found,
            error: null,
          });

          for (const row of result.rows) {
            const key = (row.meterId ?? "").trim().toLowerCase();
            if (key && !seenMeterIds.has(key)) {
              seenMeterIds.add(key);
              mergedRows.push({ ...row, portfolioAccount: conn.username });
            }
          }
        } catch (error) {
          portfolioResults.push({
            connectionId: conn.id,
            connectionName: conn.name,
            username: conn.username,
            total: 0,
            found: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        portfolioCount: portfolioConnections.length,
        portfolioResults,
        total: mergedRows.length,
        found: mergedRows.filter(r => r.status === "Found").length,
        notFound: mergedRows.filter(r => r.status === "Not Found").length,
        errored: mergedRows.filter(r => r.status === "Error").length,
        rows: mergedRows,
      };
    }),
});
