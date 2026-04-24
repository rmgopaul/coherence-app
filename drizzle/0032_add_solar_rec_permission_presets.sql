-- Task 5.1 — named permission presets. Templates of (moduleKey -> level)
-- that admins can save and re-apply to teammates. Unique per (scopeId,
-- name). Applying a preset overwrites the target user's permission rows
-- via `replaceSolarRecUserModulePermissions`; editing a preset later
-- does NOT propagate — presets are templates, not live bindings.

CREATE TABLE `solarRecPermissionPresets` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(500),
	`permissionsJson` text NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solarRecPermissionPresets_id` PRIMARY KEY(`id`),
	CONSTRAINT `solar_rec_permission_presets_scope_name_idx` UNIQUE(`scopeId`,`name`)
);
