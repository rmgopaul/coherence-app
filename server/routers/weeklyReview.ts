/**
 * Phase E (2026-04-28) — AI Weekly Review tRPC procs.
 *
 * Three procedures:
 *   - `getLatest`     — most-recent persisted review for the user.
 *                        Used by the dashboard card.
 *   - `list`          — recent reviews, default 12 (~3 months).
 *                        Used by /weekly-review history page if/when
 *                        we ship one.
 *   - `regenerate`    — manually trigger generation for a specific
 *                        weekKey. Useful when an Anthropic outage
 *                        caused the cron to write a `failed` row
 *                        and the user wants to retry without
 *                        waiting for next Monday.
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";

const WEEK_KEY_REGEX = /^\d{4}-W\d{2}$/;

export const weeklyReviewRouter = router({
  getLatest: protectedProcedure.query(async ({ ctx }) => {
    const { getLatestWeeklyReview } = await import("../db");
    const row = await getLatestWeeklyReview(ctx.user.id);
    return row;
  }),

  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { listWeeklyReviewsForUser } = await import("../db");
      const rows = await listWeeklyReviewsForUser(
        ctx.user.id,
        input?.limit ?? 12
      );
      return rows;
    }),

  regenerate: protectedProcedure
    .input(
      z.object({
        weekKey: z
          .string()
          .regex(WEEK_KEY_REGEX, "weekKey must be in 'YYYY-Www' format"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { generateWeeklyReviewForUser } = await import(
        "../services/notifications/weeklyReview"
      );
      const result = await generateWeeklyReviewForUser(
        ctx.user.id,
        input.weekKey
      );
      return result;
    }),
});
