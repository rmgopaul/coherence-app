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
  metadata: mediumtext("metadata"), // JSON string for provider-specific data
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

// Section engagement tracking for dashboard utility feedback.
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

// TOTP two-factor authentication secrets (one per user).
export const userTotpSecrets = mysqlTable(
  "userTotpSecrets",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    secret: varchar("secret", { length: 256 }).notNull(), // base32-encoded TOTP secret
    verified: boolean("verified").default(false).notNull(), // true once setup confirmed with valid code
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: uniqueIndex("user_totp_secrets_user_idx").on(table.userId),
  })
);

export type UserTotpSecret = typeof userTotpSecrets.$inferSelect;
export type InsertUserTotpSecret = typeof userTotpSecrets.$inferInsert;

// One-time recovery codes for 2FA backup access.
export const userRecoveryCodes = mysqlTable(
  "userRecoveryCodes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    codeHash: varchar("codeHash", { length: 128 }).notNull(), // SHA-256 hash
    usedAt: timestamp("usedAt"), // NULL = unused
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    userIdx: index("user_recovery_codes_user_idx").on(table.userId),
  })
);

export type UserRecoveryCode = typeof userRecoveryCodes.$inferSelect;
export type InsertUserRecoveryCode = typeof userRecoveryCodes.$inferInsert;

// SunPower PVS production readings submitted from the mobile app.
export const productionReadings = mysqlTable(
  "productionReadings",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    customerEmail: varchar("customerEmail", { length: 320 }).notNull(),
    nonId: varchar("nonId", { length: 64 }),
    lifetimeKwh: double("lifetimeKwh").notNull(),
    meterSerial: varchar("meterSerial", { length: 128 }),
    firmwareVersion: varchar("firmwareVersion", { length: 64 }),
    pvsSerial5: varchar("pvsSerial5", { length: 5 }),
    readAt: timestamp("readAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    emailIdx: index("production_readings_email_idx").on(table.customerEmail),
    nonIdIdx: index("production_readings_nonid_idx").on(table.nonId),
    readAtIdx: index("production_readings_read_at_idx").on(table.readAt),
  })
);

export type ProductionReading = typeof productionReadings.$inferSelect;
export type InsertProductionReading = typeof productionReadings.$inferInsert;

// ---------------------------------------------------------------------------
// Solar REC multi-user tables
// ---------------------------------------------------------------------------

// User accounts for the Solar REC application (Google OAuth only).
export const solarRecUsers = mysqlTable(
  "solarRecUsers",
  {
    id: int("id").autoincrement().primaryKey(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    name: varchar("name", { length: 255 }),
    googleOpenId: varchar("googleOpenId", { length: 64 }).unique(),
    avatarUrl: varchar("avatarUrl", { length: 512 }),
    role: mysqlEnum("role", ["owner", "admin", "operator", "viewer"]).default("operator").notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    invitedBy: int("invitedBy"),
    lastSignedIn: timestamp("lastSignedIn"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    emailIdx: index("solar_rec_users_email_idx").on(table.email),
    googleOpenIdIdx: index("solar_rec_users_google_open_id_idx").on(table.googleOpenId),
  })
);

export type SolarRecUser = typeof solarRecUsers.$inferSelect;
export type InsertSolarRecUser = typeof solarRecUsers.$inferInsert;

// Time-limited invite tokens for onboarding coworkers.
export const solarRecInvites = mysqlTable(
  "solarRecInvites",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).default("operator").notNull(),
    tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
    createdBy: int("createdBy").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    emailIdx: index("solar_rec_invites_email_idx").on(table.email),
  })
);

export type SolarRecInvite = typeof solarRecInvites.$inferSelect;
export type InsertSolarRecInvite = typeof solarRecInvites.$inferInsert;

// Shared API credentials used by the whole Solar REC team.
export const solarRecTeamCredentials = mysqlTable(
  "solarRecTeamCredentials",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    connectionName: varchar("connectionName", { length: 128 }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    expiresAt: timestamp("expiresAt"),
    metadata: mediumtext("metadata"), // JSON - apiKey, apiSecret, baseUrl, connection configs
    createdBy: int("createdBy").notNull(),
    updatedBy: int("updatedBy"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    providerIdx: index("solar_rec_team_credentials_provider_idx").on(table.provider),
  })
);

export type SolarRecTeamCredential = typeof solarRecTeamCredentials.$inferSelect;
export type InsertSolarRecTeamCredential = typeof solarRecTeamCredentials.$inferInsert;

// Per-site, per-date API call results for the Monitoring Dashboard.
export const monitoringApiRuns = mysqlTable(
  "monitoringApiRuns",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    connectionId: varchar("connectionId", { length: 64 }),
    siteId: varchar("siteId", { length: 128 }).notNull(),
    siteName: varchar("siteName", { length: 255 }),
    dateKey: varchar("dateKey", { length: 10 }).notNull(), // YYYY-MM-DD
    status: mysqlEnum("status", ["success", "error", "no_data", "skipped"]).notNull(),
    readingsCount: int("readingsCount").default(0).notNull(),
    lifetimeKwh: double("lifetimeKwh"),
    errorMessage: text("errorMessage"),
    durationMs: int("durationMs"),
    triggeredBy: int("triggeredBy"),
    triggeredAt: timestamp("triggeredAt"),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    providerSiteDateIdx: uniqueIndex("monitoring_api_runs_provider_site_date_idx").on(
      table.provider,
      table.siteId,
      table.dateKey
    ),
    dateKeyIdx: index("monitoring_api_runs_date_key_idx").on(table.dateKey),
    providerDateIdx: index("monitoring_api_runs_provider_date_idx").on(table.provider, table.dateKey),
    statusDateIdx: index("monitoring_api_runs_status_date_idx").on(table.status, table.dateKey),
  })
);

export type MonitoringApiRun = typeof monitoringApiRuns.$inferSelect;
export type InsertMonitoringApiRun = typeof monitoringApiRuns.$inferInsert;

// Tracks batch "Run All" operations for the Monitoring Dashboard.
export const monitoringBatchRuns = mysqlTable(
  "monitoringBatchRuns",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed"]).default("running").notNull(),
    totalSites: int("totalSites").default(0).notNull(),
    successCount: int("successCount").default(0).notNull(),
    errorCount: int("errorCount").default(0).notNull(),
    noDataCount: int("noDataCount").default(0).notNull(),
    currentProvider: varchar("currentProvider", { length: 64 }),
    currentCredentialName: varchar("currentCredentialName", { length: 128 }),
    providersTotal: int("providersTotal").default(0).notNull(),
    providersCompleted: int("providersCompleted").default(0).notNull(),
    triggeredBy: int("triggeredBy"),
    startedAt: timestamp("startedAt").defaultNow(),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    dateKeyIdx: index("monitoring_batch_runs_date_key_idx").on(table.dateKey),
    statusIdx: index("monitoring_batch_runs_status_idx").on(table.status),
  })
);

export type MonitoringBatchRun = typeof monitoringBatchRuns.$inferSelect;
export type InsertMonitoringBatchRun = typeof monitoringBatchRuns.$inferInsert;
