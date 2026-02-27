ALTER TABLE `userPreferences`
ADD COLUMN IF NOT EXISTS `displayName` varchar(120);
--> statement-breakpoint
ALTER TABLE `supplementDefinitions`
ADD COLUMN IF NOT EXISTS `brand` varchar(128);
--> statement-breakpoint
ALTER TABLE `supplementDefinitions`
ADD COLUMN IF NOT EXISTS `dosePerUnit` varchar(64);
--> statement-breakpoint
ALTER TABLE `supplementDefinitions`
ADD COLUMN IF NOT EXISTS `productUrl` text;
--> statement-breakpoint
ALTER TABLE `supplementDefinitions`
ADD COLUMN IF NOT EXISTS `pricePerBottle` double;
--> statement-breakpoint
ALTER TABLE `supplementDefinitions`
ADD COLUMN IF NOT EXISTS `quantityPerBottle` double;
