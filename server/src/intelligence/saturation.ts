/**
 * Topic Saturation Engine (Stage 8 §28-§41):话题是否已高度同质化。
 * 0-100;权重版本化 SATURATION_V1;只回答"重复程度",绝不输出"不要做这个话题"。
 * 角度分析用 Angle Embedding(词法回退 = 词法饱和度基线,UI 如实标注)。
 * 无凭证可完整运行;样本不足 → unscorable(数据不足,不造假)。
 */
import type { SaturationProfile } from "./profiles";
import { cosineSimilarity } from "../semantic/vectors";
import { round1 } from "../scoring/percentile";

export interface SaturationMember {
  contentItemId: number;
  authorKey: string | null;
  publishedAt: string | null;
  /** Angle Embedding(或词法回退);null = 未覆盖 */
  angleVector: number[] | null;
}

export interface SaturationBreakdownComponent {
  score: number | null;
  weight: number;
  available: boolean;
}

export interface SaturationOutput {
  scorable: boolean;
  unscorableReason: "insufficient_members" | "insufficient_data" | null;
  score: number | null;
  confidence: "high" | "medium" | "low" | null;
  confidenceReasons: string[];
  breakdown: Record<string, SaturationBreakdownComponent> | null;
  weightsUsed: Record<string, number> | null;
  evidence: Record<string, unknown>;
}

const DAY_MS = 86_400_000;

/** 最近 N 条(按 publishedAt 降序)参与角度分析,防话题内 O(n²) 爆炸(§32)。 */
export function capMembersForAngleAnalysis<T extends { publishedAt: string | null }>(
  members: T[],
  cap: number,
): { selected: T[]; capped: boolean } {
  if (members.length <= cap) return { selected: members, capped: false };
  const sorted = [...members].sort((a, b) => Date.parse(b.publishedAt ?? "0") - Date.parse(a.publishedAt ?? "0"));
  return { selected: sorted.slice(0, cap), capped: true };
}

/** 每条内容的最大近邻相似度(话题内;返回 map,无向量者不在 map 中)。 */
export function nearestNeighborSimilarities(members: SaturationMember[]): Map<number, number> {
  const withVec = members.filter((m) => m.angleVector !== null);
  const out = new Map<number, number>();
  for (let i = 0; i < withVec.length; i++) {
    let max = -1;
    for (let j = 0; j < withVec.length; j++) {
      if (i === j) continue;
      const sim = cosineSimilarity(withVec[i].angleVector!, withVec[j].angleVector!);
      if (sim > max) max = sim;
    }
    if (max >= 0) out.set(withVec[i].contentItemId, max);
  }
  return out;
}

/** HHI 修正集中度:(HHI − 1/n)/(1 − 1/n) → 0-1;单作者 = 1。 */
export function creatorConcentration(authorKeys: (string | null)[]): number | null {
  const known = authorKeys.filter((k): k is string => k !== null);
  const n = authorKeys.length;
  if (n === 0) return null;
  if (known.length === 0) return null; // 作者信息全缺失 = unknown(不按 0)
  const counts = new Map<string, number>();
  for (const k of known) counts.set(k, (counts.get(k) ?? 0) + 1);
  const hhi = [...counts.values()].reduce((s, c) => s + (c / n) ** 2, 0);
  if (n === 1) return 1;
  return Math.max(0, Math.min(1, (hhi - 1 / n) / (1 - 1 / n)));
}

export function computeSaturation(
  input: {
    topicId: number;
    firstObservedAt: string | null;
    members: SaturationMember[];
  },
  nowMs: number,
  profile: SaturationProfile,
): SaturationOutput {
  const evidence: Record<string, unknown> = {};
  if (input.members.length < profile.minMembers) {
    return unscorable("insufficient_members", `成员 ${input.members.length} 条,低于可信下限 ${profile.minMembers}`);
  }
  const ageDays = input.firstObservedAt
    ? Math.max(0.5, (nowMs - Date.parse(input.firstObservedAt)) / DAY_MS)
    : null;

  // 1) Volume(§30):规模 / 话题年龄 → 速率;不看绝对数量
  const volume =
    ageDays !== null
      ? Math.min(100, (100 * (input.members.length / ageDays)) / profile.volumePerDayExpected)
      : null;

  // 2) Frequency(§31):近 7 天发布密度
  const recentCut = nowMs - 7 * DAY_MS;
  const recentCount = input.members.filter(
    (m) => m.publishedAt && Date.parse(m.publishedAt) >= recentCut,
  ).length;
  const frequency = Math.min(100, (100 * (recentCount / 7)) / profile.frequencyPerDayExpected);

  // 3) Angle Similarity + 4) Repetition(§32/§33/§38):话题内近邻结构
  const { selected, capped } = capMembersForAngleAnalysis(input.members, profile.maxMembersForAngleAnalysis);
  const nn = nearestNeighborSimilarities(selected);
  let angleSimilarity: number | null = null;
  let repetitionRatio: number | null = null;
  if (nn.size >= 2) {
    const sims = [...nn.values()];
    angleSimilarity = (sims.reduce((s, v) => s + v, 0) / sims.length) * 100;
    repetitionRatio =
      (sims.filter((s) => s >= profile.repetitionSimilarityThreshold).length / sims.length) * 100;
  }
  evidence.angle = {
    参与成员: nn.size,
    向量覆盖率: round1((nn.size / Math.max(1, selected.length)) * 100) + "%",
    截断到最近: capped ? profile.maxMembersForAngleAnalysis : false,
  };

  // 5) Creator Concentration(§37):修正 HHI
  const concentration = creatorConcentration(input.members.map((m) => m.authorKey));
  const concentrationScore = concentration === null ? null : concentration * 100;

  const breakdown: Record<string, SaturationBreakdownComponent> = {
    volume: { score: volume, weight: profile.weights.volume, available: volume !== null },
    frequency: { score: frequency, weight: profile.weights.frequency, available: true },
    angleSimilarity: { score: angleSimilarity, weight: profile.weights.angleSimilarity, available: angleSimilarity !== null },
    repetitionRatio: { score: repetitionRatio, weight: profile.weights.repetitionRatio, available: repetitionRatio !== null },
    creatorConcentration: { score: concentrationScore, weight: profile.weights.creatorConcentration, available: concentrationScore !== null },
  };
  const availableComponents = Object.entries(breakdown).filter(([, c]) => c.available && c.score !== null);
  if (availableComponents.length === 0) {
    return unscorable("insufficient_data", "无任何可计算信号(向量覆盖与作者信息缺失)");
  }
  const weightSum = availableComponents.reduce((s, [, c]) => s + c.weight, 0);
  const weightsUsed: Record<string, number> = {};
  let overall = 0;
  for (const [k, c] of availableComponents) {
    const w = c.weight / weightSum;
    weightsUsed[k] = Math.round(w * 1000) / 1000;
    overall += w * (c.score as number);
  }
  overall = Math.max(0, Math.min(100, overall));

  // 置信度(§40)
  const reasons: string[] = [];
  let conf = 1;
  if (input.members.length < profile.confidence.fewMembers) {
    conf -= profile.confidence.penaltyFewMembers;
    reasons.push(`成员仅 ${input.members.length} 条`);
  }
  if (recentCount < profile.confidence.fewRecent) {
    conf -= profile.confidence.penaltyFewRecent;
    reasons.push(`近 7 天新增仅 ${recentCount} 条`);
  }
  const coverage = nn.size / Math.max(1, selected.length);
  if (coverage < 0.5) {
    conf -= 0.15;
    reasons.push("角度向量覆盖率低(请先在语义中心向量化)");
  }
  conf = Math.max(0, Math.min(1, conf));
  const label = conf >= profile.confidence.high ? "high" : conf >= profile.confidence.medium ? "medium" : "low";

  evidence.members = input.members.length;
  evidence.recent7d = recentCount;
  evidence.ageDays = ageDays === null ? null : round1(ageDays);
  evidence.unavailableComponents = Object.entries(breakdown).filter(([, c]) => !c.available).map(([k]) => k);

  return {
    scorable: true,
    unscorableReason: null,
    score: Math.round(overall * 10) / 10,
    confidence: label,
    confidenceReasons: reasons,
    breakdown,
    weightsUsed,
    evidence,
  };
}

function unscorable(
  reason: "insufficient_members" | "insufficient_data",
  detail: string,
): SaturationOutput {
  return {
    scorable: false,
    unscorableReason: reason,
    score: null,
    confidence: null,
    confidenceReasons: [detail],
    breakdown: null,
    weightsUsed: null,
    evidence: { reason: detail },
  };
}
