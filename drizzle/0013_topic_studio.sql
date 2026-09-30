-- 0013_topic_studio.sql
-- Release 1.0 · AI Topic Studio。
-- 历史不可覆盖(§20):每次生成追加一行;人工状态(收藏/废弃/备注)单独建表,
-- 不写回生成结果 —— 分数与人工判断分离的老规矩同样适用于 Studio。
-- 新表全部带外键(§73),连接层 foreign_keys=ON 已在 openDb 打开。

CREATE TABLE `topic_studio_runs` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `topic_id` INTEGER NOT NULL REFERENCES `topics`(`id`) ON DELETE CASCADE,
  /** running | completed | failed —— 绝不用 completed 冒充降级结果 */
  `status` TEXT NOT NULL DEFAULT 'running',
  /** 本次是 AI 生成还是确定性证据摘要(UI 标签必须区分,禁止假 AI) */
  `kind` TEXT NOT NULL DEFAULT 'ai',
  `provider` TEXT,
  `model` TEXT,
  `prompt_version` TEXT NOT NULL,
  `schema_version` TEXT NOT NULL,
  `evidence_version` TEXT NOT NULL,
  /** 相同证据可复用上次结果的判据(§19) */
  `evidence_hash` TEXT NOT NULL,
  `input_snapshot` TEXT NOT NULL,
  `output` TEXT,
  /** 幻觉护栏扫描结果:输出里证据不支持的数字/权威说法 */
  `unsupported_claims` TEXT,
  `evidence_truncated` TEXT,
  `usage` TEXT,
  `error` TEXT,
  `demo_data` INTEGER NOT NULL DEFAULT 0,
  `stale_evidence` INTEGER NOT NULL DEFAULT 0,
  `duration_ms` integer,
  `started_at` TEXT NOT NULL,
  `completed_at` TEXT,
  `created_at` TEXT NOT NULL
);

--> statement-breakpoint
CREATE INDEX `idx_studio_run_topic_time` ON `topic_studio_runs` (`topic_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_studio_run_evidence_hash` ON `topic_studio_runs` (`evidence_hash`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_studio_run_status` ON `topic_studio_runs` (`status`,`started_at`);
--> statement-breakpoint

CREATE TABLE `topic_studio_marks` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `run_id` INTEGER NOT NULL REFERENCES `topic_studio_runs`(`id`) ON DELETE CASCADE,
  `topic_id` INTEGER NOT NULL REFERENCES `topics`(`id`) ON DELETE CASCADE,
  /** NULL = 对整份方案的操作;非 NULL = 针对 recommendedAngles 下标 */
  `angle_index` INTEGER,
  /** saved | favorite | discarded */
  `state` TEXT NOT NULL,
  `note` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `uq_studio_mark_run_angle` ON `topic_studio_marks` (`run_id`, `angle_index`);
--> statement-breakpoint
CREATE INDEX `idx_studio_mark_topic_state` ON `topic_studio_marks` (`topic_id`,`state`);
