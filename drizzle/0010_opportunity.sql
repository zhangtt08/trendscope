-- Stage 9 §19-§21/§36/§73: opportunity infrastructure.
-- topic_opportunity_snapshots append-only;current 为 SQL 查询缓存;
-- opportunity_decisions 是人工决策状态(与 TopicWatch 分离,不影响分数,§36/§37)。
-- 真机原地升级,不删库。

CREATE TABLE `opportunity_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_version` text NOT NULL,
	`status` text NOT NULL DEFAULT 'running',
	`topics_considered` integer NOT NULL DEFAULT 0,
	`scored` integer NOT NULL DEFAULT 0,
	`unscorable` integer NOT NULL DEFAULT 0,
	`failed` integer NOT NULL DEFAULT 0,
	`config_snapshot` text NOT NULL,
	`duration_ms` integer,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_opp_run_created` ON `opportunity_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `topic_opportunity_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`score` real,
	`score_version` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_version` text NOT NULL,
	`confidence` text,
	`unscorable_reason` text,
	`trend_contribution` real,
	`burst_contribution` real,
	`novelty_contribution` real,
	`whitespace_contribution` real,
	`pattern_contribution` real,
	`lifecycle_contribution` real,
	`effective_weights` text NOT NULL,      -- JSON(重归一后)
	`delta_score` real,                     -- vs 上一 snapshot
	`why_changed` text,                     -- JSON:组件贡献差 Top 列表(§41)
	`evidence` text NOT NULL,               -- JSON:reasonCodes/正向/限制/新鲜度
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_opp_snap_topic` ON `topic_opportunity_snapshots` (`topic_id`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `idx_opp_snap_run` ON `topic_opportunity_snapshots` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_opp_snap_score` ON `topic_opportunity_snapshots` (`score`);--> statement-breakpoint
CREATE TABLE `topic_opportunity_current` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`score` real,
	`confidence` text,
	`opportunity_level` text,
	`unscorable_reason` text,
	`delta_score` real,
	`profile_id` text NOT NULL,
	`profile_version` text NOT NULL,
	`score_version` text NOT NULL,
	`evidence` text NOT NULL,
	`calculated_at` text NOT NULL,
	`run_id` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_opp_cur_score` ON `topic_opportunity_current` (`score`);--> statement-breakpoint
CREATE INDEX `idx_opp_cur_conf` ON `topic_opportunity_current` (`confidence`);--> statement-breakpoint
CREATE TABLE `opportunity_decisions` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL DEFAULT 'none',  -- shortlisted | reviewing | dismissed | none
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_opp_decision_status` ON `opportunity_decisions` (`status`,`updated_at`);
