-- DIN scraper: add extractorLog audit column + widen extractedBy enum
-- to include "qr" (QR-code decoded DINs, which bypass the vision path).

ALTER TABLE `dinScrapeResults` ADD COLUMN `extractorLog` mediumtext;
--> statement-breakpoint
ALTER TABLE `dinScrapeDins` MODIFY COLUMN `extractedBy`
  enum('claude','tesseract','pdfjs','qr') NOT NULL DEFAULT 'claude';
