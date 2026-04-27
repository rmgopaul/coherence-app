/**
 * Task 5.9 PR-A (2026-04-27) — standalone Solar REC sub-router for
 * CSG Portal credentials. Migrated out of `csgPortalRouter` in
 * `server/routers/jobRunners.ts`.
 *
 * Module key: `solar-rec-settings` (this is credential management,
 * which lives under the Settings module per Task 5.1's matrix).
 * `status` is `read`; `saveCredentials` and `testConnection` are
 * `admin` because they manage credentials.
 *
 * Credential storage stays on the per-user `integrations` table for
 * now. CSG portal credentials are used by Contract Scrape Manager,
 * DIN Scrape Manager, and ABP Invoice Settlement — every consumer
 * resolves the credential via `getIntegrationByProvider(userId,
 * CSG_PORTAL_PROVIDER)` against the calling user. Single-tenant
 * prod has only Rhett's tokens; multi-tenant future work will move
 * this to `solarRecTeamCredentials` for true team-shared CSG access.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { t, requirePermission } from "./solarRecBase";

export const solarRecCsgPortalRouter = t.router({
  status: requirePermission("solar-rec-settings", "read").query(
    async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("../db");
      const { CSG_PORTAL_PROVIDER } = await import(
        "../routers/helpers/constants"
      );
      const { parseCsgPortalMetadata } = await import(
        "../routers/helpers/providerMetadata"
      );
      const { toNonEmptyString } = await import(
        "../services/core/addressCleaning"
      );
      const integration = await getIntegrationByProvider(
        ctx.userId,
        CSG_PORTAL_PROVIDER
      );
      const metadata = parseCsgPortalMetadata(integration?.metadata);
      return {
        connected: Boolean(
          toNonEmptyString(integration?.accessToken) && metadata.email
        ),
        email: metadata.email,
        baseUrl: metadata.baseUrl,
        hasPassword: Boolean(toNonEmptyString(integration?.accessToken)),
        lastTestedAt: metadata.lastTestedAt,
        lastTestStatus: metadata.lastTestStatus,
        lastTestMessage: metadata.lastTestMessage,
      };
    }
  ),

  saveCredentials: requirePermission("solar-rec-settings", "admin")
    .input(
      z.object({
        email: z.string().email().optional(),
        password: z.string().min(1).optional(),
        baseUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getIntegrationByProvider, upsertIntegration } = await import(
        "../db"
      );
      const { CSG_PORTAL_PROVIDER } = await import(
        "../routers/helpers/constants"
      );
      const { parseCsgPortalMetadata, serializeCsgPortalMetadata } =
        await import("../routers/helpers/providerMetadata");
      const { toNonEmptyString } = await import(
        "../services/core/addressCleaning"
      );

      const existing = await getIntegrationByProvider(
        ctx.userId,
        CSG_PORTAL_PROVIDER
      );
      const existingMetadata = parseCsgPortalMetadata(existing?.metadata);

      const resolvedEmail =
        toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
      const resolvedPassword =
        toNonEmptyString(input.password) ??
        toNonEmptyString(existing?.accessToken);
      const resolvedBaseUrl =
        toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;

      if (!resolvedEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Portal email is required.",
        });
      }
      if (!resolvedPassword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Portal password is required.",
        });
      }

      const metadata = serializeCsgPortalMetadata({
        email: resolvedEmail,
        baseUrl: resolvedBaseUrl,
        lastTestedAt: existingMetadata.lastTestedAt,
        lastTestStatus: existingMetadata.lastTestStatus,
        lastTestMessage: existingMetadata.lastTestMessage,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.userId,
        provider: CSG_PORTAL_PROVIDER,
        accessToken: resolvedPassword,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return { success: true };
    }),

  testConnection: requirePermission("solar-rec-settings", "admin")
    .input(
      z
        .object({
          email: z.string().email().optional(),
          password: z.string().min(1).optional(),
          baseUrl: z.string().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const { getIntegrationByProvider, upsertIntegration } = await import(
        "../db"
      );
      const { CSG_PORTAL_PROVIDER } = await import(
        "../routers/helpers/constants"
      );
      const { parseCsgPortalMetadata, serializeCsgPortalMetadata } =
        await import("../routers/helpers/providerMetadata");
      const { toNonEmptyString } = await import(
        "../services/core/addressCleaning"
      );
      const { testCsgPortalCredentials } = await import(
        "../services/integrations/csgPortal"
      );

      const existing = await getIntegrationByProvider(
        ctx.userId,
        CSG_PORTAL_PROVIDER
      );
      const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
      const resolvedEmail =
        toNonEmptyString(input?.email)?.toLowerCase() ?? existingMetadata.email;
      const resolvedPassword =
        toNonEmptyString(input?.password) ??
        toNonEmptyString(existing?.accessToken);
      const resolvedBaseUrl =
        toNonEmptyString(input?.baseUrl) ?? existingMetadata.baseUrl;

      if (!resolvedEmail || !resolvedPassword) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Missing credentials. Save portal email/password first or provide both for testing.",
        });
      }

      try {
        await testCsgPortalCredentials({
          email: resolvedEmail,
          password: resolvedPassword,
          baseUrl: resolvedBaseUrl ?? undefined,
        });

        const metadata = serializeCsgPortalMetadata({
          email: resolvedEmail,
          baseUrl: resolvedBaseUrl,
          lastTestedAt: new Date().toISOString(),
          lastTestStatus: "success",
          lastTestMessage: "Connection successful.",
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.userId,
          provider: CSG_PORTAL_PROVIDER,
          accessToken: resolvedPassword,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          message: "Connected successfully.",
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown portal connection error.";
        if (existing && existingMetadata.email && existing.accessToken) {
          const metadata = serializeCsgPortalMetadata({
            email: existingMetadata.email,
            baseUrl: existingMetadata.baseUrl,
            lastTestedAt: new Date().toISOString(),
            lastTestStatus: "failure",
            lastTestMessage: message,
          });

          await upsertIntegration({
            id: nanoid(),
            userId: ctx.userId,
            provider: CSG_PORTAL_PROVIDER,
            accessToken: existing.accessToken,
            refreshToken: null,
            expiresAt: null,
            scope: null,
            metadata,
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Portal connection test failed: ${message}`,
        });
      }
    }),
});
