-- Task 5.8 PR-A (2026-04-27): add scopeId tenancy key to the 4
-- dinScrape* tables (jobs / jobCsgIds / results / dins).
--
-- Same 5-step pattern as 0036_schedule_b_scope_id (Task 5.6 PR-B)
-- and 0037_contract_scan_scope_id (Task 5.7 PR-A):
-- 1. ADD COLUMN with empty-string default so existing rows pass the
--    NOT NULL constraint during ALTER.
-- 2. Backfill jobs.scopeId via `scope-user-${userId}`.
-- 3. Propagate to the 3 child tables via UPDATE…JOIN through jobId.
-- 4. ALTER drop default — new rows MUST set scopeId explicitly.
-- 5. CREATE INDEX scopeIdx on each of the 4 tables.
--
-- Apply on prod via `./node_modules/.bin/drizzle-kit migrate` BEFORE
-- merging the code PR (CLAUDE.md "Schema migration safety").

ALTER TABLE `dinScrapeJobs` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `dinScrapeJobCsgIds` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `dinScrapeResults` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `dinScrapeDins` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint

-- Backfill jobs.scopeId from existing userId (matches runtime
-- resolveSolarRecScopeId() formula: `scope-user-${ownerUserId}`).
UPDATE `dinScrapeJobs`
   SET `scopeId` = CONCAT('scope-user-', `userId`)
 WHERE `scopeId` = '';--> statement-breakpoint

-- Propagate to the 3 child tables via the parent job. Orphaned child
-- rows (no parent job) are skipped — they were already invisible to
-- the runtime which always filters by jobId.
UPDATE `dinScrapeJobCsgIds` `c`
  JOIN `dinScrapeJobs` `j` ON `j`.`id` = `c`.`jobId`
   SET `c`.`scopeId` = `j`.`scopeId`
 WHERE `c`.`scopeId` = '';--> statement-breakpoint

UPDATE `dinScrapeResults` `r`
  JOIN `dinScrapeJobs` `j` ON `j`.`id` = `r`.`jobId`
   SET `r`.`scopeId` = `j`.`scopeId`
 WHERE `r`.`scopeId` = '';--> statement-breakpoint

UPDATE `dinScrapeDins` `d`
  JOIN `dinScrapeJobs` `j` ON `j`.`id` = `d`.`jobId`
   SET `d`.`scopeId` = `j`.`scopeId`
 WHERE `d`.`scopeId` = '';--> statement-breakpoint

-- Drop the empty-string default — new rows set scopeId explicitly.
ALTER TABLE `dinScrapeJobs` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `dinScrapeJobCsgIds` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `dinScrapeResults` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `dinScrapeDins` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint

-- Per-table scopeId index to support team-scoped reads.
CREATE INDEX `din_scrape_jobs_scope_idx` ON `dinScrapeJobs` (`scopeId`);--> statement-breakpoint
CREATE INDEX `din_scrape_job_csg_ids_scope_idx` ON `dinScrapeJobCsgIds` (`scopeId`);--> statement-breakpoint
CREATE INDEX `din_scrape_results_scope_idx` ON `dinScrapeResults` (`scopeId`);--> statement-breakpoint
CREATE INDEX `din_scrape_dins_scope_idx` ON `dinScrapeDins` (`scopeId`);
