/**
 * TopicClusteringConfig (Stage 6A→6B §9/§10/§24) — 禁止 magic numbers 散落。
 * Lexical 与 Semantic 空间的相似度分布不同,默认阈值分离且透明可查(§10)。
 */
export const CLUSTERING_ALGORITHM_VERSION = "topic-cluster-v1";

export interface TopicClusteringConfig {
  /** 建边阈值:cosine ≥ threshold 才有边 */
  similarityThreshold: number;
  /** 每条内容最多保留的邻居边数(§8) */
  neighborLimit: number;
  /** 低于该大小不建正式 Topic,进入 Unclustered(§11) */
  minClusterSize: number;
  /** 超过该大小触发 giant cluster guard(§13) */
  maxClusterSize: number;
  /** 平均代表相似度低于该值 → needs_review(§13/§14) */
  minCohesion: number;
  /** §24 Reconciliation Jaccard 阈值(集中配置,写入 DECISIONS) */
  topicIdentityThreshold: number;
}

/** 按 EmbeddingSpace.mode 分离的默认值(§10),全部透明可查 */
export const DEFAULT_CONFIG: Record<"lexical" | "semantic", TopicClusteringConfig> = {
  lexical: {
    similarityThreshold: 0.3, // golden 实测校准:same-topic p50=0.30,diff p99=0.22(§61 用真实结果定 baseline)
    neighborLimit: 24,
    minClusterSize: 3,
    maxClusterSize: 400,
    minCohesion: 0.55,
    topicIdentityThreshold: 0.3,
  },
  semantic: {
    similarityThreshold: 0.72,
    neighborLimit: 32,
    minClusterSize: 3,
    maxClusterSize: 400,
    minCohesion: 0.6,
    topicIdentityThreshold: 0.3,
  },
};

export function defaultConfigFor(mode: string): TopicClusteringConfig {
  return { ...(mode === "api" ? DEFAULT_CONFIG.semantic : DEFAULT_CONFIG.lexical) };
}

/** 用户覆盖只允许合理区间,拒绝荒谬参数(§9 集中校验) */
export function mergeConfig(base: TopicClusteringConfig, override: Partial<TopicClusteringConfig> | undefined): TopicClusteringConfig {
  if (!override) return { ...base };
  const merged = { ...base };
  if (override.similarityThreshold !== undefined)
    merged.similarityThreshold = Math.min(0.99, Math.max(0.05, override.similarityThreshold));
  if (override.neighborLimit !== undefined)
    merged.neighborLimit = Math.min(200, Math.max(3, Math.trunc(override.neighborLimit)));
  if (override.minClusterSize !== undefined)
    merged.minClusterSize = Math.min(50, Math.max(2, Math.trunc(override.minClusterSize)));
  if (override.maxClusterSize !== undefined)
    merged.maxClusterSize = Math.max(merged.minClusterSize, Math.trunc(override.maxClusterSize));
  if (override.minCohesion !== undefined)
    merged.minCohesion = Math.min(0.99, Math.max(0, override.minCohesion));
  if (override.topicIdentityThreshold !== undefined)
    merged.topicIdentityThreshold = Math.min(0.99, Math.max(0.05, override.topicIdentityThreshold));
  return merged;
}
