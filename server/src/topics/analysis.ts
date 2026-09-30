/**
 * Topic Analysis pipeline (Stage 6B §22-32/§41/§49-51/§65/§69-71) +
 * TopicReconciler (§22-26/§36).
 *
 * 不变式:
 * - 禁止删除重建:Topic 身份经 Reconciler 稳定继承(Jaccard,§23/§24)。
 * - manualLock membership 不得被自动覆盖(§36)。
 * - 计算在内存,持久化用小事务(§71)。
 * - Topic 只属于一个 Embedding Space(§4)。
 * - 全程无任何 Score(§79)。
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentEmbeddings,
  contentItems,
  topicEvolutionEvents,
  topicMemberships,
  topicSnapshots,
  topicAnalysisRuns,
  topics,
  topicWatches,
} from "../db/schema";
import { listSpaceEmbeddings, getSpace, type SpaceRow } from "../semantic/vectorRepository";
import { buildSemanticText } from "../semantic/semanticTextBuilder";
import { SEMANTIC_TEXT_BUILDER_VERSION } from "../semantic/semanticTextBuilder";
import {
  buildEdges,
  connectedComponents,
  validateClusters,
  type VectorEntry,
} from "./clustering";
import { defaultConfigFor, mergeConfig, CLUSTERING_ALGORITHM_VERSION, type TopicClusteringConfig } from "./config";
import { extractKeywords, KeywordFallbackNaming, type TopicNameProvider } from "./keywords";

export interface AnalysisOptions {
  embeddingSpaceId?: string;
  platform?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  autoEmbedMissing?: boolean; // §50 默认 true
  config?: Partial<TopicClusteringConfig>;
  nameProvider?: TopicNameProvider;
}

export interface AnalysisReport {
  topicCount: number;
  averageCohesion: number;
  medianCohesion: number;
  unclusteredRate: number;
  giantClusterCount: number;
  needsReviewCount: number;
}

export interface AnalysisResult {
  runId: number;
  status: "completed" | "partial" | "failed" | "cancelled";
  report: AnalysisReport;
  timings: { neighborMs: number; clusterMs: number; reconcileMs: number; totalMs: number };
}

const keywordNaming = new KeywordFallbackNaming();

async function logEvent(db: DB, e: {
  eventType: string;
  fromTopicIds?: number[];
  toTopicIds?: number[];
  analysisRunId?: number;
  detail?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(topicEvolutionEvents).values({
    eventType: e.eventType,
    fromTopicIds: e.fromTopicIds ? JSON.stringify(e.fromTopicIds) : null,
    toTopicIds: e.toTopicIds ? JSON.stringify(e.toTopicIds) : null,
    analysisRunId: e.analysisRunId ?? null,
    detail: e.detail ?? null,
    createdAt: now,
  });
}

export async function createAnalysisRun(db: DB, space: SpaceRow, opts: AnalysisOptions, cfg: TopicClusteringConfig): Promise<number> {
  const [row] = await db
    .insert(topicAnalysisRuns)
    .values({
      embeddingSpaceId: space.id,
      status: "queued",
      timeRangeStart: opts.timeRangeStart ?? null,
      timeRangeEnd: opts.timeRangeEnd ?? null,
      platformFilter: opts.platform ?? null,
      similarityThreshold: cfg.similarityThreshold,
      neighborLimit: cfg.neighborLimit,
      minClusterSize: cfg.minClusterSize,
      maxClusterSize: cfg.maxClusterSize,
      minCohesion: cfg.minCohesion,
      topicIdentityThreshold: cfg.topicIdentityThreshold,
      clusteringAlgorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      semanticTextVersion: SEMANTIC_TEXT_BUILDER_VERSION,
      provider: space.provider,
      model: space.model,
      dimension: space.dimension,
      qualityMode: space.mode === "api" ? "semantic" : "lexical_baseline",
      createdAt: new Date().toISOString(),
    })
    .returning({ id: topicAnalysisRuns.id });
  return row.id;
}

function isCancelled(db: DB, runId: number): Promise<boolean> {
  return db
    .select({ c: topicAnalysisRuns.cancelRequested })
    .from(topicAnalysisRuns)
    .where(eq(topicAnalysisRuns.id, runId))
    .limit(1)
    .then((r) => r[0]?.c === 1);
}

/** 语义字段的稳定快照(§29:指标变化不参与 → hash 不变 → 不触发 re-embedding) */
function semanticFieldsOf(item: typeof contentItems.$inferSelect) {
  return {
    contentType: item.contentType,
    title: item.title,
    text: item.text,
    transcript: item.transcript,
    hashtags: safeParseArray(item.hashtags),
  };
}

function safeParseArray(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export async function runTopicAnalysis(db: DB, runId: number, opts: AnalysisOptions = {}): Promise<AnalysisResult> {
  const [run] = await db.select().from(topicAnalysisRuns).where(eq(topicAnalysisRuns.id, runId)).limit(1);
  if (!run) throw new Error("分析运行记录不存在");
  const space = await getSpace(db, run.embeddingSpaceId);
  if (!space) {
    await db.update(topicAnalysisRuns).set({ status: "failed", error: "缺少向量空间,无法聚类", completedAt: new Date().toISOString() }).where(eq(topicAnalysisRuns.id, runId));
    throw new Error("embedding space missing");
  }
  const cfg = mergeConfig(defaultConfigFor(space.mode), opts.config);
  const t0 = Date.now();
  await db.update(topicAnalysisRuns).set({ status: "running", startedAt: new Date().toISOString() }).where(eq(topicAnalysisRuns.id, runId));

  try {
    /* ---------- 1) select content(§49) ---------- */
    const conditions = [];
    if (run.platformFilter) conditions.push(eq(contentItems.platform, run.platformFilter));
    if (run.timeRangeStart) conditions.push(sql`${contentItems.createdAt} >= ${run.timeRangeStart}`);
    if (run.timeRangeEnd) conditions.push(sql`${contentItems.createdAt} <= ${run.timeRangeEnd}`);
    const allItems = await db
      .select()
      .from(contentItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(contentItems.id);
    const contentsConsidered = allItems.length;

    /* ---------- 2) embeddings of the space ---------- */
    const allVectors = await listSpaceEmbeddings(db, space.id, space.dimension);
    const vectorByItem = new Map(allVectors.map((v) => [v.contentItemId, v.vector]));

    // §50: auto embed missing —— 只有「可向量化但尚未跑」的内容才报错引导;
    // 空语义文本(无 title/text 等)的条目永远无法向量化 → 直接归入
    // unclustered(§12),不阻塞分析、不静默换空间。
    const missing = allItems.filter((it) => !vectorByItem.has(it.id));
    if (missing.length > 0 && opts.autoEmbedMissing !== false) {
      const embeddable = missing.filter((it) => {
        const st = buildSemanticText(semanticFieldsOf(it));
        return !!st.semanticText;
      });
      if (embeddable.length > 0) {
        await db
          .update(topicAnalysisRuns)
          .set({
            status: "failed",
            error: `${embeddable.length} 条内容在空间 ${space.id} 中缺少向量 — 先运行向量化(语义中心),或选择 Skip Missing`,
            completedAt: new Date().toISOString(),
          })
          .where(eq(topicAnalysisRuns.id, runId));
        return {
          runId,
          status: "failed",
          report: emptyReport(),
          timings: { neighborMs: 0, clusterMs: 0, reconcileMs: 0, totalMs: Date.now() - t0 },
        };
      }
    }

    const entries: VectorEntry[] = [];
    const itemByIndex: typeof allItems = [];
    for (const it of allItems) {
      const v = vectorByItem.get(it.id);
      if (v) {
        entries.push({ contentItemId: it.id, vector: v });
        itemByIndex.push(it);
      }
    }

    /* ---------- 3) neighbor retrieval + graph (§7/§8) ---------- */
    if (await isCancelled(db, runId)) return finishCancelled(db, runId, t0);
    const neighborStart = Date.now();
    const edges = buildEdges(entries, cfg);
    const neighborMs = Date.now() - neighborStart;

    /* ---------- 4) components + validation (§7/§11/§13) ---------- */
    const clusterStart = Date.now();
    const components = connectedComponents(entries.length, edges);
    const { clusters, noiseIndexes } = validateClusters(entries, components, cfg);

    // §13 giant/incohesive → needs_review + 一次二次局部聚类(不无限递归)
    const finalClusters = [];
    let giantCount = 0;
    for (const c of clusters) {
      if (c.verdict === "ok") {
        finalClusters.push(c);
        continue;
      }
      if (c.verdict === "giant" || c.verdict === "incohesive") {
        if (c.verdict === "giant") giantCount += 1;
        // 二次局部聚类:提高阈值 15% 重新对该簇建边
        const subEntries = c.memberIndexes.map((idx) => entries[idx]);
        const subCfg = { ...cfg, similarityThreshold: Math.min(0.98, cfg.similarityThreshold + 0.15) };
        const subEdges = buildEdges(subEntries, subCfg);
        const subComponents = connectedComponents(subEntries.length, subEdges);
        const subValidated = validateClusters(subEntries, subComponents, subCfg);
        let keptAny = false;
        for (const sc of subValidated.clusters) {
          if (sc.verdict === "ok") {
            finalClusters.push({
              memberIndexes: sc.memberIndexes.map((i) => c.memberIndexes[i]),
              cohesion: sc.cohesion,
              representativeIndexes: sc.representativeIndexes.map((i) => c.memberIndexes[i]),
              verdict: "ok",
            });
            keptAny = true;
          } else {
            noiseIndexes.push(...sc.memberIndexes.map((i) => c.memberIndexes[i]));
          }
        }
        if (!keptAny) {
          // 二次仍不可靠 → needs_review 保留原簇(§13)
          finalClusters.push({ ...c, verdict: "incohesive" });
        }
      }
    }
    const clusterMs = Date.now() - clusterStart;

    if (await isCancelled(db, runId)) return finishCancelled(db, runId, t0);

    /* ---------- 5) naming + reconciliation (§17-26/§36) ---------- */
    const reconcileStart = Date.now();
    const allTexts = allItems.map((it) => `${it.title ?? ""} ${it.text ?? ""}`);
    const nameProvider = opts.nameProvider ?? keywordNaming;

    interface PreparedCluster {
      topicId?: number;
      memberIndexes: number[];
      cohesion: number;
      representativeIndexes: number[];
      needsReview: boolean;
      keywords: string[];
      hashtags: string[];
      name: string;
      description: string | null;
      nameConfidence: number | null;
      nameSource: "manual" | "ai" | "keyword";
    }
    const prepared: PreparedCluster[] = [];
    for (const c of finalClusters) {
      const members = c.memberIndexes.map((i) => itemByIndex[i]);
      const memberTexts = members.map((m) => ({
        text: `${m.title ?? ""} ${m.text ?? ""}`,
        hashtags: safeArr(m.hashtags),
      }));
      const kw = extractKeywords(memberTexts, allTexts);
      const nameInput = {
        keywords: kw.keywords,
        hashtags: kw.hashtags,
        representativeTitles: c.representativeIndexes.map((i) => itemByIndex[i].title ?? ""),
      };
      let naming = await nameProvider.generate(nameInput);
      // §70:AI 命名失败(返回 null)必须回退关键词命名,不能让整簇名字塌成占位串
      if (!naming && nameProvider.namingSource === "ai") naming = await keywordNaming.generate(nameInput);
      prepared.push({
        memberIndexes: c.memberIndexes,
        cohesion: c.cohesion,
        representativeIndexes: c.representativeIndexes,
        needsReview: c.verdict !== "ok",
        keywords: kw.keywords,
        hashtags: kw.hashtags,
        name: naming?.name ?? "未命名话题",
        description: naming?.description ?? null,
        nameConfidence: naming?.confidence ?? null,
        nameSource: (naming?.source ?? "keyword") as PreparedCluster["nameSource"],
      });
    }

    // ---------- reconcile(§22-26/§36) ----------
    const spaceTopics = await db
      .select()
      .from(topics)
      .where(and(eq(topics.embeddingSpaceId, space.id), inArray(topics.status, ["active", "needs_review"])));
    const oldMembers = await db.select().from(topicMemberships);
    const membersByTopic = new Map<number, Set<number>>();
    const manualLockByItem = new Map<number, number>(); // itemId → locked topicId
    for (const m of oldMembers) {
      let set = membersByTopic.get(m.topicId);
      if (!set) {
        set = new Set();
        membersByTopic.set(m.topicId, set);
      }
      set.add(m.contentItemId);
      if (m.manualLock === 1) manualLockByItem.set(m.contentItemId, m.topicId);
    }

    const now = new Date().toISOString();
    let topicsCreated = 0;
    let topicsUpdated = 0;
    const assignments: { itemId: number; topicId: number; similarity: number | null; method: string }[] = [];
    const claimedOldTopics = new Map<number, number>(); // oldTopicId → newClusterIdx(§25 split:最大 overlap 者继承)

    for (const pc of prepared) {
      const newSet = new Set(pc.memberIndexes.map((i) => itemByIndex[i].id));
      // 与每个旧 topic 的 Jaccard(§23)
      let best: { topicId: number; jaccard: number } | null = null;
      for (const t of spaceTopics) {
        const old = membersByTopic.get(t.id);
        if (!old) continue;
        let inter = 0;
        for (const id of newSet) if (old.has(id)) inter += 1;
        const union = new Set([...newSet, ...old]).size;
        const jac = union === 0 ? 0 : inter / union;
        if (!best || jac > best.jaccard) best = { topicId: t.id, jaccard: jac };
      }

      let topicId: number;
      if (best && best.jaccard >= cfg.topicIdentityThreshold) {
        // 继承旧 id(§25 split:同旧 topic 只允许一个新 cluster 继承)
        const claimed = claimedOldTopics.get(best.topicId);
        if (claimed === undefined) {
          claimedOldTopics.set(best.topicId, prepared.indexOf(pc));
          topicId = best.topicId;
          topicsUpdated += 1;
        } else {
          // 另一个 cluster 与同一旧 topic 重合 → 新建(§25)
          topicId = await createTopic(db, space.id, pc, runId, now);
          topicsCreated += 1;
          await logEvent(db, {
            eventType: "split",
            fromTopicIds: [best.topicId],
            toTopicIds: [topicId],
            analysisRunId: runId,
            detail: `cluster split: overlap ${(best.jaccard).toFixed(2)} vs inherited by #${claimed}`,
          });
        }
      } else {
        topicId = await createTopic(db, space.id, pc, runId, now);
        topicsCreated += 1;
      }
      pc.topicId = topicId;
      for (const idx of pc.memberIndexes) {
        const itemId = itemByIndex[idx].id;
        assignments.push({ itemId, topicId, similarity: null, method: "automatic" });
      }
    }

    // §36 manual lock:被锁成员保持原 topic(从自动分配中改写)
    for (const a of assignments) {
      const locked = manualLockByItem.get(a.itemId);
      if (locked !== undefined) {
        a.topicId = locked;
        a.method = "manual";
      }
    }

    /* ---------- 6) persistence(小事务,§71)---------- */
    const reconcileMs = Date.now() - reconcileStart;
    await persistMemberships(db, assignments, runId, manualLockByItem);

    // 更新 topic 统计(成员数/cohesion/keywords/representative/first/last seen)
    for (const pc of prepared) {
      const topicId = pc.topicId!;
      const memberIds = pc.memberIndexes.map((i) => itemByIndex[i].id);
      const memberCount = memberIds.length;
      const rep = pc.representativeIndexes.map((i) => itemByIndex[i].id);
      const existing = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
      const first = existing[0]?.firstObservedAt ?? now;
      const status =
        pc.needsReview ? "needs_review" : (existing[0]?.status === "needs_review" ? "active" : (existing[0]?.status ?? "active"));
      // 名字也要跟着统计一起收敛:人工命名(namingSource=manual)永不覆盖(§21);
      // 非人工话题如果现名还是占位串,或关键词发生变化,就用本次命名结果刷新 ——
      // 否则早期那次没接上关键词命名时创建的会永远是「未命名话题」。
      const keepManual = existing[0]?.namingSource === "manual";
      const prevName = existing[0]?.name ?? "";
      const prevKeywords = existing[0]?.keywords ?? "[]";
      const shouldRename = !keepManual && (prevName === "" || prevName === "未命名话题" || prevKeywords !== JSON.stringify(pc.keywords));
      await db
        .update(topics)
        .set({
          ...(shouldRename ? { name: pc.name, namingSource: pc.nameSource, nameConfidence: pc.nameConfidence } : {}),
          description: existing[0]?.namingSource === "manual" ? existing[0].description : pc.description,
          status,
          memberCount,
          representativeItemIds: JSON.stringify(rep),
          keywords: JSON.stringify(pc.keywords),
          hashtags: JSON.stringify(pc.hashtags),
          cohesion: pc.cohesion,
          firstObservedAt: first,
          lastObservedAt: now,
          updatedAt: now,
        })
        .where(eq(topics.id, topicId));
    }

    // 未聚到任何最终 cluster 的内容(包括 noise 与 giant 二次失败成员)
    const assignedItems = new Set(assignments.map((a) => a.itemId));
    const unclusteredCount = allItems.filter((it) => vectorByItem.has(it.id) && !assignedItems.has(it.id)).length;

    // snapshots(§28-32,append-only)
    const prevSnapshots = await db
      .select({ topicId: topicSnapshots.topicId, memberCount: topicSnapshots.memberCount })
      .from(topicSnapshots)
      .orderBy(topicSnapshots.id);
    const prevByTopic = new Map<number, number>();
    for (const ps of prevSnapshots) prevByTopic.set(ps.topicId, ps.memberCount);

    for (const pc of prepared) {
      const topicId = pc.topicId!;
      const memberIds = pc.memberIndexes.map((i) => itemByIndex[i].id);
      const memberCount = memberIds.length;
      const memberRows = await db
        .select({ id: contentItems.id, platform: contentItems.platform, authorId: contentItems.authorId, authorName: contentItems.authorName, likes: contentItems.likes, upvotes: contentItems.upvotes })
        .from(contentItems)
        .where(inArray(contentItems.id, memberIds.length ? memberIds : [-1]));
      const prevCount = prevByTopic.get(topicId) ?? 0;
      const platformDist: Record<string, number> = {};
      const creators = new Set<string>();
      let momentumSum = 0;
      let momentumN = 0;
      for (const m of memberRows) {
        platformDist[m.platform] = (platformDist[m.platform] ?? 0) + 1;
        creators.add(m.authorId ? `id:${m.authorId}` : m.authorName ? `name:${m.authorName}` : `item:${m.id}`);
        const mom = m.upvotes ?? m.likes;
        if (typeof mom === "number") {
          momentumSum += mom;
          momentumN += 1;
        }
      }
      await db.insert(topicSnapshots).values({
        topicId,
        analysisRunId: runId,
        capturedAt: now,
        memberCount,
        newContentCount: Math.max(0, memberCount - prevCount), // §30 明确定义
        activeCreatorCount: creators.size,
        platformCount: Object.keys(platformDist).length,
        averageRawMomentum: momentumN ? momentumSum / momentumN : null,
        rawEngagementDelta: null, // Stage 7 生命周期基线;本阶段只记录事实(§28)
        cohesion: pc.cohesion,
        platformDistribution: JSON.stringify(platformDist),
      });
    }

    // inactive 检测(§26 merge):旧 topic 未被任何 prepared cluster 继承且非 manual → inactive
    const inheritedOld = new Set(claimedOldTopics.keys());
    for (const pc of prepared) {
      const tid = pc.topicId!;
      const old = spaceTopics.find((t) => t.id === tid);
      // 若该新 cluster 是新建但旧 topic 曾高度相关(被 split 拆走)→ 已处理
      void old;
    }
    const usedTopicIds = new Set(prepared.map((pc) => pc.topicId!));
    for (const t of spaceTopics) {
      if (usedTopicIds.has(t.id) || inheritedOld.has(t.id)) continue;
      // 旧 topic 这次没有对应 cluster → inactive(§26,不物理删除)
      await db.update(topics).set({ status: "inactive", updatedAt: now }).where(eq(topics.id, t.id));
      await logEvent(db, { eventType: "inactive", fromTopicIds: [t.id], analysisRunId: runId });
    }

    /* ---------- 7) report (§53) ---------- */
    const cohesions = prepared.map((p) => p.cohesion).sort((a, b) => a - b);
    const report: AnalysisReport = {
      topicCount: prepared.length,
      averageCohesion: cohesions.length ? cohesions.reduce((a, b) => a + b, 0) / cohesions.length : 0,
      medianCohesion: cohesions.length ? cohesions[Math.floor(cohesions.length / 2)] : 0,
      unclusteredRate: contentsConsidered > 0 ? unclusteredCount / contentsConsidered : 0,
      giantClusterCount: giantCount,
      needsReviewCount: prepared.filter((p) => p.needsReview).length,
    };

    const totalMs = Date.now() - t0;
    await db
      .update(topicAnalysisRuns)
      .set({
        status: "completed",
        contentsConsidered,
        contentsEmbedded: entries.length,
        clustersFound: finalClusters.length,
        topicsCreated,
        topicsUpdated,
        unclusteredCount,
        report: JSON.stringify(report),
        completedAt: new Date().toISOString(),
      })
      .where(eq(topicAnalysisRuns.id, runId));

    return {
      runId,
      status: "completed",
      report,
      timings: { neighborMs, clusterMs, reconcileMs, totalMs },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(topicAnalysisRuns)
      .set({ status: "failed", error: msg.slice(0, 500), completedAt: new Date().toISOString() })
      .where(eq(topicAnalysisRuns.id, runId));
    return { runId, status: "failed", report: emptyReport(), timings: { neighborMs: 0, clusterMs: 0, reconcileMs: 0, totalMs: Date.now() - t0 } };
  }
}

function emptyReport(): AnalysisReport {
  return { topicCount: 0, averageCohesion: 0, medianCohesion: 0, unclusteredRate: 0, giantClusterCount: 0, needsReviewCount: 0 };
}

async function finishCancelled(db: DB, runId: number, t0: number): Promise<AnalysisResult> {
  await db
    .update(topicAnalysisRuns)
    .set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(eq(topicAnalysisRuns.id, runId));
  return { runId, status: "cancelled", report: emptyReport(), timings: { neighborMs: 0, clusterMs: 0, reconcileMs: 0, totalMs: Date.now() - t0 } };
}

async function createTopic(
  db: DB,
  spaceId: string,
  pc: { name: string; description: string | null; nameConfidence: number | null; nameSource: "manual" | "ai" | "keyword"; cohesion: number; representativeIndexes: number[] },
  runId: number,
  now: string,
): Promise<number> {
  const [row] = await db
    .insert(topics)
    .values({
      name: pc.name,
      description: pc.description,
      status: "active",
      embeddingSpaceId: spaceId,
      namingSource: pc.nameSource,
      nameConfidence: pc.nameConfidence,
      cohesion: pc.cohesion,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: topics.id });
  await logEvent(db, { eventType: "created", toTopicIds: [row.id], analysisRunId: runId });
  return row.id;
}

/** 小事务式 membership 持久化(§71);manualLock 成员保留锁(§36) */
async function persistMemberships(
  db: DB,
  assignments: { itemId: number; topicId: number; similarity: number | null; method: string }[],
  runId: number,
  manualLockByItem: Map<number, number>,
): Promise<void> {
  const now = new Date().toISOString();
  // 全量重写 primary membership:先清非锁定行,再插入
  await db.delete(topicMemberships).where(eq(topicMemberships.manualLock, 0));
  for (const a of assignments) {
    const locked = manualLockByItem.has(a.itemId);
    if (locked) continue; // 锁定行不动(delete 只删非锁定)
    await db
      .insert(topicMemberships)
      .values({
        topicId: a.topicId,
        contentItemId: a.itemId,
        similarityScore: a.similarity,
        assignmentMethod: a.method,
        confidence: null,
        analysisRunId: runId,
        manualLock: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: topicMemberships.contentItemId,
        set: { topicId: a.topicId, analysisRunId: runId, updatedAt: now, assignmentMethod: a.method },
      });
  }
  // topic.memberCount 重算(含锁定行)
  await db.run(sql`
    update topics set member_count = (
      select count(*) from topic_memberships where topic_memberships.topic_id = topics.id
    ), updated_at = ${now}
  `);
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

void contentEmbeddings;
void isNull;
void topicWatches;
