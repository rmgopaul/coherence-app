-- DIN scraper: add per-site Tesla STE (System Tesla Energy) ID
-- captured from Powerhub-app screenshot OCR. Site-scoped — one STE
-- ID per installed Tesla system — so a scalar column on dinScrapeResults
-- rather than a one-to-many table.

ALTER TABLE `dinScrapeResults` ADD COLUMN `steId` varchar(64);
