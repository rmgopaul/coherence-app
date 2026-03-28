CREATE TABLE `productionReadings` (
	`id` varchar(64) NOT NULL,
	`customerEmail` varchar(320) NOT NULL,
	`nonId` varchar(64),
	`lifetimeKwh` double NOT NULL,
	`meterSerial` varchar(128),
	`firmwareVersion` varchar(64),
	`pvsSerial5` varchar(5),
	`readAt` timestamp NOT NULL,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `productionReadings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `production_readings_email_idx` ON `productionReadings` (`customerEmail`);--> statement-breakpoint
CREATE INDEX `production_readings_nonid_idx` ON `productionReadings` (`nonId`);--> statement-breakpoint
CREATE INDEX `production_readings_read_at_idx` ON `productionReadings` (`readAt`);