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
} from "drizzle-orm/mysql-core";

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

// Conversations table. Original home was the ChatGPT widget's
// chat history; Task 4.5 V2 extends it to the shared AskAiPanel
// by adding a `source` tag. Existing ChatGPT rows leave `source`
// null; AskAiPanel writes `ask-ai:${moduleKey}` so panels filter
// their own history without cross-contaminating the widget view.

export const conversations = mysqlTable(
  "conversations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    title: text("title").notNull(),
    /**
     * Module origin tag. Null = legacy ChatGPT widget row.
     * AskAiPanel writes `ask-ai:${moduleKey}` for every conversation
     * it creates. Indexed alongside `userId` for per-module queries.
     */
    source: varchar("source", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt").defaultNow(),
  },
  (table) => ({
    userSourceIdx: index("conversations_user_source_idx").on(
      table.userId,
      table.source
    ),
  })
);

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
