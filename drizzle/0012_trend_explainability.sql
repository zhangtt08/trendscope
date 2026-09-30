-- 0012_trend_explainability.sql
-- Stage 9.5 §49-§55:话题趋势分解必须由服务端产出并保存,前端只消费(§50 唯一真源)。
-- 引擎早就算出了五组件分与 missing-aware 后的有效权重,此前只落在列里的裸分数上,
-- 导致 Trends 展开区读不到 breakdown、而话题页另写了一份硬编码权重(必然漂移)。
--
-- 新增列对既有行留 NULL:那些 Run 确实没记录分解,UI 必须显示"该版本未记录组件分解",
-- 绝不能用 0 或当前权重反推冒充(违反 null ≠ 0 红线)。

ALTER TABLE `topic_trend_snapshots` ADD COLUMN `components_json` TEXT;
--> statement-breakpoint
ALTER TABLE `topic_trend_snapshots` ADD COLUMN `effective_weights_json` TEXT;
--> statement-breakpoint
ALTER TABLE `topic_score_current` ADD COLUMN `components_json` TEXT;
--> statement-breakpoint
ALTER TABLE `topic_score_current` ADD COLUMN `effective_weights_json` TEXT;
