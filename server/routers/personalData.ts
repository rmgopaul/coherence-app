import { verifySolarReadingsSignedRequest } from "../_core/solarReadingsIngest";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  IntegrationNotConnectedError,
  parseJsonMetadata,
  getTodayDateKey,
  toFiniteNumber,
  normalizeSearchQuery,
  truncateText,
  scoreMatch,
  safeIso,
  computePearsonCorrelation,
  performSupplementBottleScanForUser,
} from "./helpers";
import { toNonEmptyString } from "../services/core/addressCleaning";
import {
  costExtremes,
  costPerDose,
  monthlyProtocolCost,
} from "@shared/supplements.math";
import {
  addNoteLink,
  addSupplementLog,
  addSupplementPriceLog,
  clearSectionEngagement,
  createHabitDefinition,
  createNote,
  createSupplementDefinition,
  deleteHabitDefinition,
  deleteNote,
  deleteNoteLink,
  deleteSupplementDefinition,
  deleteSupplementLog,
  getConversationSummaries,
  getDailyMetricsHistory,
  getHabitCompletionsByDate,
  getHabitCompletionsRange,
  getIntegrationByProvider,
  getLatestSamsungSyncPayload,
  getNoteById,
  getProductionReadingSummary,
  getSectionEngagementSummary,
  getSectionRatings,
  getSupplementAdherence,
  getSupplementDefinitionById,
  getSupplementLogByDefinitionAndDate,
  getUserByEmail,
  insertProductionReading,
  insertSectionEngagementBatch,
  listDailySnapshots,
  listHabitCompletions,
  listHabitDefinitions,
  listNoteLinks,
  listNotes,
  listProductionReadings,
  listSupplementDefinitions,
  listSupplementLogs,
  listSupplementPriceLogs,
  setSupplementDefinitionLock,
  updateNote,
  updateSupplementDefinition,
  upsertHabitCompletion,
  upsertIntegration,
} from "../db";
import { storagePut } from "../storage";
import { getValidGoogleToken } from "../helpers/tokenRefresh";
import {
  getTodoistTasks,
  getTodoistCompletedTasksInRange,
} from "../services/integrations/todoist";
import {
  getGoogleCalendarEvents,
  searchGoogleDrive,
} from "../services/integrations/google";
import {
  checkSupplementPrice,
  sourceDomainFromUrl,
} from "../services/integrations/supplements";
import { captureDailySnapshotForUser } from "../services/notifications/dailySnapshot";
import { verifySupplementIngestSignedRequest } from "../_core/supplementIngest";

export const metricsRouter = router({
  getHistory: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(120).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return getDailyMetricsHistory(ctx.user.id, input?.limit ?? 30);
    }),
  getTrendSeries: protectedProcedure
    .input(
      z
        .object({
          days: z.number().int().min(7).max(365).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const days = input?.days ?? 30;
      const rows = await getDailyMetricsHistory(ctx.user.id, days);
      const ordered = [...rows].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

      const makeSeries = (getter: (row: (typeof ordered)[number]) => number | null) =>
        ordered.map((row) => ({
          dateKey: row.dateKey,
          value: getter(row),
        }));

      const recoverySeries = makeSeries((row) => toFiniteNumber(row.whoopRecoveryScore));
      const sleepSeries = makeSeries(
        (row) => toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours)
      );
      const strainSeries = makeSeries((row) => toFiniteNumber(row.whoopDayStrain));
      const hrvSeries = makeSeries((row) => toFiniteNumber(row.whoopHrvMs));
      const stepsSeries = makeSeries((row) =>
        row.samsungSteps !== null && row.samsungSteps !== undefined ? Number(row.samsungSteps) : null
      );
      const completedTaskSeries = makeSeries((row) =>
        row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
          ? Number(row.todoistCompletedCount)
          : null
      );

      const recoveryVsSleep = computePearsonCorrelation(
        ordered.map((row) => ({
          x: toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours),
          y: toFiniteNumber(row.whoopRecoveryScore),
        }))
      );
      const recoveryVsTasks = computePearsonCorrelation(
        ordered.map((row) => ({
          x:
            row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
              ? Number(row.todoistCompletedCount)
              : null,
          y: toFiniteNumber(row.whoopRecoveryScore),
        }))
      );

      return {
        days,
        dateRange: {
          startDateKey: ordered[0]?.dateKey ?? null,
          endDateKey: ordered[ordered.length - 1]?.dateKey ?? null,
        },
        pointCount: ordered.length,
        series: {
          recovery: recoverySeries,
          sleepHours: sleepSeries,
          strain: strainSeries,
          hrvMs: hrvSeries,
          steps: stepsSeries,
          tasksCompleted: completedTaskSeries,
        },
        correlations: {
          recoveryVsSleep,
          recoveryVsTasksCompleted: recoveryVsTasks,
        },
      };
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
      await captureDailySnapshotForUser(ctx.user.id, dateKey);

      return { success: true, dateKey };
    }),
});

export const searchRouter = router({
  global: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const query = normalizeSearchQuery(input.query);
      const limit = input.limit ?? 30;

      const noteRowsPromise = listNotes(ctx.user.id, 300);
      const conversationRowsPromise = getConversationSummaries(ctx.user.id, 200);
      const todoistIntegrationPromise = getIntegrationByProvider(ctx.user.id, "todoist");
      const googleIntegrationPromise = getIntegrationByProvider(ctx.user.id, "google");

      const [noteRows, conversationRows, todoistIntegration, googleIntegration] = await Promise.all([
        noteRowsPromise,
        conversationRowsPromise,
        todoistIntegrationPromise,
        googleIntegrationPromise,
      ]);

      type SearchTodoistTask = {
        id?: string | number;
        content?: string;
        description?: string;
        createdAt?: string;
        addedAt?: string;
        due?: { date?: string } | null;
      };
      type SearchCalendarEvent = {
        id?: string;
        summary?: string;
        location?: string;
        description?: string;
        htmlLink?: string;
        start?: { dateTime?: string; date?: string } | null;
      };
      type SearchDriveFile = {
        id?: string;
        name?: string;
        mimeType?: string;
        webViewLink?: string;
        modifiedTime?: string;
      };

      let todoistTasks: SearchTodoistTask[] = [];
      if (todoistIntegration?.accessToken) {
        try {
          todoistTasks = (await getTodoistTasks(todoistIntegration.accessToken)) as unknown as SearchTodoistTask[];
        } catch (error) {
          console.warn("[Search] Failed to load Todoist tasks:", error);
        }
      }

      let calendarEvents: SearchCalendarEvent[] = [];
      let driveFiles: SearchDriveFile[] = [];
      if (googleIntegration) {
        try {
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const [events, files] = await Promise.all([
            getGoogleCalendarEvents(accessToken, { daysAhead: 120, maxResults: 250 }),
            searchGoogleDrive(accessToken, input.query),
          ]);
          calendarEvents = events;
          driveFiles = files;
        } catch (error) {
          console.warn("[Search] Failed to load Google search sources:", error);
        }
      }

      type SearchItem = {
        id: string;
        type: "task" | "note" | "calendar_event" | "conversation" | "drive_file";
        title: string;
        subtitle: string | null;
        url: string | null;
        timestamp: string | null;
        score: number;
      };

      const results: SearchItem[] = [];

      noteRows.forEach((note) => {
        const haystack = `${note.title} ${note.content} ${note.notebook}`;
        const score = scoreMatch(haystack, query);
        if (score <= 0) return;
        results.push({
          id: note.id,
          type: "note",
          title: note.title,
          subtitle: truncateText(note.content ?? "", 160),
          url: null,
          timestamp: safeIso(note.updatedAt ?? note.createdAt),
          score: score + 8,
        });
      });

      conversationRows.forEach((conversation) => {
        const title = String(conversation.title ?? "Conversation");
        const preview = String(conversation.lastMessagePreview ?? "");
        const haystack = `${title} ${preview}`;
        const score = scoreMatch(haystack, query);
        if (score <= 0) return;
        results.push({
          id: conversation.id,
          type: "conversation",
          title,
          subtitle: truncateText(preview, 160),
          url: null,
          timestamp: safeIso(conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt),
          score: score + 5,
        });
      });

      todoistTasks.forEach((task) => {
        const content = String(task?.content ?? "");
        const description = String(task?.description ?? "");
        const haystack = `${content} ${description}`;
        const score = scoreMatch(haystack, query);
        if (score <= 0) return;
        results.push({
          id: String(task?.id ?? ""),
          type: "task",
          title: content || "(Untitled task)",
          subtitle: description ? truncateText(description, 160) : null,
          url: null,
          timestamp: safeIso(task?.createdAt ?? task?.addedAt ?? task?.due?.date),
          score: score + 10,
        });
      });

      calendarEvents.forEach((event) => {
        const title = String(event?.summary ?? "");
        const location = String(event?.location ?? "");
        const description = String(event?.description ?? "");
        const haystack = `${title} ${location} ${description}`;
        const score = scoreMatch(haystack, query);
        if (score <= 0) return;
        results.push({
          id: String(event?.id ?? ""),
          type: "calendar_event",
          title: title || "(Untitled event)",
          subtitle: truncateText([location, description].filter(Boolean).join(" | "), 160) || null,
          url: toNonEmptyString(event?.htmlLink),
          timestamp: safeIso(event?.start?.dateTime ?? event?.start?.date),
          score: score + 7,
        });
      });

      driveFiles.forEach((file) => {
        const name = String(file?.name ?? "");
        const mimeType = String(file?.mimeType ?? "");
        const haystack = `${name} ${mimeType}`;
        const score = scoreMatch(haystack, query);
        if (score <= 0) return;
        results.push({
          id: String(file?.id ?? ""),
          type: "drive_file",
          title: name || "(Untitled file)",
          subtitle: mimeType || null,
          url: toNonEmptyString(file?.webViewLink),
          timestamp: safeIso(file?.modifiedTime),
          score: score + 4,
        });
      });

      results.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        const aTs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bTs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return bTs - aTs;
      });

      return {
        query: input.query,
        totalMatched: results.length,
        items: results.slice(0, limit),
      };
    }),
});

export const supplementsRouter = router({
  listDefinitions: protectedProcedure.query(async ({ ctx }) => {
    return listSupplementDefinitions(ctx.user.id);
  }),
  listPriceLogs: protectedProcedure
    .input(
      z
        .object({
          definitionId: z.string().optional(),
          limit: z.number().min(1).max(500).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listSupplementPriceLogs(ctx.user.id, {
        definitionId: input?.definitionId,
        limit: input?.limit ?? 100,
      });
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
  scanBottleWithClaude: protectedProcedure
    .input(
      z.object({
        base64Data: z.string().max(20_000_000),
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        fileName: z.string().max(255).optional(),
        timing: z.enum(["am", "pm"]).optional(),
        autoLogPrice: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      performSupplementBottleScanForUser(ctx.user.id, input)
    ),
  mobileScanBottle: publicProcedure
    .input(
      z.object({
        customerEmail: z.string().email(),
        base64Data: z.string().max(20_000_000),
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        timing: z.enum(["am", "pm"]).optional(),
        autoLogPrice: z.boolean().optional(),
        capturedAt: z.string().datetime({ offset: true }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { payload } = verifySupplementIngestSignedRequest({
        req: ctx.req,
        input,
      });

      const user = await getUserByEmail(payload.customerEmail);
      if (!user) {
        throw new Error(
          "No Coherence account found for this email. Sign in to the web app once, then retry."
        );
      }

      return performSupplementBottleScanForUser(user.id, {
        base64Data: payload.base64Data,
        contentType: payload.contentType,
        timing: payload.timing ?? undefined,
        autoLogPrice: payload.autoLogPrice,
      });
    }),
  checkPriceWithClaude: protectedProcedure
    .input(
      z.object({
        definitionId: z.string(),
        autoLogPrice: z.boolean().optional(),
        imageUrl: z.string().max(2048).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const definition = await getSupplementDefinitionById(ctx.user.id, input.definitionId);
      if (!definition) {
        throw new Error("Supplement definition not found.");
      }

      const anthropicIntegration = await getIntegrationByProvider(ctx.user.id, "anthropic");
      const apiKey = toNonEmptyString(anthropicIntegration?.accessToken);
      if (!apiKey) {
        throw new IntegrationNotConnectedError("Claude");
      }

      const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
      const model =
        typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
          ? anthropicMeta.model.trim()
          : "claude-sonnet-4-20250514";

      const priceCheck = await checkSupplementPrice({
        credentials: { apiKey, model },
        supplementName: definition.name,
        brand: definition.brand,
        dosePerUnit: definition.dosePerUnit,
      });

      let priceLogCreated = false;

      if (priceCheck.pricePerBottle !== null) {
        await updateSupplementDefinition(ctx.user.id, definition.id, {
          pricePerBottle: priceCheck.pricePerBottle,
          productUrl: priceCheck.sourceUrl ?? definition.productUrl ?? null,
        });

        if (input.autoLogPrice ?? false) {
          await addSupplementPriceLog({
            id: nanoid(),
            userId: ctx.user.id,
            definitionId: definition.id,
            supplementName: definition.name,
            brand: definition.brand ?? null,
            pricePerBottle: priceCheck.pricePerBottle,
            currency: priceCheck.currency ?? "USD",
            sourceName: priceCheck.sourceName ?? null,
            sourceUrl: priceCheck.sourceUrl ?? null,
            sourceDomain: sourceDomainFromUrl(priceCheck.sourceUrl),
            confidence: priceCheck.confidence,
            imageUrl: input.imageUrl?.trim() || null,
            capturedAt: new Date(),
          });
          priceLogCreated = true;
        }
      }

      const updatedDefinition = await getSupplementDefinitionById(ctx.user.id, definition.id);

      return {
        success: true,
        definition: updatedDefinition,
        priceCheck,
        priceLogCreated,
      };
    }),
  logPrice: protectedProcedure
    .input(
      z.object({
        definitionId: z.string(),
        pricePerBottle: z.number().positive().optional(),
        currency: z.string().max(8).optional(),
        sourceName: z.string().max(128).optional(),
        sourceUrl: z.string().max(2048).optional(),
        confidence: z.number().min(0).max(1).optional(),
        imageUrl: z.string().max(2048).optional(),
        capturedAt: z.string().datetime({ offset: true }).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const definition = await getSupplementDefinitionById(ctx.user.id, input.definitionId);
      if (!definition) {
        throw new Error("Supplement definition not found.");
      }

      const pricePerBottle = input.pricePerBottle ?? definition.pricePerBottle ?? null;
      if (pricePerBottle === null) {
        throw new Error(
          "No price available to log. Add a price first or run Check Price with Claude."
        );
      }

      const sourceUrl = input.sourceUrl?.trim() || definition.productUrl || null;
      let inferredSourceName: string | null = null;
      if (sourceUrl) {
        try {
          inferredSourceName = new URL(sourceUrl).hostname.replace(/^www\./, "");
        } catch {
          inferredSourceName = null;
        }
      }
      const sourceName = input.sourceName?.trim() || inferredSourceName;

      await addSupplementPriceLog({
        id: nanoid(),
        userId: ctx.user.id,
        definitionId: definition.id,
        supplementName: definition.name,
        brand: definition.brand ?? null,
        pricePerBottle,
        currency: input.currency?.trim().toUpperCase() || "USD",
        sourceName,
        sourceUrl,
        sourceDomain: sourceDomainFromUrl(sourceUrl),
        confidence: input.confidence ?? null,
        imageUrl: input.imageUrl?.trim() || null,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
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
      await deleteSupplementLog(ctx.user.id, input.id);
      return { success: true };
    }),
  getDefinitionById: protectedProcedure
    .input(z.object({ definitionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return getSupplementDefinitionById(ctx.user.id, input.definitionId);
    }),
  getAdherenceStats: protectedProcedure
    .input(
      z
        .object({
          windowDays: z.number().int().min(1).max(365).default(30),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return getSupplementAdherence(ctx.user.id, {
        windowDays: input?.windowDays ?? 30,
      });
    }),
  getCostSummary: protectedProcedure.query(async ({ ctx }) => {
    const defs = await listSupplementDefinitions(ctx.user.id);
    const extremes = costExtremes(defs);
    return {
      monthlyProtocolCost: monthlyProtocolCost(defs),
      lockedCount: defs.filter((d) => d.isLocked && d.isActive).length,
      activeCount: defs.filter((d) => d.isActive).length,
      cheapest: extremes.cheapest
        ? {
            definitionId: extremes.cheapest.def.id,
            name: extremes.cheapest.def.name,
            costPerDose: extremes.cheapest.costPerDose,
          }
        : null,
      mostExpensive: extremes.mostExpensive
        ? {
            definitionId: extremes.mostExpensive.def.id,
            name: extremes.mostExpensive.def.name,
            costPerDose: extremes.mostExpensive.costPerDose,
          }
        : null,
      averageCostPerDose: (() => {
        const values = defs
          .filter((d) => d.isLocked && d.isActive)
          .map((d) => costPerDose(d))
          .filter((v): v is number => v !== null);
        if (values.length === 0) return null;
        const sum = values.reduce((acc, v) => acc + v, 0);
        return sum / values.length;
      })(),
    };
  }),
});

export const habitsRouter = router({
  listDefinitions: protectedProcedure.query(async ({ ctx }) => {
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
      const dateKey = input.dateKey ?? getTodayDateKey();
      const habits = await listHabitDefinitions(ctx.user.id);
      if (!habits.some((habit) => habit.id === input.habitId)) {
        throw new Error("Habit not found");
      }
      await upsertHabitCompletion(ctx.user.id, input.habitId, dateKey, input.completed);
      return { success: true };
    }),
  getStreaks: protectedProcedure.query(async ({ ctx }) => {
    const today = new Date();
    // Get last 14 days of data for streak calculation (show 7 days, need 14 for streak count)
    const sinceDate = new Date(today);
    sinceDate.setDate(sinceDate.getDate() - 13);
    const sinceDateKey = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")}`;

    const [definitions, completions] = await Promise.all([
      listHabitDefinitions(ctx.user.id),
      getHabitCompletionsRange(ctx.user.id, sinceDateKey),
    ]);

    // Build a map: habitId -> Set of completed dateKeys
    const completionMap = new Map<string, Set<string>>();
    for (const c of completions) {
      if (!completionMap.has(c.habitId)) {
        completionMap.set(c.habitId, new Set());
      }
      completionMap.get(c.habitId)!.add(c.dateKey);
    }

    // Generate last 7 date keys for the dot calendar
    const last7Days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      last7Days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }

    return definitions.map((habit) => {
      const completedDates = completionMap.get(habit.id) ?? new Set();

      // Calculate current streak (consecutive days ending today or yesterday)
      let streak = 0;
      for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (completedDates.has(key)) {
          streak++;
        } else if (i === 0) {
          // Today not done yet — continue checking from yesterday
          continue;
        } else {
          break;
        }
      }

      // Build 7-day calendar
      const calendar = last7Days.map((dateKey) => ({
        dateKey,
        completed: completedDates.has(dateKey),
      }));

      return {
        habitId: habit.id,
        name: habit.name,
        color: habit.color,
        streak,
        calendar,
      };
    });
  }),
});

export const notesRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(1000).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
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
        content: z.string().max(250000).optional(),
        pinned: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
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
        content: z.string().max(250000).optional(),
        pinned: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
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
      await deleteNoteLink(ctx.user.id, input.linkId);
      return { success: true };
    }),
  uploadImage: protectedProcedure
    .input(
      z.object({
        base64Data: z.string().max(10_000_000),
        contentType: z.enum([
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/svg+xml",
        ]),
        fileName: z.string().max(255).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const extMap: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
      };
      const ext = extMap[input.contentType] ?? "png";
      const key = `notes/${ctx.user.id}/images/${nanoid()}.${ext}`;
      const buffer = Buffer.from(input.base64Data, "base64");

      const { url } = await storagePut(key, buffer, input.contentType);
      return { url };
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
});

export const dataExportRouter = router({
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
});

export const dockRouter = router({
  getItemDetails: protectedProcedure
    .input(z.object({
      source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
      url: z.string(),
      meta: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.source === "gmail") {
          const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
          if (!googleIntegration?.accessToken) {
            return { title: "Email" };
          }
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
            (h: { name: string; value: string }) => h.name === "Subject"
          )?.value || "Email";

          return { title: subject };
        }

        if (input.source === "gcal") {
          const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
          if (!googleIntegration?.accessToken) {
            return { title: "Calendar Event" };
          }
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
});

export const engagementRouter = router({
  recordBatch: protectedProcedure
    .input(
      z.object({
        events: z.array(
          z.object({
            sectionId: z.string().max(48),
            eventType: z.string().max(32),
            eventValue: z.string().max(64).optional(),
            sessionDate: z.string().length(10),
            durationMs: z.number().int().optional(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.events.length === 0) return { ok: true };
      await insertSectionEngagementBatch(
        input.events.map((event) => ({
          userId: ctx.user.id,
          sectionId: event.sectionId,
          eventType: event.eventType,
          eventValue: event.eventValue ?? null,
          sessionDate: event.sessionDate,
          durationMs: event.durationMs ?? null,
        }))
      );
      return { ok: true };
    }),

  setRating: protectedProcedure
    .input(
      z.object({
        sectionId: z.string().max(48),
        rating: z.enum(["essential", "useful", "rarely-use", "remove"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      await insertSectionEngagementBatch([
        {
          userId: ctx.user.id,
          sectionId: input.sectionId,
          eventType: "rating",
          eventValue: input.rating,
          sessionDate: dateKey,
          durationMs: null,
        },
      ]);
      return { ok: true };
    }),

  getRatings: protectedProcedure.query(async ({ ctx }) => {
    return getSectionRatings(ctx.user.id);
  }),

  getSummary: protectedProcedure
    .input(
      z.object({
        sinceDateKey: z.string().length(10),
      })
    )
    .query(async ({ ctx, input }) => {
      return getSectionEngagementSummary(ctx.user.id, input.sinceDateKey);
    }),

  clearAll: protectedProcedure.mutation(async ({ ctx }) => {
    await clearSectionEngagement(ctx.user.id);
    return { ok: true };
  }),
});

export const anthropicRouter = router({
  connect: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().max(512).optional(),
        model: z.string().max(64).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getIntegrationByProvider(ctx.user.id, "anthropic");
      const incomingKey = input.apiKey?.trim();
      const accessToken = incomingKey || existing?.accessToken || null;

      if (!accessToken) {
        throw new Error("Anthropic API key is required");
      }

      const existingMeta = parseJsonMetadata(existing?.metadata);
      const existingModel = typeof existingMeta.model === "string" ? existingMeta.model : "claude-sonnet-4-20250514";
      const requestedModel = input.model?.trim();
      const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

      await upsertIntegration({
        id: nanoid(),
        userId: ctx.user.id,
        provider: "anthropic",
        accessToken,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        metadata: JSON.stringify({ model }),
      });
      return { success: true, model };
    }),
});

// ── SunPower PVS production readings (mobile app → DB → dashboard) ──
export const solarReadingsRouter = router({
  /** Public endpoint secured via HMAC signature headers from the mobile app. */
  submit: publicProcedure
    .input(
      z.object({
        customerEmail: z.string().email(),
        nonId: z.string().optional(),
        lifetimeKwh: z.number().positive(),
        meterSerial: z.string().optional(),
        firmwareVersion: z.string().optional(),
        pvsSerial5: z.string().max(5).optional(),
        readAt: z.string().datetime({ offset: true }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { payload, readAt } = verifySolarReadingsSignedRequest({
        req: ctx.req,
        input,
      });
      await insertProductionReading({
        id: nanoid(),
        customerEmail: payload.customerEmail,
        nonId: payload.nonId,
        lifetimeKwh: payload.lifetimeKwh,
        meterSerial: payload.meterSerial,
        firmwareVersion: payload.firmwareVersion,
        pvsSerial5: payload.pvsSerial5,
        readAt,
      });
      return { success: true };
    }),

  /** Protected: dashboard summary card. */
  summary: protectedProcedure.query(async () => {
    return getProductionReadingSummary();
  }),

  /** Protected: list readings with optional filters. */
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(500).optional(),
          email: z.string().optional(),
          nonId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return listProductionReadings(input ?? undefined);
    }),
});
