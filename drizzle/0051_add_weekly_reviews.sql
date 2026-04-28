CREATE TABLE `weeklyReviews` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`weekKey` varchar(10) NOT NULL,
	`weekStartDateKey` varchar(10) NOT NULL,
	`weekEndDateKey` varchar(10) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`headline` varchar(280),
	`contentMarkdown` mediumtext,
	`metricsJson` text,
	`model` varchar(64),
	`daysWithData` int NOT NULL DEFAULT 0,
	`generatedAt` timestamp,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `weeklyReviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_reviews_user_week_idx` UNIQUE(`userId`,`weekKey`)
);
--> statement-breakpoint
CREATE INDEX `weekly_reviews_user_generated_idx` ON `weeklyReviews` (`userId`,`generatedAt`);--> statement-breakpoint
CREATE INDEX `weekly_reviews_status_idx` ON `weeklyReviews` (`status`);