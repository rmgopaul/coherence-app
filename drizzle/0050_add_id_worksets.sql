CREATE TABLE `idWorksets` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`createdByUserId` int NOT NULL,
	`lastEditedByUserId` int,
	`name` varchar(255) NOT NULL,
	`description` text,
	`csgIdsJson` mediumtext NOT NULL,
	`csgIdCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `idWorksets_id` PRIMARY KEY(`id`),
	CONSTRAINT `id_worksets_scope_name_idx` UNIQUE(`scopeId`,`name`)
);
--> statement-breakpoint
CREATE INDEX `id_worksets_scope_idx` ON `idWorksets` (`scopeId`);--> statement-breakpoint
CREATE INDEX `id_worksets_scope_updated_idx` ON `idWorksets` (`scopeId`,`updatedAt`);