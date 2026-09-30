CREATE TABLE `collection_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`at` text NOT NULL,
	`type` text NOT NULL,
	`message` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `idx_run_event_run` ON `collection_run_events` (`run_id`,`at`);--> statement-breakpoint
CREATE TABLE `collection_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`task_name` text NOT NULL,
	`connector_id` text NOT NULL,
	`connector_version` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`records_fetched` integer DEFAULT 0 NOT NULL,
	`records_accepted` integer DEFAULT 0 NOT NULL,
	`records_failed` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`checkpoint` text,
	`import_batch_id` integer,
	`duration_ms` integer,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_task` ON `collection_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_status` ON `collection_runs` (`status`);--> statement-breakpoint
CREATE TABLE `collection_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`connector_id` text NOT NULL,
	`platform` text NOT NULL,
	`collection_type` text NOT NULL,
	`config` text NOT NULL,
	`schedule` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_enabled_next` ON `collection_tasks` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_task_connector` ON `collection_tasks` (`connector_id`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`connector_type` text NOT NULL,
	`source_adapter_id` text NOT NULL,
	`version` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`default_timezone` text,
	`policy` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `raw_records` ADD `collection_run_id` integer;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `connector_id` text;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `connector_version` text;