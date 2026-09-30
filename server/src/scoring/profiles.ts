/**
 * Scoring profiles (Stage 7 §AA/§BX):全部默认参数集中于此,禁止散落 magic numbers。
 * 权重是设计初始值(§R/§AF);任何调整必须同步 DECISIONS.md 与 scoreVersion。
 * 确定性:同 configSnapshot + 同数据 → 同结果(§CD);无 LLM 参与(§BB)。
 */

export const CONTENT_BURST_V1 = "CONTENT_BURST_V1";
export const TOPIC_TREND_V1 = "TOPIC_TREND_V1";

export interface AgeBucket {
  key: string;
  /** 上界(小时);null = 无上界(最后一档) */
  maxHours: number | null;
}

export interface ContentBurstProfile {
  version: string;
  weights: {
    velocity: number;
    reach: number;
    engagementQuality: number;
    relativePerformance: number;
    interactionStructure: number;
  };
  /** §T:支持的观察窗口(小时);evidence 保留全部窗口数据 */
  velocityWindows: { key: string; hours: number }[];
  /** 主窗口(按序回退):该窗口内 ≥2 快照才可用 */
  velocityFallback: string[];
  minSnapshotsForVelocity: number;
  /** §J:发布年龄分桶(边界集中) */
  ageBuckets: AgeBucket[];
  /** §K:cohort 回退梯子(细→粗)与样本阈值 */
  cohort: {
    /** 各级想要的理想样本量;达到即停 */
    minSample: number;
    /** platform 级兜底最低样本;低于 = insufficient_cohort */
    floorSample: number;
    /** 0=platform+contentType+age+topic 1=…+无topic 2=platform+age 3=platform */
    levelLabels: ["exact", "broadened_once", "broadened_twice", "platform_only"];
  };
  /** §O:creator baseline 最少历史条数 */
  creatorMinHistory: number;
  confidence: {
    high: number;
    medium: number;
    /** 每项扣分(确定性;详见 confidence.ts 注释) */
    penaltySmallCohort: number;
    penaltyTinyCohort: number;
    penaltySingleSnapshot: number;
    penaltyShortSpan: number;
    penaltyLowSignal: number;
    shortSpanHours: number;
  };
}

export const CONTENT_BURST_PROFILE: ContentBurstProfile = {
  version: CONTENT_BURST_V1,
  weights: {
    velocity: 0.35,
    reach: 0.2,
    engagementQuality: 0.2,
    relativePerformance: 0.15,
    interactionStructure: 0.1,
  },
  velocityWindows: [
    { key: "6h", hours: 6 },
    { key: "24h", hours: 24 },
    { key: "72h", hours: 72 },
    { key: "7d", hours: 168 },
  ],
  velocityFallback: ["24h", "72h", "7d"],
  minSnapshotsForVelocity: 2,
  ageBuckets: [
    { key: "0-6h", maxHours: 6 },
    { key: "6-24h", maxHours: 24 },
    { key: "1-3d", maxHours: 72 },
    { key: "3-7d", maxHours: 168 },
    { key: "7-30d", maxHours: 720 },
    { key: "30d+", maxHours: null },
  ],
  cohort: {
    minSample: 30,
    floorSample: 5,
    levelLabels: ["exact", "broadened_once", "broadened_twice", "platform_only"],
  },
  creatorMinHistory: 5,
  confidence: {
    high: 0.75,
    medium: 0.45,
    penaltySmallCohort: 0.1,
    penaltyTinyCohort: 0.2,
    penaltySingleSnapshot: 0.3,
    penaltyShortSpan: 0.1,
    penaltyLowSignal: 0.15,
    shortSpanHours: 1,
  },
};

export interface TopicTrendProfile {
  version: string;
  weights: {
    contentGrowth: number;
    engagementGrowth: number;
    creatorGrowth: number;
    burstDensity: number;
    acceleration: number;
  };
  /** 当前窗口(小时);baseline = 之前等长窗口 */
  windowHours: number;
  /** §AJ:爆发内容占比阈值(burst score ≥ 此值算爆发) */
  burstDensityThreshold: number;
  /** 少于该成员数 → unscorable(§BH) */
  minMembers: number;
  /** §AI:creator 归并 key 缺失时用 authorName 兜底 */
  confidence: {
    high: number;
    medium: number;
    penaltyFewMembers: number;
    penaltyFewSnapshots: number;
    penaltyLowScoreCoverage: number;
    fewMembers: number;
    fewSnapshots: number;
    lowScoreCoverage: number;
  };
}

export const TOPIC_TREND_PROFILE: TopicTrendProfile = {
  version: TOPIC_TREND_V1,
  weights: {
    contentGrowth: 0.35,
    engagementGrowth: 0.25,
    creatorGrowth: 0.15,
    burstDensity: 0.15,
    acceleration: 0.1,
  },
  windowHours: 168,
  burstDensityThreshold: 80,
  minMembers: 3,
  confidence: {
    high: 0.75,
    medium: 0.45,
    penaltyFewMembers: 0.15,
    penaltyFewSnapshots: 0.15,
    penaltyLowScoreCoverage: 0.2,
    fewMembers: 10,
    fewSnapshots: 3,
    lowScoreCoverage: 0.5,
  },
};

/** 生命周期判定与滞回阈值(§AN-§AV)。全部集中;UI 中文见 lifecycle.ts。 */
export interface LifecycleProfile {
  /** 新兴:话题年龄上限(天)与规模上限 */
  emergingMaxAgeDays: number;
  emergingMaxMembers: number;
  /** rising:trend 分下限;content/creator growth 需为正 */
  risingTrendMin: number;
  /** peak:绝对规模与爆发密度下限;acceleration 需趋缓 */
  peakMinMembers: number;
  peakMinBurstDensity: number;
  peakTrendMin: number;
  /** saturated:增长趋平的比率带(当前/基准)与规模下限 */
  saturatedGrowthRatioBand: [number, number];
  saturatedMinMembers: number;
  /** declining:连续低分观察数 / 近期零新增且基准有量的最低门槛 */
  decliningTrendMax: number;
  decliningConsecutiveLow: number;
  /** evergreen:年龄下限(天)与波动上限(近期 trend 分标准差) */
  evergreenMinAgeDays: number;
  evergreenMaxVolatility: number;
  /** hysteresis(§AV):需连续观察次数;或分数强突破阈值(免等待) */
  hysteresisConsecutive: number;
  hysteresisStrongJump: number;
}

export const LIFECYCLE_PROFILE: LifecycleProfile = {
  emergingMaxAgeDays: 3,
  emergingMaxMembers: 30,
  risingTrendMin: 60,
  peakMinMembers: 20,
  peakMinBurstDensity: 0.25,
  peakTrendMin: 70,
  saturatedGrowthRatioBand: [0.4, 1.6],
  saturatedMinMembers: 30,
  decliningTrendMax: 40,
  decliningConsecutiveLow: 2,
  evergreenMinAgeDays: 30,
  evergreenMaxVolatility: 8,
  hysteresisConsecutive: 2,
  hysteresisStrongJump: 25,
};

/** 运行时把 profile 全量快照进 run/configSnapshot(§AA 可解释旧结果)。 */
export function configSnapshotFor(profiles: {
  burst: ContentBurstProfile;
  trend: TopicTrendProfile;
  lifecycle: LifecycleProfile;
}): string {
  return JSON.stringify({ burst: profiles.burst, trend: profiles.trend, lifecycle: profiles.lifecycle });
}

export const SCORING_PROFILES = {
  burst: CONTENT_BURST_PROFILE,
  trend: TOPIC_TREND_PROFILE,
  lifecycle: LIFECYCLE_PROFILE,
} as const;
