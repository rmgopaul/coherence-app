CREATE TABLE `srDsGeneratorDetails` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`gatsUnitId` varchar(128),
	`dateOnline` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsGeneratorDetails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_generator_details_batch_idx` ON `srDsGeneratorDetails` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_generator_details_scope_batch_idx` ON `srDsGeneratorDetails` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_generator_details_scope_unit_idx` ON `srDsGeneratorDetails` (`scopeId`,`gatsUnitId`);