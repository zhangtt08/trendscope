/**
 * Content Burst Score v1 (Stage 7 §R-§Z):归一化"异常表现"指数,0-100。
 * 非预测:只量化"已观察到的增长相对同类是否异常"(§F),UI 文案"内容爆发指数"。
 *
 * 结构(§R 初始权重,调整须记 DECISIONS):
 *   35% Velocity(单位时间互动增速,平台感知动量/小时,cohort 百分位)
 *   20% Reach(views 百分位;知乎多数内容无 views → missing-aware 跳过不压分)
 *   20% Engagement Quality(深互动[评论/分享/收藏]占互动比,需全部深互动已知)
 *   15% Relative Performance(creator median 基线 → 同组回退,记录 relativeBasis)
 *   10% Interaction Structure(各互动分量 cohort 百分位均值)
 * 缺失组件按原权重比例重归一(Available Signal Weight Renormalization,§N),
 * 同时降低置信度。null ≠ 0:任何缺失指标绝不按 0 参与计算(§BD/§BG)。
 * 确定性:同输入同输出;禁止 LLM(§BB)。
 */
import type { ContentBurstProfile } from "./profiles";
import { percentileRank, round1 } from "./percentile";
import { platformMetricProfile, momentumWeights } from "./metricProfile";
import { burstConfidence, type ConfidenceLabel } from "./confidence";
import type { RelativeBasis } from "./creatorBaseline";
import { scoreOf, deltaMetricsFor, type DeltaMetricName } from "../services/trendService";

export interface BurstMetricPoint {
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  upvotes: number | null;
}

export interface BurstItemMeta {
  contentItemId: number;
  platform: string;
  contentType: string;
  publishedAt: string | null;
}

export interface BurstCohortContext {
  key: string;
  levelLabel: string;
  size: number;
  insufficient: boolean;
  /** 各分布只含"该值可用"的成员(与目标内容同规则计算) */
  velocityPerHour: number[];
  viewsLatest: number[];
  engagementRatios: number[];
  interactionTotals: number[];
  structure: Record<string, number[]>;
}

export interface BurstCreatorContext {
  basis: RelativeBasis;
  /** creator 基线:作者历史互动总量数组(不含自身) */
  historyTotals: number[] | null;
  historyCount: number | null;
}

export interface BurstComponentResult {
  score: number | null;
  weight: number;
  available: boolean;
}

export interface BurstBreakdown {
  velocity: BurstComponentResult;
  reach: BurstComponentResult;
  engagementQuality: BurstComponentResult;
  relativePerformance: BurstComponentResult;
  interactionStructure: BurstComponentResult;
}

export interface BurstOutput {
  scorable: boolean;
  unscorableReason: "insufficient_snapshots" | "insufficient_metrics" | "insufficient_cohort" | null;
  overallScore: number | null;
  confidence: ConfidenceLabel | null;
  confidenceScore: number | null;
  confidenceReasons: string[];
  breakdown: BurstBreakdown | null;
  weightsUsed: Record<string, number> | null;
  evidence: Record<string, unknown>;
}

const HOUR_MS = 3_600_000;

/** 单内容"原始观测":供 cohort 聚合与评分共用(同规则,防分布错位)。 */
export interface BurstObservation {
  velocityPerHour: number | null;
  primaryWindowKey: string | null;
  viewsLatest: number | null;
  engagementRatio: number | null;
  interactionTotal: number | null;
  structureValues: Partial<Record<string, number>>;
  snapshotCount: number;
  spanHours: number | null;
}

/** 最新快照 + 各窗口动量速度(§S/§T)。 */
export function computeVelocityWindows(
  platform: string,
  snaps: BurstMetricPoint[],
  nowMs: number,
  profile: ContentBurstProfile,
): {
  windows: Record<string, { available: boolean; deltaMomentum: number | null; spanHours: number | null; perHour: number | null }>;
  primary: { key: string; deltaMomentum: number; spanHours: number; perHour: number } | null;
} {
  const metrics = deltaMetricsFor(platform);
  const windows: Record<string, { available: boolean; deltaMomentum: number | null; spanHours: number | null; perHour: number | null }> = {};
  let primary: { key: string; deltaMomentum: number; spanHours: number; perHour: number } | null = null;
  for (const w of profile.velocityWindows) {
    const cutoff = nowMs - w.hours * HOUR_MS;
    const inWindow = snaps.filter((s) => Date.parse(s.capturedAt) >= cutoff);
    let available = false;
    let deltaMomentum: number | null = null;
    let spanHours: number | null = null;
    let perHour: number | null = null;
    if (inWindow.length >= profile.minSnapshotsForVelocity) {
      const base = inWindow[0];
      const last = inWindow[inWindow.length - 1];
      spanHours = (Date.parse(last.capturedAt) - Date.parse(base.capturedAt)) / HOUR_MS;
      if (spanHours > 0) {
        const delta: Partial<Record<DeltaMetricName, number | null>> = {};
        let anyKnown = false;
        for (const k of metrics) {
          const b = base[k];
          const l = last[k];
          if (typeof b === "number" && typeof l === "number") {
            delta[k] = l - b;
            anyKnown = true;
          }
        }
        if (anyKnown) {
          deltaMomentum = scoreOf(delta, platform);
          perHour = deltaMomentum / spanHours;
          available = true;
        }
      }
    }
    windows[w.key] = { available, deltaMomentum, spanHours, perHour };
  }
  for (const key of profile.velocityFallback) {
    const w = windows[key];
    if (w?.available && w.perHour !== null && w.spanHours !== null && w.deltaMomentum !== null) {
      primary = { key, deltaMomentum: w.deltaMomentum, spanHours: w.spanHours, perHour: w.perHour };
      break;
    }
  }
  return { windows, primary };
}

/**
 * 深互动占比(§V):要求主互动 + 全部深互动已知(缺失绝不按 0)。
 * total=0(全部真实 0)→ 0;任何深互动缺失 → null。
 */
export function engagementRatioOf(platform: string, m: BurstMetricPoint): { ratio: number | null; missing: string[] } {
  const p = platformMetricProfile(platform);
  const primary = m[p.primaryReaction];
  const missing: string[] = [];
  if (typeof primary !== "number") missing.push(p.primaryReaction);
  let deep = 0;
  for (const k of p.deepReactions) {
    const v = m[k];
    if (typeof v === "number") deep += v;
    else missing.push(k);
  }
  if (missing.length > 0 || typeof primary !== "number") return { ratio: null, missing };
  const total = primary + deep;
  return { ratio: total === 0 ? 0 : deep / total, missing: [] };
}

/** 对单内容做原始观测(cohort 分布与评分共用同一函数 → 分布同构)。 */
export function observeBurstInputs(
  platform: string,
  snaps: BurstMetricPoint[],
  nowMs: number,
  profile: ContentBurstProfile,
): BurstObservation {
  const p = platformMetricProfile(platform);
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const { primary } = computeVelocityWindows(platform, snaps, nowMs, profile);
  const structureValues: Partial<Record<string, number>> = {};
  if (latest) {
    for (const k of p.structureComponents) {
      const v = latest[k];
      if (typeof v === "number") structureValues[k] = v;
    }
  }
  let total = 0;
  let knownCount = 0;
  if (latest) {
    for (const k of p.structureComponents) {
      const v = latest[k];
      if (typeof v === "number") {
        total += v;
        knownCount += 1;
      }
    }
  }
  const first = snaps[0];
  const spanHours =
    snaps.length >= 2 && first ? (Date.parse(latest!.capturedAt) - Date.parse(first.capturedAt)) / HOUR_MS : null;
  return {
    velocityPerHour: primary ? primary.perHour : null,
    primaryWindowKey: primary ? primary.key : null,
    viewsLatest: latest && typeof latest.views === "number" ? latest.views : null,
    engagementRatio: latest ? engagementRatioOf(platform, latest).ratio : null,
    interactionTotal: knownCount > 0 ? total : null,
    structureValues,
    snapshotCount: snaps.length,
    spanHours,
  };
}

/** 主流程:内容爆发指数(§R-§Z 全字段)。 */
export function computeContentBurst(
  item: BurstItemMeta,
  snaps: BurstMetricPoint[],
  cohort: BurstCohortContext,
  creator: BurstCreatorContext,
  nowMs: number,
  profile: ContentBurstProfile,
): BurstOutput {
  const evidence: Record<string, unknown> = {};
  const obs = observeBurstInputs(item.platform, snaps, nowMs, profile);

  // ---- 不可评分判定(§BG:unscorable,绝不 0 分) ----
  if (snaps.length === 0) {
    return unscorable("insufficient_snapshots", "从未采集到任何指标快照", item, cohort, creator, profile);
  }

  const components: BurstBreakdown = {
    velocity: { score: null, weight: profile.weights.velocity, available: false },
    reach: { score: null, weight: profile.weights.reach, available: false },
    engagementQuality: { score: null, weight: profile.weights.engagementQuality, available: false },
    relativePerformance: { score: null, weight: profile.weights.relativePerformance, available: false },
    interactionStructure: { score: null, weight: profile.weights.interactionStructure, available: false },
  };

  // 1) Velocity(35%):主窗口 per-hour 动量在 cohort 的百分位
  if (obs.velocityPerHour !== null && obs.primaryWindowKey) {
    components.velocity.score = percentileRank(obs.velocityPerHour, cohort.velocityPerHour);
    components.velocity.available = components.velocity.score !== null;
    evidence.velocity = {
      windows: Object.fromEntries(
        Object.entries(computeVelocityWindows(item.platform, snaps, nowMs, profile).windows).map(([k, w]) => [
          k,
          { 可用: w.available, 动量增量: w.deltaMomentum, 跨度小时: round1(w.spanHours), 每小时动量: round1(w.perHour) },
        ]),
      ),
      primaryWindow: obs.primaryWindowKey,
      perHour: round1(obs.velocityPerHour),
    };
  }

  // 2) Reach(20%):views 百分位;无 views → unknown(知乎不得因此自动低分)
  if (obs.viewsLatest !== null) {
    components.reach.score = percentileRank(obs.viewsLatest, cohort.viewsLatest);
    components.reach.available = components.reach.score !== null;
  }

  // 3) Engagement Quality(20%):深互动占比百分位(缺失 → unknown)
  if (obs.engagementRatio !== null) {
    components.engagementQuality.score = percentileRank(obs.engagementRatio, cohort.engagementRatios);
    components.engagementQuality.available = components.engagementQuality.score !== null;
  }

  // 4) Relative Performance(15%):creator median 基线优先,cohort 回退(§W)
  let relativeBasis: RelativeBasis = "unknown";
  if (obs.interactionTotal !== null) {
    if (creator.basis === "creator" && creator.historyTotals && creator.historyTotals.length >= 1) {
      components.relativePerformance.score = percentileRank(obs.interactionTotal, creator.historyTotals);
      relativeBasis = "creator";
    } else {
      components.relativePerformance.score = percentileRank(obs.interactionTotal, cohort.interactionTotals);
      if (components.relativePerformance.score !== null) relativeBasis = "cohort";
    }
    components.relativePerformance.available = components.relativePerformance.score !== null;
  }

  // 5) Interaction Structure(10%):可用分量百分位均值(§X 结构信号,非总量)
  const structureParts: { metric: string; percentile: number }[] = [];
  for (const [metric, value] of Object.entries(obs.structureValues)) {
    if (value === undefined) continue;
    const dist = cohort.structure[metric];
    if (!dist) continue;
    const pct = percentileRank(value, dist);
    if (pct !== null) structureParts.push({ metric, percentile: pct });
  }
  if (structureParts.length > 0) {
    components.interactionStructure.score =
      structureParts.reduce((s, p) => s + p.percentile, 0) / structureParts.length;
    components.interactionStructure.available = true;
  }

  evidence.components = Object.fromEntries(
    Object.entries(components).map(([k, c]) => [k, { 分位: round1(c.score), 可用: c.available }]),
  );

  // ---- Missing-aware 合成(§N):可用权重按原比例重归一 ----
  const availableComponents = Object.entries(components).filter(([, c]) => c.available && c.score !== null);
  if (availableComponents.length === 0) {
    return unscorable("insufficient_metrics", "无任何可计算信号(关键指标全部缺失)", item, cohort, creator, profile);
  }
  if (cohort.insufficient) {
    return unscorable("insufficient_cohort", `同组样本不足(n=${cohort.size},最低 ${profile.cohort.floorSample})`, item, cohort, creator, profile);
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

  // ---- 置信度(§Z) ----
  const signalRatio = weightSum; // 可用权重占比(总权重=1)
  const conf = burstConfidence(
    {
      snapshotCount: obs.snapshotCount,
      spanHours: obs.spanHours ?? 0,
      cohortSize: cohort.size,
      availableSignalRatio: signalRatio,
      creatorHistoryCount: creator.basis === "creator" ? creator.historyCount : null,
    },
    profile,
  );

  evidence.cohort = { key: cohort.key, level: cohort.levelLabel, size: cohort.size };
  evidence.creator = {
    basis: relativeBasis,
    historyCount: creator.historyCount,
    note: relativeBasis === "unknown" ? "作者与同组均无足够历史" : undefined,
  };
  evidence.unavailableComponents = Object.entries(components)
    .filter(([, c]) => !c.available)
    .map(([k]) => k);

  return {
    scorable: true,
    unscorableReason: null,
    overallScore: Math.round(overall * 10) / 10,
    confidence: conf.label,
    confidenceScore: conf.score,
    confidenceReasons: conf.reasons,
    breakdown: components,
    weightsUsed,
    evidence,
  };
}

function unscorable(
  reason: "insufficient_snapshots" | "insufficient_metrics" | "insufficient_cohort",
  detail: string,
  item: BurstItemMeta,
  cohort: BurstCohortContext,
  creator: BurstCreatorContext,
  profile: ContentBurstProfile,
): BurstOutput {
  void creator;
  void profile;
  return {
    scorable: false,
    unscorableReason: reason,
    overallScore: null,
    confidence: null,
    confidenceScore: null,
    confidenceReasons: [detail],
    breakdown: null,
    weightsUsed: null,
    evidence: {
      reason: detail,
      cohort: { key: cohort.key, level: cohort.levelLabel, size: cohort.size },
      platform: item.platform,
    },
  };
}

/** 供 UI/测试解释动量权重(与 Raw Momentum 同源,不再另造公式)。 */
export function momentumWeightsFor(platform: string): Partial<Record<DeltaMetricName, number>> {
  return momentumWeights(platform);
}
