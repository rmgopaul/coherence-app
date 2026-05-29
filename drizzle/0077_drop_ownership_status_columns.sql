DROP INDEX `solar_rec_dashboard_ownership_facts_scope_status_idx` ON `solarRecDashboardOwnershipFacts`;--> statement-breakpoint
DROP INDEX `solar_rec_dashboard_system_facts_scope_status_idx` ON `solarRecDashboardSystemFacts`;--> statement-breakpoint
ALTER TABLE `solarRecDashboardChangeOwnershipFacts` DROP COLUMN `ownershipStatus`;--> statement-breakpoint
ALTER TABLE `solarRecDashboardOwnershipFacts` DROP COLUMN `ownershipStatus`;--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` DROP COLUMN `ownershipStatus`;