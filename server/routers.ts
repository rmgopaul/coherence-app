import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function parseJsonMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function resolveOpenAIModel(metadata: string | null | undefined): string {
  const parsed = parseJsonMetadata(metadata);
  const model = parsed.model;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : DEFAULT_OPENAI_MODEL;
}

function toNullableScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return null;
}

function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  integrations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserIntegrations } = await import("./db");
      return getUserIntegrations(ctx.user.id);
    }),
    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
      const { deleteIntegration } = await import("./db");
      await deleteIntegration(input.id);
      return { success: true };
    }),
  }),

  oauthCreds: router({
    get: protectedProcedure
      .input(z.object({ provider: z.string() }))
      .query(async ({ ctx, input }) => {
        const { getOAuthCredential } = await import("./db");
        return getOAuthCredential(ctx.user.id, input.provider);
      }),
    save: protectedProcedure
      .input(
        z.object({
          provider: z.string(),
          clientId: z.string(),
          clientSecret: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertOAuthCredential } = await import("./db");
        const { nanoid } = await import("nanoid");
        await upsertOAuthCredential({
          id: nanoid(),
          userId: ctx.user.id,
          provider: input.provider,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        });
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ provider: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteOAuthCredential } = await import("./db");
        await deleteOAuthCredential(ctx.user.id, input.provider);
        return { success: true };
      }),
  }),

  preferences: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const { getUserPreferences } = await import("./db");
      return getUserPreferences(ctx.user.id);
    }),
    update: protectedProcedure
      .input(
        z.object({
          displayName: z.string().max(120).nullable().optional(),
          enabledWidgets: z.string().optional(),
          widgetLayout: z.string().optional(),
          theme: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertUserPreferences } = await import("./db");
        const { nanoid } = await import("nanoid");
        await upsertUserPreferences({
          id: nanoid(),
          userId: ctx.user.id,
          ...input,
        });
        return { success: true };
      }),
  }),

  solarRecDashboard: router({
    getState: protectedProcedure.query(async ({ ctx }) => {
      try {
        const { storageGet } = await import("./storage");
        const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
        const { url } = await storageGet(key);
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.text();
        if (!payload) return null;
        return { key, payload };
      } catch {
        return null;
      }
    }),
    saveState: protectedProcedure
      .input(
        z.object({
          payload: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { storagePut } = await import("./storage");
        const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
        await storagePut(key, input.payload, "application/json");
        return { success: true, key };
      }),
  }),

  // Service-specific routers
  todoist: router({
    connect: protectedProcedure
      .input(z.object({ apiToken: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
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
      .input(z.object({ filter: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistTasks } = await import("./services/todoist");
        return getTodoistTasks(integration.accessToken, input?.filter);
      }),
    getProjects: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      const { getTodoistProjects } = await import("./services/todoist");
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
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistCompletedTaskCount } = await import("./services/todoist");
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
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistCompletedTasks } = await import("./services/todoist");
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
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }

        const { nanoid } = await import("nanoid");
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
        priority: z.number().min(1).max(4).optional()
      }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { createTodoistTask } = await import("./services/todoist");
        return createTodoistTask(
          integration.accessToken,
          input.content,
          input.description,
          input.projectId,
          input.priority
        );
      }),
    completeTask: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { completeTodoistTask } = await import("./services/todoist");
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
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { createTodoistTask, getTodoistProjects } = await import("./services/todoist");
        
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
  }),

  conversations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getConversations } = await import("./db");
      return getConversations(ctx.user.id);
    }),
    create: protectedProcedure
      .input(z.object({ title: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { createConversation } = await import("./db");
        const id = await createConversation(ctx.user.id, input.title);
        return { id };
      }),
    getMessages: protectedProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(async ({ input }) => {
        const { getConversationMessages } = await import("./db");
        return getConversationMessages(input.conversationId);
      }),
    delete: protectedProcedure
      .input(z.object({ conversationId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteConversation } = await import("./db");
        await deleteConversation(input.conversationId, ctx.user.id);
        return { success: true };
      }),
  }),

  openai: router({
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().optional(),
          model: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
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
        const { getIntegrationByProvider } = await import("./db");
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
            const { getValidWhoopToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidWhoopToken(ctx.user.id);
            const { getWhoopSummary } = await import("./services/whoop");
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
    chat: protectedProcedure
      .input(z.object({ conversationId: z.string(), message: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, getConversationMessages, addMessage } = await import("./db");
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
            const { getTodoistTasks, getTodoistProjects } = await import("./services/todoist");
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
            const { getGoogleCalendarEvents } = await import("./services/google");
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
            const { getGmailMessages } = await import("./services/google");
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
        const { nanoid } = await import("nanoid");
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
  }),

  google: router({
    getCalendarEvents: protectedProcedure.query(async ({ ctx }) => {
      try {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { getGoogleCalendarEvents } = await import("./services/google");
        const events = await getGoogleCalendarEvents(accessToken);
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
      const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
      const accessToken = await getValidGoogleToken(ctx.user.id);
      const { getGmailMessages } = await import("./services/google");
      return getGmailMessages(accessToken, input?.maxResults ?? 50);
    }),
    getGmailWaitingOn: protectedProcedure
      .input(z.object({ maxResults: z.number().int().min(1).max(100).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { getGmailWaitingOn } = await import("./services/google");
        return getGmailWaitingOn(accessToken, input?.maxResults ?? 25);
      }),
    markGmailAsRead: protectedProcedure
      .input(z.object({ messageId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { markGmailMessageAsRead } = await import("./services/google");
        await markGmailMessageAsRead(accessToken, input.messageId);
        return { success: true };
      }),
    getDriveFiles: protectedProcedure.query(async ({ ctx }) => {
      try {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { getGoogleDriveFiles } = await import("./services/google");
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
          const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const { createGoogleSpreadsheet } = await import("./services/google");
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
          const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const { searchGoogleDrive } = await import("./services/google");
          const files = await searchGoogleDrive(accessToken, input.query);
          console.log(`[Google Drive Search] Found ${files.length} files for query: ${input.query}`);
          return files;
        } catch (error) {
          console.error("[Google Drive Search] Error searching Drive:", error);
          throw error;
        }
      }),
  }),

  whoop: router({
    getSummary: protectedProcedure.query(async ({ ctx }) => {
      const { getValidWhoopToken } = await import("./helpers/tokenRefresh");
      const accessToken = await getValidWhoopToken(ctx.user.id);
      const { getWhoopSummary } = await import("./services/whoop");
      return getWhoopSummary(accessToken);
    }),
  }),

  samsungHealth: router({
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
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");

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
  }),

  metrics: router({
    getHistory: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(120).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { getDailyMetricsHistory } = await import("./db");
        return getDailyMetricsHistory(ctx.user.id, input?.limit ?? 30);
      }),
    captureToday: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const { captureDailySnapshotForUser } = await import("./services/dailySnapshot");
        await captureDailySnapshotForUser(ctx.user.id, dateKey);

        return { success: true, dateKey };
      }),
  }),

  supplements: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      const { listSupplementDefinitions } = await import("./db");
      return listSupplementDefinitions(ctx.user.id);
    }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          brand: z.string().max(128).optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          dosePerUnit: z.string().max(64).optional(),
          productUrl: z.string().max(2048).optional(),
          pricePerBottle: z.number().nonnegative().optional(),
          quantityPerBottle: z.number().nonnegative().optional(),
          timing: z.enum(["am", "pm"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listSupplementDefinitions, createSupplementDefinition } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await listSupplementDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0
            ? Math.max(...existing.map((definition) => definition.sortOrder ?? 0)) + 1
            : 0;

        await createSupplementDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing ?? "am",
          isLocked: false,
          isActive: true,
          sortOrder: nextSortOrder,
        });

        return { success: true };
      }),
    updateDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          name: z.string().min(1).max(128),
          brand: z.string().max(128).nullable().optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z.enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"]),
          dosePerUnit: z.string().max(64).nullable().optional(),
          productUrl: z.string().max(2048).nullable().optional(),
          pricePerBottle: z.number().nonnegative().nullable().optional(),
          quantityPerBottle: z.number().nonnegative().nullable().optional(),
          timing: z.enum(["am", "pm"]),
          isLocked: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { updateSupplementDefinition } = await import("./db");

        await updateSupplementDefinition(ctx.user.id, input.definitionId, {
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit,
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing,
          isLocked: input.isLocked,
        });

        return { success: true };
      }),
    setDefinitionLock: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          isLocked: z.boolean(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { setSupplementDefinitionLock } = await import("./db");
        await setSupplementDefinitionLock(ctx.user.id, input.definitionId, input.isLocked);
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { deleteSupplementDefinition } = await import("./db");
        await deleteSupplementDefinition(ctx.user.id, input.definitionId);
        return { success: true };
      }),
    getLogs: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            limit: z.number().min(1).max(200).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const {
          listSupplementLogs,
          listSupplementDefinitions,
          getSupplementLogByDefinitionAndDate,
          addSupplementLog,
        } = await import("./db");
        const { nanoid } = await import("nanoid");
        const dateKey = input?.dateKey ?? getTodayDateKey();

        const definitions = await listSupplementDefinitions(ctx.user.id);
        const locked = definitions.filter((definition) => definition.isLocked);

        for (const definition of locked) {
          const existingLog = await getSupplementLogByDefinitionAndDate(
            ctx.user.id,
            definition.id,
            dateKey
          );
          if (!existingLog) {
            await addSupplementLog({
              id: nanoid(),
              userId: ctx.user.id,
              definitionId: definition.id,
              name: definition.name,
              dose: definition.dose,
              doseUnit: definition.doseUnit,
              timing: definition.timing,
              autoLogged: true,
              notes: null,
              dateKey,
              takenAt: new Date(),
            });
          }
        }
        return listSupplementLogs(ctx.user.id, dateKey, input?.limit ?? 100);
      }),
    addLog: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          timing: z.enum(["am", "pm"]).optional(),
          notes: z.string().max(500).optional(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          definitionId: z.string().optional(),
          autoLogged: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { addSupplementLog } = await import("./db");
        const { nanoid } = await import("nanoid");
        const dateKey = input.dateKey ?? getTodayDateKey();

        await addSupplementLog({
          id: nanoid(),
          userId: ctx.user.id,
          definitionId: input.definitionId ?? null,
          name: input.name.trim(),
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          timing: input.timing ?? "am",
          autoLogged: input.autoLogged ?? false,
          notes: input.notes?.trim() || null,
          dateKey,
          takenAt: new Date(),
        });
        return { success: true };
      }),
    deleteLog: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteSupplementLog } = await import("./db");
        await deleteSupplementLog(ctx.user.id, input.id);
        return { success: true };
      }),
  }),

  habits: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      const { listHabitDefinitions } = await import("./db");
      return listHabitDefinitions(ctx.user.id);
    }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(120),
          color: z.string().min(1).max(32).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listHabitDefinitions, createHabitDefinition } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await listHabitDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0 ? Math.max(...existing.map((habit) => habit.sortOrder ?? 0)) + 1 : 0;

        await createHabitDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          color: (input.color ?? "slate").trim().toLowerCase(),
          sortOrder: nextSortOrder,
          isActive: true,
        });
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(z.object({ habitId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteHabitDefinition } = await import("./db");
        await deleteHabitDefinition(ctx.user.id, input.habitId);
        return { success: true };
      }),
    getForDate: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const { listHabitDefinitions, getHabitCompletionsByDate } = await import("./db");
        const [definitions, completions] = await Promise.all([
          listHabitDefinitions(ctx.user.id),
          getHabitCompletionsByDate(ctx.user.id, dateKey),
        ]);

        const completedMap = new Map(
          completions.map((completion) => [completion.habitId, Boolean(completion.completed)])
        );

        return definitions.map((habit) => ({
          ...habit,
          completed: completedMap.get(habit.id) ?? false,
          dateKey,
        }));
      }),
    setCompletion: protectedProcedure
      .input(
        z.object({
          habitId: z.string(),
          completed: z.boolean(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listHabitDefinitions, upsertHabitCompletion } = await import("./db");
        const dateKey = input.dateKey ?? getTodayDateKey();
        const habits = await listHabitDefinitions(ctx.user.id);
        if (!habits.some((habit) => habit.id === input.habitId)) {
          throw new Error("Habit not found");
        }
        await upsertHabitCompletion(ctx.user.id, input.habitId, dateKey, input.completed);
        return { success: true };
      }),
  }),

  notes: router({
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(1000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { listNotes, listNoteLinks } = await import("./db");
        const limit = input?.limit ?? 100;
        const [noteRows, linkRows] = await Promise.all([
          listNotes(ctx.user.id, limit),
          listNoteLinks(ctx.user.id, undefined, Math.max(limit * 10, 200)),
        ]);

        const linksByNoteId = new Map<string, any[]>();
        for (const link of linkRows) {
          const bucket = linksByNoteId.get(link.noteId) ?? [];
          bucket.push(link);
          linksByNoteId.set(link.noteId, bucket);
        }

        return noteRows.map((note) => ({
          ...note,
          links: linksByNoteId.get(note.id) ?? [],
        }));
      }),
    create: protectedProcedure
      .input(
        z.object({
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180),
          content: z.string().max(20000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote } = await import("./db");

        const noteId = nanoid();
        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: input.notebook?.trim() || "General",
          title: input.title.trim(),
          content: input.content?.trim() || "",
          pinned: input.pinned ?? false,
        });

        return { success: true, noteId };
      }),
    update: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180).optional(),
          content: z.string().max(20000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getNoteById, updateNote } = await import("./db");
        const existing = await getNoteById(ctx.user.id, input.noteId);
        if (!existing) throw new Error("Note not found");

        await updateNote(ctx.user.id, input.noteId, {
          notebook: input.notebook?.trim(),
          title: input.title?.trim(),
          content: input.content,
          pinned: input.pinned,
        });

        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ noteId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteNote } = await import("./db");
        await deleteNote(ctx.user.id, input.noteId);
        return { success: true };
      }),
    addLink: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          linkType: z.enum(["todoist_task", "google_calendar_event", "note_link", "google_drive_file"]),
          externalId: z.string().min(1).max(255),
          seriesId: z.string().max(255).optional(),
          occurrenceStartIso: z.string().max(64).optional(),
          sourceUrl: z.string().max(4096).optional(),
          sourceTitle: z.string().max(255).optional(),
          metadata: z.record(z.string(), z.any()).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { getNoteById, addNoteLink, updateNote } = await import("./db");
        const note = await getNoteById(ctx.user.id, input.noteId);
        if (!note) throw new Error("Note not found");

        const linkResult = await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId: input.noteId,
          linkType: input.linkType,
          externalId: input.externalId.trim(),
          seriesId: input.seriesId?.trim() || "",
          occurrenceStartIso: input.occurrenceStartIso?.trim() || "",
          sourceUrl: input.sourceUrl?.trim() || null,
          sourceTitle: input.sourceTitle?.trim() || null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        });

        if (linkResult.created) {
          await updateNote(ctx.user.id, input.noteId, {});
        }
        return { success: true, alreadyLinked: !linkResult.created };
      }),
    removeLink: protectedProcedure
      .input(z.object({ linkId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteNoteLink } = await import("./db");
        await deleteNoteLink(ctx.user.id, input.linkId);
        return { success: true };
      }),
    createFromTodoistTask: protectedProcedure
      .input(
        z.object({
          taskId: z.string().min(1).max(255),
          taskContent: z.string().min(1).max(1000),
          taskUrl: z.string().max(4096).optional(),
          dueDate: z.string().max(128).optional(),
          projectName: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote, addNoteLink } = await import("./db");
        const noteId = nanoid();

        const title = `Task: ${input.taskContent.slice(0, 120)}`;
        const contentLines = [
          `Task: ${input.taskContent}`,
          input.projectName ? `Project: ${input.projectName}` : null,
          input.dueDate ? `Due: ${input.dueDate}` : null,
          input.taskUrl ? `URL: ${input.taskUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Tasks",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "todoist_task",
          externalId: input.taskId,
          seriesId: "",
          occurrenceStartIso: "",
          sourceUrl: input.taskUrl?.trim() || null,
          sourceTitle: input.taskContent.slice(0, 255),
          metadata: JSON.stringify({
            dueDate: input.dueDate ?? null,
            projectName: input.projectName ?? null,
          }),
        });

        return { success: true, noteId };
      }),
    createFromCalendarEvent: protectedProcedure
      .input(
        z.object({
          eventId: z.string().min(1).max(255),
          eventSummary: z.string().min(1).max(1000),
          eventUrl: z.string().max(4096).optional(),
          start: z.string().max(128).optional(),
          location: z.string().max(500).optional(),
          recurringEventId: z.string().max(255).optional(),
          iCalUID: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote, addNoteLink } = await import("./db");
        const noteId = nanoid();

        const title = `Event: ${input.eventSummary.slice(0, 120)}`;
        const contentLines = [
          `Event: ${input.eventSummary}`,
          input.start ? `Start: ${input.start}` : null,
          input.location ? `Location: ${input.location}` : null,
          input.eventUrl ? `URL: ${input.eventUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Meetings",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "google_calendar_event",
          externalId: input.eventId,
          seriesId: (input.recurringEventId || input.iCalUID || "").trim(),
          occurrenceStartIso: input.start?.trim() || "",
          sourceUrl: input.eventUrl?.trim() || null,
          sourceTitle: input.eventSummary.slice(0, 255),
          metadata: JSON.stringify({
            location: input.location ?? null,
            recurringEventId: input.recurringEventId ?? null,
            iCalUID: input.iCalUID ?? null,
          }),
        });

        return { success: true, noteId };
      }),
  }),

  dataExport: router({
    dumpAll: protectedProcedure
      .input(
        z
          .object({
            metricsLimit: z.number().min(1).max(3650).optional(),
            logsLimit: z.number().min(1).max(5000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limits = {
          metrics: input?.metricsLimit ?? 365,
          logs: input?.logsLimit ?? 2000,
        };
        const {
          getDailyMetricsHistory,
          listSupplementLogs,
          listSupplementDefinitions,
          listHabitDefinitions,
          listHabitCompletions,
          listDailySnapshots,
          getIntegrationByProvider,
          getLatestSamsungSyncPayload,
        } = await import("./db");

        const [
          metrics,
          supplementLogs,
          supplementDefinitions,
          habitDefinitions,
          habitCompletions,
          nightlySnapshots,
          samsungIntegration,
          latestSamsungRaw,
        ] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limits.metrics),
          listSupplementLogs(ctx.user.id, undefined, limits.logs),
          listSupplementDefinitions(ctx.user.id),
          listHabitDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, limits.logs),
          listDailySnapshots(ctx.user.id, limits.metrics),
          getIntegrationByProvider(ctx.user.id, "samsung-health"),
          getLatestSamsungSyncPayload(ctx.user.id),
        ]);

        let samsungLatestMetadata: Record<string, unknown> | null = null;
        if (samsungIntegration?.metadata) {
          samsungLatestMetadata = parseJsonMetadata(samsungIntegration.metadata);
        }

        let samsungRawPayload: Record<string, unknown> | null = null;
        if (latestSamsungRaw?.payload) {
          try {
            samsungRawPayload = JSON.parse(latestSamsungRaw.payload) as Record<string, unknown>;
          } catch {
            samsungRawPayload = null;
          }
        }

        return {
          generatedAt: new Date().toISOString(),
          userId: ctx.user.id,
          tables: {
            dailyHealthMetrics: metrics,
            supplementLogs,
            supplementDefinitions,
            habitDefinitions,
            habitCompletions,
            nightlySnapshots,
          },
          latest: {
            samsungIntegrationMetadata: samsungLatestMetadata,
            samsungRawPayload,
          },
        };
      }),
    dumpStructuredCsv: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(3650).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limit = input?.limit ?? 365;
        const {
          getDailyMetricsHistory,
          listSupplementLogs,
          listSupplementDefinitions,
          listHabitCompletions,
          listHabitDefinitions,
          listDailySnapshots,
          getIntegrationByProvider,
        } = await import("./db");

        const [metrics, supplementLogs, supplementDefinitions, habitCompletions, habitDefinitions, snapshots] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limit),
          listSupplementLogs(ctx.user.id, undefined, Math.min(limit * 20, 5000)),
          listSupplementDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, Math.min(limit * 20, 5000)),
          listHabitDefinitions(ctx.user.id),
          listDailySnapshots(ctx.user.id, limit),
        ]);

        const dateSet = new Set<string>();
        for (const row of metrics) dateSet.add(row.dateKey);
        for (const row of supplementLogs) dateSet.add(row.dateKey);
        for (const row of habitCompletions) dateSet.add(row.dateKey);
        for (const row of snapshots) dateSet.add(row.dateKey);

        const nextDateKey = (dateKey: string): string => {
          const date = new Date(`${dateKey}T00:00:00`);
          if (Number.isNaN(date.getTime())) return dateKey;
          date.setDate(date.getDate() + 1);
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const toDateKey = (date: Date): string => {
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const completedTodoistTaskCountsByDate = new Map<string, number>();

        try {
          const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
          if (todoistIntegration?.accessToken) {
            const { getTodoistCompletedTasksInRange } = await import("./services/todoist");
            const todayDateKey = getTodayDateKey();
            const startDate = new Date(`${todayDateKey}T00:00:00`);
            startDate.setDate(startDate.getDate() - (limit - 1));
            const completedTasks = await getTodoistCompletedTasksInRange(
              todoistIntegration.accessToken,
              toDateKey(startDate),
              nextDateKey(todayDateKey)
            );
            for (const task of completedTasks) {
              completedTodoistTaskCountsByDate.set(
                task.dateKey,
                (completedTodoistTaskCountsByDate.get(task.dateKey) ?? 0) + 1
              );
              dateSet.add(task.dateKey);
            }
          }
        } catch (error) {
          console.error("[Data Export] Failed to load Todoist completed counts:", error);
        }

        const dateKeys = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
        const metricsByDate = new Map(metrics.map((row) => [row.dateKey, row]));

        const snapshotsByDate = new Map<string, Record<string, unknown>>();
        for (const snapshot of snapshots) {
          if (!snapshot.samsungPayload && !snapshot.whoopPayload) continue;
          snapshotsByDate.set(snapshot.dateKey, {
            whoopPayload: snapshot.whoopPayload,
            samsungPayload: snapshot.samsungPayload,
          });
        }

        const supplementKey = (name: string, timing: string, doseUnit: string) =>
          `${name.trim().toLowerCase()}|${timing.trim().toLowerCase()}|${doseUnit.trim().toLowerCase()}`;
        const supplementLabel = (name: string, timing: string, doseUnit: string) =>
          `Supplement: ${name} | Timing: ${timing.toUpperCase()} | Unit: ${doseUnit}`;
        const parseDoseNumber = (value: string): number | null => {
          const trimmed = value.trim();
          if (!trimmed) return null;
          const match = trimmed.match(/-?\d+(\.\d+)?/);
          if (!match) return null;
          const parsed = Number(match[0]);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const formatAmount = (value: number): string => {
          if (!Number.isFinite(value)) return "0";
          if (Number.isInteger(value)) return String(value);
          return value.toFixed(3).replace(/\.?0+$/, "");
        };

        const supplementByKey = new Map<
          string,
          { label: string; sortOrder: number }
        >();
        for (const definition of supplementDefinitions) {
          const key = supplementKey(definition.name, definition.timing, definition.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(definition.name, definition.timing, definition.doseUnit),
              sortOrder: definition.sortOrder ?? Number.MAX_SAFE_INTEGER,
            });
          }
        }

        const supplementAmountsByKey = new Map<string, Map<string, number>>();
        for (const log of supplementLogs) {
          const key = supplementKey(log.name, log.timing, log.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(log.name, log.timing, log.doseUnit),
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = supplementAmountsByKey.get(key) ?? new Map<string, number>();
          const numericDose = parseDoseNumber(log.dose);
          const currentTotal = byDate.get(log.dateKey) ?? 0;
          byDate.set(log.dateKey, currentTotal + (numericDose ?? 0));
          supplementAmountsByKey.set(key, byDate);
        }

        const habitById = new Map<
          string,
          { label: string; sortOrder: number }
        >(
          habitDefinitions.map((habit) => [
            habit.id,
            { label: habit.name, sortOrder: habit.sortOrder ?? Number.MAX_SAFE_INTEGER },
          ])
        );
        const habitCompletionsById = new Map<string, Map<string, boolean>>();
        for (const completion of habitCompletions) {
          if (!habitById.has(completion.habitId)) {
            habitById.set(completion.habitId, {
              label: completion.habitId,
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = habitCompletionsById.get(completion.habitId) ?? new Map<string, boolean>();
          byDate.set(completion.dateKey, Boolean(completion.completed));
          habitCompletionsById.set(completion.habitId, byDate);
        }

        const supplementRows = Array.from(supplementByKey.entries())
          .map(([key, value]) => ({ key, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));
        const habitRows = Array.from(habitById.entries())
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));

        const asObj = (value: unknown): Record<string, unknown> =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const asNum = (value: unknown): number | null =>
          typeof value === "number" && Number.isFinite(value) ? value : null;
        const parseJson = (value: unknown): Record<string, unknown> => {
          if (typeof value !== "string" || !value) return {};
          try {
            return asObj(JSON.parse(value));
          } catch {
            return {};
          }
        };
        const getWhoop = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const whoopPayload = parseJson(row?.whoopPayload);
          return asNum(whoopPayload[key]);
        };
        const getSamsungSummary = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const summary = asObj(samsungPayload.summary);
          return asNum(summary[key]);
        };
        const getSamsungRaw = (dateKey: string, section: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const sectionObj = asObj(samsungPayload[section]);
          return asNum(sectionObj[key]);
        };
        const getSamsungSleepHoursFallback = (dateKey: string): number | null => {
          const summaryMinutes = getSamsungSummary(dateKey, "sleepTotalMinutes");
          if (summaryMinutes !== null) {
            return Number((summaryMinutes / 60).toFixed(1));
          }
          const rawMinutes = getSamsungRaw(dateKey, "sleep", "totalSleepMinutes");
          if (rawMinutes !== null) {
            return Number((rawMinutes / 60).toFixed(1));
          }
          return null;
        };

        const csvRows: string[][] = [];
        const addMetricRow = (
          label: string,
          getter: (dateKey: string) => string | number | null | undefined
        ) => {
          csvRows.push([
            label,
            ...dateKeys.map((dateKey) => {
              const value = getter(dateKey);
              return value === null || value === undefined ? "" : String(value);
            }),
          ]);
        };
        const addSectionRow = (label: string) => {
          csvRows.push([label, ...dateKeys.map(() => "")]);
        };

        addMetricRow("WHOOP Recovery %", (dateKey) => metricsByDate.get(dateKey)?.whoopRecoveryScore ?? getWhoop(dateKey, "recoveryScore"));
        addMetricRow("WHOOP Day Strain", (dateKey) => metricsByDate.get(dateKey)?.whoopDayStrain ?? getWhoop(dateKey, "dayStrain"));
        addMetricRow("WHOOP Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.whoopSleepHours ?? getWhoop(dateKey, "sleepHours"));
        addMetricRow("WHOOP HRV ms", (dateKey) => metricsByDate.get(dateKey)?.whoopHrvMs ?? getWhoop(dateKey, "hrvRmssdMilli"));
        addMetricRow("WHOOP Resting HR bpm", (dateKey) => metricsByDate.get(dateKey)?.whoopRestingHr ?? getWhoop(dateKey, "restingHeartRate"));
        addMetricRow("WHOOP Sleep Performance %", (dateKey) => getWhoop(dateKey, "sleepPerformance"));
        addMetricRow("WHOOP Sleep Efficiency %", (dateKey) => getWhoop(dateKey, "sleepEfficiency"));
        addMetricRow("WHOOP Sleep Consistency %", (dateKey) => getWhoop(dateKey, "sleepConsistency"));
        addMetricRow("WHOOP Respiratory Rate", (dateKey) => getWhoop(dateKey, "respiratoryRate"));
        addMetricRow("WHOOP SpO2 %", (dateKey) => getWhoop(dateKey, "spo2Percentage"));
        addMetricRow("WHOOP Avg HR bpm", (dateKey) => getWhoop(dateKey, "averageHeartRate"));
        addMetricRow("WHOOP Max HR bpm", (dateKey) => getWhoop(dateKey, "maxHeartRate"));

        addMetricRow("Samsung Steps", (dateKey) => metricsByDate.get(dateKey)?.samsungSteps ?? getSamsungSummary(dateKey, "steps") ?? getSamsungRaw(dateKey, "activity", "steps"));
        addMetricRow("Samsung Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepHours ?? getSamsungSleepHoursFallback(dateKey));
        addMetricRow("Samsung SpO2 Avg %", (dateKey) => metricsByDate.get(dateKey)?.samsungSpo2AvgPercent ?? getSamsungSummary(dateKey, "spo2AvgPercent") ?? getSamsungRaw(dateKey, "oxygenAndTemperature", "spo2AvgPercent"));
        addMetricRow("Samsung Sleep Score", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepScore ?? getSamsungSummary(dateKey, "sleepScore") ?? getSamsungRaw(dateKey, "sleep", "sleepScore"));
        addMetricRow("Samsung Energy Score", (dateKey) => metricsByDate.get(dateKey)?.samsungEnergyScore ?? getSamsungSummary(dateKey, "energyScore") ?? getSamsungRaw(dateKey, "cardio", "recoveryScore"));
        addMetricRow("Todoist Completed Tasks", (dateKey) => {
          const liveCount = completedTodoistTaskCountsByDate.get(dateKey) ?? null;
          if (liveCount !== null) return liveCount;
          return metricsByDate.get(dateKey)?.todoistCompletedCount ?? 0;
        });

        addSectionRow("Habits");
        if (habitRows.length === 0) {
          addMetricRow("No habits configured", () => "");
        } else {
          for (const habit of habitRows) {
            addMetricRow(habit.label, (dateKey) => {
              const completed = habitCompletionsById.get(habit.id)?.get(dateKey) ?? false;
              return completed ? 1 : 0;
            });
          }
        }

        addSectionRow("Supplements");
        if (supplementRows.length === 0) {
          addMetricRow("No supplements configured", () => "");
        } else {
          for (const supplement of supplementRows) {
            addMetricRow(supplement.label, (dateKey) => {
              const amount = supplementAmountsByKey.get(supplement.key)?.get(dateKey) ?? 0;
              return formatAmount(amount);
            });
          }
        }

        const escapeCsv = (value: string) => {
          if (/[",\n]/.test(value)) {
            return `"${value.replace(/"/g, "\"\"")}"`;
          }
          return value;
        };
        const csv = [
          ["Metric", ...dateKeys],
          ...csvRows,
        ]
          .map((row) => row.map((cell) => escapeCsv(cell)).join(","))
          .join("\n");

        return {
          generatedAt: new Date().toISOString(),
          filename: `coherence-structured-metrics-${new Date().toISOString().slice(0, 10)}.csv`,
          csv,
          dates: dateKeys,
          rowCount: csvRows.length,
        };
      }),
  }),

  dock: router({
    getItemDetails: protectedProcedure
      .input(z.object({
        source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
        url: z.string(),
        meta: z.record(z.string(), z.any()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        
        try {
          if (input.source === "gmail") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Email" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract message ID from parsed metadata or URL fallback.
            let messageId = input.meta?.messageId as string | undefined;
            if (!messageId) {
              try {
                const urlObj = new URL(input.url);
                const hash = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : urlObj.hash;
                const hashMessageId = hash.split("/").pop();
                const queryMessageId = urlObj.searchParams.get("th");
                messageId = queryMessageId || hashMessageId || undefined;
              } catch {
                messageId = undefined;
              }
            }
            if (!messageId) return { title: "Email" };
            
            // Fetch email details from Gmail API
            const response = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Email" };
            
            const data = await response.json();
            const subject = data.payload?.headers?.find(
              (h: any) => h.name === "Subject"
            )?.value || "Email";
            
            return { title: subject };
          }
          
          if (input.source === "gcal") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Calendar Event" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract event ID from meta (already decoded in frontend) or eid parameter
            let eventId = input.meta?.eventId as string | undefined;
            
            if (!eventId) {
              const eid = input.meta?.eid as string;
              if (!eid) return { title: "Calendar Event" };
              
              // Decode base64 event ID
              try {
                const decoded = Buffer.from(eid, "base64").toString("utf-8");
                // Event ID format: "eventId calendarId"
                eventId = decoded.split(" ")[0];
              } catch {
                return { title: "Calendar Event" };
              }
            }
            
            if (!eventId) return { title: "Calendar Event" };
            
            // Fetch event details from Calendar API
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Calendar Event" };
            
            const event = await response.json();
            return { title: event.summary || "Calendar Event" };
          }
          
          if (input.source === "gsheet") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Spreadsheet" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            const sheetId = input.meta?.sheetId as string;
            if (!sheetId) return { title: "Spreadsheet" };
            
            // Fetch spreadsheet details from Drive API
            const response = await fetch(
              `https://www.googleapis.com/drive/v3/files/${sheetId}?fields=name`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Spreadsheet" };
            
            const file = await response.json();
            return { title: file.name || "Spreadsheet" };
          }
          
          if (input.source === "todoist") {
            const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
            if (!todoistIntegration?.accessToken) {
              return { title: "Task" };
            }
            
            let taskId = input.meta?.taskId as string | undefined;
            if (!taskId) {
              const taskMatch = input.url.match(/\/task\/([A-Za-z0-9_-]+)/);
              taskId = taskMatch?.[1];
            }
            if (!taskId) return { title: "Task" };
            
            // Fetch task details from Todoist API (v1).
            const response = await fetch(
              `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
              { headers: { Authorization: `Bearer ${todoistIntegration.accessToken}` } }
            );
            
            if (!response.ok) {
              const { getTodoistTasks } = await import("./services/todoist");
              const tasks = await getTodoistTasks(todoistIntegration.accessToken);
              const task = tasks.find((t) => t.id === taskId);
              return { title: task?.content || "Task" };
            }
            
            const data = await response.json();
            const task = data?.task ?? data;
            return { title: task?.content || "Task" };
          }
          
          return { title: input.url };
        } catch (error) {
          console.error(`[Dock] Error fetching details for ${input.source}:`, error);
          return { title: input.source === "gmail" ? "Email" : input.source === "gcal" ? "Calendar Event" : input.source === "gsheet" ? "Spreadsheet" : input.source === "todoist" ? "Task" : input.url };
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
