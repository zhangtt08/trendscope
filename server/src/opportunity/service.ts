/**
 * Opportunity orchestration (Stage 9 §49/§52/§54/§68):只消费既有 Engine 的
 * Current 快照,不重算任何下层指标;依赖缺失 → 该组件 unknown(不默默算)。
 * 确定性(时钟注入);快照 append-only;delta 与 whyChanged 确定性分解。
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentItems,
  contentScoreCurrent,
  embeddingSpaces,
  opportunityRuns,
  patternResults,
  topicIntelligenceCurrent,
  topicScoreCurrent,
  topics,
} from "../db/schema";
import {
  TOPIC_OPPORTUNITY_V1,
  configSnapshotFor,
  type OpportunityProfile,
  type OpportunityProfileId,
} from "./profiles";
import { resolveActiveProfile, resolveProfileByKey } from "./profileStore";
import { computeOpportunity, computeWhyChanged, type OpportunityInput } from "./engine";
import {
  getPreviousSnapshots,
  insertOpportunitySnapshots,
  upsertOpportunityCurrent,
  type OpportunityCurrentRow,
  type OpportunitySnapshotRow,
} from "./repository";

export interface OpportunityRunResult {
  runId: number;
  profileId: string;
  topicsConsidered: number;
  scored: number;
  unscorable: number;
  failed: number;
  durationMs: number;
}

export async function runOpportunity(
  db: DB,
  opts: { now?: number; profileId?: OpportunityProfileId; profile?: OpportunityProfile } = {},
): Promise<OpportunityRunResult> {
  // Stage 9.5 §29/§30:默认吃"当前模型"(库里 active 的那一份);
  // 显式传 profile 时(测试/编排)优先用它。旧快照仍记录自己那份版本。
  const profile: OpportunityProfile =
    opts.profile ?? (opts.profileId ? await resolveProfileByKey(db, opts.profileId) : await resolveActiveProfile(db));
  const startedAt = new Date().toISOString();
  const now = opts.now ?? Date.now();
  const calculatedAt = new Date(now).toISOString();
  const [run] = await db
    .insert(opportunityRuns)
    .values({
      version: TOPIC_OPPORTUNITY_V1,
      profileId: profile.id,
      profileVersion: profile.version,
      status: "running",
      configSnapshot: configSnapshotFor(profile),
      startedAt,
      createdAt: startedAt,
    })
    .returning({ id: sql<number>`id` });
  const runId = Number(run.id);

  try {
    const t0 = Date.now();
    const topicRows = await db
      .select({ id: topics.id, embeddingSpaceId: topics.embeddingSpaceId, memberCount: topics.memberCount })
      .from(topics)
      .where(inArray(topics.status, ["active", "needs_review"]))
      .orderBy(topics.id);

    const trendRows = await db.select().from(topicScoreCurrent);
    const trendByTopic = new Map(trendRows.map((r) => [r.topicId, r]));
    const intelRows = await db.select().from(topicIntelligenceCurrent);
    const intelByTopic = new Map(intelRows.map((r) => [r.topicId, r]));

    // quality mode(§18):话题所属 embedding space 的 mode
    const spaceRows = await db.select({ id: embeddingSpaces.id, mode: embeddingSpaces.mode }).from(embeddingSpaces);
    const modeBySpace = new Map(spaceRows.map((s) => [s.id, s.mode]));

    // 成员爆发分布(§8):current 表冗余 topic_id + 内容发布时间(近期爆发计数)
    const burstRows = await db
      .select({
        topicId: contentScoreCurrent.topicId,
        score: contentScoreCurrent.overallScore,
        publishedAt: contentItems.publishedAt,
      })
      .from(contentScoreCurrent)
      .innerJoin(contentItems, eq(contentItems.id, contentScoreCurrent.contentItemId))
      .where(eq(contentScoreCurrent.scorable, 1));
    const burstByTopic = new Map<number, { score: number; publishedAt: string | null }[]>();
    for (const b of burstRows) {
      if (b.topicId === null || b.score === null) continue;
      const arr = burstByTopic.get(b.topicId);
      const entry = { score: b.score, publishedAt: b.publishedAt };
      if (arr) arr.push(entry);
      else burstByTopic.set(b.topicId, [entry]);
    }

    // pattern rows:每个话题取最近一次 intelligence run 的行(§49 消费快照)
    const patternRows = await db
      .select({
        topicId: patternResults.topicId,
        runId: patternResults.runId,
        evidenceQuality: patternResults.evidenceQuality,
        lift: patternResults.lift,
        delta: patternResults.delta,
        featureKind: patternResults.featureKind,
        viralSampleSize: patternResults.viralSampleSize,
        controlSampleSize: patternResults.controlSampleSize,
        notes: patternResults.notes,
      })
      .from(patternResults)
      .orderBy(desc(patternResults.runId), desc(patternResults.id));
    const patternsByTopic = new Map<number, NonNullable<OpportunityInput["pattern"]>["patterns"]>();
    for (const p of patternRows) {
      if (p.topicId === null) continue;
      if (!patternsByTopic.has(p.topicId)) {
        patternsByTopic.set(p.topicId, []);
      }
      const arr = patternsByTopic.get(p.topicId)!;
      if (arr.length < 40) {
        arr.push({
          evidenceQuality: p.evidenceQuality,
          lift: p.lift,
          delta: p.delta,
          featureKind: p.featureKind,
          viralSampleSize: p.viralSampleSize,
          controlSampleSize: p.controlSampleSize,
          direction: (() => {
            try {
              return (JSON.parse(p.notes) as { direction?: string }).direction;
            } catch {
              return undefined;
            }
          })(),
        });
      }
    }

    const previous = await getPreviousSnapshots(db, topicRows.map((t) => t.id));
    const snapshotRows: OpportunitySnapshotRow[] = [];
    const currentRows: OpportunityCurrentRow[] = [];
    let scored = 0;
    let unscorable = 0;
    const errors: string[] = [];

    for (const t of topicRows) {
      try {
        const trend = trendByTopic.get(t.id);
        const intel = intelByTopic.get(t.id);
        const spaceMode = modeBySpace.get(t.embeddingSpaceId) ?? "lexical";
        const input: OpportunityInput = {
          trend: trend
            ? {
                score: trend.score,
                confidence: trend.confidence,
                lifecycle: trend.lifecycle,
                calculatedAt: trend.calculatedAt,
                memberCount: t.memberCount,
                qualityMode: spaceMode === "api" ? "semantic" : "lexical_baseline",
              }
            : null,
          burst: {
            density: trend?.burstDensity ?? null,
            memberScores: burstByTopic.get(t.id) ?? [],
            calculatedAt: trend?.calculatedAt ?? null,
          },
          novelty: intel
            ? {
                score: intel.noveltyScore,
                emergingAngleCount: intel.emergingAngleCount,
                confidence: intel.noveltyConfidence,
                calculatedAt: intel.calculatedAt,
              }
            : null,
          whitespace: intel
            ? {
                saturationScore: intel.saturationScore,
                saturationScorable: intel.saturationScore !== null,
                confidence: intel.saturatedConfidence,
                calculatedAt: intel.calculatedAt,
              }
            : null,
          pattern: { patterns: patternsByTopic.get(t.id) ?? null },
          now,
        };
        const out = computeOpportunity(input, profile);
        const prev = previous.get(t.id);
        const deltaScore = out.score !== null && prev?.score != null ? Math.round((out.score - prev.score) * 10) / 10 : null;
        const whyChanged =
          out.components && prev
            ? computeWhyChanged(
                Object.fromEntries(Object.entries(out.components).map(([k, c]) => [k, c.contribution])),
                prev.contributions,
              )
            : null;
        snapshotRows.push({
          topicId: t.id,
          runId,
          score: out.score,
          scoreVersion: TOPIC_OPPORTUNITY_V1,
          profileId: profile.id,
          profileVersion: profile.version,
          confidence: out.confidence,
          unscorableReason: out.unscorableReason,
          trendContribution: out.components?.trend.contribution ?? null,
          burstContribution: out.components?.burst.contribution ?? null,
          noveltyContribution: out.components?.novelty.contribution ?? null,
          whitespaceContribution: out.components?.whitespace.contribution ?? null,
          patternContribution: out.components?.pattern.contribution ?? null,
          lifecycleContribution: out.components?.lifecycle.contribution ?? null,
          effectiveWeights: JSON.stringify(out.effectiveWeights ?? {}),
          deltaScore,
          whyChanged: whyChanged ? JSON.stringify(whyChanged) : null,
          evidence: JSON.stringify({ ...out.evidence, reasonCodes: out.reasonCodes, positiveReasons: out.positiveReasons, limitingReasons: out.limitingReasons, confidenceScore: out.confidenceScore }),
          calculatedAt,
        });
        if (out.scorable) scored += 1;
        else unscorable += 1;
        currentRows.push({
          topicId: t.id,
          score: out.score,
          confidence: out.confidence,
          opportunityLevel: out.opportunityLevel,
          unscorableReason: out.unscorableReason,
          deltaScore,
          profileId: profile.id,
          profileVersion: profile.version,
          scoreVersion: TOPIC_OPPORTUNITY_V1,
          evidence: JSON.stringify({ reasonCodes: out.reasonCodes, positiveReasons: out.positiveReasons, limitingReasons: out.limitingReasons, whyChanged, confidenceScore: out.confidenceScore, components: out.components, qualityMode: input.trend?.qualityMode ?? null }),
          calculatedAt,
          runId,
        });
      } catch (e) {
        errors.push(`topic ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await insertOpportunitySnapshots(db, snapshotRows);
    await upsertOpportunityCurrent(db, currentRows);
    const durationMs = Date.now() - t0;
    await db
      .update(opportunityRuns)
      .set({
        status: errors.length > 0 ? "partial" : "completed",
        topicsConsidered: topicRows.length,
        scored,
        unscorable,
        failed: errors.length,
        durationMs,
        error: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(opportunityRuns.id, runId));
    return { runId, profileId: profile.id, topicsConsidered: topicRows.length, scored, unscorable, failed: errors.length, durationMs };
  } catch (e) {
    await db
      .update(opportunityRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e), completedAt: new Date().toISOString() })
      .where(eq(opportunityRuns.id, runId));
    throw e;
  }
}

