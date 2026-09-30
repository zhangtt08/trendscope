CREATE TABLE `content_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`platform_content_id` text,
	`content_type` text DEFAULT 'unknown' NOT NULL,
	`url` text,
	`canonical_url` text,
	`author_id` text,
	`author_name` text,
	`title` text,
	`text` text,
	`transcript` text,
	`hashtags` text,
	`published_at` text,
	`collected_at` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`favorites` integer,
	`upvotes` integer,
	`author_followers` integer,
	`data_quality` text NOT NULL,
	`source_type` text NOT NULL,
	`raw_data_id` integer,
	`fingerprint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`raw_data_id`) REFERENCES `raw_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_platform_id` ON `content_items` (`platform`,`platform_content_id`) WHERE "content_items"."platform_content_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_canonical_url` ON `content_items` (`canonical_url`) WHERE "content_items"."canonical_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_content_published_at` ON `content_items` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_content_collected_at` ON `content_items` (`collected_at`);--> statement-breakpoint
CREATE INDEX `idx_content_author_id` ON `content_items` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_content_quality` ON `content_items` (`data_quality`);--> statement-breakpoint
CREATE INDEX `idx_content_fingerprint` ON `content_items` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_content_platform` ON `content_items` (`platform`);--> statement-breakpoint
CREATE TABLE `content_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`captured_at` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`favorites` integer,
	`upvotes` integer,
	`source` text NOT NULL,
	`import_batch_id` integer,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_item_captured` ON `content_metric_snapshots` (`content_item_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_captured_at` ON `content_metric_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`platform` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`total_records` integer DEFAULT 0 NOT NULL,
	`successful_records` integer DEFAULT 0 NOT NULL,
	`failed_records` integer DEFAULT 0 NOT NULL,
	`duplicate_records` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`options` text
);
--> statement-breakpoint
CREATE INDEX `idx_import_batches_started_at` ON `import_batches` (`started_at`);--> statement-breakpoint
CREATE TABLE `raw_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_type` text NOT NULL,
	`platform` text,
	`adapter` text NOT NULL,
	`import_batch_id` integer,
	`payload` text NOT NULL,
	`field_names` text,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_raw_records_import_batch` ON `raw_records` (`import_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_raw_records_platform` ON `raw_records` (`platform`);