/**
 * Confidence (Stage 7 §Z/§AL):确定性置信度,证据充分度驱动。
 * 有分必有置信;低分必须能在 UI 解释原因(§BU)。不依赖真实时间(§CD)。
 */
import type { ContentBurstProfile, TopicTrendProfile } from "./profiles";

export type ConfidenceLabel = "high" | "medium" | "low";

export interface ConfidenceInput {
  snapshotCount: number;
  /** 快照时间跨度(小时);无快照 → 0 */
  spanHours: number;
  cohortSize: number | null;
  /** 可用信号占比 0-1(1 = 全部权重项可用) */
  availableSignalRatio: number;
  creatorHistoryCount?: number | null;
}

export function labelFor(score: number, high: number, medium: number): ConfidenceLabel {
  if (score >= high) return "high";
  if (score >= medium) return "medium";
  return "low";
}

/**
 * Content Burst 置信度:base 1.0 依次扣减(顺序固定,可解释):
 * 单快照(无速度证据)-0.25;时间跨度 <1h -0.1;cohort<30 -0.1、<10 -0.2(不叠加取大);
 * 可用信号 ≤50% -0.15。≥0.75 high,≥0.45 medium,否则 low。
 */
export function burstConfidence(
  input: ConfidenceInput,
  profile: ContentBurstProfile,
): { score: number; label: ConfidenceLabel; reasons: string[] } {
  const c = profile.confidence;
  const reasons: string[] = [];
  let score = 1;
  if (input.snapshotCount < 2) {
    score -= c.penaltySingleSnapshot;
    reasons.push(`仅 ${input.snapshotCount} 次快照,无速度证据`);
  }
  if (input.snapshotCount >= 2 && input.spanHours > 0 && input.spanHours < c.shortSpanHours) {
    score -= c.penaltyShortSpan;
    reasons.push(`观察时间跨度不足 ${c.shortSpanHours} 小时`);
  }
  if (input.cohortSize !== null) {
    if (input.cohortSize < 10) {
      score -= c.penaltyTinyCohort;
      reasons.push(`比较样本过小(n=${input.cohortSize})`);
    } else if (input.cohortSize < 30) {
      score -= c.penaltySmallCohort;
      reasons.push(`比较样本较小(n=${input.cohortSize})`);
    }
  }
  if (input.availableSignalRatio <= 0.5) {
    score -= c.penaltyLowSignal;
    reasons.push("可用指标不足一半(缺失项已按权重重归一)");
  }
  if (input.creatorHistoryCount === null || input.creatorHistoryCount === undefined) {
    reasons.push("作者历史不足,相对表现退回同组比较");
    score -= 0.05;
  }
  score = Math.max(0, Math.min(1, score));
  return { score: Math.round(score * 100) / 100, label: labelFor(score, c.high, c.medium), reasons };
}

/**
 * Topic Trend 置信度(§AL):成员少 -0.15;TopicSnapshot <3 -0.15;
 * 爆发分覆盖率 ≤50% -0.2(内容评分未跑/覆盖低)。≤0.75/0.45 同表。
 */
export function topicConfidence(
  input: { memberCount: number; snapshotCount: number; scoreCoverage: number },
  profile: TopicTrendProfile,
): { score: number; label: ConfidenceLabel; reasons: string[] } {
  const c = profile.confidence;
  const reasons: string[] = [];
  let score = 1;
  if (input.memberCount < c.fewMembers) {
    score -= c.penaltyFewMembers;
    reasons.push(`话题成员仅 ${input.memberCount} 条`);
  }
  if (input.snapshotCount < c.fewSnapshots) {
    score -= c.penaltyFewSnapshots;
    reasons.push(`话题快照仅 ${input.snapshotCount} 次`);
  }
  if (input.scoreCoverage <= c.lowScoreCoverage) {
    score -= c.penaltyLowScoreCoverage;
    reasons.push("成员爆发指数覆盖率低(请先运行内容评分)");
  }
  score = Math.max(0, Math.min(1, score));
  return { score: Math.round(score * 100) / 100, label: labelFor(score, c.high, c.medium), reasons };
}

export const CONFIDENCE_LABELS_ZH: Record<ConfidenceLabel, string> = {
  high: "高",
  medium: "中",
  low: "低",
};
