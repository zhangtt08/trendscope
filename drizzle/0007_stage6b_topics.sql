-- Stage 6B §2-7/§27-29/§37/§67: topic clustering & governance tables.
-- Stage 6A DB 原地升级,不删库。

CREATE TABLE `topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL DEFAULT 'active', -- active|needs_review|inactive|archived(§2;无 lifecycle 词)
	`embedding_space_id` text NOT NULL,      -- §4 空间隔离
	`naming_source` text NOT NULL DEFAULT 'keyword', -- manual|ai|keyword(§17)
	`name_confidence` real,
	`member_count` integer NOT NULL DEFAULT 0,
	`representative_item_ids` text, -- JSON [top3](§15)
	`keywords` text,                -- JSON top keywords(§16)
	`hashtags` text,                -- JSON top hashtags
	`cohesion` real,                -- [0,1](§14)
	`first_observed_at` text,
	`last_observed_at` text,
	`merged_into_topic_id` integer, -- §26 merged 候选指向
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_topics_status` ON `topics` (`status`,`member_count`);--> statement-breakpoint
CREATE INDEX `idx_topics_space` ON `topics` (`embedding_space_id`);--> statement-breakpoint
CREATE TABLE `topic_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`content_item_id` integer NOT NULL,
	`similarity_score` real,
	`assignment_method` text NOT NULL, -- automatic|manual|merge|split|move(§3)
	`confidence` real,
	`analysis_run_id` integer,
	`manual_lock` integer NOT NULL DEFAULT 0, -- §36 人工指派保护
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_membership_item` ON `topic_memberships` (`content_item_id`);--> statement-breakpoint
CREATE INDEX `idx_membership_topic` ON `topic_memberships` (`topic_id`);--> statement-breakpoint
CREATE TABLE `topic_analysis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`embedding_space_id` text NOT NULL,
	`status` text NOT NULL DEFAULT 'queued', -- queued|running|completed|partial|failed|cancelled
	`time_range_start` text,
	`time_range_end` text,
	`platform_filter` text,
	`similarity_threshold` real NOT NULL,
	`neighbor_limit` integer NOT NULL,
	`min_cluster_size` integer NOT NULL,
	`max_cluster_size` integer NOT NULL,
	`min_cohesion` real NOT NULL,
	`topic_identity_threshold` real NOT NULL, -- §24 集中配置(§6 可复现)
	`clustering_algorithm_version` text NOT NULL, -- §6
	`semantic_text_version` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimension` integer NOT NULL,
	`quality_mode` text NOT NULL, -- lexical_baseline | semantic(§51/§52)
	`contents_considered` integer NOT NULL DEFAULT 0,
	`contents_embedded` integer NOT NULL DEFAULT 0,
	`clusters_found` integer NOT NULL DEFAULT 0,
	`topics_created` integer NOT NULL DEFAULT 0,
	`topics_updated` integer NOT NULL DEFAULT 0,
	`unclustered_count` integer NOT NULL DEFAULT 0,
	`report` text, -- JSON:§53 quality 汇总
	`error` text,
	`cancel_requested` integer NOT NULL DEFAULT 0,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_topic_run_status` ON `topic_analysis_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `topic_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`analysis_run_id` integer NOT NULL,
	`captured_at` text NOT NULL,
	`member_count` integer NOT NULL,
	`new_content_count` integer NOT NULL, -- §30 相对上一 snapshot 新增
	`active_creator_count` integer,       -- §31 authorId 优先,authorName 兜底
	`platform_count` integer,
	`average_raw_momentum` real,
	`raw_engagement_delta` real,
	`cohesion` real,
	`platform_distribution` text -- JSON {zhihu: n, ...}(§32)
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_topic` ON `topic_snapshots` (`topic_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `topic_evolution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL, -- created|updated|merged|split|inactive|reactivated|manual_merge|manual_split|renamed(§27)
	`from_topic_ids` text, -- JSON
	`to_topic_ids` text,   -- JSON
	`analysis_run_id` integer,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topic_watches` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL DEFAULT 'watching', -- watching|review|ignored(§37)
	`updated_at` text NOT NULL
);