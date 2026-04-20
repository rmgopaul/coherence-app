import {
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  int,
  uniqueIndex,
  index,
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

// Per-team coworker accounts for the Solar REC dashboard.
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

// ---------------------------------------------------------------------------
// "King of the day" pinned headline. One row per (userId, dateKey);
// upserted on manual pin, deleted on unpin (so the next .get() re-runs
// the rules-based picker).
// ---------------------------------------------------------------------------

export const userKingOfDay = mysqlTable(
  "userKingOfDay",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    dateKey: varchar("dateKey", { length: 10 }).notNull(), // YYYY-MM-DD, local TZ
    source: mysqlEnum("source", ["auto", "manual", "ai"]).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    reason: varchar("reason", { length: 500 }),
    taskId: varchar("taskId", { length: 128 }),
    eventId: varchar("eventId", { length: 128 }),
    pinnedAt: timestamp("pinnedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userDateIdx: uniqueIndex("userKingOfDay_user_date_idx").on(
      table.userId,
      table.dateKey
    ),
  })
);

export type UserKingOfDay = typeof userKingOfDay.$inferSelect;
export type InsertUserKingOfDay = typeof userKingOfDay.$inferInsert;
