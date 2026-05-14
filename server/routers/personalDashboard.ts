import { formatTodayKey } from "@shared/dateKey";
import { z } from "zod";

import { protectedProcedure, router } from "../_core/trpc";
import { getPersonalDashboardCommandCenter } from "../services/personalDashboard/commandCenter";

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const personalDashboardRouter = router({
  getCommandCenter: protectedProcedure
    .input(
      z
        .object({
          dateKey: z.string().regex(DATE_KEY_REGEX).optional(),
          timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return getPersonalDashboardCommandCenter({
        userId: ctx.user.id,
        dateKey: input?.dateKey ?? formatTodayKey(),
        timezoneOffsetMinutes: input?.timezoneOffsetMinutes,
      });
    }),
});
