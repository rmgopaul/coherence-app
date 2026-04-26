import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  deleteIntegration,
  getIntegrationByProvider,
  upsertIntegration,
} from "../db";
import {
  IntegrationNotConnectedError,
  ZENDESK_PROVIDER,
  getZendeskContext,
  parseZendeskMetadata,
  serializeZendeskMetadata,
  toNonEmptyString,
} from "./helpers";
import {
  getZendeskTicketMetricsByAssignee,
  normalizeZendeskSubdomainInput,
} from "../services/integrations/zendesk";

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
