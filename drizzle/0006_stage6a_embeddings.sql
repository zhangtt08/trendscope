-- Stage 6A §16-19/25/48: embedding infrastructure (semantic layer base).
-- 语义向量基础设施;Stage 5 DB 原地升级,不删库。

CREATE TABLE `embedding_spaces` (
	`id` text PRIMARY KEY NOT NULL, -- `{providerId}:{model}:{dimension}:{textBuilderVersion}`
	`provider` text NOT NULL,       -- lexical-hash | openai-compatible | …
	`model` text NOT NULL,
	`dimension` integer NOT NULL,
	`text_builder_version` text NOT NULL,
	`mode` text NOT NULL DEFAULT 'lexical', -- lexical | api(§36 UI 标注)
	`is_active` integer NOT NULL DEFAULT 0, -- §35 当前分析默认空间(历史空间保留)
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`embedding_space_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimension` integer NOT NULL,
	`text_hash` text NOT NULL,
	`vector` blob NOT NULL, -- Float32 little-endian, length = dimension*4(§18/§19)
	`text_builder_version` text NOT NULL,
	`superseded_at` text,   -- §28:文本更新后旧行标记 superseded,不物理删除
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_embedding_item_space_hash` ON `content_embeddings` (`content_item_id`,`embedding_space_id`,`text_hash`);--> statement-breakpoint
CREATE INDEX `idx_embedding_space_superseded` ON `content_embeddings` (`embedding_space_id`,`superseded_at`);--> statement-breakpoint
CREATE INDEX `idx_embedding_item` ON `content_embeddings` (`content_item_id`);--> statement-breakpoint
CREATE TABLE `embedding_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`embedding_space_id` text NOT NULL,
	`scope` text NOT NULL DEFAULT 'missing', -- missing | all(§38)
	`status` text NOT NULL DEFAULT 'queued', -- queued|running|completed|partial|failed|cancelled
	`total` integer NOT NULL DEFAULT 0,
	`processed` integer NOT NULL DEFAULT 0,
	`succeeded` integer NOT NULL DEFAULT 0,
	`failed` integer NOT NULL DEFAULT 0,
	`skipped` integer NOT NULL DEFAULT 0, -- §27 cache hits
	`started_at` text,
	`completed_at` text,
	`error` text,                -- safe message(无 Secret,§33)
	`failed_item_ids` text,      -- JSON array(§30)
	`cancel_requested` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_embedding_job_status` ON `embedding_jobs` (`status`,`created_at`);