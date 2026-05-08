-- 2026-05-09 — Option C build-isolation refactor for the Performance
-- Ratio facts table.
--
-- Pre-fix the PK was `(scopeId, key)`. A failed or overlapping build
-- could silently corrupt visible rows because the upsert-on-duplicate-
-- key collapsed build-A and build-B's writes for the same
-- `(scopeId, key)`. The fix is to include `buildId` in the PK so rows
-- from different builds COEXIST, and gate UI visibility through the
-- summary artifact's `buildId` pointer.
--
-- TiDB-specific: a clustered table cannot have its primary key
-- altered via `ALTER TABLE ... DROP PRIMARY KEY`. The first apply
-- attempt of this migration (2026-05-09) hit the
-- `Unsupported drop primary key when the table is using clustered
-- index` error. Workaround: drop + recreate the table. Safe because
-- this is a derived facts table — the next dashboard build re-
-- populates it. Codepaths that read the table reach it ONLY via
-- the summary artifact's `buildId` pointer; with no summary, the
-- read returns `available: false` (covered by the parser's strict
-- field validation). The DELETE FROM solarRecComputedArtifacts
-- below clears any stale Option-C cache rows so the next read
-- after deploy doesn't try to deserialize a pre-Option-C summary.
--
-- Identifier-length note: the `scope_build_match_idx` and
-- `scope_build_monit_idx` indexes use the abbreviated
-- `solar_rec_dashboard_perf_ratio_facts` prefix (36 chars) instead
-- of the longer `solar_rec_dashboard_performance_ratio_facts`
-- (43 chars). MySQL caps identifier length at 64 chars; the long
-- prefix would have produced 65-char names that error out at
-- CREATE INDEX time.

DROP TABLE `solarRecDashboardPerformanceRatioFacts`;--> statement-breakpoint

CREATE TABLE `solarRecDashboardPerformanceRatioFacts` (
	`scopeId` varchar(64) NOT NULL,
	`key` varchar(255) NOT NULL,
	`convertedReadKey` varchar(64) NOT NULL,
	`matchType` varchar(64) NOT NULL,
	`monitoring` varchar(128) NOT NULL,
	`monitoringSystemId` varchar(255) NOT NULL,
	`monitoringSystemName` varchar(255) NOT NULL,
	`readDate` date,
	`readDateRaw` varchar(64) NOT NULL,
	`lifetimeReadWh` decimal(20,4) NOT NULL,
	`trackingSystemRefId` varchar(128) NOT NULL,
	`systemId` varchar(128),
	`stateApplicationRefId` varchar(128),
	`systemName` text NOT NULL,
	`installerName` varchar(255) NOT NULL,
	`monitoringPlatform` varchar(255) NOT NULL,
	`portalAcSizeKw` decimal(18,4),
	`abpAcSizeKw` decimal(18,4),
	`part2VerificationDate` date,
	`baselineReadWh` decimal(20,4),
	`baselineDate` date,
	`baselineSource` varchar(255),
	`productionDeltaWh` decimal(20,4),
	`expectedProductionWh` decimal(20,4),
	`performanceRatioPercent` decimal(10,4),
	`contractValue` decimal(18,4) NOT NULL,
	`buildId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `solar_rec_dashboard_performance_ratio_facts_pk` PRIMARY KEY(`scopeId`,`buildId`,`key`)
);--> statement-breakpoint

-- Clear any stale Option-C cache rows so the next dashboard read
-- after deploy doesn't try to deserialize a pre-Option-C summary
-- payload (which lacks `allocationCount` / `monitoringOptions` /
-- etc.) into the new typed shape. The reader ALSO validates
-- required fields defensively, but deleting the rows in the
-- migration removes the corrupt-payload path entirely. The next
-- successful build re-populates them.
DELETE FROM `solarRecComputedArtifacts` WHERE `artifactType` IN ('performanceRatioSummary', 'performanceRatioAutoCompliantSources', 'performanceRatioCompliantBestPerSystem');--> statement-breakpoint

-- Covering filter+sort indexes for the page proc's read patterns.
-- All four use the abbreviated `solar_rec_dashboard_perf_ratio_facts`
-- prefix to stay under MySQL's 64-char identifier limit. Each
-- includes `key` as the tie-breaker because the page proc orders
-- by `(sortCol, key)` for pagination stability — without `key` in
-- the index, MySQL would need a filesort to apply the secondary
-- sort.
--
-- Skipped sort columns (`lifetimeReadWh`, `productionDeltaWh`,
-- `expectedProductionWh`, `contractValue`, `systemName`) accept a
-- filesort cost. `systemName` specifically can NOT be indexed
-- without a prefix length because the column is declared `text`;
-- MySQL rejects `CREATE INDEX ... (text_col)` without
-- `(text_col(N))` and Drizzle's index API doesn't currently
-- support prefix lengths in the schema DSL. Page reads with
-- `sortBy=systemName` filesort the per-build subset; the LIMIT
-- keeps the cost bounded.
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_match_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`matchType`,`key`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_monit_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`monitoring`,`key`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_readdate_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`readDate`,`key`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_perf_pct_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`performanceRatioPercent`,`key`);
