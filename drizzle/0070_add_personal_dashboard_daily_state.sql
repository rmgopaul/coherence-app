CREATE TABLE `personalDashboardDailyState` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`dailyBriefStatus` enum('not_started','draft','ready','failed') NOT NULL DEFAULT 'not_started',
	`dailyBriefJson` mediumtext,
	`todayPlanStatus` enum('not_started','draft','ready','completed') NOT NULL DEFAULT 'not_started',
	`todayPlanJson` mediumtext,
	`commitmentsJson` mediumtext,
	`outcomesJson` mediumtext,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `personalDashboardDailyState_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_dashboard_daily_state_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE INDEX `personal_dashboard_daily_state_user_updated_idx` ON `personalDashboardDailyState` (`userId`,`updatedAt`);