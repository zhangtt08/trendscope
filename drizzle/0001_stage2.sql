CREATE TABLE `duplicate_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_a` integer NOT NULL,
	`content_item_b` integer NOT NULL,
	`reason` text NOT NULL,
	`similarity` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`content_item_a`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_b`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dup_candidate_status` ON `duplicate_candidates` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_dup_candidate_a` ON `duplicate_candidates` (`content_item_a`);--> statement-breakpoint
CREATE INDEX `idx_dup_candidate_b` ON `duplicate_candidates` (`content_item_b`);--> statement-breakpoint
CREATE TABLE `duplicate_merge_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_content_id` integer NOT NULL,
	`target_content_id` integer NOT NULL,
	`reason` text NOT NULL,
	`candidate_id` integer,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_merge_record_target` ON `duplicate_merge_records` (`target_content_id`);--> statement-breakpoint
CREATE INDEX `idx_merge_record_source` ON `duplicate_merge_records` (`source_content_id`);--> statement-breakpoint
ALTER TABLE `content_items` ADD `raw_published_at` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `published_tz` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `published_tz_assumption` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `quality_reasons` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `merged_into_content_item_id` integer;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `row_index` integer;--> statement-breakpoint
CREATE INDEX `idx_snapshot_item_batch` ON `content_metric_snapshots` (`content_item_id`,`import_batch_id`);