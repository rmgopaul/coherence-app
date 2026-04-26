-- Task 5.6 PR-B (2026-04-26): add scopeId tenancy key to the 4
-- scheduleBImport* tables.
--
-- Strategy:
-- 1. ADD COLUMN with empty-string default so existing rows pass the
--    NOT NULL constraint. The default is a transient placeholder —
--    immediately overwritten by the backfill UPDATE statements.
-- 2. Backfill scopeId on jobs first (derived from existing userId via
--    `scope-user-${userId}` — same formula `resolveSolarRecScopeId()`
--    uses at runtime). Then propagate to the 3 child tables via
--    UPDATE…JOIN through jobId.
-- 3. ALTER drop default once backfill completes — new rows MUST set
--    scopeId explicitly via the DB helpers.
-- 4. CREATE the four scopeIdx indexes.
--
-- Apply on prod via `./node_modules/.bin/drizzle-kit migrate` BEFORE
-- merging the code PR (CLAUDE.md "Schema migration safety").
--
-- NOTE: drizzle-kit generate also detected drift on
-- monitoringApiRuns + 7 srDs* tables (their scope indexes are in the
-- schema but seemingly never materialized in prod). Those CREATE
-- INDEX statements were generated alongside this migration and have
-- been removed — they belong with whatever migration originally
-- declared them. Including them here would conflate two unrelated
-- changes.

ALTER TABLE `scheduleBImportJobs` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `scheduleBImportFiles` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `scheduleBImportResults` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `scheduleBImportCsgIds` ADD `scopeId` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint

-- Backfill jobs.scopeId from existing userId. The runtime
-- resolveSolarRecScopeId() returns `scope-user-${ownerUserId}` and
-- pre-PR-B all jobs are owned by whoever ran the import — single-
-- tenant model. Concatenating the existing userId column gives every
-- row the same scope key the runtime would compute today.
UPDATE `scheduleBImportJobs`
   SET `scopeId` = CONCAT('scope-user-', `userId`)
 WHERE `scopeId` = '';--> statement-breakpoint

-- Propagate scopeId to the 3 child tables via the parent job. Each
-- child table joins `scheduleBImportJobs ON jobId = id` and copies
-- the parent's scopeId. Rows with no parent job (orphans) are
-- skipped — they would already have been ignored by the runtime
-- because every read filters by jobId.
UPDATE `scheduleBImportFiles` `f`
  JOIN `scheduleBImportJobs` `j` ON `j`.`id` = `f`.`jobId`
   SET `f`.`scopeId` = `j`.`scopeId`
 WHERE `f`.`scopeId` = '';--> statement-breakpoint

UPDATE `scheduleBImportResults` `r`
  JOIN `scheduleBImportJobs` `j` ON `j`.`id` = `r`.`jobId`
   SET `r`.`scopeId` = `j`.`scopeId`
 WHERE `r`.`scopeId` = '';--> statement-breakpoint

UPDATE `scheduleBImportCsgIds` `c`
  JOIN `scheduleBImportJobs` `j` ON `j`.`id` = `c`.`jobId`
   SET `c`.`scopeId` = `j`.`scopeId`
 WHERE `c`.`scopeId` = '';--> statement-breakpoint

-- Drop the empty-string default — new rows set scopeId explicitly
-- through the DB helpers (every insert call site updated in this PR).
ALTER TABLE `scheduleBImportJobs` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `scheduleBImportFiles` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `scheduleBImportResults` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint
ALTER TABLE `scheduleBImportCsgIds` ALTER COLUMN `scopeId` DROP DEFAULT;--> statement-breakpoint

-- Per-table scopeId index to support team-scoped reads.
CREATE INDEX `schedule_b_import_jobs_scope_idx` ON `scheduleBImportJobs` (`scopeId`);--> statement-breakpoint
CREATE INDEX `schedule_b_import_files_scope_idx` ON `scheduleBImportFiles` (`scopeId`);--> statement-breakpoint
CREATE INDEX `schedule_b_import_results_scope_idx` ON `scheduleBImportResults` (`scopeId`);--> statement-breakpoint
CREATE INDEX `schedule_b_csg_ids_scope_idx` ON `scheduleBImportCsgIds` (`scopeId`);
