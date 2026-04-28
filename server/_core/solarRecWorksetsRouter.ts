/**
 * Task 9.2 (2026-04-28) — Solar REC `worksets.*` standalone sub-router.
 *
 * Saved CSG-ID worksets, scoped per team and visible to every team
 * member. Used by the Phase 9 detail page (Task 9.4) and the future
 * "Load workset" picker the existing job pages will gain in Task 9.3.
 *
 * Module gate: `portfolio-workbench`.
 *   - `read` for list/get
 *   - `edit` for create/update/delete/append
 *
 * The DB helpers (`server/db/idWorksets.ts`) own the data model
 * (dedupe, length cap, name uniqueness). The router is a thin Zod
 * → typed-error mapping plus permission gates.
 *
 * Versioning: `_runnerVersion: "solar-rec-worksets@1"` ships on
 * every response so deploys are observable per the CLAUDE.md rule.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t, requirePermission } from "./solarRecBase";

export const SOLAR_REC_WORKSETS_ROUTER_VERSION = "solar-rec-worksets@1";

const csgIdSchema = z.string().trim().min(1).max(64);
const csgIdArraySchema = z.array(csgIdSchema).max(10_000);

function asConflict(err: unknown): TRPCError | null {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "IdWorksetNameConflictError"
  ) {
    return new TRPCError({
      code: "CONFLICT",
      message: (err as Error).message,
    });
  }
  return null;
}

function asNotFound(err: unknown): TRPCError | null {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "IdWorksetNotFoundError"
  ) {
    return new TRPCError({
      code: "NOT_FOUND",
      message: (err as Error).message,
    });
  }
  return null;
}

export const solarRecWorksetsRouter = t.router({
  /**
   * Team-visible list of worksets in the caller's scope. Returns
   * summaries (no csgIds) so the picker can show 100+ entries
   * cheaply; clients fetch detail via `get` on selection.
   */
  list: requirePermission("portfolio-workbench", "read").query(
    async ({ ctx }) => {
      const { listIdWorksets } = await import("../db");
      const worksets = await listIdWorksets(ctx.scopeId);
      return {
        _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
        worksets,
      };
    }
  ),

  get: requirePermission("portfolio-workbench", "read")
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { getIdWorkset } = await import("../db");
      const workset = await getIdWorkset(ctx.scopeId, input.id);
      if (!workset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workset "${input.id}" not found`,
        });
      }
      return {
        _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
        workset,
      };
    }),

  create: requirePermission("portfolio-workbench", "edit")
    .input(
      z.object({
        name: z.string().trim().min(1).max(255),
        description: z.string().max(2000).optional(),
        csgIds: csgIdArraySchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { createIdWorkset } = await import("../db");
      try {
        const workset = await createIdWorkset(ctx.scopeId, {
          name: input.name,
          description: input.description ?? null,
          csgIds: input.csgIds,
          createdByUserId: ctx.userId,
        });
        return {
          _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
          workset,
        };
      } catch (err) {
        const conflict = asConflict(err);
        if (conflict) throw conflict;
        throw err;
      }
    }),

  /**
   * Patch-style update. Pass only the fields you want to change;
   * unset fields keep their existing values. Returns the post-update
   * detail. `editedByUserId` is taken from `ctx.userId`.
   */
  update: requirePermission("portfolio-workbench", "edit")
    .input(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(255).optional(),
        description: z.string().max(2000).nullable().optional(),
        csgIds: csgIdArraySchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { updateIdWorkset } = await import("../db");
      try {
        const workset = await updateIdWorkset(ctx.scopeId, input.id, {
          name: input.name,
          description: input.description,
          csgIds: input.csgIds,
          editedByUserId: ctx.userId,
        });
        return {
          _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
          workset,
        };
      } catch (err) {
        const conflict = asConflict(err);
        if (conflict) throw conflict;
        const notFound = asNotFound(err);
        if (notFound) throw notFound;
        throw err;
      }
    }),

  delete: requirePermission("portfolio-workbench", "edit")
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { deleteIdWorkset } = await import("../db");
      const deleted = await deleteIdWorkset(ctx.scopeId, input.id);
      return {
        _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
        deleted,
      };
    }),

  /** Append CSG IDs to an existing workset. Idempotent — duplicates
   *  in input or with existing IDs are no-ops. Returns the post-
   *  append detail. */
  append: requirePermission("portfolio-workbench", "edit")
    .input(
      z.object({
        id: z.string().min(1).max(64),
        csgIds: csgIdArraySchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { appendCsgIdsToWorkset } = await import("../db");
      try {
        const workset = await appendCsgIdsToWorkset(ctx.scopeId, input.id, {
          csgIds: input.csgIds,
          editedByUserId: ctx.userId,
        });
        return {
          _runnerVersion: SOLAR_REC_WORKSETS_ROUTER_VERSION,
          workset,
        };
      } catch (err) {
        const notFound = asNotFound(err);
        if (notFound) throw notFound;
        throw err;
      }
    }),
});

export type SolarRecWorksetsRouter = typeof solarRecWorksetsRouter;
