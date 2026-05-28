ALTER TABLE `solarRecDashboardChangeOwnershipFacts` ADD `standing` varchar(64);--> statement-breakpoint
ALTER TABLE `solarRecDashboardOwnershipFacts` ADD `standing` varchar(64);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_change_ownership_facts_scope_standing_idx` ON `solarRecDashboardChangeOwnershipFacts` (`scopeId`,`standing`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_ownership_facts_scope_standing_idx` ON `solarRecDashboardOwnershipFacts` (`scopeId`,`standing`);