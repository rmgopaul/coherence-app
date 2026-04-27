CREATE TABLE `srDsConvertedReads` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`monitoring` varchar(64),
	`monitoringSystemId` varchar(128),
	`monitoringSystemName` varchar(255),
	`lifetimeMeterReadWh` double,
	`readDate` varchar(32),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsConvertedReads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_converted_reads_batch_idx` ON `srDsConvertedReads` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_converted_reads_scope_batch_idx` ON `srDsConvertedReads` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_converted_reads_scope_system_date_idx` ON `srDsConvertedReads` (`scopeId`,`monitoringSystemId`,`readDate`);