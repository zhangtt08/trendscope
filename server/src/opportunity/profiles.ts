/**
 * Opportunity profiles (Stage 9 §6/§13/§27/§50/§55-§58):全部参数集中。
 * 权重是设计初始值;调整必须 bump version + 记 DECISIONS;禁止为 fixture 调参(§67)。
 */

export const TOPIC_OPPORTUNITY_V1 = "TOPIC_OPPORTUNITY_V1";

/** 代码内置的两份默认 profile key(自定义 profile 存在库里,见 profileStore.ts)。 */
export type BuiltinOpportunityProfileId = "balanced" | "early_discovery";
/** 引擎只认字符串 key;DB 里的 profile_key 与快照里的 profile_id 共用这一空间。 */
export type OpportunityProfileId = string;

export interface OpportunityProfile {
  id: OpportunityProfileId;
  label: string;
  version: string;
  weights: {
    trend: number;
    burst: number;
    novelty: number;
    whitespace: number;
    pattern: number;
    lifecycle: number;
  };
  /** §23:至少 N 个主要组件可用才可评分 */
  minimumAvailableComponents: number;
  /** §27:机会档位区间(只是分数区间显示,非推荐,§78) */
  levelBands: { high: number; medium: number };
  /** §13:Lifecycle Fit 透明映射(不能一票否决,§14;unknown=数据不足) */
  lifecycleFit: Record<string, number | null>;
  /** §50/§51:freshness policy(统一,不散落 Date.now) */
  freshness: {
    trendMaxAgeHours: number;
    intelligenceMaxAgeHours: number;
    penaltyStale: number;
  };
  confidence: {
    high: number;
    medium: number;
    /** 组件置信度 → 分值 */
    confValue: Record<string, number>;
    penaltyFewMembers: number;
    fewMembers: number;
    penaltyLexicalBaseline: number;
    penaltyLowBurstCoverage: number;
    lowBurstCoverage: number;
  };
  /** §8:Burst Opportunity 合成比例(密度/上分位/近期爆发数;median 防单条爆款) */
  burstMix: { density: number; p75: number; recentCount: number };
  recentBurstWindowHours: number;
}

export const BALANCED_PROFILE: OpportunityProfile = {
  id: "balanced",
  label: "均衡",
  version: "BALANCED_V1",
  weights: {
    trend: 0.3,
    burst: 0.2,
    novelty: 0.15,
    whitespace: 0.15,
    pattern: 0.1,
    lifecycle: 0.1,
  },
  minimumAvailableComponents: 3,
  levelBands: { high: 70, medium: 40 },
  lifecycleFit: {
    emerging: 65,
    rising: 85,
    peak: 70,
    saturated: 45,
    declining: 25,
    evergreen: 55,
    unknown: null,
  },
  freshness: { trendMaxAgeHours: 24, intelligenceMaxAgeHours: 48, penaltyStale: 0.1 },
  confidence: {
    high: 0.75,
    medium: 0.45,
    confValue: { high: 1, medium: 0.7, low: 0.4 },
    penaltyFewMembers: 0.2,
    fewMembers: 10,
    penaltyLexicalBaseline: 0.1,
    penaltyLowBurstCoverage: 0.1,
    lowBurstCoverage: 0.5,
  },
  burstMix: { density: 0.5, p75: 0.3, recentCount: 0.2 },
  recentBurstWindowHours: 24 * 7,
};

/** §57:偏重新颖/内容空间/趋势;UI 必须标"只是分析偏好,不是更准"。 */
export const EARLY_DISCOVERY_PROFILE: OpportunityProfile = {
  ...BALANCED_PROFILE,
  id: "early_discovery",
  label: "早期发现",
  version: "EARLY_DISCOVERY_V1",
  weights: {
    trend: 0.25,
    burst: 0.15,
    novelty: 0.25,
    whitespace: 0.2,
    pattern: 0.05,
    lifecycle: 0.1,
  },
};

export const OPPORTUNITY_PROFILES: Record<OpportunityProfileId, OpportunityProfile> = {
  balanced: BALANCED_PROFILE,
  early_discovery: EARLY_DISCOVERY_PROFILE,
};

/** §26/§76:reason code → 中文(内部保持 code)。 */
export const REASON_ZH: Record<string, string> = {
  HIGH_TREND: "趋势指数较高",
  RISING_LIFECYCLE: "处于上升阶段",
  EMERGING_LIFECYCLE: "新兴话题,样本风险需注意",
  HIGH_NOVELTY: "新颖度较高",
  EMERGING_ANGLES: "出现新兴角度",
  LOW_SATURATION: "内容重复度较低,仍有空间",
  HIGH_SATURATION: "内容重复度较高",
  STRONG_BURST_DENSITY: "爆发内容占比明显",
  CLEAR_VIRAL_PATTERNS: "已出现较清晰的爆发内容共性",
  PATTERN_SAMPLE_INSUFFICIENT: "爆发内容样本不足",
  LOW_TOPIC_HISTORY: "当前话题历史较短",
  LEXICAL_BASELINE_ONLY: "话题与角度均为词法基线",
  STALE_TREND: "趋势评分已过期,建议重跑",
  STALE_INTELLIGENCE: "内容情报已过期,建议重跑",
  LOW_BURST_COVERAGE: "成员爆发指数覆盖率低",
  NO_CORE_EVIDENCE: "缺少核心证据(趋势/新颖度)",
  INSUFFICIENT_COMPONENTS: "可用组件不足",
};

export function configSnapshotFor(profile: OpportunityProfile): string {
  return JSON.stringify({ profile });
}
