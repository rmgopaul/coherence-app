-- Phase 4 supplements tables: intentional A/B experiments + inventory events.
-- Feeds the restock predictor and the experiment start/end + report flow.
-- No backfill; both tables start empty.

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
CREATE INDEX `supplement_experiments_user_idx` ON `supplementExperiments` (`userId`);
--> statement-breakpoint
CREATE INDEX `supplement_experiments_user_status_idx` ON `supplementExperiments` (`userId`,`status`);
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
CREATE INDEX `supplement_restock_events_user_idx` ON `supplementRestockEvents` (`userId`);
--> statement-breakpoint
CREATE INDEX `supplement_restock_events_user_definition_idx` ON `supplementRestockEvents` (`userId`,`definitionId`);
--> statement-breakpoint
CREATE INDEX `supplement_restock_events_user_occurred_idx` ON `supplementRestockEvents` (`userId`,`occurredAt`);
