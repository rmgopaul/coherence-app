-- Task 4.5 V2 — AskAiPanel persistence.
--
-- Adds per-module model preference storage on `userPreferences`
-- (JSON blob keyed by moduleKey), and extends `conversations` with
-- a `source` tag so the shared AskAiPanel can filter its own
-- history away from the legacy ChatGPT widget's rows. Nullable +
-- additive; no backfill required.

ALTER TABLE `userPreferences` ADD `askAiModelsJson` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `source` varchar(128);--> statement-breakpoint
CREATE INDEX `conversations_user_source_idx` ON `conversations` (`userId`,`source`);
