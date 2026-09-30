-- Stage 7 §AB/§AD/§AM/§AW: scoring infrastructure.
-- content_score_snapshots / topic_trend_snapshots / topic_lifecycle_events 全部 append-only;
-- *_current 为 latest 查询缓存(upsert),历史只增不删。真机库原地升级,不删库。

CREATE TABLE `scoring_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`score_profile` text NOT NULL,           -- content_burst | topic_trend
	`score_version` text NOT NULL,           -- CONTENT_BURST_V1 | TOPIC_TREND_V1
	`status` text NOT NULL DEFAULT 'running', -- running|completed|partial|failed
	`time_range_start` text,
	`time_range_end` text,
	`content_count` integer NOT NULL DEFAULT 0,
	`scorable_count` integer NOT NULL DEFAULT 0,
	`unscorable_count` integer NOT NULL DEFAULT 0,
	`topic_count` integer NOT NULL DEFAULT 0,
	`config_snapshot` text NOT NULL,         -- JSON: profile 快照(权重/阈值全量)
	`duration_ms` integer,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scoring_run_profile` ON `scoring_runs` (`score_profile`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_score_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`scoring_run_id` integer NOT NULL,
	`score_type` text NOT NULL DEFAULT 'content_burst',
	`score_version` text NOT NULL,
	`scorable` integer NOT NULL DEFAULT 1,
	`unscorable_reason` text,                -- insufficient_snapshots|insufficient_metrics|insufficient_cohort
	`overall_score` real,                    -- unscorable 时 null(绝不写 0 冒充)
	`confidence` text,                       -- high|medium|low
	`breakdown` text NOT NULL,               -- JSON: 组件分+生效权重
	`evidence` text NOT NULL,                -- JSON: 窗口/cohort/creator 原始证据
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_css_item_calc` ON `content_score_snapshots` (`content_item_id`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `idx_css_run` ON `content_score_snapshots` (`scoring_run_id`);--> statement-breakpoint
CREATE INDEX `idx_css_score` ON `content_score_snapshots` (`overall_score`);--> statement-breakpoint
CREATE TABLE `content_score_current` (
	`content_item_id` integer PRIMARY KEY NOT NULL,
	`score_type` text NOT NULL DEFAULT 'content_burst',
	`score_version` text NOT NULL,
	`scorable` integer NOT NULL DEFAULT 1,
	`unscorable_reason` text,
	`overall_score` real,
	`confidence` text,
	`breakdown` text NOT NULL,
	`evidence` text NOT NULL,
	`calculated_at` text NOT NULL,
	`scoring_run_id` integer NOT NULL,
	`platform` text NOT NULL,                -- 冗余:SQL 排序/筛选免 join
	`topic_id` integer                       -- 冗余:primary topic(运行时刷新)
);
--> statement-breakpoint
CREATE INDEX `idx_csc_score` ON `content_score_current` (`overall_score`);--> statement-breakpoint
CREATE INDEX `idx_csc_platform_score` ON `content_score_current` (`platform`,`overall_score`);--> statement-breakpoint
CREATE INDEX `idx_csc_topic` ON `content_score_current` (`topic_id`);--> statement-breakpoint
CREATE TABLE `topic_trend_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`scoring_run_id` integer NOT NULL,
	`score_version` text NOT NULL,
	`scorable` integer NOT NULL DEFAULT 1,
	`unscorable_reason` text,
	`score` real,
	`confidence` text,
	`content_growth` real,
	`engagement_growth` real,
	`creator_growth` real,
	`burst_density` real,
	`acceleration` real,
	`member_count` integer NOT NULL,
	`evidence` text NOT NULL,                -- JSON: 窗口对/创作者/爆发占比原始证据
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tts_topic_calc` ON `topic_trend_snapshots` (`topic_id`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `idx_tts_run` ON `topic_trend_snapshots` (`scoring_run_id`);--> statement-breakpoint
CREATE TABLE `topic_score_current` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`score_version` text NOT NULL,
	`scorable` integer NOT NULL DEFAULT 1,
	`unscorable_reason` text,
	`score` real,
	`confidence` text,
	`lifecycle` text,                        -- emerging|rising|peak|saturated|declining|evergreen(null=数据不足)
	`pending_lifecycle` text,                -- hysteresis:待确认状态
	`pending_count` integer NOT NULL DEFAULT 0,
	`content_growth` real,
	`engagement_growth` real,
	`creator_growth` real,
	`burst_density` real,
	`acceleration` real,
	`member_count` integer NOT NULL,
	`recent_new_content` integer,            -- 当前窗口新增(展示列)
	`active_creators` integer,
	`avg_raw_momentum` real,                 -- 最新 TopicSnapshot 的平台加权动量(展示列,§BN)
	`evidence` text NOT NULL,
	`calculated_at` text NOT NULL,
	`scoring_run_id` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tsc_score` ON `topic_score_current` (`score`);--> statement-breakpoint
CREATE INDEX `idx_tsc_lifecycle` ON `topic_score_current` (`lifecycle`);--> statement-breakpoint
CREATE TABLE `topic_lifecycle_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`from_state` text,                       -- null = 首次评定
	`to_state` text NOT NULL,
	`trend_score` real,
	`reason` text NOT NULL,
	`score_version` text NOT NULL,
	`scoring_run_id` integer,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tle_topic` ON `topic_lifecycle_events` (`topic_id`,`occurred_at`);
