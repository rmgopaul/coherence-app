CREATE TABLE `monitoringApiRuns` (
	`id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`connectionId` varchar(64),
	`siteId` varchar(128) NOT NULL,
	`siteName` varchar(255),
	`dateKey` varchar(10) NOT NULL,
	`status` enum('success','error','no_data','skipped') NOT NULL,
	`readingsCount` int NOT NULL DEFAULT 0,
	`lifetimeKwh` double,
	`errorMessage` text,
	`durationMs` int,
	`triggeredBy` int,
	`triggeredAt` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `monitoringApiRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `monitoring_api_runs_provider_site_date_idx` UNIQUE(`provider`,`siteId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `monitoringBatchRuns` (
	`id` varchar(64) NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`totalSites` int NOT NULL DEFAULT 0,
	`successCount` int NOT NULL DEFAULT 0,
	`errorCount` int NOT NULL DEFAULT 0,
	`noDataCount` int NOT NULL DEFAULT 0,
	`triggeredBy` int,
	`startedAt` timestamp DEFAULT (now()),
	`completedAt` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `monitoringBatchRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `solarRecInvites` (
	`id` varchar(64) NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('admin','operator','viewer') NOT NULL DEFAULT 'operator',
	`tokenHash` varchar(128) NOT NULL,
	`createdBy` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `solarRecInvites_id` PRIMARY KEY(`id`),
	CONSTRAINT `solarRecInvites_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `solarRecTeamCredentials` (
	`id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`connectionName` varchar(128),
	`accessToken` text,
	`refreshToken` text,
	`expiresAt` timestamp,
	`metadata` mediumtext,
	`createdBy` int NOT NULL,
	`updatedBy` int,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecTeamCredentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `solarRecUsers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` varchar(255),
	`googleOpenId` varchar(64),
	`avatarUrl` varchar(512),
	`role` enum('owner','admin','operator','viewer') NOT NULL DEFAULT 'operator',
	`isActive` boolean NOT NULL DEFAULT true,
	`invitedBy` int,
	`lastSignedIn` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecUsers_id` PRIMARY KEY(`id`),
	CONSTRAINT `solarRecUsers_email_unique` UNIQUE(`email`),
	CONSTRAINT `solarRecUsers_googleOpenId_unique` UNIQUE(`googleOpenId`)
);
--> statement-breakpoint
CREATE INDEX `monitoring_api_runs_date_key_idx` ON `monitoringApiRuns` (`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_api_runs_provider_date_idx` ON `monitoringApiRuns` (`provider`,`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_api_runs_status_date_idx` ON `monitoringApiRuns` (`status`,`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_batch_runs_date_key_idx` ON `monitoringBatchRuns` (`dateKey`);--> statement-breakpoint
CREATE INDEX `monitoring_batch_runs_status_idx` ON `monitoringBatchRuns` (`status`);--> statement-breakpoint
CREATE INDEX `solar_rec_invites_email_idx` ON `solarRecInvites` (`email`);--> statement-breakpoint
CREATE INDEX `solar_rec_team_credentials_provider_idx` ON `solarRecTeamCredentials` (`provider`);--> statement-breakpoint
CREATE INDEX `solar_rec_users_email_idx` ON `solarRecUsers` (`email`);--> statement-breakpoint
CREATE INDEX `solar_rec_users_google_open_id_idx` ON `solarRecUsers` (`googleOpenId`);