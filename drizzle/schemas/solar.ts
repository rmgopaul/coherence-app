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
