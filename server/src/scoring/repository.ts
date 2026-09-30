/**
 * Scoring repository (Stage 7 §BA):所有 scoring 表读写集中于此。
 * append-only 表只 INSERT;*_current 表 upsert。小事务分批(6B §71 教训:
 * drizzle builder 是 lazy 的,一切写入必须 await)。
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentItems,
  contentScoreCurrent,
  contentScoreSnapshots,
  scoringRuns,
  topicIntelligenceCurrent,
  topicLifecycleEvents,
  topicOpportunityCurrent,
  topicScoreCurrent,
  topicTrendSnapshots,
  topics,
  topicWatches,
} from "../db/schema";

export interface ScoreSnapshotRow {
  contentItemId: number;
  scoringRunId: number;
  scoreType: string;
  scoreVersion: string;
  scorable: boolean;
  unscorableReason: string | null;
  overallScore: number | null;
  confidence: string | null;
  breakdown: string;
  evidence: string;
  calculatedAt: string;
}

export interface TopicTrendRow {
  topicId: number;
  scoringRunId: number;
  scoreVersion: string;
  scorable: boolean;
  unscorableReason: string | null;
  score: number | null;
  confidence: string | null;
  contentGrowth: number | null;
  engagementGrowth: number | null;
  creatorGrowth: number | null;
  burstDensity: number | null;
  acceleration: number | null;
  /** §51-§55:服务端产出的组件分解与有效权重(JSON);旧 Run 为 null */
  componentsJson: string | null;
  effectiveWeightsJson: string | null;
  memberCount: number;
  evidence: string;
  calculatedAt: string;
}

const CHUNK = 400;

export async function insertScoreSnapshots(db: DB, rows: (ScoreSnapshotRow & { platform: string; topicId: number | null })[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    db.transaction((tx) => {
      tx.insert(contentScoreSnapshots)
        .values(batch.map(({ platform: _p, topicId: _t, ...r }) => ({ ...r, scorable: r.scorable ? 1 : 0 })))
        .run();
      tx
        .insert(contentScoreCurrent)
        .values(
          batch.map((r) => ({
            contentItemId: r.contentItemId,
            scoreType: r.scoreType,
            scoreVersion: r.scoreVersion,
            scorable: r.scorable ? 1 : 0,
            unscorableReason: r.unscorableReason,
            overallScore: r.overallScore,
            confidence: r.confidence,
            breakdown: r.breakdown,
            evidence: r.evidence,
            calculatedAt: r.calculatedAt,
            scoringRunId: r.scoringRunId,
            platform: r.platform,
            topicId: r.topicId,
          })),
        )
        .onConflictDoUpdate({
          target: contentScoreCurrent.contentItemId,
          set: {
            scoreType: sql`excluded.score_type`,
            scoreVersion: sql`excluded.score_version`,
            scorable: sql`excluded.scorable`,
            unscorableReason: sql`excluded.unscorable_reason`,
            overallScore: sql`excluded.overall_score`,
            confidence: sql`excluded.confidence`,
            breakdown: sql`excluded.breakdown`,
            evidence: sql`excluded.evidence`,
            calculatedAt: sql`excluded.calculated_at`,
            scoringRunId: sql`excluded.scoring_run_id`,
            platform: sql`excluded.platform`,
            topicId: sql`excluded.topic_id`,
          },
        })
        .run();
    });
  }
}

export async function insertTopicTrendSnapshots(db: DB, rows: TopicTrendRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    db.transaction((tx) => {
      tx.insert(topicTrendSnapshots)
        .values(batch.map((r) => ({ ...r, scorable: r.scorable ? 1 : 0 })))
        .run();
    });
  }
}

export interface TopicCurrentRow {
  topicId: number;
  scoreVersion: string;
  scorable: boolean;
  unscorableReason: string | null;
  score: number | null;
  confidence: string | null;
  lifecycle: string | null;
  pendingLifecycle: string | null;
  pendingCount: number;
  contentGrowth: number | null;
  engagementGrowth: number | null;
  creatorGrowth: number | null;
  burstDensity: number | null;
  acceleration: number | null;
  componentsJson: string | null;
  effectiveWeightsJson: string | null;
  memberCount: number;
  recentNewContent: number | null;
  activeCreators: number | null;
  avgRawMomentum: number | null;
  evidence: string;
  calculatedAt: string;
  scoringRunId: number;
}

export async function upsertTopicCurrent(db: DB, rows: TopicCurrentRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    db.transaction((tx) => {
      tx
        .insert(topicScoreCurrent)
        .values(batch.map((r) => ({ ...r, scorable: r.scorable ? 1 : 0 })))
        .onConflictDoUpdate({
          target: topicScoreCurrent.topicId,
          set: {
            scoreVersion: sql`excluded.score_version`,
            scorable: sql`excluded.scorable`,
            unscorableReason: sql`excluded.unscorable_reason`,
            score: sql`excluded.score`,
            confidence: sql`excluded.confidence`,
            lifecycle: sql`excluded.lifecycle`,
            pendingLifecycle: sql`excluded.pending_lifecycle`,
            pendingCount: sql`excluded.pending_count`,
            contentGrowth: sql`excluded.content_growth`,
            engagementGrowth: sql`excluded.engagement_growth`,
            creatorGrowth: sql`excluded.creator_growth`,
            burstDensity: sql`excluded.burst_density`,
            acceleration: sql`excluded.acceleration`,
            componentsJson: sql`excluded.components_json`,
            effectiveWeightsJson: sql`excluded.effective_weights_json`,
            memberCount: sql`excluded.member_count`,
            recentNewContent: sql`excluded.recent_new_content`,
            activeCreators: sql`excluded.active_creators`,
            avgRawMomentum: sql`excluded.avg_raw_momentum`,
            evidence: sql`excluded.evidence`,
            calculatedAt: sql`excluded.calculated_at`,
            scoringRunId: sql`excluded.scoring_run_id`,
          },
        })
        .run();
    });
  }
}

export async function insertLifecycleEvents(
  db: DB,
  rows: {
    topicId: number;
    fromState: string | null;
    toState: string;
    trendScore: number | null;
    reason: string;
    scoreVersion: string;
    scoringRunId: number;
    occurredAt: string;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    tx.insert(topicLifecycleEvents).values(rows).run();
  });
}

export async function getTopicCurrentRows(
  db: DB,
  topicIds: number[],
): Promise<Map<number, typeof topicScoreCurrent.$inferSelect>> {
  if (topicIds.length === 0) return new Map();
  const rows = await db.select().from(topicScoreCurrent).where(inArray(topicScoreCurrent.topicId, topicIds));
  return new Map(rows.map((r) => [r.topicId, r]));
}

/** 近期 trend 分序列(升序;仅可评分快照)。 */
export async function getTopicTrendHistory(db: DB, topicId: number, limit = 10): Promise<number[]> {
  const rows = await db
    .select({ score: topicTrendSnapshots.score })
    .from(topicTrendSnapshots)
    .where(and(eq(topicTrendSnapshots.topicId, topicId), isNull(topicTrendSnapshots.unscorableReason)))
    .orderBy(desc(topicTrendSnapshots.calculatedAt))
    .limit(limit);
  return rows
    .map((r) => r.score)
    .filter((s): s is number => s !== null)
    .reverse();
}

/* ---------------- 查询侧(§CR/§CS/§CT):SQL 排序分页,禁全表 JS sort ---------------- */

export interface TopicTrendListQuery {
  search?: string;
  lifecycle?: string;
  confidence?: string;
  platform?: string;
  watch?: string;
  minScore?: number;
  /** Stage 8 §74:饱和度档(low<34 / medium / high>=67)与最低新颖度筛选 */
  saturation?: string;
  noveltyMin?: number;
  /** Stage 9 §45:机会指数下限筛选 */
  minOpportunity?: number;
  sortBy?: "score" | "memberCount" | "recentNew" | "updatedAt" | "saturation" | "novelty" | "opportunity";
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

/** 饱和度分档(集中定义;UI 低/中/高)。 */
export function saturationBand(score: number | null | undefined): "low" | "medium" | "high" | null {
  if (score === null || score === undefined) return null;
  if (score < 34) return "low";
  if (score < 67) return "medium";
  return "high";
}

export async function listTopicTrends(db: DB, q: TopicTrendListQuery) {
  const conds: SQL[] = [eq(topics.status, "active")];
  if (q.search) conds.push(sql`${topics.name} LIKE ${`%${q.search}%`}`);
  if (q.lifecycle === "unknown") conds.push(sql`${topicScoreCurrent.lifecycle} IS NULL`);
  else if (q.lifecycle) conds.push(eq(topicScoreCurrent.lifecycle, q.lifecycle));
  if (q.confidence) conds.push(eq(topicScoreCurrent.confidence, q.confidence));
  if (q.platform) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM topic_memberships m JOIN content_items ci ON ci.id = m.content_item_id
           WHERE m.topic_id = ${topics.id} AND ci.platform = ${q.platform})`,
    );
  }
  if (q.watch === "none") conds.push(sql`${topicWatches.state} IS NULL`);
  else if (q.watch) conds.push(eq(topicWatches.state, q.watch));
  if (q.minScore !== undefined) conds.push(gte(topicScoreCurrent.score, q.minScore));
  if (q.saturation === "unknown") conds.push(sql`${topicIntelligenceCurrent.saturationScore} IS NULL`);
  else if (q.saturation) {
    if (q.saturation === "low") conds.push(sql`${topicIntelligenceCurrent.saturationScore} < 34`);
    else if (q.saturation === "medium") conds.push(sql`${topicIntelligenceCurrent.saturationScore} >= 34 AND ${topicIntelligenceCurrent.saturationScore} < 67`);
    else if (q.saturation === "high") conds.push(sql`${topicIntelligenceCurrent.saturationScore} >= 67`);
  }
  if (q.noveltyMin !== undefined) conds.push(gte(topicIntelligenceCurrent.noveltyScore, q.noveltyMin));
  if (q.minOpportunity !== undefined) conds.push(gte(topicOpportunityCurrent.score, q.minOpportunity));

  const sortCol =
    q.sortBy === "memberCount"
      ? topics.memberCount
      : q.sortBy === "recentNew"
        ? topicScoreCurrent.recentNewContent
        : q.sortBy === "updatedAt"
          ? topicScoreCurrent.calculatedAt
          : q.sortBy === "saturation"
            ? topicIntelligenceCurrent.saturationScore
            : q.sortBy === "novelty"
              ? topicIntelligenceCurrent.noveltyScore
              : q.sortBy === "opportunity"
                ? topicOpportunityCurrent.score
                : topicScoreCurrent.score;
  const dir = q.order === "asc" ? asc : desc;
  const where = and(...conds);

  // 与下方 rows 查询保持同一组 JOIN:where 里引用的表必须在这里也 join 进来,
  // 否则 minOpportunity / opportunity 排序会让 count 查询报 no such column。
  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(topicScoreCurrent)
    .innerJoin(topics, eq(topics.id, topicScoreCurrent.topicId))
    .leftJoin(topicWatches, eq(topicWatches.topicId, topics.id))
    .leftJoin(topicIntelligenceCurrent, eq(topicIntelligenceCurrent.topicId, topics.id))
    .leftJoin(topicOpportunityCurrent, eq(topicOpportunityCurrent.topicId, topics.id))
    .where(where);
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = await db
    .select({
      topicId: topics.id,
      name: topics.name,
      status: topics.status,
      keywords: topics.keywords,
      cohesion: topics.cohesion,
      memberCount: topics.memberCount,
      firstObservedAt: topics.firstObservedAt,
      score: topicScoreCurrent.score,
      confidence: topicScoreCurrent.confidence,
      lifecycle: topicScoreCurrent.lifecycle,
      contentGrowth: topicScoreCurrent.contentGrowth,
      engagementGrowth: topicScoreCurrent.engagementGrowth,
      creatorGrowth: topicScoreCurrent.creatorGrowth,
      burstDensity: topicScoreCurrent.burstDensity,
      acceleration: topicScoreCurrent.acceleration,
      recentNewContent: topicScoreCurrent.recentNewContent,
      activeCreators: topicScoreCurrent.activeCreators,
      avgRawMomentum: topicScoreCurrent.avgRawMomentum,
      calculatedAt: topicScoreCurrent.calculatedAt,
      watchState: topicWatches.state,
      saturationScore: topicIntelligenceCurrent.saturationScore,
      saturatedConfidence: topicIntelligenceCurrent.saturatedConfidence,
      noveltyScore: topicIntelligenceCurrent.noveltyScore,
      emergingAngleCount: topicIntelligenceCurrent.emergingAngleCount,
      opportunityScore: topicOpportunityCurrent.score,
      opportunityLevel: topicOpportunityCurrent.opportunityLevel,
    })
    .from(topicScoreCurrent)
    .innerJoin(topics, eq(topics.id, topicScoreCurrent.topicId))
    .leftJoin(topicWatches, eq(topicWatches.topicId, topics.id))
    .leftJoin(topicIntelligenceCurrent, eq(topicIntelligenceCurrent.topicId, topics.id))
    .leftJoin(topicOpportunityCurrent, eq(topicOpportunityCurrent.topicId, topics.id))
    .where(where)
    .orderBy(dir(sortCol), desc(topics.memberCount))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return { rows, total, page: q.page, pageSize: q.pageSize };
}

export interface ContentScoreListQuery {
  platform?: string;
  topicId?: number;
  confidence?: string;
  minScore?: number;
  maxScore?: number;
  publishedFrom?: string;
  publishedTo?: string;
  scorable?: "yes" | "no";
  sortBy?: "score" | "publishedAt";
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export async function listContentScores(db: DB, q: ContentScoreListQuery) {
  const conds: SQL[] = [isNull(contentItems.mergedIntoContentItemId)];
  if (q.platform) conds.push(eq(contentScoreCurrent.platform, q.platform));
  if (q.topicId !== undefined) conds.push(eq(contentScoreCurrent.topicId, q.topicId));
  if (q.confidence) conds.push(eq(contentScoreCurrent.confidence, q.confidence));
  if (q.minScore !== undefined) conds.push(gte(contentScoreCurrent.overallScore, q.minScore));
  if (q.maxScore !== undefined) conds.push(lte(contentScoreCurrent.overallScore, q.maxScore));
  if (q.publishedFrom) conds.push(gte(contentItems.publishedAt, q.publishedFrom));
  if (q.publishedTo) conds.push(lte(contentItems.publishedAt, q.publishedTo));
  if (q.scorable === "yes") conds.push(eq(contentScoreCurrent.scorable, 1));
  if (q.scorable === "no") conds.push(eq(contentScoreCurrent.scorable, 0));

  const dir = q.order === "asc" ? asc : desc;
  const sortCol =
    q.sortBy === "publishedAt"
      ? contentItems.publishedAt
      : contentScoreCurrent.overallScore;
  const where = and(...conds);

  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(contentScoreCurrent)
    .innerJoin(contentItems, eq(contentItems.id, contentScoreCurrent.contentItemId))
    .where(where);
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = await db
    .select({
      contentItemId: contentScoreCurrent.contentItemId,
      title: contentItems.title,
      platform: contentItems.platform,
      contentType: contentItems.contentType,
      authorName: contentItems.authorName,
      publishedAt: contentItems.publishedAt,
      url: contentItems.url,
      score: contentScoreCurrent.overallScore,
      confidence: contentScoreCurrent.confidence,
      scorable: contentScoreCurrent.scorable,
      unscorableReason: contentScoreCurrent.unscorableReason,
      calculatedAt: contentScoreCurrent.calculatedAt,
      topicId: contentScoreCurrent.topicId,
    })
    .from(contentScoreCurrent)
    .innerJoin(contentItems, eq(contentItems.id, contentScoreCurrent.contentItemId))
    .where(where)
    .orderBy(dir(sortCol), desc(contentScoreCurrent.calculatedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return { rows, total, page: q.page, pageSize: q.pageSize };
}

export async function getContentScoreDetail(db: DB, contentItemId: number) {
  const [current] = await db
    .select()
    .from(contentScoreCurrent)
    .where(eq(contentScoreCurrent.contentItemId, contentItemId))
    .limit(1);
  const history = await db
    .select()
    .from(contentScoreSnapshots)
    .where(eq(contentScoreSnapshots.contentItemId, contentItemId))
    .orderBy(desc(contentScoreSnapshots.calculatedAt))
    .limit(50);
  return { current: current ?? null, history };
}

export async function getTopicTrendDetail(db: DB, topicId: number) {
  const [current] = await db
    .select()
    .from(topicScoreCurrent)
    .where(eq(topicScoreCurrent.topicId, topicId))
    .limit(1);
  const history = await db
    .select()
    .from(topicTrendSnapshots)
    .where(eq(topicTrendSnapshots.topicId, topicId))
    .orderBy(desc(topicTrendSnapshots.calculatedAt))
    .limit(50);
  const lifecycleEvents = await db
    .select()
    .from(topicLifecycleEvents)
    .where(eq(topicLifecycleEvents.topicId, topicId))
    .orderBy(desc(topicLifecycleEvents.occurredAt))
    .limit(50);
  return { current: current ?? null, history, lifecycleEvents };
}

export async function listScoringRuns(db: DB, profile: string | undefined) {
  const rows = profile
    ? await db.select().from(scoringRuns).where(eq(scoringRuns.scoreProfile, profile)).orderBy(desc(scoringRuns.id)).limit(20)
    : await db.select().from(scoringRuns).orderBy(desc(scoringRuns.id)).limit(20);
  return rows;
}
