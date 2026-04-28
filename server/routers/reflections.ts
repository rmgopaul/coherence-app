/**
 * tRPC procs for the user's nightly reflection journal.
 *
 *   - `getToday`  — read this evening's reflection (or null if not
 *                   yet captured). Drives the in-app reflection
 *                   panel's "edit existing" vs. "create new" branch.
 *   - `getRecent` — last N entries, defaults to 14 (~2 weeks). Powers
 *                   the trend chart of self-rated energy that the
 *                   weekly review draws on.
 *   - `upsertToday` — single mutation for save/edit. Idempotent on
 *                   (userId, dateKey). All fields optional so the
 *                   user can save a partial reflection (e.g. only
 *                   the energy slider) without losing the rest of
 *                   the row.
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { formatTodayKey } from "@shared/dateKey";

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const reflectionsRouter = router({
  getToday: protectedProcedure
    .input(
      z
        .object({ dateKey: z.string().regex(DATE_KEY_REGEX).optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const { getReflectionByDate } = await import("../db");
      const dateKey = input?.dateKey ?? formatTodayKey();
      const row = await getReflectionByDate(ctx.user.id, dateKey);
      return { dateKey, reflection: row };
    }),

  getRecent: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(60).optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const { listRecentReflections } = await import("../db");
      const rows = await listRecentReflections(ctx.user.id, input?.limit ?? 14);
      return rows;
    }),

  upsertToday: protectedProcedure
    .input(
      z.object({
        dateKey: z.string().regex(DATE_KEY_REGEX).optional(),
        energyLevel: z.number().int().min(1).max(10).nullable().optional(),
        wentWell: z.string().max(2000).nullable().optional(),
        didntGo: z.string().max(2000).nullable().optional(),
        tomorrowOneThing: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { upsertReflection } = await import("../db");
      const dateKey = input.dateKey ?? formatTodayKey();
      const row = await upsertReflection({
        userId: ctx.user.id,
        dateKey,
        energyLevel: input.energyLevel ?? null,
        wentWell: input.wentWell ?? null,
        didntGo: input.didntGo ?? null,
        tomorrowOneThing: input.tomorrowOneThing ?? null,
      });
      return { dateKey, reflection: row };
    }),
});
