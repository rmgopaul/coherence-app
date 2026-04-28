CREATE TABLE `dailyReflections` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`energyLevel` int,
	`wentWell` text,
	`didntGo` text,
	`tomorrowOneThing` text,
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyReflections_id` PRIMARY KEY(`id`),
	CONSTRAINT `daily_reflections_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
