/**
 * Task 5.11 PR-A (2026-04-27) — standalone Solar REC sub-router for
 * the Zendesk Ticket Metrics page. Migrated out of `zendeskRouter`
 * in `server/routers/solarMisc.ts` (deleted by this PR — that file
 * had no other exports left after the 2026-04-26 cleanup #109).
 *
 * Module key: `zendesk-metrics`. Reads use `read`, config saves use
 * `edit`, credential management (connect/disconnect) uses `admin`.
 *
 * Credentials note: `integrations[provider='zendesk']` is still keyed
 * by userId (per-user) under the standalone context's `ctx.userId`.
 * Single-tenant prod is functionally identical to the pre-migration
 * behavior. Future task: move Zendesk credentials to
 * `solarRecTeamCredentials` for true team-wide tokens — same pattern
 * as the 16 vendor migrations in Task 5.4.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { t, requirePermission } from "./solarRecBase";

export const solarRecZendeskRouter = t.router({
  getStatus: requirePermission("zendesk-metrics", "read").query(
    async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("../db");
      const { ZENDESK_PROVIDER, parseZendeskMetadata, toNonEmptyString } =
        await import("../routers/helpers");
      const integration = await getIntegrationByProvider(
        ctx.userId,
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
    }
  ),

  connect: requirePermission("zendesk-metrics", "admin")
    .input(
      z.object({
        subdomain: z.string().min(1),
        email: z.string().email(),
        apiToken: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getIntegrationByProvider, upsertIntegration } = await import(
        "../db"
      );
      const { ZENDESK_PROVIDER, parseZendeskMetadata, serializeZendeskMetadata } =
        await import("../routers/helpers");
      const { normalizeZendeskSubdomainInput } = await import(
        "../services/integrations/zendesk"
      );

      const existingIntegration = await getIntegrationByProvider(
        ctx.userId,
        ZENDESK_PROVIDER
      );
      const existingMetadata = parseZendeskMetadata(
        existingIntegration?.metadata
      );

      const normalizedSubdomain = normalizeZendeskSubdomainInput(
        input.subdomain
      );
      if (!normalizedSubdomain) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Zendesk subdomain is invalid.",
        });
      }

      const metadata = serializeZendeskMetadata({
        subdomain: normalizedSubdomain,
        email: input.email.trim().toLowerCase(),
        trackedUsers: existingMetadata.trackedUsers,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.userId,
        provider: ZENDESK_PROVIDER,
        accessToken: input.apiToken.trim(),
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return { success: true };
    }),

  saveTrackedUsers: requirePermission("zendesk-metrics", "edit")
    .input(
      z.object({
        users: z.array(z.string().min(1).max(200)).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getIntegrationByProvider, upsertIntegration } = await import(
        "../db"
      );
      const {
        ZENDESK_PROVIDER,
        parseZendeskMetadata,
        serializeZendeskMetadata,
        IntegrationNotConnectedError,
      } = await import("../routers/helpers");
      const integration = await getIntegrationByProvider(
        ctx.userId,
        ZENDESK_PROVIDER
      );
      if (!integration) {
        throw new IntegrationNotConnectedError("Zendesk");
      }
      const metadata = parseZendeskMetadata(integration.metadata);
      if (!metadata.subdomain || !metadata.email) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Zendesk metadata is incomplete. Reconnect first.",
        });
      }

      const nextMetadata = serializeZendeskMetadata({
        subdomain: metadata.subdomain,
        email: metadata.email,
        trackedUsers: input.users,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.userId,
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

  disconnect: requirePermission("zendesk-metrics", "admin").mutation(
    async ({ ctx }) => {
      const { getIntegrationByProvider, deleteIntegration } = await import(
        "../db"
      );
      const { ZENDESK_PROVIDER } = await import("../routers/helpers");
      const integration = await getIntegrationByProvider(
        ctx.userId,
        ZENDESK_PROVIDER
      );
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }
  ),

  getTicketMetrics: requirePermission("zendesk-metrics", "read")
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
      const { getIntegrationByProvider } = await import("../db");
      const { ZENDESK_PROVIDER, parseZendeskMetadata, getZendeskContext } =
        await import("../routers/helpers");
      const { getZendeskTicketMetricsByAssignee } = await import(
        "../services/integrations/zendesk"
      );
      const integration = await getIntegrationByProvider(
        ctx.userId,
        ZENDESK_PROVIDER
      );
      const metadata = parseZendeskMetadata(integration?.metadata);
      const zendeskContext = await getZendeskContext(ctx.userId);
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
