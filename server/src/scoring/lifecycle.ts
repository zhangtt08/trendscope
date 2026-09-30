/**
 * Topic Lifecycle (Stage 7 §AN-§AX):趋势阶段,与 Topic.status(active/needs_review/
 * inactive/archived)是完全不同的概念,绝不可混用。
 *
 * 状态:emerging 新兴 / rising 上升 / peak 高位 / saturated 饱和 / declining 下降 /
 *       evergreen 常青;数据不足 → unknown(UI 显示"数据不足",§AX 不硬造阶段)。
 * 判定非单一分数阈值(§AO):综合话题年龄/近期增长/加速度/趋势分/爆发密度/
 * 内容规模/饱和代理/历史波动。确定性决策树,顺序即优先级(先排除 declining,
 * 再 emerging,然后 peak → rising → saturated → evergreen → 兜底)。
 * 滞回(hysteresis,§AV)由 service 层状态机处理:切换需连续 2 次观察一致,
 * 或趋势分强突破(Δ≥25)免等待;迁移原因落 topic_lifecycle_events。
 */
import type { LifecycleProfile } from "./profiles";
import { stddev, round1 } from "./percentile";

export type LifecycleState = "emerging" | "rising" | "peak" | "saturated" | "declining" | "evergreen";

export const LIFECYCLE_LABELS_ZH: Record<LifecycleState | "unknown", string> = {
  emerging: "新兴",
  rising: "上升",
  peak: "高位",
  saturated: "饱和",
  declining: "下降",
  evergreen: "常青",
  unknown: "数据不足",
};

export interface LifecycleFactors {
  /** 话题年龄(天,自 firstObservedAt);null = 未知 */
  topicAgeDays: number | null;
  memberCount: number;
  /** 当前窗口新增内容数(§AG);null = 无快照证据 */
  recentNew: number | null;
  /** 基准窗口新增内容数 */
  baselineNew: number | null;
  /** 创作者增长是否为正(true/false/unknown) */
  creatorGrowthPositive: boolean | null;
  /** 二阶变化(当前新增 − 基准新增) */
  acceleration: number | null;
  /** Topic Trend Score(§AF);null = 未评分 → unknown */
  trendScore: number | null;
  /** 爆发内容占比 0-1 */
  burstDensity: number | null;
  /** 近期 trend 分序列(升序,来自 topic_trend_snapshots) */
  trendHistory: number[];
  /** §AY v1 饱和代理 */
  growthFlattening: boolean | null;
  creatorConcentration: number | null;
}

export interface LifecycleDecision {
  state: LifecycleState | "unknown";
  reason: string;
}

export function decideLifecycle(f: LifecycleFactors, profile: LifecycleProfile): LifecycleDecision {
  // ---- insufficient(§AX):不硬造阶段 ----
  if (f.trendScore === null) return { state: "unknown", reason: "尚未计算话题趋势分" };
  if (f.memberCount < 3) return { state: "unknown", reason: `成员仅 ${f.memberCount} 条,不足以判定阶段` };

  const decliningStreak =
    f.trendHistory.length >= profile.decliningConsecutiveLow &&
    f.trendHistory.slice(-profile.decliningConsecutiveLow).every((s) => s < profile.decliningTrendMax);

  // 1) declining(§AT):不因单日波动判定 —— 需"近期零新增且基准有量"或连续低分
  if (
    (f.recentNew === 0 && (f.baselineNew ?? 0) >= 3) ||
    (decliningStreak && (f.recentNew === null || f.recentNew <= (f.baselineNew ?? 0)))
  ) {
    return {
      state: "declining",
      reason: `近期新增 ${f.recentNew ?? "—"} vs 基准 ${f.baselineNew ?? "—"};趋势分 ${round1(f.trendScore)}${
        decliningStreak ? ";连续低分" : ""
      }`,
    };
  }

  // 2) emerging(§AP):年龄短 + 有新增 + 规模未大
  if (
    f.topicAgeDays !== null &&
    f.topicAgeDays <= profile.emergingMaxAgeDays &&
    f.memberCount <= profile.emergingMaxMembers &&
    (f.recentNew ?? 0) > 0
  ) {
    return {
      state: "emerging",
      reason: `话题年龄 ${round1(f.topicAgeDays)} 天,近窗口新增 ${f.recentNew},成员 ${f.memberCount} 条`,
    };
  }

  // 3) peak(§AR):绝对活跃度高 + 爆发密度高(不解释为"即将下降")
  if (
    f.memberCount >= profile.peakMinMembers &&
    (f.burstDensity ?? 0) >= profile.peakMinBurstDensity &&
    f.trendScore >= profile.peakTrendMin
  ) {
    return {
      state: "peak",
      reason: `成员 ${f.memberCount} 条、爆发密度 ${round1((f.burstDensity ?? 0) * 100)}%、趋势分 ${round1(f.trendScore)},处于高热度阶段`,
    };
  }

  // 4) rising(§AQ):趋势分高 + 内容增长为正 + 创作者增长非负 + 加速度未转负
  if (
    f.trendScore >= profile.risingTrendMin &&
    (f.recentNew ?? 0) > (f.baselineNew ?? 0) &&
    f.creatorGrowthPositive !== false &&
    (f.acceleration === null || f.acceleration >= 0)
  ) {
    return {
      state: "rising",
      reason: `趋势分 ${round1(f.trendScore)},近窗口新增 ${f.recentNew} > 基准 ${f.baselineNew},仍在扩大`,
    };
  }

  // 5) saturated(§AS):高内容量 + 增长趋平(初步饱和判断,v1 代理)
  const ratio =
    f.recentNew !== null && f.baselineNew !== null && f.baselineNew > 0 ? f.recentNew / f.baselineNew : null;
  if (
    f.memberCount >= profile.saturatedMinMembers &&
    ratio !== null &&
    ratio >= profile.saturatedGrowthRatioBand[0] &&
    ratio <= profile.saturatedGrowthRatioBand[1] &&
    (f.burstDensity ?? 0) < profile.peakMinBurstDensity
  ) {
    return {
      state: "saturated",
      reason: `成员 ${f.memberCount} 条,新增/基准 = ${round1(ratio)}(趋平);初步饱和判断(v1 代理)`,
    };
  }

  // 6) evergreen(§AU):长龄 + 低波动 + 持续有小量内容流
  const volatility = stddev(f.trendHistory);
  if (
    f.topicAgeDays !== null &&
    f.topicAgeDays >= profile.evergreenMinAgeDays &&
    (volatility === null || volatility <= profile.evergreenMaxVolatility)
  ) {
    return {
      state: "evergreen",
      reason: `话题年龄 ${round1(f.topicAgeDays)} 天,趋势分波动 ${volatility === null ? "样本不足" : round1(volatility)},长期稳定讨论`,
    };
  }

  // ---- 兜底(全部条件未命中;按可得证据归入最接近态,reason 说明依据) ----
  // 创作者退潮或增长回落且趋势平淡 → 保守归入饱和观察(§AQ 负向信号同样约束兜底)
  if (
    f.creatorGrowthPositive === false ||
    (f.recentNew !== null && f.baselineNew !== null && f.recentNew < f.baselineNew && f.trendScore < 55)
  ) {
    return {
      state: "saturated",
      reason: `增长平淡(新增 ${f.recentNew ?? "—"} / 基准 ${f.baselineNew ?? "—"}${f.creatorGrowthPositive === false ? ",创作者退潮" : ""}),保守归入饱和观察`,
    };
  }
  if (f.trendScore >= 55 && (f.recentNew ?? 0) >= 0) {
    return { state: "rising", reason: `趋势分 ${round1(f.trendScore)} 且无衰退证据,保守归入上升` };
  }
  return { state: "evergreen", reason: `年龄 ${round1(f.topicAgeDays ?? 0)} 天、增长平稳,归入常青` };
}
