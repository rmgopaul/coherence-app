-- DropDock items — Phase F3
-- Persistent backing store for the front-page DropDock chips.
-- Rows are added when the user pastes/drags a Gmail/GCal/Sheets/Todoist
-- /URL link onto the dock; deleted when they remove the chip.
--
-- See: client/src/features/dashboard/frontpage/DropDock.tsx
--      server/routers/personalData.ts dockRouter

CREATE TABLE IF NOT EXISTS `dockItems` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `userId` int NOT NULL,
  `source` enum('gmail','gcal','gsheet','todoist','url') NOT NULL,
  `url` text NOT NULL,
  `urlCanonical` varchar(512) NOT NULL,
  `title` varchar(500),
  `meta` text,
  `pinnedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP
);

CREATE INDEX `dock_items_user_created_idx`
  ON `dockItems` (`userId`, `createdAt`);

CREATE UNIQUE INDEX `dock_items_user_url_unique`
  ON `dockItems` (`userId`, `urlCanonical`);
