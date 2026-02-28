ALTER TABLE `notes` ADD `notebook` varchar(120) DEFAULT 'General' NOT NULL;--> statement-breakpoint
CREATE INDEX `notes_user_notebook_idx` ON `notes` (`userId`,`notebook`);