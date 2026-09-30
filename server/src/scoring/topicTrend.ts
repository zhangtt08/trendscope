/**
 * Topic Trend Score v1 (Stage 7 §AF-§AL):话题趋势指数 0-100。
 * 只基于已有数据(Topic/TopicMembership/TopicSnapshot/ContentScore/MetricSnapshot,
 * §AE);禁 LLM 看描述猜趋势。确定性(§BB)。
 *
 * 结构(§AF 初始权重):
 *   35% Content Growth   当前窗口新增内容 vs 基准(前等长窗口/历史中位)
 *   25% Engagement Growth 平台加权动量均值变化(Raw Momentum 同源;禁跨平台原值相加)
 *   15% Creator Growth   活跃创作者变化(区分"一个号发 20 条"vs"20 个人在讨论")
 *   15% Burst Density    成员中爆发指数 ≥ 阈值的占比(§CA 单条爆款防误判关键)
 *   10% Acceleration     增长的二阶变化(前窗口 +4 → 当前 +12 = positive)
 * 缺失组件按权重重归一(§N);数据不足 → unscorable(§BH),UI 显示"数据不足"。
 */
import type { TopicTrendProfile } from "./profiles";
import { growthRatioScore, round1 } from "./percentile";
import { topicConfidence, type ConfidenceLabel } from "./confidence";

export interface TopicTrendMember {
  contentItemId: number;
  authorKey: string | null;
  /** latest content burst score(未评分/不可评分 → null) */
  burstScore: number | null;
  joinedAt: string | null;
}

export interface TopicSnapshotPoint {
  capturedAt: string;
  memberCount: number;
  newContentCount: number;
  activeCreatorCount: number | null;
  averageRawMomentum: number | null;
}

export interface TopicTrendInput {
  topicId: number;
  name: string;
  firstObservedAt: string | null;
  members: TopicTrendMember[];
  /** TopicSnapshot 序列,升序 */
  snapshots: TopicSnapshotPoint[];
}

export interface TrendComponentResult {
  score: number | null;
  weight: number;
  available: boolean;
  /** §52:不可用时为什么不可用(可用时为 null)。前端不得把 null 当 0。 */
  reason: string | null;
}

export interface TopicTrendOutput {
  scorable: boolean;
  unscorableReason: "insufficient_members" | "insufficient_snapshots" | "insufficient_metrics" | null;
  score: number | null;
  confidence: ConfidenceLabel | null;
  confidenceScore: number | null;
  confidenceReasons: string[];
  components: {
    contentGrowth: TrendComponentResult;
    engagementGrowth: TrendComponentResult;
    creatorGrowth: TrendComponentResult;
    burstDensity: TrendComponentResult;
    acceleration: TrendComponentResult;
  } | null;
  weightsUsed: Record<string, number> | null;
  /** 供 lifecycle 判定的原始窗口数值(不经中文 evidence key 解析) */
  raw: {
    recentNew: number | null;
    baselineNew: number | null;
    currentCreators: number | null;
    baselineCreators: number | null;
    currentMomentum: number | null;
    baselineMomentum: number | null;
    burstDensityRatio: number | null;
    acceleration: number | null;
  } | null;
  /** §AY 基础饱和代理(v1 proxy,UI 标"初步饱和判断") */
  saturationProxy: { creatorConcentration: number | null; growthFlattening: boolean | null; note: string } | null;
  evidence: Record<string, unknown>;
}

const HOUR_MS = 3_600_000;

interface WindowCounts {
  currentNew: number | null;
  baselineNew: number | null;
  currentCreators: number | null;
  baselineCreators: number | null;
  currentMomentum: number | null;
  baselineMomentum: number | null;
}

/** 窗口聚合:当前 7d vs 前 7d;基准窗口无数据 → 全历史中位兜底(确定性)。 */
function windowCounts(snapshots: TopicSnapshotPoint[], nowMs: number, profile: TopicTrendProfile): WindowCounts {
  const curCut = nowMs - profile.windowHours * HOUR_MS;
  const baseCut = nowMs - 2 * profile.windowHours * HOUR_MS;
  let currentNew = 0, baselineNew = 0, hasCur = false, hasBase = false;
  let currentCreators = 0, baselineCreators = 0;
  let curCreatorsKnown = false, baseCreatorsKnown = false;
  let currentMomentum = 0, currentMomentumN = 0, baselineMomentum = 0, baselineMomentumN = 0;
  const priorNew: number[] = [];
  const priorCreators: number[] = [];
  const priorMomentum: number[] = [];
  for (const s of snapshots) {
    const t = Date.parse(s.capturedAt);
    if (!Number.isFinite(t)) continue;
    if (t >= curCut) {
      hasCur = true;
      currentNew += s.newContentCount;
      if (s.activeCreatorCount !== null) {
        currentCreators += s.activeCreatorCount;
        curCreatorsKnown = true;
      }
      if (s.averageRawMomentum !== null) {
        currentMomentum += s.averageRawMomentum;
        currentMomentumN += 1;
      }
    } else if (t >= baseCut) {
      hasBase = true;
      baselineNew += s.newContentCount;
      if (s.activeCreatorCount !== null) {
        baselineCreators += s.activeCreatorCount;
        baseCreatorsKnown = true;
      }
      if (s.averageRawMomentum !== null) {
        baselineMomentum += s.averageRawMomentum;
        baselineMomentumN += 1;
      }
    } else {
      priorNew.push(s.newContentCount);
      if (s.activeCreatorCount !== null) priorCreators.push(s.activeCreatorCount);
      if (s.averageRawMomentum !== null) priorMomentum.push(s.averageRawMomentum);
    }
  }
  const medianOf = (arr: number[]): number | null =>
    arr.length === 0 ? null : [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return {
    currentNew: hasCur ? currentNew : null,
    // 基准窗口无快照 → 更早全历史中位兜底(仍不足 → null,组件 unknown)
    baselineNew: hasBase ? baselineNew : medianOf(priorNew),
    // activeCreatorCount 全 null = unknown(绝不按 0,红线)
    currentCreators: hasCur && curCreatorsKnown ? currentCreators : null,
    baselineCreators: hasBase
      ? baseCreatorsKnown
        ? baselineCreators
        : null
      : medianOf(priorCreators),
    currentMomentum: currentMomentumN > 0 ? currentMomentum / currentMomentumN : null,
    baselineMomentum: baselineMomentumN > 0 ? baselineMomentum / baselineMomentumN : medianOf(priorMomentum),
  };
}

/** 成员 joinedAt 兜底:当前/基准窗口加入的 distinct creators(§AI 快照缺失时)。 */
function creatorGrowthFromMembers(members: TopicTrendMember[], nowMs: number, windowHours: number): {
  current: number | null;
  baseline: number | null;
} {
  const curCut = nowMs - windowHours * HOUR_MS;
  const baseCut = nowMs - 2 * windowHours * HOUR_MS;
  const cur = new Set<string>();
  const base = new Set<string>();
  let any = false;
  for (const m of members) {
    if (!m.joinedAt) continue;
    const t = Date.parse(m.joinedAt);
    if (!Number.isFinite(t)) continue;
    any = true;
    if (t >= curCut) {
      if (m.authorKey) cur.add(m.authorKey);
    } else if (t >= baseCut) {
      if (m.authorKey) base.add(m.authorKey);
    }
  }
  return any ? { current: cur.size, baseline: base.size } : { current: null, baseline: null };
}

export function computeTopicTrend(
  input: TopicTrendInput,
  nowMs: number,
  profile: TopicTrendProfile,
): TopicTrendOutput {
  const evidence: Record<string, unknown> = {};
  if (input.members.length < profile.minMembers) {
    return unscorable("insufficient_members", `成员 ${input.members.length} 条,低于可信下限 ${profile.minMembers}`, input);
  }

  const wc = windowCounts(input.snapshots, nowMs, profile);
  const components: NonNullable<TopicTrendOutput["components"]> = {
    contentGrowth: { score: null, weight: profile.weights.contentGrowth, available: false, reason: "当前窗口或基准窗口的新增内容数无法确定(快照不足)" },
    engagementGrowth: { score: null, weight: profile.weights.engagementGrowth, available: false, reason: "缺少可比较的窗口平均原始动量" },
    creatorGrowth: { score: null, weight: profile.weights.creatorGrowth, available: false, reason: "当前与基准窗口的活跃创作者数无法确定" },
    burstDensity: { score: null, weight: profile.weights.burstDensity, available: false, reason: "成员还没有可用的爆发指数(未运行内容评分,或评分覆盖为 0)" },
    acceleration: { score: null, weight: profile.weights.acceleration, available: false, reason: "内容增长不可用时,二阶加速度无法计算" },
  };

  // 1) Content Growth(35%):当前窗口新增 vs 基准
  if (wc.currentNew !== null && wc.baselineNew !== null) {
    components.contentGrowth.score = growthRatioScore(wc.currentNew, wc.baselineNew);
    components.contentGrowth.available = true;
    components.contentGrowth.reason = null;
  }

  // 2) Engagement Growth(25%):平台加权动量均值变化(TopicSnapshot 序列;
  //    权重来自平台映射,不把知乎赞同与抖音点赞原值相加,§AH)
  if (wc.currentMomentum !== null && wc.baselineMomentum !== null) {
    components.engagementGrowth.score = growthRatioScore(wc.currentMomentum, wc.baselineMomentum);
    components.engagementGrowth.available = true;
    components.engagementGrowth.reason = null;
  }

  // 3) Creator Growth(15%):快照 activeCreatorCount 优先,membership 兜底
  let cg: { current: number | null; baseline: number | null } = {
    current: wc.currentCreators,
    baseline: wc.baselineCreators,
  };
  if (cg.current === null || cg.baseline === null) {
    const fromMembers = creatorGrowthFromMembers(input.members, nowMs, profile.windowHours);
    if (cg.current === null) cg.current = fromMembers.current;
    if (cg.baseline === null) cg.baseline = fromMembers.baseline;
  }
  if (cg.current !== null && cg.baseline !== null) {
    components.creatorGrowth.score = growthRatioScore(cg.current, cg.baseline);
    components.creatorGrowth.available = true;
    components.creatorGrowth.reason = null;
  }

  // 4) Burst Density(15%):成员爆发指数 ≥ 阈值占比;覆盖率也记录(§CA 防单条误判:
  //    1/21 ≈ 4.8% → 低分;密度映射 min(100, 100·density/0.3))
  const scored = input.members.filter((m) => m.burstScore !== null);
  const bursting = scored.filter((m) => (m.burstScore as number) >= profile.burstDensityThreshold);
  if (scored.length > 0) {
    const density = bursting.length / scored.length;
    components.burstDensity.score = Math.min(100, (100 * density) / 0.3);
    components.burstDensity.available = true;
    components.burstDensity.reason = null;
    evidence.burstDensity = {
      成员总数: input.members.length,
      已评分: scored.length,
      爆发数: bursting.length,
      密度: round1(density * 100) + "%",
      阈值: profile.burstDensityThreshold,
    };
  }

  // 5) Acceleration(10%):content growth 的二阶变化(当前 − 基准;§AK)
  if (components.contentGrowth.available) {
    const accel = (wc.currentNew as number) - (wc.baselineNew as number);
    components.acceleration.score = 50 + 50 * Math.max(-1, Math.min(1, accel / Math.max(wc.baselineNew as number, 3)));
    components.acceleration.available = true;
    components.acceleration.reason = null;
    evidence.acceleration = { 当前窗口新增: wc.currentNew, 基准: wc.baselineNew, 二阶变化: accel };
  }

  // ---- Missing-aware 合成 ----
  const availableComponents = Object.entries(components).filter(([, c]) => c.available && c.score !== null);
  if (availableComponents.length === 0) {
    return unscorable("insufficient_snapshots", "话题快照与成员时序数据均不足,无任何可计算组件", input);
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

  const scoreCoverage = input.members.length > 0 ? scored.length / input.members.length : 0;
  const conf = topicConfidence(
    { memberCount: input.members.length, snapshotCount: input.snapshots.length, scoreCoverage },
    profile,
  );

  // ---- §AY 基础饱和代理(v1) ----
  const authorCounts = new Map<string, number>();
  for (const m of input.members) {
    if (!m.authorKey) continue;
    authorCounts.set(m.authorKey, (authorCounts.get(m.authorKey) ?? 0) + 1);
  }
  const maxShare = authorCounts.size > 0 ? Math.max(...authorCounts.values()) / input.members.length : null;
  const curNew = wc.currentNew;
  const baseNew = wc.baselineNew;
  const saturationProxy = {
    creatorConcentration: maxShare === null ? null : Math.round(maxShare * 100) / 100,
    // 仍有个位新增但增长率落回 ~1 → 趋平;无新增属于 declining 判据,不算趋平
    growthFlattening:
      curNew !== null && baseNew !== null && baseNew > 0 && curNew > 0 ? curNew / baseNew <= 1.2 : null,
    note: "v1 proxy:仅基于成员增长趋平与创作者集中度,非内容角度相似度饱和(Stage 9 增强)",
  };

  evidence.windows = {
    当前窗口新增: wc.currentNew,
    基准窗口新增: wc.baselineNew,
    当前创作者: cg.current,
    基准创作者: cg.baseline,
    当前平均动量: round1(wc.currentMomentum),
    基准平均动量: round1(wc.baselineMomentum),
  };
  evidence.unavailableComponents = Object.entries(components)
    .filter(([, c]) => !c.available)
    .map(([k]) => k);
  evidence.snapshotCount = input.snapshots.length;

  return {
    scorable: true,
    unscorableReason: null,
    score: Math.round(overall * 10) / 10,
    confidence: conf.label,
    confidenceScore: conf.score,
    confidenceReasons: conf.reasons,
    components,
    weightsUsed,
    raw: {
      recentNew: wc.currentNew,
      baselineNew: wc.baselineNew,
      currentCreators: cg.current,
      baselineCreators: cg.baseline,
      currentMomentum: wc.currentMomentum,
      baselineMomentum: wc.baselineMomentum,
      burstDensityRatio: scored.length > 0 ? bursting.length / scored.length : null,
      acceleration: components.contentGrowth.available
        ? (wc.currentNew as number) - (wc.baselineNew as number)
        : null,
    },
    saturationProxy,
    evidence,
  };
}

function unscorable(
  reason: "insufficient_members" | "insufficient_snapshots",
  detail: string,
  input: TopicTrendInput,
): TopicTrendOutput {
  void input;
  return {
    scorable: false,
    unscorableReason: reason,
    score: null,
    confidence: null,
    confidenceScore: null,
    confidenceReasons: [detail],
    components: null,
    weightsUsed: null,
    raw: null,
    saturationProxy: null,
    evidence: { reason: detail },
  };
}

/* ============================================================
   Stage 9.5 §51-§55:把引擎已经算出的分解结果整理成可展示的形态。
   服务端是唯一真源(§50)—— 前端不得再用一份写死的权重重算。
   ============================================================ */

export const TREND_COMPONENT_LABELS: Record<string, string> = {
  contentGrowth: "内容增长",
  engagementGrowth: "互动增长",
  creatorGrowth: "创作者增长",
  burstDensity: "爆发密度",
  acceleration: "增长加速度",
};

export interface TrendComponentView {
  label: string;
  /** null = 该组件不可用;绝不返回 0 冒充未知(§52) */
  score: number | null;
  /** profile 里的名义权重 */
  weight: number;
  /** missing-aware 重归一后的实际有效权重(§53);不可用时为 null */
  effectiveWeight: number | null;
  available: boolean;
  /** 不可用的原因(可用时为 null) */
  reason: string | null;
  /** 该组件的关键证据(窗口对比值) */
  evidence: Record<string, unknown> | null;
}

export interface TrendBreakdownView {
  components: Record<string, TrendComponentView>;
  effectiveWeights: Record<string, number> | null;
  unavailableReasons: Record<string, string>;
}

export function buildTrendBreakdown(out: TopicTrendOutput): TrendBreakdownView | null {
  if (!out.components) return null;
  const raw = out.raw;
  const ev = out.evidence as Record<string, unknown>;
  const windows = (ev.windows ?? {}) as Record<string, unknown>;
  const perComponent: Record<string, Record<string, unknown> | null> = {
    contentGrowth: {
      当前窗口新增内容: raw?.recentNew ?? null,
      基准窗口新增内容: raw?.baselineNew ?? null,
    },
    engagementGrowth: {
      当前平均原始动量: raw?.currentMomentum ?? null,
      基准平均原始动量: raw?.baselineMomentum ?? null,
    },
    creatorGrowth: {
      当前活跃创作者: raw?.currentCreators ?? null,
      基准窗口创作者: raw?.baselineCreators ?? null,
    },
    burstDensity: (ev.burstDensity as Record<string, unknown> | undefined) ?? {
      爆发密度: raw?.burstDensityRatio ?? null,
    },
    acceleration: (ev.acceleration as Record<string, unknown> | undefined) ?? {
      二阶变化: raw?.acceleration ?? null,
    },
  };
  void windows;

  const components: Record<string, TrendComponentView> = {};
  const unavailableReasons: Record<string, string> = {};
  for (const [key, c] of Object.entries(out.components)) {
    components[key] = {
      label: TREND_COMPONENT_LABELS[key] ?? key,
      score: c.available ? c.score : null,
      weight: c.weight,
      effectiveWeight: c.available ? out.weightsUsed?.[key] ?? null : null,
      available: c.available,
      reason: c.available ? null : c.reason,
      evidence: c.available ? perComponent[key] ?? null : null,
    };
    if (!c.available) unavailableReasons[key] = c.reason ?? "该组件当前不可用";
  }
  return { components, effectiveWeights: out.weightsUsed, unavailableReasons };
}
