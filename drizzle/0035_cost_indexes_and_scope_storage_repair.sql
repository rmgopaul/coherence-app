-- Cost repair migration.
--
-- 1. Re-applies the scope-storage backfill/indexes idempotently because
--    production was observed with scopeId present but NULL rows and missing
--    scope indexes.
-- 2. Adds query-shape indexes for monitoring views and Solar REC active
--    batch reads. These prevent TiDB from scanning high-cardinality tables
--    for normal dashboard/cache paths.

ALTER TABLE `solarRecDashboardStorage`
  ADD COLUMN IF NOT EXISTS `scopeId` varchar(64) NULL AFTER `userId`;--> statement-breakpoint
ALTER TABLE `solarRecDatasetSyncState`
  ADD COLUMN IF NOT EXISTS `scopeId` varchar(64) NULL AFTER `userId`;--> statement-breakpoint
UPDATE `solarRecDashboardStorage`
  SET `scopeId` = CONCAT('scope-user-', `userId`)
  WHERE `scopeId` IS NULL;--> statement-breakpoint
UPDATE `solarRecDatasetSyncState`
  SET `scopeId` = CONCAT('scope-user-', `userId`)
  WHERE `scopeId` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `solar_rec_dashboard_storage_scope_key_chunk_idx`
  ON `solarRecDashboardStorage` (`scopeId`,`storageKey`,`chunkIndex`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `solar_rec_dashboard_storage_scope_key_idx`
  ON `solarRecDashboardStorage` (`scopeId`,`storageKey`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `solar_rec_dataset_sync_state_scope_key_idx`
  ON `solarRecDatasetSyncState` (`scopeId`,`storageKey`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `solar_rec_dataset_sync_state_scope_updated_idx`
  ON `solarRecDatasetSyncState` (`scopeId`,`updatedAt`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `monitoring_api_runs_scope_provider_site_date_idx`
  ON `monitoringApiRuns` (`scopeId`,`provider`,`siteId`,`dateKey`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `monitoring_api_runs_scope_date_provider_status_idx`
  ON `monitoringApiRuns` (`scopeId`,`dateKey`,`provider`,`status`,`siteId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_abp_report_scope_batch_idx`
  ON `srDsAbpReport` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_acct_solar_gen_scope_batch_idx`
  ON `srDsAccountSolarGeneration` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_contracted_date_scope_batch_idx`
  ON `srDsContractedDate` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_delivery_schedule_scope_batch_idx`
  ON `srDsDeliverySchedule` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_gen_entry_scope_batch_idx`
  ON `srDsGenerationEntry` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_solar_apps_scope_batch_idx`
  ON `srDsSolarApplications` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sr_ds_transfer_history_scope_batch_idx`
  ON `srDsTransferHistory` (`scopeId`,`batchId`);--> statement-breakpoint

ANALYZE TABLE `monitoringApiRuns`;--> statement-breakpoint
ANALYZE TABLE `solarRecDashboardStorage`;--> statement-breakpoint
ANALYZE TABLE `srDsAccountSolarGeneration`;--> statement-breakpoint
ANALYZE TABLE `srDsTransferHistory`;
