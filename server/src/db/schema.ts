/**
 * Drizzle schema — Stage 1 data foundation.
 *
 * Layering (Medallion-inspired, borrowed from dlt/dbt practice):
 *   raw_records            = Bronze  (original payload, never mutated)
 *   content_items          = Silver  (normalized, current state)
 *   content_metric_snapshots = time-series observations (append-only)
 *   import_batches         = lineage for every ingestion run
 */
import {
  blob,
  real,
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    platform: text("platform"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    totalRecords: integer("total_records").notNull().default(0),
    successfulRecords: integer("successful_records").notNull().default(0),
    failedRecords: integer("failed_records").notNull().default(0),
    duplicateRecords: integer("duplicate_records").notNull().default(0),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    options: text("options"), // JSON: field mapping etc.
  },
  (t) => [index("idx_import_batches_started_at").on(t.startedAt)],
);

export const rawRecords = sqliteTable(
  "raw_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceType: text("source_type").notNull(),
    platform: text("platform"),
    adapter: text("adapter").notNull(),
    importBatchId: integer("import_batch_id").references(() => importBatches.id),
    /** Original payload exactly as received (JSON string). Never normalized in place. */
    payload: text("payload").notNull(),
    /** Original field names present on the payload (JSON array) — evidence for audits. */
    fieldNames: text("field_names"),
    /** 1-based row index inside the source payload (Stage 2: error inspection). */
    rowIndex: integer("row_index"),
    /** Stage 3 provenance when ingested by a connector run */
    collectionRunId: integer("collection_run_id"),
    connectorId: text("connector_id"),
    connectorVersion: text("connector_version"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_raw_records_import_batch").on(t.importBatchId),
    index("idx_raw_records_platform").on(t.platform),
  ],
);

export const contentItems = sqliteTable(
  "content_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull(),
    platformContentId: text("platform_content_id"),
    contentType: text("content_type").notNull().default("unknown"),
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    authorId: text("author_id"),
    authorName: text("author_name"),
    title: text("title"),
    text: text("text"),
    transcript: text("transcript"),
    /** JSON array of strings */
    hashtags: text("hashtags"),
    publishedAt: text("published_at"),
    /** Stage 2 time provenance — raw value is also preserved inside raw_records. */
    rawPublishedAt: text("raw_published_at"),
    publishedTz: text("published_tz"),
    publishedTzAssumption: text("published_tz_assumption"),
    collectedAt: text("collected_at").notNull(),
    // latest metrics (null = unknown, never 0-by-default)
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    favorites: integer("favorites"),
    upvotes: integer("upvotes"),
    authorFollowers: integer("author_followers"),
    dataQuality: text("data_quality").notNull(),
    /** machine-readable quality reasons, JSON array (Stage 2 §16) */
    qualityReasons: text("quality_reasons"),
    /** merge pointer (Stage 2 §14): set on the source item after confirmed merge */
    mergedIntoContentItemId: integer("merged_into_content_item_id"),
    sourceType: text("source_type").notNull(),
    /** raw record that CREATED this item (provenance of original ingest) */
    rawDataId: integer("raw_data_id").references(() => rawRecords.id),
    /** stable fingerprint for fuzzy duplicate detection (non-authoritative) */
    fingerprint: text("fingerprint"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_content_platform_id")
      .on(t.platform, t.platformContentId)
      .where(sql`${t.platformContentId} IS NOT NULL`),
    uniqueIndex("uq_content_canonical_url")
      .on(t.canonicalUrl)
      .where(sql`${t.canonicalUrl} IS NOT NULL`),
    index("idx_content_published_at").on(t.publishedAt),
    index("idx_content_collected_at").on(t.collectedAt),
    index("idx_content_author_id").on(t.authorId),
    index("idx_content_quality").on(t.dataQuality),
    index("idx_content_fingerprint").on(t.fingerprint),
    index("idx_content_platform").on(t.platform),
  ],
);

export const contentMetricSnapshots = sqliteTable(
  "content_metric_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    capturedAt: text("captured_at").notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    favorites: integer("favorites"),
    upvotes: integer("upvotes"),
    source: text("source").notNull(),
    importBatchId: integer("import_batch_id").references(() => importBatches.id),
  },
  (t) => [
    index("idx_snapshot_item_captured").on(t.contentItemId, t.capturedAt),
    index("idx_snapshot_captured_at").on(t.capturedAt),
    index("idx_snapshot_item_batch").on(t.contentItemId, t.importBatchId),
  ],
);

/** Stage 2 §11: fuzzy matches become candidates — never auto-merged. */
export const duplicateCandidates = sqliteTable(
  "duplicate_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemA: integer("content_item_a")
      .notNull()
      .references(() => contentItems.id),
    contentItemB: integer("content_item_b")
      .notNull()
      .references(() => contentItems.id),
    reason: text("reason").notNull(),
    similarity: integer("similarity"), // 0-10000 (permyriad), optional
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("idx_dup_candidate_status").on(t.status, t.createdAt),
    index("idx_dup_candidate_a").on(t.contentItemA),
    index("idx_dup_candidate_b").on(t.contentItemB),
  ],
);

/** Stage 2 §15: merge audit trail. History stays reconstructable (undo-friendly). */
export const duplicateMergeRecords = sqliteTable(
  "duplicate_merge_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceContentId: integer("source_content_id").notNull(),
    targetContentId: integer("target_content_id").notNull(),
    reason: text("reason").notNull(),
    candidateId: integer("candidate_id"),
    resolvedAt: text("resolved_at").notNull(),
  },
  (t) => [
    index("idx_merge_record_target").on(t.targetContentId),
    index("idx_merge_record_source").on(t.sourceContentId),
  ],
);

/* ============================================================
   Stage 3 → Stage 4 §0 — content picks (Candidate Workbench)
   ============================================================ */

/**
 * One decision row per content item (upsert semantics) — domain 名 ContentPick。
 * 表名 topic_picks 暂保留(迁移成本 > 收益,见 docs/DECISIONS.md);
 * 未来真正的 Topic Engine 不得复用本表/本概念。
 * status: candidate (under review) | adopted (chosen topic) | rejected (passed)
 * momentum_score 列名保留,语义 = 决策时点的 Raw Momentum Score(原始互动动量)。
 */
export const topicPicks = sqliteTable(
  "topic_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("candidate"),
    note: text("note"),
    momentumScore: integer("momentum_score"),
    windowDays: integer("window_days"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_topic_pick_item").on(t.contentItemId),
    index("idx_topic_pick_status").on(t.status, t.updatedAt),
  ],
);

/* ============================================================
   Stage 3 — collection runtime
   ============================================================ */

/** Registered connector metadata (declarations, no secrets). */
export const connectors = sqliteTable("connectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  connectorType: text("connector_type").notNull(), // api | browser | file | mock | other
  sourceAdapterId: text("source_adapter_id").notNull(), // SourceAdapter used for normalization
  version: text("version").notNull(),
  capabilities: text("capabilities").notNull().default("[]"), // JSON array
  defaultTimezone: text("default_timezone"),
  policy: text("policy"), // JSON: default rate limits / min interval
  enabled: integer("enabled").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

/** "我要持续采什么" — connector-specific config validated by the connector's Zod schema. */
export const collectionTasks = sqliteTable(
  "collection_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    connectorId: text("connector_id").notNull(),
    platform: text("platform").notNull(),
    collectionType: text("collection_type").notNull(), // search | hotlist | content | author | custom
    config: text("config").notNull(), // JSON (connector-specific; no secrets — secretRef only)
    schedule: text("schedule"), // JSON: {type:"manual"} | {type:"interval", intervalMs}
    enabled: integer("enabled").notNull().default(1),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_task_enabled_next").on(t.enabled, t.nextRunAt),
    index("idx_task_connector").on(t.connectorId),
  ],
);

/** One execution of a task. Distinct from ImportBatch (§9) — linked via import_batch_id. */
export const collectionRuns = sqliteTable(
  "collection_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    taskName: text("task_name").notNull(), // denormalized: task rows may be deleted, runs remain
    connectorId: text("connector_id").notNull(),
    connectorVersion: text("connector_version").notNull(),
    status: text("status").notNull().default("queued"), // queued|running|completed|partial|failed|cancelled
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    recordsFetched: integer("records_fetched").notNull().default(0),
    recordsAccepted: integer("records_accepted").notNull().default(0),
    recordsFailed: integer("records_failed").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    checkpoint: text("checkpoint"), // JSON cursor/state for resume
    importBatchId: integer("import_batch_id"),
    durationMs: integer("duration_ms"),
    trigger: text("trigger").notNull().default("manual"), // manual | schedule | resume
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_run_task").on(t.taskId, t.createdAt),
    index("idx_run_status").on(t.status),
  ],
);

/** Structured run events (spec §29) — secrets are redacted at write time. */
export const collectionRunEvents = sqliteTable(
  "collection_run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    at: text("at").notNull(),
    type: text("type").notNull(),
    message: text("message"),
    data: text("data"), // JSON, redacted
  },
  (t) => [index("idx_run_event_run").on(t.runId, t.at)],
);

/* ============================================================
   Stage 5 — platform-agnostic discovery observations (§29-31)
   ============================================================ */

/**
 * One row per (content discovered in a source listing) per collection run.
 * Append-only(§30):同一内容今天搜索第 3、明天第 25 —— 各记一行,
 * 绝不覆盖;热榜 rank over time 由此天然形成时间序列(§31)。
 * Platform-agnostic:知乎热榜 rank、抖音搜索排名、小红书搜索排名共用。
 */
export const contentDiscoveryObservations = sqliteTable(
  "content_discovery_observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    collectionRunId: integer("collection_run_id"),
    connectorId: text("connector_id"),
    /** search | hotlist | recommendation */
    discoveryType: text("discovery_type").notNull(),
    /** search query, if the discovery came from a search */
    query: text("query"),
    /** 1-based position in the source listing (null when source gives none) */
    rank: integer("rank"),
    capturedAt: text("captured_at").notNull(),
    /** JSON: platform-specific extras (rankingScore, thumbnailUrl, …) */
    metadata: text("metadata"),
  },
  (t) => [
    index("idx_discovery_item_captured").on(t.contentItemId, t.capturedAt),
    index("idx_discovery_run").on(t.collectionRunId),
    index("idx_discovery_type_captured").on(t.discoveryType, t.capturedAt),
  ],
);

/* ============================================================
   Stage 6A — semantic embedding infrastructure (§16-19/25/48)
   ============================================================ */

/**
 * EmbeddingSpace (§16): stable id `{providerId}:{model}:{dimension}:{textBuilderVersion}`.
 * 不同空间绝不能直接算 cosine;is_active = 当前分析默认空间(历史空间保留,§35)。
 */
export const embeddingSpaces = sqliteTable("embedding_spaces", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  dimension: integer("dimension").notNull(),
  textBuilderVersion: text("text_builder_version").notNull(),
  /** lexical | api(§36 UI 如实标注) */
  mode: text("mode").notNull().default("lexical"),
  isActive: integer("is_active").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

/**
 * ContentEmbedding (§17/§28): 唯一约束 (contentItemId, embeddingSpaceId, textHash)。
 * 文本更新 → 新 hash → 新行;旧行标 superseded_at(不物理删除)。
 * vector = Float32 little-endian BLOB,length 恒等于 dimension*4(§19)。
 */
export const contentEmbeddings = sqliteTable(
  "content_embeddings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimension: integer("dimension").notNull(),
    textHash: text("text_hash").notNull(),
    vector: blob("vector", { mode: "buffer" }).notNull(),
    textBuilderVersion: text("text_builder_version").notNull(),
    supersededAt: text("superseded_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_embedding_item_space_hash").on(t.contentItemId, t.embeddingSpaceId, t.textHash),
    index("idx_embedding_space_superseded").on(t.embeddingSpaceId, t.supersededAt),
    index("idx_embedding_item").on(t.contentItemId),
  ],
);

/**
 * EmbeddingJob (§25): queued|running|completed|partial|failed|cancelled。
 * skipped = textHash 命中缓存的条数(§27);failed_item_ids = JSON 数组(§30);
 * cancel_requested 由取消 API 置位,job 循环检查(§19 边界安全停止)。
 */
export const embeddingJobs = sqliteTable(
  "embedding_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    /** missing | all(§38) */
    scope: text("scope").notNull().default("missing"),
    status: text("status").notNull().default("queued"),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    /** safe message — never a secret(§33) */
    error: text("error"),
    /** JSON array of failed contentItemIds(§30) */
    failedItemIds: text("failed_item_ids"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_embedding_job_status").on(t.status, t.createdAt)],
);

/* ============================================================
   Stage 6B — Topic clustering & governance (§2-7/§27-29/§37/§67)
   ============================================================ */

/** Topic (§2):正式领域对象。status 无 rising/peak/declining(未来 Trend Lifecycle)。 */
export const topics = sqliteTable(
  "topics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    /** active | needs_review | inactive | archived */
    status: text("status").notNull().default("active"),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    /** manual | ai | keyword(§17;manual 永不被自动覆盖,§21) */
    namingSource: text("naming_source").notNull().default("keyword"),
    nameConfidence: real("name_confidence"),
    memberCount: integer("member_count").notNull().default(0),
    /** JSON [top3 representative contentItemIds](§15) */
    representativeItemIds: text("representative_item_ids"),
    /** JSON top keywords(§16) */
    keywords: text("keywords"),
    /** JSON top hashtags */
    hashtags: text("hashtags"),
    cohesion: real("cohesion"),
    firstObservedAt: text("first_observed_at"),
    lastObservedAt: text("last_observed_at"),
    mergedIntoTopicId: integer("merged_into_topic_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [
    index("idx_topics_status").on(t.status, t.memberCount),
    index("idx_topics_space").on(t.embeddingSpaceId),
  ],
);

/**
 * TopicMembership (§3):assignment = automatic|manual|merge|split|move。
 * 每 ContentItem 至多一个 primary membership(UNIQUE content_item_id);
 * manual_lock = 人工指派,自动 Reconcile 不得覆盖(§36)。
 */
export const topicMemberships = sqliteTable(
  "topic_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    contentItemId: integer("content_item_id").notNull(),
    similarityScore: real("similarity_score"),
    assignmentMethod: text("assignment_method").notNull(),
    confidence: real("confidence"),
    analysisRunId: integer("analysis_run_id"),
    manualLock: integer("manual_lock").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_membership_item").on(t.contentItemId),
    index("idx_membership_topic").on(t.topicId),
  ],
);

/** TopicAnalysisRun (§5/§6):全部参数落库保证可复现。 */
export const topicAnalysisRuns = sqliteTable(
  "topic_analysis_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    status: text("status").notNull().default("queued"),
    timeRangeStart: text("time_range_start"),
    timeRangeEnd: text("time_range_end"),
    platformFilter: text("platform_filter"),
    similarityThreshold: real("similarity_threshold").notNull(),
    neighborLimit: integer("neighbor_limit").notNull(),
    minClusterSize: integer("min_cluster_size").notNull(),
    maxClusterSize: integer("max_cluster_size").notNull(),
    minCohesion: real("min_cohesion").notNull(),
    topicIdentityThreshold: real("topic_identity_threshold").notNull(),
    clusteringAlgorithmVersion: text("clustering_algorithm_version").notNull(),
    semanticTextVersion: text("semantic_text_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimension: integer("dimension").notNull(),
    /** lexical_baseline | semantic(§51/§52) */
    qualityMode: text("quality_mode").notNull(),
    contentsConsidered: integer("contents_considered").notNull().default(0),
    contentsEmbedded: integer("contents_embedded").notNull().default(0),
    clustersFound: integer("clusters_found").notNull().default(0),
    topicsCreated: integer("topics_created").notNull().default(0),
    topicsUpdated: integer("topics_updated").notNull().default(0),
    unclusteredCount: integer("unclustered_count").notNull().default(0),
    /** JSON §53 quality 汇总 */
    report: text("report"),
    error: text("error"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_run_status").on(t.status, t.createdAt)],
);

/** TopicSnapshot (§28/§29):append-only,每次成功 Analysis 追加,不覆盖。 */
export const topicSnapshots = sqliteTable(
  "topic_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    analysisRunId: integer("analysis_run_id").notNull(),
    capturedAt: text("captured_at").notNull(),
    memberCount: integer("member_count").notNull(),
    /** §30:相对上一 snapshot 新增成员数 */
    newContentCount: integer("new_content_count").notNull(),
    /** §31:authorId 去重;缺失时 authorName 兜底 */
    activeCreatorCount: integer("active_creator_count"),
    platformCount: integer("platform_count"),
    averageRawMomentum: real("average_raw_momentum"),
    rawEngagementDelta: real("raw_engagement_delta"),
    cohesion: real("cohesion"),
    /** JSON {zhihu: n, douyin: n, ...}(§32) */
    platformDistribution: text("platform_distribution"),
  },
  (t) => [index("idx_snapshot_topic").on(t.topicId, t.capturedAt)],
);

/** TopicEvolutionEvent (§27):created|updated|merged|split|inactive|reactivated|manual_*|renamed */
export const topicEvolutionEvents = sqliteTable("topic_evolution_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  fromTopicIds: text("from_topic_ids"),
  toTopicIds: text("to_topic_ids"),
  analysisRunId: integer("analysis_run_id"),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});

/** TopicWatch (§37):用户关注状态,不是 lifecycle。 */
export const topicWatches = sqliteTable("topic_watches", {
  topicId: integer("topic_id").primaryKey(),
  /** watching | review | ignored */
  state: text("state").notNull().default("watching"),
  updatedAt: text("updated_at").notNull(),
});

/* ============================================================
   Stage 7 — scoring (burst / topic trend / lifecycle)
   append-only 快照 + current 缓存;历史永不覆盖。
   ============================================================ */

/** ScoringRun(§AD):批量评分的可追溯记账。 */
export const scoringRuns = sqliteTable(
  "scoring_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** content_burst | topic_trend */
    scoreProfile: text("score_profile").notNull(),
    /** CONTENT_BURST_V1 | TOPIC_TREND_V1 */
    scoreVersion: text("score_version").notNull(),
    /** running | completed | partial | failed */
    status: text("status").notNull().default("running"),
    timeRangeStart: text("time_range_start"),
    timeRangeEnd: text("time_range_end"),
    contentCount: integer("content_count").notNull().default(0),
    scorableCount: integer("scorable_count").notNull().default(0),
    unscorableCount: integer("unscorable_count").notNull().default(0),
    topicCount: integer("topic_count").notNull().default(0),
    /** JSON:评分时 profile 全量快照(权重/阈值),保证旧结果可解释 */
    configSnapshot: text("config_snapshot").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_scoring_run_profile").on(t.scoreProfile, t.createdAt)],
);

/** ContentScoreSnapshot(§AB):append-only,unscorable 也记录(overall_score=null)。 */
export const contentScoreSnapshots = sqliteTable(
  "content_score_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id").notNull(),
    scoringRunId: integer("scoring_run_id").notNull(),
    scoreType: text("score_type").notNull().default("content_burst"),
    scoreVersion: text("score_version").notNull(),
    scorable: integer("scorable").notNull().default(1),
    /** insufficient_snapshots | insufficient_metrics | insufficient_cohort */
    unscorableReason: text("unscorable_reason"),
    /** null = 不可评分(不是 0 分!) */
    overallScore: real("overall_score"),
    /** high | medium | low */
    confidence: text("confidence"),
    /** JSON:组件分 + 生效权重(missing-aware 重归一后) */
    breakdown: text("breakdown").notNull(),
    /** JSON:窗口/cohort/creator 原始证据 */
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [
    index("idx_css_item_calc").on(t.contentItemId, t.calculatedAt),
    index("idx_css_run").on(t.scoringRunId),
    index("idx_css_score").on(t.overallScore),
  ],
);

/** Latest-score 缓存(§AC):upsert;历史仍在 snapshots。冗余 platform/topic 供 SQL 排序筛选。 */
export const contentScoreCurrent = sqliteTable(
  "content_score_current",
  {
    contentItemId: integer("content_item_id").primaryKey(),
    scoreType: text("score_type").notNull().default("content_burst"),
    scoreVersion: text("score_version").notNull(),
    scorable: integer("scorable").notNull().default(1),
    unscorableReason: text("unscorable_reason"),
    overallScore: real("overall_score"),
    confidence: text("confidence"),
    breakdown: text("breakdown").notNull(),
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
    scoringRunId: integer("scoring_run_id").notNull(),
    platform: text("platform").notNull(),
    topicId: integer("topic_id"),
  },
  (t) => [
    index("idx_csc_score").on(t.overallScore),
    index("idx_csc_platform_score").on(t.platform, t.overallScore),
    index("idx_csc_topic").on(t.topicId),
  ],
);

/** TopicTrendSnapshot(§AM):append-only。 */
export const topicTrendSnapshots = sqliteTable(
  "topic_trend_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    scoringRunId: integer("scoring_run_id").notNull(),
    scoreVersion: text("score_version").notNull(),
    scorable: integer("scorable").notNull().default(1),
    unscorableReason: text("unscorable_reason"),
    score: real("score"),
    confidence: text("confidence"),
    contentGrowth: real("content_growth"),
    engagementGrowth: real("engagement_growth"),
    creatorGrowth: real("creator_growth"),
    burstDensity: real("burst_density"),
    acceleration: real("acceleration"),
    memberCount: integer("member_count").notNull(),
    /** §51-§55 服务端产出的组件分解(旧行为 NULL = 未记录,不得用 0 冒充) */
    componentsJson: text("components_json"),
    effectiveWeightsJson: text("effective_weights_json"),
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [
    index("idx_tts_topic_calc").on(t.topicId, t.calculatedAt),
    index("idx_tts_run").on(t.scoringRunId),
  ],
);

/** Topic current(§AM/§AN):latest trend + lifecycle 状态机状态(含 pending)。 */
export const topicScoreCurrent = sqliteTable(
  "topic_score_current",
  {
    topicId: integer("topic_id").primaryKey(),
    scoreVersion: text("score_version").notNull(),
    scorable: integer("scorable").notNull().default(1),
    unscorableReason: text("unscorable_reason"),
    score: real("score"),
    confidence: text("confidence"),
    /** emerging|rising|peak|saturated|declining|evergreen;null=数据不足 */
    lifecycle: text("lifecycle"),
    /** hysteresis 待确认状态(连续 2 次观察才切换) */
    pendingLifecycle: text("pending_lifecycle"),
    pendingCount: integer("pending_count").notNull().default(0),
    contentGrowth: real("content_growth"),
    engagementGrowth: real("engagement_growth"),
    creatorGrowth: real("creator_growth"),
    burstDensity: real("burst_density"),
    acceleration: real("acceleration"),
    memberCount: integer("member_count").notNull(),
    recentNewContent: integer("recent_new_content"),
    activeCreators: integer("active_creators"),
    avgRawMomentum: real("avg_raw_momentum"),
    /** §51-§55 组件分解 + 有效权重(与快照同形,便于列表页直接展开) */
    componentsJson: text("components_json"),
    effectiveWeightsJson: text("effective_weights_json"),
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
    scoringRunId: integer("scoring_run_id").notNull(),
  },
  (t) => [
    index("idx_tsc_score").on(t.score),
    index("idx_tsc_lifecycle").on(t.lifecycle),
  ],
);

/** TopicLifecycleEvent(§AW):append-only 状态迁移审计。 */
export const topicLifecycleEvents = sqliteTable(
  "topic_lifecycle_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    /** null = 首次评定 */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    trendScore: real("trend_score"),
    reason: text("reason").notNull(),
    scoreVersion: text("score_version").notNull(),
    scoringRunId: integer("scoring_run_id"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [index("idx_tle_topic").on(t.topicId, t.occurredAt)],
);

/* ============================================================
   Stage 8 — content intelligence(爆发共性 / 饱和度 / 新颖度)
   feature 记录缓存;pattern/saturation/novelty append-only;
   angle clusters 持久化调和;current 为 SQL 查询缓存。
   ============================================================ */

/** ContentIntelligenceRun(§60):三个引擎版本 + 记账。 */
export const intelligenceRuns = sqliteTable(
  "intelligence_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureVersion: text("feature_version").notNull(),
    patternVersion: text("pattern_version").notNull(),
    saturationVersion: text("saturation_version").notNull(),
    noveltyVersion: text("novelty_version").notNull(),
    angleTextVersion: text("angle_text_version").notNull(),
    timeRangeStart: text("time_range_start"),
    timeRangeEnd: text("time_range_end"),
    topicsAnalyzed: integer("topics_analyzed").notNull().default(0),
    contentsAnalyzed: integer("contents_analyzed").notNull().default(0),
    patternScorable: integer("pattern_scorable").notNull().default(0),
    patternInsufficient: integer("pattern_insufficient").notNull().default(0),
    saturatedScorable: integer("saturated_scorable").notNull().default(0),
    saturatedInsufficient: integer("saturated_insufficient").notNull().default(0),
    noveltyScorable: integer("novelty_scorable").notNull().default(0),
    emergingAngleCount: integer("emerging_angle_count").notNull().default(0),
    status: text("status").notNull().default("running"),
    configSnapshot: text("config_snapshot").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_intel_run_created").on(t.createdAt)],
);

/** ContentFeatureRecord(§15):textHash+featureVersion 命中即复用,避免重复分析文本。 */
export const contentFeatureRecords = sqliteTable(
  "content_feature_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentItemId: integer("content_item_id").notNull(),
    textHash: text("text_hash").notNull(),
    featureVersion: text("feature_version").notNull(),
    extractor: text("extractor").notNull(),
    model: text("model"),
    /** JSON: { deterministic: {...}, semantic: {...} | null, semanticUnavailable?: string } */
    features: text("features").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_feature_item_version_hash").on(t.contentItemId, t.featureVersion, t.textHash)],
);

/** PatternResult(§22):append-only;lift 是观察到的关联,不是因果(§17)。 */
export const patternResults = sqliteTable(
  "pattern_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    /** topic | platform_global */
    scope: text("scope").notNull().default("topic"),
    topicId: integer("topic_id"),
    platform: text("platform"),
    windowHours: integer("window_hours").notNull(),
    feature: text("feature").notNull(),
    /** boolean | continuous | categorical */
    featureKind: text("feature_kind").notNull(),
    viralValue: text("viral_value").notNull(),
    controlValue: text("control_value").notNull(),
    lift: real("lift"),
    delta: real("delta"),
    viralSampleSize: integer("viral_sample_size").notNull(),
    controlSampleSize: integer("control_sample_size").notNull(),
    /** high | medium | low | insufficient */
    evidenceQuality: text("evidence_quality").notNull(),
    /** JSON: controlMatchLevel / smoothingApplied / direction(positive|negative) */
    notes: text("notes").notNull(),
    featureVersion: text("feature_version").notNull(),
    patternVersion: text("pattern_version").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [
    index("idx_pattern_run").on(t.runId),
    index("idx_pattern_topic").on(t.topicId, t.calculatedAt),
  ],
);

/** TopicSaturationSnapshot(§63):append-only,可回看话题从低饱和变高饱和。 */
export const topicSaturationSnapshots = sqliteTable(
  "topic_saturation_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    runId: integer("run_id").notNull(),
    /** null = unscorable(数据不足,绝不 0) */
    score: real("score"),
    confidence: text("confidence"),
    unscorableReason: text("unscorable_reason"),
    breakdown: text("breakdown").notNull(),
    evidence: text("evidence").notNull(),
    version: text("version").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [index("idx_sat_snap_topic").on(t.topicId, t.calculatedAt)],
);

/** TopicNoveltySnapshot(§64):append-only。 */
export const topicNoveltySnapshots = sqliteTable(
  "topic_novelty_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    runId: integer("run_id").notNull(),
    score: real("score"),
    emergingAngleCount: integer("emerging_angle_count").notNull().default(0),
    confidence: text("confidence"),
    unscorableReason: text("unscorable_reason"),
    evidence: text("evidence").notNull(),
    version: text("version").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [index("idx_nov_snap_topic").on(t.topicId, t.calculatedAt)],
);

/** TopicAngleCluster(§46):持久化,跨 Run 按质心相似度调和稳定 ID。 */
export const topicAngleClusters = sqliteTable(
  "topic_angle_clusters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    label: text("label").notNull(),
    /** keyword | ai | manual(§50,manual 永不被覆盖) */
    labelSource: text("label_source").notNull().default("keyword"),
    memberCount: integer("member_count").notNull(),
    firstObservedAt: text("first_observed_at").notNull(),
    lastObservedAt: text("last_observed_at").notNull(),
    /** JSON [contentItemIds] 代表内容 */
    representativeItemIds: text("representative_item_ids").notNull(),
    /** Float32 LE 质心(角度向量空间) */
    centroid: blob("centroid", { mode: "buffer" }),
    dimension: integer("dimension"),
    noveltyScore: real("novelty_score"),
    isEmerging: integer("is_emerging").notNull().default(0),
    /** active | inactive */
    status: text("status").notNull().default("active"),
    lastRunId: integer("last_run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_angle_cluster_topic").on(t.topicId, t.status)],
);

/** topic_intelligence_current(§73):SQL 排序分页缓存。 */
export const topicIntelligenceCurrent = sqliteTable(
  "topic_intelligence_current",
  {
    topicId: integer("topic_id").primaryKey(),
    saturationScore: real("saturation_score"),
    saturatedConfidence: text("saturated_confidence"),
    saturationVersion: text("saturation_version"),
    noveltyScore: real("novelty_score"),
    emergingAngleCount: integer("emerging_angle_count"),
    noveltyConfidence: text("novelty_confidence"),
    noveltyVersion: text("novelty_version"),
    calculatedAt: text("calculated_at").notNull(),
    runId: integer("run_id").notNull(),
  },
  (t) => [
    index("idx_intel_cur_saturation").on(t.saturationScore),
    index("idx_intel_cur_novelty").on(t.noveltyScore),
  ],
);

/* ============================================================
   Stage 9 — opportunity engine(选题机会指数)
   snapshot append-only;current 为查询缓存;decision 与 TopicWatch 分离。
   ============================================================ */

/** OpportunityRun(§21)。 */
export const opportunityRuns = sqliteTable(
  "opportunity_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    version: text("version").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    status: text("status").notNull().default("running"),
    topicsConsidered: integer("topics_considered").notNull().default(0),
    scored: integer("scored").notNull().default(0),
    unscorable: integer("unscorable").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    configSnapshot: text("config_snapshot").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_opp_run_created").on(t.createdAt)],
);

/** TopicOpportunitySnapshot(§19):append-only,含六组件贡献与 whyChanged。 */
export const topicOpportunitySnapshots = sqliteTable(
  "topic_opportunity_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    runId: integer("run_id").notNull(),
    /** null = unscorable(数据不足,绝不 0) */
    score: real("score"),
    scoreVersion: text("score_version").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    confidence: text("confidence"),
    unscorableReason: text("unscorable_reason"),
    trendContribution: real("trend_contribution"),
    burstContribution: real("burst_contribution"),
    noveltyContribution: real("novelty_contribution"),
    whitespaceContribution: real("whitespace_contribution"),
    patternContribution: real("pattern_contribution"),
    lifecycleContribution: real("lifecycle_contribution"),
    /** JSON:重归一后生效权重 */
    effectiveWeights: text("effective_weights").notNull(),
    /** vs 上一 snapshot(§42) */
    deltaScore: real("delta_score"),
    /** JSON:组件贡献差 Top 列表(§41 deterministic) */
    whyChanged: text("why_changed"),
    /** JSON:reasonCodes/正向/限制/新鲜度 */
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
  },
  (t) => [
    index("idx_opp_snap_topic").on(t.topicId, t.calculatedAt),
    index("idx_opp_snap_run").on(t.runId),
    index("idx_opp_snap_score").on(t.score),
  ],
);

/** current(§20):latest 查询缓存。 */
export const topicOpportunityCurrent = sqliteTable(
  "topic_opportunity_current",
  {
    topicId: integer("topic_id").primaryKey(),
    score: real("score"),
    confidence: text("confidence"),
    /** high | medium | low(§27 区间档,集中配置) */
    opportunityLevel: text("opportunity_level"),
    unscorableReason: text("unscorable_reason"),
    deltaScore: real("delta_score"),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    scoreVersion: text("score_version").notNull(),
    evidence: text("evidence").notNull(),
    calculatedAt: text("calculated_at").notNull(),
    runId: integer("run_id").notNull(),
  },
  (t) => [
    index("idx_opp_cur_score").on(t.score),
    index("idx_opp_cur_conf").on(t.confidence),
  ],
);

/** OpportunityDecision(§36-§38):人工决策状态,不影响分数(§37)。 */
export const opportunityDecisions = sqliteTable(
  "opportunity_decisions",
  {
    topicId: integer("topic_id").primaryKey(),
    /** shortlisted | reviewing | dismissed | none */
    status: text("status").notNull().default("none"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_opp_decision_status").on(t.status, t.updatedAt)],
);

/* ============================================================
   Stage 9.5 — Opportunity Profile 治理(§23-§30)
   版本不可原地修改;当前模型唯一;archive 不物理删除。
   ============================================================ */

export const opportunityProfiles = sqliteTable(
  "opportunity_profiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 同一 profile 的多个版本共享这个 key(§24) */
    profileKey: text("profile_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** BALANCED_V1 / BALANCED_V2 …;写入快照后即为 immutable 标识 */
    version: text("version").notNull(),
    /** active | archived(§42:不做物理删除) */
    status: text("status").notNull().default("active"),
    /** 全表只允许一行为 1(部分唯一索引) */
    isActive: integer("is_active").notNull().default(0),
    weightsJson: text("weights_json").notNull(),
    freshnessJson: text("freshness_json").notNull(),
    minimumEvidenceJson: text("minimum_evidence_json").notNull(),
    lifecycleFitJson: text("lifecycle_fit_json").notNull(),
    /** levelBands / confidence 阈值 / burstMix 等引擎侧参数(§37 折叠区) */
    tuningJson: text("tuning_json").notNull(),
    createdFromProfileId: integer("created_from_profile_id"),
    createdAt: text("created_at").notNull(),
    activatedAt: text("activated_at"),
    archivedAt: text("archived_at"),
  },
  (t) => [
    uniqueIndex("uq_profile_key_version").on(t.profileKey, t.version),
    uniqueIndex("uq_profile_single_active")
      .on(t.isActive)
      .where(sql`${t.isActive} = 1`),
    index("idx_profile_status").on(t.status, t.profileKey),
  ],
);

/* ============================================================
   Release 1.0 · AI Topic Studio
   历史只追加不覆盖;人工状态(保存/收藏/废弃)与生成结果分离。
   ============================================================ */

export const topicStudioRuns = sqliteTable(
  "topic_studio_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id").notNull(),
    /** running | completed | failed */
    status: text("status").notNull().default("running"),
    /** ai | evidence_brief —— UI 标签必须区分,不得把规则产物标成 AI 建议 */
    kind: text("kind").notNull().default("ai"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    evidenceVersion: text("evidence_version").notNull(),
    /** 相同证据可复用上次结果的判据 */
    evidenceHash: text("evidence_hash").notNull(),
    inputSnapshot: text("input_snapshot").notNull(),
    output: text("output"),
    unsupportedClaims: text("unsupported_claims"),
    evidenceTruncated: text("evidence_truncated"),
    usage: text("usage"),
    error: text("error"),
    demoData: integer("demo_data").notNull().default(0),
    staleEvidence: integer("stale_evidence").notNull().default(0),
    durationMs: integer("duration_ms"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_studio_run_topic_time").on(t.topicId, t.createdAt),
    index("idx_studio_run_evidence_hash").on(t.evidenceHash, t.status),
    index("idx_studio_run_status").on(t.status, t.startedAt),
  ],
);

export const topicStudioMarks = sqliteTable(
  "topic_studio_marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    topicId: integer("topic_id").notNull(),
    /** null = 整份方案;非 null = recommendedAngles 下标 */
    angleIndex: integer("angle_index"),
    /** saved | favorite | discarded */
    state: text("state").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_studio_mark_run_angle").on(t.runId, t.angleIndex),
    index("idx_studio_mark_topic_state").on(t.topicId, t.state),
  ],
);

/** 一键全分析的编排进度(§38/§39)。只记录过程,不记录业务结论。 */
export const analysisRuns = sqliteTable(
  "analysis_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** running | completed | partial | failed */
    status: text("status").notNull().default("running"),
    triggerSource: text("trigger_source").notNull().default("manual"),
    currentStep: text("current_step"),
    /** JSON [{key,label,state,startedAt,finishedAt,error,result}] */
    steps: text("steps").notNull().default("[]"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("idx_analysis_run_status").on(t.status, t.startedAt)],
);
