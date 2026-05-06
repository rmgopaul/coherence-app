CREATE TABLE `solarRecDashboardMonitoringDetailsFacts` (
	`scopeId` varchar(64) NOT NULL,
	`systemKey` varchar(128) NOT NULL,
	`onlineMonitoringAccessType` text,
	`onlineMonitoring` text,
	`onlineMonitoringGrantedUsername` text,
	`onlineMonitoringUsername` text,
	`onlineMonitoringSystemName` text,
	`onlineMonitoringSystemId` text,
	`onlineMonitoringPassword` text,
	`onlineMonitoringWebsiteApiLink` text,
	`onlineMonitoringEntryMethod` text,
	`onlineMonitoringNotes` text,
	`onlineMonitoringSelfReport` text,
	`onlineMonitoringRgmInfo` text,
	`onlineMonitoringNoSubmitGeneration` text,
	`systemOnline` text,
	`lastReportedOnlineDate` text,
	`abpApplicationId` varchar(128),
	`abpAcSizeKw` decimal(12,4),
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_monitoring_details_facts_pk` PRIMARY KEY(`scopeId`,`systemKey`)
);
--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_monitoring_details_facts_scope_build_idx` ON `solarRecDashboardMonitoringDetailsFacts` (`scopeId`,`buildId`);