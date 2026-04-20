-- DropDock canvas columns — Phase F8
-- Adds optional positioning (x/y/tilt) + color so the same dockItems
-- row can also render as a sticky note on /dashboard/canvas.
--
-- Idempotent: each ADD COLUMN is wrapped so re-runs swallow the
-- "Duplicate column name" error in the migration runner.

ALTER TABLE `dockItems` ADD COLUMN `x` int NULL;
ALTER TABLE `dockItems` ADD COLUMN `y` int NULL;
ALTER TABLE `dockItems` ADD COLUMN `tilt` smallint NULL;
ALTER TABLE `dockItems` ADD COLUMN `color` varchar(16) NULL;
