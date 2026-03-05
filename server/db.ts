import { eq, and, desc, asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type PoolOptions } from "mysql2";
import { 
  InsertUser, 
  users, 
  integrations, 
  userPreferences, 
  oauthCredentials, 
  conversations, 
  messages,
  dailyHealthMetrics,
  supplementLogs,
  supplementDefinitions,
  habitDefinitions,
  habitCompletions,
  notes,
  noteLinks,
  dailySnapshots,
  samsungSyncPayloads,
  solarRecDashboardStorage,
  InsertIntegration,
  InsertUserPreference,
  InsertOAuthCredential,
  InsertConversation,
  InsertMessage,
  InsertDailyHealthMetric,
  InsertSupplementLog,
  InsertSupplementDefinition,
  InsertHabitDefinition,
  InsertNote,
  InsertNoteLink,
  InsertDailySnapshot,
  InsertSamsungSyncPayload,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { nanoid } from 'nanoid';

let _db: ReturnType<typeof drizzle> | null = null;
let _solarRecDashboardTableEnsured = false;
const SOLAR_REC_DB_CHUNK_CHARS = 60_000;

const RETRYABLE_DB_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
]);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === "string") return cause.code;
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const direct = (error as { message?: unknown }).message;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { message?: unknown } }).cause;
  if (cause && typeof cause.message === "string") return cause.message;
  return "";
}

function isRetryableDbError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && RETRYABLE_DB_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getErrorMessage(error);
  return (
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("PROTOCOL_CONNECTION_LOST")
  );
}

function buildDbUnavailableError(operation: string, originalError: unknown): Error {
  const error = new Error(
    `[Database] ${operation} failed: unable to reach TiDB. Check TiDB Network Access allowlist and outbound port 4000.`
  );
  (error as { cause?: unknown }).cause = originalError;
  return error;
}

async function withDbRetry<T>(operation: string, action: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableDbError(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw buildDbUnavailableError(operation, error);
      }
      await sleep(200 * attempt);
    }
  }
  throw buildDbUnavailableError(operation, lastError);
}

function parseDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name");
  }

  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isFinite(port)) {
    throw new Error("DATABASE_URL contains an invalid port");
  }

  return {
    host: url.hostname,
    port,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
  };
}

function buildPoolOptions(connectionString: string): PoolOptions {
  const parsed = parseDatabaseUrl(connectionString);
  const sslEnabled = !["false", "0", "off"].includes(
    (process.env.DATABASE_SSL ?? "").trim().toLowerCase()
  );
  const sslRejectUnauthorized = !["false", "0", "off"].includes(
    (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase()
  );

  return {
    ...parsed,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    ...(sslEnabled
      ? {
          ssl: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: sslRejectUnauthorized,
          },
        }
      : {}),
  };
}

function splitIntoChunks(value: string, chunkSize: number): string[] {
  if (value.length <= chunkSize) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

async function ensureSolarRecDashboardStorageTable() {
  const db = await getDb();
  if (!db) return false;
  if (_solarRecDashboardTableEnsured) return true;

  await withDbRetry("ensure solar rec dashboard storage table", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS solarRecDashboardStorage (
        id varchar(64) NOT NULL,
        userId int NOT NULL,
        storageKey varchar(191) NOT NULL,
        chunkIndex int NOT NULL,
        payload text NOT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY solar_rec_dashboard_storage_user_key_chunk_idx (userId, storageKey, chunkIndex),
        KEY solar_rec_dashboard_storage_user_key_idx (userId, storageKey)
      )
    `);
  });

  _solarRecDashboardTableEnsured = true;
  return true;
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = createPool(buildPoolOptions(process.env.DATABASE_URL));
      await pool.promise().query("select 1");
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await withDbRetry("upsert user", async () => {
      await db.insert(users).values(values).onDuplicateKeyUpdate({
        set: updateSet,
      });
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await withDbRetry("load user", async () =>
    db.select().from(users).where(eq(users.openId, openId)).limit(1)
  );

  return result.length > 0 ? result[0] : undefined;
}

export async function listUsers() {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list users", async () => db.select().from(users));
}

// Integration functions
export async function getUserIntegrations(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return withDbRetry("list integrations", async () =>
    db.select().from(integrations).where(eq(integrations.userId, userId))
  );
}

export async function getIntegrationsByProvider(provider: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list integrations by provider", async () =>
    db.select().from(integrations).where(eq(integrations.provider, provider))
  );
}

export async function getIntegrationByProvider(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await withDbRetry("load integration", async () =>
    db.select().from(integrations)
      .where(and(eq(integrations.userId, userId), eq(integrations.provider, provider)))
      .limit(1)
  );
    
  return result.length > 0 ? result[0] : null;
}

export async function upsertIntegration(integration: InsertIntegration) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load integration before upsert", async () =>
    db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.userId, integration.userId),
          eq(integrations.provider, integration.provider)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update integration", async () => {
      await db
        .update(integrations)
        .set({
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata: integration.metadata,
          updatedAt: now,
        })
        .where(eq(integrations.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert integration", async () => {
    await db.insert(integrations).values({
      ...integration,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteIntegration(id: string) {
  const db = await getDb();
  if (!db) return;
  
  await withDbRetry("delete integration", async () => {
    await db.delete(integrations).where(eq(integrations.id, id));
  });
}

// User preferences functions
export async function getUserPreferences(userId: number) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await withDbRetry("load user preferences", async () =>
    db.select().from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1)
  );
    
  return result.length > 0 ? result[0] : null;
}

export async function upsertUserPreferences(prefs: InsertUserPreference) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load user preferences before upsert", async () =>
    db
      .select({ id: userPreferences.id })
      .from(userPreferences)
      .where(eq(userPreferences.userId, prefs.userId))
      .limit(1)
  );

  if (existing.length > 0) {
    const updatePayload: Partial<InsertUserPreference> & { updatedAt: Date } = {
      updatedAt: now,
    };
    if (prefs.displayName !== undefined) updatePayload.displayName = prefs.displayName;
    if (prefs.enabledWidgets !== undefined) updatePayload.enabledWidgets = prefs.enabledWidgets;
    if (prefs.widgetLayout !== undefined) updatePayload.widgetLayout = prefs.widgetLayout;
    if (prefs.theme !== undefined) updatePayload.theme = prefs.theme;

    await withDbRetry("update user preferences", async () => {
      await db
        .update(userPreferences)
        .set(updatePayload)
        .where(eq(userPreferences.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert user preferences", async () => {
    await db.insert(userPreferences).values({
      ...prefs,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function getSolarRecDashboardPayload(userId: number, storageKey: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return null;

  const rows = await withDbRetry("load solar rec dashboard payload", async () =>
    db
      .select({
        payload: solarRecDashboardStorage.payload,
        chunkIndex: solarRecDashboardStorage.chunkIndex,
      })
      .from(solarRecDashboardStorage)
      .where(
        and(
          eq(solarRecDashboardStorage.userId, userId),
          eq(solarRecDashboardStorage.storageKey, storageKey)
        )
      )
      .orderBy(asc(solarRecDashboardStorage.chunkIndex))
  );

  if (rows.length === 0) return null;
  return rows.map((row) => row.payload ?? "").join("");
}

export async function saveSolarRecDashboardPayload(userId: number, storageKey: string, payload: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return false;

  const chunks = splitIntoChunks(payload, SOLAR_REC_DB_CHUNK_CHARS);
  const now = new Date();

  await withDbRetry("save solar rec dashboard payload", async () => {
    await db.transaction(async (tx) => {
      await tx
        .delete(solarRecDashboardStorage)
        .where(
          and(
            eq(solarRecDashboardStorage.userId, userId),
            eq(solarRecDashboardStorage.storageKey, storageKey)
          )
        );

      await tx.insert(solarRecDashboardStorage).values(
        chunks.map((chunk, index) => ({
          id: nanoid(),
          userId,
          storageKey,
          chunkIndex: index,
          payload: chunk,
          createdAt: now,
          updatedAt: now,
        }))
      );
    });
  });

  return true;
}

// OAuth credentials functions
export async function getOAuthCredential(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await withDbRetry("load oauth credentials", async () =>
    db.select().from(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)))
      .limit(1)
  );
    
  return result.length > 0 ? result[0] : null;
}

export async function upsertOAuthCredential(cred: InsertOAuthCredential) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load oauth credentials before upsert", async () =>
    db
      .select({ id: oauthCredentials.id })
      .from(oauthCredentials)
      .where(
        and(
          eq(oauthCredentials.userId, cred.userId),
          eq(oauthCredentials.provider, cred.provider)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update oauth credentials", async () => {
      await db
        .update(oauthCredentials)
        .set({
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          updatedAt: now,
        })
        .where(eq(oauthCredentials.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert oauth credentials", async () => {
    await db.insert(oauthCredentials).values({
      ...cred,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteOAuthCredential(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return;
  
  await withDbRetry("delete oauth credentials", async () => {
    await db.delete(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)));
  });
}

// Conversation functions
export async function getConversations(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  return withDbRetry("list conversations", async () =>
    db.select().from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(conversations.updatedAt)
  );
}

export async function createConversation(userId: number, title: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const id = nanoid();
  await withDbRetry("create conversation", async () => {
    await db.insert(conversations).values({
      id,
      userId,
      title,
    });
  });
  
  return id;
}

export async function getConversationMessages(conversationId: string) {
  const db = await getDb();
  if (!db) return [];
  
  return withDbRetry("list conversation messages", async () =>
    db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
  );
}

export async function addMessage(message: InsertMessage) {
  const db = await getDb();
  if (!db) return;
  
  await withDbRetry("insert message", async () => {
    await db.insert(messages).values(message);
  });
}

export async function deleteConversation(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return;
  
  // Delete messages first
  await withDbRetry("delete conversation messages", async () => {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
  });
  
  // Then delete conversation
  await withDbRetry("delete conversation", async () => {
    await db.delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  });
}

// Notes + links
export async function listNotes(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list notes", async () =>
    db
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(desc(notes.pinned), desc(notes.updatedAt))
      .limit(limit)
  );
}

export async function getNoteById(userId: number, noteId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load note", async () =>
    db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function createNote(entry: InsertNote) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert note", async () => {
    await db.insert(notes).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
    });
  });
}

type NoteUpdateInput = {
  notebook?: string;
  title?: string;
  content?: string;
  pinned?: boolean;
};

export async function updateNote(userId: number, noteId: string, updates: NoteUpdateInput) {
  const db = await getDb();
  if (!db) return;

  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (updates.notebook !== undefined) updatePayload.notebook = updates.notebook;
  if (updates.title !== undefined) updatePayload.title = updates.title;
  if (updates.content !== undefined) updatePayload.content = updates.content;
  if (updates.pinned !== undefined) updatePayload.pinned = updates.pinned;

  await withDbRetry("update note", async () => {
    await db
      .update(notes)
      .set(updatePayload)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)));
  });
}

export async function deleteNote(userId: number, noteId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete note links", async () => {
    await db
      .delete(noteLinks)
      .where(and(eq(noteLinks.userId, userId), eq(noteLinks.noteId, noteId)));
  });

  await withDbRetry("delete note", async () => {
    await db
      .delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.id, noteId)));
  });
}

export async function listNoteLinks(userId: number, noteId?: string, limit = 500) {
  const db = await getDb();
  if (!db) return [];

  if (noteId) {
    return withDbRetry("list note links by note", async () =>
      db
        .select()
        .from(noteLinks)
        .where(and(eq(noteLinks.userId, userId), eq(noteLinks.noteId, noteId)))
        .orderBy(desc(noteLinks.createdAt))
        .limit(limit)
    );
  }

  return withDbRetry("list note links", async () =>
    db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.userId, userId))
      .orderBy(desc(noteLinks.createdAt))
      .limit(limit)
  );
}

export async function findNoteLinkByUnique(
  userId: number,
  noteId: string,
  linkType: string,
  externalId: string,
  seriesId = "",
  occurrenceStartIso = ""
) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("find note link", async () =>
    db
      .select()
      .from(noteLinks)
      .where(
        and(
          eq(noteLinks.userId, userId),
          eq(noteLinks.noteId, noteId),
          eq(noteLinks.linkType, linkType),
          eq(noteLinks.externalId, externalId),
          eq(noteLinks.seriesId, seriesId),
          eq(noteLinks.occurrenceStartIso, occurrenceStartIso)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function addNoteLink(entry: InsertNoteLink) {
  const db = await getDb();
  if (!db) return { created: false as const, existingId: null as string | null };

  const normalizedSeriesId = entry.seriesId ?? "";
  const normalizedOccurrence = entry.occurrenceStartIso ?? "";

  const existing = await findNoteLinkByUnique(
    entry.userId,
    entry.noteId,
    entry.linkType,
    entry.externalId,
    normalizedSeriesId,
    normalizedOccurrence
  );
  if (existing) {
    return { created: false as const, existingId: existing.id };
  }

  await withDbRetry("insert note link", async () => {
    await db.insert(noteLinks).values({
      ...entry,
      seriesId: normalizedSeriesId,
      occurrenceStartIso: normalizedOccurrence,
      createdAt: new Date(),
    });
  });

  return { created: true as const, existingId: null as string | null };
}

export async function deleteNoteLink(userId: number, linkId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete note link", async () => {
    await db
      .delete(noteLinks)
      .where(and(eq(noteLinks.userId, userId), eq(noteLinks.id, linkId)));
  });
}

// Daily metrics log functions
export async function getDailyMetricByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load daily metric", async () =>
    db
      .select()
      .from(dailyHealthMetrics)
      .where(and(eq(dailyHealthMetrics.userId, userId), eq(dailyHealthMetrics.dateKey, dateKey)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function upsertDailyMetric(metric: InsertDailyHealthMetric) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load daily metric before upsert", async () =>
    db
      .select({ id: dailyHealthMetrics.id })
      .from(dailyHealthMetrics)
      .where(
        and(eq(dailyHealthMetrics.userId, metric.userId), eq(dailyHealthMetrics.dateKey, metric.dateKey))
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update daily metric", async () => {
      await db
        .update(dailyHealthMetrics)
        .set({
          whoopRecoveryScore: metric.whoopRecoveryScore,
          whoopDayStrain: metric.whoopDayStrain,
          whoopSleepHours: metric.whoopSleepHours,
          whoopHrvMs: metric.whoopHrvMs,
          whoopRestingHr: metric.whoopRestingHr,
          samsungSteps: metric.samsungSteps,
          samsungSleepHours: metric.samsungSleepHours,
          samsungSpo2AvgPercent: metric.samsungSpo2AvgPercent,
          samsungSleepScore: metric.samsungSleepScore,
          samsungEnergyScore: metric.samsungEnergyScore,
          todoistCompletedCount: metric.todoistCompletedCount,
          updatedAt: now,
        })
        .where(eq(dailyHealthMetrics.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert daily metric", async () => {
    await db.insert(dailyHealthMetrics).values({
      ...metric,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function getDailyMetricsHistory(userId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list daily metrics history", async () =>
    db
      .select()
      .from(dailyHealthMetrics)
      .where(eq(dailyHealthMetrics.userId, userId))
      .orderBy(desc(dailyHealthMetrics.dateKey))
      .limit(limit)
  );
}

// Supplement logs
export async function listSupplementLogs(userId: number, dateKey?: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  if (dateKey) {
    return withDbRetry("list supplement logs by date", async () =>
      db
        .select()
        .from(supplementLogs)
        .where(and(eq(supplementLogs.userId, userId), eq(supplementLogs.dateKey, dateKey)))
        .orderBy(desc(supplementLogs.takenAt))
        .limit(limit)
    );
  }

  return withDbRetry("list supplement logs", async () =>
    db
      .select()
      .from(supplementLogs)
      .where(eq(supplementLogs.userId, userId))
      .orderBy(desc(supplementLogs.takenAt))
      .limit(limit)
  );
}

export async function addSupplementLog(entry: InsertSupplementLog) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement log", async () => {
    await db.insert(supplementLogs).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function getSupplementLogByDefinitionAndDate(
  userId: number,
  definitionId: string,
  dateKey: string
) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load supplement log by definition/date", async () =>
    db
      .select()
      .from(supplementLogs)
      .where(
        and(
          eq(supplementLogs.userId, userId),
          eq(supplementLogs.definitionId, definitionId),
          eq(supplementLogs.dateKey, dateKey)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function deleteSupplementLog(userId: number, id: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete supplement log", async () => {
    await db
      .delete(supplementLogs)
      .where(and(eq(supplementLogs.id, id), eq(supplementLogs.userId, userId)));
  });
}

export async function listSupplementDefinitions(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list supplement definitions", async () =>
    db
      .select()
      .from(supplementDefinitions)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.isActive, true)))
      .orderBy(asc(supplementDefinitions.sortOrder), asc(supplementDefinitions.name))
  );
}

export async function createSupplementDefinition(definition: InsertSupplementDefinition) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement definition", async () => {
    await db.insert(supplementDefinitions).values({
      ...definition,
      createdAt: now,
      updatedAt: now,
    });
  });
}

type SupplementDefinitionUpdateInput = {
  name?: string;
  brand?: string | null;
  dose?: string;
  doseUnit?: string;
  dosePerUnit?: string | null;
  productUrl?: string | null;
  pricePerBottle?: number | null;
  quantityPerBottle?: number | null;
  timing?: string;
  isLocked?: boolean;
};

export async function updateSupplementDefinition(
  userId: number,
  definitionId: string,
  updates: SupplementDefinitionUpdateInput
) {
  const db = await getDb();
  if (!db) return;

  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) updatePayload.name = updates.name;
  if (updates.brand !== undefined) updatePayload.brand = updates.brand;
  if (updates.dose !== undefined) updatePayload.dose = updates.dose;
  if (updates.doseUnit !== undefined) updatePayload.doseUnit = updates.doseUnit;
  if (updates.dosePerUnit !== undefined) updatePayload.dosePerUnit = updates.dosePerUnit;
  if (updates.productUrl !== undefined) updatePayload.productUrl = updates.productUrl;
  if (updates.pricePerBottle !== undefined) updatePayload.pricePerBottle = updates.pricePerBottle;
  if (updates.quantityPerBottle !== undefined) {
    updatePayload.quantityPerBottle = updates.quantityPerBottle;
  }
  if (updates.timing !== undefined) updatePayload.timing = updates.timing;
  if (updates.isLocked !== undefined) updatePayload.isLocked = updates.isLocked;

  await withDbRetry("update supplement definition", async () => {
    await db
      .update(supplementDefinitions)
      .set(updatePayload)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}

export async function setSupplementDefinitionLock(
  userId: number,
  definitionId: string,
  isLocked: boolean
) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("update supplement definition lock", async () => {
    await db
      .update(supplementDefinitions)
      .set({
        isLocked,
        updatedAt: new Date(),
      })
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}

export async function deleteSupplementDefinition(userId: number, definitionId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete supplement definition logs", async () => {
    await db
      .delete(supplementLogs)
      .where(and(eq(supplementLogs.userId, userId), eq(supplementLogs.definitionId, definitionId)));
  });

  await withDbRetry("delete supplement definition", async () => {
    await db
      .delete(supplementDefinitions)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}

// Habit definition + completion
export async function listHabitDefinitions(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit definitions", async () =>
    db
      .select()
      .from(habitDefinitions)
      .where(and(eq(habitDefinitions.userId, userId), eq(habitDefinitions.isActive, true)))
      .orderBy(asc(habitDefinitions.sortOrder), asc(habitDefinitions.name))
  );
}

export async function createHabitDefinition(habit: InsertHabitDefinition) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert habit definition", async () => {
    await db.insert(habitDefinitions).values({
      ...habit,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteHabitDefinition(userId: number, habitId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete habit completions", async () => {
    await db
      .delete(habitCompletions)
      .where(and(eq(habitCompletions.userId, userId), eq(habitCompletions.habitId, habitId)));
  });

  await withDbRetry("delete habit definition", async () => {
    await db
      .delete(habitDefinitions)
      .where(and(eq(habitDefinitions.userId, userId), eq(habitDefinitions.id, habitId)));
  });
}

export async function getHabitCompletionsByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit completions by date", async () =>
    db
      .select()
      .from(habitCompletions)
      .where(and(eq(habitCompletions.userId, userId), eq(habitCompletions.dateKey, dateKey)))
  );
}

export async function upsertHabitCompletion(
  userId: number,
  habitId: string,
  dateKey: string,
  completed: boolean
) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load habit completion before upsert", async () =>
    db
      .select({ id: habitCompletions.id })
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.userId, userId),
          eq(habitCompletions.habitId, habitId),
          eq(habitCompletions.dateKey, dateKey)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update habit completion", async () => {
      await db
        .update(habitCompletions)
        .set({
          completed,
          completedAt: completed ? now : null,
          updatedAt: now,
        })
        .where(eq(habitCompletions.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert habit completion", async () => {
    await db.insert(habitCompletions).values({
      id: nanoid(),
      userId,
      habitId,
      dateKey,
      completed,
      completedAt: completed ? now : null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function listHabitCompletions(userId: number, limit = 200) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit completions", async () =>
    db
      .select()
      .from(habitCompletions)
      .where(eq(habitCompletions.userId, userId))
      .orderBy(desc(habitCompletions.updatedAt))
      .limit(limit)
  );
}

export async function getDailySnapshotByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load daily snapshot", async () =>
    db
      .select()
      .from(dailySnapshots)
      .where(and(eq(dailySnapshots.userId, userId), eq(dailySnapshots.dateKey, dateKey)))
      .limit(1)
  );
  return result.length > 0 ? result[0] : null;
}

export async function upsertDailySnapshot(snapshot: InsertDailySnapshot) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load daily snapshot before upsert", async () =>
    db
      .select({ id: dailySnapshots.id })
      .from(dailySnapshots)
      .where(and(eq(dailySnapshots.userId, snapshot.userId), eq(dailySnapshots.dateKey, snapshot.dateKey)))
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update daily snapshot", async () => {
      await db
        .update(dailySnapshots)
        .set({
          capturedAt: snapshot.capturedAt,
          whoopPayload: snapshot.whoopPayload,
          samsungPayload: snapshot.samsungPayload,
          supplementsPayload: snapshot.supplementsPayload,
          habitsPayload: snapshot.habitsPayload,
          todoistCompletedCount: snapshot.todoistCompletedCount,
          updatedAt: now,
        })
        .where(eq(dailySnapshots.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert daily snapshot", async () => {
    await db.insert(dailySnapshots).values({
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function listDailySnapshots(userId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list daily snapshots", async () =>
    db
      .select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.userId, userId))
      .orderBy(desc(dailySnapshots.dateKey))
      .limit(limit)
  );
}

export async function addSamsungSyncPayload(entry: InsertSamsungSyncPayload) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("insert samsung sync payload", async () => {
    await db.insert(samsungSyncPayloads).values({
      ...entry,
      createdAt: new Date(),
    });
  });
}

export async function getLatestSamsungSyncPayload(userId: number, dateKey?: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load latest samsung sync payload", async () => {
    if (dateKey) {
      return db
        .select()
        .from(samsungSyncPayloads)
        .where(and(eq(samsungSyncPayloads.userId, userId), eq(samsungSyncPayloads.dateKey, dateKey)))
        .orderBy(desc(samsungSyncPayloads.capturedAt))
        .limit(1);
    }

    return db
      .select()
      .from(samsungSyncPayloads)
      .where(eq(samsungSyncPayloads.userId, userId))
      .orderBy(desc(samsungSyncPayloads.capturedAt))
      .limit(1);
  });

  return result.length > 0 ? result[0] : null;
}
