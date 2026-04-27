CREATE TABLE `srDsAnnualProductionEstimates` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`unitId` varchar(64),
	`facilityName` varchar(255),
	`jan` double,
	`feb` double,
	`mar` double,
	`apr` double,
	`may` double,
	`jun` double,
	`jul` double,
	`aug` double,
	`sep` double,
	`oct` double,
	`nov` double,
	`decMonth` double,
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAnnualProductionEstimates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_annual_production_batch_idx` ON `srDsAnnualProductionEstimates` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_annual_production_scope_batch_idx` ON `srDsAnnualProductionEstimates` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_annual_production_scope_unit_idx` ON `srDsAnnualProductionEstimates` (`scopeId`,`unitId`);