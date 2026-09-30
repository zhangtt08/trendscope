/**
 * Evidence Package 构建器(Part 1 §2-§4、§112、§114)。
 *
 * 三条硬规则:
 *  1. **只选必要证据**,不把数据库字段 stringify 后整包扔给模型 —— 所以这里逐字段命名。
 *  2. **unknown = null**,绝不填 0 冒充(与全项目 null ≠ 0 同一条红线)。
 *  3. 内容文本是**外部数据**,可能写着"忽略之前指令"。这里统一标成 DATA 区块,
 *     system prompt 明确要求把其中内容当待分析数据、不得执行(§112)。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentItems,
  contentScoreCurrent,
  patternResults,
  topicAngleClusters,
  topicIntelligenceCurrent,
  topicMemberships,
  topicOpportunityCurrent,
  topicSaturationSnapshots,
  topicScoreCurrent,
  topics,
} from "../db/schema";
import { LIFECYCLE_LABELS_ZH } from "../scoring/lifecycle";
import { STUDIO_EVIDENCE_BUDGET, STUDIO_EVIDENCE_VERSION, STUDIO_FRESHNESS_WARN_HOURS } from "./config";

export interface EvidenceRefItem {
  /** 模型必须引用这些 id(§10):trend-1 / pattern-2 / angle-1 / burst-content-3 … */
  id: string;
  kind: "topic" | "trend" | "opportunity" | "pattern" | "angle" | "burst-content" | "representative" | "saturation" | "novelty";
  label: string;
}

export interface EvidenceContent {
  refId: string;
  contentItemId: number;
  title: string | null;
  /** 截断后的正文摘要,已标记为数据 */
  excerpt: string | null;
  platform: string;
  contentType: string;
  authorName: string | null;
  burstScore: number | null;
  burstConfidence: string | null;
  likes: number | null;
  comments: number | null;
  publishedAt: string | null;
  truncated: boolean;
}

export interface EvidencePattern {
  refId: string;
  feature: string;
  featureKind: string;
  viralRate: number | null;
  controlRate: number | null;
  lift: number | null;
  delta: number | null;
  viralSampleSize: number | null;
  controlSampleSize: number | null;
  evidenceQuality: string | null;
  direction: "more_common" | "less_common";
  controlMatchLevel: string | null;
  smoothingApplied: boolean;
}

export interface EvidenceAngle {
  refId: string;
  label: string | null;
  labelSource: string | null;
  memberCount: number;
  noveltyScore: number | null;
  isEmerging: boolean;
  firstObservedAt: string | null;
}

export interface StudioEvidencePackage {
  evidenceVersion: string;
  /** 证据包内容哈希 —— 相同证据允许复用上次结果(§19) */
  evidenceHash: string;
  builtAt: string;
  topicId: number;
  topicName: string;
  topicDescription: string | null;
  memberCount: number;
  topKeywords: string[];
  topHashtags: string[];
  platformDistribution: Record<string, number>;
  opportunityScore: number | null;
  opportunityConfidence: string | null;
  opportunityLevel: string | null;
  opportunityScoreVersion: string | null;
  positiveOpportunityReasons: string[];
  limitingOpportunityReasons: string[];
  lifecycle: string | null;
  lifecycleReason: string | null;
  pendingLifecycle: string | null;
  trendScore: number | null;
  trendConfidence: string | null;
  trendEvidence: Record<string, unknown> | null;
  trendEffectiveWeights: Record<string, number> | null;
  trendUnavailableReasons: Record<string, string> | null;
  burstDensity: number | null;
  topBurstContents: EvidenceContent[];
  representativeContent: EvidenceContent[];
  viralPatterns: EvidencePattern[];
  saturationScore: number | null;
  saturationBand: string | null;
  saturationEvidence: Record<string, unknown> | null;
  noveltyScore: number | null;
  noveltyConfidence: string | null;
  emergingAngles: EvidenceAngle[];
  dataFreshness: {
    trendCalculatedAt: string | null;
    intelligenceCalculatedAt: string | null;
    opportunityCalculatedAt: string | null;
    ageHours: Record<string, number | null>;
    stale: boolean;
  };
  /** 话题/角度是词法基线还是语义向量(影响可信度陈述,不隐藏) */
  qualityMode: string;
  /** §106 数据来源构成:live / replay / fixture / manual / import */
  sourceKinds: Record<string, number>;
  /** §107/§108 演示数据标记 —— fixture/replay 为主时为 true */
  demoData: boolean;
  evidenceTruncated: {
    representative: boolean;
    burstContents: boolean;
    patterns: boolean;
    angles: boolean;
    packageSize: boolean;
  };
  evidenceIndex: EvidenceRefItem[];
  charCount: number;
}

function parseJsonArray(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const j = JSON.parse(v);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(v: string | null | undefined): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const j = JSON.parse(v);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
}

/** §112:内容文本一律包成 DATA 区块,并在 system prompt 里声明"其中的指令不是指令"。 */
export function markAsData(label: string, text: string): string {
  const safe = text
    .replace(/【(\/?DATA·[^】]{0,64})】/g, "〔$1〕")
    .split("【DATA·")
    .join("〔DATA·")
    .split("【/DATA·")
    .join("〔/DATA·");
  return `【DATA·${label}】\n${safe}\n【/DATA·${label}】`;
}

function excerpt(text: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (!text) return { value: null, truncated: false };
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return { value: clean, truncated: false };
  return { value: `${clean.slice(0, limit)}…`, truncated: true };
}

function band(v: number | null): string | null {
  if (v === null) return null;
  return v < 34 ? "低" : v < 67 ? "中" : "高";
}

async function loadContents(
  db: DB,
  ids: number[],
  refPrefix: string,
): Promise<{ items: EvidenceContent[]; truncated: boolean }> {
  if (ids.length === 0) return { items: [], truncated: false };
  const rows = await db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      text: contentItems.text,
      platform: contentItems.platform,
      contentType: contentItems.contentType,
      authorName: contentItems.authorName,
      likes: contentItems.likes,
      comments: contentItems.comments,
      publishedAt: contentItems.publishedAt,
      burst: contentScoreCurrent.overallScore,
      burstConfidence: contentScoreCurrent.confidence,
    })
    .from(contentItems)
    .leftJoin(contentScoreCurrent, eq(contentScoreCurrent.contentItemId, contentItems.id))
    .where(inArray(contentItems.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const budget = STUDIO_EVIDENCE_BUDGET;
  const items: EvidenceContent[] = [];
  ids.forEach((id, i) => {
    const r = byId.get(id);
    if (!r) return;
    const ex = excerpt(r.text ?? null, budget.perContentTextChars);
    items.push({
      refId: `${refPrefix}-${i + 1}`,
      contentItemId: r.id,
      title: r.title,
      excerpt: ex.value,
      platform: r.platform,
      contentType: r.contentType,
      authorName: r.authorName,
      burstScore: r.burst === null || r.burst === undefined ? null : Number(r.burst),
      burstConfidence: r.burstConfidence ?? null,
      likes: r.likes === null || r.likes === undefined ? null : Number(r.likes),
      comments: r.comments === null || r.comments === undefined ? null : Number(r.comments),
      publishedAt: r.publishedAt,
      truncated: ex.truncated,
    });
  });
  return { items, truncated: ids.length > items.length };
}

/** §19:相同证据可复用上次结果 —— 哈希覆盖"模型会看到的内容",不含时间戳。 */
/** 证据包核心形状(不含运行期才生成的 hash / 时间戳 / 统计) */
type PackageCore = Omit<StudioEvidencePackage, "evidenceHash" | "builtAt" | "charCount">;

function hashPackage(p: PackageCore): string {
  const stable = JSON.stringify({
    topicId: p.topicId,
    topicName: p.topicName,
    memberCount: p.memberCount,
    opportunityScore: p.opportunityScore,
    opportunityConfidence: p.opportunityConfidence,
    positive: p.positiveOpportunityReasons,
    limiting: p.limitingOpportunityReasons,
    lifecycle: p.lifecycle,
    trendScore: p.trendScore,
    trendEvidence: p.trendEvidence,
    trendEffectiveWeights: p.trendEffectiveWeights,
    trendUnavailable: p.trendUnavailableReasons,
    burstDensity: p.burstDensity,
    burst: p.topBurstContents.map((c) => [c.contentItemId, c.title, c.excerpt, c.burstScore]),
    rep: p.representativeContent.map((c) => [c.contentItemId, c.title, c.excerpt]),
    patterns: p.viralPatterns.map((x) => [x.feature, x.lift, x.evidenceQuality, x.viralSampleSize, x.controlSampleSize]),
    angles: p.emergingAngles.map((a) => [a.label, a.memberCount, a.noveltyScore, a.isEmerging]),
    saturation: p.saturationScore,
    novelty: p.noveltyScore,
    // 只哈希"证据本身"(各引擎的计算时刻),不哈希由当前时钟推算的 ageHours ——
    // 否则每次读取年龄都在变,§19 的"相同证据可复用"永远命中不了。
    freshness: {
      trend: p.dataFreshness.trendCalculatedAt,
      intelligence: p.dataFreshness.intelligenceCalculatedAt,
      opportunity: p.dataFreshness.opportunityCalculatedAt,
      stale: p.dataFreshness.stale,
    },
    qualityMode: p.qualityMode,
    truncated: p.evidenceTruncated,
    evidenceVersion: p.evidenceVersion,
  });
  // FNV-1a 64bit 双轮,足够稳定且零依赖
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < stable.length; i++) {
    h1 ^= BigInt(stable.charCodeAt(i));
    h1 = (h1 * prime) & 0xfffffffffffffn;
  }
  let h2 = 0x9e3779b97f4a7c15n;
  for (let i = stable.length - 1; i >= 0; i--) {
    h2 ^= BigInt(stable.charCodeAt(i));
    h2 = (h2 * prime) & 0xfffffffffffffn;
  }
  return `ev-${h1.toString(16)}${h2.toString(16)}`;
}

export async function buildEvidencePackage(
  db: DB,
  topicId: number,
  opts: { now?: number } = {},
): Promise<StudioEvidencePackage | null> {
  const now = opts.now ?? Date.now();
  const budget = STUDIO_EVIDENCE_BUDGET;
  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId));
  if (!topic) return null;

  const [trend] = await db.select().from(topicScoreCurrent).where(eq(topicScoreCurrent.topicId, topicId));
  const [intel] = await db
    .select()
    .from(topicIntelligenceCurrent)
    .where(eq(topicIntelligenceCurrent.topicId, topicId));
  const [opp] = await db
    .select()
    .from(topicOpportunityCurrent)
    .where(eq(topicOpportunityCurrent.topicId, topicId));

  const memberIds = await db
    .select({ id: topicMemberships.contentItemId })
    .from(topicMemberships)
    .where(eq(topicMemberships.topicId, topicId));
  const memberList = memberIds.map((m) => Number(m.id));

  // 爆发内容:成员内爆发指数最高的几条(null 不参与排序冒充"低")
  const burstRows = memberList.length
    ? await db
        .select({ id: contentScoreCurrent.contentItemId, score: contentScoreCurrent.overallScore })
        .from(contentScoreCurrent)
        .where(
          and(
            eq(contentScoreCurrent.scoreType, "content_burst"),
            sql`${contentScoreCurrent.overallScore} IS NOT NULL`,
            inArray(contentScoreCurrent.contentItemId, memberList),
          ),
        )
        .orderBy(desc(contentScoreCurrent.overallScore))
        .limit(budget.burstTopK)
    : [];

  const repIds = parseJsonArray(topic.representativeItemIds).map(Number).filter(Number.isInteger);
  const burstRequested = burstRows.map((b) => Number(b.id));
  const { items: burstContents, truncated: burstTruncated } = await loadContents(
    db,
    burstRequested.slice(0, budget.burstTopK),
    "burst-content",
  );
  const { items: representatives, truncated: repTruncated } = await loadContents(
    db,
    repIds.slice(0, budget.representativeTopK),
    "rep",
  );

  const patternRows = await db
    .select()
    .from(patternResults)
    .where(and(eq(patternResults.topicId, topicId), sql`${patternResults.lift} IS NOT NULL`))
    .orderBy(
      sql`case ${patternResults.evidenceQuality} when 'high' then 0 when 'medium' then 1 else 2 end`,
      desc(sql`abs(coalesce(${patternResults.lift}, 1))`),
    )
    .limit(budget.patternTopK + 4);
  const viralPatterns: EvidencePattern[] = patternRows.slice(0, budget.patternTopK).map((p, i) => {
    const lift = numOrNull(p.lift);
    return {
      refId: `pattern-${i + 1}`,
      feature: p.feature,
      featureKind: p.featureKind ?? "unknown",
      viralRate: numOrNull(p.viralValue),
      controlRate: numOrNull(p.controlValue),
      lift,
      delta: numOrNull(p.delta),
      viralSampleSize: numOrNull(p.viralSampleSize),
      controlSampleSize: numOrNull(p.controlSampleSize),
      evidenceQuality: p.evidenceQuality ?? null,
      direction: lift !== null && lift < 1 ? "less_common" : "more_common",
      controlMatchLevel: p.scope ?? null,
      smoothingApplied: parseJsonObject(p.notes)?.smoothingApplied === true,
    };
  });

  const angleRows = await db
    .select()
    .from(topicAngleClusters)
    .where(and(eq(topicAngleClusters.topicId, topicId), eq(topicAngleClusters.status, "active")))
    .orderBy(desc(topicAngleClusters.noveltyScore))
    .limit(budget.angleTopK + 5);
  const emergingAngles: EvidenceAngle[] = angleRows.slice(0, budget.angleTopK).map((a, i) => ({
    refId: `angle-${i + 1}`,
    label: a.label,
    labelSource: a.labelSource,
    memberCount: Number(a.memberCount ?? 0),
    noveltyScore: numOrNull(a.noveltyScore),
    isEmerging: a.isEmerging === 1,
    firstObservedAt: a.firstObservedAt,
  }));

  const oppEvidence = parseJsonObject(opp?.evidence) ?? {};
  const trendEvidence = parseJsonObject(trend?.evidence) ?? null;
  const trendWeights = parseJsonObject(trend?.effectiveWeightsJson ?? null);
  const unavailableReasons: Record<string, string> = {};
  const trendComponents = trend?.componentsJson ? parseJsonObject(trend.componentsJson) : null;
  if (trendComponents) {
    for (const [k, v] of Object.entries(trendComponents)) {
      const c = v as { available?: boolean; reason?: string | null; label?: string };
      if (c?.available === false) unavailableReasons[k] = c.reason ?? "该组件当前不可用";
    }
  }

  // 饱和度证据:读该话题最近一次可评分的快照(没有就给 null,不编)
  const satRows = await db
    .select({ evidence: topicSaturationSnapshots.evidence, score: topicSaturationSnapshots.score })
    .from(topicSaturationSnapshots)
    .where(and(eq(topicSaturationSnapshots.topicId, topicId), sql`${topicSaturationSnapshots.score} IS NOT NULL`))
    .orderBy(desc(topicSaturationSnapshots.calculatedAt))
    .limit(1);
  const saturationEvidence = satRows.length ? parseJsonObject(satRows[0].evidence) : null;

  const sources = await db
    .select({ kind: contentItems.sourceType, c: sql<number>`count(*)` })
    .from(contentItems)
    .innerJoin(topicMemberships, eq(topicMemberships.contentItemId, contentItems.id))
    .where(eq(topicMemberships.topicId, topicId))
    .groupBy(contentItems.sourceType);
  const sourceKinds: Record<string, number> = {};
  for (const s of sources) sourceKinds[String(s.kind ?? "unknown")] = Number(s.c);
  const demoData = (sourceKinds.fixture ?? 0) + (sourceKinds.replay ?? 0) > (sourceKinds.api ?? 0) + (sourceKinds.manual ?? 0) + (sourceKinds.import ?? 0);

  const ageHours = (iso: string | null | undefined): number | null =>
    iso === null || iso === undefined ? null : Math.max(0, Math.round(((now - Date.parse(iso)) / 3_600_000) * 10) / 10);
  const ages = {
    trend: ageHours(trend?.calculatedAt),
    intelligence: ageHours(intel?.calculatedAt),
    opportunity: ageHours(opp?.calculatedAt),
  };
  const platformDist: Record<string, number> = {};
  const platformRows = await db
    .select({ platform: contentItems.platform, c: sql<number>`count(*)` })
    .from(contentItems)
    .innerJoin(topicMemberships, eq(topicMemberships.contentItemId, contentItems.id))
    .where(eq(topicMemberships.topicId, topicId))
    .groupBy(contentItems.platform);
  for (const p of platformRows) platformDist[String(p.platform)] = Number(p.c);

  const pkg: Omit<StudioEvidencePackage, "evidenceHash" | "builtAt" | "charCount"> = {
    evidenceVersion: STUDIO_EVIDENCE_VERSION,
    topicId,
    topicName: topic.name,
    topicDescription: topic.description ?? null,
    memberCount: Number(topic.memberCount ?? memberList.length),
    topKeywords: parseJsonArray(topic.keywords).slice(0, 12),
    topHashtags: parseJsonArray(topic.hashtags).slice(0, 12),
    platformDistribution: platformDist,
    opportunityScore: opp ? numOrNull(opp.score) : null,
    opportunityConfidence: opp?.confidence ?? null,
    opportunityLevel: opp?.opportunityLevel ?? null,
    opportunityScoreVersion: opp?.scoreVersion ?? null,
    positiveOpportunityReasons: Array.isArray(oppEvidence.positiveReasons)
      ? (oppEvidence.positiveReasons as unknown[]).map(String)
      : [],
    limitingOpportunityReasons: Array.isArray(oppEvidence.limitingReasons)
      ? (oppEvidence.limitingReasons as unknown[]).map(String)
      : [],
    lifecycle: trend?.lifecycle ?? null,
    lifecycleReason: typeof (trendEvidence as Record<string, unknown>)?.lifecycle === "object"
      ? String(((trendEvidence as Record<string, { reason?: string }>).lifecycle ?? {}).reason ?? "") || null
      : null,
    pendingLifecycle: trend?.pendingLifecycle ?? null,
    trendScore: trend ? numOrNull(trend.score) : null,
    trendConfidence: trend?.confidence ?? null,
    trendEvidence,
    trendEffectiveWeights: trendWeights as Record<string, number> | null,
    trendUnavailableReasons: Object.keys(unavailableReasons).length ? unavailableReasons : null,
    burstDensity: trend ? numOrNull(trend.burstDensity) : null,
    topBurstContents: burstContents,
    representativeContent: representatives,
    viralPatterns,
    saturationScore: intel ? numOrNull(intel.saturationScore) : null,
    saturationBand: band(intel ? numOrNull(intel.saturationScore) : null),
    saturationEvidence,
    noveltyScore: intel ? numOrNull(intel.noveltyScore) : null,
    noveltyConfidence: intel?.noveltyConfidence ?? null,
    emergingAngles,
    dataFreshness: {
      trendCalculatedAt: trend?.calculatedAt ?? null,
      intelligenceCalculatedAt: intel?.calculatedAt ?? null,
      opportunityCalculatedAt: opp?.calculatedAt ?? null,
      ageHours: ages,
      stale: Object.values(ages).some((a) => a !== null && a > STUDIO_FRESHNESS_WARN_HOURS),
    },
    qualityMode: String(oppEvidence.qualityMode ?? (intel?.saturationVersion?.includes("lexical") ? "lexical_baseline" : "unknown")),
    sourceKinds,
    demoData,
    evidenceTruncated: {
      representative: repTruncated || repIds.length > budget.representativeTopK,
      burstContents: burstTruncated || burstRequested.length > budget.burstTopK,
      patterns: patternRows.length > budget.patternTopK,
      angles: angleRows.length > budget.angleTopK,
      packageSize: false,
    },
    evidenceIndex: [],
  };

  // 证据索引 = 模型唯一可引用的 id 清单(§10)。裁剪后重建,保证不会引用已被丢掉的证据。
  const withIndex = { ...pkg, evidenceIndex: buildEvidenceIndex(pkg) };
  let charCount = JSON.stringify(withIndex).length;

  // §114 超预算:按优先级逐级裁剪,并如实记 evidenceTruncated(不假装完整)
  const trimmed: PackageCore = { ...withIndex };
  const dropHalf = <T>(arr: T[]): T[] => arr.slice(0, Math.max(1, Math.ceil(arr.length / 2)));
  const mark = (flag: keyof PackageCore["evidenceTruncated"]) => {
    trimmed.evidenceTruncated = { ...trimmed.evidenceTruncated, [flag]: true };
  };
  let guard = 0;
  while (charCount > budget.maxPackageChars && guard++ < 12) {
    const before = charCount;
    if (trimmed.topBurstContents.some((c) => (c.excerpt?.length ?? 0) > 80)) {
      trimmed.topBurstContents = trimmed.topBurstContents.map((c) => ({
        ...c,
        excerpt: c.excerpt ? `${c.excerpt.slice(0, 80)}…` : c.excerpt,
        truncated: true,
      }));
      mark("burstContents");
    } else if (trimmed.representativeContent.length > 1) {
      trimmed.representativeContent = dropHalf(trimmed.representativeContent);
      mark("representative");
    } else if (trimmed.topBurstContents.length > 1) {
      trimmed.topBurstContents = dropHalf(trimmed.topBurstContents);
      mark("burstContents");
    } else if (trimmed.viralPatterns.length > 2) {
      trimmed.viralPatterns = dropHalf(trimmed.viralPatterns);
      mark("patterns");
    } else if (trimmed.emergingAngles.length > 1) {
      trimmed.emergingAngles = dropHalf(trimmed.emergingAngles);
      mark("angles");
    } else {
      break;
    }
    trimmed.evidenceIndex = buildEvidenceIndex(trimmed);
    charCount = JSON.stringify(trimmed).length;
    if (charCount === before) break;
  }
  if (charCount > budget.maxPackageChars) {
    trimmed.evidenceTruncated = { ...trimmed.evidenceTruncated, packageSize: true };
  }

  return {
    ...trimmed,
    evidenceHash: hashPackage(trimmed),
    builtAt: new Date(now).toISOString(),
    charCount,
  };
}

/** 只列"证据包里真的存在"的引用,避免模型引到被裁掉的条目上。 */
function buildEvidenceIndex(p: PackageCore): EvidenceRefItem[] {
  const out: EvidenceRefItem[] = [
    { id: "topic-1", kind: "topic", label: `话题 ${p.topicName}(${String(p.memberCount)} 条成员)` },
  ];
  if (p.trendScore !== null) {
    out.push({
      id: "trend-1",
      kind: "trend",
      label: `话题趋势指数 ${p.trendScore}(生命周期 ${
        p.lifecycle ? LIFECYCLE_LABELS_ZH[p.lifecycle as keyof typeof LIFECYCLE_LABELS_ZH] ?? p.lifecycle : "数据不足"
      })`,
    });
  }
  if (p.opportunityScore !== null) {
    out.push({ id: "opportunity-1", kind: "opportunity", label: `选题机会指数 ${p.opportunityScore}` });
  }
  if (p.saturationScore !== null) {
    out.push({ id: "saturation-1", kind: "saturation", label: `饱和度 ${p.saturationScore}(${p.saturationBand ?? "?"})` });
  }
  if (p.noveltyScore !== null) {
    out.push({ id: "novelty-1", kind: "novelty", label: `新颖度 ${p.noveltyScore}` });
  }
  for (const x of p.viralPatterns) {
    out.push({ id: x.refId, kind: "pattern", label: `共性 ${x.feature}${x.lift !== null ? ` ×${x.lift}` : ""}` });
  }
  for (const a of p.emergingAngles) {
    out.push({ id: a.refId, kind: "angle", label: `角度 ${a.label ?? "(未命名)"}` });
  }
  for (const c of p.topBurstContents) {
    out.push({ id: c.refId, kind: "burst-content", label: `爆发内容 ${c.title ?? c.contentItemId}` });
  }
  for (const c of p.representativeContent) {
    out.push({ id: c.refId, kind: "representative", label: `代表内容 ${c.title ?? c.contentItemId}` });
  }
  return out;
}
