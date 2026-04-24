CREATE TABLE `dailyJobClaims` (
	`id` varchar(64) NOT NULL,
	`dateKey` varchar(10) NOT NULL,
	`runKey` varchar(64) NOT NULL,
	`claimedAt` timestamp NOT NULL DEFAULT (now()),
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`completedAt` timestamp,
	`errorMessage` text,
	CONSTRAINT `dailyJobClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `dailyJobClaims_dateKey_runKey` UNIQUE(`dateKey`,`runKey`)
);
