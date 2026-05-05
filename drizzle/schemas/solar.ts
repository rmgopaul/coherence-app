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
  json,
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
    /**
     * Team scope this row belongs to. Added as nullable in Task 1.2b
     * migration (PR A) so existing per-user rows keep working while
     * PR B rewrites the procedures to resolve by scope. Backfilled
     * to `scope-user-${userId}` at migration time. Tightens to NOT
     * NULL in a follow-up once all readers are on the new column.
     */
    scopeId: varchar("scopeId", { length: 64 }),
    storageKey: varchar("storageKey", { length: 191 }).notNull(),
    chunkIndex: int("chunkIndex").notNull(),
    payload: mediumtext("payload").notNull(),
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
    scopeKeyChunkIdx: uniqueIndex("solar_rec_dashboard_storage_scope_key_chunk_idx").on(
      table.scopeId,
      table.storageKey,
      table.chunkIndex
    ),
    scopeKeyIdx: index("solar_rec_dashboard_storage_scope_key_idx").on(
      table.scopeId,
      table.storageKey
    ),
  })
);

export type SolarRecDashboardStorage = typeof solarRecDashboardStorage.$inferSelect;
export type InsertSolarRecDashboardStorage = typeof solarRecDashboardStorage.$inferInsert;

export const solarRecDatasetSyncState = mysqlTable(
  "solarRecDatasetSyncState",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    /** See `solarRecDashboardStorage.scopeId` — same migration semantics. */
    scopeId: varchar("scopeId", { length: 64 }),
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
    scopeStorageKeyIdx: uniqueIndex("solar_rec_dataset_sync_state_scope_key_idx").on(
      table.scopeId,
      table.storageKey
    ),
    scopeUpdatedAtIdx: index("solar_rec_dataset_sync_state_scope_updated_idx").on(
      table.scopeId,
      table.updatedAt
    ),
  })
);

export type SolarRecDatasetSyncState = typeof solarRecDatasetSyncState.$inferSelect;
export type InsertSolarRecDatasetSyncState = typeof solarRecDatasetSyncState.$inferInsert;

// Section engagement tracking for dashboard utility feedback.

export const monitoringApiRuns = mysqlTable(
  "monitoringApiRuns",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    // Task 5.3 — scope the run to a solar-rec tenant. Existing rows are
    // backfilled to Rhett's scope by migration 0034; all new inserts must
    // pass a scopeId from the request context.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    // Previously: unique on (provider, connectionId, siteId, dateKey).
    // scopeId is now part of the unique key so two scopes can each own
    // rows for the same external site without colliding. connectionId is
    // still included so multiple logins for the same provider/scope can
    // each own their own row per day.
    scopeProviderConnectionSiteDateIdx: uniqueIndex(
      "monitoring_api_runs_scope_provider_conn_site_date_idx"
    ).on(table.scopeId, table.provider, table.connectionId, table.siteId, table.dateKey),
    dateKeyIdx: index("monitoring_api_runs_date_key_idx").on(table.dateKey),
    scopeDateIdx: index("monitoring_api_runs_scope_date_idx").on(table.scopeId, table.dateKey),
    scopeProviderSiteDateIdx: index(
      "monitoring_api_runs_scope_provider_site_date_idx"
    ).on(table.scopeId, table.provider, table.siteId, table.dateKey),
    scopeDateProviderStatusIdx: index(
      "monitoring_api_runs_scope_date_provider_status_idx"
    ).on(table.scopeId, table.dateKey, table.provider, table.status, table.siteId),
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
    // Task 5.3 — scope the batch run to a solar-rec tenant. Same
    // semantics as monitoringApiRuns.scopeId.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeDateIdx: index("monitoring_batch_runs_scope_date_idx").on(
      table.scopeId,
      table.dateKey
    ),
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
    // Task 5.7 PR-A (2026-04-26): scope tenancy key. Backfilled to
    // `scope-user-${userId}` for existing rows so the single-tenant
    // production state is preserved. New jobs set this from
    // `resolveSolarRecScopeId()` (computed at the proc layer until
    // Task 5.7 PR-B moves the procs onto the standalone router with
    // `ctx.scopeId` available directly).
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("contract_scan_jobs_scope_idx").on(table.scopeId),
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
    // Task 5.7 PR-A (2026-04-26): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId. Backfilled via UPDATE…JOIN
    // contractScanJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
  },
  (table) => ({
    jobCsgIdx: uniqueIndex("contract_scan_job_csg_ids_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    jobIdx: index("contract_scan_job_csg_ids_job_idx").on(table.jobId),
    scopeIdx: index("contract_scan_job_csg_ids_scope_idx").on(table.scopeId),
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
    // Task 5.7 PR-A (2026-04-26): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId. Backfilled via UPDATE…JOIN
    // contractScanJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("contract_scan_results_scope_idx").on(table.scopeId),
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
    // Task 5.6 PR-B (2026-04-26): scope tenancy key. Backfilled to
    // `scope-user-${userId}` for existing rows so the single-tenant
    // production state is preserved. New jobs set this from
    // `ctx.scopeId` (the standalone Solar REC context).
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("schedule_b_import_jobs_scope_idx").on(table.scopeId),
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
    // Task 5.6 PR-B (2026-04-26): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId so file-level queries can
    // filter without an additional join. Backfilled via
    // UPDATE…JOIN scheduleBImportJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("schedule_b_import_files_scope_idx").on(table.scopeId),
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
    // Task 5.6 PR-B (2026-04-26): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId. Backfilled via UPDATE…JOIN
    // scheduleBImportJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("schedule_b_import_results_scope_idx").on(table.scopeId),
  })
);

export type ScheduleBImportResult = typeof scheduleBImportResults.$inferSelect;
export type InsertScheduleBImportResult = typeof scheduleBImportResults.$inferInsert;

export const scheduleBImportCsgIds = mysqlTable(
  "scheduleBImportCsgIds",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    // Task 5.6 PR-B (2026-04-26): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId. Backfilled via UPDATE…JOIN
    // scheduleBImportJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    scopeIdx: index("schedule_b_csg_ids_scope_idx").on(table.scopeId),
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

export const solarRecImportBatches = mysqlTable(
  "solarRecImportBatches",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    datasetKey: varchar("datasetKey", { length: 64 }).notNull(),
    ingestSource: varchar("ingestSource", { length: 16 }).notNull(),
    mergeStrategy: varchar("mergeStrategy", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
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

export const solarRecComputeRuns = mysqlTable(
  "solarRecComputeRuns",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    artifactType: varchar("artifactType", { length: 64 }).notNull(),
    inputVersionHash: varchar("inputVersionHash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
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
    scopeBatchIdx: index("sr_ds_solar_apps_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_abp_report_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_gen_entry_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_acct_solar_gen_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_contracted_date_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_delivery_schedule_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
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
    scopeBatchIdx: index("sr_ds_transfer_history_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeUnitIdx: index("sr_ds_transfer_history_scope_unit_idx").on(
      table.scopeId,
      table.unitId
    ),
  })
);

export type SrDsTransferHistory = typeof srDsTransferHistory.$inferSelect;
export type InsertSrDsTransferHistory = typeof srDsTransferHistory.$inferInsert;

// Task 5.12 PR-1 (2026-04-27): Generator Details row table.
// Added when migrating the 11 non-row-backed dashboard datasets to srDs*.
// `gatsUnitId` and `dateOnline` are the only stable typed columns — both come
// from the dataset's `requiredHeaderSets`. AC size headers are fuzzy-matched
// at read time (see parseGeneratorDetailsAcSizeKw) so they stay in `rawRow`.
export const srDsGeneratorDetails = mysqlTable(
  "srDsGeneratorDetails",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    gatsUnitId: varchar("gatsUnitId", { length: 128 }),
    dateOnline: varchar("dateOnline", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_generator_details_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_generator_details_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeUnitIdx: index("sr_ds_generator_details_scope_unit_idx").on(
      table.scopeId,
      table.gatsUnitId
    ),
  })
);

export type SrDsGeneratorDetails = typeof srDsGeneratorDetails.$inferSelect;
export type InsertSrDsGeneratorDetails = typeof srDsGeneratorDetails.$inferInsert;

// Task 5.12 PR-2 (2026-04-27): ABP CSG-System Mapping row table.
// Single-file replace dataset. Only two stable typed columns — both
// come from `requiredHeaderSets` and both are read by every consumer
// (FinancialsTab, AppPipelineTab, the financials profit-data joins
// in SolarRecDashboard.tsx). Large portfolios can have 28k+ rows
// (see solarRecContractScanRouter.ts:307); the typed indexes keep
// CSG ID lookups O(log n).
export const srDsAbpCsgSystemMapping = mysqlTable(
  "srDsAbpCsgSystemMapping",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }),
    systemId: varchar("systemId", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_csg_system_mapping_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_csg_system_mapping_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeCsgIdx: index("sr_ds_abp_csg_system_mapping_scope_csg_idx").on(
      table.scopeId,
      table.csgId
    ),
  })
);

export type SrDsAbpCsgSystemMapping = typeof srDsAbpCsgSystemMapping.$inferSelect;
export type InsertSrDsAbpCsgSystemMapping = typeof srDsAbpCsgSystemMapping.$inferInsert;

// Task 5.12 PR-3 (2026-04-27): ABP ProjectApplication Rows row table.
// Single-file replace dataset shared between Solar REC dashboard and
// ABP Monthly Invoice Settlement. Four stable typed columns — required
// headers (`applicationId` + `inverterSizeKwAcPart1`) plus the two
// date fields (`part1SubmissionDate`, `part1OriginalSubmissionDate`)
// that drive the application-fee cutoff logic in
// `client/src/lib/abpSettlement.ts`. No fuzzy header matching anywhere
// in the consumer chain (EarlyPayment, AbpInvoiceSettlement,
// parseProjectApplications), so all stable fields are typed; rawRow
// is preserved for forward-compat with future consumers.
export const srDsAbpProjectApplicationRows = mysqlTable(
  "srDsAbpProjectApplicationRows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    applicationId: varchar("applicationId", { length: 64 }),
    inverterSizeKwAcPart1: varchar("inverterSizeKwAcPart1", { length: 32 }),
    part1SubmissionDate: varchar("part1SubmissionDate", { length: 32 }),
    part1OriginalSubmissionDate: varchar(
      "part1OriginalSubmissionDate",
      { length: 32 }
    ),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_project_app_rows_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_project_app_rows_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeAppIdx: index("sr_ds_abp_project_app_rows_scope_app_idx").on(
      table.scopeId,
      table.applicationId
    ),
  })
);

export type SrDsAbpProjectApplicationRows =
  typeof srDsAbpProjectApplicationRows.$inferSelect;
export type InsertSrDsAbpProjectApplicationRows =
  typeof srDsAbpProjectApplicationRows.$inferInsert;

// Task 5.12 PR-4 (2026-04-27): ABP Portal Invoice Map Rows row table.
// Single-file replace dataset shared with ABP Monthly Invoice Settlement.
// Two stable typed columns (`csgId`, `invoiceNumber`) — both required
// headers; the only fuzzy lookup in the consumer chain is the
// "Num" header alias inside `parseInvoiceNumberMap`, which is a
// header-detection fallback, not a separate column. Hot path is the
// reverse `invoiceNumber → systemId` lookup in
// `buildInvoiceNumberToSystemIdMap`, but that joins through the
// settlement state in memory; the DB-side index that matters is
// `(scopeId, csgId)` so the settlement engine can re-hydrate
// per-system via paginated row reads (Task 5.13).
export const srDsAbpPortalInvoiceMapRows = mysqlTable(
  "srDsAbpPortalInvoiceMapRows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }),
    invoiceNumber: varchar("invoiceNumber", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_portal_invoice_map_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_portal_invoice_map_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeCsgIdx: index("sr_ds_abp_portal_invoice_map_scope_csg_idx").on(
      table.scopeId,
      table.csgId
    ),
  })
);

export type SrDsAbpPortalInvoiceMapRows =
  typeof srDsAbpPortalInvoiceMapRows.$inferSelect;
export type InsertSrDsAbpPortalInvoiceMapRows =
  typeof srDsAbpPortalInvoiceMapRows.$inferInsert;

// Task 5.12 PR-5 (2026-04-27): ABP CSG Portal Database Rows row table.
// Single-file replace dataset that carries 12 fields (2 required +
// 10 optional installer/company/location/email/payment-note attrs).
// Only `systemId` and `csgId` are promoted to typed columns: every
// other field in `parseCsgPortalDatabase` uses fuzzy keyword-based
// header detection (e.g., `["installer"]`, `["customer", "email"]`,
// `["collateral", "reimburs"]`), so reproducing that detection in
// the persister would re-implement parser logic that's already
// stable in the client. Keeping the 10 fuzzy fields in `rawRow`
// preserves the parser's authority and keeps the schema portable.
// Hot path is `(scopeId, csgId)` — `buildCsgPortalLookup` keys the
// per-system settlement-engine map on csgId.
export const srDsAbpCsgPortalDatabaseRows = mysqlTable(
  "srDsAbpCsgPortalDatabaseRows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    systemId: varchar("systemId", { length: 64 }),
    csgId: varchar("csgId", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_csg_portal_db_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_csg_portal_db_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeCsgIdx: index("sr_ds_abp_csg_portal_db_scope_csg_idx").on(
      table.scopeId,
      table.csgId
    ),
  })
);

export type SrDsAbpCsgPortalDatabaseRows =
  typeof srDsAbpCsgPortalDatabaseRows.$inferSelect;
export type InsertSrDsAbpCsgPortalDatabaseRows =
  typeof srDsAbpCsgPortalDatabaseRows.$inferInsert;

// Task 5.12 PR-6 (2026-04-27): ABP QuickBooks Rows row table.
// Single-file replace dataset that carries QuickBooks invoice-line
// detail rows. The parser (`parseQuickBooksDetailedReport` in
// `client/src/lib/abpSettlement.ts`) detects the raw QB export
// format by looking at the first three column headers
// (`Date`, `Num`, `Customer`) and then resolves all other fields
// via fuzzy keyword matching on normalized headers. Reproducing
// that detection in the persister would re-implement parser logic
// already stable in the client. Only `invoiceNumber` (the QB "Num"
// column) is typed — it's the join key the settlement engine uses
// to group multi-line invoices and reconcile against the portal
// invoice map. Everything else stays in `rawRow` for the client to
// re-parse on read.
export const srDsAbpQuickBooksRows = mysqlTable(
  "srDsAbpQuickBooksRows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    invoiceNumber: varchar("invoiceNumber", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_quick_books_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_quick_books_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeInvoiceIdx: index("sr_ds_abp_quick_books_scope_invoice_idx").on(
      table.scopeId,
      table.invoiceNumber
    ),
  })
);

export type SrDsAbpQuickBooksRows = typeof srDsAbpQuickBooksRows.$inferSelect;
export type InsertSrDsAbpQuickBooksRows =
  typeof srDsAbpQuickBooksRows.$inferInsert;

// Task 5.12 PR-7 (2026-04-27): ABP Utility Invoice Rows row table.
// Single-file replace dataset carrying utility invoice detail
// (system × payment-cycle × monthly-true-up). The parser
// (`parseUtilityInvoiceMatrix` in `client/src/lib/abpSettlement.ts`)
// detects the header row by exact match on
// "System ID + Payment Number + Total RECS + REC Price + Invoice Amount ($)"
// and then reads each field via `readByNormalizedHeader` with
// fuzzy alias lists (e.g. `["Invoice Amount ($)", "Invoice Amount"]`,
// `["Total RECS", "REC Quantity"]`). Reproducing that fuzzy
// detection in the persister would re-implement parser logic that
// is already stable in the client. Only `systemId` is typed — it's
// the join key for the CSG mapping and ICC report joins, and the
// only field the parser reads canonically (no fuzzy fallback).
// Hot path is `(scopeId, systemId)`.
export const srDsAbpUtilityInvoiceRows = mysqlTable(
  "srDsAbpUtilityInvoiceRows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    systemId: varchar("systemId", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_utility_invoice_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_utility_invoice_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeSystemIdx: index("sr_ds_abp_utility_invoice_scope_system_idx").on(
      table.scopeId,
      table.systemId
    ),
  })
);

export type SrDsAbpUtilityInvoiceRows =
  typeof srDsAbpUtilityInvoiceRows.$inferSelect;
export type InsertSrDsAbpUtilityInvoiceRows =
  typeof srDsAbpUtilityInvoiceRows.$inferInsert;

// Task 5.12 PR-8 (2026-04-27): Annual Production Estimates row table.
// Single-file replace dataset (one row per Unit ID = system) carrying
// the 12-month expected production profile used by PerformanceRatioTab
// and ForecastTab. Unlike the prior ABP migrations (PR-5/6/7) where
// fuzzy header detection forced a strict 1-typed-column approach,
// `annualProductionEstimates` has 13 stable canonical headers (Unit ID
// + 12 months) read by exact match in `buildAnnualProductionByTrackingId`
// (`client/src/solar-rec-dashboard/lib/helpers/system.ts`). All 12
// months are typed as `double` so future server-side aggregators
// (Task 5.13 TrendsTab/AlertsTab) can do `SUM(jan), SUM(feb)` without
// JSON-parsing rawRow. `unitId` and `facilityName` are typed for
// indexing and display. `rawRow` is preserved for forward-compat.
//
// PR-8 also removes phantom dataset keys `abpReportLatest` and
// `performanceSourceRows` from `ALL_DATASET_KEYS` in the router —
// neither key exists in the canonical `DatasetKey` union or
// `DATASET_DEFINITIONS`; they were planning-doc artifacts. The real
// remaining datasets after this PR are `convertedReads`,
// `abpIccReport2Rows`, and `abpIccReport3Rows` (3 not 5).
export const srDsAnnualProductionEstimates = mysqlTable(
  "srDsAnnualProductionEstimates",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    unitId: varchar("unitId", { length: 64 }),
    facilityName: varchar("facilityName", { length: 255 }),
    jan: double("jan"),
    feb: double("feb"),
    mar: double("mar"),
    apr: double("apr"),
    may: double("may"),
    jun: double("jun"),
    jul: double("jul"),
    aug: double("aug"),
    sep: double("sep"),
    oct: double("oct"),
    nov: double("nov"),
    decMonth: double("decMonth"),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_annual_production_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_annual_production_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeUnitIdx: index("sr_ds_annual_production_scope_unit_idx").on(
      table.scopeId,
      table.unitId
    ),
  })
);

export type SrDsAnnualProductionEstimates =
  typeof srDsAnnualProductionEstimates.$inferSelect;
export type InsertSrDsAnnualProductionEstimates =
  typeof srDsAnnualProductionEstimates.$inferInsert;

// Task 5.12 PR-9 (2026-04-27): ABP ICC Report 2 + Report 3 row tables.
// Two structurally-identical tables for the two ICC reports — they
// share the same `parseIccContractRows` parser (`EarlyPayment.tsx`),
// the same join key (`applicationId`), and the same field-alias
// reads in every consumer (EarlyPayment, deepUpdateSynth,
// SolarRecDashboard FinancialsTab/AppPipelineTab). Strict typed
// approach (mirrors PR-5/6/7): only `applicationId` is typed —
// every other field uses fuzzy alias lists in the parser, so
// reproducing that detection in the persister would re-implement
// stable client logic. Hot path is `(scopeId, applicationId)` for
// the per-application Map lookup in `buildIccMap`.
//
// The two reports are migrated together because their parser,
// schema shape, and consumer access patterns are identical — Report 3
// is the primary consumer in dashboard tabs, Report 2 is a fallback
// in EarlyPayment + deepUpdateSynth, and only one ABP-specific field
// (`Scheduled Energization Date`) is read from Report 2 only. That
// field is preserved in `rawRow` per the established pattern.
export const srDsAbpIccReport2Rows = mysqlTable(
  "srDsAbpIccReport2Rows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    applicationId: varchar("applicationId", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_icc_report_2_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_icc_report_2_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeAppIdx: index("sr_ds_abp_icc_report_2_scope_app_idx").on(
      table.scopeId,
      table.applicationId
    ),
  })
);

export type SrDsAbpIccReport2Rows =
  typeof srDsAbpIccReport2Rows.$inferSelect;
export type InsertSrDsAbpIccReport2Rows =
  typeof srDsAbpIccReport2Rows.$inferInsert;

export const srDsAbpIccReport3Rows = mysqlTable(
  "srDsAbpIccReport3Rows",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    applicationId: varchar("applicationId", { length: 64 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_abp_icc_report_3_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_abp_icc_report_3_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeAppIdx: index("sr_ds_abp_icc_report_3_scope_app_idx").on(
      table.scopeId,
      table.applicationId
    ),
  })
);

export type SrDsAbpIccReport3Rows =
  typeof srDsAbpIccReport3Rows.$inferSelect;
export type InsertSrDsAbpIccReport3Rows =
  typeof srDsAbpIccReport3Rows.$inferInsert;

// Task 5.12 PR-10 (2026-04-27): Converted Reads row table — the FINAL
// dataset migration in Task 5.12. Multi-file append (mirrors
// `srDsAccountSolarGeneration` and `srDsTransferHistory`) carrying
// per-system meter readings written BOTH by user uploads and by the
// monitoring bridge (`server/solar/convertedReadsBridge.ts`).
//
// Five typed columns matching the canonical required headers — every
// consumer (`PerformanceRatioTab`, `TrendsTab`, `DataQualityTab`,
// `SystemDetailSheet`) reads them via stable snake_case keys, no fuzzy
// matching anywhere in the chain. `lifetimeMeterReadWh` is `double`
// because consumers do `parseFloat(row.lifetime_meter_read_wh)`
// directly; typing it enables future server-side aggregation in
// Task 5.13 (TrendsTab / PerformanceRatioTab moves) without rawRow
// JSON parsing.
//
// `status` and `alertSeverity` are bridge padding columns (always
// empty strings from `buildConvertedReadRow`) so they stay in
// `rawRow` rather than getting dedicated typed columns.
//
// Hot-path index is `(scopeId, monitoringSystemId, readDate)` —
// PerformanceRatioTab does a per-system time-series scan, and the
// dedup checker for append uploads matches against the same prefix.
//
// Dedup key for append: all 5 required fields (per the bridge's
// `convertedReadsRowKey` at `convertedReadsBridge.ts:251`). Two reads
// that share scope/system/date but differ on `lifetimeMeterReadWh`
// (e.g., a corrected reading) are kept as separate rows so the
// downstream parser can resolve which one wins.
//
// PR-10 does NOT modify the bridge. The bridge continues writing to
// the chunked-CSV manifest as before. The server-side migration
// (`serverSideMigration.ts`) backfills `srDsConvertedReads` from
// existing chunked-CSV manifests on demand. Cutover to row-table-
// authoritative reads happens in a follow-up workstream alongside
// the TrendsTab / PerformanceRatioTab Task 5.13 migrations.
export const srDsConvertedReads = mysqlTable(
  "srDsConvertedReads",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    batchId: varchar("batchId", { length: 64 }).notNull(),
    monitoring: varchar("monitoring", { length: 64 }),
    monitoringSystemId: varchar("monitoringSystemId", { length: 128 }),
    monitoringSystemName: varchar("monitoringSystemName", { length: 255 }),
    lifetimeMeterReadWh: double("lifetimeMeterReadWh"),
    readDate: varchar("readDate", { length: 32 }),
    rawRow: mediumtext("rawRow"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    batchIdx: index("sr_ds_converted_reads_batch_idx").on(table.batchId),
    scopeBatchIdx: index("sr_ds_converted_reads_scope_batch_idx").on(
      table.scopeId,
      table.batchId
    ),
    scopeSystemDateIdx: index(
      "sr_ds_converted_reads_scope_system_date_idx"
    ).on(table.scopeId, table.monitoringSystemId, table.readDate),
  })
);

export type SrDsConvertedReads = typeof srDsConvertedReads.$inferSelect;
export type InsertSrDsConvertedReads =
  typeof srDsConvertedReads.$inferInsert;

// Step 7: Scope-Aware Contract Scan Bridge
export const solarRecScopeContractScanVersion = mysqlTable(
  "solarRecScopeContractScanVersion",
  {
    scopeId: varchar("scopeId", { length: 64 }).primaryKey(),
    latestCompletedJobId: varchar("latestCompletedJobId", { length: 64 }),
    latestOverrideAt: timestamp("latestOverrideAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  }
);

// ────────────────────────────────────────────────────────────────────
// Type exports for the Solar REC scope / import / compute tables.
// (The tables themselves were split out earlier without their $infer*
// types; parity-gap fixed here.)
// ────────────────────────────────────────────────────────────────────
export type SolarRecScope = typeof solarRecScopes.$inferSelect;
export type InsertSolarRecScope = typeof solarRecScopes.$inferInsert;
export type SolarRecImportBatch = typeof solarRecImportBatches.$inferSelect;
export type InsertSolarRecImportBatch = typeof solarRecImportBatches.$inferInsert;
export type SolarRecImportFile = typeof solarRecImportFiles.$inferSelect;
export type InsertSolarRecImportFile = typeof solarRecImportFiles.$inferInsert;
export type SolarRecImportError = typeof solarRecImportErrors.$inferSelect;
export type InsertSolarRecImportError = typeof solarRecImportErrors.$inferInsert;
export type SolarRecActiveDatasetVersion = typeof solarRecActiveDatasetVersions.$inferSelect;
export type SolarRecComputeRun = typeof solarRecComputeRuns.$inferSelect;
export type InsertSolarRecComputeRun = typeof solarRecComputeRuns.$inferInsert;

// ---------------------------------------------------------------------------
// DIN scrape job tables — CSG portal photo → DIN extraction
// ---------------------------------------------------------------------------

export const dinScrapeJobs = mysqlTable(
  "dinScrapeJobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("userId").notNull(),
    // Task 5.8 PR-A (2026-04-27): scope tenancy key. Backfilled to
    // `scope-user-${userId}` for existing rows. Same pattern as
    // contractScanJobs.scopeId (#117) and scheduleBImportJobs.scopeId
    // (#115).
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
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
    totalSites: int("totalSites").default(0).notNull(),
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
    userIdx: index("din_scrape_jobs_user_idx").on(table.userId),
    scopeIdx: index("din_scrape_jobs_scope_idx").on(table.scopeId),
    statusIdx: index("din_scrape_jobs_status_idx").on(table.status),
  })
);

export type DinScrapeJob = typeof dinScrapeJobs.$inferSelect;
export type InsertDinScrapeJob = typeof dinScrapeJobs.$inferInsert;

export const dinScrapeJobCsgIds = mysqlTable(
  "dinScrapeJobCsgIds",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    // Task 5.8 PR-A (2026-04-27): denormalized scope tenancy key.
    // Mirrors the parent job's scopeId. Backfilled via UPDATE…JOIN
    // dinScrapeJobs in the migration.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
  },
  (table) => ({
    jobCsgIdx: uniqueIndex("din_scrape_job_csg_ids_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    jobIdx: index("din_scrape_job_csg_ids_job_idx").on(table.jobId),
    scopeIdx: index("din_scrape_job_csg_ids_scope_idx").on(table.scopeId),
  })
);

export type DinScrapeJobCsgId = typeof dinScrapeJobCsgIds.$inferSelect;
export type InsertDinScrapeJobCsgId = typeof dinScrapeJobCsgIds.$inferInsert;

// One row per CSG site processed. Summary + error.
export const dinScrapeResults = mysqlTable(
  "dinScrapeResults",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    // Task 5.8 PR-A (2026-04-27): denormalized scope tenancy key.
    // Backfilled via UPDATE…JOIN dinScrapeJobs.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
    systemPageUrl: varchar("systemPageUrl", { length: 512 }),
    inverterPhotoCount: int("inverterPhotoCount").default(0).notNull(),
    meterPhotoCount: int("meterPhotoCount").default(0).notNull(),
    dinCount: int("dinCount").default(0).notNull(),
    error: text("error"),
    /**
     * JSON-serialized audit trail of every extractor attempt for this
     * site: which photos were tried, what QR/Claude/tesseract said
     * (including refusals and reasons for zero-DIN results), and what
     * rotations were used. Makes zero-DIN cases debuggable without
     * re-running the scraper. Bounded at mediumtext (~16 MB).
     */
    extractorLog: mediumtext("extractorLog"),
    scannedAt: timestamp("scannedAt").defaultNow(),
  },
  (table) => ({
    jobIdx: index("din_scrape_results_job_idx").on(table.jobId),
    jobCsgIdx: uniqueIndex("din_scrape_results_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    csgIdx: index("din_scrape_results_csg_idx").on(table.csgId),
    scopeIdx: index("din_scrape_results_scope_idx").on(table.scopeId),
  })
);

export type DinScrapeResult = typeof dinScrapeResults.$inferSelect;
export type InsertDinScrapeResult = typeof dinScrapeResults.$inferInsert;

// One row per DIN found — many per site.
export const dinScrapeDins = mysqlTable(
  "dinScrapeDins",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    // Task 5.8 PR-A (2026-04-27): denormalized scope tenancy key.
    // Backfilled via UPDATE…JOIN dinScrapeJobs.
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    csgId: varchar("csgId", { length: 64 }).notNull(),
    dinValue: varchar("dinValue", { length: 128 }).notNull(),
    sourceType: mysqlEnum("sourceType", ["inverter", "meter", "unknown"])
      .default("unknown")
      .notNull(),
    sourceUrl: varchar("sourceUrl", { length: 512 }),
    sourceFileName: varchar("sourceFileName", { length: 255 }),
    extractedBy: mysqlEnum("extractedBy", [
      "claude",
      "tesseract",
      "pdfjs",
      "qr",
    ])
      .default("claude")
      .notNull(),
    rawMatch: mediumtext("rawMatch"),
    foundAt: timestamp("foundAt").defaultNow(),
  },
  (table) => ({
    jobIdx: index("din_scrape_dins_job_idx").on(table.jobId),
    csgIdx: index("din_scrape_dins_csg_idx").on(table.csgId),
    jobDinIdx: uniqueIndex("din_scrape_dins_job_csg_din_idx").on(
      table.jobId,
      table.csgId,
      table.dinValue
    ),
    scopeIdx: index("din_scrape_dins_scope_idx").on(table.scopeId),
  })
);

export type DinScrapeDin = typeof dinScrapeDins.$inferSelect;
export type InsertDinScrapeDin = typeof dinScrapeDins.$inferInsert;

// ---------------------------------------------------------------------------
// Task 9.2 (2026-04-28) — Saved CSG-ID worksets (Phase 9 MVP).
//
// A workset is a named bag of CSG IDs scoped to a team. Created by
// any team member with `portfolio-workbench: edit`, visible to the
// whole scope so a teammate can pick up where another left off.
//
// CSG IDs are stored as a JSON-stringified `string[]` in `csgIdsJson`.
// Reasonable for an MVP — typical worksets hold 10–500 IDs and
// no procedure needs to filter by CSG-ID inside the JSON. If we ever
// need that, migrate to a join table `idWorksetCsgIds` mirroring the
// pattern in `contractScanJobCsgIds`. The mediumtext column gives us
// ~16 MB headroom — a workset of 250 K CSG IDs at 16 bytes each fits
// comfortably, and we cap inserts at 10 K via the proc layer.
//
// `createdByUserId` is preserved as the original author for audit;
// edits don't bump it. The proc layer additionally writes
// `lastEditedByUserId` so the team can see who last touched a workset.
// ---------------------------------------------------------------------------

export const idWorksets = mysqlTable(
  "idWorksets",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    createdByUserId: int("createdByUserId").notNull(),
    lastEditedByUserId: int("lastEditedByUserId"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    csgIdsJson: mediumtext("csgIdsJson").notNull(),
    csgIdCount: int("csgIdCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    scopeIdx: index("id_worksets_scope_idx").on(table.scopeId),
    scopeUpdatedIdx: index("id_worksets_scope_updated_idx").on(
      table.scopeId,
      table.updatedAt
    ),
    // Names are unique per scope so the "load workset" picker can
    // surface a single deduped list. Two team members editing the
    // same name simultaneously is acceptable — last writer wins via
    // updatedAt and the proc returns the conflict via the standard
    // duplicate-key path on insert.
    scopeNameIdx: uniqueIndex("id_worksets_scope_name_idx").on(
      table.scopeId,
      table.name
    ),
  })
);

export type IdWorkset = typeof idWorksets.$inferSelect;
export type InsertIdWorkset = typeof idWorksets.$inferInsert;

// ────────────────────────────────────────────────────────────────────
// Server-side dashboard upload — Phase 1 of the IndexedDB-removal
// refactor (docs/server-side-dashboard-refactor.md).
//
// `datasetUploadJobs` tracks one upload-and-parse-and-write run per
// CSV file. Chunks come in via the chunked-base64-tRPC pattern (same
// as Schedule B PDFs in `scheduleBImportFiles`) and reassemble into
// a temp file at `storageKey`. The runner stream-parses the file and
// writes typed rows directly into `srDs*` tables, bumping
// `rowsParsed` + `rowsWritten` atomically along the way.
//
// Status state machine:
//   queued    — row created, no chunks uploaded yet
//   uploading — chunks streaming in
//   parsing   — runner is preparing to stream-parse the reassembled CSV
//   preparing — append-mode runner is copying prior rows / loading dedupe keys
//   writing   — runner is batching rows into srDs* (overlap with parsing)
//   done      — completedAt stamped, batchId became the active version
//   failed    — errorMessage set; row preserved for diagnostic
//
// Per-row errors persist to `datasetUploadJobErrors` so a parser
// failure on row 4,217 of a 32k-row Solar Apps file doesn't abort
// the whole job — it logs and keeps going.
// ────────────────────────────────────────────────────────────────────

export const datasetUploadJobs = mysqlTable(
  "datasetUploadJobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    initiatedByUserId: int("initiatedByUserId").notNull(),
    // Which dataset (`solarApplications`, `abpReport`, …) this
    // upload targets. Validated against the registry on insert.
    datasetKey: varchar("datasetKey", { length: 64 }).notNull(),
    fileName: varchar("fileName", { length: 500 }).notNull(),
    fileSizeBytes: int("fileSizeBytes"),
    // Ephemeral upload session id; matches `tmp:<uploadId>` storage
    // keys during the chunked upload. Discarded after assembly.
    uploadId: varchar("uploadId", { length: 64 }),
    uploadedChunks: int("uploadedChunks").default(0).notNull(),
    totalChunks: int("totalChunks"),
    // `tmp:<uploadId>` while uploading; the absolute temp path
    // (under DATASET_UPLOAD_TMP_ROOT) once assembled.
    storageKey: varchar("storageKey", { length: 512 }),
    status: varchar("status", { length: 32 }).default("queued").notNull(),
    totalRows: int("totalRows"),
    rowsParsed: int("rowsParsed").default(0).notNull(),
    rowsWritten: int("rowsWritten").default(0).notNull(),
    errorMessage: text("errorMessage"),
    // The batch id written into the per-dataset srDs* table for
    // every row in this upload. After completion, this becomes the
    // active version in `solarRecActiveDatasetVersions`.
    batchId: varchar("batchId", { length: 64 }),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    scopeStatusIdx: index("dataset_upload_jobs_scope_status_idx").on(
      table.scopeId,
      table.status
    ),
    scopeDatasetCreatedIdx: index(
      "dataset_upload_jobs_scope_dataset_created_idx"
    ).on(table.scopeId, table.datasetKey, table.createdAt),
    scopeCreatedIdx: index("dataset_upload_jobs_scope_created_idx").on(
      table.scopeId,
      table.createdAt
    ),
  })
);

export type DatasetUploadJob = typeof datasetUploadJobs.$inferSelect;
export type InsertDatasetUploadJob = typeof datasetUploadJobs.$inferInsert;

export const datasetUploadJobErrors = mysqlTable(
  "datasetUploadJobErrors",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    jobId: varchar("jobId", { length: 64 }).notNull(),
    // Zero-based row index in the source CSV (header row excluded).
    // Null when the error happened before any row was reached
    // (file-level parse error, unknown dataset, etc.).
    rowIndex: int("rowIndex"),
    errorMessage: text("errorMessage").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    jobIdx: index("dataset_upload_job_errors_job_idx").on(table.jobId),
    jobCreatedIdx: index("dataset_upload_job_errors_job_created_idx").on(
      table.jobId,
      table.createdAt
    ),
  })
);

export type DatasetUploadJobError =
  typeof datasetUploadJobErrors.$inferSelect;
export type InsertDatasetUploadJobError =
  typeof datasetUploadJobErrors.$inferInsert;

// ────────────────────────────────────────────────────────────────────
// Dashboard CSV export jobs — Phase 6 PR-A.
//
// Replaces the in-memory `Map` registry in
// `server/services/solar/dashboardCsvExportJobs.ts` (originally
// shipped in PR #346 as transitional). The in-memory shape:
//   - dies on every process restart (deploy / OOM), orphaning any
//     in-flight jobs and forcing PR #352's "notFound is retryable"
//     workaround;
//   - has no story for multi-instance deploys (a poll routed to a
//     different process than the worker that started the job
//     reads `notFound`).
//
// This DB-backed table closes both gaps. Mirrors the
// `datasetUploadJobs` shape (atomic counter columns, status enum
// stored as varchar, indexed by `(scopeId, status)` for
// active-job lookup). Adds **claim fields** for cross-process
// safety: a runner only operates on a row whose `claimedBy ===
// own process id` AND whose `claimedAt` is recent enough to be
// considered live. Stale claims (a process restarted mid-job) are
// re-claimable by the next runner once `claimedAt` exceeds the
// heartbeat threshold.
//
// Status state machine:
//   queued    — row created, no worker has claimed it yet
//   running   — claimedBy + claimedAt set; worker is mid-flight
//   succeeded — completedAt stamped; fileName + artifactUrl
//               populated when rowCount > 0, both null on
//               empty-result jobs
//   failed    — completedAt stamped; errorMessage set
//
// Discriminated input is stored as JSON. Validated by the Zod
// schema on `startDashboardCsvExport.input(...)` at insert time;
// the runner re-validates on read so a future schema change
// doesn't crash the worker on stale rows.
//
// **Phase 6 PR-A is schema-only.** PR-B will swap the in-memory
// `Map` for this table. PR #352's `notFound` retry workaround
// reverts to terminal semantics in PR-B because notFound from a
// DB-backed registry genuinely means the job was pruned, never
// "process restarted."
// ────────────────────────────────────────────────────────────────────

export const dashboardCsvExportJobs = mysqlTable(
  "dashboardCsvExportJobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scopeId: varchar("scopeId", { length: 64 }).notNull(),
    // Discriminated input: see DashboardCsvExportInput in
    // `server/services/solar/dashboardCsvExportJobs.ts`. Today's
    // shape is one of:
    //   { exportType: "ownershipTile", tile: "reporting" | "notReporting" | "terminated" }
    //   { exportType: "changeOwnershipTile", status: ChangeOwnershipStatus }
    // Stored as JSON so future export types don't require a
    // schema migration; the worker re-validates the shape on
    // read.
    input: json("input").notNull(),
    // Status state machine values: "queued" | "running" |
    // "succeeded" | "failed". Stored as varchar (not mysqlEnum)
    // so adding a state in a code-only PR doesn't require a
    // schema migration; matches the `datasetUploadJobs` choice.
    status: varchar("status", { length: 32 }).default("queued").notNull(),
    // Lifecycle timestamps.
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    // Result fields (populated on success). Both fileName +
    // artifactUrl are null on empty-result (rowCount=0) jobs:
    // there's nothing for the client to download, only a "no rows
    // match" toast.
    fileName: varchar("fileName", { length: 500 }),
    artifactUrl: text("artifactUrl"),
    rowCount: int("rowCount"),
    csvBytes: int("csvBytes"),
    // Failure field (populated on failed). Mirrors the existing
    // `errorMessage` convention from `datasetUploadJobs`.
    errorMessage: text("errorMessage"),
    // Cross-process claim fields. The runner sets `claimedBy`
    // to a per-attempt identifier that includes process metadata
    // (e.g. `pid-${pid}-host-${hostname}-${suffix}`) before
    // transitioning queued → running, and refreshes `claimedAt`
    // periodically as a liveness heartbeat. A
    // separate sweeper (or the next-claimer's start path) treats
    // a stale `claimedAt` as evidence the prior process died and
    // re-claims the row. PR-A reserves the columns but does not
    // wire any runner logic.
    claimedBy: varchar("claimedBy", { length: 128 }),
    claimedAt: timestamp("claimedAt"),
    // Runner version marker — every status snapshot includes the
    // version that wrote the row, mirroring `_runnerVersion` on
    // every dashboard tRPC response. Lets a deploy recognize
    // stale-shape rows (e.g. `input` JSON written by a prior
    // runner version that the new code can't decode).
    runnerVersion: varchar("runnerVersion", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    // Active-job lookup: "what's queued or running for this scope?"
    // — bounds the worker's claim search.
    scopeStatusCreatedIdx: index(
      "dashboard_csv_export_jobs_scope_status_created_idx"
    ).on(table.scopeId, table.status, table.createdAt),
    // TTL prune: "what's terminal AND older than X?" — supports
    // the periodic cleanup sweep that retires the in-memory
    // `pruneExpired` helper.
    completedAtIdx: index(
      "dashboard_csv_export_jobs_completed_at_idx"
    ).on(table.completedAt),
    // Stale-claim detection: "what's running with a claim older
    // than the heartbeat threshold?" — supports the cross-process
    // re-claim path. Status comes first so the index can satisfy
    // a `WHERE status = 'running' AND claimedAt < ?` predicate
    // efficiently.
    statusClaimedAtIdx: index(
      "dashboard_csv_export_jobs_status_claimed_at_idx"
    ).on(table.status, table.claimedAt),
  })
);

export type DashboardCsvExportJob =
  typeof dashboardCsvExportJobs.$inferSelect;
export type InsertDashboardCsvExportJob =
  typeof dashboardCsvExportJobs.$inferInsert;
