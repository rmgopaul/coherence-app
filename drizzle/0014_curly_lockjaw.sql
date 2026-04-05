CREATE TABLE `supplementPriceLogs` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`definitionId` varchar(64) NOT NULL,
	`supplementName` varchar(128) NOT NULL,
	`brand` varchar(128),
	`pricePerBottle` double NOT NULL,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`sourceName` varchar(128),
	`sourceUrl` text,
	`sourceDomain` varchar(128),
	`confidence` double,
	`imageUrl` text,
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supplementPriceLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `supplement_price_logs_user_captured_idx` ON `supplementPriceLogs` (`userId`,`capturedAt`);--> statement-breakpoint
CREATE INDEX `supplement_price_logs_user_definition_captured_idx` ON `supplementPriceLogs` (`userId`,`definitionId`,`capturedAt`);