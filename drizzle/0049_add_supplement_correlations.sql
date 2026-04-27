CREATE TABLE `supplementCorrelations` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`supplementId` varchar(64) NOT NULL,
	`metric` varchar(32) NOT NULL,
	`windowDays` int NOT NULL,
	`lagDays` int NOT NULL DEFAULT 0,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	`cohensD` double,
	`pearsonR` double,
	`onN` int NOT NULL,
	`offN` int NOT NULL,
	`onMean` double,
	`offMean` double,
	`insufficientData` boolean NOT NULL DEFAULT true,
	CONSTRAINT `supplementCorrelations_id` PRIMARY KEY(`id`),
	CONSTRAINT `supplement_correlations_unique_slice_idx` UNIQUE(`userId`,`supplementId`,`metric`,`windowDays`,`lagDays`)
);
--> statement-breakpoint
CREATE INDEX `supplement_correlations_user_idx` ON `supplementCorrelations` (`userId`);