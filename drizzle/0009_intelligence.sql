-- Stage 8 §15/§22/§60-§64/§73: content intelligence tables.
-- content_feature_records = 缓存(textHash+featureVersion 命中即复用);
-- pattern_results / *_snapshots = append-only;topic_angle_clusters 持久化并跨 Run 调和;
-- topic_intelligence_current = 列表查询缓存(SQL 排序分页,§73)。真机原地升级。

CREATE TABLE `intelligence_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_version` text NOT NULL,
	`pattern_version` text NOT NULL,
	`saturation_version` text NOT NULL,
	`novelty_version` text NOT NULL,
	`angle_text_version` text NOT NULL,
	`time_range_start` text,
	`time_range_end` text,
	`topics_analyzed` integer NOT NULL DEFAULT 0,
	`contents_analyzed` integer NOT NULL DEFAULT 0,
	`pattern_scorable` integer NOT NULL DEFAULT 0,
	`pattern_insufficient` integer NOT NULL DEFAULT 0,
	`saturated_scorable` integer NOT NULL DEFAULT 0,
	`saturated_insufficient` integer NOT NULL DEFAULT 0,
	`novelty_scorable` integer NOT NULL DEFAULT 0,
	`emerging_angle_count` integer NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT 'running',
	`config_snapshot` text NOT NULL,
	`duration_ms` integer,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_intel_run_created` ON `intelligence_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `content_feature_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`text_hash` text NOT NULL,
	`feature_version` text NOT NULL,
	`extractor` text NOT NULL,
	`model` text,
	`features` text NOT NULL,               -- JSON: deterministic + semantic(结构化 Zod schema)
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_feature_item_version_hash` ON `content_feature_records` (`content_item_id`,`feature_version`,`text_hash`);--> statement-breakpoint
CREATE TABLE `pattern_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`scope` text NOT NULL DEFAULT 'topic',  -- topic | platform_global
	`topic_id` integer,
	`platform` text,
	`window_hours` integer NOT NULL,
	`feature` text NOT NULL,
	`feature_kind` text NOT NULL,           -- boolean | continuous | categorical
	`viral_value` text NOT NULL,            -- JSON
	`control_value` text NOT NULL,          -- JSON
	`lift` real,
	`delta` real,
	`viral_sample_size` integer NOT NULL,
	`control_sample_size` integer NOT NULL,
	`evidence_quality` text NOT NULL,       -- high | medium | low | insufficient
	`notes` text NOT NULL,                  -- JSON: controlMatchLevel/smoothingApplied/direction
	`feature_version` text NOT NULL,
	`pattern_version` text NOT NULL,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pattern_run` ON `pattern_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_pattern_topic` ON `pattern_results` (`topic_id`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `topic_saturation_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`score` real,
	`confidence` text,
	`unscorable_reason` text,
	`breakdown` text NOT NULL,
	`evidence` text NOT NULL,
	`version` text NOT NULL,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sat_snap_topic` ON `topic_saturation_snapshots` (`topic_id`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `topic_novelty_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`score` real,
	`emerging_angle_count` integer NOT NULL DEFAULT 0,
	`confidence` text,
	`unscorable_reason` text,
	`evidence` text NOT NULL,
	`version` text NOT NULL,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nov_snap_topic` ON `topic_novelty_snapshots` (`topic_id`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `topic_angle_clusters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`label` text NOT NULL,
	`label_source` text NOT NULL DEFAULT 'keyword', -- keyword | ai | manual
	`member_count` integer NOT NULL,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`representative_item_ids` text NOT NULL,        -- JSON [top3]
	`centroid` blob,                                -- Float32 LE,angle embedding 质心
	`dimension` integer,
	`novelty_score` real,
	`is_emerging` integer NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT 'active',        -- active | inactive
	`last_run_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_angle_cluster_topic` ON `topic_angle_clusters` (`topic_id`,`status`);--> statement-breakpoint
CREATE TABLE `topic_intelligence_current` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`saturation_score` real,
	`saturated_confidence` text,
	`saturation_version` text,
	`novelty_score` real,
	`emerging_angle_count` integer,
	`novelty_confidence` text,
	`novelty_version` text,
	`calculated_at` text NOT NULL,
	`run_id` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_intel_cur_saturation` ON `topic_intelligence_current` (`saturation_score`);--> statement-breakpoint
CREATE INDEX `idx_intel_cur_novelty` ON `topic_intelligence_current` (`novelty_score`);
