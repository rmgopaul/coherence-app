-- Solar REC Normalized Dataset Tables (Step 3)
-- 7 core dataset tables with typed columns + rawRow JSON for the long tail.

CREATE TABLE IF NOT EXISTS `srDsSolarApplications` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `applicationId` varchar(64),
  `systemId` varchar(64),
  `trackingSystemRefId` varchar(64),
  `stateCertificationNumber` varchar(64),
  `systemName` varchar(255),
  `installedKwAc` double,
  `installedKwDc` double,
  `recPrice` double,
  `totalContractAmount` double,
  `annualRecs` double,
  `contractType` varchar(128),
  `installerName` varchar(255),
  `county` varchar(128),
  `state` varchar(64),
  `zipCode` varchar(16),
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_solar_apps_batch_idx` ON `srDsSolarApplications` (`batchId`);
CREATE INDEX `sr_ds_solar_apps_scope_tracking_idx` ON `srDsSolarApplications` (`scopeId`, `trackingSystemRefId`);
CREATE INDEX `sr_ds_solar_apps_scope_appid_idx` ON `srDsSolarApplications` (`scopeId`, `applicationId`);

CREATE TABLE IF NOT EXISTS `srDsAbpReport` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `applicationId` varchar(64),
  `systemId` varchar(64),
  `trackingSystemRefId` varchar(64),
  `projectName` varchar(255),
  `part2AppVerificationDate` varchar(32),
  `inverterSizeKwAc` double,
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_abp_report_batch_idx` ON `srDsAbpReport` (`batchId`);
CREATE INDEX `sr_ds_abp_report_scope_appid_idx` ON `srDsAbpReport` (`scopeId`, `applicationId`);

CREATE TABLE IF NOT EXISTS `srDsGenerationEntry` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `unitId` varchar(64),
  `facilityName` varchar(255),
  `lastMonthOfGen` varchar(32),
  `effectiveDate` varchar(32),
  `onlineMonitoring` varchar(255),
  `onlineMonitoringAccessType` varchar(64),
  `onlineMonitoringSystemId` varchar(255),
  `onlineMonitoringSystemName` varchar(255),
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_gen_entry_batch_idx` ON `srDsGenerationEntry` (`batchId`);
CREATE INDEX `sr_ds_gen_entry_scope_unit_idx` ON `srDsGenerationEntry` (`scopeId`, `unitId`);

CREATE TABLE IF NOT EXISTS `srDsAccountSolarGeneration` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `gatsGenId` varchar(64),
  `facilityName` varchar(255),
  `monthOfGeneration` varchar(32),
  `lastMeterReadDate` varchar(32),
  `lastMeterReadKwh` varchar(64),
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_acct_solar_gen_batch_idx` ON `srDsAccountSolarGeneration` (`batchId`);
CREATE INDEX `sr_ds_acct_solar_gen_scope_gats_idx` ON `srDsAccountSolarGeneration` (`scopeId`, `gatsGenId`);

CREATE TABLE IF NOT EXISTS `srDsContractedDate` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `systemId` varchar(64),
  `contractedDate` varchar(32),
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_contracted_date_batch_idx` ON `srDsContractedDate` (`batchId`);
CREATE INDEX `sr_ds_contracted_date_scope_system_idx` ON `srDsContractedDate` (`scopeId`, `systemId`);

CREATE TABLE IF NOT EXISTS `srDsDeliverySchedule` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `trackingSystemRefId` varchar(64),
  `systemName` varchar(255),
  `utilityContractNumber` varchar(64),
  `batchIdRef` varchar(64),
  `stateCertificationNumber` varchar(64),
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_delivery_schedule_batch_idx` ON `srDsDeliverySchedule` (`batchId`);
CREATE INDEX `sr_ds_delivery_schedule_scope_tracking_idx` ON `srDsDeliverySchedule` (`scopeId`, `trackingSystemRefId`);

CREATE TABLE IF NOT EXISTS `srDsTransferHistory` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `batchId` varchar(64) NOT NULL,
  `transactionId` varchar(64),
  `unitId` varchar(64),
  `transferCompletionDate` varchar(32),
  `quantity` double,
  `transferor` varchar(255),
  `transferee` varchar(255),
  `rawRow` mediumtext,
  `createdAt` timestamp NOT NULL DEFAULT (now())
);

CREATE INDEX `sr_ds_transfer_history_batch_idx` ON `srDsTransferHistory` (`batchId`);
CREATE INDEX `sr_ds_transfer_history_scope_unit_idx` ON `srDsTransferHistory` (`scopeId`, `unitId`);
