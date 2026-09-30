-- Stage 5 §29-31: platform-agnostic discovery observations (append-only).
-- 知乎热榜 rank、搜索排名等"发现语境"记录;同一内容多次发现各记一行,绝不覆盖。
CREATE TABLE `content_discovery_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`collection_run_id` integer,
	`connector_id` text,
	`discovery_type` text NOT NULL,
	`query` text,
	`rank` integer,
	`captured_at` text NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_discovery_item_captured` ON `content_discovery_observations` (`content_item_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_discovery_run` ON `content_discovery_observations` (`collection_run_id`);--> statement-breakpoint
CREATE INDEX `idx_discovery_type_captured` ON `content_discovery_observations` (`discovery_type`,`captured_at`);