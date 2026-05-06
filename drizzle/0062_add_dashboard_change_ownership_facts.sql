CREATE TABLE `solarRecDashboardChangeOwnershipFacts` (
	`scopeId` varchar(64) NOT NULL,
	`systemKey` varchar(128) NOT NULL,
	`systemName` text NOT NULL,
	`systemId` varchar(128),
	`trackingSystemRefId` varchar(128),
	`installedKwAc` decimal(18,4),
	`contractType` varchar(64),
	`contractStatusText` text NOT NULL,
	`contractedDate` date,
	`zillowStatus` varchar(64),
	`zillowSoldDate` date,
	`latestReportingDate` date,
	`changeOwnershipStatus` varchar(64) NOT NULL,
	`ownershipStatus` varchar(64) NOT NULL,
	`isReporting` boolean NOT NULL,
	`isTerminated` boolean NOT NULL,
	`isTransferred` boolean NOT NULL,
	`hasChangedOwnership` boolean NOT NULL,
	`totalContractAmount` decimal(18,4),
	`contractedValue` decimal(18,4),
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_change_ownership_facts_pk` PRIMARY KEY(`scopeId`,`systemKey`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_change_ownership_facts_scope_build_idx` ON `solarRecDashboardChangeOwnershipFacts` (`scopeId`,`buildId`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_change_ownership_facts_scope_status_idx` ON `solarRecDashboardChangeOwnershipFacts` (`scopeId`,`changeOwnershipStatus`);