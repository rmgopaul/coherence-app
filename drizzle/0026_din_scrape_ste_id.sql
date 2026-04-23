-- DIN scraper: add per-site Tesla STE (System Tesla Energy) ID
-- captured from Powerhub-app screenshot OCR. Site-scoped — one STE
-- ID per installed Tesla system — so a scalar column on dinScrapeResults
-- rather than a one-to-many table.
--
-- Phase 1 of 2: this commit lands the column only. The application
-- code that writes and reads `steId` ships in a later commit, AFTER
-- this migration has been applied to prod. Splitting avoids the
-- situation where the ORM schema references a column that doesn't
-- exist in the database yet and every SELECT / INSERT fails silently
-- (see commit 201bd8a, reverted).

ALTER TABLE `dinScrapeResults` ADD COLUMN `steId` varchar(64);
