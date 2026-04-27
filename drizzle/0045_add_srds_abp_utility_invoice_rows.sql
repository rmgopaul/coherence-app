CREATE TABLE `srDsAbpUtilityInvoiceRows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`systemId` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpUtilityInvoiceRows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_utility_invoice_batch_idx` ON `srDsAbpUtilityInvoiceRows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_utility_invoice_scope_batch_idx` ON `srDsAbpUtilityInvoiceRows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_utility_invoice_scope_system_idx` ON `srDsAbpUtilityInvoiceRows` (`scopeId`,`systemId`);