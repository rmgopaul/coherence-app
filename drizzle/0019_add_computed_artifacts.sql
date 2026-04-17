-- Solar REC Computed Artifacts cache table
-- Phase 8.3d: replaces the ad-hoc piggyback on solarRecDashboardStorage
-- for caching system snapshots. One row per (scope, artifactType,
-- inputVersionHash), payload is the serialized result.

CREATE TABLE IF NOT EXISTS `solarRecComputedArtifacts` (
  `id` varchar(64) PRIMARY KEY NOT NULL,
  `scopeId` varchar(64) NOT NULL,
  `artifactType` varchar(64) NOT NULL,
  `inputVersionHash` varchar(64) NOT NULL,
  `payload` mediumtext NOT NULL,
  `rowCount` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now())
);

CREATE UNIQUE INDEX `sr_computed_artifacts_lookup_idx`
  ON `solarRecComputedArtifacts` (`scopeId`, `artifactType`, `inputVersionHash`);
