CREATE TABLE `solarRecDashboardPerformanceRatioCompliantFacts` (
	`scopeId` varchar(64) NOT NULL,
	`buildId` varchar(64) NOT NULL,
	`systemKey` varchar(256) NOT NULL,
	`key` varchar(255) NOT NULL,
	`systemId` varchar(128),
	`stateApplicationRefId` varchar(128),
	`trackingSystemRefId` varchar(128) NOT NULL,
	`systemName` text NOT NULL,
	`matchType` varchar(64) NOT NULL,
	`monitoring` varchar(128) NOT NULL,
	`monitoringSystemId` varchar(255) NOT NULL,
	`monitoringSystemName` varchar(255) NOT NULL,
	`monitoringPlatform` varchar(255) NOT NULL,
	`installerName` varchar(255) NOT NULL,
	`portalAcSizeKw` decimal(18,4),
	`abpAcSizeKw` decimal(18,4),
	`part2VerificationDate` date,
	`readDate` date,
	`readDateRaw` varchar(64) NOT NULL,
	`performanceRatioPercent` decimal(10,4),
	`productionDeltaWh` decimal(20,4),
	`expectedProductionWh` decimal(20,4),
	`contractValue` decimal(18,4) NOT NULL,
	`baselineReadWh` decimal(20,4),
	`baselineDate` date,
	`baselineSource` varchar(255),
	`lifetimeReadWh` decimal(20,4) NOT NULL,
	`compliantSource` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_perf_ratio_compliant_facts_pk` PRIMARY KEY(`scopeId`,`buildId`,`systemKey`)
);
--> statement-breakpoint
CREATE INDEX `sr_d_perf_ratio_compl_facts_scope_build_source_idx` ON `solarRecDashboardPerformanceRatioCompliantFacts` (`scopeId`,`buildId`,`compliantSource`,`systemKey`);--> statement-breakpoint
CREATE INDEX `sr_d_perf_ratio_compl_facts_scope_build_monit_idx` ON `solarRecDashboardPerformanceRatioCompliantFacts` (`scopeId`,`buildId`,`monitoring`,`systemKey`);--> statement-breakpoint
CREATE INDEX `sr_d_perf_ratio_compl_facts_scope_build_perf_pct_idx` ON `solarRecDashboardPerformanceRatioCompliantFacts` (`scopeId`,`buildId`,`performanceRatioPercent`,`systemKey`);--> statement-breakpoint
CREATE INDEX `sr_d_perf_ratio_compl_facts_scope_build_readdate_idx` ON `solarRecDashboardPerformanceRatioCompliantFacts` (`scopeId`,`buildId`,`readDate`,`systemKey`);