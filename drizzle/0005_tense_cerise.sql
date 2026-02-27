CREATE TABLE `dailySnapshots` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	`whoopPayload` text,
	`samsungPayload` text,
	`supplementsPayload` text,
	`habitsPayload` text,
	`todoistCompletedCount` int,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailySnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `daily_snapshots_user_date_idx` UNIQUE(`userId`,`dateKey`)
);
--> statement-breakpoint
CREATE TABLE `samsungSyncPayloads` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	`payload` text NOT NULL,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `samsungSyncPayloads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `daily_snapshots_user_captured_idx` ON `dailySnapshots` (`userId`,`capturedAt`);--> statement-breakpoint
CREATE INDEX `samsung_sync_payloads_user_date_idx` ON `samsungSyncPayloads` (`userId`,`dateKey`);--> statement-breakpoint
CREATE INDEX `samsung_sync_payloads_user_captured_idx` ON `samsungSyncPayloads` (`userId`,`capturedAt`);