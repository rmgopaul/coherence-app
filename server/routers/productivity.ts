import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  parseJsonMetadata,
  resolveOpenAIModel,
  toNullableScore,
  getTodayDateKey,
  CLOCKIFY_PROVIDER,
  parseClockifyMetadata,
  getClockifyContext,
} from "./helpers";
import { toNonEmptyString } from "../services/core/addressCleaning";
import {
  addMessage,
  createConversation,
  deleteConversation,
  deleteIntegration,
  getConversationMessages,
  getConversations,
  getConversationSummaries,
  getIntegrationByProvider,
  upsertIntegration,
} from "../db";
import { getValidGoogleToken, getValidWhoopToken } from "../helpers/tokenRefresh";
import {
  getClockifyCurrentUser,
  getClockifyInProgressTimeEntry,
  getClockifyRecentTimeEntries,
  listClockifyWorkspaces,
  startClockifyTimeEntry,
  stopClockifyInProgressTimeEntry,
} from "../services/integrations/clockify";
import {
  getTodoistTasks,
  getTodoistProjects,
  getTodoistCompletedTaskCount,
  getTodoistCompletedTasks,
  createTodoistTask,
  completeTodoistTask,
} from "../services/integrations/todoist";
import {
  getGoogleCalendarEvents,
  getGmailMessages,
  getGmailWaitingOn,
  markGmailMessageAsRead,
  getGoogleDriveFiles,
  createGoogleSpreadsheet,
  searchGoogleDrive,
} from "../services/integrations/google";
import { getWhoopSummary } from "../services/integrations/whoop";

export const clockifyRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
    const metadata = parseClockifyMetadata(integration?.metadata);

    return {
      connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.workspaceId && metadata.userId),
      workspaceId: metadata.workspaceId,
      workspaceName: metadata.workspaceName,
      userId: metadata.userId,
      userName: metadata.userName,
      userEmail: metadata.userEmail,
    };
  }),
  connect: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().min(1),
        workspaceId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existingIntegration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
      const existingMetadata = parseClockifyMetadata(existingIntegration?.metadata);

      const apiKey = input.apiKey.trim();
      const user = await getClockifyCurrentUser(apiKey);
      const workspaces = await listClockifyWorkspaces(apiKey);

      const requestedWorkspaceId = toNonEmptyString(input.workspaceId);
      let resolvedWorkspace =
        requestedWorkspaceId
          ? workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ?? null
          : null;

      if (requestedWorkspaceId && !resolvedWorkspace) {
        throw new Error("The selected Clockify workspace ID was not found for this API key.");
      }

      if (!resolvedWorkspace) {
        const preferredWorkspaceId =
          existingMetadata.workspaceId ?? user.activeWorkspaceId ?? user.defaultWorkspaceId;
        resolvedWorkspace =
          (preferredWorkspaceId
            ? workspaces.find((workspace) => workspace.id === preferredWorkspaceId)
            : null) ?? workspaces[0] ?? null;
      }

      if (!resolvedWorkspace) {
        throw new Error("No Clockify workspace was found for this account.");
      }

      const metadata = JSON.stringify({
        workspaceId: resolvedWorkspace.id,
        workspaceName: resolvedWorkspace.name,
        userId: user.id,
        userName: user.name || null,
        userEmail: user.email,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: CLOCKIFY_PROVIDER,
        accessToken: apiKey,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });

      return {
        success: true,
        workspaceId: resolvedWorkspace.id,
        workspaceName: resolvedWorkspace.name,
        userName: user.name || null,
        userEmail: user.email,
      };
    }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
    if (integration?.id) {
      await deleteIntegration(integration.id);
    }
    return { success: true };
  }),
  getCurrentEntry: protectedProcedure.query(async ({ ctx }) => {
    const context = await getClockifyContext(ctx.user.id);
    return getClockifyInProgressTimeEntry(
      context.apiKey,
      context.workspaceId,
      context.clockifyUserId
    );
  }),
  getRecentEntries: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const context = await getClockifyContext(ctx.user.id);
      return getClockifyRecentTimeEntries(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId,
        input?.limit ?? 20
      );
    }),
  startTimer: protectedProcedure
    .input(
      z.object({
        description: z.string().min(1).max(300),
        projectId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const context = await getClockifyContext(ctx.user.id);
      const currentEntry = await getClockifyInProgressTimeEntry(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId
      );
      if (currentEntry?.isRunning) {
        throw new Error("A Clockify timer is already running. Stop it before starting a new one.");
      }

      return startClockifyTimeEntry(context.apiKey, context.workspaceId, {
        description: input.description,
        projectId: toNonEmptyString(input.projectId),
      });
    }),
  stopTimer: protectedProcedure.mutation(async ({ ctx }) => {
    const context = await getClockifyContext(ctx.user.id);
    const stoppedEntry = await stopClockifyInProgressTimeEntry(
      context.apiKey,
      context.workspaceId,
      context.clockifyUserId
    );
    return {
      success: true,
      stopped: Boolean(stoppedEntry),
      entry: stoppedEntry,
    };
  }),
});

export const todoistRouter = router({
  connect: protectedProcedure
    .input(z.object({ apiToken: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, "todoist");
      const metadata = existing?.metadata ?? JSON.stringify({ defaultFilter: "all" });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: "todoist",
        accessToken: input.apiToken,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata,
      });
      return { success: true };
    }),
  getTasks: protectedProcedure
    .input(z.object({ filter: z.string().max(500).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      return getTodoistTasks(integration.accessToken, input?.filter);
    }),
  getProjects: protectedProcedure.query(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
    if (!integration?.accessToken) {
      throw new Error("Todoist not connected");
    }
    return getTodoistProjects(integration.accessToken);
  }),
  getCompletedCount: protectedProcedure
    .input(
      z
        .object({
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      const dateKey = input?.dateKey ?? getTodayDateKey();
      const count = await getTodoistCompletedTaskCount(
        integration.accessToken,
        dateKey,
        input?.timezoneOffsetMinutes
      );
      return { dateKey, count };
    }),
  getCompletedDebug: protectedProcedure
    .input(
      z
        .object({
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      const dateKey = input?.dateKey ?? getTodayDateKey();
      const tasks = await getTodoistCompletedTasks(
        integration.accessToken,
        dateKey,
        input?.timezoneOffsetMinutes
      );
      return {
        dateKey,
        timezoneOffsetMinutes: input?.timezoneOffsetMinutes ?? null,
        count: tasks.length,
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          content: task.content,
          completedAt: task.completedAt,
          dateKey: task.dateKey,
        })),
      };
    }),
  saveSettings: protectedProcedure
    .input(z.object({ defaultFilter: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }

      const existingMetadata = parseJsonMetadata(integration.metadata);
      const metadata = JSON.stringify({
        ...existingMetadata,
        defaultFilter: input.defaultFilter,
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: "todoist",
        accessToken: integration.accessToken,
        refreshToken: integration.refreshToken,
        expiresAt: integration.expiresAt,
        scope: integration.scope,
        metadata,
      });

      return { success: true, defaultFilter: input.defaultFilter };
    }),
  createTask: protectedProcedure
    .input(z.object({
      content: z.string(),
      description: z.string().optional(),
      projectId: z.string().optional(),
      priority: z.number().min(1).max(4).optional(),
      dueString: z.string().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      return createTodoistTask(
        integration.accessToken,
        input.content,
        input.description,
        input.projectId,
        input.priority,
        input.dueString,
        input.dueDate
      );
    }),
  completeTask: protectedProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      await completeTodoistTask(integration.accessToken, input.taskId);
      return { success: true };
    }),
  createTaskFromEmail: protectedProcedure
    .input(z.object({
      subject: z.string(),
      emailLink: z.string(),
      body: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      // Find the Inbox project
      const projects = await getTodoistProjects(integration.accessToken);
      const inboxProject = projects.find(p => p.name.toLowerCase() === "inbox");

      const taskContent = `[${input.subject}](${input.emailLink})`;
      const taskDescription = input.body || '';

      return createTodoistTask(
        integration.accessToken,
        taskContent,
        taskDescription,
        inboxProject?.id,
        undefined
      );
    }),
});

export const conversationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getConversations(ctx.user.id);
  }),
  listSummaries: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(300).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return getConversationSummaries(ctx.user.id, input?.limit ?? 100);
    }),
  create: protectedProcedure
    .input(z.object({ title: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const id = await createConversation(ctx.user.id, input.title);
      return { id };
    }),
  getMessages: protectedProcedure
    .input(z.object({ conversationId: z.string().max(64) }))
    .query(async ({ input }) => {
      return getConversationMessages(input.conversationId);
    }),
  delete: protectedProcedure
    .input(z.object({ conversationId: z.string().max(64) }))
    .mutation(async ({ ctx, input }) => {
      await deleteConversation(input.conversationId, ctx.user.id);
      return { success: true };
    }),
});

export const openaiRouter = router({
  connect: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().max(512).optional(),
        model: z.string().max(64).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, "openai");
      const incomingKey = input.apiKey?.trim();
      const accessToken = incomingKey || existing?.accessToken || null;

      if (!accessToken) {
        throw new Error("OpenAI API key is required");
      }

      const existingModel = resolveOpenAIModel(existing?.metadata);
      const requestedModel = input.model?.trim();
      const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: "openai",
        accessToken,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata: JSON.stringify({ model }),
      });
      return { success: true, model };
    }),
  generateDailyOverview: protectedProcedure
    .input(
      z.object({
        date: z.string(),
        weather: z
          .object({
            summary: z.string(),
            location: z.string().optional(),
            temperatureF: z.number().optional(),
          })
          .optional(),
        todoistTasks: z
          .array(
            z.object({
              content: z.string(),
              due: z.string().optional(),
              priority: z.number().optional(),
            })
          )
          .max(20),
        calendarEvents: z
          .array(
            z.object({
              summary: z.string(),
              start: z.string().optional(),
              location: z.string().optional(),
            })
          )
          .max(20),
        prioritizedEmails: z
          .array(
            z.object({
              from: z.string().optional(),
              subject: z.string(),
              snippet: z.string().optional(),
              date: z.string().optional(),
              reason: z.string().optional(),
            })
          )
          .max(20),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "openai");
      if (!integration?.accessToken) {
        throw new Error("OpenAI not connected");
      }

      const weatherLine = input.weather
        ? `Weather: ${input.weather.summary}${input.weather.location ? ` in ${input.weather.location}` : ""}`
        : "Weather: unavailable";

      const taskLines =
        input.todoistTasks.length > 0
          ? input.todoistTasks
              .map((task) => {
                const priority = task.priority ? `P${task.priority}` : "P4";
                return `- [${priority}] ${task.content}${task.due ? ` (Due: ${task.due})` : ""}`;
              })
              .join("\n")
          : "- None";

      const eventLines =
        input.calendarEvents.length > 0
          ? input.calendarEvents
              .map(
                (event) =>
                  `- ${event.summary}${event.start ? ` (${event.start})` : ""}${
                    event.location ? ` @ ${event.location}` : ""
                  }`
              )
              .join("\n")
          : "- None";

      const emailLines =
        input.prioritizedEmails.length > 0
          ? input.prioritizedEmails
              .map(
                (email) =>
                  `- ${email.subject}${email.from ? ` from ${email.from}` : ""}${
                    email.reason ? ` | Reason: ${email.reason}` : ""
                  }${email.date ? ` | Date: ${email.date}` : ""}`
              )
              .join("\n")
          : "- None";

      const safeNumber = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;

      let whoopLine = "WHOOP: unavailable";
      const whoopIntegration = await getIntegrationByProvider(ctx.user.id, "whoop");
      if (whoopIntegration?.accessToken) {
        try {
          const accessToken = await getValidWhoopToken(ctx.user.id);
          const whoop = await getWhoopSummary(accessToken);

          const recovery = safeNumber(whoop.recoveryScore);
          const sleepHours = safeNumber(whoop.sleepHours);
          const strain = safeNumber(whoop.dayStrain);
          const restingHr = safeNumber(whoop.restingHeartRate);
          const hrv = safeNumber(whoop.hrvRmssdMilli);
          const spo2 = safeNumber(whoop.spo2Percentage);

          whoopLine = [
            `WHOOP: recovery ${recovery !== null ? `${Math.round(recovery)}%` : "N/A"}`,
            `sleep ${sleepHours !== null ? `${sleepHours.toFixed(1)}h` : "N/A"}`,
            `strain ${strain !== null ? strain.toFixed(1) : "N/A"}`,
            `resting HR ${restingHr !== null ? `${Math.round(restingHr)} bpm` : "N/A"}`,
            `HRV ${hrv !== null ? `${Math.round(hrv)} ms` : "N/A"}`,
            `SpO2 ${spo2 !== null ? `${Math.round(spo2)}%` : "N/A"}`,
          ].join(", ");
        } catch (error) {
          console.error("Failed to fetch WHOOP summary for daily overview:", error);
        }
      }

      let samsungLine = "Samsung Health: unavailable";
      const samsungIntegration = await getIntegrationByProvider(ctx.user.id, "samsung-health");
      if (samsungIntegration?.metadata) {
        const metadata = parseJsonMetadata(samsungIntegration.metadata);
        const summary =
          metadata.summary && typeof metadata.summary === "object"
            ? (metadata.summary as Record<string, unknown>)
            : {};
        const manualScores =
          metadata.manualScores && typeof metadata.manualScores === "object"
            ? (metadata.manualScores as Record<string, unknown>)
            : {};

        const steps = safeNumber(summary.steps);
        const sleepMinutes = safeNumber(summary.sleepTotalMinutes);
        const spo2 = safeNumber(summary.spo2AvgPercent);
        const sleepScore = safeNumber(manualScores.sleepScore) ?? safeNumber(summary.sleepScore);
        const energyScore = safeNumber(manualScores.energyScore) ?? safeNumber(summary.energyScore);
        const receivedAt =
          typeof metadata.receivedAt === "string" && metadata.receivedAt.length > 0
            ? metadata.receivedAt
            : null;

        samsungLine = [
          `Samsung Health: steps ${steps !== null ? Math.round(steps).toLocaleString() : "N/A"}`,
          `sleep ${sleepMinutes !== null ? `${(sleepMinutes / 60).toFixed(1)}h` : "N/A"}`,
          `SpO2 ${spo2 !== null ? `${spo2.toFixed(1)}%` : "N/A"}`,
          `sleep score ${sleepScore !== null ? sleepScore : "N/A"}`,
          `energy score ${energyScore !== null ? energyScore : "N/A"}`,
          `last sync ${receivedAt ?? "N/A"}`,
        ].join(", ");
      }

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${integration.accessToken}`,
        },
        body: JSON.stringify({
          model: resolveOpenAIModel(integration.metadata),
          messages: [
            {
              role: "system",
              content:
                "You generate concise daily productivity overviews in clean GitHub-flavored markdown. Use exactly these headings: '## Summary', '## Must Do Today', '## Priority Emails', '## Risks & Follow-ups'. Under each heading, use 2-5 bullet points with '- '. Keep to about 120-180 words. Do not output any extra headings or prose outside these sections. Explicitly factor in health and recovery context (WHOOP and Samsung Health) when setting workload intensity and sequencing. If health data is available, mention at least one concrete WHOOP or Samsung metric in the output.",
            },
            {
              role: "user",
              content: `Date: ${input.date}\n${weatherLine}\n\nTodoist items due today:\n${taskLines}\n\nToday's calendar events:\n${eventLines}\n\nPriority emails (date/language based):\n${emailLines}\n\nHealth and recovery context:\n- ${whoopLine}\n- ${samsungLine}\n\nGenerate the daily overview now using the exact heading and bullet format.`,
            },
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.error?.message || "Failed to generate daily overview");
      }

      const data = await response.json();
      const overview = data?.choices?.[0]?.message?.content;
      if (!overview || typeof overview !== "string") {
        throw new Error("Invalid overview response from OpenAI");
      }

      return { overview };
    }),
  generatePipelineReport: protectedProcedure
    .input(
      z.object({
        generatedAt: z.string(),
        rows3Year: z.array(
          z.object({
            month: z.string(),
            part1Count: z.number(), part2Count: z.number(),
            part1KwAc: z.number(), part2KwAc: z.number(),
            interconnectedCount: z.number(), interconnectedKwAc: z.number(),
            prevPart1Count: z.number(), prevPart2Count: z.number(),
            prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
            prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
          })
        ),
        rows12Month: z.array(
          z.object({
            month: z.string(),
            part1Count: z.number(), part2Count: z.number(),
            part1KwAc: z.number(), part2KwAc: z.number(),
            interconnectedCount: z.number(), interconnectedKwAc: z.number(),
            prevPart1Count: z.number(), prevPart2Count: z.number(),
            prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
            prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
          })
        ),
        summaryTotals: z.object({
          threeYear: z.object({
            totalPart1: z.number(), totalPart2: z.number(),
            totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
            totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
          }),
          twelveMonth: z.object({
            totalPart1: z.number(), totalPart2: z.number(),
            totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
            totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
          }),
        }),
        cashFlowSummary: z.object({
          rows12Month: z.array(z.object({
            month: z.string(),
            vendorFee: z.number(),
            ccAuthCollateral: z.number(),
            additionalCollateral: z.number(),
            totalCashFlow: z.number(),
            projectCount: z.number(),
          })),
          totalVendorFee12Mo: z.number(),
          totalCollateral12Mo: z.number(),
          totalCashFlow12Mo: z.number(),
        }).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "openai");
      if (!integration?.accessToken) {
        throw new Error("OpenAI not connected. Please add your API key in Settings.");
      }

      const formatRows = (rows: typeof input.rows3Year) =>
        rows
          .map(
            (r) =>
              `${r.month}: P1=${r.part1Count} (${r.part1KwAc.toFixed(1)} kW), P2=${r.part2Count} (${r.part2KwAc.toFixed(1)} kW), IC=${r.interconnectedCount} (${r.interconnectedKwAc.toFixed(1)} kW) | PY: P1=${r.prevPart1Count}, P2=${r.prevPart2Count}, IC=${r.prevInterconnectedCount}`
          )
          .join("\n");

      const systemMessage = {
        role: "system" as const,
        content: `You are a solar energy portfolio analyst generating a professional report on application pipeline trends. Write in clear, professional prose with markdown formatting. Use these exact sections:

## Executive Summary
A 3-4 sentence high-level summary of the pipeline health.

## Application Volume Trends
Analysis of Part I submissions and Part II verifications -- monthly patterns, seasonality, acceleration or deceleration. Use concise prose, not raw data dumps.

## Capacity Trends (kW AC)
Analysis of capacity flowing through the pipeline -- average system sizes, capacity growth, and how kW AC trends differ from count trends.

## Interconnection Analysis
Trends in systems going online -- throughput rates, bottlenecks, and how interconnection volume compares to application volume.

## Year-over-Year Comparison
Summarize YoY changes in 2-3 concise sentences covering the most significant shifts. Focus on the overall trend direction and magnitude rather than listing every month individually. State the trailing-12-month totals vs. prior-year totals for Part I, Part II, and Interconnected with percentage change. Do NOT list individual monthly comparisons.

## Cash Flow Forecast
If cash flow data is provided, analyze the monthly revenue (vendor fee) and collateral obligations (CC Auth 5%, Additional Collateral) flowing to CSG. Note the M+1 lag: Part II verification in month M triggers an invoice on the 1st of M+1, with payment by end of M+1. Identify trends in revenue volume and collateral burden. State trailing-12-month total vendor fee revenue and total cash flow. If no cash flow data is provided, omit this section entirely.

## Key Risks & Opportunities
2-4 bullet points identifying risks (declining volumes, growing backlogs) and opportunities (capacity growth, improving conversion rates).

FORMATTING RULES:
- Write in concise professional prose. Avoid cramming multiple statistics into a single sentence.
- When citing numbers, round kW values to the nearest whole number or one decimal (e.g. 47.6 MW, not 47600.1 kW).
- Use "MW" for values above 1,000 kW (divide by 1,000).
- Do NOT use asterisks for emphasis within numbers or percentages. Use plain text.
- Keep the total analysis to 400-600 words.`,
      };

      const t3 = input.summaryTotals.threeYear;
      const t12 = input.summaryTotals.twelveMonth;
      const userMessage = {
        role: "user" as const,
        content: `Report generated: ${input.generatedAt}

3-YEAR PIPELINE DATA (monthly):
${formatRows(input.rows3Year)}

3-Year Totals: Part I: ${t3.totalPart1} apps (${t3.totalPart1KwAc.toFixed(1)} kW), Part II: ${t3.totalPart2} apps (${t3.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t3.totalInterconnected} (${t3.totalInterconnectedKwAc.toFixed(1)} kW)

12-MONTH PIPELINE DATA (monthly):
${formatRows(input.rows12Month)}

12-Month Totals: Part I: ${t12.totalPart1} apps (${t12.totalPart1KwAc.toFixed(1)} kW), Part II: ${t12.totalPart2} apps (${t12.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t12.totalInterconnected} (${t12.totalInterconnectedKwAc.toFixed(1)} kW)
${input.cashFlowSummary ? `
CASH FLOW DATA (Last 12 Months — month shown is the payment month, M+1 from Part II verification):
${input.cashFlowSummary.rows12Month.map((r) => `${r.month}: VendorFee=$${r.vendorFee.toFixed(2)}, CcAuth=$${r.ccAuthCollateral.toFixed(2)}, AddlColl=$${r.additionalCollateral.toFixed(2)}, Total=$${r.totalCashFlow.toFixed(2)}, Projects=${r.projectCount}`).join("\n")}

Cash Flow 12-Month Totals: Vendor Fee Revenue: $${input.cashFlowSummary.totalVendorFee12Mo.toFixed(2)}, Collateral: $${input.cashFlowSummary.totalCollateral12Mo.toFixed(2)}, Total Cash Flow: $${input.cashFlowSummary.totalCashFlow12Mo.toFixed(2)}
` : ""}
Generate the pipeline analysis report now.`,
      };

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${integration.accessToken}`,
        },
        body: JSON.stringify({
          model: resolveOpenAIModel(integration.metadata),
          messages: [systemMessage, userMessage],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        console.error("OpenAI pipeline report error:", response.status, errorBody);
        let errorMessage = "Failed to generate pipeline report";
        try {
          const parsed = JSON.parse(errorBody);
          errorMessage = parsed?.error?.message || errorMessage;
        } catch {}
        throw new Error(`OpenAI API error (${response.status}): ${errorMessage}`);
      }

      const data = await response.json();
      const analysis = (data as any)?.choices?.[0]?.message?.content;
      if (!analysis || typeof analysis !== "string") {
        throw new Error("Invalid response from OpenAI");
      }

      return { analysis };
    }),
  chat: protectedProcedure
    .input(z.object({ conversationId: z.string().max(64), message: z.string().min(1).max(32000) }))
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "openai");
      if (!integration?.accessToken) {
        throw new Error("OpenAI not connected");
      }

      // Fetch productivity data if available
      let contextParts: string[] = [];

      // Todoist context
      const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (todoistIntegration?.accessToken) {
        try {
          const [tasks, projects] = await Promise.all([
            getTodoistTasks(todoistIntegration.accessToken),
            getTodoistProjects(todoistIntegration.accessToken)
          ]);

          const projectMap = new Map(projects.map(p => [p.id, p.name]));
          const taskList = tasks.slice(0, 50).map(t => {
            const projectName = projectMap.get(t.projectId) || "Inbox";
            const priority = ["P4", "P3", "P2", "P1"][t.priority - 1] || "P4";
            return `- [${priority}] ${t.content}${t.description ? ` (${t.description})` : ""} [${projectName}]${t.due ? ` Due: ${t.due.string}` : ""}`;
          }).join("\n");

          contextParts.push(`TODOIST TASKS (${tasks.length} total):\n${taskList}`);
        } catch (error) {
          console.error("Failed to fetch Todoist data:", error);
        }
      }

      // Google Calendar context
      const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
      if (googleIntegration?.accessToken) {
        try {
          const events = await getGoogleCalendarEvents(googleIntegration.accessToken);

          const eventList = events.slice(0, 20).map(e => {
            const start = e.start.dateTime || e.start.date || "";
            const end = e.end.dateTime || e.end.date || "";
            return `- ${e.summary || "Untitled"} (${start} to ${end})${e.location ? ` @ ${e.location}` : ""}`;
          }).join("\n");

          contextParts.push(`GOOGLE CALENDAR (${events.length} upcoming events):\n${eventList}`);
        } catch (error) {
          console.error("Failed to fetch Google Calendar data:", error);
        }
      }

      // Gmail context
      if (googleIntegration?.accessToken) {
        try {
          const messages = await getGmailMessages(googleIntegration.accessToken, 10);

          const emailList = messages.map(m => {
            const from = m.payload.headers.find((h: any) => h.name === "From")?.value || "Unknown";
            const subject = m.payload.headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
            const date = m.payload.headers.find((h: any) => h.name === "Date")?.value || "";
            return `- From: ${from}\n  Subject: ${subject}\n  Date: ${date}\n  Preview: ${m.snippet}`;
          }).join("\n\n");

          contextParts.push(`GMAIL (${messages.length} recent emails):\n${emailList}`);
        } catch (error) {
          console.error("Failed to fetch Gmail data:", error);
        }
      }

      const productivityContext = contextParts.length > 0
        ? `\n\nYou have access to the user's productivity data:\n\n${contextParts.join("\n\n")}\n\nYou can analyze, summarize, or provide insights about their tasks, schedule, and emails when relevant to their question.`
        : "";

      // Save user message
      await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "user", content: input.message });

      // Get conversation history
      const history = await getConversationMessages(input.conversationId);
      const conversationMessages = history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content
      }));

      const systemMessage = {
        role: "system" as const,
        content: `You are a helpful productivity assistant. You help users manage their tasks, schedule, and productivity.${productivityContext}`
      };

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${integration.accessToken}`,
        },
        body: JSON.stringify({
          model: resolveOpenAIModel(integration.metadata),
          messages: [
            systemMessage,
            ...conversationMessages
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || "OpenAI API error");
      }

      const data = await response.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error("Invalid response from OpenAI");
      }

      const reply = data.choices[0].message.content;

      // Save assistant message
      await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "assistant", content: reply });

      return { reply };
    }),
});

export const googleRouter = router({
  getCalendarEvents: protectedProcedure
    .input(
      z
        .object({
          startIso: z.string().datetime().optional(),
          endIso: z.string().datetime().optional(),
          daysAhead: z.number().int().min(1).max(365).optional(),
          maxResults: z.number().int().min(1).max(250).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const events = await getGoogleCalendarEvents(accessToken, {
          startIso: input?.startIso,
          endIso: input?.endIso,
          daysAhead: input?.daysAhead,
          maxResults: input?.maxResults,
        });
        console.log(`[Google Calendar] Fetched ${events.length} events`);
        return events;
      } catch (error) {
        console.error("[Google Calendar] Error fetching events:", error);
        throw error;
      }
    }),
  getGmailMessages: protectedProcedure
    .input(z.object({ maxResults: z.number().int().min(1).max(800).optional() }).optional())
    .query(async ({ ctx, input }) => {
    const accessToken = await getValidGoogleToken(ctx.user.id);
    return getGmailMessages(accessToken, input?.maxResults ?? 50);
  }),
  getGmailWaitingOn: protectedProcedure
    .input(z.object({ maxResults: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accessToken = await getValidGoogleToken(ctx.user.id);
      return getGmailWaitingOn(accessToken, input?.maxResults ?? 25);
    }),
  markGmailAsRead: protectedProcedure
    .input(z.object({ messageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const accessToken = await getValidGoogleToken(ctx.user.id);
      await markGmailMessageAsRead(accessToken, input.messageId);
      return { success: true };
    }),
  getDriveFiles: protectedProcedure.query(async ({ ctx }) => {
    try {
      const accessToken = await getValidGoogleToken(ctx.user.id);
      const files = await getGoogleDriveFiles(accessToken);
      console.log(`[Google Drive] Fetched ${files.length} files`);
      return files;
    } catch (error) {
      console.error("[Google Drive] Error fetching files:", error);
      throw error;
    }
  }),
  createSpreadsheet: protectedProcedure
    .input(z.object({ title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const result = await createGoogleSpreadsheet(accessToken, input.title);
        console.log(`[Google Sheets] Created spreadsheet: ${input.title}`);
        return result;
      } catch (error) {
        console.error("[Google Sheets] Error creating spreadsheet:", error);
        throw error;
      }
    }),
  searchDrive: protectedProcedure
    .input(z.object({ query: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const files = await searchGoogleDrive(accessToken, input.query);
        console.log(`[Google Drive Search] Found ${files.length} files for query: ${input.query}`);
        return files;
      } catch (error) {
        console.error("[Google Drive Search] Error searching Drive:", error);
        throw error;
      }
    }),
});

export const whoopRouter = router({
  getSummary: protectedProcedure.query(async ({ ctx }) => {
    const accessToken = await getValidWhoopToken(ctx.user.id);
    return getWhoopSummary(accessToken);
  }),
});

export const samsungHealthRouter = router({
  getConfig: protectedProcedure.query(async () => {
    const syncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY?.trim() || "";
    const userIdRaw = process.env.SAMSUNG_HEALTH_USER_ID?.trim() || "1";
    const userId = Number.parseInt(userIdRaw, 10);
    return {
      syncKey,
      hasSyncKey: syncKey.length > 0,
      userId: Number.isFinite(userId) && userId > 0 ? userId : 1,
    };
  }),
  saveManualScores: protectedProcedure
    .input(
      z.object({
        sleepScore: z.number().min(0).max(100).nullable(),
        energyScore: z.number().min(0).max(100).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, "samsung-health");
      const existingMetadata = parseJsonMetadata(existing?.metadata);
      const existingSummary =
        existingMetadata.summary && typeof existingMetadata.summary === "object"
          ? (existingMetadata.summary as Record<string, unknown>)
          : {};
      const existingManual =
        existingMetadata.manualScores && typeof existingMetadata.manualScores === "object"
          ? (existingMetadata.manualScores as Record<string, unknown>)
          : {};

      const sleepScore = input.sleepScore;
      const energyScore = input.energyScore;

      const nextMetadata = JSON.stringify({
        ...existingMetadata,
        summary: {
          ...existingSummary,
          sleepScore: toNullableScore(sleepScore),
          energyScore: toNullableScore(energyScore),
        },
        manualScores: {
          sleepScore: toNullableScore(sleepScore),
          energyScore: toNullableScore(energyScore),
        },
        manualScoresUpdatedAt: new Date().toISOString(),
      });

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: "samsung-health",
        accessToken: existing?.accessToken ?? null,
        refreshToken: existing?.refreshToken ?? null,
        expiresAt: existing?.expiresAt ?? null,
        scope: existing?.scope ?? null,
        metadata: nextMetadata,
      });

      return {
        success: true,
        manualScores: {
          sleepScore: toNullableScore(sleepScore),
          energyScore: toNullableScore(energyScore),
        },
      };
    }),
});
