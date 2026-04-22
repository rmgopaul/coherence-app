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
CREATE INDEX `din_scrape_dins_job_idx` ON `dinScrapeDins` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_dins_csg_idx` ON `dinScrapeDins` (`csgId`);--> statement-breakpoint
CREATE INDEX `din_scrape_job_csg_ids_job_idx` ON `dinScrapeJobCsgIds` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_jobs_user_idx` ON `dinScrapeJobs` (`userId`);--> statement-breakpoint
CREATE INDEX `din_scrape_jobs_status_idx` ON `dinScrapeJobs` (`status`);--> statement-breakpoint
CREATE INDEX `din_scrape_results_job_idx` ON `dinScrapeResults` (`jobId`);--> statement-breakpoint
CREATE INDEX `din_scrape_results_csg_idx` ON `dinScrapeResults` (`csgId`);