/**
 * Content Intelligence profiles (Stage 8 §61/§BX):VIRAL_PATTERN_V1 / SATURATION_V1 /
 * NOVELTY_V1 / ANGLE_TEXT_V1 全部参数集中;调整必须 bump 版本 + 记 DECISIONS。
 */

export const VIRAL_PATTERN_V1 = "VIRAL_PATTERN_V1";
export const SATURATION_V1 = "SATURATION_V1";
export const NOVELTY_V1 = "NOVELTY_V1";
export const ANGLE_TEXT_V1 = "ANGLE_TEXT_V1";
export const CONTENT_FEATURES_V1 = "CONTENT_FEATURES_V1";

export interface IntelligenceProfile {
  /** §3:爆发组定义 = 内容爆发指数 ≥ 此阈值(集中配置,非 views/likes 阈值) */
  viralBurstThreshold: number;
  /** §6:最小样本;不足 → insufficient_data,不硬输出 */
  minimumViralSample: number;
  minimumControlSample: number;
  /** §4:控制组匹配梯子级别标签 */
  controlLevels: string[];
  /** 连续特征比较保留的分位 */
  continuous: { p25: number; p75: number };
  /** §19:controlRate=0 时用 add-1 平滑(Jeffreys),记录 smoothingApplied */
  smoothing: { pseudoHits: number; pseudoTrials: number };
  /** 证据质量分级阈值(基于两侧样本量) */
  evidence: { high: number; medium: number };
  /** §72:Pattern 特征分析窗口(小时) */
  windowHours: number;
}

export const INTELLIGENCE_PROFILE: IntelligenceProfile = {
  viralBurstThreshold: 80,
  minimumViralSample: 8,
  minimumControlSample: 15,
  controlLevels: [
    "exact", // 同话题+平台+类型+年龄桶
    "topic_platform_age", // 同话题+平台+年龄桶
    "topic_platform", // 同话题+平台
    "topic_only", // 同话题
    "platform_global", // 跨话题,同平台(放宽到全局,标注)
  ],
  continuous: { p25: 25, p75: 75 },
  smoothing: { pseudoHits: 1, pseudoTrials: 2 },
  evidence: { high: 30, medium: 10 },
  windowHours: 24 * 30,
};

export interface SaturationProfile {
  version: string;
  weights: {
    volume: number;
    frequency: number;
    angleSimilarity: number;
    repetitionRatio: number;
    creatorConcentration: number;
  };
  /** §30:期望速率(条/天),超过即满分会饱和 */
  volumePerDayExpected: number;
  frequencyPerDayExpected: number;
  /** §38:近邻相似度 ≥ 此值记重复 */
  repetitionSimilarityThreshold: number;
  /** §32:角度相似度计算的成员上限(取最近 N 条,防 O(n²) 爆炸) */
  maxMembersForAngleAnalysis: number;
  /** §40:样本门槛 */
  minMembers: number;
  confidence: { high: number; medium: number; penaltyFewMembers: number; penaltyFewRecent: number; fewMembers: number; fewRecent: number };
}

export const SATURATION_PROFILE: SaturationProfile = {
  version: SATURATION_V1,
  weights: {
    volume: 0.2,
    frequency: 0.2,
    angleSimilarity: 0.25,
    repetitionRatio: 0.2,
    creatorConcentration: 0.15,
  },
  volumePerDayExpected: 1.5,
  frequencyPerDayExpected: 1,
  repetitionSimilarityThreshold: 0.7,
  maxMembersForAngleAnalysis: 300,
  minMembers: 5,
  confidence: {
    high: 0.75,
    medium: 0.45,
    penaltyFewMembers: 0.15,
    penaltyFewRecent: 0.1,
    fewMembers: 10,
    fewRecent: 5,
  },
};

export interface NoveltyProfile {
  version: string;
  /** §45:角度簇相似度阈值(≥ 即同簇) */
  angleClusterSimThreshold: number;
  /** §49:新角度最少成员(1 条离群内容不构成新角度) */
  minAngleMembers: number;
  /** §47:与历史角度的最大相似度 < 此值才算"新" */
  noveltyDistanceThreshold: number;
  /** 近期窗口(小时):firstObserved 在窗口内 = 新角度候选 */
  recentWindowHours: number;
  /** 与历史角度簇调和的同一性阈值(≥ 即继承 ID) */
  angleIdentityThreshold: number;
  weights: {
    historicalDistance: number;
    recentGrowth: number;
    memberAdequacy: number;
    creatorDiversity: number;
  };
  confidence: { high: number; medium: number; penaltyNoHistorical: number; penaltySmallCluster: number };
}

export const NOVELTY_PROFILE: NoveltyProfile = {
  version: NOVELTY_V1,
  angleClusterSimThreshold: 0.6,
  minAngleMembers: 3,
  noveltyDistanceThreshold: 0.5,
  recentWindowHours: 24 * 7,
  angleIdentityThreshold: 0.6,
  weights: {
    historicalDistance: 0.4,
    recentGrowth: 0.25,
    memberAdequacy: 0.2,
    creatorDiversity: 0.15,
  },
  confidence: {
    high: 0.75,
    medium: 0.45,
    penaltyNoHistorical: 0.2,
    penaltySmallCluster: 0.1,
  },
};

export function intelligenceConfigSnapshot(): string {
  return JSON.stringify({
    intelligence: INTELLIGENCE_PROFILE,
    saturation: SATURATION_PROFILE,
    novelty: NOVELTY_PROFILE,
  });
}
