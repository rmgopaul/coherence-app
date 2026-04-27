CREATE TABLE `srDsAbpProjectApplicationRows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`applicationId` varchar(64),
	`inverterSizeKwAcPart1` varchar(32),
	`part1SubmissionDate` varchar(32),
	`part1OriginalSubmissionDate` varchar(32),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpProjectApplicationRows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_project_app_rows_batch_idx` ON `srDsAbpProjectApplicationRows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_project_app_rows_scope_batch_idx` ON `srDsAbpProjectApplicationRows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_project_app_rows_scope_app_idx` ON `srDsAbpProjectApplicationRows` (`scopeId`,`applicationId`);