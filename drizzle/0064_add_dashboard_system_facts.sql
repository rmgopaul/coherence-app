CREATE TABLE `solarRecDashboardSystemFacts` (
	`scopeId` varchar(64) NOT NULL,
	`systemKey` varchar(128) NOT NULL,
	`systemId` varchar(128),
	`stateApplicationRefId` varchar(128),
	`trackingSystemRefId` varchar(128),
	`systemName` text NOT NULL,
	`installedKwAc` decimal(12,4),
	`installedKwDc` decimal(12,4),
	`sizeBucket` varchar(32) NOT NULL,
	`recPrice` decimal(18,4),
	`totalContractAmount` decimal(18,4),
	`contractedRecs` decimal(18,4),
	`deliveredRecs` decimal(18,4),
	`contractedValue` decimal(18,4),
	`deliveredValue` decimal(18,4),
	`valueGap` decimal(18,4),
	`latestReportingDate` date,
	`latestReportingKwh` decimal(18,4),
	`isReporting` boolean NOT NULL,
	`isTerminated` boolean NOT NULL,
	`isTransferred` boolean NOT NULL,
	`ownershipStatus` varchar(64) NOT NULL,
	`hasChangedOwnership` boolean NOT NULL,
	`changeOwnershipStatus` varchar(64),
	`contractStatusText` text NOT NULL,
	`contractType` varchar(64),
	`zillowStatus` varchar(64),
	`zillowSoldDate` date,
	`contractedDate` date,
	`monitoringType` text NOT NULL,
	`monitoringPlatform` text NOT NULL,
	`installerName` text NOT NULL,
	`part2VerificationDate` date,
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_system_facts_pk` PRIMARY KEY(`scopeId`,`systemKey`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_system_facts_scope_build_idx` ON `solarRecDashboardSystemFacts` (`scopeId`,`buildId`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_system_facts_scope_status_idx` ON `solarRecDashboardSystemFacts` (`scopeId`,`ownershipStatus`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_system_facts_scope_size_idx` ON `solarRecDashboardSystemFacts` (`scopeId`,`sizeBucket`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_system_facts_scope_reporting_idx` ON `solarRecDashboardSystemFacts` (`scopeId`,`isReporting`);