-- King of the Day — Phase C
-- One row per (userId, dateKey) capturing the headline rendered by
-- `KingOfTheDayHero`. Auto-created by the rules-based `selectKingOfDay`
-- when no row exists; `pin` upserts a `manual` row; `unpin` deletes the
-- row so the next .get() re-runs the selector.
--
-- See: productivity-hub/handoff/king-of-the-day.md

CREATE TABLE IF NOT EXISTS `userKingOfDay` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `userId` int NOT NULL,
  `dateKey` varchar(10) NOT NULL,           -- YYYY-MM-DD, local TZ
  `source` enum('auto','manual','ai') NOT NULL,
  `title` varchar(200) NOT NULL,
  `reason` varchar(500),
  `taskId` varchar(128),                    -- Todoist task id if applicable
  `eventId` varchar(128),                   -- Google calendar event id if applicable
  `pinnedAt` timestamp NULL,                -- set on manual pin
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX `userKingOfDay_user_date_idx`
  ON `userKingOfDay` (`userId`, `dateKey`);
