CREATE TABLE `dashboardCsvExportJobs` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`input` json NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`fileName` varchar(500),
	`artifactUrl` text,
	`rowCount` int,
	`csvBytes` int,
	`errorMessage` text,
	`claimedBy` varchar(128),
	`claimedAt` timestamp,
	`runnerVersion` varchar(64) NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dashboardCsvExportJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dashboard_csv_export_jobs_scope_status_created_idx` ON `dashboardCsvExportJobs` (`scopeId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `dashboard_csv_export_jobs_completed_at_idx` ON `dashboardCsvExportJobs` (`completedAt`);--> statement-breakpoint
CREATE INDEX `dashboard_csv_export_jobs_status_claimed_at_idx` ON `dashboardCsvExportJobs` (`status`,`claimedAt`);