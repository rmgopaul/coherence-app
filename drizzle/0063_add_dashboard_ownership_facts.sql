CREATE TABLE `solarRecDashboardOwnershipFacts` (
	`scopeId` varchar(64) NOT NULL,
	`systemKey` varchar(128) NOT NULL,
	`part2ProjectName` text NOT NULL,
	`part2ApplicationId` varchar(128),
	`part2SystemId` varchar(128),
	`part2TrackingId` varchar(128),
	`source` varchar(64) NOT NULL,
	`systemName` text NOT NULL,
	`systemId` varchar(128),
	`stateApplicationRefId` varchar(128),
	`trackingSystemRefId` varchar(128),
	`ownershipStatus` varchar(64) NOT NULL,
	`isReporting` boolean NOT NULL,
	`isTransferred` boolean NOT NULL,
	`isTerminated` boolean NOT NULL,
	`contractType` varchar(64),
	`contractStatusText` text NOT NULL,
	`latestReportingDate` date,
	`contractedDate` date,
	`zillowStatus` varchar(64),
	`zillowSoldDate` date,
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_ownership_facts_pk` PRIMARY KEY(`scopeId`,`systemKey`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_ownership_facts_scope_build_idx` ON `solarRecDashboardOwnershipFacts` (`scopeId`,`buildId`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_ownership_facts_scope_status_idx` ON `solarRecDashboardOwnershipFacts` (`scopeId`,`ownershipStatus`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_ownership_facts_scope_source_idx` ON `solarRecDashboardOwnershipFacts` (`scopeId`,`source`);