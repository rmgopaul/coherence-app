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
