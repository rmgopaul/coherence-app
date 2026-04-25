-- Task 5.3 — scope monitoringApiRuns and monitoringBatchRuns to
-- solar-rec tenants. All existing rows are backfilled to
-- `scope-user-1` (Rhett's scope) before the column is made NOT NULL.
-- The previous (provider, connectionId, siteId, dateKey) unique index
-- on monitoringApiRuns is replaced by a scope-aware one so two scopes
-- can each own rows for the same external site without colliding.

ALTER TABLE `monitoringApiRuns` DROP INDEX `monitoring_api_runs_provider_conn_site_date_idx`;--> statement-breakpoint

-- Step 1: add the column as nullable so the backfill can populate it.
ALTER TABLE `monitoringApiRuns` ADD `scopeId` varchar(64);--> statement-breakpoint
ALTER TABLE `monitoringBatchRuns` ADD `scopeId` varchar(64);--> statement-breakpoint

-- Step 2: backfill existing rows to Rhett's scope. New scopes will get
-- their own rows going forward; these historical rows predate multi-
-- scope tenancy so they all belong to scope-user-1.
UPDATE `monitoringApiRuns` SET `scopeId` = 'scope-user-1' WHERE `scopeId` IS NULL;--> statement-breakpoint
UPDATE `monitoringBatchRuns` SET `scopeId` = 'scope-user-1' WHERE `scopeId` IS NULL;--> statement-breakpoint

-- Step 3: tighten to NOT NULL now that every row has a value.
ALTER TABLE `monitoringApiRuns` MODIFY `scopeId` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `monitoringBatchRuns` MODIFY `scopeId` varchar(64) NOT NULL;--> statement-breakpoint

-- Step 4: scope-aware indexes.
ALTER TABLE `monitoringApiRuns` ADD CONSTRAINT `monitoring_api_runs_scope_provider_conn_site_date_idx` UNIQUE(`scopeId`,`provider`,`connectionId`,`siteId`,`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_api_runs_scope_date_idx` ON `monitoringApiRuns` (`scopeId`,`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_batch_runs_scope_date_idx` ON `monitoringBatchRuns` (`scopeId`,`dateKey`);
