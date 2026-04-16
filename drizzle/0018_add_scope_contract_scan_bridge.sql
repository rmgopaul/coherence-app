-- Scope-Aware Contract Scan Bridge (Step 7)
-- Tracks latest completed scan job + latest override timestamp per scope.
-- Financials version hash reads from this table.

CREATE TABLE IF NOT EXISTS `solarRecScopeContractScanVersion` (
  `scopeId` varchar(64) PRIMARY KEY NOT NULL,
  `latestCompletedJobId` varchar(64),
  `latestOverrideAt` timestamp,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP
);
