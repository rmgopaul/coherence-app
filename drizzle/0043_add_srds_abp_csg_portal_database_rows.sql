CREATE TABLE `srDsAbpCsgPortalDatabaseRows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`systemId` varchar(64),
	`csgId` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpCsgPortalDatabaseRows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_portal_db_batch_idx` ON `srDsAbpCsgPortalDatabaseRows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_portal_db_scope_batch_idx` ON `srDsAbpCsgPortalDatabaseRows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_csg_portal_db_scope_csg_idx` ON `srDsAbpCsgPortalDatabaseRows` (`scopeId`,`csgId`);