/**
 * Novelty / Emerging Angle Engine (Stage 8 §42-§53):区分"新话题"与"新角度"。
 * 新角度 = 已有话题内最近出现的局部内容簇(Angle Embedding 轻量连通分量,
 * 不建第二套 Topic Engine);与历史角度比较后判 Emerging;
 * 单条离群内容不构成新角度(§49 minAngleMembers)。
 * 跨 Run 按质心相似度调和 → 簇 ID / firstObservedAt / 人工命名 稳定(§50)。
 */
import type { NoveltyProfile } from "./profiles";
import { cosineSimilarity } from "../semantic/vectors";
import { round1 } from "../scoring/percentile";

export interface AngleMember {
  contentItemId: number;
  authorKey: string | null;
  publishedAt: string | null;
  title: string | null;
  angleVector: number[];
}

export interface HistoricalCluster {
  id: number;
  label: string;
  labelSource: string;
  firstObservedAt: string;
  centroid: number[] | null;
  dimension: number | null;
  isEmerging: number;
  status: string;
}

export interface AngleClusterDraft {
  memberItemIds: number[];
  authors: (string | null)[];
  titles: (string | null)[];
  publishedDates: (string | null)[];
  centroid: number[];
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface ReconciledCluster {
  /** 命中历史簇则继承其 id / firstObservedAt / 人工命名;否则为新簇 */
  inheritedId: number | null;
  label: string;
  labelSource: string;
  draft: AngleClusterDraft;
  /** 与历史角度的最大相似度(无历史 → null) */
  maxHistoricalSimilarity: number | null;
  isEmerging: boolean;
  /** 曾识别为新兴(历史标记 || 当下);持久化用,后续 Run 不丢"曾新兴" */
  everEmerging: boolean;
  noveltyScore: number | null;
  noveltyReasons: string[];
}

export interface NoveltyOutput {
  scorable: boolean;
  unscorableReason: "insufficient_members" | "insufficient_data" | null;
  /** 话题级新颖度 = 最强 emerging angle 分数(无 → 0,非 null) */
  score: number;
  emergingAngleCount: number;
  confidence: "high" | "medium" | "low" | null;
  confidenceReasons: string[];
  clusters: ReconciledCluster[];
  evidence: Record<string, unknown>;
}

/* ---------------- 角度簇:连通分量(阈值图,轻量) ---------------- */

export function clusterAngles(members: AngleMember[], profile: NoveltyProfile): AngleClusterDraft[] {
  const n = members.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(members[i].angleVector, members[j].angleVector) >= profile.angleClusterSimThreshold) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(i);
    else groups.set(r, [i]);
  }
  const drafts: AngleClusterDraft[] = [];
  for (const idxs of groups.values()) {
    const dim = members[0].angleVector.length;
    const centroid = new Array<number>(dim).fill(0);
    for (const i of idxs) {
      for (let k = 0; k < dim; k++) centroid[k] += members[i].angleVector[k];
    }
    for (let k = 0; k < dim; k++) centroid[k] /= idxs.length;
    const dates = idxs
      .map((i) => members[i].publishedAt)
      .filter((d): d is string => d !== null)
      .map((d) => Date.parse(d))
      .filter((t) => Number.isFinite(t));
    drafts.push({
      memberItemIds: idxs.map((i) => members[i].contentItemId),
      authors: idxs.map((i) => members[i].authorKey),
      titles: idxs.map((i) => members[i].title),
      publishedDates: idxs.map((i) => members[i].publishedAt),
      centroid,
      firstObservedAt: dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : new Date(0).toISOString(),
      lastObservedAt: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : new Date(0).toISOString(),
    });
  }
  // 确定性排序:成员多在前,同大按首成员 id
  drafts.sort((a, b) => b.memberItemIds.length - a.memberItemIds.length || a.memberItemIds[0] - b.memberItemIds[0]);
  return drafts;
}

/* ---------------- 历史调和(稳定 ID / 人工命名保留) ---------------- */

export function reconcileClusters(
  drafts: AngleClusterDraft[],
  historical: HistoricalCluster[],
  profile: NoveltyProfile,
  nowMs: number,
): ReconciledCluster[] {
  const usedHistorical = new Set<number>();
  const recentCut = nowMs - profile.recentWindowHours * 3_600_000;
  const out: ReconciledCluster[] = [];
  for (const draft of drafts) {
    let bestSim = -1;
    let bestHist: HistoricalCluster | null = null;
    for (const hist of historical) {
      if (usedHistorical.has(hist.id) || !hist.centroid) continue;
      const sim = cosineSimilarity(draft.centroid, hist.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestHist = hist;
      }
    }
    const inherited = bestHist !== null && bestSim >= profile.angleIdentityThreshold;
    if (inherited) usedHistorical.add(bestHist!.id);
    // 与"未被自己继承的历史角度"比较 → 判断新颖度
    let maxHistoricalSimilarity: number | null = null;
    for (const hist of historical) {
      if (!hist.centroid) continue;
      if (inherited && hist.id === bestHist!.id) continue;
      const sim = cosineSimilarity(draft.centroid, hist.centroid);
      if (maxHistoricalSimilarity === null || sim > maxHistoricalSimilarity) maxHistoricalSimilarity = sim;
    }
    const firstObservedAt = inherited ? bestHist!.firstObservedAt : draft.firstObservedAt;
    const labelSource = inherited ? bestHist!.labelSource : "keyword";
    const label = inherited ? bestHist!.label : labelFromTitles(draft.titles);
    const memberCount = draft.memberItemIds.length;
    const appearedRecently = Date.parse(firstObservedAt) >= recentCut;
    const enoughMembers = memberCount >= profile.minAngleMembers;
    const isNewExpression =
      maxHistoricalSimilarity === null || maxHistoricalSimilarity < profile.noveltyDistanceThreshold;
    const isEmerging = !inherited && appearedRecently && enoughMembers && isNewExpression;
    const everEmerging = isEmerging || (inherited && bestHist!.isEmerging === 1);

    // Novelty score(§48):历史距离 40% + 近期增长 25% + 成员充分 20% + 创作者多样 15%
    const reasons: string[] = [];
    const distanceScore = maxHistoricalSimilarity === null ? 100 : (1 - maxHistoricalSimilarity) * 100;
    if (maxHistoricalSimilarity === null) reasons.push("无历史角度可比(新话题或首个角度)");
    const recentPublished = draft.publishedDates.filter(
      (d) => d !== null && Date.parse(d) >= nowMs - profile.recentWindowHours * 3_600_000,
    ).length;
    const growthScore = Math.min(100, (100 * (recentPublished / Math.max(1, memberCount))) / 0.6);
    const adequacyScore = Math.min(100, (100 * memberCount) / profile.minAngleMembers);
    const distinctAuthors = new Set(draft.authors.filter((a): a is string => a !== null)).size;
    const diversityScore = memberCount > 0 ? (distinctAuthors / memberCount) * 100 : 0;
    let noveltyScore: number | null = null;
    if (enoughMembers) {
      noveltyScore = Math.round(
        (profile.weights.historicalDistance * distanceScore +
          profile.weights.recentGrowth * growthScore +
          profile.weights.memberAdequacy * adequacyScore +
          profile.weights.creatorDiversity * diversityScore) *
          10,
      ) / 10;
      if (isEmerging) {
        reasons.push(`与历史角度最大相似度 ${maxHistoricalSimilarity === null ? "无" : round1(maxHistoricalSimilarity * 100) + "%"},${memberCount} 条成员`);
      }
    }
    out.push({
      inheritedId: inherited ? bestHist!.id : null,
      label,
      labelSource,
      draft,
      maxHistoricalSimilarity,
      isEmerging,
      everEmerging,
      noveltyScore,
      noveltyReasons: reasons,
    });
  }
  return out;
}

/** 关键词命名回退(§50):标题 CJK bigram 频次,停用字过滤,Top1-2。 */
const LABEL_STOP_CHARS = "的了了吗呢吧啊呀哦嗯是我在有和就不人都一个这那也都很被把给与对上中大小多少什么怎么为什么";
export function labelFromTitles(titles: (string | null)[]): string {
  const freq = new Map<string, number>();
  const firstPos = new Map<string, number>();
  for (const t of titles) {
    const s = (t ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    for (let i = 0; i + 1 < s.length; i++) {
      const bg = s.slice(i, i + 2);
      if ([...bg].some((ch) => LABEL_STOP_CHARS.includes(ch))) continue;
      freq.set(bg, (freq.get(bg) ?? 0) + 1);
      if (!firstPos.has(bg)) firstPos.set(bg, i);
    }
  }
  // 频次并列时取标题中最早出现的 bigram(更像"开头词",如"打车"而非"才合")
  const top = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || (firstPos.get(a[0]) ?? 99) - (firstPos.get(b[0]) ?? 99))
    .slice(0, 2)
    .map(([k]) => k);
  if (top.length > 0) return top.join(" ");
  const first = (titles.find((t) => t && t.trim()) ?? "未命名角度").slice(0, 12);
  return first;
}

/* ---------------- 话题级 Novelty 输出 ---------------- */

export function computeTopicNovelty(
  input: {
    topicId: number;
    members: AngleMember[];
    historical: HistoricalCluster[];
  },
  nowMs: number,
  profile: NoveltyProfile,
): NoveltyOutput {
  if (input.members.length < profile.minAngleMembers) {
    return {
      scorable: false,
      unscorableReason: "insufficient_members",
      score: 0,
      emergingAngleCount: 0,
      confidence: null,
      confidenceReasons: [`成员 ${input.members.length} 条,不足以形成角度簇`],
      clusters: [],
      evidence: { reason: `成员 ${input.members.length} 条` },
    };
  }
  const drafts = clusterAngles(input.members, profile);
  const reconciled = reconcileClusters(drafts, input.historical, profile, nowMs);

  const emerging = reconciled.filter((c) => c.isEmerging && c.noveltyScore !== null);
  const emergingAngleCount = emerging.length;
  const score = emergingAngleCount > 0 ? Math.max(...emerging.map((c) => c.noveltyScore as number)) : 0;

  // 置信度:小簇 −0.1;无历史可比 −0.2
  const reasons: string[] = [];
  let conf = 1;
  const biggest = reconciled.reduce((m, c) => Math.max(m, c.draft.memberItemIds.length), 0);
  if (biggest < profile.minAngleMembers * 2) {
    conf -= profile.confidence.penaltySmallCluster;
    reasons.push(`最大角度簇仅 ${biggest} 条`);
  }
  if (input.historical.filter((h) => h.centroid).length === 0) {
    conf -= profile.confidence.penaltyNoHistorical;
    reasons.push("无历史角度可比(首次分析)");
  }
  conf = Math.max(0, Math.min(1, conf));
  const label = conf >= profile.confidence.high ? "high" : conf >= profile.confidence.medium ? "medium" : "low";

  return {
    scorable: true,
    unscorableReason: null,
    score,
    emergingAngleCount,
    confidence: label,
    confidenceReasons: reasons,
    clusters: reconciled,
    evidence: {
      成员总数: input.members.length,
      角度簇数: drafts.length,
      historicalClusters: input.historical.length,
      noiseGuard: `minAngleMembers=${profile.minAngleMembers}(单条离群不成角度)`,
      emerging: emerging.map((c) => ({
        label: c.label,
        memberCount: c.draft.memberItemIds.length,
        noveltyScore: c.noveltyScore,
        firstObservedAt: c.draft.firstObservedAt,
        maxHistoricalSimilarity: c.maxHistoricalSimilarity,
      })),
    },
  };
}
