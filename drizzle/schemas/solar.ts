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
    csgId: varchar("csgId", { length: 64 }).notNull(),
  },
  (table) => ({
    jobCsgIdx: uniqueIndex("din_scrape_job_csg_ids_job_csg_idx").on(
      table.jobId,
      table.csgId
    ),
    jobIdx: index("din_scrape_job_csg_ids_job_idx").on(table.jobId),
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
    csgId: varchar("csgId", { length: 64 }).notNull(),
    systemPageUrl: varchar("systemPageUrl", { length: 512 }),
    inverterPhotoCount: int("inverterPhotoCount").default(0).notNull(),
    meterPhotoCount: int("meterPhotoCount").default(0).notNull(),
    dinCount: int("dinCount").default(0).notNull(),
    /**
     * Tesla System Tesla Energy ID (e.g. "STE20230612-00205") if
     * visible in any Powerhub-app screenshot OCR'd for this site.
     * Site-scoped (one per system), so a single column rather than
     * a one-to-many like dinScrapeDins.
     */
    steId: varchar("steId", { length: 64 }),
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
  })
);

export type DinScrapeDin = typeof dinScrapeDins.$inferSelect;
export type InsertDinScrapeDin = typeof dinScrapeDins.$inferInsert;
