CREATE TABLE `solarRecDashboardPerformanceRatioFacts` (
	`scopeId` varchar(64) NOT NULL,
	`key` varchar(255) NOT NULL,
	`convertedReadKey` varchar(64) NOT NULL,
	`matchType` varchar(64) NOT NULL,
	`monitoring` varchar(128) NOT NULL,
	`monitoringSystemId` varchar(255) NOT NULL,
	`monitoringSystemName` varchar(255) NOT NULL,
	`readDate` date,
	`readDateRaw` varchar(64) NOT NULL,
	`lifetimeReadWh` decimal(20,4) NOT NULL,
	`trackingSystemRefId` varchar(128) NOT NULL,
	`systemId` varchar(128),
	`stateApplicationRefId` varchar(128),
	`systemName` text NOT NULL,
	`installerName` varchar(255) NOT NULL,
	`monitoringPlatform` varchar(255) NOT NULL,
	`portalAcSizeKw` decimal(18,4),
	`abpAcSizeKw` decimal(18,4),
	`part2VerificationDate` date,
	`baselineReadWh` decimal(20,4),
	`baselineDate` date,
	`baselineSource` varchar(255),
	`productionDeltaWh` decimal(20,4),
	`expectedProductionWh` decimal(20,4),
	`performanceRatioPercent` decimal(10,4),
	`contractValue` decimal(18,4) NOT NULL,
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_performance_ratio_facts_pk` PRIMARY KEY(`scopeId`,`key`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_performance_ratio_facts_scope_build_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_performance_ratio_facts_scope_match_type_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`matchType`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_performance_ratio_facts_scope_monitoring_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`monitoring`);