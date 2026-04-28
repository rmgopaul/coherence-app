ALTER TABLE `dockItems` ADD `dueAt` timestamp;--> statement-breakpoint
CREATE INDEX `dock_items_user_due_idx` ON `dockItems` (`userId`,`dueAt`);