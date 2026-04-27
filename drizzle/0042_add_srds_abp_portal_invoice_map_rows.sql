CREATE TABLE `srDsAbpPortalInvoiceMapRows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`csgId` varchar(64),
	`invoiceNumber` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpPortalInvoiceMapRows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_portal_invoice_map_batch_idx` ON `srDsAbpPortalInvoiceMapRows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_portal_invoice_map_scope_batch_idx` ON `srDsAbpPortalInvoiceMapRows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_portal_invoice_map_scope_csg_idx` ON `srDsAbpPortalInvoiceMapRows` (`scopeId`,`csgId`);