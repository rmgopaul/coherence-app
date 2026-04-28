ALTER TABLE `dockItems` ADD `archivedAt` timestamp;--> statement-breakpoint
CREATE INDEX `dock_items_archived_at_idx` ON `dockItems` (`archivedAt`);