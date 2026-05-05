CREATE TABLE `teslaPowerhubProductionJobs` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`createdBy` int,
	`config` json NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`progressJson` json,
	`resultJson` mediumtext,
	`errorMessage` text,
	`claimedBy` varchar(128),
	`claimedAt` timestamp,
	`runnerVersion` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`finishedAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teslaPowerhubProductionJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `tesla_powerhub_production_jobs_scope_status_created_idx` ON `teslaPowerhubProductionJobs` (`scopeId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tesla_powerhub_production_jobs_finished_at_idx` ON `teslaPowerhubProductionJobs` (`finishedAt`);--> statement-breakpoint
CREATE INDEX `tesla_powerhub_production_jobs_status_claimed_at_idx` ON `teslaPowerhubProductionJobs` (`status`,`claimedAt`);