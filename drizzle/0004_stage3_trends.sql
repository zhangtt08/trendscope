CREATE TABLE `topic_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`note` text,
	`momentum_score` integer,
	`window_days` integer,
	`created_at` text NOT NULL,
	`decided_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_topic_pick_item` ON `topic_picks` (`content_item_id`);--> statement-breakpoint
CREATE INDEX `idx_topic_pick_status` ON `topic_picks` (`status`,`updated_at`);
