-- 0014_analysis_runs.sql
-- Release 1.0 · WP2:一键全分析要能显示"当前第几步 / 哪一步失败 / 前面成功的保留"(§37-§39)。
-- 这张表只记录编排过程,不记录业务结论 —— 各引擎自己的表仍是唯一事实来源。
-- 表内没有任何外部引用,因此不存在孤儿行通路(§73);业务外键仍由 0013 等migration负责。

CREATE TABLE `analysis_runs` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `status` TEXT NOT NULL DEFAULT 'running',
  `trigger_source` TEXT NOT NULL DEFAULT 'manual',
  `current_step` TEXT,
  `steps` TEXT NOT NULL DEFAULT '[]',
  `error` TEXT,
  `started_at` TEXT NOT NULL,
  `finished_at` TEXT,
  `duration_ms` integer
);

--> statement-breakpoint
CREATE INDEX `idx_analysis_run_status` ON `analysis_runs` (`status`,`started_at`);
