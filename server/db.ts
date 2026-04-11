import { eq, and, desc, asc, sql, gte } from "drizzle-orm";
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
  supplementPriceLogs,
  habitDefinitions,
  habitCompletions,
  notes,
  noteLinks,
  dailySnapshots,
  samsungSyncPayloads,
  solarRecDashboardStorage,
  userFeedback,
  InsertIntegration,
  InsertUserPreference,
  InsertOAuthCredential,
  InsertConversation,
  InsertMessage,
  InsertDailyHealthMetric,
  InsertSupplementLog,
  InsertSupplementDefinition,
  InsertSupplementPriceLog,
  InsertHabitDefinition,
  InsertNote,
  InsertNoteLink,
  InsertDailySnapshot,
  InsertSamsungSyncPayload,
  sectionEngagement,
  InsertSectionEngagement,
  InsertUserFeedback,
  userTotpSecrets,
  InsertUserTotpSecret,
  userRecoveryCodes,
  InsertUserRecoveryCode,
  productionReadings,
  InsertProductionReading,
  solarRecUsers,
  InsertSolarRecUser,
  solarRecInvites,
  InsertSolarRecInvite,
  solarRecTeamCredentials,
  InsertSolarRecTeamCredential,
  monitoringApiRuns,
  InsertMonitoringApiRun,
  monitoringBatchRuns,
  InsertMonitoringBatchRun,
  contractScanJobs,
  InsertContractScanJob,
  contractScanJobCsgIds,
  contractScanResults,
  InsertContractScanResult,
  scheduleBImportJobs,
  InsertScheduleBImportJob,
  scheduleBImportFiles,
  InsertScheduleBImportFile,
  scheduleBImportResults,
  InsertScheduleBImportResult,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { nanoid } from 'nanoid';

let _db: ReturnType<typeof drizzle> | null = null;
let _solarRecDashboardTableEnsured = false;
let _userFeedbackTableEnsured = false;
let _scheduleBImportTablesEnsured = false;
const SOLAR_REC_DB_CHUNK_CHARS = 900_000;

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
        payload mediumtext NOT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY solar_rec_dashboard_storage_user_key_chunk_idx (userId, storageKey, chunkIndex),
        KEY solar_rec_dashboard_storage_user_key_idx (userId, storageKey)
      )
    `);

    // Migrate older installs that created this as TEXT so larger payloads can persist.
    await db.execute(sql`
      ALTER TABLE solarRecDashboardStorage
      MODIFY COLUMN payload MEDIUMTEXT NOT NULL
    `);
  });

  _solarRecDashboardTableEnsured = true;
  return true;
}

async function ensureUserFeedbackTable() {
  const db = await getDb();
  if (!db) return false;
  if (_userFeedbackTableEnsured) return true;

  await withDbRetry("ensure user feedback table", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS userFeedback (
        id varchar(64) NOT NULL,
        userId int NOT NULL,
        pagePath varchar(255) NOT NULL,
        sectionId varchar(191) DEFAULT NULL,
        category varchar(32) NOT NULL DEFAULT 'improvement',
        note text NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'open',
        contextJson text,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY user_feedback_user_created_idx (userId, createdAt),
        KEY user_feedback_status_created_idx (status, createdAt)
      )
    `);
  });

  _userFeedbackTableEnsured = true;
  return true;
}

async function ensureScheduleBImportTables() {
  const db = await getDb();
  if (!db) return false;
  if (_scheduleBImportTablesEnsured) return true;

  await withDbRetry("ensure schedule b import tables", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduleBImportJobs (
        id varchar(64) NOT NULL,
        userId int NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'queued',
        currentFileName varchar(255) DEFAULT NULL,
        totalFiles int NOT NULL DEFAULT 0,
        successCount int NOT NULL DEFAULT 0,
        failureCount int NOT NULL DEFAULT 0,
        error text,
        startedAt timestamp NULL DEFAULT NULL,
        stoppedAt timestamp NULL DEFAULT NULL,
        completedAt timestamp NULL DEFAULT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY schedule_b_import_jobs_user_idx (userId),
        KEY schedule_b_import_jobs_status_idx (status)
      )
    `);

    // Add counter columns to pre-existing installs that created the
    // table before the contract-scraper-style rewrite. We use an
    // information_schema check instead of `ADD COLUMN IF NOT EXISTS`
    // because that syntax is only supported on MySQL 8.0.29+ and
    // recent TiDB — older installs would reject the ALTER outright
    // and cause the whole ensureScheduleBImportTables to throw,
    // breaking the entire scanner at startup.
    const addColumnIfMissing = async (columnName: string, columnDef: string) => {
      const result = (await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'scheduleBImportJobs'
          AND column_name = ${columnName}
      `)) as unknown as Array<Array<{ cnt: number }>>;
      const rows = Array.isArray(result) ? result[0] : [];
      const exists = Array.isArray(rows) && rows[0]?.cnt > 0;
      if (exists) return;
      await db.execute(
        sql.raw(`ALTER TABLE scheduleBImportJobs ADD COLUMN ${columnName} ${columnDef}`)
      );
    };
    try {
      await addColumnIfMissing("totalFiles", "int NOT NULL DEFAULT 0");
      await addColumnIfMissing("successCount", "int NOT NULL DEFAULT 0");
      await addColumnIfMissing("failureCount", "int NOT NULL DEFAULT 0");
    } catch (migrationError) {
      // Best-effort migration: if any ALTER fails we log it and continue.
      // The new runner will still function on fresh installs (CREATE TABLE
      // above defines the columns), and existing installs can apply the
      // ALTER manually if needed.
      console.warn(
        "[db] scheduleBImportJobs counter column migration failed:",
        migrationError instanceof Error ? migrationError.message : migrationError
      );
    }

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduleBImportFiles (
        id varchar(64) NOT NULL,
        jobId varchar(64) NOT NULL,
        fileName varchar(255) NOT NULL,
        fileSize int DEFAULT NULL,
        storageKey varchar(512) DEFAULT NULL,
        status varchar(32) NOT NULL DEFAULT 'uploading',
        uploadedChunks int NOT NULL DEFAULT 0,
        totalChunks int NOT NULL DEFAULT 0,
        error text,
        processedAt timestamp NULL DEFAULT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY schedule_b_import_files_job_file_idx (jobId, fileName),
        KEY schedule_b_import_files_job_status_idx (jobId, status),
        KEY schedule_b_import_files_job_created_idx (jobId, createdAt)
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduleBImportResults (
        id varchar(64) NOT NULL,
        jobId varchar(64) NOT NULL,
        fileName varchar(255) NOT NULL,
        designatedSystemId varchar(64) DEFAULT NULL,
        gatsId varchar(64) DEFAULT NULL,
        acSizeKw double DEFAULT NULL,
        capacityFactor double DEFAULT NULL,
        contractPrice double DEFAULT NULL,
        energizationDate varchar(32) DEFAULT NULL,
        maxRecQuantity int DEFAULT NULL,
        deliveryYearsJson mediumtext,
        error text,
        scannedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        appliedAt timestamp NULL DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY schedule_b_import_results_job_file_idx (jobId, fileName),
        KEY schedule_b_import_results_job_idx (jobId),
        KEY schedule_b_import_results_gats_idx (gatsId),
        KEY schedule_b_import_results_job_applied_idx (jobId, appliedAt)
      )
    `);

    // Ensure older installs have sufficient space for delivery-year payload JSON.
    await db.execute(sql`
      ALTER TABLE scheduleBImportResults
      MODIFY COLUMN deliveryYearsJson MEDIUMTEXT
    `);

    // apply-track-v1: add appliedAt column + supporting index to
    // pre-existing installs that created scheduleBImportResults before
    // this migration. Same information_schema pattern as the counter
    // columns above so we don't require MySQL 8.0.29+ syntax.
    const resultsColumnExists = async (columnName: string): Promise<boolean> => {
      const result = (await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'scheduleBImportResults'
          AND column_name = ${columnName}
      `)) as unknown as Array<Array<{ cnt: number }>>;
      const rows = Array.isArray(result) ? result[0] : [];
      return Array.isArray(rows) && rows[0]?.cnt > 0;
    };
    const resultsIndexExists = async (indexName: string): Promise<boolean> => {
      const result = (await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'scheduleBImportResults'
          AND index_name = ${indexName}
      `)) as unknown as Array<Array<{ cnt: number }>>;
      const rows = Array.isArray(result) ? result[0] : [];
      return Array.isArray(rows) && rows[0]?.cnt > 0;
    };
    try {
      if (!(await resultsColumnExists("appliedAt"))) {
        await db.execute(
          sql.raw(
            "ALTER TABLE scheduleBImportResults ADD COLUMN appliedAt timestamp NULL DEFAULT NULL"
          )
        );
      }
      if (!(await resultsIndexExists("schedule_b_import_results_job_applied_idx"))) {
        await db.execute(
          sql.raw(
            "CREATE INDEX schedule_b_import_results_job_applied_idx ON scheduleBImportResults (jobId, appliedAt)"
          )
        );
      }
    } catch (migrationError) {
      // Best-effort — a failure here disables the pendingApplyCount
      // feature but does not break the rest of the scanner. Log and
      // continue so the server still comes up.
      console.warn(
        "[db] scheduleBImportResults appliedAt migration failed:",
        migrationError instanceof Error ? migrationError.message : migrationError
      );
    }
  });

  _scheduleBImportTablesEnsured = true;
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

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user by email: database not available");
    return undefined;
  }

  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;

  const result = await withDbRetry("load user by email", async () =>
    db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalized}`)
      .limit(1)
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
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
  );
}

function buildMessagePreview(content: string | null | undefined, maxLength = 140): string {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export async function getConversationSummaries(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  const cappedLimit = Math.max(1, Math.min(limit, 300));
  const rows = await withDbRetry("list conversation summaries", async () =>
    db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
      .limit(cappedLimit)
  );

  const summaries = await Promise.all(
    rows.map(async (row) => {
      const latestMessage = await withDbRetry("load latest conversation message", async () =>
        db
          .select({
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, row.id))
          .orderBy(desc(messages.createdAt))
          .limit(1)
      );

      const messageCountRows = await withDbRetry("count conversation messages", async () =>
        db
          .select({
            count: sql<number>`count(*)`,
          })
          .from(messages)
          .where(eq(messages.conversationId, row.id))
      );

      const latest = latestMessage[0];
      const messageCount = Number(messageCountRows[0]?.count ?? 0);

      return {
        ...row,
        lastMessagePreview: buildMessagePreview(latest?.content),
        lastMessageAt: latest?.createdAt ?? row.updatedAt ?? row.createdAt ?? null,
        messageCount,
      };
    })
  );

  return summaries.sort((a, b) => {
    const aMs = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bMs = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    if (aMs !== bMs) return bMs - aMs;
    return b.title.localeCompare(a.title);
  });
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
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, message.conversationId));
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

export async function getSupplementDefinitionById(userId: number, definitionId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load supplement definition by id", async () =>
    db
      .select()
      .from(supplementDefinitions)
      .where(
        and(
          eq(supplementDefinitions.userId, userId),
          eq(supplementDefinitions.id, definitionId),
          eq(supplementDefinitions.isActive, true)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
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

export async function listSupplementPriceLogs(
  userId: number,
  options?: {
    definitionId?: string;
    limit?: number;
  }
) {
  const db = await getDb();
  if (!db) return [];

  const safeLimit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const definitionId = options?.definitionId?.trim();

  if (definitionId) {
    return withDbRetry("list supplement price logs by definition", async () =>
      db
        .select()
        .from(supplementPriceLogs)
        .where(
          and(
            eq(supplementPriceLogs.userId, userId),
            eq(supplementPriceLogs.definitionId, definitionId)
          )
        )
        .orderBy(desc(supplementPriceLogs.capturedAt), desc(supplementPriceLogs.createdAt))
        .limit(safeLimit)
    );
  }

  return withDbRetry("list supplement price logs", async () =>
    db
      .select()
      .from(supplementPriceLogs)
      .where(eq(supplementPriceLogs.userId, userId))
      .orderBy(desc(supplementPriceLogs.capturedAt), desc(supplementPriceLogs.createdAt))
      .limit(safeLimit)
  );
}

export async function addSupplementPriceLog(entry: InsertSupplementPriceLog) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement price log", async () => {
    await db.insert(supplementPriceLogs).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
      capturedAt: entry.capturedAt ?? now,
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

  await withDbRetry("delete supplement definition price logs", async () => {
    await db
      .delete(supplementPriceLogs)
      .where(and(eq(supplementPriceLogs.userId, userId), eq(supplementPriceLogs.definitionId, definitionId)));
  });

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

/**
 * Returns habit completion data for the last N days for streak calculation.
 * Returns rows grouped by habitId + dateKey with completed status.
 */
export async function getHabitCompletionsRange(
  userId: number,
  sinceDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get habit completions range", async () =>
    db
      .select({
        habitId: habitCompletions.habitId,
        dateKey: habitCompletions.dateKey,
        completed: habitCompletions.completed,
      })
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.userId, userId),
          gte(habitCompletions.dateKey, sinceDateKey),
          eq(habitCompletions.completed, true)
        )
      )
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

// ── Section Engagement ──

export async function insertSectionEngagementBatch(
  rows: Array<Omit<InsertSectionEngagement, "id" | "createdAt">>
) {
  const db = await getDb();
  if (!db || rows.length === 0) return;

  const toInsert = rows.map((row) => ({
    ...row,
    id: nanoid(),
  }));

  await withDbRetry("insert section engagement batch", async () => {
    await db.insert(sectionEngagement).values(toInsert);
  });
}

export async function getSectionEngagementSummary(
  userId: number,
  sinceDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get section engagement summary", async () => {
    return db
      .select({
        sectionId: sectionEngagement.sectionId,
        eventType: sectionEngagement.eventType,
        totalDurationMs: sql<number>`COALESCE(SUM(${sectionEngagement.durationMs}), 0)`,
        eventCount: sql<number>`COUNT(*)`,
      })
      .from(sectionEngagement)
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          sql`${sectionEngagement.sessionDate} >= ${sinceDateKey}`
        )
      )
      .groupBy(sectionEngagement.sectionId, sectionEngagement.eventType);
  });
}

export async function getSectionRatings(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get section ratings", async () => {
    // Get the most recent rating per section
    const subquery = db
      .select({
        sectionId: sectionEngagement.sectionId,
        maxCreatedAt: sql<Date>`MAX(${sectionEngagement.createdAt})`.as("maxCreatedAt"),
      })
      .from(sectionEngagement)
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          eq(sectionEngagement.eventType, "rating")
        )
      )
      .groupBy(sectionEngagement.sectionId)
      .as("latest");

    return db
      .select({
        sectionId: sectionEngagement.sectionId,
        eventValue: sectionEngagement.eventValue,
      })
      .from(sectionEngagement)
      .innerJoin(
        subquery,
        and(
          eq(sectionEngagement.sectionId, subquery.sectionId),
          eq(sectionEngagement.createdAt, subquery.maxCreatedAt)
        )
      )
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          eq(sectionEngagement.eventType, "rating")
        )
      );
  });
}

export async function pruneSectionEngagement(olderThanDateKey: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("prune section engagement", async () => {
    await db
      .delete(sectionEngagement)
      .where(sql`${sectionEngagement.sessionDate} < ${olderThanDateKey}`);
  });
}

export async function clearSectionEngagement(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("clear section engagement", async () => {
    await db
      .delete(sectionEngagement)
      .where(eq(sectionEngagement.userId, userId));
  });
}

// ── User Feedback ──

export async function submitUserFeedback(
  input: Omit<InsertUserFeedback, "id" | "createdAt" | "updatedAt">
) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return null;

  const row: InsertUserFeedback = {
    id: nanoid(),
    userId: input.userId,
    pagePath: input.pagePath,
    sectionId: input.sectionId ?? null,
    category: input.category ?? "improvement",
    note: input.note,
    status: input.status ?? "open",
    contextJson: input.contextJson ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withDbRetry("submit user feedback", async () => {
    await db.insert(userFeedback).values(row);
  });

  return row;
}

export async function listUserFeedback(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return [];

  return withDbRetry("list user feedback", async () =>
    db
      .select()
      .from(userFeedback)
      .where(eq(userFeedback.userId, userId))
      .orderBy(desc(userFeedback.createdAt))
      .limit(Math.max(1, Math.min(500, limit)))
  );
}

export async function listRecentUserFeedback(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureUserFeedbackTable();
  if (!ensured) return [];

  return withDbRetry("list recent user feedback", async () =>
    db
      .select()
      .from(userFeedback)
      .orderBy(desc(userFeedback.createdAt))
      .limit(Math.max(1, Math.min(500, limit)))
  );
}

// ── TOTP 2FA functions ──────────────────────────────────────────────

export async function getTotpSecret(userId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await withDbRetry("get totp secret", async () =>
    db.select().from(userTotpSecrets).where(eq(userTotpSecrets.userId, userId)).limit(1)
  );
  return result.length > 0 ? result[0] : undefined;
}

export async function saveTotpSecret(userId: number, secret: string) {
  const db = await getDb();
  if (!db) return;

  // Delete any existing (unverified) secret first
  await withDbRetry("delete old totp secret", async () =>
    db.delete(userTotpSecrets).where(eq(userTotpSecrets.userId, userId))
  );

  await withDbRetry("save totp secret", async () =>
    db.insert(userTotpSecrets).values({
      id: nanoid(),
      userId,
      secret,
      verified: false,
    })
  );
}

export async function markTotpVerified(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("mark totp verified", async () =>
    db.update(userTotpSecrets).set({ verified: true }).where(eq(userTotpSecrets.userId, userId))
  );
}

export async function deleteTotpSecret(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete totp secret", async () =>
    db.delete(userTotpSecrets).where(eq(userTotpSecrets.userId, userId))
  );
}

export async function saveRecoveryCodes(userId: number, codeHashes: string[]) {
  const db = await getDb();
  if (!db) return;

  // Delete existing codes first
  await withDbRetry("delete old recovery codes", async () =>
    db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  );

  if (codeHashes.length === 0) return;

  const rows = codeHashes.map((hash) => ({
    id: nanoid(),
    userId,
    codeHash: hash,
  }));

  await withDbRetry("save recovery codes", async () =>
    db.insert(userRecoveryCodes).values(rows)
  );
}

export async function getUnusedRecoveryCodeCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const result = await withDbRetry("count unused recovery codes", async () =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), sql`${userRecoveryCodes.usedAt} IS NULL`))
  );
  return result[0]?.count ?? 0;
}

export async function consumeRecoveryCode(userId: number, codeHash: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const result = await withDbRetry("consume recovery code", async () =>
    db
      .update(userRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          eq(userRecoveryCodes.codeHash, codeHash),
          sql`${userRecoveryCodes.usedAt} IS NULL`
        )
      )
  );
  // MySQL returns affectedRows for updates
  return (result as any)?.[0]?.affectedRows > 0 || (result as any)?.rowsAffected > 0;
}

export async function deleteRecoveryCodes(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete recovery codes", async () =>
    db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  );
}

// ── Production Readings (SunPower PVS mobile app) ──────────────────

export async function insertProductionReading(reading: InsertProductionReading) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("insert production reading", async () =>
    db.insert(productionReadings).values(reading)
  );
}

export async function listProductionReadings(opts?: {
  limit?: number;
  email?: string;
  nonId?: string;
}) {
  const db = await getDb();
  if (!db) return [];

  const limit = opts?.limit ?? 200;
  const conditions = [];
  if (opts?.email) conditions.push(eq(productionReadings.customerEmail, opts.email));
  if (opts?.nonId) conditions.push(eq(productionReadings.nonId, opts.nonId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return withDbRetry("list production readings", async () =>
    db
      .select()
      .from(productionReadings)
      .where(where)
      .orderBy(desc(productionReadings.readAt))
      .limit(limit)
  );
}

export async function getProductionReadingSummary() {
  const db = await getDb();
  if (!db) return { totalReadings: 0, uniqueCustomers: 0, latestReadings: [] };

  return withDbRetry("production reading summary", async () => {
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(productionReadings);

    const [uniqueResult] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${productionReadings.customerEmail})` })
      .from(productionReadings);

    const latestReadings = await db
      .select()
      .from(productionReadings)
      .orderBy(desc(productionReadings.readAt))
      .limit(10);

    return {
      totalReadings: countResult?.count ?? 0,
      uniqueCustomers: uniqueResult?.count ?? 0,
      latestReadings,
    };
  });
}

// ── Solar REC Users ─────────────────────────────────────────────────

export async function getSolarRecUserById(id: number) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by id", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.id, id)).limit(1);
    return user ?? null;
  });
}

export async function getSolarRecUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by email", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.email, email.toLowerCase())).limit(1);
    return user ?? null;
  });
}

export async function getSolarRecUserByGoogleOpenId(googleOpenId: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by google open id", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.googleOpenId, googleOpenId)).limit(1);
    return user ?? null;
  });
}

export async function createSolarRecUser(data: {
  email: string;
  name: string;
  googleOpenId: string;
  avatarUrl: string | null;
  role: "owner" | "admin" | "operator" | "viewer";
  invitedBy?: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return withDbRetry("create solar rec user", async () => {
    await db.insert(solarRecUsers).values({
      email: data.email.toLowerCase(),
      name: data.name,
      googleOpenId: data.googleOpenId,
      avatarUrl: data.avatarUrl,
      role: data.role,
      invitedBy: data.invitedBy ?? null,
      lastSignedIn: new Date(),
    });
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.email, data.email.toLowerCase())).limit(1);
    return user!;
  });
}

export async function updateSolarRecUserLastSignIn(
  id: number,
  googleOpenId?: string,
  name?: string,
  avatarUrl?: string
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update solar rec user last sign in", async () => {
    const updates: Record<string, unknown> = { lastSignedIn: new Date() };
    if (googleOpenId) updates.googleOpenId = googleOpenId;
    if (name) updates.name = name;
    if (avatarUrl) updates.avatarUrl = avatarUrl;
    await db.update(solarRecUsers).set(updates).where(eq(solarRecUsers.id, id));
  });
}

export async function updateSolarRecUserRole(id: number, role: "admin" | "operator" | "viewer") {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update solar rec user role", async () => {
    await db.update(solarRecUsers).set({ role }).where(eq(solarRecUsers.id, id));
  });
}

export async function deactivateSolarRecUser(id: number) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("deactivate solar rec user", async () => {
    await db.update(solarRecUsers).set({ isActive: false }).where(eq(solarRecUsers.id, id));
  });
}

export async function listSolarRecUsers() {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec users", async () =>
    db.select().from(solarRecUsers).orderBy(asc(solarRecUsers.id))
  );
}

// ── Solar REC Invites ───────────────────────────────────────────────

export async function createSolarRecInvite(data: {
  email: string;
  role: "admin" | "operator" | "viewer";
  createdBy: number;
  expiresInDays?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const token = nanoid(32);
  const tokenHash = (await import("crypto")).createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + (data.expiresInDays ?? 30) * 24 * 60 * 60 * 1000);

  await withDbRetry("create solar rec invite", async () => {
    await db.insert(solarRecInvites).values({
      id: nanoid(),
      email: data.email.toLowerCase(),
      role: data.role,
      tokenHash,
      createdBy: data.createdBy,
      expiresAt,
    });
  });

  return { token, expiresAt };
}

export async function getSolarRecInviteByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec invite by email", async () => {
    const [invite] = await db
      .select()
      .from(solarRecInvites)
      .where(
        and(
          eq(solarRecInvites.email, email.toLowerCase()),
          sql`${solarRecInvites.usedAt} IS NULL`,
          sql`${solarRecInvites.expiresAt} > NOW()`
        )
      )
      .orderBy(desc(solarRecInvites.createdAt))
      .limit(1);
    return invite ?? null;
  });
}

export async function markSolarRecInviteUsed(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("mark solar rec invite used", async () => {
    await db.update(solarRecInvites).set({ usedAt: new Date() }).where(eq(solarRecInvites.id, id));
  });
}

export async function listSolarRecInvites(createdBy?: number) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec invites", async () => {
    const where = createdBy ? eq(solarRecInvites.createdBy, createdBy) : undefined;
    return db
      .select()
      .from(solarRecInvites)
      .where(where)
      .orderBy(desc(solarRecInvites.createdAt))
      .limit(50);
  });
}

export async function deleteSolarRecInvite(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete solar rec invite", async () => {
    await db.delete(solarRecInvites).where(eq(solarRecInvites.id, id));
  });
}

// ── Solar REC Team Credentials ──────────────────────────────────────

export async function listSolarRecTeamCredentials() {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec team credentials", async () =>
    db.select().from(solarRecTeamCredentials).orderBy(asc(solarRecTeamCredentials.provider))
  );
}

export async function getSolarRecTeamCredential(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec team credential", async () => {
    const [cred] = await db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id)).limit(1);
    return cred ?? null;
  });
}

export async function getSolarRecTeamCredentialsByProvider(provider: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get solar rec team credentials by provider", async () =>
    db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.provider, provider))
  );
}

export async function upsertSolarRecTeamCredential(data: {
  id?: string;
  provider: string;
  connectionName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  metadata?: string;
  createdBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = data.id ?? nanoid();
  return withDbRetry("upsert solar rec team credential", async () => {
    const [existing] = await db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id)).limit(1);
    if (existing) {
      await db.update(solarRecTeamCredentials).set({
        connectionName: data.connectionName ?? existing.connectionName,
        accessToken: data.accessToken ?? existing.accessToken,
        refreshToken: data.refreshToken ?? existing.refreshToken,
        expiresAt: data.expiresAt ?? existing.expiresAt,
        metadata: data.metadata ?? existing.metadata,
        updatedBy: data.createdBy,
      }).where(eq(solarRecTeamCredentials.id, id));
    } else {
      await db.insert(solarRecTeamCredentials).values({
        id,
        provider: data.provider,
        connectionName: data.connectionName ?? null,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        metadata: data.metadata ?? null,
        createdBy: data.createdBy,
        updatedBy: data.createdBy,
      });
    }
    return id;
  });
}

export async function deleteSolarRecTeamCredential(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete solar rec team credential", async () => {
    await db.delete(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id));
  });
}

// ── Monitoring API Runs ─────────────────────────────────────────────

export async function upsertMonitoringApiRun(data: InsertMonitoringApiRun) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("upsert monitoring api run", async () => {
    // Lookup now matches the updated unique index
    // (provider, connectionId, siteId, dateKey). Previously the upsert
    // ignored connectionId and one run would overwrite another when
    // multiple credentials managed the same provider+site+date.
    //
    // connectionId is nullable in the schema, but legacy rows exist with
    // NULL. We use `IS NULL`-safe matching for that case.
    const connectionIdPredicate =
      data.connectionId === null || data.connectionId === undefined
        ? sql`${monitoringApiRuns.connectionId} IS NULL`
        : eq(monitoringApiRuns.connectionId, data.connectionId);

    const [existing] = await db
      .select({ id: monitoringApiRuns.id })
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.provider, data.provider),
          connectionIdPredicate,
          eq(monitoringApiRuns.siteId, data.siteId),
          eq(monitoringApiRuns.dateKey, data.dateKey)
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(monitoringApiRuns)
        .set({
          status: data.status,
          readingsCount: data.readingsCount,
          lifetimeKwh: data.lifetimeKwh,
          errorMessage: data.errorMessage,
          durationMs: data.durationMs,
          triggeredBy: data.triggeredBy,
          triggeredAt: data.triggeredAt,
          siteName: data.siteName,
          connectionId: data.connectionId,
        })
        .where(eq(monitoringApiRuns.id, existing.id));
    } else {
      await db.insert(monitoringApiRuns).values({ ...data, id: data.id ?? nanoid() });
    }
  });
}

export async function getMonitoringGrid(startDate: string, endDate: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get monitoring grid", async () =>
    db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          gte(monitoringApiRuns.dateKey, startDate),
          sql`${monitoringApiRuns.dateKey} <= ${endDate}`
        )
      )
      .orderBy(asc(monitoringApiRuns.provider), asc(monitoringApiRuns.siteId), asc(monitoringApiRuns.dateKey))
  );
}

export async function getMonitoringRunDetail(provider: string, siteId: string, dateKey: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get monitoring run detail", async () => {
    const [row] = await db
      .select()
      .from(monitoringApiRuns)
      .where(
        and(
          eq(monitoringApiRuns.provider, provider),
          eq(monitoringApiRuns.siteId, siteId),
          eq(monitoringApiRuns.dateKey, dateKey)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

export async function getMonitoringHealthSummary() {
  const db = await getDb();
  if (!db) return [];
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const startDate = sevenDaysAgo.toISOString().slice(0, 10);

  return withDbRetry("get monitoring health summary", async () =>
    db
      .select({
        provider: monitoringApiRuns.provider,
        totalRuns: sql<number>`COUNT(*)`,
        successCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN 1 ELSE 0 END)`,
        errorCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'error' THEN 1 ELSE 0 END)`,
        noDataCount: sql<number>`SUM(CASE WHEN ${monitoringApiRuns.status} = 'no_data' THEN 1 ELSE 0 END)`,
        uniqueSites: sql<number>`COUNT(DISTINCT ${monitoringApiRuns.siteId})`,
        lastSuccess: sql<string>`MAX(CASE WHEN ${monitoringApiRuns.status} = 'success' THEN ${monitoringApiRuns.dateKey} END)`,
      })
      .from(monitoringApiRuns)
      .where(gte(monitoringApiRuns.dateKey, startDate))
      .groupBy(monitoringApiRuns.provider)
  );
}

// ── Monitoring Batch Runs ───────────────────────────────────────────

export async function createMonitoringBatchRun(data: {
  dateKey: string;
  triggeredBy: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  await withDbRetry("create monitoring batch run", async () => {
    await db.insert(monitoringBatchRuns).values({
      id,
      dateKey: data.dateKey,
      status: "running",
      triggeredBy: data.triggeredBy,
      startedAt: new Date(),
    });
  });
  return id;
}

export async function updateMonitoringBatchRun(
  id: string,
  data: Partial<{
    status: "running" | "completed" | "failed";
    totalSites: number;
    successCount: number;
    errorCount: number;
    noDataCount: number;
    currentProvider: string | null;
    currentCredentialName: string | null;
    providersTotal: number;
    providersCompleted: number;
    completedAt: Date;
  }>
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update monitoring batch run", async () => {
    await db.update(monitoringBatchRuns).set(data).where(eq(monitoringBatchRuns.id, id));
  });
}

export async function getMonitoringBatchRun(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get monitoring batch run", async () => {
    const [row] = await db.select().from(monitoringBatchRuns).where(eq(monitoringBatchRuns.id, id)).limit(1);
    return row ?? null;
  });
}

// ── Contract Scan Jobs ──────────────────────────────────────────────

export async function createContractScanJob(data: {
  userId: number;
  totalContracts: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  const now = new Date();
  try {
    await withDbRetry("create contract scan job", async () => {
      await db.insert(contractScanJobs).values({
        id,
        userId: data.userId,
        status: "queued",
        totalContracts: data.totalContracts,
        successCount: 0,
        failureCount: 0,
        currentCsgId: null,
        error: null,
        startedAt: null,
        stoppedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    console.error(`[contractScanJob] INSERT failed: code=${code} message=${msg}`, err);
    throw new Error(`Failed to create contract scan job: ${msg}`);
  }
  return id;
}

export async function getContractScanJob(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get contract scan job", async () => {
    const [row] = await db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.id, id))
      .limit(1);
    return row ?? null;
  });
}

export async function getLatestContractScanJob(userId: number) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get latest contract scan job", async () => {
    const [row] = await db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.userId, userId))
      .orderBy(desc(contractScanJobs.createdAt))
      .limit(1);
    return row ?? null;
  });
}

export async function listContractScanJobs(
  userId: number,
  limit = 20
) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list contract scan jobs", async () =>
    db
      .select()
      .from(contractScanJobs)
      .where(eq(contractScanJobs.userId, userId))
      .orderBy(desc(contractScanJobs.createdAt))
      .limit(limit)
  );
}

export async function updateContractScanJob(
  id: string,
  data: Partial<{
    status:
      | "queued"
      | "running"
      | "stopping"
      | "stopped"
      | "completed"
      | "failed";
    currentCsgId: string | null;
    error: string | null;
    startedAt: Date;
    stoppedAt: Date;
    completedAt: Date;
  }>
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update contract scan job", async () => {
    await db
      .update(contractScanJobs)
      .set(data)
      .where(eq(contractScanJobs.id, id));
  });
}

export async function incrementContractScanJobCounter(
  id: string,
  field: "successCount" | "failureCount"
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("increment contract scan job counter", async () => {
    await db
      .update(contractScanJobs)
      .set({
        [field]: sql`${contractScanJobs[field]} + 1`,
      })
      .where(eq(contractScanJobs.id, id));
  });
}

// ── Contract Scan Job CSG IDs ───────────────────────────────────────

export async function bulkInsertContractScanJobCsgIds(
  jobId: string,
  csgIds: string[]
) {
  const db = await getDb();
  if (!db) return;
  // Insert in batches of 500 to avoid query size limits
  const batchSize = 500;
  for (let i = 0; i < csgIds.length; i += batchSize) {
    const batch = csgIds.slice(i, i + batchSize);
    await withDbRetry(
      `bulk insert contract scan csg ids batch ${i}`,
      async () => {
        await db.insert(contractScanJobCsgIds).values(
          batch.map((csgId) => ({
            id: nanoid(),
            jobId,
            csgId,
          }))
        );
      }
    );
  }
}

// ── Contract Scan Results ───────────────────────────────────────────

export async function insertContractScanResult(
  data: InsertContractScanResult
) {
  const db = await getDb();
  if (!db) return;
  // Truncate milliseconds from scannedAt for TiDB timestamp compatibility
  const scannedAt = data.scannedAt ? new Date(Math.floor(data.scannedAt.getTime() / 1000) * 1000) : new Date();
  try {
    await withDbRetry("insert contract scan result", async () => {
      await db.insert(contractScanResults).values({
        id: data.id ?? nanoid(),
        jobId: data.jobId,
        csgId: data.csgId,
        systemName: data.systemName ?? null,
        vendorFeePercent: data.vendorFeePercent ?? null,
        additionalCollateralPercent: data.additionalCollateralPercent ?? null,
        ccAuthorizationCompleted: data.ccAuthorizationCompleted ?? null,
        additionalFivePercentSelected: data.additionalFivePercentSelected ?? null,
        ccCardAsteriskCount: data.ccCardAsteriskCount ?? null,
        paymentMethod: data.paymentMethod ?? null,
        payeeName: data.payeeName ?? null,
        mailingAddress1: data.mailingAddress1 ?? null,
        mailingAddress2: data.mailingAddress2 ?? null,
        cityStateZip: data.cityStateZip ?? null,
        recQuantity: data.recQuantity ?? null,
        recPrice: data.recPrice ?? null,
        acSizeKw: data.acSizeKw ?? null,
        dcSizeKw: data.dcSizeKw ?? null,
        pdfUrl: data.pdfUrl ?? null,
        pdfFileName: data.pdfFileName ?? null,
        error: data.error ?? null,
        scannedAt,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[contractScanResult] INSERT failed for csgId=${data.csgId}: ${msg}`);
    throw err;
  }
}

export async function deleteContractScanJobData(jobId: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete contract scan job data", async () => {
    await db.delete(contractScanResults).where(eq(contractScanResults.jobId, jobId));
    await db.delete(contractScanJobCsgIds).where(eq(contractScanJobCsgIds.jobId, jobId));
    await db.delete(contractScanJobs).where(eq(contractScanJobs.id, jobId));
  });
}

export async function getCompletedCsgIdsForJob(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  return withDbRetry("get completed csg ids for job", async () => {
    const rows = await db
      .select({ csgId: contractScanResults.csgId })
      .from(contractScanResults)
      .where(
        and(
          eq(contractScanResults.jobId, jobId),
          sql`${contractScanResults.error} IS NULL`
        )
      );
    return new Set(rows.map((r) => r.csgId));
  });
}

export async function listContractScanResults(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  return withDbRetry("list contract scan results", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(contractScanResults)
        .where(eq(contractScanResults.jobId, jobId))
        .orderBy(desc(contractScanResults.scannedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(contractScanResults)
        .where(eq(contractScanResults.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function getAllContractScanResultsForJob(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get all contract scan results for job", async () =>
    db
      .select()
      .from(contractScanResults)
      .where(eq(contractScanResults.jobId, jobId))
      .orderBy(asc(contractScanResults.csgId))
  );
}

/**
 * Returns the latest successful contractScanResults row per csgId,
 * filtered to scan jobs owned by the given user.
 *
 * IMPORTANT: contractScanResults has no userId column of its own — it
 * links to a user via contractScanJobs.userId. Earlier versions of
 * this function omitted the JOIN and returned ANY user's scan
 * results matching the csgIds, which was a cross-tenant data
 * leakage bug AND an obstacle to correctly attributing data on the
 * Financials tab. The userId parameter is now required.
 */
export async function getLatestScanResultsByCsgIds(
  userId: number,
  csgIds: string[]
) {
  const db = await getDb();
  if (!db) return [];
  if (csgIds.length === 0) return [];

  // Query in batches to avoid oversized IN clauses
  const batchSize = 500;
  const allResults: (typeof contractScanResults.$inferSelect)[] = [];

  for (let i = 0; i < csgIds.length; i += batchSize) {
    const batch = csgIds.slice(i, i + batchSize);
    const rows = await withDbRetry(
      `get latest scan results batch ${i}`,
      async () =>
        db
          .select({
            id: contractScanResults.id,
            jobId: contractScanResults.jobId,
            csgId: contractScanResults.csgId,
            systemName: contractScanResults.systemName,
            vendorFeePercent: contractScanResults.vendorFeePercent,
            additionalCollateralPercent:
              contractScanResults.additionalCollateralPercent,
            ccAuthorizationCompleted:
              contractScanResults.ccAuthorizationCompleted,
            additionalFivePercentSelected:
              contractScanResults.additionalFivePercentSelected,
            ccCardAsteriskCount: contractScanResults.ccCardAsteriskCount,
            paymentMethod: contractScanResults.paymentMethod,
            payeeName: contractScanResults.payeeName,
            mailingAddress1: contractScanResults.mailingAddress1,
            mailingAddress2: contractScanResults.mailingAddress2,
            cityStateZip: contractScanResults.cityStateZip,
            recQuantity: contractScanResults.recQuantity,
            recPrice: contractScanResults.recPrice,
            acSizeKw: contractScanResults.acSizeKw,
            dcSizeKw: contractScanResults.dcSizeKw,
            pdfUrl: contractScanResults.pdfUrl,
            pdfFileName: contractScanResults.pdfFileName,
            error: contractScanResults.error,
            scannedAt: contractScanResults.scannedAt,
          })
          .from(contractScanResults)
          .innerJoin(
            contractScanJobs,
            eq(contractScanResults.jobId, contractScanJobs.id)
          )
          .where(
            and(
              eq(contractScanJobs.userId, userId),
              sql`${contractScanResults.csgId} IN (${sql.join(
                batch.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${contractScanResults.error} IS NULL`
            )
          )
          .orderBy(desc(contractScanResults.scannedAt))
    );
    allResults.push(...rows);
  }

  // Deduplicate: keep only the latest (first by scannedAt DESC) per csgId
  const seen = new Set<string>();
  const deduped: typeof allResults = [];
  for (const row of allResults) {
    if (!seen.has(row.csgId)) {
      seen.add(row.csgId);
      deduped.push(row);
    }
  }
  return deduped;
}

// ── Schedule B Import Jobs ─────────────────────────────────────────

export type ScheduleBImportJobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export type ScheduleBImportFileStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export async function createScheduleBImportJob(
  data: {
    userId: number;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) throw new Error("Schedule B import table initialization failed");

  const id = nanoid();
  const now = new Date();
  await withDbRetry("create schedule b import job", async () => {
    await db.insert(scheduleBImportJobs).values({
      id,
      userId: data.userId,
      status: "queued",
      currentFileName: null,
      error: null,
      startedAt: null,
      stoppedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
  return id;
}

export async function getScheduleBImportJob(jobId: string) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get schedule b import job", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.id, jobId))
      .limit(1);
    return row ?? null;
  });
}

export async function getLatestScheduleBImportJob(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get latest schedule b import job", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.userId, userId))
      .orderBy(desc(scheduleBImportJobs.createdAt))
      .limit(1);
    return row ?? null;
  });
}

export async function updateScheduleBImportJob(
  jobId: string,
  data: Partial<{
    status: ScheduleBImportJobStatus;
    currentFileName: string | null;
    error: string | null;
    startedAt: Date | null;
    stoppedAt: Date | null;
    completedAt: Date | null;
    totalFiles: number;
    successCount: number;
    failureCount: number;
  }>
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("update schedule b import job", async () => {
    await db
      .update(scheduleBImportJobs)
      .set(data)
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}

/**
 * Atomically increment a counter column on the Schedule B job row. Mirrors
 * `incrementContractScanJobCounter` — the contract scraper's pattern for
 * tracking progress without relying on derived COUNT(*) queries over a
 * file-state table.
 */
export async function incrementScheduleBImportJobCounter(
  jobId: string,
  field: "successCount" | "failureCount" | "totalFiles"
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("increment schedule b import job counter", async () => {
    await db
      .update(scheduleBImportJobs)
      .set({
        [field]: sql`${scheduleBImportJobs[field]} + 1`,
      })
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}

export async function getOrCreateLatestScheduleBImportJob(userId: number) {
  const existing = await getLatestScheduleBImportJob(userId);
  if (existing) return existing;
  const id = await createScheduleBImportJob({ userId });
  const created = await getScheduleBImportJob(id);
  if (!created) {
    throw new Error("Failed to create Schedule B import job.");
  }
  return created;
}

// ── Schedule B Import Files ───────────────────────────────────────

export async function getScheduleBImportFile(jobId: string, fileName: string) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get schedule b import file", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.fileName, fileName)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

export async function upsertScheduleBImportFileUploadProgress(
  data: {
    jobId: string;
    fileName: string;
    fileSize: number;
    uploadedChunks: number;
    totalChunks: number;
    status: ScheduleBImportFileStatus;
    storageKey?: string | null;
    error?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  const now = new Date();

  await withDbRetry("upsert schedule b import file upload progress", async () => {
    const existing = await db
      .select({ id: scheduleBImportFiles.id })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportFiles)
        .set({
          fileSize: data.fileSize,
          uploadedChunks: data.uploadedChunks,
          totalChunks: data.totalChunks,
          status: data.status,
          storageKey:
            data.storageKey !== undefined
              ? data.storageKey
              : sql`${scheduleBImportFiles.storageKey}`,
          error: data.error ?? null,
          updatedAt: now,
        })
        .where(eq(scheduleBImportFiles.id, existing[0].id));
      return;
    }

    await db.insert(scheduleBImportFiles).values({
      id: nanoid(),
      jobId: data.jobId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      storageKey: data.storageKey ?? null,
      status: data.status,
      uploadedChunks: data.uploadedChunks,
      totalChunks: data.totalChunks,
      error: data.error ?? null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function markScheduleBImportFileQueued(
  data: {
    jobId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    storageKey: string;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  const now = new Date();

  await withDbRetry("mark schedule b import file queued", async () => {
    const existing = await db
      .select({ id: scheduleBImportFiles.id })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportFiles)
        .set({
          fileSize: data.fileSize,
          totalChunks: data.totalChunks,
          uploadedChunks: data.totalChunks,
          storageKey: data.storageKey,
          status: "queued",
          error: null,
          updatedAt: now,
        })
        .where(eq(scheduleBImportFiles.id, existing[0].id));
      return;
    }

    await db.insert(scheduleBImportFiles).values({
      id: nanoid(),
      jobId: data.jobId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      totalChunks: data.totalChunks,
      uploadedChunks: data.totalChunks,
      storageKey: data.storageKey,
      status: "queued",
      error: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Bulk-insert scheduleBImportFiles rows for a drive-link-v1 batch.
 *
 * Each row is stored with `storageKey = "drive:<fileId>"` and
 * `status = "queued"` so the existing scheduleBImportJobRunner picks
 * them up immediately — the drive branch inside processSingleFile
 * downloads from Google Drive based on the prefix. No chunk lifecycle
 * (uploadedChunks = totalChunks = 1) because drive files are
 * finalized from the moment the row exists.
 *
 * Deduplicates by fileName against the job's existing rows before
 * inserting — collisions are silently counted as `skipped` so the
 * mutation can report "X new, Y already in queue" to the user.
 *
 * Chunks the actual INSERT into batches of 500 to keep the SQL
 * statement size manageable on TiDB/MySQL and to keep withDbRetry
 * units small.
 *
 * Returns { inserted, skipped }.
 */
export async function bulkInsertScheduleBDriveFiles(
  jobId: string,
  files: Array<{
    fileName: string;
    fileSize: number | null;
    driveFileId: string;
  }>
): Promise<{ inserted: number; skipped: number }> {
  if (files.length === 0) return { inserted: 0, skipped: 0 };
  const db = await getDb();
  if (!db) return { inserted: 0, skipped: 0 };
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return { inserted: 0, skipped: 0 };

  // 1. Load all existing filenames for this job so we can filter
  //    duplicates in-memory (the (jobId, fileName) unique index would
  //    reject them anyway, but pre-filtering keeps the INSERT clean).
  const knownFileNamesRows = await withDbRetry(
    "list schedule b file names for bulk drive insert",
    async () =>
      db
        .select({ fileName: scheduleBImportFiles.fileName })
        .from(scheduleBImportFiles)
        .where(eq(scheduleBImportFiles.jobId, jobId))
  );
  const knownFileNames = new Set(
    knownFileNamesRows.map((row) => row.fileName)
  );

  // 2. Partition into "new" and "skip".
  const fresh: typeof files = [];
  let skipped = 0;
  const seenThisBatch = new Set<string>();
  for (const file of files) {
    if (knownFileNames.has(file.fileName)) {
      skipped += 1;
      continue;
    }
    // Also skip duplicates WITHIN this batch (two Drive files with
    // the same name in the same folder would trip the unique index
    // otherwise).
    if (seenThisBatch.has(file.fileName)) {
      skipped += 1;
      continue;
    }
    seenThisBatch.add(file.fileName);
    fresh.push(file);
  }

  if (fresh.length === 0) {
    return { inserted: 0, skipped };
  }

  // 3. Chunked multi-row insert. 500 rows/chunk is a conservative
  //    balance between throughput and statement size.
  const CHUNK_SIZE = 500;
  let inserted = 0;
  for (let start = 0; start < fresh.length; start += CHUNK_SIZE) {
    const chunk = fresh.slice(start, start + CHUNK_SIZE);
    const now = new Date();
    const rows = chunk.map((file) => ({
      id: nanoid(),
      jobId,
      fileName: file.fileName,
      fileSize: file.fileSize ?? 0,
      storageKey: `drive:${file.driveFileId}`,
      status: "queued" as const,
      uploadedChunks: 1,
      totalChunks: 1,
      error: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    }));
    await withDbRetry("bulk insert schedule b drive files chunk", async () => {
      await db.insert(scheduleBImportFiles).values(rows);
    });
    inserted += rows.length;
  }

  return { inserted, skipped };
}

export async function markScheduleBImportFileStatus(
  data: {
    jobId: string;
    fileName: string;
    status: ScheduleBImportFileStatus;
    error?: string | null;
    processedAt?: Date | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("mark schedule b import file status", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: data.status,
        error: data.error ?? null,
        processedAt:
          data.processedAt ??
          (data.status === "completed" || data.status === "failed"
            ? new Date()
            : null),
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      );
  });
}

export async function listScheduleBImportFileNames(
  jobId: string,
  opts?: { includeStatuses?: ScheduleBImportFileStatus[] }
) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("list schedule b import file names", async () => {
    const statuses = opts?.includeStatuses;
    const whereCondition =
      Array.isArray(statuses) && statuses.length > 0
        ? and(
            eq(scheduleBImportFiles.jobId, jobId),
            sql`${scheduleBImportFiles.status} IN (${sql.join(
              statuses.map((status) => sql`${status}`),
              sql`, `
            )})`
          )
        : eq(scheduleBImportFiles.jobId, jobId);

    const rows = await db
      .select({ fileName: scheduleBImportFiles.fileName })
      .from(scheduleBImportFiles)
      .where(whereCondition);
    return rows.map((row) => row.fileName);
  });
}

export async function listPendingScheduleBImportFiles(jobId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("list pending schedule b import files", async () =>
    db
      .select()
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "queued")
        )
      )
      .orderBy(asc(scheduleBImportFiles.createdAt))
      .limit(limit)
  );
}

/**
 * List every file in the job that has a permanent storage key (i.e. the
 * chunked upload finished and storagePut succeeded). Files still being
 * uploaded chunk-by-chunk have storageKey = 'tmp:...' and are
 * deliberately excluded — processing them would write an "upload did
 * not finalize" error result row that then permanently masks the file
 * after upload actually completes (because the runner skips any
 * fileName already in the results table on resume).
 *
 * Files with NULL or empty storageKey are also excluded for the same
 * reason. The runner will pick them up on a subsequent invocation once
 * markScheduleBImportFileQueued has assigned a permanent key.
 */
export async function listAllUploadedScheduleBImportFiles(jobId: string) {
  const db = await getDb();
  if (!db) return [] as Array<{ fileName: string; storageKey: string | null }>;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [] as Array<{ fileName: string; storageKey: string | null }>;
  return withDbRetry("list all uploaded schedule b import files", async () => {
    const rows = await db
      .select({
        fileName: scheduleBImportFiles.fileName,
        storageKey: scheduleBImportFiles.storageKey,
      })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          // Exclude tmp:, NULL, and empty — i.e. any file whose upload
          // has not yet been finalized into permanent storage.
          sql`${scheduleBImportFiles.storageKey} IS NOT NULL`,
          sql`${scheduleBImportFiles.storageKey} <> ''`,
          sql`${scheduleBImportFiles.storageKey} NOT LIKE 'tmp:%'`
        )
      )
      .orderBy(asc(scheduleBImportFiles.fileName));
    return rows;
  });
}

/**
 * Return the set of fileNames that already have a row in
 * scheduleBImportResults for the given job. Used by the runner to skip
 * already-processed files on resume (mirrors getCompletedCsgIdsForJob
 * in the contract scraper).
 */
export async function getCompletedScheduleBImportFileNames(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return new Set();
  return withDbRetry("get completed schedule b file names", async () => {
    const rows = await db
      .select({ fileName: scheduleBImportResults.fileName })
      .from(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId));
    return new Set(rows.map((r) => r.fileName));
  });
}

export async function requeueScheduleBImportProcessingFiles(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("requeue schedule b import processing files", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "queued",
        error: null,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "processing")
        )
      );
  });
}

/**
 * DEPRECATED — retained as a no-op so any cached caller (e.g. already-
 * deployed clients polling the old getScheduleBImportStatus) continues
 * to function. The new runner handles stale "tmp:" storage keys
 * explicitly per-file (writing an error result row) rather than
 * sweeping with a global UPDATE that could race with in-flight uploads.
 */
export async function failScheduleBImportFilesWithInvalidStorage(_jobId: string) {
  // Intentionally empty. See the rewritten scheduleBImportJobRunner for
  // the new per-file "storageKey missing / tmp:" error handling.
}

export async function requeueScheduleBImportRetryableFiles(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;

  await withDbRetry("requeue schedule b import retryable files", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "queued",
        error: null,
        processedAt: null,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "failed"),
          sql`${scheduleBImportFiles.storageKey} IS NOT NULL`,
          sql`${scheduleBImportFiles.storageKey} <> ''`,
          sql`${scheduleBImportFiles.storageKey} NOT LIKE 'tmp:%'`
        )
      );

    await db.execute(sql`
      UPDATE scheduleBImportFiles f
      JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'queued',
        f.error = NULL,
        f.processedAt = NULL
      WHERE
        f.jobId = ${jobId}
        AND f.status = 'completed'
        AND r.error IS NOT NULL
    `);
  });
}

/**
 * Delete rows that are stuck in 'uploading' status with a NULL / empty /
 * 'tmp:%' storageKey, i.e. upload sessions the client started but never
 * finalized (browser crash, page reload, retry loop exhausted, etc.).
 *
 * These rows are invisible to listAllUploadedScheduleBImportFiles (which
 * excludes tmp: keys) so they never get processed, but they DO count
 * toward the job's totalFiles tally — which means the runner's
 * "remaining = totalFiles - processed" check never reaches 0 and the
 * job stays wedged in 'queued' forever.
 *
 * After calling this, the caller should invoke
 * reconcileScheduleBImportJobState to resync the job-row counters and
 * runScheduleBImportJob to re-evaluate the completion state.
 *
 * Returns the number of rows deleted.
 */
export async function clearScheduleBImportStuckUploads(
  jobId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;

  return withDbRetry("clear schedule b import stuck uploads", async () => {
    const result = await db.execute(sql`
      DELETE FROM scheduleBImportFiles
      WHERE jobId = ${jobId}
        AND status = 'uploading'
        AND (
          storageKey IS NULL
          OR storageKey = ''
          OR storageKey LIKE 'tmp:%'
        )
    `);
    return getDbExecuteAffectedRows(result);
  });
}

export async function getScheduleBImportJobCounts(jobId: string) {
  const db = await getDb();
  if (!db) {
    return {
      totalFiles: 0,
      uploadingFiles: 0,
      queuedFiles: 0,
      processingFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      uploadedFiles: 0,
      processedFiles: 0,
      successCount: 0,
      failureCount: 0,
    };
  }
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) {
    return {
      totalFiles: 0,
      uploadingFiles: 0,
      queuedFiles: 0,
      processingFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      uploadedFiles: 0,
      processedFiles: 0,
      successCount: 0,
      failureCount: 0,
    };
  }

  return withDbRetry("get schedule b import job counts", async () => {
    const [
      totalFilesResult,
      uploadingResult,
      queuedResult,
      processingResult,
      completedResult,
      failedResult,
      successResult,
      extractionFailedResult,
    ] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(eq(scheduleBImportFiles.jobId, jobId)),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "uploading")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "queued")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "processing")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "completed")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "failed")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(
          and(
            eq(scheduleBImportResults.jobId, jobId),
            sql`${scheduleBImportResults.error} IS NULL`
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(
          and(
            eq(scheduleBImportResults.jobId, jobId),
            sql`${scheduleBImportResults.error} IS NOT NULL`
          )
        ),
    ]);

    const totalFiles = totalFilesResult[0]?.count ?? 0;
    const uploadingFiles = uploadingResult[0]?.count ?? 0;
    const queuedFiles = queuedResult[0]?.count ?? 0;
    const processingFiles = processingResult[0]?.count ?? 0;
    const completedFiles = completedResult[0]?.count ?? 0;
    const failedFiles = failedResult[0]?.count ?? 0;
    const successCount = successResult[0]?.count ?? 0;
    const extractionFailedCount = extractionFailedResult[0]?.count ?? 0;

    return {
      totalFiles,
      uploadingFiles,
      queuedFiles,
      processingFiles,
      completedFiles,
      failedFiles,
      uploadedFiles: Math.max(0, totalFiles - uploadingFiles),
      processedFiles: completedFiles + failedFiles,
      successCount,
      failureCount: extractionFailedCount + failedFiles,
    };
  });
}

function getDbExecuteAffectedRows(result: unknown): number {
  if (!result) return 0;
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as { affectedRows?: unknown };
    if (typeof first?.affectedRows === "number") return first.affectedRows;
  }
  if (typeof result === "object" && "affectedRows" in result) {
    const affected = (result as { affectedRows?: unknown }).affectedRows;
    if (typeof affected === "number") return affected;
  }
  return 0;
}

export async function reconcileScheduleBImportJobState(jobId: string) {
  const db = await getDb();
  const emptyCounts = {
    totalFiles: 0,
    uploadingFiles: 0,
    queuedFiles: 0,
    processingFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    uploadedFiles: 0,
    processedFiles: 0,
    successCount: 0,
    failureCount: 0,
    filesMarkedCompleted: 0,
    filesRequeued: 0,
  };
  if (!db) return emptyCounts;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return emptyCounts;

  let filesMarkedCompleted = 0;
  let filesRequeued = 0;

  await withDbRetry("reconcile schedule b import job state", async () => {
    const now = new Date();
    // IMPORTANT: exclude in-flight uploads (NULL / empty / 'tmp:%'
    // storageKey) from the markCompleted sweep. Without this guard the
    // reconciler flips a row from 'uploading' -> 'completed' whenever a
    // matching result row exists from a prior scan of the same filename
    // (e.g. a re-upload), which causes the next chunk of the in-flight
    // upload to fail with "Upload session missing ...". The requeue
    // step below already has the same guard; this aligns the
    // markCompleted step with the invariant enforced by
    // listAllUploadedScheduleBImportFiles.
    const markCompletedResult = await db.execute(sql`
      UPDATE scheduleBImportFiles f
      JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'completed',
        f.error = NULL,
        f.processedAt = COALESCE(f.processedAt, r.scannedAt),
        f.updatedAt = ${now}
      WHERE
        f.jobId = ${jobId}
        AND f.storageKey IS NOT NULL
        AND f.storageKey <> ''
        AND f.storageKey NOT LIKE 'tmp:%'
        AND (
          f.status <> 'completed'
          OR f.error IS NOT NULL
        )
    `);
    filesMarkedCompleted = getDbExecuteAffectedRows(markCompletedResult);

    const requeueResult = await db.execute(sql`
      UPDATE scheduleBImportFiles f
      LEFT JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'queued',
        f.error = NULL,
        f.processedAt = NULL,
        f.updatedAt = ${now}
      WHERE
        f.jobId = ${jobId}
        AND f.status = 'processing'
        AND f.storageKey IS NOT NULL
        AND f.storageKey <> ''
        AND f.storageKey NOT LIKE 'tmp:%'
        AND r.id IS NULL
    `);
    filesRequeued = getDbExecuteAffectedRows(requeueResult);
  });

  const counts = await getScheduleBImportJobCounts(jobId);
  await withDbRetry("sync schedule b import job counters from authoritative counts", async () => {
    await db
      .update(scheduleBImportJobs)
      .set({
        totalFiles: counts.totalFiles,
        successCount: counts.successCount,
        failureCount: counts.failureCount,
      })
      .where(eq(scheduleBImportJobs.id, jobId));
  });

  return {
    ...counts,
    filesMarkedCompleted,
    filesRequeued,
  };
}

// ── Schedule B Import Results ─────────────────────────────────────

export async function upsertScheduleBImportResult(
  data: {
    jobId: string;
    fileName: string;
    designatedSystemId: string | null;
    gatsId: string | null;
    acSizeKw: number | null;
    capacityFactor: number | null;
    contractPrice: number | null;
    energizationDate: string | null;
    maxRecQuantity: number | null;
    deliveryYearsJson: string;
    error: string | null;
    scannedAt: Date;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;

  const scannedAt = data.scannedAt
    ? new Date(Math.floor(data.scannedAt.getTime() / 1000) * 1000)
    : new Date();
  const now = new Date();

  await withDbRetry("upsert schedule b import result", async () => {
    const existing = await db
      .select({ id: scheduleBImportResults.id })
      .from(scheduleBImportResults)
      .where(
        and(
          eq(scheduleBImportResults.jobId, data.jobId),
          eq(scheduleBImportResults.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportResults)
        .set({
          designatedSystemId: data.designatedSystemId,
          gatsId: data.gatsId,
          acSizeKw: data.acSizeKw,
          capacityFactor: data.capacityFactor,
          contractPrice: data.contractPrice,
          energizationDate: data.energizationDate,
          maxRecQuantity: data.maxRecQuantity,
          deliveryYearsJson: data.deliveryYearsJson,
          error: data.error,
          scannedAt,
        })
        .where(eq(scheduleBImportResults.id, existing[0].id));
      return;
    }

    await db.insert(scheduleBImportResults).values({
      id: nanoid(),
      jobId: data.jobId,
      fileName: data.fileName,
      designatedSystemId: data.designatedSystemId,
      gatsId: data.gatsId,
      acSizeKw: data.acSizeKw,
      capacityFactor: data.capacityFactor,
      contractPrice: data.contractPrice,
      energizationDate: data.energizationDate,
      maxRecQuantity: data.maxRecQuantity,
      deliveryYearsJson: data.deliveryYearsJson,
      error: data.error,
      scannedAt,
    });
  });

  await withDbRetry("mark schedule b file completed after result upsert", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "completed",
        error: null,
        processedAt: scannedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      );
  });
}

export async function listScheduleBImportResults(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return { rows: [], total: 0 };

  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;

  return withDbRetry("list schedule b import results", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, jobId))
        .orderBy(asc(scheduleBImportResults.fileName))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function getAllScheduleBImportResults(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("get all schedule b import results", async () =>
    db
      .select()
      .from(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId))
      .orderBy(asc(scheduleBImportResults.fileName))
  );
}

/**
 * Mark a set of schedule B import result rows as applied to the
 * deliveryScheduleBase dataset. Called by
 * applyScheduleBToDeliveryObligations after a successful merge +
 * persist. The "Apply as Delivery Schedule (N)" button counter binds
 * to the resulting pendingApplyCount so it decreases automatically.
 *
 * Safe to call with an empty fileNames array (no-op).
 *
 * Returns the number of rows affected.
 */
export async function markScheduleBImportResultsApplied(
  jobId: string,
  fileNames: string[]
): Promise<number> {
  if (fileNames.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;

  return withDbRetry("mark schedule b import results applied", async () => {
    // Chunk the UPDATE so we don't build an unbounded IN list if the
    // caller hands us tens of thousands of filenames. MySQL/TiDB handle
    // large IN lists but the query planner stays fastest at ~1k.
    const CHUNK_SIZE = 500;
    const now = new Date();
    let totalAffected = 0;
    for (let start = 0; start < fileNames.length; start += CHUNK_SIZE) {
      const chunk = fileNames.slice(start, start + CHUNK_SIZE);
      const result = await db.execute(sql`
        UPDATE scheduleBImportResults
        SET appliedAt = ${now}
        WHERE jobId = ${jobId}
          AND fileName IN (${sql.join(
            chunk.map((name) => sql`${name}`),
            sql`, `
          )})
      `);
      totalAffected += getDbExecuteAffectedRows(result);
    }
    return totalAffected;
  });
}

/**
 * COUNT(*) of scheduleBImportResults rows for the job that have no
 * error AND have not been applied yet. This is the authoritative count
 * behind the "Apply as Delivery Schedule (N)" button label.
 *
 * Uses the (jobId, appliedAt) index.
 */
export async function getPendingScheduleBImportApplyCount(
  jobId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;
  return withDbRetry("get pending schedule b apply count", async () => {
    const rows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(scheduleBImportResults)
      .where(
        and(
          eq(scheduleBImportResults.jobId, jobId),
          sql`${scheduleBImportResults.error} IS NULL`,
          sql`${scheduleBImportResults.appliedAt} IS NULL`
        )
      );
    return rows[0]?.count ?? 0;
  });
}

export async function deleteScheduleBImportJobData(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("delete schedule b import job data", async () => {
    await db
      .delete(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId));
    await db
      .delete(scheduleBImportFiles)
      .where(eq(scheduleBImportFiles.jobId, jobId));
    await db
      .delete(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}
