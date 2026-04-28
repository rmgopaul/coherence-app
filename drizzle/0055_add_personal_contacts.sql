CREATE TABLE `personalContacts` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`email` varchar(320),
	`phone` varchar(64),
	`role` varchar(200),
	`company` varchar(200),
	`notes` text,
	`tags` varchar(500),
	`lastContactedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`archivedAt` timestamp,
	CONSTRAINT `personalContacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `personal_contacts_user_created_idx` ON `personalContacts` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `personal_contacts_user_last_contacted_idx` ON `personalContacts` (`userId`,`lastContactedAt`);