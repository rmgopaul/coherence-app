CREATE TABLE `gmailWaitingOnCache` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`queryHash` varchar(64) NOT NULL,
	`payload` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gmailWaitingOnCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `gmailWaitingOnCache_userId_queryHash` UNIQUE(`userId`,`queryHash`)
);
--> statement-breakpoint
CREATE INDEX `gmailWaitingOnCache_expiresAt` ON `gmailWaitingOnCache` (`expiresAt`);