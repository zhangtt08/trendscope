/**
 * Intelligence repository (Stage 8 §60-§65/§73):feature 缓存、append-only 结果、
 * angle cluster 调和持久化、current 缓存与 SQL 列表。写入必须 await/同步事务。
 */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentFeatureRecords,
  intelligenceRuns,
  patternResults,
  topicAngleClusters,
  topicIntelligenceCurrent,
  topicNoveltySnapshots,
  topicSaturationSnapshots,
  topics,
} from "../db/schema";

export interface FeatureRecordRow {
  contentItemId: number;
  textHash: string;
  featureVersion: string;
  extractor: string;
  model: string | null;
  features: string;
  calculatedAt: string;
}

export async function findFeatureRecords(
  db: DB,
  keys: { contentItemId: number; textHash: string }[],
  featureVersion: string,
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const idSet = new Set(keys.map((k) => k.contentItemId));
  const rows = await db
    .select()
    .from(contentFeatureRecords)
    .where(
      and(
        eq(contentFeatureRecords.featureVersion, featureVersion),
        inArray(contentFeatureRecords.contentItemId, [...idSet]),
      ),
    );
  const byKey = new Map<string, string>();
  const keySet = new Set(keys.map((k) => `${k.contentItemId}:${k.textHash}`));
  for (const r of rows) {
    const key = `${r.contentItemId}:${r.textHash}`;
    if (keySet.has(key)) byKey.set(key, r.features);
  }
  return byKey;
}

export async function insertFeatureRecords(db: DB, rows: FeatureRecordRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(contentFeatureRecords)
        .values(batch)
        .onConflictDoNothing({
          target: [contentFeatureRecords.contentItemId, contentFeatureRecords.featureVersion, contentFeatureRecords.textHash],
        })
        .run();
    });
  }
}

export interface PatternResultRow {
  runId: number;
  scope: string;
  topicId: number | null;
  platform: string | null;
  windowHours: number;
  feature: string;
  featureKind: string;
  viralValue: string;
  controlValue: string;
  lift: number | null;
  delta: number | null;
  viralSampleSize: number;
  controlSampleSize: number;
  evidenceQuality: string;
  notes: string;
  featureVersion: string;
  patternVersion: string;
  calculatedAt: string;
}

export async function insertPatternResults(db: DB, rows: PatternResultRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(patternResults).values(batch).run();
    });
  }
}

export interface SaturationSnapshotRow {
  topicId: number;
  runId: number;
  score: number | null;
  confidence: string | null;
  unscorableReason: string | null;
  breakdown: string;
  evidence: string;
  version: string;
  calculatedAt: string;
}

export async function insertSaturationSnapshots(db: DB, rows: SaturationSnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(topicSaturationSnapshots).values(batch).run();
    });
  }
}

export interface NoveltySnapshotRow {
  topicId: number;
  runId: number;
  score: number | null;
  emergingAngleCount: number;
  confidence: string | null;
  unscorableReason: string | null;
  evidence: string;
  version: string;
  calculatedAt: string;
}

export async function insertNoveltySnapshots(db: DB, rows: NoveltySnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(topicNoveltySnapshots).values(batch).run();
    });
  }
}

export interface HistoricalClusterRow {
  id: number;
  label: string;
  labelSource: string;
  firstObservedAt: string;
  centroid: number[] | null;
  dimension: number | null;
  isEmerging: number;
  status: string;
}

/** 话题既有角度簇(质心解码回 number[];无质心 → null)。 */
export async function getHistoricalClusters(db: DB, topicId: number): Promise<HistoricalClusterRow[]> {
  const rows = await db
    .select()
    .from(topicAngleClusters)
    .where(and(eq(topicAngleClusters.topicId, topicId), eq(topicAngleClusters.status, "active")));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    labelSource: r.labelSource,
    firstObservedAt: r.firstObservedAt,
    centroid: r.centroid ? [...new Float32Array(r.centroid.buffer, r.centroid.byteOffset, r.dimension ?? 0)] : null,
    dimension: r.dimension,
    isEmerging: r.isEmerging,
    status: r.status,
  }));
}

export interface AngleClusterUpsert {
  inheritedId: number | null;
  topicId: number;
  label: string;
  labelSource: string;
  memberCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  representativeItemIds: number[];
  centroid: number[] | null;
  noveltyScore: number | null;
  isEmerging: boolean;
  runId: number;
  calculatedAt: string;
}

/** 调和写入:继承簇更新(人工命名/来源不动),新簇插入;本次未命中的旧簇 → inactive(历史保留可查)。 */
export async function persistAngleClusters(db: DB, topicId: number, upserts: AngleClusterUpsert[]): Promise<void> {
  const matchedIds = upserts.map((u) => u.inheritedId).filter((x): x is number => x !== null);
  const ts = upserts[0]?.calculatedAt ?? new Date().toISOString();
  db.transaction((tx) => {
    // 1) 先停用本轮未命中的旧簇(必须先于插入,否则会误停刚插入的新簇)
    tx.update(topicAngleClusters)
      .set({ status: "inactive", updatedAt: ts })
      .where(
        matchedIds.length > 0
          ? and(
              eq(topicAngleClusters.topicId, topicId),
              eq(topicAngleClusters.status, "active"),
              notInArray(topicAngleClusters.id, matchedIds),
            )
          : and(eq(topicAngleClusters.topicId, topicId), eq(topicAngleClusters.status, "active")),
      )
      .run();
    // 2) 继承簇更新(人工命名/来源不动)
    for (const u of upserts) {
      if (u.inheritedId !== null) {
        tx.update(topicAngleClusters)
          .set({
            memberCount: u.memberCount,
            lastObservedAt: u.lastObservedAt,
            representativeItemIds: JSON.stringify(u.representativeItemIds),
            centroid: u.centroid ? Buffer.from(new Float32Array(u.centroid).buffer) : null,
            dimension: u.centroid?.length ?? null,
            noveltyScore: u.noveltyScore,
            isEmerging: u.isEmerging ? 1 : 0,
            lastRunId: u.runId,
            updatedAt: ts,
            status: "active",
          })
          .where(eq(topicAngleClusters.id, u.inheritedId))
          .run();
      }
    }
    // 3) 新簇插入
    for (const u of upserts) {
      if (u.inheritedId !== null) continue;
      tx.insert(topicAngleClusters)
        .values({
          topicId: u.topicId,
          label: u.label,
          labelSource: u.labelSource,
          memberCount: u.memberCount,
          firstObservedAt: u.firstObservedAt,
          lastObservedAt: u.lastObservedAt,
          representativeItemIds: JSON.stringify(u.representativeItemIds),
          centroid: u.centroid ? Buffer.from(new Float32Array(u.centroid).buffer) : null,
          dimension: u.centroid?.length ?? null,
          noveltyScore: u.noveltyScore,
          isEmerging: u.isEmerging ? 1 : 0,
          status: "active",
          lastRunId: u.runId,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
  });
}

export interface IntelligenceCurrentRow {
  topicId: number;
  saturationScore: number | null;
  saturatedConfidence: string | null;
  saturationVersion: string | null;
  noveltyScore: number | null;
  emergingAngleCount: number | null;
  noveltyConfidence: string | null;
  noveltyVersion: string | null;
  calculatedAt: string;
  runId: number;
}

export async function upsertIntelligenceCurrent(db: DB, rows: IntelligenceCurrentRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    db.transaction((tx) => {
      tx.insert(topicIntelligenceCurrent)
        .values(batch)
        .onConflictDoUpdate({
          target: topicIntelligenceCurrent.topicId,
          set: {
            saturationScore: sql`excluded.saturation_score`,
            saturatedConfidence: sql`excluded.saturated_confidence`,
            saturationVersion: sql`excluded.saturation_version`,
            noveltyScore: sql`excluded.novelty_score`,
            emergingAngleCount: sql`excluded.emerging_angle_count`,
            noveltyConfidence: sql`excluded.novelty_confidence`,
            noveltyVersion: sql`excluded.novelty_version`,
            calculatedAt: sql`excluded.calculated_at`,
            runId: sql`excluded.run_id`,
          },
        })
        .run();
    });
  }
}

/* ---------------- 查询侧(§74,SQL 分页/排序) ---------------- */

export async function getTopicPatterns(db: DB, topicId: number, limit = 40) {
  const rows = await db
    .select()
    .from(patternResults)
    .where(eq(patternResults.topicId, topicId))
    .orderBy(desc(patternResults.runId), desc(patternResults.id))
    .limit(limit);
  return rows;
}

export async function getTopicSaturationDetail(db: DB, topicId: number) {
  const [latest] = await db
    .select()
    .from(topicSaturationSnapshots)
    .where(eq(topicSaturationSnapshots.topicId, topicId))
    .orderBy(desc(topicSaturationSnapshots.id))
    .limit(1);
  const history = await db
    .select()
    .from(topicSaturationSnapshots)
    .where(eq(topicSaturationSnapshots.topicId, topicId))
    .orderBy(desc(topicSaturationSnapshots.id))
    .limit(50);
  return { current: latest ?? null, history };
}

export async function getTopicNoveltyDetail(db: DB, topicId: number) {
  const [latest] = await db
    .select()
    .from(topicNoveltySnapshots)
    .where(eq(topicNoveltySnapshots.topicId, topicId))
    .orderBy(desc(topicNoveltySnapshots.id))
    .limit(1);
  const history = await db
    .select()
    .from(topicNoveltySnapshots)
    .where(eq(topicNoveltySnapshots.topicId, topicId))
    .orderBy(desc(topicNoveltySnapshots.id))
    .limit(50);
  return { current: latest ?? null, history };
}

export async function getTopicAngles(db: DB, topicId: number) {
  return db
    .select()
    .from(topicAngleClusters)
    .where(and(eq(topicAngleClusters.topicId, topicId), eq(topicAngleClusters.status, "active")))
    .orderBy(desc(topicAngleClusters.isEmerging), desc(topicAngleClusters.noveltyScore), desc(topicAngleClusters.memberCount))
    .limit(30);
}

export async function getContentFeatureRecord(db: DB, contentItemId: number) {
  const rows = await db
    .select()
    .from(contentFeatureRecords)
    .where(eq(contentFeatureRecords.contentItemId, contentItemId))
    .orderBy(desc(contentFeatureRecords.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listIntelligenceRuns(db: DB) {
  return db.select().from(intelligenceRuns).orderBy(desc(intelligenceRuns.id)).limit(20);
}

export async function getLatestIntelligenceRun(db: DB) {
  const rows = await db.select().from(intelligenceRuns).orderBy(desc(intelligenceRuns.id)).limit(1);
  return rows[0] ?? null;
}

export async function activeTopicsWithCounts(db: DB) {
  return db
    .select({ id: topics.id, memberCount: topics.memberCount, firstObservedAt: topics.firstObservedAt })
    .from(topics)
    .where(inArray(topics.status, ["active", "needs_review"]));
}

