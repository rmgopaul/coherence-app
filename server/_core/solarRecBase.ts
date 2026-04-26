/**
 * Shared base for the standalone Solar REC tRPC router tree.
 *
 * Extracted from `_core/solarRecRouter.ts` so multiple sub-router
 * source files (e.g. `solarRecDashboardRouter.ts`) can share the same
 * `t` instance and `requirePermission` middleware without creating a
 * circular dependency on the composition file.
 *
 * Anything that defines or shapes the SolarRecContext should live
 * here — sub-routers should only import what they need (`t`,
 * `requirePermission`, etc.). `createSolarRecContext` itself stays in
 * `solarRecRouter.ts` because the Express middleware mount in
 * `_core/index.ts` already imports it from there; moving it would
 * widen the touch surface unnecessarily.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import { type SolarRecAuthenticatedUser } from "./solarRecAuth";
import {
  MODULE_KEYS,
  permissionAtLeast,
  type ModuleKey,
} from "../../shared/solarRecModules";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type SolarRecContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: SolarRecAuthenticatedUser | null;
  userId: number;
  scopeId: string;
};

// ---------------------------------------------------------------------------
// tRPC instance
// ---------------------------------------------------------------------------

export const t = initTRPC.context<SolarRecContext>().create({
  transformer: superjson,
});

/** Any authenticated user (no per-module gate). */
export const solarRecViewerProcedure = t.procedure;

// ---------------------------------------------------------------------------
// Module-permission helpers (Task 5.1)
// ---------------------------------------------------------------------------

export const MODULE_KEY_ZOD = z.enum(
  MODULE_KEYS as unknown as [ModuleKey, ...ModuleKey[]]
);
export const PERMISSION_LEVEL_ZOD = z.enum(["none", "read", "edit", "admin"]);
export const NON_NONE_LEVEL_ZOD = z.enum(["read", "edit", "admin"]);

export function permissionUserIdentity(user: SolarRecAuthenticatedUser) {
  return {
    id: user.id,
    isScopeAdmin: user.isScopeAdmin,
    googleOpenId: user.googleOpenId,
    email: user.email,
  };
}

/**
 * Build a procedure that requires at least `minLevel` permission on
 * `moduleKey`. Usage:
 *
 *   requirePermission('contract-scanner', 'edit').mutation(...)
 *
 * The scope owner (`solarRecScopes.ownerUserId`) and users with
 * `solarRecUsers.isScopeAdmin = true` bypass the matrix entirely and
 * always pass the gate. All other callers must have a row with
 * permission >= minLevel; missing rows are treated as `none` and 403.
 */
export function requirePermission(
  moduleKey: ModuleKey,
  minLevel: "read" | "edit" | "admin"
) {
  return t.procedure.use(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    const { resolveEffectivePermission } = await import("../db");
    const effective = await resolveEffectivePermission(
      ctx.userId,
      ctx.scopeId,
      moduleKey,
      {
        user: permissionUserIdentity(ctx.user),
      }
    );
    if (!permissionAtLeast(effective.level, minLevel)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Module ${moduleKey} requires ${minLevel} (you have ${effective.level})`,
      });
    }
    return next({ ctx: { ...ctx, modulePermission: effective.level } });
  });
}
