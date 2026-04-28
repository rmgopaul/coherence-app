import { verifySolarReadingsSignedRequest } from "../_core/solarReadingsIngest";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { formatTodayKey, toDateKey } from "@shared/dateKey";
import { conversations, userPreferences } from "../../drizzle/schema";
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
import { analyzeCorrelation } from "../services/supplements/correlation";
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
  createHabitCategory,
  deleteHabitCategory,
  getHabitCompletionsByDate,
  getHabitCompletionsForDefinitionRange,
  // Phase E (2026-04-28): bulk variant for HabitsHistoryPanel.
  getHabitCompletionsForUserRange,
  groupCompletionsByHabitId,
  getHabitCompletionsRange,
  getSleepNoteByDate,
  listHabitCategories,
  listSleepNotesRange,
  updateHabitCategory,
  updateHabitDefinition,
  upsertSleepNote,
  getIntegrationByProvider,
  getLatestSamsungSyncPayload,
  getNoteById,
  getProductionReadingSummary,
  getSectionEngagementSummary,
  getSectionRatings,
  addSupplementRestockEvent,
  createSupplementExperiment,
  deleteSupplementRestockEvent,
  getSupplementAdherence,
  getSupplementDefinitionById,
  getSupplementDoseBalances,
  getSupplementExperimentById,
  getSupplementLogByDefinitionAndDate,
  listSupplementExperiments,
  listSupplementLogsRange,
  listSupplementRestockEvents,
  updateSupplementExperiment,
  getUserByEmail,
  insertProductionReading,
  insertSectionEngagementBatch,
  listDailySnapshots,
  listHabitCompletions,
  listHabitDefinitions,
  getTopSignalsForUser,
  listNoteLinks,
  listNotes,
  // Task 10.3 (2026-04-28): reverse-link rendering on the dashboard.
  listNotesForExternal,
  countNoteLinksByExternalIds,
  listProductionReadings,
  listSupplementDefinitions,
  // Phase E (2026-04-28): "Log all AM/PM" eligibility filter.
  selectUnloggedDefinitionsForTiming,
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
import {
  clearDockItemsForUser,
  deleteDockItem,
  findDockItemByCanonicalUrl,
  insertDockItem,
  listDockItems,
  // Phase E (2026-04-28) — dueAt + reminders.
  listUpcomingDockItems,
  setDockItemDueAt,
  updateDockItemCanvas,
} from "../db/dock";
// Phase E (2026-04-28) — personal contacts overlay.
import {
  archivePersonalContact,
  deletePersonalContact,
  insertPersonalContact,
  listPersonalContacts,
  recordPersonalContactEvent,
  updatePersonalContact,
} from "../db/contacts";
import { canonicalizeUrl } from "@shared/dropdock.helpers";

export const metricsRouter = router({
  getHistory: protectedProcedure
    .input(
      z
        .object({
          // 3650 = 10 years. Matches the upper bound on
          // `dataExport.dumpStructuredCsv` so any client that holds a
          // full historical CSV-import (~3000 days for a long-term
          // Samsung Health user) can still pull every row.
          limit: z.number().min(1).max(3650).optional(),
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
          days: z.number().int().min(7).max(3650).optional(),
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
  /**
   * Phase E (2026-04-28) — "Log all AM" / "Log all PM" batch.
   *
   * Inserts a log row for every active supplement definition with
   * the requested timing that doesn't already have a log for the
   * given dateKey. Returns counts so the toast can say "logged 4
   * (2 already logged)" — useful when the user double-clicks or
   * re-opens the page mid-day.
   *
   * The `dateKey` defaults to today; pass an explicit value when
   * back-filling.
   */
  logAllForTiming: protectedProcedure
    .input(
      z.object({
        timing: z.enum(["am", "pm"]),
        dateKey: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dateKey = input.dateKey ?? getTodayDateKey();
      // Fan-out reads in parallel — definitions list + already-
      // logged-today list. Both are small so the cost is dominated
      // by the round-trip itself.
      const [definitions, todaysLogs] = await Promise.all([
        listSupplementDefinitions(ctx.user.id),
        listSupplementLogs(ctx.user.id, dateKey, 500),
      ]);
      const toLog = selectUnloggedDefinitionsForTiming(
        definitions,
        todaysLogs,
        input.timing
      );
      const candidatesCount = definitions.filter(
        (def) => def.isActive && def.timing === input.timing
      ).length;

      const now = new Date();
      // Sequential insert — supplements per timing typically ≤10,
      // so the latency is negligible and we avoid hammering the
      // pool with parallel writes against the same user.
      for (const def of toLog) {
        await addSupplementLog({
          id: nanoid(),
          userId: ctx.user.id,
          definitionId: def.id,
          name: def.name,
          dose: def.dose,
          doseUnit: def.doseUnit,
          timing: input.timing,
          autoLogged: false,
          notes: null,
          dateKey,
          takenAt: now,
        });
      }

      return {
        logged: toLog.length,
        skipped: candidatesCount - toLog.length,
        candidates: candidatesCount,
      };
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
  getAdherenceRange: protectedProcedure
    .input(
      z.object({
        windowDays: z.number().int().min(7).max(365).default(90),
      })
    )
    .query(async ({ ctx, input }) => {
      // Inclusive window ending today.
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (input.windowDays - 1));
      const toKey = (d: Date) => toDateKey(d);
      const startKey = toKey(start);
      const endKey = toKey(end);

      const [definitions, logs] = await Promise.all([
        listSupplementDefinitions(ctx.user.id),
        listSupplementLogsRange(ctx.user.id, startKey, endKey),
      ]);

      // Expected-per-day = count of locked+active defs at current time.
      const expectedPerDay = definitions.filter(
        (d) => d.isLocked && d.isActive
      ).length;

      // Distinct logged defs per dateKey.
      const takenByDate = new Map<string, Set<string>>();
      for (const log of logs) {
        if (!log.definitionId) continue;
        const set = takenByDate.get(log.dateKey) ?? new Set<string>();
        set.add(log.definitionId);
        takenByDate.set(log.dateKey, set);
      }

      // Emit one entry per day in the window, oldest → newest.
      const days: { dateKey: string; taken: number; expected: number }[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const key = toKey(cursor);
        days.push({
          dateKey: key,
          taken: takenByDate.get(key)?.size ?? 0,
          expected: expectedPerDay,
        });
        cursor.setDate(cursor.getDate() + 1);
      }

      return { days, expectedPerDay, startKey, endKey };
    }),
  getLogsRange: protectedProcedure
    .input(
      z.object({
        startDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      return listSupplementLogsRange(
        ctx.user.id,
        input.startDateKey,
        input.endDateKey
      );
    }),
  getCorrelation: protectedProcedure
    .input(
      z.object({
        definitionId: z.string().min(1),
        metric: z.enum([
          "whoopRecoveryScore",
          "whoopDayStrain",
          "whoopSleepHours",
          "whoopHrvMs",
          "whoopRestingHr",
          "samsungSteps",
          "samsungSleepHours",
          "samsungSpo2AvgPercent",
          "samsungSleepScore",
          "samsungEnergyScore",
          "todoistCompletedCount",
        ]),
        windowDays: z.number().int().min(14).max(365).default(90),
        lagDays: z.number().int().min(0).max(3).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      // Build window bounds (inclusive, ending today).
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (input.windowDays - 1));
      const toKey = (d: Date) => toDateKey(d);
      const startKey = toKey(start);
      const endKey = toKey(end);

      // Fetch both series in parallel. Metrics are capped to the window by
      // pulling the most-recent `windowDays` rows from getDailyMetricsHistory
      // and filtering to the window — cheap, and matches existing access
      // patterns without a new range helper.
      const [rawMetrics, logs] = await Promise.all([
        getDailyMetricsHistory(ctx.user.id, input.windowDays),
        listSupplementLogsRange(ctx.user.id, startKey, endKey),
      ]);

      const metricField = input.metric;
      const metrics = rawMetrics
        .filter((row) => row.dateKey >= startKey && row.dateKey <= endKey)
        .map((row) => {
          const raw = (row as Record<string, unknown>)[metricField];
          const num =
            raw === null || raw === undefined
              ? null
              : typeof raw === "number"
                ? raw
                : Number(raw);
          return {
            dateKey: row.dateKey,
            value:
              num === null || !Number.isFinite(num) ? null : (num as number),
          };
        });

      const suppLogDates = new Set<string>();
      for (const log of logs) {
        if (log.definitionId === input.definitionId) {
          suppLogDates.add(log.dateKey);
        }
      }

      const result = analyzeCorrelation({
        suppLogDates,
        metrics,
        lagDays: input.lagDays,
      });

      return {
        ...result,
        metric: input.metric,
        windowDays: input.windowDays,
        lagDays: input.lagDays,
        startKey,
        endKey,
      };
    }),
  /**
   * Task 6.1 (2026-04-27) — top correlation signals from the
   * pre-computed `supplementCorrelations` table (populated by the
   * nightly snapshot). Replaces the dashboard's old adherence-only
   * card with real effect-size data.
   *
   * Returns rows with the supplement name joined in so the client
   * doesn't have to issue a second query for each row's label.
   * Skips slices flagged `insufficientData` and orders by absolute
   * Cohen's d. Result is empty until the first nightly run lands.
   */
  getTopSignals: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(20).default(5),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 5;
      const [rows, defs] = await Promise.all([
        getTopSignalsForUser(ctx.user.id, limit),
        listSupplementDefinitions(ctx.user.id),
      ]);
      const nameById = new Map(defs.map((d) => [d.id, d.name]));
      return rows.map((row) => ({
        supplementId: row.supplementId,
        supplementName: nameById.get(row.supplementId) ?? row.supplementId,
        metric: row.metric,
        windowDays: row.windowDays,
        lagDays: row.lagDays,
        cohensD: row.cohensD,
        pearsonR: row.pearsonR,
        onN: row.onN,
        offN: row.offN,
        onMean: row.onMean,
        offMean: row.offMean,
        computedAt: row.computedAt,
      }));
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

  // ─── Phase 4: Experiments ─────────────────────────────────────────
  listExperiments: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(["active", "ended", "abandoned"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listSupplementExperiments(ctx.user.id, { status: input?.status });
    }),
  createExperiment: protectedProcedure
    .input(
      z.object({
        definitionId: z.string().min(1),
        hypothesis: z.string().min(1).max(1000),
        startDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        primaryMetric: z
          .enum([
            "whoopRecoveryScore",
            "whoopDayStrain",
            "whoopSleepHours",
            "whoopHrvMs",
            "whoopRestingHr",
            "samsungSteps",
            "samsungSleepHours",
            "samsungSpo2AvgPercent",
            "samsungSleepScore",
            "samsungEnergyScore",
            "todoistCompletedCount",
          ])
          .optional(),
        notes: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = nanoid();
      await createSupplementExperiment({
        id,
        userId: ctx.user.id,
        definitionId: input.definitionId,
        hypothesis: input.hypothesis.trim(),
        startDateKey: input.startDateKey,
        endDateKey: null,
        status: "active",
        primaryMetric: input.primaryMetric ?? null,
        notes: input.notes?.trim() || null,
      });
      return { id, success: true };
    }),
  endExperiment: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        endDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.enum(["ended", "abandoned"]).default("ended"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getSupplementExperimentById(ctx.user.id, input.id);
      if (!existing) throw new Error("Experiment not found.");
      await updateSupplementExperiment(ctx.user.id, input.id, {
        status: input.status,
        endDateKey: input.endDateKey,
      });
      return { success: true };
    }),

  // ─── Phase 4: Restock events ─────────────────────────────────────
  listRestockEvents: protectedProcedure
    .input(
      z
        .object({
          definitionId: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listSupplementRestockEvents(ctx.user.id, {
        definitionId: input?.definitionId,
        limit: input?.limit,
      });
    }),
  addRestockEvent: protectedProcedure
    .input(
      z.object({
        definitionId: z.string().min(1),
        eventType: z.enum(["purchased", "opened", "finished"]),
        occurredAt: z.string().optional(),
        quantityDelta: z.number(),
        unitPrice: z.number().nonnegative().optional(),
        sourceUrl: z.string().max(2048).optional(),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await addSupplementRestockEvent({
        id: nanoid(),
        userId: ctx.user.id,
        definitionId: input.definitionId,
        eventType: input.eventType,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        quantityDelta: input.quantityDelta,
        unitPrice: input.unitPrice ?? null,
        sourceUrl: input.sourceUrl?.trim() || null,
        notes: input.notes?.trim() || null,
      });
      return { success: true };
    }),
  deleteRestockEvent: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await deleteSupplementRestockEvent(ctx.user.id, input.id);
      return { success: true };
    }),
  getRestockForecast: protectedProcedure.query(async ({ ctx }) => {
    const [defs, balances] = await Promise.all([
      listSupplementDefinitions(ctx.user.id),
      getSupplementDoseBalances(ctx.user.id),
    ]);
    const balanceByDefId = new Map<string, number>();
    for (const row of balances) {
      if (!row.definitionId) continue;
      const raw = row.balance as unknown;
      const num = typeof raw === "number" ? raw : Number(raw);
      balanceByDefId.set(row.definitionId, Number.isFinite(num) ? num : 0);
    }
    const today = new Date();
    return defs
      .filter((d) => d.isLocked && d.isActive)
      .map((d) => {
        const balance = balanceByDefId.get(d.id) ?? 0;
        const dailyRate = 1; // one locked dose/day; schedule-aware rates later
        const daysRemaining =
          dailyRate > 0 ? Math.floor(balance / dailyRate) : null;
        const runsOutOn =
          daysRemaining !== null && daysRemaining >= 0
            ? (() => {
                const d2 = new Date(today);
                d2.setDate(d2.getDate() + daysRemaining);
                return toDateKey(d2);
              })()
            : null;
        return {
          definitionId: d.id,
          name: d.name,
          balance,
          dailyRate,
          daysRemaining,
          runsOutOn,
        };
      });
  }),

  // ─── Phase 4: Price watcher (manual trigger) ─────────────────────
  runPriceWatchNow: protectedProcedure.mutation(async ({ ctx }) => {
    const { runPriceWatchForUser } = await import(
      "../services/supplements/priceWatcher"
    );
    return runPriceWatchForUser(ctx.user.id);
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
        categoryId: z.string().max(64).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await listHabitDefinitions(ctx.user.id);
      const nextSortOrder =
        existing.length > 0 ? Math.max(...existing.map((habit) => habit.sortOrder ?? 0)) + 1 : 0;
      const id = nanoid();

      await createHabitDefinition({
        id,
        userId: ctx.user.id,
        name: input.name.trim(),
        color: (input.color ?? "slate").trim().toLowerCase(),
        sortOrder: nextSortOrder,
        isActive: true,
        categoryId: input.categoryId ?? null,
      });
      return { id, success: true };
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
    const sinceDateKey = toDateKey(sinceDate);

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
      last7Days.push(toDateKey(d));
    }

    return definitions.map((habit) => {
      const completedDates = completionMap.get(habit.id) ?? new Set();

      // Calculate current streak (consecutive days ending today or yesterday)
      let streak = 0;
      for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = toDateKey(d);
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

  // ─── Categories ──────────────────────────────────────────────────
  listCategories: protectedProcedure.query(async ({ ctx }) => {
    return listHabitCategories(ctx.user.id);
  }),
  createCategory: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        color: z.string().max(32).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await listHabitCategories(ctx.user.id);
      const nextSortOrder =
        existing.length > 0
          ? Math.max(...existing.map((c) => c.sortOrder ?? 0)) + 1
          : 0;
      const id = nanoid();
      await createHabitCategory({
        id,
        userId: ctx.user.id,
        name: input.name.trim(),
        color: input.color?.trim() || "slate",
        sortOrder: nextSortOrder,
        isActive: true,
      });
      return { id, success: true };
    }),
  updateCategory: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        color: z.string().max(32).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await updateHabitCategory(ctx.user.id, input.id, {
        name: input.name?.trim(),
        color: input.color?.trim(),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      });
      return { success: true };
    }),
  deleteCategory: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await deleteHabitCategory(ctx.user.id, input.id);
      return { success: true };
    }),

  // ─── Definition updates (rename, recolor, recategorize, reorder) ─
  updateDefinition: protectedProcedure
    .input(
      z.object({
        habitId: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        color: z.string().max(32).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
        categoryId: z.string().max(64).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await updateHabitDefinition(ctx.user.id, input.habitId, {
        name: input.name?.trim(),
        color: input.color?.trim(),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        categoryId: input.categoryId,
      });
      return { success: true };
    }),

  // ─── Completions range (heatmap) ─────────────────────────────────
  getCompletionsRange: protectedProcedure
    .input(
      z.object({
        habitId: z.string().min(1),
        startDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await getHabitCompletionsForDefinitionRange(
        ctx.user.id,
        input.habitId,
        input.startDateKey,
        input.endDateKey
      );
      return rows.map((r) => ({
        dateKey: r.dateKey,
        completed: r.completed,
      }));
    }),

  /**
   * Phase E (2026-04-28) — bulk variant of `getCompletionsRange`.
   *
   * One round-trip returns `Record<habitId, {dateKey, completed}[]>`
   * for every habit the user has rows for in the window. The
   * `HabitsHistoryPanel` previously fired one query PER habit
   * (N+1); with this it fires one total. Rows for habits with
   * zero completions in the window are simply absent from the
   * record — the client fills missing days with `completed: false`
   * via its existing `fullRange` reduction.
   */
  getCompletionsRangeBulk: protectedProcedure
    .input(
      z.object({
        startDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await getHabitCompletionsForUserRange(
        ctx.user.id,
        input.startDateKey,
        input.endDateKey
      );
      // Strip the row shape down to what the heatmap consumes,
      // then fold into the per-habit map.
      const stripped = rows.map((r) => ({
        habitId: r.habitId,
        dateKey: r.dateKey,
        completed: r.completed,
      }));
      return {
        byHabitId: groupCompletionsByHabitId(stripped),
      };
    }),

  // ─── Correlation (habit × health metric) ─────────────────────────
  getCorrelation: protectedProcedure
    .input(
      z.object({
        habitId: z.string().min(1),
        metric: z.enum([
          "whoopRecoveryScore",
          "whoopDayStrain",
          "whoopSleepHours",
          "whoopHrvMs",
          "whoopRestingHr",
          "samsungSteps",
          "samsungSleepHours",
          "samsungSpo2AvgPercent",
          "samsungSleepScore",
          "samsungEnergyScore",
          "todoistCompletedCount",
        ]),
        windowDays: z.number().int().min(14).max(365).default(90),
        lagDays: z.number().int().min(0).max(3).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (input.windowDays - 1));
      const toKey = (d: Date) => toDateKey(d);
      const startKey = toKey(start);
      const endKey = toKey(end);

      const [rawMetrics, completions] = await Promise.all([
        getDailyMetricsHistory(ctx.user.id, input.windowDays),
        getHabitCompletionsForDefinitionRange(
          ctx.user.id,
          input.habitId,
          startKey,
          endKey
        ),
      ]);

      const metricField = input.metric;
      const metrics = rawMetrics
        .filter((row) => row.dateKey >= startKey && row.dateKey <= endKey)
        .map((row) => {
          const raw = (row as Record<string, unknown>)[metricField];
          const num =
            raw === null || raw === undefined
              ? null
              : typeof raw === "number"
                ? raw
                : Number(raw);
          return {
            dateKey: row.dateKey,
            value: num === null || !Number.isFinite(num) ? null : (num as number),
          };
        });

      // Habit "event" = day completed. Filter to true completions only.
      const eventDates = new Set<string>();
      for (const row of completions) {
        if (row.completed) eventDates.add(row.dateKey);
      }

      const result = analyzeCorrelation({
        suppLogDates: eventDates,
        metrics,
        lagDays: input.lagDays,
      });

      return {
        ...result,
        metric: input.metric,
        windowDays: input.windowDays,
        lagDays: input.lagDays,
        startKey,
        endKey,
      };
    }),

  // ─── Sleep report (habit × sleep metrics, one-shot matrix) ───────
  getSleepReport: protectedProcedure
    .input(
      z.object({
        windowDays: z.number().int().min(30).max(365).default(90),
      })
    )
    .query(async ({ ctx, input }) => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (input.windowDays - 1));
      const toKey = (d: Date) => toDateKey(d);
      const startKey = toKey(start);
      const endKey = toKey(end);

      const sleepMetrics = [
        "whoopSleepHours",
        "whoopHrvMs",
        "samsungSleepScore",
        "samsungSleepHours",
      ] as const;

      const [definitions, rawMetrics, allCompletions] = await Promise.all([
        listHabitDefinitions(ctx.user.id),
        getDailyMetricsHistory(ctx.user.id, input.windowDays),
        getHabitCompletionsRange(ctx.user.id, startKey),
      ]);

      const filteredMetrics = rawMetrics.filter(
        (row) => row.dateKey >= startKey && row.dateKey <= endKey
      );

      // Build per-metric arrays once — re-used across every habit.
      const metricsByField: Record<
        (typeof sleepMetrics)[number],
        { dateKey: string; value: number | null }[]
      > = {
        whoopSleepHours: [],
        whoopHrvMs: [],
        samsungSleepScore: [],
        samsungSleepHours: [],
      };
      for (const metric of sleepMetrics) {
        metricsByField[metric] = filteredMetrics.map((row) => {
          const raw = (row as Record<string, unknown>)[metric];
          const num =
            raw === null || raw === undefined
              ? null
              : typeof raw === "number"
                ? raw
                : Number(raw);
          return {
            dateKey: row.dateKey,
            value: num === null || !Number.isFinite(num) ? null : (num as number),
          };
        });
      }

      // Bucket completions by habitId once.
      const completionsByHabit = new Map<string, Set<string>>();
      for (const c of allCompletions) {
        if (!c.completed) continue;
        if (c.dateKey < startKey || c.dateKey > endKey) continue;
        const set = completionsByHabit.get(c.habitId) ?? new Set<string>();
        set.add(c.dateKey);
        completionsByHabit.set(c.habitId, set);
      }

      return definitions
        .filter((d) => d.isActive)
        .map((def) => {
          const eventDates = completionsByHabit.get(def.id) ?? new Set();
          const correlations = sleepMetrics.map((metric) => {
            const analysis = analyzeCorrelation({
              suppLogDates: eventDates,
              metrics: metricsByField[metric],
              lagDays: 0,
            });
            return {
              metric,
              cohensD: analysis.cohensD,
              pearsonR: analysis.pearsonR,
              onN: analysis.onN,
              offN: analysis.offN,
              onMean: analysis.onMean,
              offMean: analysis.offMean,
              insufficientData: analysis.insufficientData,
            };
          });
          return {
            habitId: def.id,
            name: def.name,
            color: def.color,
            correlations,
          };
        });
    }),
});

export const sleepRouter = router({
  getNote: protectedProcedure
    .input(
      z.object({ dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    )
    .query(async ({ ctx, input }) => {
      return getSleepNoteByDate(ctx.user.id, input.dateKey);
    }),
  upsertNote: protectedProcedure
    .input(
      z.object({
        dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tags: z.string().max(500).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await upsertSleepNote({
        userId: ctx.user.id,
        dateKey: input.dateKey,
        tags: input.tags ?? undefined,
        notes: input.notes ?? undefined,
      });
      return { success: true };
    }),
  listNotesRange: protectedProcedure
    .input(
      z.object({
        startDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      return listSleepNotesRange(
        ctx.user.id,
        input.startDateKey,
        input.endDateKey
      );
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

  /**
   * Task 10.3 (2026-04-28) — reverse-link lookup. Given an external
   * productivity object, return the notes that link to it.
   *
   * Powers the dashboard's "📎 N linked notes" badge on Todoist
   * task rows + Calendar event cards. The forward direction
   * (note → external) is created by the Notebook→Todoist flow
   * (Task 4.6) and the equivalent calendar handoff; this proc
   * closes the loop.
   *
   * `seriesId` / `occurrenceStartIso` are optional — when omitted,
   * matches any link with the supplied (linkType, externalId),
   * which is what the dashboard wants for "any note touching this
   * task / this event."
   */
  listForExternal: protectedProcedure
    .input(
      z.object({
        linkType: z
          .enum(["todoist_task", "google_calendar_event"]),
        externalId: z.string().min(1).max(255),
        seriesId: z.string().max(255).optional(),
        occurrenceStartIso: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const notes = await listNotesForExternal(
        ctx.user.id,
        input.linkType,
        input.externalId,
        {
          limit: input.limit,
          seriesId: input.seriesId,
          occurrenceStartIso: input.occurrenceStartIso,
        }
      );
      return { notes };
    }),

  /**
   * Task 10.3 (2026-04-28) — batch reverse-link counts. Returns
   * `Record<externalId, count>` so the dashboard can render badges
   * for ~30-50 rows per render in one round-trip.
   *
   * Empty `externalIds` → empty result. Caller-supplied IDs are
   * deduped + capped at 500 server-side.
   */
  countLinksByExternalIds: protectedProcedure
    .input(
      z.object({
        linkType: z
          .enum(["todoist_task", "google_calendar_event"]),
        externalIds: z.array(z.string().min(1).max(255)).max(500),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.externalIds.length === 0) {
        return { counts: {} as Record<string, number> };
      }
      const counts = await countNoteLinksByExternalIds(
        ctx.user.id,
        input.linkType,
        input.externalIds
      );
      return { counts };
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
        return toDateKey(date);
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

/**
 * Enrich a dock item — given source/url/meta, fetch the upstream
 * source's display title and return it (or null if anything fails).
 * Pure-IO; no side effects. Used by:
 *   - `dock.getItemDetails` — called during the paste/drop flow
 *   - `dock.refreshTitle` — called by chips that were stored without
 *     a title (e.g. before the gcal-htmlLink classification fix
 *     landed; or when SignalActions drops a Todoist task whose
 *     content was null at the source row)
 *
 * Returns null on every defensive path — token missing, source
 * unsupported, upstream HTTP failure, or upstream returns an empty
 * value. Callers fall back to `chipFallbackLabel` for display.
 */
async function enrichDockTitle(
  userId: number,
  source: "gmail" | "gcal" | "gsheet" | "todoist" | "url",
  url: string,
  meta: Record<string, unknown> | null | undefined
): Promise<string | null> {
  const { stripMarkdownLinks } = await import("@shared/dropdock.helpers");
  const cleanTitle = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const stripped = stripMarkdownLinks(raw).trim();
    return stripped.length > 0 ? stripped : null;
  };

  try {
    if (source === "gmail") {
      const googleIntegration = await getIntegrationByProvider(userId, "google");
      if (!googleIntegration?.accessToken) return null;
      const accessToken = await getValidGoogleToken(userId);

      let messageId = meta?.messageId as string | undefined;
      if (!messageId) {
        try {
          const urlObj = new URL(url);
          const hash = urlObj.hash.startsWith("#")
            ? urlObj.hash.slice(1)
            : urlObj.hash;
          const hashMessageId = hash.split("/").pop();
          const queryMessageId = urlObj.searchParams.get("th");
          messageId = queryMessageId || hashMessageId || undefined;
        } catch {
          messageId = undefined;
        }
      }
      if (!messageId) return null;

      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!response.ok) return null;

      const data = await response.json();
      const subject = data.payload?.headers?.find(
        (h: { name: string; value: string }) => h.name === "Subject"
      )?.value;
      return cleanTitle(subject);
    }

    if (source === "gcal") {
      const googleIntegration = await getIntegrationByProvider(userId, "google");
      if (!googleIntegration?.accessToken) return null;
      const accessToken = await getValidGoogleToken(userId);

      let eventId = meta?.eventId as string | undefined;
      let calendarId = meta?.calendarId as string | undefined;

      // Try `eid` from meta first (set by classifyUrl). For chips
      // stored before the www.google.com/calendar host fix, meta
      // could be empty — in that case try parsing `eid` directly
      // off the URL as a defensive fallback.
      let eid = meta?.eid as string | undefined;
      if (!eventId && !eid) {
        try {
          const urlObj = new URL(url);
          eid = urlObj.searchParams.get("eid") ?? undefined;
        } catch {
          eid = undefined;
        }
      }

      if (!eventId && eid) {
        // Decode base64 event ID. Format is "eventId calendarId"
        // (calendarId absent when the event lives on the primary
        // calendar). Non-primary calendars require the calendar id
        // in the API URL or the fetch 404s.
        try {
          const decoded = Buffer.from(eid, "base64").toString("utf-8");
          const parts = decoded.split(" ");
          eventId = parts[0];
          if (!calendarId && parts[1]) calendarId = parts[1];
        } catch {
          return null;
        }
      }
      if (!eventId) return null;

      const targetCalendar = calendarId ?? "primary";
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendar)}/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!response.ok) return null;

      const event = await response.json();
      return cleanTitle(event.summary);
    }

    if (source === "gsheet") {
      const googleIntegration = await getIntegrationByProvider(userId, "google");
      if (!googleIntegration?.accessToken) return null;
      const accessToken = await getValidGoogleToken(userId);

      const spreadsheetId =
        (meta?.spreadsheetId as string | undefined) ??
        (meta?.sheetId as string | undefined);
      if (!spreadsheetId) return null;

      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=name`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!response.ok) return null;

      const file = await response.json();
      return cleanTitle(file.name);
    }

    if (source === "todoist") {
      const todoistIntegration = await getIntegrationByProvider(userId, "todoist");
      if (!todoistIntegration?.accessToken) return null;

      let taskId = meta?.taskId as string | undefined;
      if (!taskId) {
        // First try the query-param shape (`?id=…` — matches
        // SignalActions' `taskUrl: showTask?id=…`).
        try {
          const urlObj = new URL(url);
          taskId = urlObj.searchParams.get("id") ?? undefined;
        } catch {
          taskId = undefined;
        }
      }
      if (!taskId) {
        // Fall through to the `/task/<id>` path-segment shape.
        const taskMatch = url.match(/\/task\/([A-Za-z0-9_-]+)/);
        taskId = taskMatch?.[1];
      }
      if (!taskId) return null;

      const response = await fetch(
        `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: { Authorization: `Bearer ${todoistIntegration.accessToken}` },
        }
      );

      if (!response.ok) {
        // Fallback: pull the full open-task list and find by id.
        // Slow but covers cases where the v1 single-task endpoint
        // returns 404 for a task the user CAN access.
        const tasks = await getTodoistTasks(todoistIntegration.accessToken);
        const task = tasks.find((t) => t.id === taskId);
        return cleanTitle(task?.content);
      }

      const data = await response.json();
      const task = data?.task ?? data;
      return cleanTitle(task?.content);
    }

    return null;
  } catch (error) {
    console.error(`[Dock] enrichDockTitle ${source} failed:`, error);
    return null;
  }
}

export const dockRouter = router({
  getItemDetails: protectedProcedure
    .input(z.object({
      source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
      url: z.string(),
      meta: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Delegates to `enrichDockTitle` so the paste/drop flow and
      // the self-heal `refreshTitle` flow share one enrichment
      // implementation. Returns `{ title: null }` on every defensive
      // path so the chip render falls back to `chipFallbackLabel`.
      const title = await enrichDockTitle(
        ctx.user.id,
        input.source,
        input.url,
        input.meta ?? null
      );
      return { title };
    }),

  /**
   * Self-heal a dock chip whose stored title is null/empty. Loads
   * the row, runs enrichment, and persists the resolved title (if
   * any) so subsequent renders skip the round trip. Used by the
   * client when a chip mounts with no title — typically because
   * the chip was added before the gcal `htmlLink` URL classification
   * fix landed, or before SignalActions started passing the title
   * through.
   *
   * Re-classification step (the actual fix for the original
   * regression). Chips added BEFORE the htmlLink classification
   * fix have `source: "url"` and empty meta in the DB even though
   * the URL itself is a Calendar event link. We re-run
   * `classifyUrl(item.url)` first and use the freshly-classified
   * source + meta for enrichment. When the new source is more
   * specific than the stored one (e.g. "url" → "gcal"), we also
   * update the stored source so the chip's badge label/color
   * upgrades on the next render.
   *
   * Returns the resolved title (or null when enrichment still
   * fails). The client falls back to `chipFallbackLabel` either way.
   *
   * Idempotent — calling on a chip that already has a title is a
   * no-op (we re-return the existing title without hitting the
   * upstream API).
   */
  refreshTitle: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { classifyUrl } = await import("@shared/dropdock.helpers");
      const { getDockItemById, updateDockItemTitle } = await import(
        "../db/dock"
      );
      const item = await getDockItemById(ctx.user.id, input.id);
      if (!item) {
        return { title: null, refreshed: false as const };
      }
      // Already-titled chips short-circuit. The client checks
      // `item.title` before calling, but a parallel paste might
      // have populated the title between render and dispatch.
      if (item.title?.trim()) {
        return { title: item.title, refreshed: false as const };
      }

      // Re-classify the stored URL with the current `classifyUrl`.
      // Pre-fix chips have `source: "url"` and empty meta even
      // when the URL is actually a Calendar / Todoist link — the
      // current classifier knows about all the URL shapes the
      // pre-fix one missed (most importantly
      // www.google.com/calendar/event?eid=...).
      const reclassified = classifyUrl(item.url);
      const storedMeta = item.meta ? parseDockMeta(item.meta) : null;
      // Prefer the re-classified source when it's more specific
      // than the stored one. An "url" stored source is the
      // generic catchall — any other source classification beats
      // it. When the stored source is already specific (gmail /
      // gcal / etc.), keep it.
      const useReclassifiedSource =
        reclassified.source !== "url" && item.source === "url";
      const effectiveSource = useReclassifiedSource
        ? reclassified.source
        : (item.source as "gmail" | "gcal" | "gsheet" | "todoist" | "url");
      // Merge metas, preferring the re-classified one's keys when
      // they fill in fields the stored meta is missing. Don't
      // discard stored meta keys (they may include manually-added
      // fields like calendarId).
      const effectiveMeta: Record<string, string> = {
        ...(reclassified.meta ?? {}),
        ...(storedMeta ?? {}),
      };

      const title = await enrichDockTitle(
        ctx.user.id,
        effectiveSource,
        item.url,
        effectiveMeta
      );
      if (!title) {
        return { title: null, refreshed: false as const };
      }
      // Persist the corrected source + merged meta alongside the
      // title when the re-classification produced a more specific
      // source. Otherwise just write the title.
      const updateOpts = useReclassifiedSource
        ? {
            source: reclassified.source,
            meta:
              Object.keys(effectiveMeta).length > 0
                ? JSON.stringify(effectiveMeta)
                : null,
          }
        : {};
      const updated = await updateDockItemTitle(
        ctx.user.id,
        input.id,
        title,
        updateOpts
      );
      return {
        title,
        refreshed: updated,
      };
    }),

  // ---- Phase F3 — server-persisted DropDock chips ----------------------
  // The shape mirrors the Drizzle row but only exposes what the UI needs.
  // `meta` is JSON-encoded server-side; clients see a parsed object.

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listDockItems(ctx.user.id);
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      url: row.url,
      title: row.title,
      meta: parseDockMeta(row.meta),
      pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      // Canvas (Phase F8) — null when the chip isn't placed on the board.
      x: (row as { x?: number | null }).x ?? null,
      y: (row as { y?: number | null }).y ?? null,
      tilt: (row as { tilt?: number | null }).tilt ?? null,
      color: (row as { color?: string | null }).color ?? null,
      // Phase E (2026-04-28) — optional reminder. ISO string so the
      // wire payload roundtrips cleanly through superjson.
      dueAt: (row as { dueAt?: Date | null }).dueAt
        ? (row as { dueAt: Date }).dueAt.toISOString()
        : null,
    }));
  }),

  add: protectedProcedure
    .input(
      z.object({
        source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
        url: z.string().min(1).max(2048),
        title: z.string().max(500).optional(),
        meta: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const urlCanonical = canonicalizeUrl(input.url).slice(0, 512);
      if (!urlCanonical) {
        throw new Error("Invalid URL");
      }

      // Idempotent: pasting the same link twice surfaces the existing
      // chip rather than throwing on the unique constraint.
      const existing = await findDockItemByCanonicalUrl(
        ctx.user.id,
        urlCanonical
      );
      if (existing) {
        return {
          id: existing.id,
          source: existing.source,
          url: existing.url,
          title: existing.title,
          meta: parseDockMeta(existing.meta),
          pinnedAt: existing.pinnedAt ? existing.pinnedAt.toISOString() : null,
          createdAt: existing.createdAt ? existing.createdAt.toISOString() : null,
          deduplicated: true as const,
        };
      }

      const id = nanoid();
      await insertDockItem({
        id,
        userId: ctx.user.id,
        source: input.source,
        url: input.url,
        urlCanonical,
        title: input.title?.trim() || null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      });
      return {
        id,
        source: input.source,
        url: input.url,
        title: input.title ?? null,
        meta: input.meta ?? {},
        pinnedAt: null,
        createdAt: new Date().toISOString(),
        deduplicated: false as const,
      };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await deleteDockItem(ctx.user.id, input.id);
      return { ok: true as const };
    }),

  clear: protectedProcedure.mutation(async ({ ctx }) => {
    await clearDockItemsForUser(ctx.user.id);
    return { ok: true as const };
  }),

  // ---- Phase F8 — canvas positioning ----------------------------------
  // `move` updates an existing chip's x/y/tilt/color; pass null to clear.
  // Sending `x:null,y:null` removes the chip from the canvas board while
  // preserving the chip in the dock.
  move: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        x: z.number().int().min(-2000).max(20000).nullable().optional(),
        y: z.number().int().min(-2000).max(20000).nullable().optional(),
        tilt: z.number().int().min(-15).max(15).nullable().optional(),
        color: z
          .enum(["paper", "yellow", "red", "blue", "black"])
          .nullable()
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      await updateDockItemCanvas(ctx.user.id, id, patch);
      return { ok: true as const };
    }),

  /**
   * Phase E (2026-04-28) — set or clear a chip's due date. Stores
   * the wire ISO string as a Date column so MySQL can sort by it
   * server-side. Returns `{ updated }` so the client can surface a
   * toast when the row vanished out from under the user (e.g. they
   * had two tabs open and removed the chip in the other tab).
   */
  setDueAt: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        // ISO datetime string ("2026-05-01T18:00:00Z"). null clears.
        dueAt: z.string().datetime().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dueAt = input.dueAt ? new Date(input.dueAt) : null;
      const updated = await setDockItemDueAt(ctx.user.id, input.id, dueAt);
      return { updated };
    }),

  /**
   * Phase E (2026-04-28) — chips with a due date inside the next
   * `windowHours` window (default 36h). Always includes overdue
   * chips regardless of windowHours so the dashboard's "Upcoming"
   * strip never silently drops a missed reminder. The proc layer
   * defines the window default; the underlying db helper accepts
   * `null` to mean "every dated chip" so a future "Show all
   * reminders" view doesn't need a new helper.
   */
  listUpcoming: protectedProcedure
    .input(
      z
        .object({
          windowHours: z.number().int().min(1).max(24 * 90).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const rows = await listUpcomingDockItems(ctx.user.id, {
        windowHours: input?.windowHours ?? 36,
        limit: input?.limit ?? 50,
      });
      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        url: row.url,
        title: row.title,
        meta: parseDockMeta(row.meta),
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      }));
    }),
});

function parseDockMeta(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Coerce values to strings — schema-input-time guarantee.
      return Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")])
      );
    }
  } catch {
    // fall through to {}
  }
  return {};
}

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
      const dateKey = formatTodayKey();
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

  /**
   * Generic "Ask AI about this data" endpoint. The shared AskAiPanel
   * component calls this with a moduleKey + on-screen context.
   *
   * Task 4.5 V2: optional `conversationId` lets the panel resume a
   * prior thread instead of starting fresh every ask. When the
   * caller omits `conversationId` AND `persistConversation` is true,
   * a new `conversations` row is created with
   * `source = "ask-ai:${moduleKey}"` and both the user's question
   * and the assistant's response are persisted to `messages`.
   * Returns `{answer, model, conversationId}` so the client can
   * stash the id and keep the thread alive.
   */
  ask: protectedProcedure
    .input(
      z.object({
        moduleKey: z.string().min(1).max(64),
        question: z.string().min(1).max(8000),
        contextText: z.string().max(200_000).optional(),
        conversationHistory: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            })
          )
          .max(20)
          .default([]),
        modelOverride: z.string().max(64).optional(),
        conversationId: z.string().max(64).optional(),
        persistConversation: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "anthropic");
      const apiKey = toNonEmptyString(integration?.accessToken);
      if (!apiKey) {
        throw new Error(
          "Anthropic API key not configured. Go to Settings and connect your Anthropic account."
        );
      }
      const metadata = parseJsonMetadata(integration?.metadata);
      const defaultModel =
        toNonEmptyString(metadata.model) ?? "claude-sonnet-4-20250514";
      const model =
        toNonEmptyString(input.modelOverride) ?? defaultModel;

      const systemPrompt = [
        `You are an analyst assistant for the Coherence Productivity Hub.`,
        `The user is on the "${input.moduleKey}" module and wants to ask questions about on-screen data.`,
        input.contextText && input.contextText.trim().length > 0
          ? `\nDATA CONTEXT:\n${input.contextText}`
          : `\nNo explicit data context was provided — reason only from the conversation itself.`,
        `\nINSTRUCTIONS:`,
        `- Answer using ONLY the provided data unless the user explicitly asks you to reason beyond it.`,
        `- Be specific: cite numbers, names, dates verbatim from the context.`,
        `- Use markdown tables when comparing multiple rows.`,
        `- Keep answers concise but thorough.`,
        `- If the context doesn't contain enough info to answer, say so rather than guessing.`,
      ].join("\n");

      const messagesForApi = [
        ...input.conversationHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: input.question },
      ];

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: messagesForApi,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let message = "Claude API error";
        try {
          message =
            (JSON.parse(errorBody) as { error?: { message?: string } })?.error
              ?.message ?? message;
        } catch {
          /* leave fallback */
        }
        throw new Error(`Claude API error (${response.status}): ${message}`);
      }

      const payload = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text =
        payload.content
          ?.filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n") ?? "";
      if (!text) throw new Error("Empty response from Claude.");

      // Task 4.5 V2 — persist conversation + messages when enabled.
      let conversationId: string | null = input.conversationId ?? null;
      if (input.persistConversation) {
        try {
          if (!conversationId) {
            const { createConversation } = await import("../db");
            // Title from the user's first question, trimmed to fit
            // the `text` column comfortably (no hard limit in the
            // schema, but we want it readable in the list UI).
            const title = input.question.slice(0, 120);
            conversationId = await createConversation(
              ctx.user.id,
              title,
              `ask-ai:${input.moduleKey}`
            );
          }
          const { addMessage } = await import("../db");
          await addMessage({
            id: nanoid(),
            conversationId,
            role: "user",
            content: input.question,
          });
          await addMessage({
            id: nanoid(),
            conversationId,
            role: "assistant",
            content: text,
          });
        } catch (persistError) {
          // Persistence failures must not block the answer. Log and
          // proceed; the client will still render the response and
          // simply won't have a conversationId to re-anchor next ask.
          console.warn(
            "[anthropic.ask] conversation persistence failed:",
            persistError instanceof Error
              ? persistError.message
              : persistError
          );
          conversationId = null;
        }
      }

      return { answer: text, model, conversationId };
    }),

  /**
   * Task 4.5 V2 — per-module model preference. Stored in
   * `userPreferences.askAiModelsJson` as
   * `{ [moduleKey: string]: modelId }`. Returns null when the user
   * has no saved preference for this module (client falls back to
   * the account-wide default).
   */
  getModelForModule: protectedProcedure
    .input(z.object({ moduleKey: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) return { model: null as string | null };
      const [row] = await db
        .select({ askAiModelsJson: userPreferences.askAiModelsJson })
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id))
        .limit(1);
      if (!row?.askAiModelsJson) return { model: null };
      try {
        const parsed = JSON.parse(row.askAiModelsJson) as Record<
          string,
          string
        >;
        const candidate = parsed[input.moduleKey];
        return {
          model: typeof candidate === "string" && candidate.length > 0
            ? candidate
            : null,
        };
      } catch {
        return { model: null };
      }
    }),

  setModelForModule: protectedProcedure
    .input(
      z.object({
        moduleKey: z.string().min(1).max(64),
        model: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) return { success: false as const };
      const [existing] = await db
        .select({ askAiModelsJson: userPreferences.askAiModelsJson })
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id))
        .limit(1);
      let prefs: Record<string, string> = {};
      if (existing?.askAiModelsJson) {
        try {
          const parsed = JSON.parse(existing.askAiModelsJson);
          if (parsed && typeof parsed === "object")
            prefs = parsed as Record<string, string>;
        } catch {
          /* fall through to empty */
        }
      }
      prefs[input.moduleKey] = input.model;
      const nextJson = JSON.stringify(prefs);
      if (existing !== undefined) {
        await db
          .update(userPreferences)
          .set({ askAiModelsJson: nextJson })
          .where(eq(userPreferences.userId, ctx.user.id));
      } else {
        await db.insert(userPreferences).values({
          id: nanoid(),
          userId: ctx.user.id,
          askAiModelsJson: nextJson,
        });
      }
      return { success: true as const };
    }),

  /**
   * Task 4.5 V2 — list conversations created by the AskAiPanel for
   * a given moduleKey. Used by the panel's "prior sessions" UI.
   */
  listAskAiConversations: protectedProcedure
    .input(z.object({ moduleKey: z.string().min(1).max(64), limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      const { listConversationsBySource } = await import("../db");
      const rows = await listConversationsBySource(
        ctx.user.id,
        `ask-ai:${input.moduleKey}`,
        input.limit
      );
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt
          ? new Date(row.createdAt).toISOString()
          : null,
        updatedAt: row.updatedAt
          ? new Date(row.updatedAt).toISOString()
          : null,
      }));
    }),

  getAskAiConversationMessages: protectedProcedure
    .input(z.object({ conversationId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { getConversationMessages, getDb } = await import("../db");
      const db = await getDb();
      if (!db) return [];
      // Ownership check: only the conversation's owner may read.
      const [row] = await db
        .select({ userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (!row || row.userId !== ctx.user.id) return [];
      const rows = await getConversationMessages(input.conversationId);
      return rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      }));
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

/**
 * Phase E (2026-04-28) — Personal contacts (CRM-lite) overlay.
 *
 * Personal-side feature; lives on the main app router. All procs
 * scope by `ctx.user.id`, never `scopeId` (this is single-user
 * data, not a team feature).
 *
 * Wire shape: dates serialize as ISO strings via the toJSON path
 * built into superjson. The client reconstitutes them inside
 * `formatLastContactedLabel` / `categorizeContactStaleness` which
 * accept both strings and Date instances.
 */
const CONTACT_FIELD_LIMITS = {
  name: 200,
  email: 320,
  phone: 64,
  role: 200,
  company: 200,
  notes: 4000,
  tags: 500,
} as const;

const contactInputShape = z.object({
  name: z.string().min(1).max(CONTACT_FIELD_LIMITS.name),
  email: z
    .string()
    .max(CONTACT_FIELD_LIMITS.email)
    .nullable()
    .optional(),
  phone: z
    .string()
    .max(CONTACT_FIELD_LIMITS.phone)
    .nullable()
    .optional(),
  role: z.string().max(CONTACT_FIELD_LIMITS.role).nullable().optional(),
  company: z
    .string()
    .max(CONTACT_FIELD_LIMITS.company)
    .nullable()
    .optional(),
  notes: z.string().max(CONTACT_FIELD_LIMITS.notes).nullable().optional(),
  tags: z.string().max(CONTACT_FIELD_LIMITS.tags).nullable().optional(),
});

function normalizeContactField(
  value: string | null | undefined
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const contactsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).optional(),
          includeArchived: z.boolean().optional(),
          sort: z.enum(["recent", "stale"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listPersonalContacts(ctx.user.id, {
        limit: input?.limit,
        includeArchived: input?.includeArchived,
        sort: input?.sort,
      });
    }),

  create: protectedProcedure
    .input(contactInputShape)
    .mutation(async ({ ctx, input }) => {
      const id = nanoid();
      const now = new Date();
      await insertPersonalContact({
        id,
        userId: ctx.user.id,
        name: input.name.trim(),
        email: normalizeContactField(input.email),
        phone: normalizeContactField(input.phone),
        role: normalizeContactField(input.role),
        company: normalizeContactField(input.company),
        notes: normalizeContactField(input.notes),
        tags: normalizeContactField(input.tags),
        lastContactedAt: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      return { id };
    }),

  update: protectedProcedure
    .input(
      contactInputShape.partial().extend({
        id: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      // Trim/strip optional string fields the same way create does
      // so a follow-up patch produces the same canonical shape as
      // the original insert.
      const patch: Parameters<typeof updatePersonalContact>[2] = {};
      if (rest.name !== undefined) patch.name = rest.name.trim();
      if (rest.email !== undefined) patch.email = normalizeContactField(rest.email);
      if (rest.phone !== undefined) patch.phone = normalizeContactField(rest.phone);
      if (rest.role !== undefined) patch.role = normalizeContactField(rest.role);
      if (rest.company !== undefined)
        patch.company = normalizeContactField(rest.company);
      if (rest.notes !== undefined) patch.notes = normalizeContactField(rest.notes);
      if (rest.tags !== undefined) patch.tags = normalizeContactField(rest.tags);
      const updated = await updatePersonalContact(ctx.user.id, id, patch);
      return { updated };
    }),

  /**
   * Stamp `lastContactedAt = now()` on a contact. The "Just talked"
   * button on each contact card calls this. Pass `clear=true` to
   * undo (clears the stamp).
   */
  recordContact: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        clear: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await recordPersonalContactEvent(
        ctx.user.id,
        input.id,
        input.clear ? null : new Date()
      );
      return { updated };
    }),

  /**
   * Soft delete: stamps `archivedAt`. Pass `archived=false` to
   * restore.
   */
  archive: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        archived: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await archivePersonalContact(
        ctx.user.id,
        input.id,
        input.archived
      );
      return { updated };
    }),

  /**
   * Hard delete. Surfaces a "Permanently delete?" confirm in the UI.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deletePersonalContact(ctx.user.id, input.id);
      return { deleted };
    }),
});
