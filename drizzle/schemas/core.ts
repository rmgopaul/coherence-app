import {
  mysqlEnum,
  mysqlTable,
  text,
  mediumtext,
  timestamp,
  varchar,
  int,
  uniqueIndex,
  index,
  double,
  boolean,
} from "drizzle-orm/mysql-core";

export const userPreferences = mysqlTable("userPreferences", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: int("userId").notNull().unique(),
  displayName: varchar("displayName", { length: 120 }),
  enabledWidgets: text("enabledWidgets"), // JSON array of enabled widget IDs
  widgetLayout: text("widgetLayout"), // JSON object for widget positions
  theme: varchar("theme", { length: 32 }).default("light"),
  /**
   * Task 4.5 V2 — per-module AskAiPanel model preference.
   * JSON object of shape `{ [moduleKey: string]: modelId }`, e.g.
   * `{ "notebook": "claude-sonnet-4-6", "supplements-insights":
   * "claude-opus-4-7" }`. Null means no stored preference.
   */
  askAiModelsJson: text("askAiModelsJson"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type InsertUserPreference = typeof userPreferences.$inferInsert;

// Daily metric log for trend tracking over time.
export const dailyHealthMetrics = mysqlTable(
  "dailyHealthMetrics",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(), // YYYY-MM-DD (user local day)
    whoopRecoveryScore: double("whoopRecoveryScore"),
    whoopDayStrain: double("whoopDayStrain"),
    whoopSleepHours: double("whoopSleepHours"),
    whoopHrvMs: double("whoopHrvMs"),
    whoopRestingHr: double("whoopRestingHr"),
    samsungSteps: int("samsungSteps"),
    samsungSleepHours: double("samsungSleepHours"),
    samsungSpo2AvgPercent: double("samsungSpo2AvgPercent"),
    samsungSleepScore: double("samsungSleepScore"),
    samsungEnergyScore: double("samsungEnergyScore"),
    todoistCompletedCount: int("todoistCompletedCount"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userDateIdx: uniqueIndex("daily_health_metrics_user_date_idx").on(table.userId, table.dateKey),
    userIdx: index("daily_health_metrics_user_idx").on(table.userId),
  })
);

export type DailyHealthMetric = typeof dailyHealthMetrics.$inferSelect;
export type InsertDailyHealthMetric = typeof dailyHealthMetrics.$inferInsert;

/**
 * Pre-computed correlation results for `(supplement × metric × window)`.
 *
 * Task 6.1 (2026-04-27) — populated by the nightly snapshot after the
 * per-user `dailyHealthMetrics` upsert. Each row is one slice of
 * supplement signal: how much an active-and-locked supplement
 * appears to move a chosen metric (recoveryScore, sleepHours,
 * dayStrain, hrvMs) across a chosen window (30 or 90 days).
 *
 * Stores Cohen's d (effect size) and Pearson r (logged 0/1 vs
 * value) — same statistics as the on-demand correlation tRPC
 * procedure. The dashboard surfaces the top |cohensD| rows with
 * `insufficientData = false` (≥ MIN_GROUP_SIZE samples in BOTH
 * groups). `lagDays` defaults to 0; lagged variants are explored
 * via the existing on-demand procedure.
 *
 * Unique on (userId, supplementId, metric, windowDays, lagDays) so
 * the nightly job idempotently overwrites the previous result.
 */
export const supplementCorrelations = mysqlTable(
  "supplementCorrelations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    supplementId: varchar("supplementId", { length: 64 }).notNull(),
    metric: varchar("metric", { length: 32 }).notNull(),
    windowDays: int("windowDays").notNull(),
    lagDays: int("lagDays").default(0).notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
    cohensD: double("cohensD"),
    pearsonR: double("pearsonR"),
    onN: int("onN").notNull(),
    offN: int("offN").notNull(),
    onMean: double("onMean"),
    offMean: double("offMean"),
    insufficientData: boolean("insufficientData").default(true).notNull(),
  },
  (table) => ({
    userIdx: index("supplement_correlations_user_idx").on(table.userId),
    uniqueSliceIdx: uniqueIndex("supplement_correlations_unique_slice_idx").on(
      table.userId,
      table.supplementId,
      table.metric,
      table.windowDays,
      table.lagDays
    ),
  })
);

export type SupplementCorrelation = typeof supplementCorrelations.$inferSelect;
export type InsertSupplementCorrelation =
  typeof supplementCorrelations.$inferInsert;

// Ad-hoc supplement logs entered from dashboard.

export const supplementLogs = mysqlTable(
  "supplementLogs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    definitionId: varchar("definitionId", { length: 64 }),
    name: varchar("name", { length: 128 }).notNull(),
    dose: varchar("dose", { length: 64 }).notNull(),
    doseUnit: varchar("doseUnit", { length: 24 }).default("capsule").notNull(),
    timing: varchar("timing", { length: 8 }).default("am").notNull(), // am | pm
    autoLogged: boolean("autoLogged").default(false).notNull(),
    notes: text("notes"),
    dateKey: varchar("dateKey", { length: 10 }).notNull(), // YYYY-MM-DD
    takenAt: timestamp("takenAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userDateIdx: index("supplement_logs_user_date_idx").on(table.userId, table.dateKey),
    userTakenIdx: index("supplement_logs_user_taken_idx").on(table.userId, table.takenAt),
    userDateDefinitionIdx: uniqueIndex("supplement_logs_user_date_definition_idx").on(
      table.userId,
      table.dateKey,
      table.definitionId
    ),
  })
);

export type SupplementLog = typeof supplementLogs.$inferSelect;
export type InsertSupplementLog = typeof supplementLogs.$inferInsert;

// Curated supplement protocol definitions.

export const supplementDefinitions = mysqlTable(
  "supplementDefinitions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    brand: varchar("brand", { length: 128 }),
    dose: varchar("dose", { length: 64 }).notNull(),
    doseUnit: varchar("doseUnit", { length: 24 }).default("capsule").notNull(),
    dosePerUnit: varchar("dosePerUnit", { length: 64 }),
    productUrl: text("productUrl"),
    pricePerBottle: double("pricePerBottle"),
    quantityPerBottle: double("quantityPerBottle"),
    timing: varchar("timing", { length: 8 }).default("am").notNull(), // am | pm
    isLocked: boolean("isLocked").default(false).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("supplement_definitions_user_idx").on(table.userId),
    userNameIdx: uniqueIndex("supplement_definitions_user_name_idx").on(table.userId, table.name),
  })
);

export type SupplementDefinition = typeof supplementDefinitions.$inferSelect;
export type InsertSupplementDefinition = typeof supplementDefinitions.$inferInsert;

// Historical price snapshots for supplements.

export const supplementPriceLogs = mysqlTable(
  "supplementPriceLogs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    definitionId: varchar("definitionId", { length: 64 }).notNull(),
    supplementName: varchar("supplementName", { length: 128 }).notNull(),
    brand: varchar("brand", { length: 128 }),
    pricePerBottle: double("pricePerBottle").notNull(),
    currency: varchar("currency", { length: 8 }).default("USD").notNull(),
    sourceName: varchar("sourceName", { length: 128 }),
    sourceUrl: text("sourceUrl"),
    sourceDomain: varchar("sourceDomain", { length: 128 }),
    confidence: double("confidence"),
    imageUrl: text("imageUrl"),
    capturedAt: timestamp("capturedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userCapturedIdx: index("supplement_price_logs_user_captured_idx").on(table.userId, table.capturedAt),
    userDefinitionCapturedIdx: index("supplement_price_logs_user_definition_captured_idx").on(
      table.userId,
      table.definitionId,
      table.capturedAt
    ),
  })
);

export type SupplementPriceLog = typeof supplementPriceLogs.$inferSelect;
export type InsertSupplementPriceLog = typeof supplementPriceLogs.$inferInsert;

// Intentional A/B-style trials for supplements — user records a hypothesis
// and a window, then the analysis re-uses Phase 3 correlation math.
export const supplementExperiments = mysqlTable(
  "supplementExperiments",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    definitionId: varchar("definitionId", { length: 64 }).notNull(),
    hypothesis: text("hypothesis").notNull(),
    startDateKey: varchar("startDateKey", { length: 10 }).notNull(),
    endDateKey: varchar("endDateKey", { length: 10 }),
    status: mysqlEnum("status", ["active", "ended", "abandoned"]).default("active").notNull(),
    primaryMetric: varchar("primaryMetric", { length: 64 }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("supplement_experiments_user_idx").on(table.userId),
    userStatusIdx: index("supplement_experiments_user_status_idx").on(
      table.userId,
      table.status
    ),
  })
);

export type SupplementExperiment = typeof supplementExperiments.$inferSelect;
export type InsertSupplementExperiment = typeof supplementExperiments.$inferInsert;

// Physical inventory events for supplement bottles. Running balance =
// sum(quantityDelta); purchased is +doses, opened/finished are -doses.
export const supplementRestockEvents = mysqlTable(
  "supplementRestockEvents",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    definitionId: varchar("definitionId", { length: 64 }).notNull(),
    eventType: mysqlEnum("eventType", ["purchased", "opened", "finished"]).notNull(),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    quantityDelta: double("quantityDelta").notNull(),
    unitPrice: double("unitPrice"),
    sourceUrl: text("sourceUrl"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("supplement_restock_events_user_idx").on(table.userId),
    userDefinitionIdx: index("supplement_restock_events_user_definition_idx").on(
      table.userId,
      table.definitionId
    ),
    userOccurredIdx: index("supplement_restock_events_user_occurred_idx").on(
      table.userId,
      table.occurredAt
    ),
  })
);

export type SupplementRestockEvent = typeof supplementRestockEvents.$inferSelect;
export type InsertSupplementRestockEvent = typeof supplementRestockEvents.$inferInsert;

// Optional grouping for habits ("morning routine", "fitness"). Deleting a
// category nulls out habitDefinitions.categoryId instead of cascading.
export const habitCategories = mysqlTable(
  "habitCategories",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    color: varchar("color", { length: 32 }).default("slate").notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("habit_categories_user_idx").on(table.userId),
    userNameIdx: uniqueIndex("habit_categories_user_name_idx").on(
      table.userId,
      table.name
    ),
  })
);

export type HabitCategory = typeof habitCategories.$inferSelect;
export type InsertHabitCategory = typeof habitCategories.$inferInsert;

// User-defined habits for tile-based daily tracking.

export const habitDefinitions = mysqlTable(
  "habitDefinitions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    color: varchar("color", { length: 32 }).default("slate").notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    // Nullable FK to habitCategories.id. Not a hard FK constraint so
    // deletes don't cascade.
    categoryId: varchar("categoryId", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("habit_definitions_user_idx").on(table.userId),
    userNameIdx: uniqueIndex("habit_definitions_user_name_idx").on(table.userId, table.name),
    userCategoryIdx: index("habit_definitions_user_category_idx").on(
      table.userId,
      table.categoryId
    ),
  })
);

export type HabitDefinition = typeof habitDefinitions.$inferSelect;
export type InsertHabitDefinition = typeof habitDefinitions.$inferInsert;

export const habitCompletions = mysqlTable(
  "habitCompletions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    habitId: varchar("habitId", { length: 64 }).notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(),
    completed: boolean("completed").default(true).notNull(),
    completedAt: timestamp("completedAt").defaultNow(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userHabitDateIdx: uniqueIndex("habit_completions_user_habit_date_idx").on(
      table.userId,
      table.habitId,
      table.dateKey
    ),
    userDateIdx: index("habit_completions_user_date_idx").on(table.userId, table.dateKey),
  })
);

export type HabitCompletion = typeof habitCompletions.$inferSelect;
export type InsertHabitCompletion = typeof habitCompletions.$inferInsert;

// Freeform journal per night. `dateKey` = wake date, matching the
// convention used by whoopSleepHours (sleep attributed to the morning
// you wake up, not the night you went to bed). One row per
// (userId, dateKey) — upsert semantics.
export const sleepNotes = mysqlTable(
  "sleepNotes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(),
    tags: varchar("tags", { length: 500 }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userDateIdx: uniqueIndex("sleep_notes_user_date_idx").on(
      table.userId,
      table.dateKey
    ),
    userIdx: index("sleep_notes_user_idx").on(table.userId),
  })
);

export type SleepNote = typeof sleepNotes.$inferSelect;
export type InsertSleepNote = typeof sleepNotes.$inferInsert;

// User-authored notes stored natively in Coherence.

export const notes = mysqlTable(
  "notes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    notebook: varchar("notebook", { length: 120 }).default("General").notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    content: mediumtext("content").notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userUpdatedIdx: index("notes_user_updated_idx").on(table.userId, table.updatedAt),
    userPinnedIdx: index("notes_user_pinned_idx").on(table.userId, table.pinned),
    userNotebookIdx: index("notes_user_notebook_idx").on(table.userId, table.notebook),
  })
);

export type Note = typeof notes.$inferSelect;
export type InsertNote = typeof notes.$inferInsert;

// Link notes to external productivity objects (Todoist tasks, Google Calendar events).

export const noteLinks = mysqlTable(
  "noteLinks",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    noteId: varchar("noteId", { length: 64 }).notNull(),
    linkType: varchar("linkType", { length: 48 }).notNull(), // todoist_task | google_calendar_event
    externalId: varchar("externalId", { length: 255 }).notNull(),
    seriesId: varchar("seriesId", { length: 255 }).default("").notNull(),
    occurrenceStartIso: varchar("occurrenceStartIso", { length: 64 }).default("").notNull(),
    sourceUrl: text("sourceUrl"),
    sourceTitle: varchar("sourceTitle", { length: 255 }),
    metadata: text("metadata"),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    userNoteIdx: index("note_links_user_note_idx").on(table.userId, table.noteId),
    userTypeIdx: index("note_links_user_type_idx").on(table.userId, table.linkType),
    noteUniqueIdx: uniqueIndex("note_links_unique_idx").on(
      table.noteId,
      table.linkType,
      table.externalId,
      table.seriesId,
      table.occurrenceStartIso
    ),
  })
);

export type NoteLink = typeof noteLinks.$inferSelect;
export type InsertNoteLink = typeof noteLinks.$inferInsert;

// Full nightly snapshot to preserve all collected datapoints/state.

export const dailySnapshots = mysqlTable(
  "dailySnapshots",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(),
    capturedAt: timestamp("capturedAt").defaultNow().notNull(),
    whoopPayload: text("whoopPayload"),
    samsungPayload: text("samsungPayload"),
    supplementsPayload: text("supplementsPayload"),
    habitsPayload: text("habitsPayload"),
    todoistCompletedCount: int("todoistCompletedCount"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userDateIdx: uniqueIndex("daily_snapshots_user_date_idx").on(table.userId, table.dateKey),
    userCapturedIdx: index("daily_snapshots_user_captured_idx").on(table.userId, table.capturedAt),
  })
);

export type DailySnapshot = typeof dailySnapshots.$inferSelect;
export type InsertDailySnapshot = typeof dailySnapshots.$inferInsert;

// Raw Samsung payload archive for full datapoint retention.

export const samsungSyncPayloads = mysqlTable(
  "samsungSyncPayloads",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(),
    capturedAt: timestamp("capturedAt").defaultNow().notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    userDateIdx: index("samsung_sync_payloads_user_date_idx").on(table.userId, table.dateKey),
    userCapturedIdx: index("samsung_sync_payloads_user_captured_idx").on(table.userId, table.capturedAt),
  })
);

export type SamsungSyncPayload = typeof samsungSyncPayloads.$inferSelect;
export type InsertSamsungSyncPayload = typeof samsungSyncPayloads.$inferInsert;

// Chunked storage for large per-user dashboard payloads.

export const sectionEngagement = mysqlTable(
  "sectionEngagement",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    sectionId: varchar("sectionId", { length: 48 }).notNull(),
    eventType: varchar("eventType", { length: 32 }).notNull(), // view, interact, expand, collapse, refresh, rating
    eventValue: varchar("eventValue", { length: 64 }), // for rating: essential, useful, rarely-use, remove
    sessionDate: varchar("sessionDate", { length: 10 }).notNull(), // YYYY-MM-DD
    durationMs: int("durationMs"),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    userSectionDateIdx: index("section_engagement_user_section_date_idx").on(
      table.userId,
      table.sectionId,
      table.sessionDate
    ),
    userEventDateIdx: index("section_engagement_user_event_date_idx").on(
      table.userId,
      table.eventType,
      table.sessionDate
    ),
  })
);

export type SectionEngagement = typeof sectionEngagement.$inferSelect;
export type InsertSectionEngagement = typeof sectionEngagement.$inferInsert;

// Freeform user feedback for product improvements across pages/sections.

export const userFeedback = mysqlTable(
  "userFeedback",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    pagePath: varchar("pagePath", { length: 255 }).notNull(),
    sectionId: varchar("sectionId", { length: 191 }),
    category: varchar("category", { length: 32 }).default("improvement").notNull(),
    note: text("note").notNull(),
    status: varchar("status", { length: 32 }).default("open").notNull(),
    contextJson: text("contextJson"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userCreatedIdx: index("user_feedback_user_created_idx").on(table.userId, table.createdAt),
    statusCreatedIdx: index("user_feedback_status_created_idx").on(table.status, table.createdAt),
  })
);

export type UserFeedback = typeof userFeedback.$inferSelect;
export type InsertUserFeedback = typeof userFeedback.$inferInsert;

// Distributed daily-job claim table. First process to INSERT for a given
// (dateKey, runKey) wins; duplicate inserts fail the unique constraint
// and the losing process skips that day's work. Prevents multi-instance
// deploys from double-firing daily jobs, and lets a restart inside the
// target minute still pick up the work (the claim, not the clock, is
// what's checked).
export const dailyJobClaims = mysqlTable(
  "dailyJobClaims",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(), // YYYY-MM-DD local
    runKey: varchar("runKey", { length: 64 }).notNull(),
    claimedAt: timestamp("claimedAt").defaultNow().notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed"])
      .default("running")
      .notNull(),
    completedAt: timestamp("completedAt"),
    errorMessage: text("errorMessage"),
  },
  (table) => ({
    uniq: uniqueIndex("dailyJobClaims_dateKey_runKey").on(
      table.dateKey,
      table.runKey,
    ),
  }),
);

export type DailyJobClaim = typeof dailyJobClaims.$inferSelect;
export type InsertDailyJobClaim = typeof dailyJobClaims.$inferInsert;

// 15-minute cache of the server-computed Gmail "waiting on" result so
// two tabs (or a WebSocket reconnect) don't each trigger a fresh
// Gmail API round-trip within the same window. Key is (userId,
// queryHash) where queryHash is sha256 of the normalized input params;
// bumping the query contract (e.g. changing maxResults bounds) makes
// new hashes naturally invalidate the old cache rows.
export const gmailWaitingOnCache = mysqlTable(
  "gmailWaitingOnCache",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    queryHash: varchar("queryHash", { length: 64 }).notNull(),
    payload: text("payload").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    uniq: uniqueIndex("gmailWaitingOnCache_userId_queryHash").on(
      table.userId,
      table.queryHash,
    ),
    expiresIdx: index("gmailWaitingOnCache_expiresAt").on(table.expiresAt),
  }),
);

export type GmailWaitingOnCache = typeof gmailWaitingOnCache.$inferSelect;
export type InsertGmailWaitingOnCache =
  typeof gmailWaitingOnCache.$inferInsert;

// ---------------------------------------------------------------------------
// Phase E (2026-04-28) — AI Weekly Review.
//
// One row per (user, ISO week). Generated weekly by the nightly
// scheduler (Monday early morning) by feeding the prior 7 daily
// snapshots to an LLM and parsing a structured response. Surfaced
// on the dashboard as a "review of last week" card with the
// headline + content markdown.
//
// `weekKey` uses ISO week format ("2026-W17") so the unique index
// gives natural sortability + matches the existing dateKey
// conventions in `shared/dateKey.ts`. `weekStartDateKey` /
// `weekEndDateKey` are the Monday/Sunday of that week, useful for
// joining back to dailySnapshots without re-parsing the weekKey.
//
// `status` enum:
//   - `pending`       — row created but no LLM call yet
//   - `ready`         — review generated successfully
//   - `insufficient`  — fewer than 3 days of snapshots in the
//                        window; nothing meaningful to summarize
//   - `failed`        — LLM call or parse error; `errorMessage` set
// ---------------------------------------------------------------------------

export const weeklyReviews = mysqlTable(
  "weeklyReviews",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    weekKey: varchar("weekKey", { length: 10 }).notNull(),
    weekStartDateKey: varchar("weekStartDateKey", { length: 10 }).notNull(),
    weekEndDateKey: varchar("weekEndDateKey", { length: 10 }).notNull(),
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    headline: varchar("headline", { length: 280 }),
    contentMarkdown: mediumtext("contentMarkdown"),
    /** Stringified JSON snapshot of derived metrics — e.g. sleep avg,
     *  recovery avg, supplements adherence, todoist completed count.
     *  Stored so the UI can render trend chips without re-parsing the
     *  raw daily snapshots. */
    metricsJson: text("metricsJson"),
    model: varchar("model", { length: 64 }),
    daysWithData: int("daysWithData").default(0).notNull(),
    generatedAt: timestamp("generatedAt"),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userWeekIdx: uniqueIndex("weekly_reviews_user_week_idx").on(
      table.userId,
      table.weekKey
    ),
    userGeneratedIdx: index("weekly_reviews_user_generated_idx").on(
      table.userId,
      table.generatedAt
    ),
    statusIdx: index("weekly_reviews_status_idx").on(table.status),
  })
);

export type WeeklyReview = typeof weeklyReviews.$inferSelect;
export type InsertWeeklyReview = typeof weeklyReviews.$inferInsert;
