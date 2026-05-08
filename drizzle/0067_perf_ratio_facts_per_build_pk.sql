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
-- Truncate the table first because (a) the existing rows would all
-- collapse into the new PK fine but the build-runner is being changed
-- in the same PR to write summary AFTER rows, and (b) the next
-- successful dashboard build re-populates the table from the
-- aggregator's source data — these are derived facts.

TRUNCATE TABLE `solarRecDashboardPerformanceRatioFacts`;--> statement-breakpoint
ALTER TABLE `solarRecDashboardPerformanceRatioFacts` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `solarRecDashboardPerformanceRatioFacts` ADD CONSTRAINT `solar_rec_dashboard_performance_ratio_facts_pk` PRIMARY KEY (`scopeId`,`buildId`,`key`);--> statement-breakpoint

-- Drop now-redundant indexes. The new PK `(scopeId, buildId, key)`
-- subsumes `(scopeId, buildId)` for the build-sweep query; the
-- per-filter indexes are replaced below with covering versions that
-- include `key` for the ORDER BY.
DROP INDEX `solar_rec_dashboard_performance_ratio_facts_scope_build_idx` ON `solarRecDashboardPerformanceRatioFacts`;--> statement-breakpoint
DROP INDEX `solar_rec_dashboard_performance_ratio_facts_scope_match_type_idx` ON `solarRecDashboardPerformanceRatioFacts`;--> statement-breakpoint
DROP INDEX `solar_rec_dashboard_performance_ratio_facts_scope_monitoring_idx` ON `solarRecDashboardPerformanceRatioFacts`;--> statement-breakpoint

-- Covering filter+sort indexes for the page proc's read patterns:
-- `WHERE scopeId=? AND buildId=? AND matchType=? ORDER BY key LIMIT N OFFSET M`
-- and the same shape with `monitoring` instead of / in addition to
-- `matchType`. Including `key` lets MySQL use the index for both the
-- filter AND the order-by, avoiding a filesort over the per-build set.
CREATE INDEX `solar_rec_dashboard_performance_ratio_facts_scope_build_match_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`matchType`,`key`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_performance_ratio_facts_scope_build_monit_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`monitoring`,`key`);--> statement-breakpoint

-- Common sort columns. Skipped: `lifetimeReadWh` /
-- `productionDeltaWh` / `expectedProductionWh` / `contractValue` —
-- they accept a filesort over the per-build set today and can be
-- promoted to covering indexes if a tab surfaces a slow query.
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_readdate_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`readDate`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_perf_pct_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`performanceRatioPercent`);--> statement-breakpoint
CREATE INDEX `solar_rec_dashboard_perf_ratio_facts_scope_build_sysname_idx` ON `solarRecDashboardPerformanceRatioFacts` (`scopeId`,`buildId`,`systemName`);
