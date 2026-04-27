CREATE TABLE `srDsAbpIccReport2Rows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`applicationId` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpIccReport2Rows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `srDsAbpIccReport3Rows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`applicationId` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpIccReport3Rows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_2_batch_idx` ON `srDsAbpIccReport2Rows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_2_scope_batch_idx` ON `srDsAbpIccReport2Rows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_2_scope_app_idx` ON `srDsAbpIccReport2Rows` (`scopeId`,`applicationId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_3_batch_idx` ON `srDsAbpIccReport3Rows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_3_scope_batch_idx` ON `srDsAbpIccReport3Rows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_icc_report_3_scope_app_idx` ON `srDsAbpIccReport3Rows` (`scopeId`,`applicationId`);