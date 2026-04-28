CREATE TABLE `datasetUploadJobErrors` (
	`id` varchar(64) NOT NULL,
	`jobId` varchar(64) NOT NULL,
	`rowIndex` int,
	`errorMessage` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `datasetUploadJobErrors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `datasetUploadJobs` (
	`id` varchar(64) NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`initiatedByUserId` int NOT NULL,
	`datasetKey` varchar(64) NOT NULL,
	`fileName` varchar(500) NOT NULL,
	`fileSizeBytes` int,
	`uploadId` varchar(64),
	`uploadedChunks` int NOT NULL DEFAULT 0,
	`totalChunks` int,
	`storageKey` varchar(512),
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`totalRows` int,
	`rowsParsed` int NOT NULL DEFAULT 0,
	`rowsWritten` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`batchId` varchar(64),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `datasetUploadJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dataset_upload_job_errors_job_idx` ON `datasetUploadJobErrors` (`jobId`);--> statement-breakpoint
CREATE INDEX `dataset_upload_job_errors_job_created_idx` ON `datasetUploadJobErrors` (`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `dataset_upload_jobs_scope_status_idx` ON `datasetUploadJobs` (`scopeId`,`status`);--> statement-breakpoint
CREATE INDEX `dataset_upload_jobs_scope_dataset_created_idx` ON `datasetUploadJobs` (`scopeId`,`datasetKey`,`createdAt`);--> statement-breakpoint
CREATE INDEX `dataset_upload_jobs_scope_created_idx` ON `datasetUploadJobs` (`scopeId`,`createdAt`);