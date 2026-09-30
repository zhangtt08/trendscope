/**
 * Scoring batch orchestration (Stage 7 §AD/§CQ):Content Burst Run → Topic Trend Run
 * (→ Lifecycle 状态机)。确定性:now 可注入(§CD),同 DB+同 config → 同输出。
 * 全程无 LLM(§BB)。持久化小事务;drizzle 写入一律 await(交接坑 4)。
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentItems,
  contentMetricSnapshots,
  scoringRuns,
  topicMemberships,
  topicSnapshots,
  topics,
} from "../db/schema";
import {
  CONTENT_BURST_PROFILE,
  LIFECYCLE_PROFILE,
  SCORING_PROFILES,
  TOPIC_TREND_PROFILE,
  configSnapshotFor,
} from "./profiles";
import { ageBucketKey, resolveCohort } from "./cohort";
import {
  computeContentBurst,
  observeBurstInputs,
  type BurstCohortContext,
  type BurstCreatorContext,
  type BurstMetricPoint,
} from "./contentBurst";
import { creatorKeyOf } from "./creatorBaseline";
import { computeTopicTrend, type TopicSnapshotPoint, type TopicTrendInput, type TopicTrendMember , buildTrendBreakdown } from "./topicTrend";
import { decideLifecycle, LIFECYCLE_LABELS_ZH } from "./lifecycle";
import {
  insertLifecycleEvents,
  insertScoreSnapshots,
  insertTopicTrendSnapshots,
  getTopicCurrentRows,
  getTopicTrendHistory,
  upsertTopicCurrent,
  type ScoreSnapshotRow,
  type TopicCurrentRow,
  type TopicTrendRow,
} from "./repository";

const DAY_MS = 86_400_000;

/** 最新一次快照的平台加权动量(展示用;null = 从未观测到,§BN 展示列)。 */
function latestMomentum(snaps: TopicSnapshotPoint[]): number | null {
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].averageRawMomentum !== null) return snaps[i].averageRawMomentum;
  }
  return null;
}

export interface ContentScoringResult {
  runId: number;
  scoreProfile: "content_burst";
  scoreVersion: string;
  contentCount: number;
  scorableCount: number;
  unscorableCount: number;
  unscorableBreakdown: Record<string, number>;
  durationMs: number;
}

export interface TopicScoringResult {
  runId: number;
  scoreProfile: "topic_trend";
  scoreVersion: string;
  topicCount: number;
  scorableCount: number;
  unscorableCount: number;
  lifecycleTransitions: { topicId: number; from: string | null; to: string; reason: string }[];
  durationMs: number;
}

interface ItemRow {
  id: number;
  platform: string;
  contentType: string;
  publishedAt: string | null;
  authorId: string | null;
  authorName: string | null;
}

interface ObsRecord {
  item: ItemRow;
  snaps: BurstMetricPoint[];
  ageBucket: string;
  authorKey: string | null;
  obs: ReturnType<typeof observeBurstInputs>;
  topicId: number | null;
}

/* ------------------------------------------------------------------ */
/* Layer 1+2: Content Burst batch run                                  */
/* ------------------------------------------------------------------ */

export async function runContentScoring(
  db: DB,
  opts: { now?: number } = {},
): Promise<ContentScoringResult> {
  const startedAt = new Date().toISOString();
  const now = opts.now ?? Date.now();
  const calculatedAt = new Date(now).toISOString();
  const configSnapshot = configSnapshotFor(SCORING_PROFILES);
  const [run] = await db
    .insert(scoringRuns)
    .values({
      scoreProfile: "content_burst",
      scoreVersion: CONTENT_BURST_PROFILE.version,
      status: "running",
      configSnapshot,
      startedAt,
      createdAt: startedAt,
    })
    .returning({ id: scoringRuns.id });
  const runId = run.id;

  try {
    const t0 = Date.now();
    const items: ItemRow[] = await db
      .select({
        id: contentItems.id,
        platform: contentItems.platform,
        contentType: contentItems.contentType,
        publishedAt: contentItems.publishedAt,
        authorId: contentItems.authorId,
        authorName: contentItems.authorName,
      })
      .from(contentItems)
      .where(sql`${contentItems.mergedIntoContentItemId} IS NULL`)
      .orderBy(contentItems.id);

    // 全量快照一次拉取,内存分组(与 trendService 同模式,禁 per-item 查询)
    const snapRows = await db
      .select({
        contentItemId: contentMetricSnapshots.contentItemId,
        capturedAt: contentMetricSnapshots.capturedAt,
        views: contentMetricSnapshots.views,
        likes: contentMetricSnapshots.likes,
        comments: contentMetricSnapshots.comments,
        shares: contentMetricSnapshots.shares,
        favorites: contentMetricSnapshots.favorites,
        upvotes: contentMetricSnapshots.upvotes,
      })
      .from(contentMetricSnapshots)
      .innerJoin(contentItems, eq(contentItems.id, contentMetricSnapshots.contentItemId))
      .where(sql`${contentItems.mergedIntoContentItemId} IS NULL`)
      .orderBy(contentMetricSnapshots.contentItemId, contentMetricSnapshots.capturedAt, contentMetricSnapshots.id);
    const snapsByItem = new Map<number, BurstMetricPoint[]>();
    for (const r of snapRows) {
      const arr = snapsByItem.get(r.contentItemId);
      if (arr) arr.push(r);
      else snapsByItem.set(r.contentItemId, [r]);
    }

    const memRows = await db
      .select({ contentItemId: topicMemberships.contentItemId, topicId: topicMemberships.topicId })
      .from(topicMemberships);
    const topicByItem = new Map(memRows.map((m) => [m.contentItemId, m.topicId]));

    // ---- 逐内容观测(与 cohort 分布同规则,防分布错位) ----
    const records: ObsRecord[] = items.map((item) => {
      const snaps = snapsByItem.get(item.id) ?? [];
      return {
        item,
        snaps,
        ageBucket: ageBucketKey(item.publishedAt, now, CONTENT_BURST_PROFILE.ageBuckets),
        authorKey: creatorKeyOf(item.authorId, item.authorName),
        obs: observeBurstInputs(item.platform, snaps, now, CONTENT_BURST_PROFILE),
        topicId: topicByItem.get(item.id) ?? null,
      };
    });

    // ---- 作者历史(带 id,便于精确排除自身;§O) ----
    const byAuthor = new Map<string, { itemId: number; total: number }[]>();
    for (const r of records) {
      if (!r.authorKey || r.obs.interactionTotal === null) continue;
      const arr = byAuthor.get(r.authorKey);
      const entry = { itemId: r.item.id, total: r.obs.interactionTotal };
      if (arr) arr.push(entry);
      else byAuthor.set(r.authorKey, [entry]);
    }

    // ---- cohort 规模(4 级 key 全量计数) ----
    const sizes = { l0: new Map<string, number>(), l1: new Map<string, number>(), l2: new Map<string, number>(), l3: new Map<string, number>() };
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of records) {
      const p = r.item.platform;
      bump(sizes.l0, `${p}|${r.item.contentType}|${r.ageBucket}|topic:${r.topicId ?? "-"}`);
      bump(sizes.l1, `${p}|${r.item.contentType}|${r.ageBucket}`);
      bump(sizes.l2, `${p}|${r.ageBucket}`);
      bump(sizes.l3, `${p}`);
    }
    const sizeOf = (m: Map<string, number>, k: string) => m.get(k) ?? 0;

    // ---- 解析每条内容的 cohort,并把可用观测注入对应分布 ----
    interface CohortDist {
      velocityPerHour: number[];
      viewsLatest: number[];
      engagementRatios: number[];
      interactionTotals: number[];
      structure: Map<string, number[]>;
    }
    const dists = new Map<string, CohortDist>();
    const resolved: { r: ObsRecord; key: string; level: 0 | 1 | 2 | 3; levelLabel: string; insufficient: boolean; size: number }[] = [];
    for (const r of records) {
      const p = r.item.platform;
      const placement = resolveCohort(
        { platform: p, contentType: r.item.contentType, ageBucket: r.ageBucket, topicId: r.topicId },
        {
          l0: sizeOf(sizes.l0, `${p}|${r.item.contentType}|${r.ageBucket}|topic:${r.topicId ?? "-"}`),
          l1: sizeOf(sizes.l1, `${p}|${r.item.contentType}|${r.ageBucket}`),
          l2: sizeOf(sizes.l2, `${p}|${r.ageBucket}`),
          l3: sizeOf(sizes.l3, `${p}`),
        },
        CONTENT_BURST_PROFILE,
      );
      resolved.push({ r, key: placement.key, level: placement.level, levelLabel: placement.levelLabel, insufficient: placement.insufficient, size: placement.size });
      let d = dists.get(placement.key);
      if (!d) {
        d = { velocityPerHour: [], viewsLatest: [], engagementRatios: [], interactionTotals: [], structure: new Map() };
        dists.set(placement.key, d);
      }
      if (r.obs.velocityPerHour !== null) d.velocityPerHour.push(r.obs.velocityPerHour);
      if (r.obs.viewsLatest !== null) d.viewsLatest.push(r.obs.viewsLatest);
      if (r.obs.engagementRatio !== null) d.engagementRatios.push(r.obs.engagementRatio);
      if (r.obs.interactionTotal !== null) d.interactionTotals.push(r.obs.interactionTotal);
      for (const [k, v] of Object.entries(r.obs.structureValues)) {
        const arr = d.structure.get(k);
        if (arr) arr.push(v as number);
        else d.structure.set(k, [v as number]);
      }
    }

    // ---- 逐内容评分(单条异常不拖垮整批) ----
    const rows: (ScoreSnapshotRow & { platform: string; topicId: number | null })[] = [];
    const unscorableBreakdown: Record<string, number> = {};
    let scorableCount = 0;
    const errors: string[] = [];
    for (const { r, key, levelLabel, insufficient, size } of resolved) {
      try {
        const ownEntries = r.authorKey ? (byAuthor.get(r.authorKey) ?? []) : [];
        const historyTotals = ownEntries.filter((e) => e.itemId !== r.item.id).map((e) => e.total);
        const creatorCtx: BurstCreatorContext =
          historyTotals.length >= CONTENT_BURST_PROFILE.creatorMinHistory
            ? { basis: "creator", historyTotals, historyCount: historyTotals.length }
            : { basis: "cohort", historyTotals: null, historyCount: historyTotals.length };
        const cohortCtx: BurstCohortContext = {
          key,
          levelLabel,
          size,
          insufficient,
          velocityPerHour: dists.get(key)!.velocityPerHour,
          viewsLatest: dists.get(key)!.viewsLatest,
          engagementRatios: dists.get(key)!.engagementRatios,
          interactionTotals: dists.get(key)!.interactionTotals,
          structure: Object.fromEntries(dists.get(key)!.structure),
        };
        const out = computeContentBurst(
          {
            contentItemId: r.item.id,
            platform: r.item.platform,
            contentType: r.item.contentType,
            publishedAt: r.item.publishedAt,
          },
          r.snaps,
          cohortCtx,
          creatorCtx,
          now,
          CONTENT_BURST_PROFILE,
        );
        if (out.scorable) scorableCount += 1;
        else unscorableBreakdown[out.unscorableReason ?? "unknown"] = (unscorableBreakdown[out.unscorableReason ?? "unknown"] ?? 0) + 1;
        rows.push({
          contentItemId: r.item.id,
          scoringRunId: runId,
          scoreType: "content_burst",
          scoreVersion: CONTENT_BURST_PROFILE.version,
          scorable: out.scorable,
          unscorableReason: out.unscorableReason,
          overallScore: out.overallScore,
          confidence: out.confidence,
          breakdown: JSON.stringify({ ...out.breakdown, weightsUsed: out.weightsUsed, confidenceScore: out.confidenceScore, confidenceReasons: out.confidenceReasons }),
          evidence: JSON.stringify(out.evidence),
          calculatedAt,
          platform: r.item.platform,
          topicId: r.topicId,
        });
      } catch (e) {
        errors.push(`item ${r.item.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await insertScoreSnapshots(db, rows);
    const durationMs = Date.now() - t0;
    const status = errors.length > 0 ? "partial" : "completed";
    await db
      .update(scoringRuns)
      .set({
        status,
        contentCount: records.length,
        scorableCount,
        unscorableCount: records.length - scorableCount,
        durationMs,
        error: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(scoringRuns.id, runId));
    return {
      runId,
      scoreProfile: "content_burst",
      scoreVersion: CONTENT_BURST_PROFILE.version,
      contentCount: records.length,
      scorableCount,
      unscorableCount: records.length - scorableCount,
      unscorableBreakdown,
      durationMs,
    };
  } catch (e) {
    await db
      .update(scoringRuns)
      .set({
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        completedAt: new Date().toISOString(),
      })
      .where(eq(scoringRuns.id, runId));
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Layer 3+4: Topic Trend + Lifecycle batch run                        */
/* ------------------------------------------------------------------ */

export async function runTopicTrendScoring(
  db: DB,
  opts: { now?: number } = {},
): Promise<TopicScoringResult> {
  const startedAt = new Date().toISOString();
  const now = opts.now ?? Date.now();
  const calculatedAt = new Date(now).toISOString();
  const configSnapshot = configSnapshotFor(SCORING_PROFILES);
  const [run] = await db
    .insert(scoringRuns)
    .values({
      scoreProfile: "topic_trend",
      scoreVersion: TOPIC_TREND_PROFILE.version,
      status: "running",
      configSnapshot,
      startedAt,
      createdAt: startedAt,
    })
    .returning({ id: scoringRuns.id });
  const runId = run.id;
  const transitions: TopicScoringResult["lifecycleTransitions"] = [];

  try {
    const t0 = Date.now();
    const topicRows = await db
      .select({
        id: topics.id,
        name: topics.name,
        firstObservedAt: topics.firstObservedAt,
        memberCount: topics.memberCount,
      })
      .from(topics)
      .where(inArray(topics.status, ["active", "needs_review"]))
      .orderBy(topics.id);

    const snapRows = await db
      .select({
        topicId: topicSnapshots.topicId,
        capturedAt: topicSnapshots.capturedAt,
        memberCount: topicSnapshots.memberCount,
        newContentCount: topicSnapshots.newContentCount,
        activeCreatorCount: topicSnapshots.activeCreatorCount,
        averageRawMomentum: topicSnapshots.averageRawMomentum,
      })
      .from(topicSnapshots)
      .innerJoin(topics, eq(topics.id, topicSnapshots.topicId))
      .where(inArray(topics.status, ["active", "needs_review"]))
      .orderBy(topicSnapshots.topicId, topicSnapshots.capturedAt, topicSnapshots.id);
    const snapsByTopic = new Map<number, TopicSnapshotPoint[]>();
    for (const r of snapRows) {
      const arr = snapsByTopic.get(r.topicId);
      const point: TopicSnapshotPoint = {
        capturedAt: r.capturedAt,
        memberCount: r.memberCount,
        newContentCount: r.newContentCount,
        activeCreatorCount: r.activeCreatorCount,
        averageRawMomentum: r.averageRawMomentum,
      };
      if (arr) arr.push(point);
      else snapsByTopic.set(r.topicId, [point]);
    }

    const memberRows = await db
      .select({
        topicId: topicMemberships.topicId,
        contentItemId: topicMemberships.contentItemId,
        joinedAt: topicMemberships.createdAt,
        authorId: contentItems.authorId,
        authorName: contentItems.authorName,
      })
      .from(topicMemberships)
      .innerJoin(topics, eq(topics.id, topicMemberships.topicId))
      .innerJoin(contentItems, eq(contentItems.id, topicMemberships.contentItemId))
      .where(inArray(topics.status, ["active", "needs_review"]));
    const burstRows = await db
      .select({ contentItemId: sql<number>`content_item_id`, score: sql<number | null>`overall_score` })
      .from(sql`content_score_current`);
    const burstByItem = new Map(burstRows.map((b) => [Number(b.contentItemId), b.score === null ? null : Number(b.score)]));
    const membersByTopic = new Map<number, TopicTrendMember[]>();
    for (const m of memberRows) {
      const arr = membersByTopic.get(m.topicId);
      const member: TopicTrendMember = {
        contentItemId: m.contentItemId,
        authorKey: creatorKeyOf(m.authorId, m.authorName),
        burstScore: burstByItem.get(m.contentItemId) ?? null,
        joinedAt: m.joinedAt,
      };
      if (arr) arr.push(member);
      else membersByTopic.set(m.topicId, [member]);
    }

    const currentRows = await getTopicCurrentRows(db, topicRows.map((t) => t.id));
    const trendRows: TopicTrendRow[] = [];
    const currentUpserts: TopicCurrentRow[] = [];
    const lifecycleEvents: Parameters<typeof insertLifecycleEvents>[1] = [];
    let scorableCount = 0;
    const errors: string[] = [];

    for (const t of topicRows) {
      try {
        const input: TopicTrendInput = {
          topicId: t.id,
          name: t.name,
          firstObservedAt: t.firstObservedAt,
          members: membersByTopic.get(t.id) ?? [],
          snapshots: snapsByTopic.get(t.id) ?? [],
        };
        const out = computeTopicTrend(input, now, TOPIC_TREND_PROFILE);
        // §50-§55:分解与有效权重在引擎里已经算好,这里只负责落库,前端不再重算
        const breakdown = buildTrendBreakdown(out);
        const prev = currentRows.get(t.id);

        if (!out.scorable) {
          trendRows.push({
            topicId: t.id,
            scoringRunId: runId,
            scoreVersion: TOPIC_TREND_PROFILE.version,
            scorable: false,
            unscorableReason: out.unscorableReason,
            score: null,
            confidence: null,
            contentGrowth: null,
            engagementGrowth: null,
            creatorGrowth: null,
            burstDensity: null,
            acceleration: null,
            componentsJson: null,
            effectiveWeightsJson: null,
            memberCount: input.members.length,
            evidence: JSON.stringify(out.evidence),
            calculatedAt,
          });
          // 不可评分:保留既有 lifecycle(不因一次数据缺失翻转阶段)
          currentUpserts.push({
            topicId: t.id,
            scoreVersion: TOPIC_TREND_PROFILE.version,
            scorable: false,
            unscorableReason: out.unscorableReason,
            score: prev?.score ?? null,
            confidence: prev?.confidence ?? null,
            lifecycle: prev?.lifecycle ?? null,
            pendingLifecycle: null,
            pendingCount: 0,
            contentGrowth: null,
            engagementGrowth: null,
            creatorGrowth: null,
            burstDensity: null,
            acceleration: null,
            componentsJson: null,
            effectiveWeightsJson: null,
            memberCount: input.members.length,
            recentNewContent: null,
            activeCreators: null,
            avgRawMomentum: latestMomentum(input.snapshots),
            evidence: JSON.stringify(out.evidence),
            calculatedAt,
            scoringRunId: runId,
          });
          continue;
        }
        scorableCount += 1;

        // ---- lifecycle 判定(§AN-§AV) ----
        const trendHistory = await getTopicTrendHistory(db, t.id);
        const ageDays =
          t.firstObservedAt && Number.isFinite(Date.parse(t.firstObservedAt))
            ? (now - Date.parse(t.firstObservedAt)) / DAY_MS
            : null;
        const decision = decideLifecycle(
          {
            topicAgeDays: ageDays,
            memberCount: input.members.length,
            recentNew: out.raw!.recentNew,
            baselineNew: out.raw!.baselineNew,
            creatorGrowthPositive:
              out.raw!.currentCreators !== null && out.raw!.baselineCreators !== null
                ? (out.raw!.currentCreators as number) > (out.raw!.baselineCreators as number)
                : null,
            acceleration: out.raw!.acceleration,
            trendScore: out.score,
            burstDensity: out.raw!.burstDensityRatio,
            trendHistory,
            growthFlattening: out.saturationProxy?.growthFlattening ?? null,
            creatorConcentration: out.saturationProxy?.creatorConcentration ?? null,
          },
          LIFECYCLE_PROFILE,
        );

        // ---- 滞回状态机(§AV):连续 N 次观察一致,或趋势分强突破 ----
        let lifecycle = prev?.lifecycle ?? null;
        let pendingLifecycle = prev?.pendingLifecycle ?? null;
        let pendingCount = prev?.pendingCount ?? 0;
        const strongJump =
          prev?.score !== null &&
          prev?.score !== undefined &&
          Math.abs((out.score as number) - (prev.score as number)) >= LIFECYCLE_PROFILE.hysteresisStrongJump;
        if (decision.state === "unknown") {
          pendingLifecycle = null;
          pendingCount = 0;
        } else if (lifecycle === null) {
          lifecycle = decision.state;
          pendingLifecycle = null;
          pendingCount = 0;
          lifecycleEvents.push({
            topicId: t.id,
            fromState: null,
            toState: decision.state,
            trendScore: out.score,
            reason: `${decision.reason};首次评定(${LIFECYCLE_LABELS_ZH[decision.state]})`,
            scoreVersion: TOPIC_TREND_PROFILE.version,
            scoringRunId: runId,
            occurredAt: calculatedAt,
          });
        } else if (decision.state === lifecycle) {
          pendingLifecycle = null;
          pendingCount = 0;
        } else {
          if (pendingLifecycle === decision.state) pendingCount += 1;
          else {
            pendingLifecycle = decision.state;
            pendingCount = 1;
          }
          if (pendingCount >= LIFECYCLE_PROFILE.hysteresisConsecutive || strongJump) {
            lifecycleEvents.push({
              topicId: t.id,
              fromState: lifecycle,
              toState: decision.state,
              trendScore: out.score,
              reason: `${decision.reason};${strongJump ? `趋势分强突破 Δ=${Math.round(Math.abs((out.score as number) - (prev!.score as number)))}` : `连续 ${pendingCount} 次观察一致`}`,
              scoreVersion: TOPIC_TREND_PROFILE.version,
              scoringRunId: runId,
              occurredAt: calculatedAt,
            });
            transitions.push({ topicId: t.id, from: lifecycle, to: decision.state, reason: decision.reason });
            lifecycle = decision.state;
            pendingLifecycle = null;
            pendingCount = 0;
          }
        }

        const ev = {
          ...out.evidence,
          lifecycle: { state: decision.state, reason: decision.reason, label: LIFECYCLE_LABELS_ZH[decision.state] },
          saturationProxy: out.saturationProxy,
        };
        trendRows.push({
          topicId: t.id,
          scoringRunId: runId,
          scoreVersion: TOPIC_TREND_PROFILE.version,
          scorable: true,
          unscorableReason: null,
          score: out.score,
          confidence: out.confidence,
          contentGrowth: out.components!.contentGrowth.score,
          engagementGrowth: out.components!.engagementGrowth.score,
          creatorGrowth: out.components!.creatorGrowth.score,
          burstDensity: out.components!.burstDensity.score,
          acceleration: out.components!.acceleration.score,
          componentsJson: breakdown ? JSON.stringify(breakdown.components) : null,
          effectiveWeightsJson: breakdown ? JSON.stringify(breakdown.effectiveWeights) : null,
          memberCount: input.members.length,
          evidence: JSON.stringify(ev),
          calculatedAt,
        });
        currentUpserts.push({
          topicId: t.id,
          scoreVersion: TOPIC_TREND_PROFILE.version,
          scorable: true,
          unscorableReason: null,
          score: out.score,
          confidence: out.confidence,
          lifecycle: lifecycle ?? null,
          pendingLifecycle,
          pendingCount,
          contentGrowth: out.components!.contentGrowth.score,
          engagementGrowth: out.components!.engagementGrowth.score,
          creatorGrowth: out.components!.creatorGrowth.score,
          burstDensity: out.components!.burstDensity.score,
          acceleration: out.components!.acceleration.score,
          componentsJson: breakdown ? JSON.stringify(breakdown.components) : null,
          effectiveWeightsJson: breakdown ? JSON.stringify(breakdown.effectiveWeights) : null,
          memberCount: input.members.length,
          recentNewContent: out.raw!.recentNew,
          activeCreators: out.raw!.currentCreators,
          avgRawMomentum: latestMomentum(input.snapshots),
          evidence: JSON.stringify(ev),
          calculatedAt,
          scoringRunId: runId,
        });
      } catch (e) {
        errors.push(`topic ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await insertTopicTrendSnapshots(db, trendRows);
    await upsertTopicCurrent(db, currentUpserts);
    await insertLifecycleEvents(db, lifecycleEvents);

    const durationMs = Date.now() - t0;
    await db
      .update(scoringRuns)
      .set({
        status: errors.length > 0 ? "partial" : "completed",
        topicCount: topicRows.length,
        scorableCount,
        unscorableCount: topicRows.length - scorableCount,
        durationMs,
        error: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(scoringRuns.id, runId));
    return {
      runId,
      scoreProfile: "topic_trend",
      scoreVersion: TOPIC_TREND_PROFILE.version,
      topicCount: topicRows.length,
      scorableCount,
      unscorableCount: topicRows.length - scorableCount,
      lifecycleTransitions: transitions,
      durationMs,
    };
  } catch (e) {
    await db
      .update(scoringRuns)
      .set({
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        completedAt: new Date().toISOString(),
      })
      .where(eq(scoringRuns.id, runId));
    throw e;
  }
}

/** 组合运行:内容评分 → 话题趋势(顺序硬约束:Layer 2 先于 Layer 3)。 */
export async function runAllScoring(db: DB, opts: { now?: number } = {}) {
  const content = await runContentScoring(db, opts);
  const topic = await runTopicTrendScoring(db, opts);
  return { content, topic };
}
