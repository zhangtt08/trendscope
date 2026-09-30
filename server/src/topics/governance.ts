/**
 * Topic governance service (Stage 6B §33-37/§66/§69/§72): manual merge/split/
 * move/rename/watch + queries (explorer/detail/unclustered).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client";
import {
  contentItems,
  topicEvolutionEvents,
  topicMemberships,
  topicSnapshots,
  topicAnalysisRuns,
  topics,
  topicWatches,
} from "../db/schema";

const now = () => new Date().toISOString();

async function logEvolution(db: DB, e: { eventType: string; fromTopicIds?: number[]; toTopicIds?: number[]; detail?: string }): Promise<void> {
  await db.insert(topicEvolutionEvents).values({
    eventType: e.eventType,
    fromTopicIds: e.fromTopicIds ? JSON.stringify(e.fromTopicIds) : null,
    toTopicIds: e.toTopicIds ? JSON.stringify(e.toTopicIds) : null,
    detail: e.detail ?? null,
    createdAt: now(),
  });
}

/* ---------------- manual rename (§21/§72) ---------------- */

export async function renameTopic(db: DB, topicId: number, name: string, description?: string): Promise<void> {
  const t = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!t[0]) throw new Error("topic not found");
  await db
    .update(topics)
    .set({
      name: name.trim().slice(0, 64),
      ...(description !== undefined ? { description: description.slice(0, 300) } : {}),
      namingSource: "manual", // §21 manual 永远最高优先级,自动 Analysis 不得覆盖
      nameConfidence: 1,
      updatedAt: now(),
    })
    .where(eq(topics.id, topicId));
  await logEvolution(db, { eventType: "renamed", fromTopicIds: [topicId], detail: `manual rename → ${name}` });
}

/* ---------------- manual merge (§33/§72) ---------------- */

export const MergeSchema = z.object({
  canonicalTopicId: z.number().int().positive(),
  mergedTopicId: z.number().int().positive(),
});

export async function mergeTopics(db: DB, canonicalTopicId: number, mergedTopicId: number): Promise<void> {
  if (canonicalTopicId === mergedTopicId) throw new Error("不能合并同一个话题");
  const [canon] = await db.select().from(topics).where(eq(topics.id, canonicalTopicId)).limit(1);
  const [merged] = await db.select().from(topics).where(eq(topics.id, mergedTopicId)).limit(1);
  if (!canon || !merged) throw new Error("topic not found");
  if (canon.embeddingSpaceId !== merged.embeddingSpaceId) throw new Error("跨 Embedding Space 禁止合并(§4)");

  // 成员转移到 canonical(assignment=merge);被合并者不物理删除
  await db
    .update(topicMemberships)
    .set({ topicId: canonicalTopicId, assignmentMethod: "merge", updatedAt: now() })
    .where(eq(topicMemberships.topicId, mergedTopicId));
  await db
    .update(topics)
    .set({ status: "inactive", mergedIntoTopicId: canonicalTopicId, updatedAt: now() })
    .where(eq(topics.id, mergedTopicId));
  await recount(db, canonicalTopicId);
  await logEvolution(db, {
    eventType: "manual_merge",
    fromTopicIds: [mergedTopicId],
    toTopicIds: [canonicalTopicId],
    detail: `manual merge: ${merged.name} → ${canon.name}`,
  });
}

/* ---------------- manual move / remove (§34/§72) ---------------- */

export const MoveSchema = z.object({
  contentItemId: z.number().int().positive(),
  toTopicId: z.number().int().positive().nullable(), // null = remove from topic
});

export async function moveContent(db: DB, contentItemId: number, toTopicId: number | null): Promise<void> {
  // topic_memberships 没有指向 content_items 的外键,不校验就会写入孤儿行并虚增 member_count
  const [item] = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.id, contentItemId)).limit(1);
  if (!item) throw new Error("content item not found");
  if (toTopicId === null) {
    await db.delete(topicMemberships).where(eq(topicMemberships.contentItemId, contentItemId));
    await logEvolution(db, { eventType: "manual_split", fromTopicIds: [], detail: `remove item ${contentItemId} from topic` });
    await recountAll(db);
    return;
  }
  const [topic] = await db.select().from(topics).where(eq(topics.id, toTopicId)).limit(1);
  if (!topic) throw new Error("目标话题不存在");
  await db
    .insert(topicMemberships)
    .values({
      topicId: toTopicId,
      contentItemId,
      assignmentMethod: "move",
      manualLock: 1, // §36 人工指派保护
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: topicMemberships.contentItemId,
      set: { topicId: toTopicId, assignmentMethod: "move", manualLock: 1, updatedAt: now() },
    });
  await recountAll(db);
  await logEvolution(db, { eventType: "manual_split", fromTopicIds: [], toTopicIds: [toTopicId], detail: `move item ${contentItemId} → topic ${toTopicId}` });
}

/* ---------------- manual split (§35/§72) ---------------- */

export const SplitSchema = z.object({
  sourceTopicId: z.number().int().positive(),
  contentItemIds: z.array(z.number().int().positive()).min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(300).optional(),
});

export async function splitTopic(db: DB, input: z.infer<typeof SplitSchema>): Promise<{ newTopicId: number }> {
  const [source] = await db.select().from(topics).where(eq(topics.id, input.sourceTopicId)).limit(1);
  if (!source) throw new Error("来源话题不存在");
  const ts = now();
  const [newTopic] = await db
    .insert(topics)
    .values({
      name: input.name.trim(),
      description: input.description ?? `从「${source.name}」手动拆分`,
      status: "active",
      embeddingSpaceId: source.embeddingSpaceId,
      namingSource: "manual",
      nameConfidence: 1,
      firstObservedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: topics.id });
  await db
    .update(topicMemberships)
    .set({ topicId: newTopic.id, assignmentMethod: "split", manualLock: 1, updatedAt: ts })
    .where(and(eq(topicMemberships.topicId, input.sourceTopicId), inArray(topicMemberships.contentItemId, input.contentItemIds)));
  await recount(db, input.sourceTopicId);
  await recount(db, newTopic.id);
  await logEvolution(db, {
    eventType: "manual_split",
    fromTopicIds: [input.sourceTopicId],
    toTopicIds: [newTopic.id],
    detail: `manual split: ${input.contentItemIds.length} items → ${input.name}`,
  });
  return { newTopicId: newTopic.id };
}

async function recount(db: DB, topicId: number): Promise<void> {
  await db
    .update(topics)
    .set({
      memberCount: (
        await db.select({ n: sql<number>`count(*)` }).from(topicMemberships).where(eq(topicMemberships.topicId, topicId))
      )[0].n,
      updatedAt: now(),
    })
    .where(eq(topics.id, topicId));
}

async function recountAll(db: DB): Promise<void> {
  await db.run(sql`
    update topics set member_count = (
      select count(*) from topic_memberships where topic_memberships.topic_id = topics.id
    ), updated_at = ${now()}
  `);
}

/* ---------------- watch (§37/§45) ---------------- */

// "none" = 取消关注。原先只允许三个正向状态,一旦标过就再也撤不掉。
export const WatchSchema = z.object({ state: z.enum(["watching", "review", "ignored", "none"]) });

export async function setWatch(
  db: DB,
  topicId: number,
  state: "watching" | "review" | "ignored" | "none",
): Promise<void> {
  if (state === "none") {
    await db.delete(topicWatches).where(eq(topicWatches.topicId, topicId));
    return;
  }
  await db
    .insert(topicWatches)
    .values({ topicId, state, updatedAt: now() })
    .onConflictDoUpdate({ target: topicWatches.topicId, set: { state, updatedAt: now() } });
}

/* ---------------- queries (§38-42/§66/§69) ---------------- */

export async function listTopics(
  db: DB,
  q: { search?: string; platform?: string; status?: string; watch?: string; minMembers?: number },
): Promise<unknown[]> {
  const conds = [];
  if (q.status) conds.push(eq(topics.status, q.status));
  else conds.push(inArray(topics.status, ["active", "needs_review"]));
  if (q.minMembers) conds.push(sql`${topics.memberCount} >= ${q.minMembers}`);
  if (q.search) conds.push(sql`(${topics.name} LIKE ${"%" + q.search + "%"} OR ${topics.description} LIKE ${"%" + q.search + "%"} OR ${topics.keywords} LIKE ${"%" + q.search + "%"})`);
  const rows = await db
    .select()
    .from(topics)
    .where(and(...conds))
    .orderBy(desc(topics.memberCount));
  const watches = await db.select().from(topicWatches);
  const watchMap = new Map(watches.map((w) => [w.topicId, w.state]));
  let out = rows.map((t) => ({
    ...t,
    keywords: safeArr(t.keywords),
    hashtags: safeArr(t.hashtags),
    representativeItemIds: safeNumArr(t.representativeItemIds),
    watchState: watchMap.get(t.id) ?? null,
  }));
  if (q.watch) out = out.filter((t) => t.watchState === q.watch);
  if (q.platform) {
    // platform filter via snapshots(§32 platform distribution)
    const snaps = await db.select().from(topicSnapshots);
    const dist = new Map<number, Record<string, number>>();
    for (const sn of snaps) {
      try {
        dist.set(sn.topicId, JSON.parse(sn.platformDistribution ?? "{}"));
      } catch { /* ignore */ }
    }
    out = out.filter((t) => (dist.get(t.id)?.[q.platform!] ?? 0) > 0);
  }
  return out;
}

export async function topicDetail(db: DB, topicId: number): Promise<unknown> {
  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return null;
  const members = await db
    .select({
      membershipId: topicMemberships.id,
      contentItemId: topicMemberships.contentItemId,
      similarityScore: topicMemberships.similarityScore,
      assignmentMethod: topicMemberships.assignmentMethod,
      manualLock: topicMemberships.manualLock,
      createdAt: topicMemberships.createdAt,
      title: contentItems.title,
      platform: contentItems.platform,
      contentType: contentItems.contentType,
      publishedAt: contentItems.publishedAt,
      likes: contentItems.likes,
      upvotes: contentItems.upvotes,
    })
    .from(topicMemberships)
    .innerJoin(contentItems, eq(contentItems.id, topicMemberships.contentItemId))
    .where(eq(topicMemberships.topicId, topicId))
    .orderBy(desc(topicMemberships.similarityScore));
  const snapshots = await db
    .select()
    .from(topicSnapshots)
    .where(eq(topicSnapshots.topicId, topicId))
    .orderBy(topicSnapshots.capturedAt);
  const evolution = await db.select().from(topicEvolutionEvents).orderBy(desc(topicEvolutionEvents.id)).limit(50);
  const runs = await db.select().from(topicAnalysisRuns).orderBy(desc(topicAnalysisRuns.id)).limit(5);
  const [watch] = await db.select().from(topicWatches).where(eq(topicWatches.topicId, topicId)).limit(1);
  return {
    ...topic,
    keywords: safeArr(topic.keywords),
    hashtags: safeArr(topic.hashtags),
    representativeItemIds: safeNumArr(topic.representativeItemIds),
    members,
    snapshots,
    evolution,
    recentRuns: runs,
    watchState: watch?.state ?? null,
  };
}

export async function listUnclustered(db: DB, limit = 100): Promise<unknown[]> {
  // 有向量但无 membership 的内容(§12:正式概念,不是 error)
  return db
    .select({ id: contentItems.id, title: contentItems.title, platform: contentItems.platform, contentType: contentItems.contentType })
    .from(contentItems)
    .where(
      sql`${contentItems.id} NOT IN (select content_item_id from topic_memberships)`,
    )
    .limit(limit);
}

/** 返回 false = 该 run 不存在(否则取消会静默"成功")。 */
export async function requestCancel(db: DB, runId: number): Promise<boolean> {
  const res = await db
    .update(topicAnalysisRuns)
    .set({ cancelRequested: 1 })
    .where(eq(topicAnalysisRuns.id, runId));
  return (res as unknown as { changes?: number }).changes !== 0;
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function safeNumArr(s: string | null): number[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(Number) : [];
  } catch {
    return [];
  }
}
