CREATE TABLE `srDsAbpQuickBooksRows` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`batchId` varchar(64) NOT NULL,
	`invoiceNumber` varchar(64),
	`rawRow` mediumtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `srDsAbpQuickBooksRows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sr_ds_abp_quick_books_batch_idx` ON `srDsAbpQuickBooksRows` (`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_quick_books_scope_batch_idx` ON `srDsAbpQuickBooksRows` (`scopeId`,`batchId`);--> statement-breakpoint
CREATE INDEX `sr_ds_abp_quick_books_scope_invoice_idx` ON `srDsAbpQuickBooksRows` (`scopeId`,`invoiceNumber`);