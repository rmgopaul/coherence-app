import { formatTodayKey } from "@shared/dateKey";
import { z } from "zod";

import { protectedProcedure, router } from "../_core/trpc";
import { getPersonalDashboardCommandCenter } from "../services/personalDashboard/commandCenter";
import {
  getPersonalDashboardDailyState,
  upsertPersonalDashboardDailyState,
} from "../db";

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const dashboardSourceKindSchema = z.enum([
  "todoist",
  "calendar",
  "gmail",
  "dock",
  "daily_brief",
  "today_plan",
  "weekly_review",
  "health",
  "system",
]);
const dashboardSourceSchema = z.enum([
  ...dashboardSourceKindSchema.options,
  "google",
  "drive",
  "clockify",
  "whoop",
  "samsungHealth",
  "weather",
  "news",
]);

const dailyBriefSchema = z.object({
  headline: z.string().min(1).max(500),
  summary: z.string().max(4000).nullable(),
  generatedAt: z.string().datetime().nullable(),
  sourceRefs: z
    .array(
      z.object({
        source: dashboardSourceSchema,
        id: z.string().max(255).nullable(),
        label: z.string().min(1).max(255),
        url: z.string().url().nullable(),
      })
    )
    .max(50),
});

const todayPlanSchema = z.object({
  topPriority: z.string().max(500).nullable(),
  notes: z.string().max(4000).nullable(),
  blocks: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().min(1).max(500),
        startIso: z.string().datetime().nullable(),
        endIso: z.string().datetime().nullable(),
        source: dashboardSourceKindSchema,
        sourceId: z.string().max(255).nullable(),
        status: z.enum(["planned", "active", "done", "skipped"]),
      })
    )
    .max(40),
  updatedAt: z.string().datetime().nullable(),
});

const commitmentSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(500),
  source: dashboardSourceSchema,
  sourceId: z.string().max(255).nullable(),
  owner: z.string().max(255).nullable(),
  dueAt: z.string().datetime().nullable(),
  status: z.enum(["open", "waiting", "done", "blocked"]),
  url: z.string().url().nullable(),
});

const outcomeSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(500),
  status: z.enum(["active", "won", "missed", "paused"]),
  metricLabel: z.string().max(255).nullable(),
  target: z.string().max(255).nullable(),
  current: z.string().max(255).nullable(),
});

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

  getDailyState: protectedProcedure
    .input(
      z
        .object({
          dateKey: z.string().regex(DATE_KEY_REGEX).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const dateKey = input?.dateKey ?? formatTodayKey();
      return getPersonalDashboardDailyState(ctx.user.id, dateKey);
    }),

  saveDailyState: protectedProcedure
    .input(
      z.object({
        dateKey: z.string().regex(DATE_KEY_REGEX).optional(),
        dailyBriefStatus: z
          .enum(["not_started", "draft", "ready", "failed"])
          .optional(),
        dailyBrief: dailyBriefSchema.nullable().optional(),
        todayPlanStatus: z
          .enum(["not_started", "draft", "ready", "completed"])
          .optional(),
        todayPlan: todayPlanSchema.nullable().optional(),
        commitments: z.array(commitmentSchema).max(100).optional(),
        outcomes: z.array(outcomeSchema).max(50).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dateKey = input.dateKey ?? formatTodayKey();
      return upsertPersonalDashboardDailyState(ctx.user.id, dateKey, {
        dailyBriefStatus: input.dailyBriefStatus,
        dailyBrief: input.dailyBrief,
        todayPlanStatus: input.todayPlanStatus,
        todayPlan: input.todayPlan,
        commitments: input.commitments,
        outcomes: input.outcomes,
      });
    }),
});
