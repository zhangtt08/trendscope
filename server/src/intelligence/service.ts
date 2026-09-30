/**
 * Content Intelligence orchestration (Stage 8 §60/§71/§79):
 * 特征抽取(textHash 缓存)→ 爆发共性(Topic 上下文为主,控制组梯子)→ 饱和度
 * → 新颖度/角度簇。确定性(时钟注入);角度向量恒用词法回退(词法饱和度基线,§36,
 * DECISIONS D18);AI 语义特征凭证缺失 → unavailable 不阻塞(§12)。
 * 全部持久化 append-only;真机只做安全追加,不动治理状态(§CW 延续)。
 */
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems, contentScoreCurrent, topicMemberships, topics } from "../db/schema";
import { lexicalEmbed } from "../semantic/lexicalProvider";
import { cosineSimilarity } from "../semantic/vectors";
import {
  ANGLE_TEXT_V1,
  CONTENT_FEATURES_V1,
  INTELLIGENCE_PROFILE,
  NOVELTY_PROFILE,
  SATURATION_PROFILE,
  VIRAL_PATTERN_V1,
  intelligenceConfigSnapshot,
} from "./profiles";
import { extractDeterministicFeatures } from "./features";
import {
  RuleBasedSemanticFeatureExtractor,
  OpenAiCompatibleSemanticFeatureExtractor,
  type SemanticFeatures,
} from "./semanticFeatures";
import { buildAngleText } from "./angleText";
import { ageBucketKey } from "../scoring/cohort";
import { creatorKeyOf } from "../scoring/creatorBaseline";
import { computePatterns, matchControlGroup, sortPatterns, type FeatureRecord } from "./viralPattern";
import { computeSaturation, type SaturationMember } from "./saturation";
import { computeTopicNovelty, type AngleMember } from "./novelty";
import {
  findFeatureRecords,
  getContentFeatureRecord,
  getHistoricalClusters,
  getTopicAngles,
  getTopicNoveltyDetail,
  getTopicPatterns,
  getTopicSaturationDetail,
  insertFeatureRecords,
  insertNoveltySnapshots,
  insertPatternResults,
  insertSaturationSnapshots,
  listIntelligenceRuns,
  persistAngleClusters,
  upsertIntelligenceCurrent,
  type AngleClusterUpsert,
} from "./repository";

export interface IntelligenceRunResult {
  runId: number;
  topicsAnalyzed: number;
  contentsAnalyzed: number;
  patternScorable: number;
  patternInsufficient: number;
  saturatedScorable: number;
  saturatedInsufficient: number;
  noveltyScorable: number;
  emergingAngleCount: number;
  durationMs: number;
}

interface ItemMeta {
  id: number;
  platform: string;
  contentType: string;
  title: string | null;
  text: string | null;
  hashtags: string | null;
  authorId: string | null;
  authorName: string | null;
  publishedAt: string | null;
}

function parseTags(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** 特征缓存键:与 SemanticText 无关的独立内容文本指纹(标题+正文+标签)。 */
function contentTextHash(item: ItemMeta): string {
  return createHash("sha256")
    .update(`${item.title ?? ""}\u0000${item.text ?? ""}\u0000${parseTags(item.hashtags).join("|")}`)
    .digest("hex");
}

export async function runIntelligence(db: DB, opts: { now?: number } = {}): Promise<IntelligenceRunResult> {
  const startedAt = new Date().toISOString();
  const now = opts.now ?? Date.now();
  const calculatedAt = new Date(now).toISOString();

  // §12:AI 语义特征仅在凭证存在时启用;RuleBased 恒可用
  const ruleExtractor = new RuleBasedSemanticFeatureExtractor();
  const aiExtractor = new OpenAiCompatibleSemanticFeatureExtractor(
    {
      baseUrl: process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
      model: process.env.EMBEDDING_MODEL ?? "unknown",
      apiKeySecretRef: "secretref:env:EMBEDDING_API_KEY",
    },
    {
      resolveSecret: (ref) => (ref === "secretref:env:EMBEDDING_API_KEY" ? (process.env.EMBEDDING_API_KEY ?? null) : null),
    },
  );
  const aiAvailable = aiExtractor.available();

  const [run] = await db
    .insert(intelligenceRunsTable())
    .values({
      featureVersion: CONTENT_FEATURES_V1,
      patternVersion: VIRAL_PATTERN_V1,
      saturationVersion: SATURATION_PROFILE.version,
      noveltyVersion: NOVELTY_PROFILE.version,
      angleTextVersion: ANGLE_TEXT_V1,
      status: "running",
      configSnapshot: intelligenceConfigSnapshot(),
      startedAt,
      createdAt: startedAt,
    })
    .returning({ id: sql<number>`id` });
  const runId = Number(run.id);

  try {
    const t0 = Date.now();
    const topicRows = await db
      .select({ id: topics.id, firstObservedAt: topics.firstObservedAt })
      .from(topics)
      .where(inArray(topics.status, ["active", "needs_review"]))
      .orderBy(topics.id);

    const memberRows = await db
      .select({
        topicId: topicMemberships.topicId,
        contentItemId: topicMemberships.contentItemId,
      })
      .from(topicMemberships)
      .innerJoin(topics, eq(topics.id, topicMemberships.topicId))
      .where(inArray(topics.status, ["active", "needs_review"]));
    const membersByTopic = new Map<number, number[]>();
    for (const m of memberRows) {
      const arr = membersByTopic.get(m.topicId);
      if (arr) arr.push(m.contentItemId);
      else membersByTopic.set(m.topicId, [m.contentItemId]);
    }

    // 全量未合并条目一次拉取(话题成员 + 平台全局控制池的超集)
    const itemRows: ItemMeta[] = await db
      .select({
        id: contentItems.id,
        platform: contentItems.platform,
        contentType: contentItems.contentType,
        title: contentItems.title,
        text: contentItems.text,
        hashtags: contentItems.hashtags,
        authorId: contentItems.authorId,
        authorName: contentItems.authorName,
        publishedAt: contentItems.publishedAt,
      })
      .from(contentItems)
      .where(sql`${contentItems.mergedIntoContentItemId} IS NULL`)
      .orderBy(contentItems.id);
    const itemById = new Map(itemRows.map((i) => [i.id, i]));

    const burstRows = await db
      .select({ contentItemId: contentScoreCurrent.contentItemId, score: contentScoreCurrent.overallScore, scorable: contentScoreCurrent.scorable })
      .from(contentScoreCurrent);
    const burstByItem = new Map<number, number | null>(
      burstRows.map((b) => [b.contentItemId, b.scorable === 1 ? b.score : null]),
    );

    // ---- 特征抽取(textHash+版本 缓存,§15) ----
    const itemsToAnalyze = itemRows;
    const hashByItem = new Map<number, string>(itemsToAnalyze.map((i) => [i.id, contentTextHash(i)]));
    const cache = await findFeatureRecords(
      db,
      itemsToAnalyze.map((i) => ({ contentItemId: i.id, textHash: hashByItem.get(i.id)! })),
      CONTENT_FEATURES_V1,
    );
    const featureByItem = new Map<number, { deterministic: ReturnType<typeof extractDeterministicFeatures>; semantic: SemanticFeatures | null }>();
    const newRecords: Parameters<typeof insertFeatureRecords>[1] = [];
    for (const item of itemsToAnalyze) {
      const key = `${item.id}:${hashByItem.get(item.id)!}`;
      const cached = cache.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as { deterministic: ReturnType<typeof extractDeterministicFeatures>; semantic: SemanticFeatures | null };
        featureByItem.set(item.id, { deterministic: parsed.deterministic, semantic: parsed.semantic });
        continue;
      }
      const deterministic = extractDeterministicFeatures({
        title: item.title,
        text: item.text,
        hashtags: parseTags(item.hashtags),
        publishedAt: item.publishedAt,
      });
      let semantic: SemanticFeatures | null = null;
      try {
        semantic = await ruleExtractor.extract({ title: item.title, text: item.text });
      } catch {
        semantic = null; // 规则抽取不该失败;防御
      }
      featureByItem.set(item.id, { deterministic, semantic });
      newRecords.push({
        contentItemId: item.id,
        textHash: hashByItem.get(item.id)!,
        featureVersion: CONTENT_FEATURES_V1,
        extractor: ruleExtractor.id,
        model: aiAvailable ? aiExtractor.id : null,
        features: JSON.stringify({
          deterministic,
          semantic,
          semanticUnavailable: aiAvailable ? null : "SEMANTIC_FEATURE_CREDENTIAL_MISSING",
        }),
        calculatedAt,
      });
    }
    await insertFeatureRecords(db, newRecords);

    // ---- FeatureRecord 组装 + 角度向量(词法回退,恒可用) ----
    const recordsByItem = new Map<number, FeatureRecord>();
    const angleVectorByItem = new Map<number, number[]>();
    for (const item of itemsToAnalyze) {
      const f = featureByItem.get(item.id)!;
      recordsByItem.set(item.id, {
        contentItemId: item.id,
        platform: item.platform,
        contentType: item.contentType,
        ageBucket: ageBucketKey(item.publishedAt, now, INTELLIGENCE_PROFILE_AGE_BUCKETS),
        topicId: null,
        authorKey: creatorKeyOf(item.authorId, item.authorName),
        publishedAt: item.publishedAt,
        burstScore: burstByItem.has(item.id) ? burstByItem.get(item.id)! : null,
        deterministic: f.deterministic,
        semantic: f.semantic,
      });
      const angle = buildAngleText({ title: item.title, text: item.text, hashtags: parseTags(item.hashtags) });
      angleVectorByItem.set(item.id, lexicalEmbed(angle.text, 512));
    }
    // 话题归属
    for (const [topicId, ids] of membersByTopic) {
      for (const id of ids) {
        const rec = recordsByItem.get(id);
        if (rec) rec.topicId = topicId;
      }
    }

    // ---- 逐话题:Pattern → Saturation → Novelty ----
    const patternRows: Parameters<typeof insertPatternResults>[1] = [];
    const saturationRows: Parameters<typeof insertSaturationSnapshots>[1] = [];
    const noveltyRows: Parameters<typeof insertNoveltySnapshots>[1] = [];
    const currentRows: Parameters<typeof upsertIntelligenceCurrent>[1] = [];
    const errors: string[] = [];
    let patternScorable = 0;
    let patternInsufficient = 0;
    let saturatedScorable = 0;
    let saturatedInsufficient = 0;
    let noveltyScorable = 0;
    let emergingAngleCount = 0;

    for (const topic of topicRows) {
      try {
        const memberIds = membersByTopic.get(topic.id) ?? [];
        const members = memberIds.map((id) => recordsByItem.get(id)).filter((r): r is FeatureRecord => r !== undefined);
        const viral = members.filter((m) => m.burstScore !== null && m.burstScore >= INTELLIGENCE_PROFILE.viralBurstThreshold);
        // 控制组候选 = 全部话题成员(梯子内部会排除爆发组本身)

        // 1) Viral Pattern(§3-§27)
        if (viral.length < INTELLIGENCE_PROFILE.minimumViralSample) {
          patternInsufficient += 1;
        } else {
          const platformPool = itemRows
            .filter((i) => i.platform === (members[0]?.platform ?? ""))
            .map((i) => recordsByItem.get(i.id))
            .filter((r): r is FeatureRecord => r !== undefined);
          const match = matchControlGroup(viral, members, platformPool, INTELLIGENCE_PROFILE);
          if (!match) {
            patternInsufficient += 1;
          } else {
            const patterns = sortPatterns(
              computePatterns(viral, match.controls, match, {
                scope: "topic",
                topicId: topic.id,
                platform: null,
                now,
                semanticAvailable: true,
              }),
            );
            for (const p of patterns) {
              patternRows.push({
                runId,
                scope: p.scope,
                topicId: p.topicId,
                platform: p.platform,
                windowHours: p.windowHours,
                feature: p.feature,
                featureKind: p.featureKind,
                viralValue: JSON.stringify(p.viralValue),
                controlValue: JSON.stringify(p.controlValue),
                lift: p.lift,
                delta: p.delta,
                viralSampleSize: p.viralSampleSize,
                controlSampleSize: p.controlSampleSize,
                evidenceQuality: p.evidenceQuality,
                notes: JSON.stringify(p.notes),
                featureVersion: p.featureVersion,
                patternVersion: p.patternVersion,
                calculatedAt,
              });
            }
            patternScorable += 1;
          }
        }

        // 2) Saturation(§28-§41)
        const satMembers: SaturationMember[] = memberIds
          .map((id) => {
            const rec = recordsByItem.get(id);
            const item = itemById.get(id);
            if (!rec || !item) return null;
            return {
              contentItemId: id,
              authorKey: rec.authorKey,
              publishedAt: item.publishedAt,
              angleVector: angleVectorByItem.get(id) ?? null,
            };
          })
          .filter((m): m is SaturationMember => m !== null);
        const sat = computeSaturation(
          { topicId: topic.id, firstObservedAt: topic.firstObservedAt, members: satMembers },
          now,
          SATURATION_PROFILE,
        );
        if (sat.scorable) saturatedScorable += 1;
        else saturatedInsufficient += 1;
        saturationRows.push({
          topicId: topic.id,
          runId,
          score: sat.score,
          confidence: sat.confidence,
          unscorableReason: sat.unscorableReason,
          breakdown: JSON.stringify({ breakdown: sat.breakdown, weightsUsed: sat.weightsUsed, confidenceReasons: sat.confidenceReasons }),
          evidence: JSON.stringify(sat.evidence),
          version: SATURATION_PROFILE.version,
          calculatedAt,
        });

        // 3) Novelty / Angle Clusters(§42-§53)
        const angleMembers: AngleMember[] = satMembers
          .filter((m) => m.angleVector !== null)
          .map((m) => {
            const item = itemById.get(m.contentItemId);
            return {
              contentItemId: m.contentItemId,
              authorKey: m.authorKey,
              publishedAt: m.publishedAt,
              title: item?.title ?? null,
              angleVector: m.angleVector!,
            };
          });
        const historical = await getHistoricalClusters(db, topic.id);
        const novelty = computeTopicNovelty(
          { topicId: topic.id, members: angleMembers, historical },
          now,
          NOVELTY_PROFILE,
        );
        if (novelty.scorable) {
          noveltyScorable += 1;
          emergingAngleCount += novelty.emergingAngleCount;
          const vectorByItem = new Map(angleMembers.map((m) => [m.contentItemId, m.angleVector]));
          const upserts: AngleClusterUpsert[] = [];
          for (const c of novelty.clusters) {
            if (c.draft.memberItemIds.length < NOVELTY_PROFILE.minAngleMembers && c.inheritedId === null) continue; // 噪声簇不入库
            const reps = [...c.draft.memberItemIds]
              .map((id) => {
                const v = vectorByItem.get(id)!;
                return { id, sim: cosineSimilarity(v, c.draft.centroid) };
              })
              .sort((a, b) => b.sim - a.sim)
              .slice(0, 3)
              .map((x) => x.id);
            upserts.push({
              inheritedId: c.inheritedId,
              topicId: topic.id,
              label: c.label,
              labelSource: c.labelSource,
              memberCount: c.draft.memberItemIds.length,
              firstObservedAt: c.draft.firstObservedAt,
              lastObservedAt: c.draft.lastObservedAt,
              representativeItemIds: reps,
              centroid: c.draft.centroid,
              noveltyScore: c.noveltyScore,
              isEmerging: c.everEmerging,
              runId,
              calculatedAt,
            });
          }
          await persistAngleClusters(db, topic.id, upserts);
        }
        noveltyRows.push({
          topicId: topic.id,
          runId,
          score: novelty.scorable ? novelty.score : null,
          emergingAngleCount: novelty.emergingAngleCount,
          confidence: novelty.confidence,
          unscorableReason: novelty.unscorableReason,
          evidence: JSON.stringify(novelty.evidence),
          version: NOVELTY_PROFILE.version,
          calculatedAt,
        });

        currentRows.push({
          topicId: topic.id,
          saturationScore: sat.score,
          saturatedConfidence: sat.confidence,
          saturationVersion: SATURATION_PROFILE.version,
          noveltyScore: novelty.scorable ? novelty.score : null,
          emergingAngleCount: novelty.emergingAngleCount,
          noveltyConfidence: novelty.confidence,
          noveltyVersion: NOVELTY_PROFILE.version,
          calculatedAt,
          runId,
        });
      } catch (e) {
        errors.push(`topic ${topic.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await insertPatternResults(db, patternRows);
    await insertSaturationSnapshots(db, saturationRows);
    await insertNoveltySnapshots(db, noveltyRows);
    await upsertIntelligenceCurrent(db, currentRows);

    const durationMs = Date.now() - t0;
    await db
      .update(intelligenceRunsTable())
      .set({
        status: errors.length > 0 ? "partial" : "completed",
        topicsAnalyzed: topicRows.length,
        contentsAnalyzed: itemsToAnalyze.length,
        patternScorable,
        patternInsufficient,
        saturatedScorable,
        saturatedInsufficient,
        noveltyScorable,
        emergingAngleCount,
        durationMs,
        error: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(intelligenceRuns.id, runId));
    return {
      runId,
      topicsAnalyzed: topicRows.length,
      contentsAnalyzed: itemsToAnalyze.length,
      patternScorable,
      patternInsufficient,
      saturatedScorable,
      saturatedInsufficient,
      noveltyScorable,
      emergingAngleCount,
      durationMs,
    };
  } catch (e) {
    await db
      .update(intelligenceRunsTable())
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e), completedAt: new Date().toISOString() })
      .where(eq(intelligenceRuns.id, runId));
    throw e;
  }
}

/** INTELLIGENCE_PROFILE 无 ageBuckets —— 复用 Stage 7 的集中年龄桶(单一事实来源)。 */
import { CONTENT_BURST_PROFILE } from "../scoring/profiles";
const INTELLIGENCE_PROFILE_AGE_BUCKETS = CONTENT_BURST_PROFILE.ageBuckets;

import { intelligenceRuns } from "../db/schema";
function intelligenceRunsTable() {
  return intelligenceRuns;
}

export {
  getContentFeatureRecord,
  getTopicPatterns,
  getTopicSaturationDetail,
  getTopicNoveltyDetail,
  getTopicAngles,
  listIntelligenceRuns,
};
export { CONTENT_FEATURES_V1, VIRAL_PATTERN_V1, ANGLE_TEXT_V1 };
