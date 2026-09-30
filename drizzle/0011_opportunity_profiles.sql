-- 0011_opportunity_profiles.sql
-- Stage 9.5 §23:Opportunity Profile 从"只在代码里"升级为可治理的持久化模型。
-- 种子两行必须与 server/src/opportunity/profiles.ts 的 BALANCED_PROFILE /
-- EARLY_DISCOVERY_PROFILE 逐字段一致(tests/integration/opportunity-profile.test.ts
-- 有深比较断言锁死这条不变量),否则历史快照引用的 profileVersion 无法复现。
-- 硬规则(§24/§25):已存版本不可原地修改;改权重 = 新建版本;被 Snapshot 引用的版本永远保留。
-- 引擎用的完整配置由这些列无损重建:weights + freshness + minimum_evidence +
-- lifecycle_fit + tuning(levelBands/confidence/burstMix/…);每次 Run 仍写自己的
-- config_snapshot(opportunity_runs 已有),所以这里不重复存快照。

CREATE TABLE `opportunity_profiles` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `profile_key` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT,
  `version` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'active',
  `is_active` INTEGER NOT NULL DEFAULT 0,
  `weights_json` TEXT NOT NULL,
  `freshness_json` TEXT NOT NULL,
  `minimum_evidence_json` TEXT NOT NULL,
  `lifecycle_fit_json` TEXT NOT NULL,
  `tuning_json` TEXT NOT NULL,
  `created_from_profile_id` INTEGER,
  `created_at` TEXT NOT NULL,
  `activated_at` TEXT,
  `archived_at` TEXT
);

--> statement-breakpoint
CREATE UNIQUE INDEX `uq_profile_key_version` ON `opportunity_profiles` (`profile_key`,`version`);
--> statement-breakpoint
-- 只允许一个"当前模型"(§29/§30:切换只影响之后的新 Run)
CREATE UNIQUE INDEX `uq_profile_single_active` ON `opportunity_profiles` (`is_active`) WHERE `is_active` = 1;
--> statement-breakpoint
CREATE INDEX `idx_profile_status` ON `opportunity_profiles` (`status`,`profile_key`);
--> statement-breakpoint

INSERT INTO `opportunity_profiles`
  (`profile_key`,`name`,`description`,`version`,`status`,`is_active`,
   `weights_json`,`freshness_json`,`minimum_evidence_json`,`lifecycle_fit_json`,`tuning_json`,`created_at`)
VALUES
  ('balanced','均衡','默认分析偏好:六组件加权量化当前可研究程度,不预测未来结果','BALANCED_V1','active',1,
   '{"trend":0.3,"burst":0.2,"novelty":0.15,"whitespace":0.15,"pattern":0.1,"lifecycle":0.1}',
   '{"trendMaxAgeHours":24,"intelligenceMaxAgeHours":48,"penaltyStale":0.1}',
   '{"minimumAvailableComponents":3}',
   '{"emerging":65,"rising":85,"peak":70,"saturated":45,"declining":25,"evergreen":55,"unknown":null}',
   '{"levelBands":{"high":70,"medium":40},"confValue":{"high":1,"medium":0.7,"low":0.4},"confidenceHigh":0.75,"confidenceMedium":0.45,"penaltyFewMembers":0.2,"fewMembers":10,"penaltyLexicalBaseline":0.1,"penaltyLowBurstCoverage":0.1,"lowBurstCoverage":0.5,"burstMix":{"density":0.5,"p75":0.3,"recentCount":0.2},"recentBurstWindowHours":168}',
   '2026-09-27T00:00:00.000Z'),
  ('early_discovery','早期发现','偏重新颖度与内容空间的分析偏好;只是偏好,不是更准确的算法','EARLY_DISCOVERY_V1','active',0,
   '{"trend":0.25,"burst":0.15,"novelty":0.25,"whitespace":0.2,"pattern":0.05,"lifecycle":0.1}',
   '{"trendMaxAgeHours":24,"intelligenceMaxAgeHours":48,"penaltyStale":0.1}',
   '{"minimumAvailableComponents":3}',
   '{"emerging":65,"rising":85,"peak":70,"saturated":45,"declining":25,"evergreen":55,"unknown":null}',
   '{"levelBands":{"high":70,"medium":40},"confValue":{"high":1,"medium":0.7,"low":0.4},"confidenceHigh":0.75,"confidenceMedium":0.45,"penaltyFewMembers":0.2,"fewMembers":10,"penaltyLexicalBaseline":0.1,"penaltyLowBurstCoverage":0.1,"lowBurstCoverage":0.5,"burstMix":{"density":0.5,"p75":0.3,"recentCount":0.2},"recentBurstWindowHours":168}',
   '2026-09-27T00:00:00.000Z');
