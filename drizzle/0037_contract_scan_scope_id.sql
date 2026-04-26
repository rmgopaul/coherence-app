-- Task 5.7 PR-A (2026-04-26): add scopeId tenancy key to the 3
-- contractScan* tables (jobs / job CSG ids / results).
--
-- Same 5-step pattern as 0036_schedule_b_scope_id (Task 5.6 PR-B):
-- 1. ADD COLUMN with empty-string default so existing rows pass the
--    NOT NULL constraint during ALTER.
-- 2. Backfill jobs.scopeId via `scope-user-${userId}` (same formula
--    `resolveSolarRecScopeId()` returns at runtime).
-- 3. Propagate to the 2 child tables (jobCsgIds + results) via
--    UPDATE…JOIN through jobId.
-- 4. ALTER drop default — new rows MUST set scopeId explicitly via
--    the DB helpers.
-- 5. CREATE INDEX scopeIdx on each of the 3 tables.
--
-- Apply on prod via `./node_modules/.bin/drizzle-kit migrate` BEFORE
-- merging the code PR (CLAUDE.md "Schema migration safety").

ALTER TABLE `contractScanJobs` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `contractScanJobCsgIds` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `contractScanResults` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint

-- Backfill jobs.scopeId from existing userId.
UPDATE `contractScanJobs`
   SET `scopeId` = CONCAT('scope-user-', `userId`)
 WHERE `scopeId` = '';--> statement-breakpoint

-- Propagate to the 2 child tables via the parent job. Orphaned child
-- rows (no parent job) are skipped — they were already invisible to
-- the runtime which always filters by jobId.
UPDATE `contractScanJobCsgIds` `c`
  JOIN `contractScanJobs` `j` ON `j`.`id` = `c`.`jobId`
   SET `c`.`scopeId` = `j`.`scopeId`
 WHERE `c`.`scopeId` = '';--> statement-breakpoint

UPDATE `contractScanResults` `r`
  JOIN `contractScanJobs` `j` ON `j`.`id` = `r`.`jobId`
   SET `r`.`scopeId` = `j`.`scopeId`
 WHERE `r`.`scopeId` = '';--> statement-breakpoint

-- Drop the empty-string default — new rows set scopeId explicitly.
ALTER TABLE `contractScanJobs` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `contractScanJobCsgIds` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `contractScanResults` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint

-- Per-table scopeId index to support team-scoped reads.
CREATE INDEX `contract_scan_jobs_scope_idx` ON `contractScanJobs` (`scopeId`);--> statement-breakpoint
CREATE INDEX `contract_scan_job_csg_ids_scope_idx` ON `contractScanJobCsgIds` (`scopeId`);--> statement-breakpoint
CREATE INDEX `contract_scan_results_scope_idx` ON `contractScanResults` (`scopeId`);
