import { eq, and, desc, asc, sql, gte, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type PoolOptions } from "mysql2";

import { ENV } from "../_core/env";

// Re-export commonly used drizzle helpers so sub-modules can import
// them from "./_core" without duplicating the import.
export { eq, and, desc, asc, sql, gte, inArray };

// Re-export the schema so other modules can import everything from
// a single source if they prefer.
export * as schema from "../../drizzle/schema";

// ─────────────────────────────────────────────────────────────────────
// Module-level singletons
// ─────────────────────────────────────────────────────────────────────

let _db: ReturnType<typeof drizzle> | null = null;
let _solarRecDashboardTableEnsured = false;
let _solarRecDatasetSyncStateTableEnsured = false;
let _userFeedbackTableEnsured = false;
let _scheduleBImportTablesEnsured = false;
let _contractScanOverrideColumnsEnsured = false;
let _scheduleBCsgIdsTableEnsured = false;

export const SOLAR_REC_DB_CHUNK_CHARS = 900_000;

const RETRYABLE_DB_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
]);

// ─────────────────────────────────────────────────────────────────────
// Error / retry helpers
// ─────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function withDbRetry<T>(
  operation: string,
  action: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
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

// ─────────────────────────────────────────────────────────────────────
// Pool configuration helpers
// ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// Misc shared helpers
// ─────────────────────────────────────────────────────────────────────

export function splitIntoChunks(value: string, chunkSize: number): string[] {
  if (value.length <= chunkSize) return [value];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

export function getDbExecuteAffectedRows(result: unknown): number {
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

export function buildMessagePreview(
  content: string | null | undefined,
  maxLength = 140
): string {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

// Re-export ENV so other modules can grab it via "./_core"
export { ENV };

// ─────────────────────────────────────────────────────────────────────
// getDb singleton
// ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// Table-ensure helpers (lazy migrations on first call per process)
// ─────────────────────────────────────────────────────────────────────

export async function ensureSolarRecDashboardStorageTable() {
  const db = await getDb();
  if (!db) return false;
  if (_solarRecDashboardTableEnsured) return true;

  await withDbRetry("ensure solar rec dashboard storage table", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS solarRecDashboardStorage (
        id varchar(64) NOT NULL,
        userId int NOT NULL,
        scopeId varchar(64) NULL,
        storageKey varchar(191) NOT NULL,
        chunkIndex int NOT NULL,
        payload mediumtext NOT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY solar_rec_dashboard_storage_user_key_chunk_idx (userId, storageKey, chunkIndex),
        KEY solar_rec_dashboard_storage_user_key_idx (userId, storageKey),
        UNIQUE KEY solar_rec_dashboard_storage_scope_key_chunk_idx (scopeId, storageKey, chunkIndex),
        KEY solar_rec_dashboard_storage_scope_key_idx (scopeId, storageKey)
      )
    `);

    // Migrate older installs that created this as TEXT so larger payloads can persist.
    await db.execute(sql`
      ALTER TABLE solarRecDashboardStorage
      MODIFY COLUMN payload MEDIUMTEXT NOT NULL
    `);

    // Task 1.2b (PR A): add scopeId column + indexes to older installs.
    // Idempotent: IF NOT EXISTS guards avoid errors on fresh DBs where
    // the CREATE TABLE above already includes them.
    await db.execute(sql`
      ALTER TABLE solarRecDashboardStorage
      ADD COLUMN IF NOT EXISTS scopeId varchar(64) NULL AFTER userId
    `);
    await db.execute(sql`
      UPDATE solarRecDashboardStorage
      SET scopeId = CONCAT('scope-user-', userId)
      WHERE scopeId IS NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS solar_rec_dashboard_storage_scope_key_chunk_idx
      ON solarRecDashboardStorage (scopeId, storageKey, chunkIndex)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS solar_rec_dashboard_storage_scope_key_idx
      ON solarRecDashboardStorage (scopeId, storageKey)
    `);
  });

  _solarRecDashboardTableEnsured = true;
  return true;
}

export async function ensureSolarRecDatasetSyncStateTable() {
  const db = await getDb();
  if (!db) return false;
  if (_solarRecDatasetSyncStateTableEnsured) return true;

  await withDbRetry("ensure solar rec dataset sync state table", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS solarRecDatasetSyncState (
        id varchar(64) NOT NULL,
        userId int NOT NULL,
        scopeId varchar(64) NULL,
        storageKey varchar(191) NOT NULL,
        payloadSha256 varchar(64) NOT NULL DEFAULT '',
        payloadBytes int NOT NULL DEFAULT 0,
        dbPersisted tinyint(1) NOT NULL DEFAULT 0,
        storageSynced tinyint(1) NOT NULL DEFAULT 0,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY solar_rec_dataset_sync_state_user_key_idx (userId, storageKey),
        KEY solar_rec_dataset_sync_state_user_updated_idx (userId, updatedAt),
        UNIQUE KEY solar_rec_dataset_sync_state_scope_key_idx (scopeId, storageKey),
        KEY solar_rec_dataset_sync_state_scope_updated_idx (scopeId, updatedAt)
      )
    `);

    // Task 1.2b (PR A): add scopeId column + indexes to older installs.
    await db.execute(sql`
      ALTER TABLE solarRecDatasetSyncState
      ADD COLUMN IF NOT EXISTS scopeId varchar(64) NULL AFTER userId
    `);
    await db.execute(sql`
      UPDATE solarRecDatasetSyncState
      SET scopeId = CONCAT('scope-user-', userId)
      WHERE scopeId IS NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS solar_rec_dataset_sync_state_scope_key_idx
      ON solarRecDatasetSyncState (scopeId, storageKey)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS solar_rec_dataset_sync_state_scope_updated_idx
      ON solarRecDatasetSyncState (scopeId, updatedAt)
    `);
  });

  _solarRecDatasetSyncStateTableEnsured = true;
  return true;
}

export async function ensureUserFeedbackTable() {
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

export async function ensureScheduleBImportTables() {
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
      if (!(await resultsColumnExists("contractNumber"))) {
        await db.execute(
          sql.raw(
            "ALTER TABLE scheduleBImportResults ADD COLUMN contractNumber varchar(32) DEFAULT NULL"
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

export async function ensureContractScanOverrideColumns() {
  const db = await getDb();
  if (!db || _contractScanOverrideColumnsEnsured) return;

  const columnExists = async (columnName: string): Promise<boolean> => {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'contractScanResults'
        AND column_name = ${columnName}
    `)) as unknown as Array<Array<{ cnt: number }>>;
    const rows = Array.isArray(result) ? result[0] : [];
    return Array.isArray(rows) && rows[0]?.cnt > 0;
  };

  try {
    if (!(await columnExists("overrideVendorFeePercent"))) {
      await db.execute(sql.raw("ALTER TABLE contractScanResults ADD COLUMN overrideVendorFeePercent double DEFAULT NULL"));
    }
    if (!(await columnExists("overrideAdditionalCollateralPercent"))) {
      await db.execute(sql.raw("ALTER TABLE contractScanResults ADD COLUMN overrideAdditionalCollateralPercent double DEFAULT NULL"));
    }
    if (!(await columnExists("overrideNotes"))) {
      await db.execute(sql.raw("ALTER TABLE contractScanResults ADD COLUMN overrideNotes varchar(512) DEFAULT NULL"));
    }
    if (!(await columnExists("overriddenAt"))) {
      await db.execute(sql.raw("ALTER TABLE contractScanResults ADD COLUMN overriddenAt timestamp NULL DEFAULT NULL"));
    }
  } catch (migrationError) {
    console.warn("[db] contractScanResults override columns migration failed:", migrationError instanceof Error ? migrationError.message : migrationError);
  }

  _contractScanOverrideColumnsEnsured = true;
}

export async function ensureScheduleBImportCsgIdsTable() {
  const db = await getDb();
  if (!db) return false;
  if (_scheduleBCsgIdsTableEnsured) return true;

  await withDbRetry("ensure schedule b csg ids table", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduleBImportCsgIds (
        id varchar(64) NOT NULL,
        jobId varchar(64) NOT NULL,
        csgId varchar(64) NOT NULL,
        nonId varchar(64) DEFAULT NULL,
        abpId varchar(64) DEFAULT NULL,
        createdAt timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY schedule_b_csg_ids_job_csg_idx (jobId, csgId),
        KEY schedule_b_csg_ids_job_idx (jobId)
      )
    `);
  });

  _scheduleBCsgIdsTableEnsured = true;
  return true;
}
