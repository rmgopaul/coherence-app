import {
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  int,
  uniqueIndex,
  index,
  double,
  boolean,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Integration connections table to store OAuth tokens
export const integrations = mysqlTable("integrations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: int("userId").notNull(),
  provider: varchar("provider", { length: 64 }).notNull(), // todoist, google, whoop, samsung-health, openai
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  expiresAt: timestamp("expiresAt"),
  scope: text("scope"),
  metadata: text("metadata"), // JSON string for provider-specific data
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export type Integration = typeof integrations.$inferSelect;
export type InsertIntegration = typeof integrations.$inferInsert;

// User preferences for dashboard layout
export const userPreferences = mysqlTable("userPreferences", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: int("userId").notNull().unique(),
  displayName: varchar("displayName", { length: 120 }),
  enabledWidgets: text("enabledWidgets"), // JSON array of enabled widget IDs
  widgetLayout: text("widgetLayout"), // JSON object for widget positions
  theme: varchar("theme", { length: 32 }).default("light"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type InsertUserPreference = typeof userPreferences.$inferInsert;

// OAuth credentials table for storing client IDs and secrets
export const oauthCredentials = mysqlTable("oauthCredentials", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: int("userId").notNull(),
  provider: varchar("provider", { length: 64 }).notNull(), // google, whoop
  clientId: text("clientId"),
  clientSecret: text("clientSecret"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
}, (table) => ({
  userProviderIdx: uniqueIndex("user_provider_idx").on(table.userId, table.provider),
}));

export type OAuthCredential = typeof oauthCredentials.$inferSelect;
export type InsertOAuthCredential = typeof oauthCredentials.$inferInsert;

// Conversations table for ChatGPT chat history
export const conversations = mysqlTable("conversations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: int("userId").notNull(),
  title: text("title").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

// Messages table for individual chat messages
export const messages = mysqlTable("messages", {
  id: varchar("id", { length: 64 }).primaryKey(),
  conversationId: varchar("conversationId", { length: 64 }).notNull(),
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

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
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("habit_definitions_user_idx").on(table.userId),
    userNameIdx: uniqueIndex("habit_definitions_user_name_idx").on(table.userId, table.name),
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

// User-authored notes stored natively in Coherence.
export const notes = mysqlTable(
  "notes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    notebook: varchar("notebook", { length: 120 }).default("General").notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    content: text("content").notNull(),
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
export const solarRecDashboardStorage = mysqlTable(
  "solarRecDashboardStorage",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    storageKey: varchar("storageKey", { length: 191 }).notNull(),
    chunkIndex: int("chunkIndex").notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userKeyChunkIdx: uniqueIndex("solar_rec_dashboard_storage_user_key_chunk_idx").on(
      table.userId,
      table.storageKey,
      table.chunkIndex
    ),
    userKeyIdx: index("solar_rec_dashboard_storage_user_key_idx").on(table.userId, table.storageKey),
  })
);

export type SolarRecDashboardStorage = typeof solarRecDashboardStorage.$inferSelect;
export type InsertSolarRecDashboardStorage = typeof solarRecDashboardStorage.$inferInsert;
