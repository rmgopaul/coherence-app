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

export const solarRecDatasetSyncState = mysqlTable(
  "solarRecDatasetSyncState",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    storageKey: varchar("storageKey", { length: 191 }).notNull(),
    payloadSha256: varchar("payloadSha256", { length: 64 }).notNull().default(""),
    payloadBytes: int("payloadBytes").notNull().default(0),
    dbPersisted: boolean("dbPersisted").notNull().default(false),
    storageSynced: boolean("storageSynced").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userStorageKeyIdx: uniqueIndex("solar_rec_dataset_sync_state_user_key_idx").on(
      table.userId,
      table.storageKey
    ),
    userUpdatedAtIdx: index("solar_rec_dataset_sync_state_user_updated_idx").on(
      table.userId,
      table.updatedAt
    ),
  })
);

export type SolarRecDatasetSyncState = typeof solarRecDatasetSyncState.$inferSelect;
export type InsertSolarRecDatasetSyncState = typeof solarRecDatasetSyncState.$inferInsert;

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
    // Previously: unique on (provider, siteId, dateKey). That collided when
    // multiple logins for the same provider managed the same site on the
    // same day — the second run overwrote the first. connectionId is now
    // part of the unique key so each (provider, connection, site, date)
    // combination owns its own row.
    providerConnectionSiteDateIdx: uniqueIndex(
      "monitoring_api_runs_provider_conn_site_date_idx"
    ).on(table.provider, table.connectionId, table.siteId, table.dateKey),
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

// Tracks contract scraping jobs for ABP settlement (CSG portal).
export const contractScanJobs = mysqlTable(
  "contractScanJobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    status: mysqlEnum("status", [
      "queued",
      "running",
      "stopping",
      "stopped",
      "completed",
      "failed",
    ])
      .default("queued")
      .notNull(),
    totalContracts: int("totalContracts").default(0).notNull(),
    successCount: int("successCount").default(0).notNull(),
    failureCount: int("failureCount").default(0).notNull(),
    currentCsgId: varchar("currentCsgId", { length: 64 }),
    error: text("error"),
    startedAt: timestamp("startedAt"),
    stoppedAt: timestamp("stoppedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("contract_scan_jobs_user_idx").on(table.userId),
    statusIdx: index("contract_scan_jobs_status_idx").on(table.status),
  })
);

export type ContractScanJob = typeof contractScanJobs.$inferSelect;
export type InsertContractScanJob = typeof contractScanJobs.$inferInsert;

// Input CSG IDs for a contract scan job (one row per ID).
export const contractScanJobCsgIds = mysqlTable(
  "contractScanJobCsgIds",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
  },
  (table) => ({
    jobCsgIdx: uniqueIndex("contract_scan_job_csg_ids_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    jobIdx: index("contract_scan_job_csg_ids_job_idx").on(table.jobId),
  })
);

export type ContractScanJobCsgId = typeof contractScanJobCsgIds.$inferSelect;
export type InsertContractScanJobCsgId =
  typeof contractScanJobCsgIds.$inferInsert;

// Per-contract scan results from CSG portal scraping.
export const contractScanResults = mysqlTable(
  "contractScanResults",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
    systemName: varchar("systemName", { length: 255 }),
    vendorFeePercent: double("vendorFeePercent"),
    additionalCollateralPercent: double("additionalCollateralPercent"),
    ccAuthorizationCompleted: boolean("ccAuthorizationCompleted"),
    additionalFivePercentSelected: boolean("additionalFivePercentSelected"),
    ccCardAsteriskCount: int("ccCardAsteriskCount"),
    paymentMethod: varchar("paymentMethod", { length: 64 }),
    payeeName: varchar("payeeName", { length: 255 }),
    mailingAddress1: varchar("mailingAddress1", { length: 255 }),
    mailingAddress2: varchar("mailingAddress2", { length: 255 }),
    cityStateZip: varchar("cityStateZip", { length: 255 }),
    recQuantity: double("recQuantity"),
    recPrice: double("recPrice"),
    acSizeKw: double("acSizeKw"),
    dcSizeKw: double("dcSizeKw"),
    pdfUrl: varchar("pdfUrl", { length: 512 }),
    pdfFileName: varchar("pdfFileName", { length: 255 }),
    error: text("error"),
    scannedAt: timestamp("scannedAt").defaultNow(),
    // Manual overrides — take precedence over scanned values when present.
    overrideVendorFeePercent: double("overrideVendorFeePercent"),
    overrideAdditionalCollateralPercent: double("overrideAdditionalCollateralPercent"),
    overrideNotes: varchar("overrideNotes", { length: 512 }),
    overriddenAt: timestamp("overriddenAt"),
  },
  (table) => ({
    jobIdx: index("contract_scan_results_job_idx").on(table.jobId),
    jobCsgIdx: uniqueIndex("contract_scan_results_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    csgIdx: index("contract_scan_results_csg_idx").on(table.csgId),
  })
);

export type ContractScanResult = typeof contractScanResults.$inferSelect;
export type InsertContractScanResult =
  typeof contractScanResults.$inferInsert;

// Tracks server-backed Schedule B PDF import jobs.
export const scheduleBImportJobs = mysqlTable(
  "scheduleBImportJobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    status: varchar("status", { length: 32 }).default("queued").notNull(),
    currentFileName: varchar("currentFileName", { length: 255 }),
    // Atomic counters mirroring contractScanJobs. The runner increments
    // these after each processed file so the UI can show progress from
    // a single job-row query instead of COUNT(*) over a file-state table.
    totalFiles: int("totalFiles").default(0).notNull(),
    successCount: int("successCount").default(0).notNull(),
    failureCount: int("failureCount").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("startedAt"),
    stoppedAt: timestamp("stoppedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdx: index("schedule_b_import_jobs_user_idx").on(table.userId),
    statusIdx: index("schedule_b_import_jobs_status_idx").on(table.status),
  })
);

export type ScheduleBImportJob = typeof scheduleBImportJobs.$inferSelect;
export type InsertScheduleBImportJob = typeof scheduleBImportJobs.$inferInsert;

// Tracks each uploaded Schedule B PDF within a job.
export const scheduleBImportFiles = mysqlTable(
  "scheduleBImportFiles",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    fileSize: int("fileSize"),
    storageKey: varchar("storageKey", { length: 512 }),
    status: varchar("status", { length: 32 }).default("uploading").notNull(),
    uploadedChunks: int("uploadedChunks").default(0).notNull(),
    totalChunks: int("totalChunks").default(0).notNull(),
    error: text("error"),
    processedAt: timestamp("processedAt"),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
  },
  (table) => ({
    jobFileIdx: uniqueIndex("schedule_b_import_files_job_file_idx").on(
      table.jobId,
      table.fileName
    ),
    jobStatusIdx: index("schedule_b_import_files_job_status_idx").on(
      table.jobId,
      table.status
    ),
    jobCreatedIdx: index("schedule_b_import_files_job_created_idx").on(
      table.jobId,
      table.createdAt
    ),
  })
);

export type ScheduleBImportFile = typeof scheduleBImportFiles.$inferSelect;
export type InsertScheduleBImportFile = typeof scheduleBImportFiles.$inferInsert;

// Extraction output per Schedule B PDF.
export const scheduleBImportResults = mysqlTable(
  "scheduleBImportResults",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    designatedSystemId: varchar("designatedSystemId", { length: 64 }),
    gatsId: varchar("gatsId", { length: 64 }),
    acSizeKw: double("acSizeKw"),
    capacityFactor: double("capacityFactor"),
    contractPrice: double("contractPrice"),
    contractNumber: varchar("contractNumber", { length: 32 }),
    energizationDate: varchar("energizationDate", { length: 32 }),
    maxRecQuantity: int("maxRecQuantity"),
    deliveryYearsJson: text("deliveryYearsJson"),
    error: text("error"),
    scannedAt: timestamp("scannedAt").defaultNow(),
    // NULL = not yet applied to deliveryScheduleBase. Set to NOW() by
    // applyScheduleBToDeliveryObligations after a successful merge. The
    // "Apply as Delivery Schedule (N)" button counter binds to
    // COUNT(*) WHERE appliedAt IS NULL, so it decreases on apply and
    // survives navigation/reload (solves the "counter grows forever"
    // UX bug).
    appliedAt: timestamp("appliedAt"),
  },
  (table) => ({
    jobFileIdx: uniqueIndex("schedule_b_import_results_job_file_idx").on(
      table.jobId,
      table.fileName
    ),
    jobIdx: index("schedule_b_import_results_job_idx").on(table.jobId),
    gatsIdx: index("schedule_b_import_results_gats_idx").on(table.gatsId),
    // Supports the pendingApplyCount query in getScheduleBImportStatus:
    // SELECT COUNT(*) WHERE jobId=? AND error IS NULL AND appliedAt IS NULL.
    jobAppliedIdx: index("schedule_b_import_results_job_applied_idx").on(
      table.jobId,
      table.appliedAt
    ),
  })
);

export type ScheduleBImportResult = typeof scheduleBImportResults.$inferSelect;
export type InsertScheduleBImportResult = typeof scheduleBImportResults.$inferInsert;

export const scheduleBImportCsgIds = mysqlTable(
  "scheduleBImportCsgIds",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
    nonId: varchar("nonId", { length: 64 }),
    abpId: varchar("abpId", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow(),
  },
  (table) => ({
    jobCsgIdx: uniqueIndex("schedule_b_csg_ids_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    jobIdx: index("schedule_b_csg_ids_job_idx").on(table.jobId),
  })
);

// ---------------------------------------------------------------------------
// Solar REC Server-Side Architecture — Foundational Tables
// ---------------------------------------------------------------------------

export const solarRecScopes = mysqlTable("solarRecScopes", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }),
  ownerUserId: int("ownerUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SolarRecScope = typeof solarRecScopes.$inferSelect;
export type InsertSolarRecScope = typeof solarRecScopes.$inferInsert;

export const solarRecImportBatches = mysqlTable(
  "solarRecImportBatches",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    datasetKey: varchar("datasetKey", { length: 64 }).notNull(),
    ingestSource: varchar("ingestSource", { length: 16 }).notNull(), // upload | scanner | migration
    mergeStrategy: varchar("mergeStrategy", { length: 16 }).notNull(), // replace | append
    status: varchar("status", { length: 16 }).notNull(), // uploading | processing | active | superseded | archived | failed
    rowCount: int("rowCount"),
    error: text("error"),
    importedBy: int("importedBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (table) => ({
    scopeDatasetStatusIdx: index("sr_import_batches_scope_ds_status_idx").on(
      table.scopeId,
      table.datasetKey,
      table.status
    ),
  })
);

export type SolarRecImportBatch = typeof solarRecImportBatches.$inferSelect;
export type InsertSolarRecImportBatch = typeof solarRecImportBatches.$inferInsert;

export const solarRecImportFiles = mysqlTable(
  "solarRecImportFiles",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    storageKey: varchar("storageKey", { length: 512 }),
    sizeBytes: int("sizeBytes"),
    rowCount: int("rowCount"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_import_files_batch_idx").on(table.batchId),
  })
);

export type SolarRecImportFile = typeof solarRecImportFiles.$inferSelect;
export type InsertSolarRecImportFile = typeof solarRecImportFiles.$inferInsert;

export const solarRecImportErrors = mysqlTable(
  "solarRecImportErrors",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    rowIndex: int("rowIndex"),
    columnName: varchar("columnName", { length: 128 }),
    errorType: varchar("errorType", { length: 64 }),
    message: text("message"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_import_errors_batch_idx").on(table.batchId),
  })
);

export type SolarRecImportError = typeof solarRecImportErrors.$inferSelect;
export type InsertSolarRecImportError = typeof solarRecImportErrors.$inferInsert;

export const solarRecActiveDatasetVersions = mysqlTable(
  "solarRecActiveDatasetVersions",
  {
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    datasetKey: varchar("datasetKey", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    activatedAt: timestamp("activatedAt").defaultNow().notNull(),
  },
  (table) => ({
    pk: uniqueIndex("sr_active_versions_pk").on(table.scopeId, table.datasetKey),
  })
);

export type SolarRecActiveDatasetVersion = typeof solarRecActiveDatasetVersions.$inferSelect;

export const solarRecComputeRuns = mysqlTable(
  "solarRecComputeRuns",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    artifactType: varchar("artifactType", { length: 64 }).notNull(), // system_snapshot | delivery_allocations | financials
    inputVersionHash: varchar("inputVersionHash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(), // running | completed | failed
    rowCount: int("rowCount"),
    error: text("error"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (table) => ({
    claimIdx: uniqueIndex("sr_compute_runs_claim_idx").on(
      table.scopeId,
      table.artifactType,
      table.inputVersionHash
    ),
    scopeArtifactStatusIdx: index("sr_compute_runs_scope_artifact_status_idx").on(
      table.scopeId,
      table.artifactType,
      table.status
    ),
  })
);

export type SolarRecComputeRun = typeof solarRecComputeRuns.$inferSelect;
export type InsertSolarRecComputeRun = typeof solarRecComputeRuns.$inferInsert;

// ---------------------------------------------------------------------------
// Solar REC Computed Artifacts
//
// Cache table for expensive per-scope computations (system snapshot,
// delivery allocations, financials). Keyed by (scopeId, artifactType,
// inputVersionHash) with a UNIQUE index so upserts can be atomic.
// The payload column holds the serialized result (typically JSON);
// row counts are tracked separately for telemetry / UI display.
// ---------------------------------------------------------------------------

export const solarRecComputedArtifacts = mysqlTable(
  "solarRecComputedArtifacts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    artifactType: varchar("artifactType", { length: 64 }).notNull(),
    inputVersionHash: varchar("inputVersionHash", { length: 64 }).notNull(),
    payload: mediumtext("payload").notNull(),
    rowCount: int("rowCount"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex("sr_computed_artifacts_key_idx").on(
      table.scopeId,
      table.artifactType,
      table.inputVersionHash
    ),
    scopeTypeUpdatedIdx: index("sr_computed_artifacts_scope_type_updated_idx").on(
      table.scopeId,
      table.artifactType,
      table.updatedAt
    ),
  })
);

export type SolarRecComputedArtifact = typeof solarRecComputedArtifacts.$inferSelect;
export type InsertSolarRecComputedArtifact = typeof solarRecComputedArtifacts.$inferInsert;

// ---------------------------------------------------------------------------
// Solar REC Normalized Dataset Tables (Step 3)
// Core 7 datasets. Each row belongs to a batch (via batchId).
// Typed columns for commonly-queried fields + rawRow JSON for the long tail.
// ---------------------------------------------------------------------------

export const srDsSolarApplications = mysqlTable(
  "srDsSolarApplications",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    applicationId: varchar("applicationId", { length: 64 }),
    systemId: varchar("systemId", { length: 64 }),
    trackingSystemRefId: varchar("trackingSystemRefId", { length: 64 }),
    stateCertificationNumber: varchar("stateCertificationNumber", { length: 64 }),
    systemName: varchar("systemName", { length: 255 }),
    installedKwAc: double("installedKwAc"),
    installedKwDc: double("installedKwDc"),
    recPrice: double("recPrice"),
    totalContractAmount: double("totalContractAmount"),
    annualRecs: double("annualRecs"),
    contractType: varchar("contractType", { length: 128 }),
    installerName: varchar("installerName", { length: 255 }),
    county: varchar("county", { length: 128 }),
    state: varchar("state", { length: 64 }),
    zipCode: varchar("zipCode", { length: 16 }),
    rawRow: mediumtext("rawRow"), // JSON of full CsvRow for all other fields
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_solar_apps_batch_idx").on(table.batchId),
    scopeTrackingIdx: index("sr_ds_solar_apps_scope_tracking_idx").on(
      table.scopeId,
      table.trackingSystemRefId
    ),
    scopeAppIdIdx: index("sr_ds_solar_apps_scope_appid_idx").on(
      table.scopeId,
      table.applicationId
    ),
  })
);

export type SrDsSolarApplication = typeof srDsSolarApplications.$inferSelect;
export type InsertSrDsSolarApplication = typeof srDsSolarApplications.$inferInsert;

export const srDsAbpReport = mysqlTable(
  "srDsAbpReport",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    applicationId: varchar("applicationId", { length: 64 }),
    systemId: varchar("systemId", { length: 64 }),
    trackingSystemRefId: varchar("trackingSystemRefId", { length: 64 }),
    projectName: varchar("projectName", { length: 255 }),
    part2AppVerificationDate: varchar("part2AppVerificationDate", { length: 32 }),
    inverterSizeKwAc: double("inverterSizeKwAc"),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_report_batch_idx").on(table.batchId),
    scopeAppIdIdx: index("sr_ds_abp_report_scope_appid_idx").on(
      table.scopeId,
      table.applicationId
    ),
  })
);

export type SrDsAbpReport = typeof srDsAbpReport.$inferSelect;
export type InsertSrDsAbpReport = typeof srDsAbpReport.$inferInsert;

export const srDsGenerationEntry = mysqlTable(
  "srDsGenerationEntry",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    unitId: varchar("unitId", { length: 64 }),
    facilityName: varchar("facilityName", { length: 255 }),
    lastMonthOfGen: varchar("lastMonthOfGen", { length: 32 }),
    effectiveDate: varchar("effectiveDate", { length: 32 }),
    onlineMonitoring: varchar("onlineMonitoring", { length: 255 }),
    onlineMonitoringAccessType: varchar("onlineMonitoringAccessType", { length: 64 }),
    onlineMonitoringSystemId: varchar("onlineMonitoringSystemId", { length: 255 }),
    onlineMonitoringSystemName: varchar("onlineMonitoringSystemName", { length: 255 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_gen_entry_batch_idx").on(table.batchId),
    scopeUnitIdx: index("sr_ds_gen_entry_scope_unit_idx").on(
      table.scopeId,
      table.unitId
    ),
  })
);

export type SrDsGenerationEntry = typeof srDsGenerationEntry.$inferSelect;
export type InsertSrDsGenerationEntry = typeof srDsGenerationEntry.$inferInsert;

export const srDsAccountSolarGeneration = mysqlTable(
  "srDsAccountSolarGeneration",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    gatsGenId: varchar("gatsGenId", { length: 64 }),
    facilityName: varchar("facilityName", { length: 255 }),
    monthOfGeneration: varchar("monthOfGeneration", { length: 32 }),
    lastMeterReadDate: varchar("lastMeterReadDate", { length: 32 }),
    lastMeterReadKwh: varchar("lastMeterReadKwh", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_acct_solar_gen_batch_idx").on(table.batchId),
    scopeGatsIdx: index("sr_ds_acct_solar_gen_scope_gats_idx").on(
      table.scopeId,
      table.gatsGenId
    ),
  })
);

export type SrDsAccountSolarGeneration = typeof srDsAccountSolarGeneration.$inferSelect;
export type InsertSrDsAccountSolarGeneration = typeof srDsAccountSolarGeneration.$inferInsert;

export const srDsContractedDate = mysqlTable(
  "srDsContractedDate",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    systemId: varchar("systemId", { length: 64 }),
    contractedDate: varchar("contractedDate", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_contracted_date_batch_idx").on(table.batchId),
    scopeSystemIdx: index("sr_ds_contracted_date_scope_system_idx").on(
      table.scopeId,
      table.systemId
    ),
  })
);

export type SrDsContractedDate = typeof srDsContractedDate.$inferSelect;
export type InsertSrDsContractedDate = typeof srDsContractedDate.$inferInsert;

export const srDsDeliverySchedule = mysqlTable(
  "srDsDeliverySchedule",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    trackingSystemRefId: varchar("trackingSystemRefId", { length: 64 }),
    systemName: varchar("systemName", { length: 255 }),
    utilityContractNumber: varchar("utilityContractNumber", { length: 64 }),
    batchIdRef: varchar("batchIdRef", { length: 64 }),
    stateCertificationNumber: varchar("stateCertificationNumber", { length: 64 }),
    rawRow: mediumtext("rawRow"), // Contains year1-15 columns as JSON
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_delivery_schedule_batch_idx").on(table.batchId),
    scopeTrackingIdx: index("sr_ds_delivery_schedule_scope_tracking_idx").on(
      table.scopeId,
      table.trackingSystemRefId
    ),
  })
);

export type SrDsDeliverySchedule = typeof srDsDeliverySchedule.$inferSelect;
export type InsertSrDsDeliverySchedule = typeof srDsDeliverySchedule.$inferInsert;

export const srDsTransferHistory = mysqlTable(
  "srDsTransferHistory",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    transactionId: varchar("transactionId", { length: 64 }),
    unitId: varchar("unitId", { length: 64 }),
    transferCompletionDate: varchar("transferCompletionDate", { length: 32 }),
    quantity: double("quantity"),
    transferor: varchar("transferor", { length: 255 }),
    transferee: varchar("transferee", { length: 255 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_transfer_history_batch_idx").on(table.batchId),
    scopeUnitIdx: index("sr_ds_transfer_history_scope_unit_idx").on(
      table.scopeId,
      table.unitId
    ),
  })
);

// ---------------------------------------------------------------------------
// Scope-Aware Contract Scan Bridge (Step 7)
// Tracks the latest completed scan job + latest override timestamp per scope.
// Updated on: job completion + override mutation.
// ---------------------------------------------------------------------------

export const solarRecScopeContractScanVersion = mysqlTable(
  "solarRecScopeContractScanVersion",
  {
    scopeId: varchar("scopeId", { length: 64 }).primaryKey(),
    latestCompletedJobId: varchar("latestCompletedJobId", { length: 64 }),
    latestOverrideAt: timestamp("latestOverrideAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  }
);
