/**
 * Opportunity repository (Stage 9 §71-§72):append-only 快照、current 缓存、
 * 人工决策、SQL 分页/排序/筛选(禁全量 JS sort)。
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  opportunityDecisions,
  opportunityRuns,
  topicIntelligenceCurrent,
  topicOpportunityCurrent,
  topicOpportunitySnapshots,
  topicScoreCurrent,
  topics,
  topicWatches,
} from "../db/schema";

export interface OpportunitySnapshotRow {
  topicId: number;
  runId: number;
  score: number | null;
  scoreVersion: string;
  profileId: string;
  profileVersion: string;
  confidence: string | null;
  unscorableReason: string | null;
  trendContribution: number | null;
  burstContribution: number | null;
  noveltyContribution: number | null;
  whitespaceContribution: number | null;
  patternContribution: number | null;
  lifecycleContribution: number | null;
  effectiveWeights: string;
  deltaScore: number | null;
  whyChanged: string | null;
  evidence: string;
  calculatedAt: string;
}

export async function insertOpportunitySnapshots(db: DB, rows: OpportunitySnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(topicOpportunitySnapshots).values(batch).run();
    });
  }
}

/** 上一 snapshot(贡献 + 分数),供 delta / whyChanged(§41/§42)。 */
export async function getPreviousSnapshots(db: DB, topicIds: number[]): Promise<Map<number, { score: number | null; contributions: Record<string, number | null> }>> {
  if (topicIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(topicOpportunitySnapshots)
    .where(inArray(topicOpportunitySnapshots.topicId, topicIds))
    .orderBy(desc(topicOpportunitySnapshots.id))
    .limit(topicIds.length * 3);
  const out = new Map<number, { score: number | null; contributions: Record<string, number | null> }>();
  for (const r of rows) {
    if (out.has(r.topicId)) continue; // 每话题只取最新一条
    out.set(r.topicId, {
      score: r.score,
      contributions: {
        trend: r.trendContribution,
        burst: r.burstContribution,
        novelty: r.noveltyContribution,
        whitespace: r.whitespaceContribution,
        pattern: r.patternContribution,
        lifecycle: r.lifecycleContribution,
      },
    });
  }
  return out;
}

export interface OpportunityCurrentRow {
  topicId: number;
  score: number | null;
  confidence: string | null;
  opportunityLevel: string | null;
  unscorableReason: string | null;
  deltaScore: number | null;
  profileId: string;
  profileVersion: string;
  scoreVersion: string;
  evidence: string;
  calculatedAt: string;
  runId: number;
}

export async function upsertOpportunityCurrent(db: DB, rows: OpportunityCurrentRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(topicOpportunityCurrent)
        .values(batch)
        .onConflictDoUpdate({
          target: topicOpportunityCurrent.topicId,
          set: {
            score: sql`excluded.score`,
            confidence: sql`excluded.confidence`,
            opportunityLevel: sql`excluded.opportunity_level`,
            unscorableReason: sql`excluded.unscorable_reason`,
            deltaScore: sql`excluded.delta_score`,
            profileId: sql`excluded.profile_id`,
            profileVersion: sql`excluded.profile_version`,
            scoreVersion: sql`excluded.score_version`,
            evidence: sql`excluded.evidence`,
            calculatedAt: sql`excluded.calculated_at`,
            runId: sql`excluded.run_id`,
          },
        })
        .run();
    });
  }
}

export async function upsertDecision(
  db: DB,
  topicId: number,
  status: string,
  note: string | null,
  nowIso: string,
): Promise<void> {
  db.transaction((tx) => {
    tx.insert(opportunityDecisions)
      .values({ topicId, status, note, createdAt: nowIso, updatedAt: nowIso })
      .onConflictDoUpdate({
        target: opportunityDecisions.topicId,
        set: { status: sql`excluded.status`, note: sql`excluded.note`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  });
}

export async function getDecision(db: DB, topicId: number) {
  const rows = await db.select().from(opportunityDecisions).where(eq(opportunityDecisions.topicId, topicId)).limit(1);
  return rows[0] ?? null;
}

/* ---------------- 查询侧(§75/§76):SQL 分页排序筛选 ---------------- */

export interface OpportunityListQuery {
  minOpportunity?: number;
  confidence?: string;
  lifecycle?: string;
  maxSaturation?: number;
  minNovelty?: number;
  decision?: string;
  watchState?: string;
  minMembers?: number;
  updatedAfter?: string;
  sortBy?: "score" | "delta" | "trend" | "novelty" | "memberCount" | "updatedAt";
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export async function listOpportunityTopics(db: DB, q: OpportunityListQuery) {
  const conds: SQL[] = [eq(topics.status, "active")];
  if (q.minOpportunity !== undefined) conds.push(gte(topicOpportunityCurrent.score, q.minOpportunity));
  if (q.confidence) conds.push(eq(topicOpportunityCurrent.confidence, q.confidence));
  if (q.lifecycle) conds.push(eq(topicScoreCurrent.lifecycle, q.lifecycle));
  if (q.maxSaturation !== undefined) conds.push(lte(topicIntelligenceCurrent.saturationScore, q.maxSaturation));
  if (q.minNovelty !== undefined) conds.push(gte(topicIntelligenceCurrent.noveltyScore, q.minNovelty));
  if (q.decision) conds.push(eq(opportunityDecisions.status, q.decision));
  if (q.watchState) conds.push(eq(topicWatches.state, q.watchState));
  if (q.minMembers !== undefined) conds.push(gte(topics.memberCount, q.minMembers));
  if (q.updatedAfter) conds.push(gte(topicOpportunityCurrent.calculatedAt, q.updatedAfter));

  const sortCol =
    q.sortBy === "delta"
      ? topicOpportunityCurrent.deltaScore
      : q.sortBy === "trend"
        ? topicScoreCurrent.score
        : q.sortBy === "novelty"
          ? topicIntelligenceCurrent.noveltyScore
          : q.sortBy === "memberCount"
            ? topics.memberCount
            : q.sortBy === "updatedAt"
              ? topicOpportunityCurrent.calculatedAt
              : topicOpportunityCurrent.score;
  const dir = q.order === "asc" ? asc : desc;
  const where = and(...conds);

  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(topicOpportunityCurrent)
    .innerJoin(topics, eq(topics.id, topicOpportunityCurrent.topicId))
    .innerJoin(topicScoreCurrent, eq(topicScoreCurrent.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(topicIntelligenceCurrent, eq(topicIntelligenceCurrent.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(opportunityDecisions, eq(opportunityDecisions.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(topicWatches, eq(topicWatches.topicId, topicOpportunityCurrent.topicId))
    .where(where);
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = await db
    .select({
      topicId: topics.id,
      name: topics.name,
      memberCount: topics.memberCount,
      keywords: topics.keywords,
      score: topicOpportunityCurrent.score,
      confidence: topicOpportunityCurrent.confidence,
      opportunityLevel: topicOpportunityCurrent.opportunityLevel,
      deltaScore: topicOpportunityCurrent.deltaScore,
      calculatedAt: topicOpportunityCurrent.calculatedAt,
      trendScore: topicScoreCurrent.score,
      lifecycle: topicScoreCurrent.lifecycle,
      burstDensity: topicScoreCurrent.burstDensity,
      saturationScore: topicIntelligenceCurrent.saturationScore,
      noveltyScore: topicIntelligenceCurrent.noveltyScore,
      emergingAngleCount: topicIntelligenceCurrent.emergingAngleCount,
      decision: opportunityDecisions.status,
      watchState: topicWatches.state,
    })
    .from(topicOpportunityCurrent)
    .innerJoin(topics, eq(topics.id, topicOpportunityCurrent.topicId))
    .innerJoin(topicScoreCurrent, eq(topicScoreCurrent.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(topicIntelligenceCurrent, eq(topicIntelligenceCurrent.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(opportunityDecisions, eq(opportunityDecisions.topicId, topicOpportunityCurrent.topicId))
    .leftJoin(topicWatches, eq(topicWatches.topicId, topicOpportunityCurrent.topicId))
    .where(where)
    .orderBy(dir(sortCol), desc(topicOpportunityCurrent.confidence), desc(topics.memberCount))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return { rows, total, page: q.page, pageSize: q.pageSize };
}

export async function getTopicOpportunityDetail(db: DB, topicId: number) {
  const [current] = await db
    .select()
    .from(topicOpportunityCurrent)
    .where(eq(topicOpportunityCurrent.topicId, topicId))
    .limit(1);
  const history = await db
    .select()
    .from(topicOpportunitySnapshots)
    .where(eq(topicOpportunitySnapshots.topicId, topicId))
    .orderBy(desc(topicOpportunitySnapshots.id))
    .limit(50);
  const decision = await getDecision(db, topicId);
  return { current: current ?? null, history, decision };
}

export async function listOpportunityRuns(db: DB) {
  return db.select().from(opportunityRuns).orderBy(desc(opportunityRuns.id)).limit(20);
}
