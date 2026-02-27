CREATE TABLE `supplementDefinitions` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`dose` varchar(64) NOT NULL,
	`doseUnit` varchar(24) NOT NULL DEFAULT 'capsule',
	`timing` varchar(8) NOT NULL DEFAULT 'am',
	`isLocked` boolean NOT NULL DEFAULT false,
	`isActive` boolean NOT NULL DEFAULT true,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supplementDefinitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `supplement_definitions_user_name_idx` UNIQUE(`userId`,`name`)
);
--> statement-breakpoint
ALTER TABLE `supplementLogs` ADD `definitionId` varchar(64);--> statement-breakpoint
ALTER TABLE `supplementLogs` ADD `doseUnit` varchar(24) DEFAULT 'capsule' NOT NULL;--> statement-breakpoint
ALTER TABLE `supplementLogs` ADD `timing` varchar(8) DEFAULT 'am' NOT NULL;--> statement-breakpoint
ALTER TABLE `supplementLogs` ADD `autoLogged` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `supplementLogs` ADD CONSTRAINT `supplement_logs_user_date_definition_idx` UNIQUE(`userId`,`dateKey`,`definitionId`);--> statement-breakpoint
CREATE INDEX `supplement_definitions_user_idx` ON `supplementDefinitions` (`userId`);