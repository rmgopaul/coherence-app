ALTER TABLE `solarRecDashboardSystemFacts` ADD `addressCity` varchar(128);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `addressState` varchar(64);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `addressZip` varchar(16);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `county` varchar(128);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `utilityTerritory` varchar(128);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `contractIdNumber` varchar(64);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `additionalCollateralPercent` decimal(10,4);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `terminationCost` decimal(18,4);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `deliveryStartDate` date;--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `deliveryEndDate` date;--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `totalTransferredMwh` decimal(18,4);--> statement-breakpoint
ALTER TABLE `solarRecDashboardSystemFacts` ADD `lastMeterReadDate` date;