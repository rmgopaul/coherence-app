-- Task 1.2b (PR A): per-scope cloud storage migration — schema prep.
--
-- Adds a nullable `scopeId` column + new unique/secondary indexes on
-- both `solarRecDashboardStorage` and `solarRecDatasetSyncState`.
-- Existing rows are backfilled to `scope-user-${userId}` to match the
-- string literal returned by `resolveSolarRecScopeId()` on the server.
-- Old per-user unique indexes are retained so existing code keeps
-- working; PR B rewrites the procedures to resolve reads/writes by
-- scope, and drops the legacy indexes once the cutover is verified.

ALTER TABLE `solarRecDashboardStorage` ADD `scopeId` varchar(64);--> statement-breakpoint
ALTER TABLE `solarRecDatasetSyncState` ADD `scopeId` varchar(64);--> statement-breakpoint
UPDATE `solarRecDashboardStorage` SET `scopeId` = CONCAT('scope-user-', `userId`) WHERE `scopeId` IS NULL;--> statement-breakpoint
UPDATE `solarRecDatasetSyncState` SET `scopeId` = CONCAT('scope-user-', `userId`) WHERE `scopeId` IS NULL;--> statement-breakpoint
ALTER TABLE `solarRecDashboardStorage` ADD CONSTRAINT `solar_rec_dashboard_storage_scope_key_chunk_idx` UNIQUE(`scopeId`,`storageKey`,`chunkIndex`);--> statement-breakpoint
ALTER TABLE `solarRecDatasetSyncState` ADD CONSTRAINT `solar_rec_dataset_sync_state_scope_key_idx` UNIQUE(`scopeId`,`storageKey`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_storage_scope_key_idx` ON `solarRecDashboardStorage` (`scopeId`,`storageKey`);--> statement-breakpoint
CREATE INDEX `solar_rec_dataset_sync_state_scope_updated_idx` ON `solarRecDatasetSyncState` (`scopeId`,`updatedAt`);
