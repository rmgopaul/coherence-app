CREATE TABLE `noteLinks` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`noteId` varchar(64) NOT NULL,
	`linkType` varchar(48) NOT NULL,
	`externalId` varchar(255) NOT NULL,
	`seriesId` varchar(255) NOT NULL DEFAULT '',
	`occurrenceStartIso` varchar(64) NOT NULL DEFAULT '',
	`sourceUrl` text,
	`sourceTitle` varchar(255),
	`metadata` text,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `noteLinks_id` PRIMARY KEY(`id`),
	CONSTRAINT `note_links_unique_idx` UNIQUE(`noteId`,`linkType`,`externalId`,`seriesId`,`occurrenceStartIso`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(180) NOT NULL,
	`content` text NOT NULL,
	`pinned` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `note_links_user_note_idx` ON `noteLinks` (`userId`,`noteId`);--> statement-breakpoint
CREATE INDEX `note_links_user_type_idx` ON `noteLinks` (`userId`,`linkType`);--> statement-breakpoint
CREATE INDEX `notes_user_updated_idx` ON `notes` (`userId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `notes_user_pinned_idx` ON `notes` (`userId`,`pinned`);