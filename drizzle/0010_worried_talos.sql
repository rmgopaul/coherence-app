CREATE TABLE `sectionEngagement` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`sectionId` varchar(48) NOT NULL,
	`eventType` varchar(32) NOT NULL,
	`eventValue` varchar(64),
	`sessionDate` varchar(10) NOT NULL,
	`durationMs` int,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `sectionEngagement_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `section_engagement_user_section_date_idx` ON `sectionEngagement` (`userId`,`sectionId`,`sessionDate`);--> statement-breakpoint
CREATE INDEX `section_engagement_user_event_date_idx` ON `sectionEngagement` (`userId`,`eventType`,`sessionDate`);