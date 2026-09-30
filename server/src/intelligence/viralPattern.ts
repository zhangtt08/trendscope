/**
 * Viral Pattern Engine (Stage 8 §3-§27):爆发内容 vs 匹配控制组的特征共性。
 * 爆发组 = Burst Score ≥ 阈值(集中配置);控制组按梯子匹配并记录 controlMatchLevel;
 * Lift 是**观察到的关联**,不是因果(§17,UI 文案红线);零命中用平滑(§19);
 * 样本不足 → insufficient_data(§6),绝不输出"N=2 的夸张结论"。
 */
import type { IntelligenceProfile } from "./profiles";
import { INTELLIGENCE_PROFILE, VIRAL_PATTERN_V1 } from "./profiles";
import { DETERMINISTIC_BOOLEAN_FEATURES, DETERMINISTIC_CONTINUOUS_FEATURES, DeterministicFeatures } from "./features";
import type { SemanticFeatures } from "./semanticFeatures";

export interface FeatureRecord {
  contentItemId: number;
  platform: string;
  contentType: string;
  ageBucket: string;
  topicId: number | null;
  authorKey: string | null;
  publishedAt: string | null;
  burstScore: number | null;
  deterministic: DeterministicFeatures;
  semantic: SemanticFeatures | null;
}

export interface BooleanLift {
  viralRate: number;
  controlRate: number;
  lift: number;
}

export interface ContinuousComparison {
  viralMedian: number;
  controlMedian: number;
  viralIqr: [number, number];
  controlIqr: [number, number];
  delta: number;
}

export interface CategoricalDistribution {
  viral: Record<string, number>;
  control: Record<string, number>;
  maxShareDelta: number;
  topFeature?: string;
}

export type FeatureValue =
  | BooleanLift
  | ContinuousComparison
  | CategoricalDistribution
  | { hits: number; n: number }
  | { median: number; n: number };

export interface PatternResult {
  scope: "topic" | "platform_global";
  topicId: number | null;
  platform: string | null;
  windowHours: number;
  feature: string;
  featureKind: "boolean" | "continuous" | "categorical";
  viralValue: FeatureValue;
  controlValue: FeatureValue;
  lift: number | null;
  delta: number | null;
  viralSampleSize: number;
  controlSampleSize: number;
  evidenceQuality: "high" | "medium" | "low" | "insufficient";
  notes: { controlMatchLevel: string; smoothingApplied: boolean; direction: "positive" | "negative" | "none" };
  featureVersion: string;
  patternVersion: string;
  calculatedAt: string;
}

export interface ControlMatch {
  level: number;
  levelLabel: string;
  controls: FeatureRecord[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function medianOf(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * §4/§5:控制组匹配梯子。同话题内逐级放宽;仍不足 → 同平台全局(标注
 * platform_global,避免拿全站当控制组的伪统计)。返回 null = 控制组不足。
 */
export function matchControlGroup(
  viral: FeatureRecord[],
  topicCandidates: FeatureRecord[],
  platformPool: FeatureRecord[],
  profile: IntelligenceProfile,
): ControlMatch | null {
  const viralIds = new Set(viral.map((v) => v.contentItemId));
  const pool = topicCandidates.filter((c) => !viralIds.has(c.contentItemId));
  const platforms = new Set(viral.map((v) => v.platform));
  const types = new Set(viral.map((v) => v.contentType));
  const buckets = new Set(viral.map((v) => v.ageBucket));
  const l0 = pool.filter((c) => platforms.has(c.platform) && types.has(c.contentType) && buckets.has(c.ageBucket));
  if (l0.length >= profile.minimumControlSample) return { level: 0, levelLabel: profile.controlLevels[0], controls: l0 };
  const l1 = pool.filter((c) => platforms.has(c.platform) && buckets.has(c.ageBucket));
  if (l1.length >= profile.minimumControlSample) return { level: 1, levelLabel: profile.controlLevels[1], controls: l1 };
  const l2 = pool.filter((c) => platforms.has(c.platform));
  if (l2.length >= profile.minimumControlSample) return { level: 2, levelLabel: profile.controlLevels[2], controls: l2 };
  if (pool.length >= profile.minimumControlSample) return { level: 3, levelLabel: profile.controlLevels[3], controls: pool };
  const globalPool = platformPool.filter((c) => !viralIds.has(c.contentItemId) && platforms.has(c.platform));
  if (globalPool.length >= profile.minimumControlSample) {
    return { level: 4, levelLabel: profile.controlLevels[4], controls: globalPool };
  }
  return null;
}

/** §19:controlRate=0 不得输出 Infinity → add-1(Jeffreys)平滑,记录 smoothingApplied。 */
export function booleanLift(
  viralHits: number,
  viralN: number,
  controlHits: number,
  controlN: number,
  profile: IntelligenceProfile,
): { lift: BooleanLift; smoothingApplied: boolean } {
  const zeroSide = viralHits === 0 || controlHits === 0;
  const s = profile.smoothing;
  const vRate = zeroSide ? (viralHits + s.pseudoHits) / (viralN + s.pseudoTrials) : viralHits / viralN;
  const cRate = zeroSide ? (controlHits + s.pseudoHits) / (controlN + s.pseudoTrials) : controlHits / controlN;
  return {
    lift: { viralRate: vRate, controlRate: cRate, lift: cRate > 0 ? vRate / cRate : 0 },
    smoothingApplied: zeroSide,
  };
}

function evidenceQualityFor(viralN: number, controlN: number, profile: IntelligenceProfile): PatternResult["evidenceQuality"] {
  const min = Math.min(viralN, controlN);
  if (min >= profile.evidence.high) return "high";
  if (min >= profile.evidence.medium) return "medium";
  return "low";
}

const SEMANTIC_NUMERIC = [
  "conflictIntensity",
  "controversy",
  "emotionalIntensity",
  "identityIdentification",
  "positionClarity",
  "counterIntuitive",
  "utility",
  "novelty",
  "participationThreshold",
  "stanceTakingSpace",
] as const;

/**
 * 单个 cohort 对的全部特征 PatternResult(§22 全字段)。
 * 排序原则(§26):evidence quality 优先,再按效应量 —— 不让 N=2 的夸张 lift 排第一。
 */
export function computePatterns(
  viral: FeatureRecord[],
  controls: FeatureRecord[],
  controlLevel: ControlMatch,
  opts: { scope: "topic" | "platform_global"; topicId: number | null; platform: string | null; now: number; semanticAvailable: boolean },
): PatternResult[] {
  const profile = INTELLIGENCE_PROFILE;
  const results: PatternResult[] = [];
  const calculatedAt = new Date(opts.now).toISOString();
  const base = {
    scope: opts.scope,
    topicId: opts.topicId,
    platform: opts.platform,
    windowHours: profile.windowHours,
    viralSampleSize: viral.length,
    controlSampleSize: controls.length,
    featureVersion: "CONTENT_FEATURES_V1",
    patternVersion: VIRAL_PATTERN_V1,
    calculatedAt,
  };
  const quality = evidenceQualityFor(viral.length, controls.length, profile);

  // ---- 布尔特征(deterministic + semantic 枚举不在此列) ----
  for (const f of DETERMINISTIC_BOOLEAN_FEATURES) {
    const vHits = viral.filter((v) => v.deterministic[f]).length;
    const cHits = controls.filter((c) => c.deterministic[f]).length;
    const { lift, smoothingApplied } = booleanLift(vHits, viral.length, cHits, controls.length, profile);
    const direction = lift.lift > 1.15 ? "positive" : lift.lift < 0.87 ? "negative" : "none";
    results.push({
      ...base,
      feature: f,
      featureKind: "boolean",
      viralValue: lift,
      controlValue: { hits: cHits, n: controls.length },
      lift: lift.lift,
      delta: lift.viralRate - lift.controlRate,
      evidenceQuality: quality,
      notes: { controlMatchLevel: controlLevel.levelLabel, smoothingApplied, direction },
    });
  }

  // ---- 连续特征(§20:median + IQR,不硬转 bool) ----
  for (const f of DETERMINISTIC_CONTINUOUS_FEATURES) {
    const vVals = viral.map((v) => v.deterministic[f]).filter((x): x is number => x !== null);
    const cVals = controls.map((c) => c.deterministic[f]).filter((x): x is number => x !== null);
    if (vVals.length === 0 || cVals.length === 0) continue;
    const vSorted = [...vVals].sort((a, b) => a - b);
    const cSorted = [...cVals].sort((a, b) => a - b);
    const vMedian = quantile(vSorted, 0.5);
    const cMedian = quantile(cSorted, 0.5);
    const cc: ContinuousComparison = {
      viralMedian: vMedian,
      controlMedian: cMedian,
      viralIqr: [quantile(vSorted, profile.continuous.p25 / 100), quantile(vSorted, profile.continuous.p75 / 100)],
      controlIqr: [quantile(cSorted, profile.continuous.p25 / 100), quantile(cSorted, profile.continuous.p75 / 100)],
      delta: vMedian - cMedian,
    };
    const denom = Math.abs(cMedian) > 1e-9 ? Math.abs(cMedian) : 1;
    const ratioDelta = cc.delta / denom;
    results.push({
      ...base,
      feature: f,
      featureKind: "continuous",
      viralValue: cc,
      controlValue: { median: cMedian, n: cVals.length },
      lift: cMedian !== 0 ? vMedian / cMedian : null,
      delta: cc.delta,
      evidenceQuality: quality,
      notes: {
        controlMatchLevel: controlLevel.levelLabel,
        smoothingApplied: false,
        direction: ratioDelta > 0.15 ? "positive" : ratioDelta < -0.15 ? "negative" : "none",
      },
    });
  }

  // ---- 语义连续特征(可用时;§10) ----
  if (opts.semanticAvailable && viral.some((v) => v.semantic) && controls.some((c) => c.semantic)) {
    for (const f of SEMANTIC_NUMERIC) {
      const vVals = viral.map((v) => v.semantic?.[f]).filter((x): x is number => typeof x === "number");
      const cVals = controls.map((c) => c.semantic?.[f]).filter((x): x is number => typeof x === "number");
      if (vVals.length < 3 || cVals.length < 3) continue;
      const vMedian = medianOf(vVals);
      const cMedian = medianOf(cVals);
      results.push({
        ...base,
        feature: `semantic.${f}`,
        featureKind: "continuous",
        viralValue: { viralMedian: vMedian, controlMedian: cMedian, viralIqr: [0, 0], controlIqr: [0, 0], delta: vMedian - cMedian },
        controlValue: { median: cMedian, n: cVals.length },
        lift: cMedian > 1e-9 ? vMedian / cMedian : null,
        delta: vMedian - cMedian,
        evidenceQuality: quality,
        notes: {
          controlMatchLevel: controlLevel.levelLabel,
          smoothingApplied: false,
          direction: vMedian - cMedian > 0.1 ? "positive" : vMedian - cMedian < -0.1 ? "negative" : "none",
        },
      });
    }
    // ---- 语义枚举特征(§21:分布差异) ----
    for (const f of ["hookType", "contentStructure"] as const) {
      const dist = (rows: FeatureRecord[]): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const r of rows) {
          const v = r.semantic?.[f];
          if (v) out[v] = (out[v] ?? 0) + 1;
        }
        return out;
      };
      const vDist = dist(viral);
      const cDist = dist(controls);
      const toShare = (d: Record<string, number>, n: number): Record<string, number> =>
        Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v / Math.max(1, n)]));
      const vShare = toShare(vDist, viral.length);
      const cShare = toShare(cDist, controls.length);
      const keys = new Set([...Object.keys(vShare), ...Object.keys(cShare)]);
      let topFeature: string | undefined;
      let maxShareDelta = 0;
      for (const k of keys) {
        const d = (vShare[k] ?? 0) - (cShare[k] ?? 0);
        if (Math.abs(d) > Math.abs(maxShareDelta)) {
          maxShareDelta = d;
          topFeature = k;
        }
      }
      results.push({
        ...base,
        feature: `semantic.${f}`,
        featureKind: "categorical",
        viralValue: { viral: vDist, control: cDist, maxShareDelta, topFeature } satisfies CategoricalDistribution,
        controlValue: { viral: vDist, control: cDist, maxShareDelta, topFeature } satisfies CategoricalDistribution,
        lift: null,
        delta: maxShareDelta,
        evidenceQuality: quality,
        notes: { controlMatchLevel: controlLevel.levelLabel, smoothingApplied: false, direction: "none" },
      });
    }
  }
  return results;
}

/** §26:证据质量优先,再按 |效应量|;正负模式都保留(§27)。 */
export function sortPatterns(results: PatternResult[]): PatternResult[] {
  const qualityRank: Record<string, number> = { high: 0, medium: 1, low: 2, insufficient: 3 };
  const effect = (r: PatternResult): number => {
    if (r.featureKind === "boolean" && r.lift !== null) return Math.abs(r.lift - 1);
    if (r.delta !== null && Number.isFinite(r.delta)) return Math.abs(r.delta);
    return 0;
  };
  return [...results].sort((a, b) => qualityRank[a.evidenceQuality] - qualityRank[b.evidenceQuality] || effect(b) - effect(a));
}
