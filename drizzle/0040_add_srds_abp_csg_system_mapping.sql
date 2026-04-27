CREATE TABLE `srDsAbpCsgSystemMapping` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`csgId` varchar(64),
	`systemId` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpCsgSystemMapping_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_system_mapping_batch_idx` ON `srDsAbpCsgSystemMapping` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_system_mapping_scope_batch_idx` ON `srDsAbpCsgSystemMapping` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_system_mapping_scope_csg_idx` ON `srDsAbpCsgSystemMapping` (`scopeId`,`csgId`);