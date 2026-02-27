CREATE TABLE `dailyHealthMetrics` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`whoopRecoveryScore` double,
	`whoopDayStrain` double,
	`whoopSleepHours` double,
	`whoopHrvMs` double,
	`whoopRestingHr` double,
	`samsungSteps` int,
	`samsungSleepHours` double,
	`samsungSpo2AvgPercent` double,
	`samsungSleepScore` double,
	`samsungEnergyScore` double,
	`todoistCompletedCount` int,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyHealthMetrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `daily_health_metrics_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `habitCompletions` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`habitId` varchar(64) NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`completed` boolean NOT NULL DEFAULT true,
	`completedAt` timestamp DEFAULT (now()),
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `habitCompletions_id` PRIMARY KEY(`id`),
	CONSTRAINT `habit_completions_user_habit_date_idx` UNIQUE(`userId`,`habitId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `habitDefinitions` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`color` varchar(32) NOT NULL DEFAULT 'slate',
	`sortOrder` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `habitDefinitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `habit_definitions_user_name_idx` UNIQUE(`userId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `supplementLogs` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`dose` varchar(64) NOT NULL,
	`notes` text,
	`dateKey` varchar(10) NOT NULL,
	`takenAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supplementLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `daily_health_metrics_user_idx` ON `dailyHealthMetrics` (`userId`);--> statement-breakpoint
CREATE INDEX `habit_completions_user_date_idx` ON `habitCompletions` (`userId`,`dateKey`);--> statement-breakpoint
CREATE INDEX `habit_definitions_user_idx` ON `habitDefinitions` (`userId`);--> statement-breakpoint
CREATE INDEX `supplement_logs_user_date_idx` ON `supplementLogs` (`userId`,`dateKey`);--> statement-breakpoint
CREATE INDEX `supplement_logs_user_taken_idx` ON `supplementLogs` (`userId`,`takenAt`);