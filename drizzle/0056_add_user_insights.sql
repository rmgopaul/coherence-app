CREATE TABLE `userInsights` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`dateKey` varchar(10) NOT NULL,
	`rangeStartKey` varchar(10) NOT NULL,
	`rangeEndKey` varchar(10) NOT NULL,
	`model` varchar(64) NOT NULL,
	`daysAnalyzed` int NOT NULL,
	`insightsJson` mediumtext NOT NULL,
	`promptVersion` varchar(32) NOT NULL,
	`status` enum('ready','failed') NOT NULL,
	`errorMessage` text,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userInsights_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_insights_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE INDEX `user_insights_user_generated_idx` ON `userInsights` (`userId`,`generatedAt`);