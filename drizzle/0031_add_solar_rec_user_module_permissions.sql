-- Task 5.1 — Solar REC permission matrix infrastructure.
--
-- New table `solarRecUserModulePermissions` holds one row per (userId,
-- scopeId, moduleKey). Absence of a row is treated as `none` — module
-- hidden, all writes 403. Scope owner (solarRecScopes.ownerUserId) and
-- users with solarRecUsers.isScopeAdmin=true bypass this table with
-- implicit admin on every module (prevents lockout).
--
-- No data changes. No seed rows — the Settings UI populates them later.

CREATE TABLE `solarRecUserModulePermissions` (
	`id` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`moduleKey` varchar(64) NOT NULL,
	`permission` enum('none','read','edit','admin') NOT NULL DEFAULT 'none',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecUserModulePermissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `solar_rec_user_module_permissions_user_scope_module_idx` UNIQUE(`userId`,`scopeId`,`moduleKey`)
);
--> statement-breakpoint
ALTER TABLE `solarRecUsers` ADD `isScopeAdmin` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `solar_rec_user_module_permissions_scope_module_idx` ON `solarRecUserModulePermissions` (`scopeId`,`moduleKey`);