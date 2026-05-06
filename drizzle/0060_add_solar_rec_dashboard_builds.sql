CREATE TABLE `solarRecDashboardBuilds` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`createdBy` int,
	`inputVersionsJson` json NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`progressJson` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`errorMessage` text,
	`claimedBy` varchar(128),
	`claimedAt` timestamp,
	`runnerVersion` varchar(64) NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecDashboardBuilds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_builds_scope_status_created_idx` ON `solarRecDashboardBuilds` (`scopeId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_builds_completed_at_idx` ON `solarRecDashboardBuilds` (`completedAt`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_builds_status_claimed_at_idx` ON `solarRecDashboardBuilds` (`status`,`claimedAt`);