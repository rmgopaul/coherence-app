CREATE TABLE `userRecoveryCodes` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`codeHash` varchar(128) NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `userRecoveryCodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `userTotpSecrets` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`secret` varchar(256) NOT NULL,
	`verified` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userTotpSecrets_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_totp_secrets_user_idx` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE INDEX `user_recovery_codes_user_idx` ON `userRecoveryCodes` (`userId`);
