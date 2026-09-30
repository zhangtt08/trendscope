/**
 * Duplicate governance (Stage 2 §11-15).
 *
 * Deterministic dedup (platform+id, canonicalUrl) happens in the pipeline.
 * Fuzzy/fingerprint matches ONLY ever become DuplicateCandidates here.
 * A confirmed merge:
 *   - keeps BOTH items (source gets mergedIntoContentItemId — no physical delete)
 *   - keeps ALL raw records untouched
 *   - moves snapshots to the canonical item (history preserved, timeline merged)
 *   - writes a DuplicateMergeRecord (audit; architecture leaves room for undo)
 */
import { asc, desc, eq, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentItems,
  contentMetricSnapshots,
  duplicateCandidates,
  duplicateMergeRecords,
  rawRecords,
} from "../db/schema";
import { syncItemAfterWrite, deleteItemFromIndex } from "./searchIndexService";

export type ResolveAction = "confirm" | "not_duplicate" | "ignore";

export interface CandidateListItem {
  id: number;
  reason: string;
  similarity: number | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  a: ItemBrief;
  b: ItemBrief;
}

export interface ItemBrief {
  id: number;
  platform: string;
  platformContentId: string | null;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  url: string | null;
  text: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  sourceType: string;
  fingerprint: string | null;
  dataQuality: string;
}

export function briefOf(item: typeof contentItems.$inferSelect): ItemBrief {
  return {
    id: item.id,
    platform: item.platform,
    platformContentId: item.platformContentId,
    title: item.title,
    authorName: item.authorName,
    publishedAt: item.publishedAt,
    url: item.url,
    text: item.text?.slice(0, 800) ?? null,
    views: item.views,
    likes: item.likes,
    comments: item.comments,
    sourceType: item.sourceType,
    fingerprint: item.fingerprint,
    dataQuality: item.dataQuality,
  };
}

export async function listCandidates(
  db: DB,
  status: string | null,
  limit = 50,
): Promise<CandidateListItem[]> {
  const rows = await db
    .select()
    .from(duplicateCandidates)
    .where(status ? eq(duplicateCandidates.status, status) : sql`1=1`)
    .orderBy(desc(duplicateCandidates.createdAt))
    .limit(limit);

  const out: CandidateListItem[] = [];
  for (const c of rows) {
    const [a] = await db.select().from(contentItems).where(eq(contentItems.id, c.contentItemA));
    const [b] = await db.select().from(contentItems).where(eq(contentItems.id, c.contentItemB));
    if (!a || !b) continue;
    out.push({
      id: c.id,
      reason: c.reason,
      similarity: c.similarity,
      status: c.status,
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt,
      a: briefOf(a),
      b: briefOf(b),
    });
  }
  return out;
}

export async function getCandidate(db: DB, id: number): Promise<CandidateListItem | null> {
  const [c] = await db.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, id));
  if (!c) return null;
  const [a] = await db.select().from(contentItems).where(eq(contentItems.id, c.contentItemA));
  const [b] = await db.select().from(contentItems).where(eq(contentItems.id, c.contentItemB));
  if (!a || !b) return null;
  return {
    id: c.id,
    reason: c.reason,
    similarity: c.similarity,
    status: c.status,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
    a: briefOf(a),
    b: briefOf(b),
  };
}

export async function pendingCandidateCount(db: DB): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.status, "pending"));
  return row?.n ?? 0;
}

export async function resolveCandidate(
  db: DB,
  candidateId: number,
  action: ResolveAction,
): Promise<{ candidateId: number; action: ResolveAction; mergedSourceId?: number; targetId?: number }> {
  const [candidate] = await db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.id, candidateId))
    .limit(1);
  if (!candidate) throw new Error("疑似重复候选不存在");
  if (candidate.status !== "pending") {
    throw new Error(`该候选已处理过(状态:${candidate.status})`);
  }
  const ts = new Date().toISOString();

  if (action !== "confirm") {
    await db
      .update(duplicateCandidates)
      .set({
        status: action === "not_duplicate" ? "not_duplicate" : "ignored",
        resolvedAt: ts,
      })
      .where(eq(duplicateCandidates.id, candidateId));
    return { candidateId, action };
  }

  // ---- confirmed merge (canonical = A, source = B) ----
  const targetId = candidate.contentItemA;
  const sourceId = candidate.contentItemB;

  const [target] = await db.select().from(contentItems).where(eq(contentItems.id, targetId));
  const [source] = await db.select().from(contentItems).where(eq(contentItems.id, sourceId));
  if (!target || !source) throw new Error("候选对应的内容条目缺失");
  if (target.mergedIntoContentItemId !== null || source.mergedIntoContentItemId !== null) {
    throw new Error("该条目已合并到其他内容,不能重复合并");
  }

  await db.transaction((tx) => {
    // 1. source becomes a pointer (never deleted)
    tx.update(contentItems)
      .set({ mergedIntoContentItemId: targetId, updatedAt: ts })
      .where(eq(contentItems.id, sourceId))
      .run();
    // 2. snapshot history moves to canonical (capturedAt preserved)
    tx.update(contentMetricSnapshots)
      .set({ contentItemId: targetId })
      .where(eq(contentMetricSnapshots.contentItemId, sourceId))
      .run();
    // 3. fill-if-null enrichment of canonical from source
    tx.update(contentItems)
      .set({
        title: sql`COALESCE(${contentItems.title}, ${source.title})`,
        text: sql`COALESCE(${contentItems.text}, ${source.text})`,
        url: sql`COALESCE(${contentItems.url}, ${source.url})`,
        canonicalUrl: sql`COALESCE(${contentItems.canonicalUrl}, ${source.canonicalUrl})`,
        authorId: sql`COALESCE(${contentItems.authorId}, ${source.authorId})`,
        authorName: sql`COALESCE(${contentItems.authorName}, ${source.authorName})`,
        publishedAt: sql`COALESCE(${contentItems.publishedAt}, ${source.publishedAt})`,
        rawPublishedAt: sql`COALESCE(${contentItems.rawPublishedAt}, ${source.rawPublishedAt})`,
        publishedTz: sql`COALESCE(${contentItems.publishedTz}, ${source.publishedTz})`,
        publishedTzAssumption: sql`COALESCE(${contentItems.publishedTzAssumption}, ${source.publishedTzAssumption})`,
        contentType: sql`CASE WHEN ${contentItems.contentType} = 'unknown' THEN ${source.contentType} ELSE ${contentItems.contentType} END`,
        authorFollowers: sql`COALESCE(${contentItems.authorFollowers}, ${source.authorFollowers})`,
        updatedAt: ts,
      })
      .where(eq(contentItems.id, targetId))
      .run();
    // 4. audit record
    tx.insert(duplicateMergeRecords)
      .values({
        sourceContentId: sourceId,
        targetContentId: targetId,
        reason: candidate.reason,
        candidateId: candidate.id,
        resolvedAt: ts,
      })
      .run();
    // 5. candidate resolution
    tx.update(duplicateCandidates)
      .set({ status: "confirmed_duplicate", resolvedAt: ts })
      .where(eq(duplicateCandidates.id, candidateId))
      .run();
  });

  // canonicalUrl conflict guard happened implicitly: COALESCE keeps target's
  // value; if target had none and source's value collides with a third item the
  // unique index would fail → surface as error without partial state (tx rolled back)
  // 合并本身已在事务里提交;这里索引重算失败不能让调用方以为整笔操作失败,
  // 但必须留下痕迹 —— 否则 FTS 会静默留着已合并掉的旧条目。
  await syncItemAfterWrite(db, targetId).catch((e) => {
    console.warn(`[duplicates] 合并后搜索索引重算失败(target=${targetId}):`, e instanceof Error ? e.message : e);
  });
  deleteItemFromIndex(db, sourceId);

  return { candidateId, action, mergedSourceId: sourceId, targetId };
}

/** Items merged INTO the given canonical item (+ their creator raw records). */
export async function getMergedSources(db: DB, targetId: number) {
  const sources = await db
    .select()
    .from(contentItems)
    .where(eq(contentItems.mergedIntoContentItemId, targetId))
    .orderBy(asc(contentItems.id));
  const out: {
    item: typeof contentItems.$inferSelect;
    raw: typeof rawRecords.$inferSelect | null;
  }[] = [];
  for (const s of sources) {
    let raw: typeof rawRecords.$inferSelect | null = null;
    if (s.rawDataId) {
      const [r] = await db.select().from(rawRecords).where(eq(rawRecords.id, s.rawDataId));
      raw = r ?? null;
    }
    out.push({ item: s, raw });
  }
  return out;
}

/** Merge records targeting this item (audit trail). */
export async function getMergeRecordsFor(db: DB, targetId: number) {
  return db
    .select()
    .from(duplicateMergeRecords)
    .where(
      or(
        eq(duplicateMergeRecords.targetContentId, targetId),
        eq(duplicateMergeRecords.sourceContentId, targetId),
      ),
    )
    .orderBy(desc(duplicateMergeRecords.resolvedAt));
}

/** Candidates involving an item (used by Content Detail lineage view). */
export async function candidatesForItem(db: DB, itemId: number) {
  return db
    .select()
    .from(duplicateCandidates)
    .where(
      or(
        eq(duplicateCandidates.contentItemA, itemId),
        eq(duplicateCandidates.contentItemB, itemId),
      ),
    )
    .orderBy(desc(duplicateCandidates.createdAt))
    .limit(20);
}
