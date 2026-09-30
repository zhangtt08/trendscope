/**
 * Opportunity Engine (Stage 9 §5-§24/§41):只消费既有 Engine 的 Current 快照,
 * 不重算任何 Trend/Saturation/Novelty/Pattern(§49)。确定性;missing-aware 重归一;
 * Confidence 与 Score 独立(§16,数据多少不改变分数,只改变置信)。
 * 输出是"值得进一步研究的结构化量化",不是未来结果概率(§1 红线)。
 */
import type { OpportunityProfile } from "./profiles";
import { round1 } from "../scoring/percentile";

export interface OpportunityInputTrend {
  score: number | null;
  confidence: string | null;
  lifecycle: string | null;
  calculatedAt: string | null;
  memberCount: number | null;
  /** 话题来自词法聚类还是语义(§18 quality mode) */
  qualityMode: "lexical_baseline" | "semantic";
}

export interface OpportunityInputBurst {
  /** topic_score_current.burstDensity(0-100 分量分) */
  density: number | null;
  /** 成员爆发分布(content_score_current by topic) */
  memberScores: { score: number; publishedAt: string | null }[];
  calculatedAt: string | null;
}

export interface OpportunityInputNovelty {
  score: number | null;
  emergingAngleCount: number | null;
  confidence: string | null;
  calculatedAt: string | null;
}

export interface OpportunityInputWhitespace {
  /** 饱和度快照分;unscorable → null → Whitespace unknown(§10,禁 100) */
  saturationScore: number | null;
  saturationScorable: boolean;
  confidence: string | null;
  calculatedAt: string | null;
}

export interface OpportunityInputPattern {
  /** 最近一次 intelligence run 的 pattern rows(无 rows → unknown,§12 判定见 D20) */
  patterns: {
    evidenceQuality: string;
    lift: number | null;
    delta: number | null;
    featureKind: string;
    viralSampleSize: number;
    controlSampleSize: number;
    direction?: string;
  }[] | null;
}

export interface OpportunityInput {
  trend: OpportunityInputTrend | null;
  burst: OpportunityInputBurst | null;
  novelty: OpportunityInputNovelty | null;
  whitespace: OpportunityInputWhitespace | null;
  pattern: OpportunityInputPattern | null;
  /** 当前时间(注入,§CD) */
  now: number;
}

export interface ComponentContribution {
  raw: number | null;
  weight: number;
  effectiveWeight: number | null;
  contribution: number | null;
  available: boolean;
}

export interface OpportunityOutput {
  scorable: boolean;
  unscorableReason: string | null;
  score: number | null;
  confidence: "high" | "medium" | "low" | null;
  confidenceScore: number | null;
  opportunityLevel: "high" | "medium" | "low" | null;
  components: Record<string, ComponentContribution> | null;
  effectiveWeights: Record<string, number> | null;
  reasonCodes: string[];
  positiveReasons: string[];
  limitingReasons: string[];
  evidence: Record<string, unknown>;
}

/** Burst Opportunity(§8):密度 + 上分位 + 近期爆发数;median 语义已含在 density;
 *  单条爆款无法拉高 p75/密度(§CA 延续)。 */
export function computeBurstOpportunity(burst: OpportunityInputBurst, profile: OpportunityProfile, now: number): { score: number | null; recentBurstCount: number | null; coverage: number | null; top: number | null; p75: number | null; median: number | null } {
  const scores = burst.memberScores.map((m) => m.score).filter((s) => Number.isFinite(s));
  if (burst.density === null && scores.length === 0) {
    return { score: null, recentBurstCount: null, coverage: null, top: null, p75: null, median: null };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const q = (p: number): number | null =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const cut = now - profile.recentBurstWindowHours * 3_600_000;
  const recentBurstCount = burst.memberScores.filter(
    (m) => m.score >= 80 && m.publishedAt !== null && Date.parse(m.publishedAt) >= cut,
  ).length;
  const density = burst.density ?? 0;
  const p75 = q(0.75) ?? 0;
  const score = Math.max(
    0,
    Math.min(
      100,
      profile.burstMix.density * density +
        profile.burstMix.p75 * p75 +
        profile.burstMix.recentCount * Math.min(100, recentBurstCount * 20),
    ),
  );
  return {
    score: Math.round(score * 10) / 10,
    recentBurstCount,
    coverage: burst.memberScores.length > 0 ? scores.length / burst.memberScores.length : 0,
    top: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    p75,
    median: q(0.5),
  };
}

/** Pattern Strength(§12):高证据数量 × 效应量;禁 max lift → 100。 */
export function computePatternStrength(patterns: NonNullable<OpportunityInputPattern["patterns"]>): number {
  let base = 0;
  let maxEffect = 0;
  for (const p of patterns) {
    if (p.evidenceQuality !== "high" && p.evidenceQuality !== "medium") continue;
    const effect =
      p.featureKind === "boolean" && p.lift !== null
        ? Math.abs(p.lift - 1)
        : Math.abs(p.delta ?? 0);
    const normalized = Math.min(1, effect);
    if (p.evidenceQuality === "high") base += 20 * (0.6 + 0.4 * normalized);
    else base += 12 * (0.6 + 0.4 * normalized);
    maxEffect = Math.max(maxEffect, normalized);
  }
  return Math.min(100, base + maxEffect * 20);
}

export function computeOpportunity(input: OpportunityInput, profile: OpportunityProfile): OpportunityOutput {
  const now = input.now;
  const evidence: Record<string, unknown> = {};
  const reasonCodes: string[] = [];

  // ---- 各组件 raw 分(0-100)或 unknown ----
  const trendRaw = input.trend?.score ?? null;
  const burstCalc = input.burst ? computeBurstOpportunity(input.burst, profile, input.now) : null;
  const burstRaw = burstCalc?.score ?? null;
  const noveltyRaw = input.novelty?.score ?? null;
  // §10:饱和 unscorable → whitespace unknown;绝不 100
  const whitespaceRaw =
    input.whitespace && input.whitespace.saturationScorable && input.whitespace.saturationScore !== null
      ? Math.max(0, Math.min(100, 100 - input.whitespace.saturationScore))
      : null;
  const patternRaw =
    input.pattern?.patterns && input.pattern.patterns.length > 0 ? computePatternStrength(input.pattern.patterns) : null;
  const lifecycleRaw =
    input.trend?.lifecycle != null ? (profile.lifecycleFit[input.trend.lifecycle] ?? null) : null;

  const raws: Record<string, number | null> = {
    trend: trendRaw,
    burst: burstRaw,
    novelty: noveltyRaw,
    whitespace: whitespaceRaw,
    pattern: patternRaw,
    lifecycle: lifecycleRaw,
  };
  const available = Object.entries(raws).filter(([, v]) => v !== null);
  const weightOf = (k: string): number => (profile.weights as Record<string, number>)[k];

  // ---- §23 最低证据门 ----
  if (available.length < profile.minimumAvailableComponents) {
    return unscorable("INSUFFICIENT_COMPONENTS", `可用组件 ${available.length}/${profile.minimumAvailableComponents}`, reasonCodes);
  }
  if (trendRaw === null && noveltyRaw === null) {
    return unscorable("NO_CORE_EVIDENCE", "缺少核心证据(趋势/新颖度均不可用)", reasonCodes);
  }

  // ---- missing-aware 合成(§15) ----
  const weightSum = available.reduce((s, [k]) => s + weightOf(k), 0);
  const effectiveWeights: Record<string, number> = {};
  const components: Record<string, ComponentContribution> = {};
  let overall = 0;
  for (const [k, v] of Object.entries(raws)) {
    const w = weightOf(k);
    const eff = v !== null ? w / weightSum : null;
    effectiveWeights[k] = eff !== null ? Math.round(eff * 1000) / 1000 : 0;
    components[k] = {
      raw: v,
      weight: w,
      effectiveWeight: eff,
      contribution: v !== null && eff !== null ? Math.round(v * eff * 10) / 10 : null,
      available: v !== null,
    };
    if (v !== null && eff !== null) overall += v * eff;
  }
  overall = Math.max(0, Math.min(100, overall));

  // ---- Reason codes + 正向/限制(§24/§25) ----
  const positiveReasons: string[] = [];
  const limitingReasons: string[] = [];
  const conf = profile.confidence;
  const trend = input.trend;
  if (trendRaw !== null && trendRaw >= 60) {
    reasonCodes.push("HIGH_TREND");
    positiveReasons.push(`趋势指数 ${Math.round(trendRaw)}`);
  }
  if (trend?.lifecycle === "rising") {
    reasonCodes.push("RISING_LIFECYCLE");
    positiveReasons.push("处于上升阶段");
  }
  if (trend?.lifecycle === "emerging") {
    reasonCodes.push("EMERGING_LIFECYCLE");
    positiveReasons.push("新兴话题(样本风险需注意)");
  }
  if (noveltyRaw !== null && noveltyRaw >= 60) {
    reasonCodes.push("HIGH_NOVELTY");
    positiveReasons.push(`新颖度 ${Math.round(noveltyRaw)}`);
  }
  if ((input.novelty?.emergingAngleCount ?? 0) > 0) {
    reasonCodes.push("EMERGING_ANGLES");
    positiveReasons.push(`检测到 ${input.novelty!.emergingAngleCount} 个新兴角度`);
  }
  const satScore = input.whitespace?.saturationScorable ? input.whitespace?.saturationScore : null;
  if (satScore !== null && satScore !== undefined) {
    if (satScore < 40) {
      reasonCodes.push("LOW_SATURATION");
      positiveReasons.push(`饱和度 ${Math.round(satScore)},内容空间 ${Math.round(whitespaceRaw ?? 0)}`);
    } else if (satScore >= 67) {
      reasonCodes.push("HIGH_SATURATION");
      limitingReasons.push(`饱和度 ${Math.round(satScore)},内容重复度较高`);
    }
  }
  if ((input.burst?.density ?? 0) >= 25) {
    reasonCodes.push("STRONG_BURST_DENSITY");
    positiveReasons.push(`爆发内容占比 ${Math.round(input.burst!.density!)}`);
  }
  const highPatterns = (input.pattern?.patterns ?? []).filter((p) => p.evidenceQuality === "high");
  if (highPatterns.length > 0) {
    reasonCodes.push("CLEAR_VIRAL_PATTERNS");
    positiveReasons.push(`${highPatterns.length} 条高证据爆发共性`);
  }
  if (patternRaw === null && input.pattern !== null) {
    reasonCodes.push("PATTERN_SAMPLE_INSUFFICIENT");
    limitingReasons.push("爆发共性样本量不足");
  }
  if ((trend?.memberCount ?? 0) < conf.fewMembers) {
    reasonCodes.push("LOW_TOPIC_HISTORY");
    limitingReasons.push(`话题仅 ${trend?.memberCount ?? 0} 个成员`);
  }

  // ---- Confidence(§16,与分数独立) ----
  let confidenceScore = 1;
  const confValue = (c: string | null | undefined): number =>
    c && conf.confValue[c] !== undefined ? conf.confValue[c] : 0.55;
  // 各上游置信度的保守平均(缺组件该因子跳过)
  const confFactors: number[] = [];
  if (trendRaw !== null) confFactors.push(confValue(trend?.confidence));
  if (noveltyRaw !== null) confFactors.push(confValue(input.novelty?.confidence));
  if (whitespaceRaw !== null) confFactors.push(confValue(input.whitespace?.confidence));
  if (confFactors.length > 0) {
    confidenceScore *= confFactors.reduce((s, v) => s + v, 0) / confFactors.length;
  }
  if ((trend?.memberCount ?? 0) < conf.fewMembers) {
    confidenceScore -= conf.penaltyFewMembers;
    reasonCodes.push("LOW_TOPIC_HISTORY");
  }
  if (trend?.qualityMode === "lexical_baseline") {
    confidenceScore -= conf.penaltyLexicalBaseline;
    reasonCodes.push("LEXICAL_BASELINE_ONLY");
    limitingReasons.push("话题与角度均为词法基线,升级语义向量后更可靠");
  }
  const coverage = burstCalc?.coverage;
  if (coverage !== null && coverage !== undefined && coverage < conf.lowBurstCoverage && (trend?.memberCount ?? 0) > 0) {
    confidenceScore -= conf.penaltyLowBurstCoverage;
    reasonCodes.push("LOW_BURST_COVERAGE");
    limitingReasons.push("成员爆发指数覆盖率低(先运行内容评分)");
  }
  // §50/§51:freshness policy(统一在 profile)
  const staleTrend =
    trend?.calculatedAt && now - Date.parse(trend.calculatedAt) > profile.freshness.trendMaxAgeHours * 3_600_000;
  const staleIntel =
    (input.novelty?.calculatedAt && now - Date.parse(input.novelty.calculatedAt) > profile.freshness.intelligenceMaxAgeHours * 3_600_000) ||
    (input.whitespace?.calculatedAt && now - Date.parse(input.whitespace.calculatedAt) > profile.freshness.intelligenceMaxAgeHours * 3_600_000);
  if (staleTrend) {
    confidenceScore -= profile.freshness.penaltyStale;
    reasonCodes.push("STALE_TREND");
    limitingReasons.push("趋势评分已过期,建议重跑");
  }
  if (staleIntel) {
    confidenceScore -= profile.freshness.penaltyStale;
    reasonCodes.push("STALE_INTELLIGENCE");
    limitingReasons.push("内容情报已过期,建议重跑");
  }
  confidenceScore = Math.max(0, Math.min(1, confidenceScore));
  const confidenceLabel = confidenceScore >= conf.high ? "high" : confidenceScore >= conf.medium ? "medium" : "low";
  if (reasonCodes.includes("PATTERN_SAMPLE_INSUFFICIENT") && !limitingReasons.some((r) => r.includes("样本量不足"))) {
    limitingReasons.push("爆发共性样本量不足");
  }

  evidence.availableComponents = available.map(([k]) => k);
  evidence.burst = burstCalc ? { density: input.burst?.density ?? null, top: burstCalc.top, p75: burstCalc.p75, median: burstCalc.median, recentBurstCount: burstCalc.recentBurstCount, coverage: burstCalc.coverage === null ? null : round1(burstCalc.coverage) } : null;
  evidence.patternCount = input.pattern?.patterns?.length ?? null;
  evidence.memberCount = trend?.memberCount ?? null;
  evidence.qualityMode = trend?.qualityMode ?? null;

  const level: OpportunityOutput["opportunityLevel"] =
    overall >= profile.levelBands.high ? "high" : overall >= profile.levelBands.medium ? "medium" : "low";

  return {
    scorable: true,
    unscorableReason: null,
    score: Math.round(overall * 10) / 10,
    confidence: confidenceLabel,
    confidenceScore: Math.round(confidenceScore * 100) / 100,
    opportunityLevel: level,
    components,
    effectiveWeights,
    reasonCodes: [...new Set(reasonCodes)],
    positiveReasons,
    limitingReasons: [...new Set(limitingReasons)],
    evidence,
  };
}

function unscorable(reason: string, detail: string, reasonCodes: string[]): OpportunityOutput {
  return {
    scorable: false,
    unscorableReason: reason,
    score: null,
    confidence: null,
    confidenceScore: null,
    opportunityLevel: null,
    components: null,
    effectiveWeights: null,
    reasonCodes: [...new Set([...reasonCodes, reason])],
    positiveReasons: [],
    limitingReasons: [detail],
    evidence: { reason: detail },
  };
}

/** §41:why changed —— 组件贡献差的确定性分解。 */
export function computeWhyChanged(
  current: Record<string, number | null>,
  previous: Record<string, number | null>,
): { component: string; delta: number }[] {
  const diffs: { component: string; delta: number }[] = [];
  for (const k of Object.keys(current)) {
    const c = current[k] ?? 0;
    const p = previous[k] ?? 0;
    const d = Math.round((c - p) * 10) / 10;
    if (Math.abs(d) > 0.05) diffs.push({ component: k, delta: d });
  }
  diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return diffs.slice(0, 4);
}
