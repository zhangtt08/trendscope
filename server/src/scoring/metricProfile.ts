/**
 * PlatformMetricProfile (Stage 7 §Q):跨平台指标语义映射。
 * 知乎 upvotes 承接"主互动"语义但绝不写入 likes(Stage 5 D8 延续);
 * 分数引擎不感知平台细节,全部经由此表(以后加 douyin/xiaohongshu 不改核心)。
 * 动量权重复用 trendService 的平台权重表(单一事实来源,不复制公式)。
 */
import { deltaMetricsFor, SCORE_WEIGHTS, type DeltaMetricName } from "../services/trendService";

export interface PlatformMetricProfile {
  id: string;
  /** 主互动字段(zhihu=upvotes,其余=likes)——参与 EQ 分母与结构分 */
  primaryReaction: "upvotes" | "likes";
  /** 深互动(高成本行为):评论/分享/收藏 */
  deepReactions: readonly DeltaMetricName[];
  /** velocity 纳入动量的指标(= Raw Momentum 同源,禁另造) */
  velocityMetrics: readonly DeltaMetricName[];
  /** 结构分参与百分位的组件(主互动 + 深互动) */
  structureComponents: readonly DeltaMetricName[];
}

const GENERIC: PlatformMetricProfile = {
  id: "generic",
  primaryReaction: "likes",
  deepReactions: ["comments", "shares", "favorites"],
  velocityMetrics: deltaMetricsFor("generic"),
  structureComponents: ["likes", "comments", "shares", "favorites"],
};

const ZHIHU: PlatformMetricProfile = {
  id: "zhihu",
  primaryReaction: "upvotes",
  deepReactions: ["comments", "shares", "favorites"],
  velocityMetrics: deltaMetricsFor("zhihu"),
  structureComponents: ["upvotes", "comments", "shares", "favorites"],
};

/** fixture/manual/csv 等一律 generic;zhihu 单独;未来平台在此注册。 */
export function platformMetricProfile(platform: string | null | undefined): PlatformMetricProfile {
  return platform === "zhihu" ? ZHIHU : GENERIC;
}

/** 动量权重表暴露(透明可解释;与 trendService 同源)。 */
export function momentumWeights(platform: string | null | undefined): Partial<Record<DeltaMetricName, number>> {
  return platform === "zhihu" ? { ...SCORE_WEIGHTS, upvotes: 1 } : { ...SCORE_WEIGHTS };
}
