CREATE TABLE `userKingOfDay` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`source` enum('auto','manual','ai') NOT NULL,
	`title` varchar(200) NOT NULL,
	`reason` varchar(500),
	`taskId` varchar(128),
	`eventId` varchar(128),
	`pinnedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userKingOfDay_id` PRIMARY KEY(`id`),
	CONSTRAINT `userKingOfDay_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `habitCategories` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`color` varchar(32) NOT NULL DEFAULT 'slate',
	`sortOrder` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `habitCategories_id` PRIMARY KEY(`id`),
	CONSTRAINT `habit_categories_user_name_idx` UNIQUE(`userId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `sleepNotes` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`tags` varchar(500),
	`notes` text,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sleepNotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `sleep_notes_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `supplementExperiments` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`definitionId` varchar(64) NOT NULL,
	`hypothesis` text NOT NULL,
	`startDateKey` varchar(10) NOT NULL,
	`endDateKey` varchar(10),
	`status` enum('active','ended','abandoned') NOT NULL DEFAULT 'active',
	`primaryMetric` varchar(64),
	`notes` text,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supplementExperiments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supplementRestockEvents` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`definitionId` varchar(64) NOT NULL,
	`eventType` enum('purchased','opened','finished') NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`quantityDelta` double NOT NULL,
	`unitPrice` double,
	`sourceUrl` text,
	`notes` text,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supplementRestockEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dinScrapeDins` (
	`id` varchar(64) NOT NULL,
	`jobId` varchar(64) NOT NULL,
	`csgId` varchar(64) NOT NULL,
	`dinValue` varchar(128) NOT NULL,
	`sourceType` enum('inverter','meter','unknown') NOT NULL DEFAULT 'unknown',
	`sourceUrl` varchar(512),
	`sourceFileName` varchar(255),
	`extractedBy` enum('claude','tesseract','pdfjs') NOT NULL DEFAULT 'claude',
	`rawMatch` mediumtext,
	`foundAt` timestamp DEFAULT (now()),
	CONSTRAINT `dinScrapeDins_id` PRIMARY KEY(`id`),
	CONSTRAINT `din_scrape_dins_job_csg_din_idx` UNIQUE(`jobId`,`csgId`,`dinValue`)
);
--> statement-breakpoint
CREATE TABLE `dinScrapeJobCsgIds` (
	`id` varchar(64) NOT NULL,
	`jobId` varchar(64) NOT NULL,
	`csgId` varchar(64) NOT NULL,
	CONSTRAINT `dinScrapeJobCsgIds_id` PRIMARY KEY(`id`),
	CONSTRAINT `din_scrape_job_csg_ids_job_csg_idx` UNIQUE(`jobId`,`csgId`)
);
--> statement-breakpoint
CREATE TABLE `dinScrapeJobs` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`status` enum('queued','running','stopping','stopped','completed','failed') NOT NULL DEFAULT 'queued',
	`totalSites` int NOT NULL DEFAULT 0,
	`successCount` int NOT NULL DEFAULT 0,
	`failureCount` int NOT NULL DEFAULT 0,
	`currentCsgId` varchar(64),
	`error` text,
	`startedAt` timestamp,
	`stoppedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dinScrapeJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dinScrapeResults` (
	`id` varchar(64) NOT NULL,
	`jobId` varchar(64) NOT NULL,
	`csgId` varchar(64) NOT NULL,
	`systemPageUrl` varchar(512),
	`inverterPhotoCount` int NOT NULL DEFAULT 0,
	`meterPhotoCount` int NOT NULL DEFAULT 0,
	`dinCount` int NOT NULL DEFAULT 0,
	`error` text,
	`scannedAt` timestamp DEFAULT (now()),
	CONSTRAINT `dinScrapeResults_id` PRIMARY KEY(`id`),
	CONSTRAINT `din_scrape_results_job_csg_idx` UNIQUE(`jobId`,`csgId`)
);
--> statement-breakpoint
CREATE TABLE `solarRecDatasetSyncState` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`storageKey` varchar(191) NOT NULL,
	`payloadSha256` varchar(64) NOT NULL DEFAULT '',
	`payloadBytes` int NOT NULL DEFAULT 0,
	`dbPersisted` boolean NOT NULL DEFAULT false,
	`storageSynced` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecDatasetSyncState_id` PRIMARY KEY(`id`),
	CONSTRAINT `solar_rec_dataset_sync_state_user_key_idx` UNIQUE(`userId`,`storageKey`)
);
--> statement-breakpoint
CREATE TABLE `dockItems` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`source` enum('gmail','gcal','gsheet','todoist','url') NOT NULL,
	`url` text NOT NULL,
	`urlCanonical` varchar(512) NOT NULL,
	`title` varchar(500),
	`meta` text,
	`pinnedAt` timestamp,
	`x` int,
	`y` int,
	`tilt` smallint,
	`color` varchar(16),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dockItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `dock_items_user_url_unique` UNIQUE(`userId`,`urlCanonical`)
);
--> statement-breakpoint
ALTER TABLE `solarRecComputedArtifacts` DROP INDEX `sr_computed_artifacts_lookup_idx`;--> statement-breakpoint
ALTER TABLE `solarRecComputedArtifacts` MODIFY COLUMN `rowCount` int;--> statement-breakpoint
ALTER TABLE `solarRecComputedArtifacts` MODIFY COLUMN `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `solarRecDashboardStorage` MODIFY COLUMN `payload` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `habitDefinitions` ADD `categoryId` varchar(64);--> statement-breakpoint
ALTER TABLE `solarRecComputedArtifacts` ADD CONSTRAINT `sr_computed_artifacts_key_idx` UNIQUE(`scopeId`,`artifactType`,`inputVersionHash`);--> statement-breakpoint
CREATE INDEX `habit_categories_user_idx` ON `habitCategories` (`userId`);--> statement-breakpoint
CREATE INDEX `sleep_notes_user_idx` ON `sleepNotes` (`userId`);--> statement-breakpoint
CREATE INDEX `supplement_experiments_user_idx` ON `supplementExperiments` (`userId`);--> statement-breakpoint
CREATE INDEX `supplement_experiments_user_status_idx` ON `supplementExperiments` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `supplement_restock_events_user_idx` ON `supplementRestockEvents` (`userId`);--> statement-breakpoint
CREATE INDEX `supplement_restock_events_user_definition_idx` ON `supplementRestockEvents` (`userId`,`definitionId`);--> statement-breakpoint
CREATE INDEX `supplement_restock_events_user_occurred_idx` ON `supplementRestockEvents` (`userId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `din_scrape_dins_job_idx` ON `dinScrapeDins` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_dins_csg_idx` ON `dinScrapeDins` (`csgId`);--> statement-breakpoint
CREATE INDEX `din_scrape_job_csg_ids_job_idx` ON `dinScrapeJobCsgIds` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_jobs_user_idx` ON `dinScrapeJobs` (`userId`);--> statement-breakpoint
CREATE INDEX `din_scrape_jobs_status_idx` ON `dinScrapeJobs` (`status`);--> statement-breakpoint
CREATE INDEX `din_scrape_results_job_idx` ON `dinScrapeResults` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_results_csg_idx` ON `dinScrapeResults` (`csgId`);--> statement-breakpoint
CREATE INDEX `solar_rec_dataset_sync_state_user_updated_idx` ON `solarRecDatasetSyncState` (`userId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `dock_items_user_created_idx` ON `dockItems` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `habit_definitions_user_category_idx` ON `habitDefinitions` (`userId`,`categoryId`);--> statement-breakpoint
CREATE INDEX `sr_computed_artifacts_scope_type_updated_idx` ON `solarRecComputedArtifacts` (`scopeId`,`artifactType`,`updatedAt`);