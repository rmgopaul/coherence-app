-- Solar REC Server-Side Architecture — Foundational Tables
-- Step 1 of server-side migration: versioned ingestion + compute tracking

CREATE TABLE IF NOT EXISTS `solarRecScopes` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `name` varchar(255),
  `ownerUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE TABLE IF NOT EXISTS `solarRecImportBatches` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `datasetKey` varchar(64) NOT NULL,
  `ingestSource` varchar(16) NOT NULL,
  `mergeStrategy` varchar(16) NOT NULL,
  `status` varchar(16) NOT NULL,
  `rowCount` int,
  `error` text,
  `importedBy` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `completedAt` timestamp
);

CREATE INDEX `sr_import_batches_scope_ds_status_idx` ON `solarRecImportBatches` (`scopeId`, `datasetKey`, `status`);

CREATE TABLE IF NOT EXISTS `solarRecImportFiles` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `fileName` varchar(255) NOT NULL,
  `storageKey` varchar(512),
  `sizeBytes` int,
  `rowCount` int,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_import_files_batch_idx` ON `solarRecImportFiles` (`batchId`);

CREATE TABLE IF NOT EXISTS `solarRecImportErrors` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `rowIndex` int,
  `columnName` varchar(128),
  `errorType` varchar(64),
  `message` text,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_import_errors_batch_idx` ON `solarRecImportErrors` (`batchId`);

CREATE TABLE IF NOT EXISTS `solarRecActiveDatasetVersions` (
  `scopeId` varchar(64) NOT NULL,
  `datasetKey` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `activatedAt` timestamp NOT NULL DEFAULT (now())
);

CREATE UNIQUE INDEX `sr_active_versions_pk` ON `solarRecActiveDatasetVersions` (`scopeId`, `datasetKey`);

CREATE TABLE IF NOT EXISTS `solarRecComputeRuns` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `artifactType` varchar(64) NOT NULL,
  `inputVersionHash` varchar(64) NOT NULL,
  `status` varchar(16) NOT NULL,
  `rowCount` int,
  `error` text,
  `startedAt` timestamp NOT NULL DEFAULT (now()),
  `completedAt` timestamp
);

CREATE UNIQUE INDEX `sr_compute_runs_claim_idx` ON `solarRecComputeRuns` (`scopeId`, `artifactType`, `inputVersionHash`);
CREATE INDEX `sr_compute_runs_scope_artifact_status_idx` ON `solarRecComputeRuns` (`scopeId`, `artifactType`, `status`);
