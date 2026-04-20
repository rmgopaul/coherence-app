-- Habits + Health feature tables.
-- New: habitCategories (grouping), sleepNotes (per-night journal).
-- Alters: habitDefinitions gains nullable categoryId.

CREATE TABLE `habitCategories` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`color` varchar(32) NOT NULL DEFAULT 'slate',
	`sortOrder` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `habitCategories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `habit_categories_user_idx` ON `habitCategories` (`userId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `habit_categories_user_name_idx` ON `habitCategories` (`userId`,`name`);
--> statement-breakpoint

ALTER TABLE `habitDefinitions` ADD COLUMN `categoryId` varchar(64);
--> statement-breakpoint
CREATE INDEX `habit_definitions_user_category_idx` ON `habitDefinitions` (`userId`,`categoryId`);
--> statement-breakpoint

CREATE TABLE `sleepNotes` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`tags` varchar(500),
	`notes` text,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sleepNotes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sleep_notes_user_date_idx` ON `sleepNotes` (`userId`,`dateKey`);
--> statement-breakpoint
CREATE INDEX `sleep_notes_user_idx` ON `sleepNotes` (`userId`);
