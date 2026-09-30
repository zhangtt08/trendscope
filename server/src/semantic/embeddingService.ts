/**
 * Embedding service (Stage 6A §21/§25-32/§40/§41): job runner + similar content.
 *
 * - Job:scope(missing|all)→ 逐条 SemanticText → textHash 缓存判断(§27)→
 *   provider.embedBatch(§26)→ VectorRepository。单条失败不崩 job(§30);
 *   partial 状态;cancel_requested 在条目边界检查(§25 状态机含 cancelled)。
 * - Cache:contentItemId + embeddingSpace + textHash 均未变 → skip(§8/§27)。
 * - Metric 变化(likes/…)不影响 semanticText → hash 不变 → 不重算(§29)。
 * - Similar:批量读空间活跃向量 + brute-force cosine(§41:5000 条实测足够,
 *   benchmark 记录于 DECISIONS;不重复解析,单次查询)。
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentEmbeddings, contentItems, embeddingJobs } from "../db/schema";
import { buildSemanticText } from "./semanticTextBuilder";
import { cosineSimilarity } from "./vectors";
import {
  ensureSpaceProbed,
  getSpace,
  getActiveSpace,
  getEmbedding,
  listSpaceEmbeddings,
  embeddedItemIds,
  upsertEmbedding,
  type SpaceRow,
} from "./vectorRepository";
import type { EmbeddingProvider } from "./provider";

/* ------------------------------------------------------------------ */
/* job runner                                                          */
/* ------------------------------------------------------------------ */

export type EmbeddingJobScope = "missing" | "all";

export async function createEmbeddingJob(db: DB, spaceId: string, scope: EmbeddingJobScope): Promise<number> {
  const space = await getSpace(db, spaceId);
  if (!space) throw new Error(`embedding space 不存在: ${spaceId}`);
  const [row] = await db
    .insert(embeddingJobs)
    .values({ embeddingSpaceId: spaceId, scope, status: "queued", createdAt: new Date().toISOString() })
    .returning({ id: embeddingJobs.id });
  return row.id;
}

export async function requestJobCancel(db: DB, jobId: number): Promise<boolean> {
  const [job] = await db.select().from(embeddingJobs).where(eq(embeddingJobs.id, jobId)).limit(1);
  if (!job) throw new Error("向量化任务不存在");
  if (["completed", "failed", "cancelled"].includes(job.status)) return false;
  if (job.status === "queued") {
    await db
      .update(embeddingJobs)
      .set({ status: "cancelled", completedAt: new Date().toISOString() })
      .where(eq(embeddingJobs.id, jobId));
    return true;
  }
  await db.update(embeddingJobs).set({ cancelRequested: 1 }).where(eq(embeddingJobs.id, jobId));
  return true;
}

async function isCancelRequested(db: DB, jobId: number): Promise<boolean> {
  const [job] = await db
    .select({ cancelRequested: embeddingJobs.cancelRequested })
    .from(embeddingJobs)
    .where(eq(embeddingJobs.id, jobId))
    .limit(1);
  return job?.cancelRequested === 1;
}

/** 语义字段的稳定快照(§29:指标不参与) */
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

export interface RunJobResult {
  status: "completed" | "partial" | "failed" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function runEmbeddingJob(
  db: DB,
  jobId: number,
  provider: EmbeddingProvider,
  opts: { signal?: AbortSignal } = {},
): Promise<RunJobResult> {
  const [job] = await db.select().from(embeddingJobs).where(eq(embeddingJobs.id, jobId)).limit(1);
  if (!job) throw new Error("向量化任务不存在");
  if (job.status !== "queued") throw new Error(`任务 ${jobId} 当前状态为 ${job.status},只有排队中的任务才能开始`);

  // 探测失败也必须留下终态。这一行以前直接让异常飞出去:任务永远停在 queued,
  // 而 fullRefresh 判"是否忙"读的是 status in (queued, running) —— 一条死行就能让
  // 自动向量化永久停摆,连向量服务恢复之后也不会自己缓过来(D60 同一类,换了个门进来)。
  const space = await ensureSpaceProbed(db, provider, opts.signal).catch(async (e: unknown) => {
    await db
      .update(embeddingJobs)
      .set({
        status: "failed",
        error: `向量服务探测失败:${e instanceof Error ? e.message : String(e)}`,
        completedAt: new Date().toISOString(),
      })
      .where(eq(embeddingJobs.id, jobId));
    throw e;
  });
  if (space.id !== job.embeddingSpaceId) {
    // job 绑定空间与 provider 推导空间不一致 → 明确失败(防串空间)
    await db
      .update(embeddingJobs)
      .set({ status: "failed", error: "任务与当前向量空间不一致", completedAt: new Date().toISOString() })
      .where(eq(embeddingJobs.id, jobId));
    return { status: "failed", total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const startedAt = new Date().toISOString();
  await db.update(embeddingJobs).set({ status: "running", startedAt }).where(eq(embeddingJobs.id, jobId));

  try {
    // 1) 候选集合
    const items = await db.select().from(contentItems).orderBy(contentItems.id);
    const done = job.scope === "missing" ? await embeddedItemIds(db, space.id) : new Set<number>();
    const candidates = items.filter((it) => !done.has(it.id));

    // 2) 逐条构建 semanticText + 先按 hash 分组(skip 判定在向量层面)
    const prepared: { item: typeof contentItems.$inferSelect; semanticText: string; textHash: string }[] = [];
    let skipped = 0;
    for (const it of candidates) {
      if (opts.signal?.aborted || (await isCancelRequested(db, jobId))) break;
      const st = buildSemanticText(semanticFieldsOf(it));
      if (!st.semanticText || !st.textHash) {
        skipped += 1; // 空语义文本(无 title/text 等)→ 无可嵌入
        continue;
      }
      // §27: 同 hash 已有活跃向量 → skip
      const existing = await db
        .select({ id: contentEmbeddings.id })
        .from(contentEmbeddings)
        .where(
          and(
            eq(contentEmbeddings.contentItemId, it.id),
            eq(contentEmbeddings.embeddingSpaceId, space.id),
            eq(contentEmbeddings.textHash, st.textHash),
            isNull(contentEmbeddings.supersededAt),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }
      prepared.push({ item: it, semanticText: st.semanticText, textHash: st.textHash });
    }

    // 3) batch embed(§26/§30)
    let succeeded = 0;
    let failed = 0;
    const failedItemIds: number[] = [];
    let processed = 0;
    const total = prepared.length;
    const batchSize = Math.max(1, provider.batchSize);

    for (let i = 0; i < prepared.length; i += batchSize) {
      if (opts.signal?.aborted || (await isCancelRequested(db, jobId))) break;
      const slice = prepared.slice(i, i + batchSize);
      try {
        const vectors = await provider.embedBatch(
          slice.map((p) => p.semanticText),
          opts.signal,
        );
        for (let j = 0; j < slice.length; j++) {
          const vec = vectors[j];
          if (!Array.isArray(vec) || vec.length !== space.dimension) {
            failed += 1;
            failedItemIds.push(slice[j].item.id);
            continue; // 单条维度问题不崩 job(§30)
          }
          await upsertEmbedding(db, {
            contentItemId: slice[j].item.id,
            space,
            textHash: slice[j].textHash,
            vector: vec,
          });
          succeeded += 1;
        }
      } catch (e) {
        // batch 级失败:记录该批所有条目,继续下一批(§30 partial)
        const msg = e instanceof Error ? e.message : String(e);
        for (const p of slice) {
          failed += 1;
          failedItemIds.push(p.item.id);
        }
        await db
          .update(embeddingJobs)
          .set({ error: `batch failed at offset ${i}: ${msg}`.slice(0, 500) })
          .where(eq(embeddingJobs.id, jobId));
      }
      processed += slice.length;
      await db
        .update(embeddingJobs)
        .set({ total, processed, succeeded, failed, skipped })
        .where(eq(embeddingJobs.id, jobId));
    }

    const cancelled = opts.signal?.aborted || (await isCancelRequested(db, jobId));
    const status: RunJobResult["status"] = cancelled
      ? "cancelled"
      : failed === 0
        ? "completed"
        : succeeded > 0
          ? "partial"
          : "failed";
    await db
      .update(embeddingJobs)
      .set({
        total,
        processed,
        succeeded,
        failed,
        skipped,
        status,
        completedAt: new Date().toISOString(),
        failedItemIds: failedItemIds.length ? JSON.stringify(failedItemIds.slice(0, 200)) : null,
      })
      .where(eq(embeddingJobs.id, jobId));
    return { status, total, processed, succeeded, failed, skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(embeddingJobs)
      .set({ status: "failed", error: msg.slice(0, 500), completedAt: new Date().toISOString() })
      .where(eq(embeddingJobs.id, jobId));
    return { status: "failed", total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* similar content (§21/§22/§40/§41)                                   */
/* ------------------------------------------------------------------ */

export interface SimilarContentOptions {
  embeddingSpaceId?: string;
  topK?: number;
  minSimilarity?: number;
  platform?: string;
  excludeSelf?: boolean;
}

export interface SimilarContentHit {
  contentItemId: number;
  title: string | null;
  platform: string;
  contentType: string;
  publishedAt: string | null;
  similarity: number;
}

export interface SimilarContentResult {
  embeddingSpace: { id: string; provider: string; model: string; mode: string; dimension: number } | null;
  mode: "lexical" | "api";
  hits: SimilarContentHit[];
  candidateCount: number;
  elapsedMs: number;
}

/**
 * 邻居搜索(§22:不创建 Topic)。空间内目标向量 vs 全部活跃向量 brute-force;
 * platform 过滤在打分前做(候选缩减);excludeSelf 默认 true(§21)。
 */
export async function findSimilarContent(
  db: DB,
  contentItemId: number,
  options: SimilarContentOptions = {},
): Promise<SimilarContentResult> {
  const started = Date.now();
  const topK = Math.max(1, Math.min(50, Math.trunc(options.topK ?? 10)));
  const minSimilarity = Math.max(0, Math.min(1, options.minSimilarity ?? 0));
  const excludeSelf = options.excludeSelf !== false;

  const space = options.embeddingSpaceId ? await getSpace(db, options.embeddingSpaceId) : await getActiveSpace(db);
  if (!space) {
    return { embeddingSpace: null, mode: "lexical", hits: [], candidateCount: 0, elapsedMs: Date.now() - started };
  }

  const target = await getEmbedding(db, space.id, contentItemId);
  if (!target) {
    return {
      embeddingSpace: spaceView(space),
      mode: space.mode === "api" ? "api" : "lexical",
      hits: [],
      candidateCount: 0,
      elapsedMs: Date.now() - started,
    };
  }

  const pool = await listSpaceEmbeddings(db, space.id, space.dimension);
  const meta = await db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      platform: contentItems.platform,
      contentType: contentItems.contentType,
      publishedAt: contentItems.publishedAt,
    })
    .from(contentItems);
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const scored: SimilarContentHit[] = [];
  for (const cand of pool) {
    if (excludeSelf && cand.contentItemId === contentItemId) continue;
    const m = metaById.get(cand.contentItemId);
    if (!m) continue;
    if (options.platform && m.platform !== options.platform) continue; // §41 candidate reduction
    const sim = cosineSimilarity(target.vector, cand.vector);
    if (sim >= minSimilarity) {
      scored.push({
        contentItemId: m.id,
        title: m.title,
        platform: m.platform,
        contentType: m.contentType,
        publishedAt: m.publishedAt,
        similarity: sim,
      });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);

  return {
    embeddingSpace: spaceView(space),
    mode: space.mode === "api" ? "api" : "lexical",
    hits: scored.slice(0, topK),
    candidateCount: pool.length,
    elapsedMs: Date.now() - started,
  };
}

function spaceView(space: SpaceRow) {
  return {
    id: space.id,
    provider: space.provider,
    model: space.model,
    mode: space.mode,
    dimension: space.dimension,
  };
}

/* ------------------------------------------------------------------ */
/* provenance / preview (§45/§46)                                      */
/* ------------------------------------------------------------------ */

export interface EmbeddingStatus {
  space: ReturnType<typeof spaceView> | null;
  embeddings: {
    textHash: string;
    superseded: boolean;
    createdAt: string;
    dimension: number;
    provider: string;
    model: string;
  }[];
  semanticText: {
    semanticText: string;
    textHash: string;
    textBuilderVersion: string;
    wasTruncated: boolean;
  } | null;
}

export async function getEmbeddingStatus(db: DB, contentItemId: number, spaceId?: string): Promise<EmbeddingStatus> {
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId)).limit(1);
  const space = spaceId ? await getSpace(db, spaceId) : await getActiveSpace(db);
  let semanticText: EmbeddingStatus["semanticText"] = null;
  if (item) {
    const st = buildSemanticText(semanticFieldsOf(item));
    semanticText = st.semanticText
      ? { semanticText: st.semanticText, textHash: st.textHash, textBuilderVersion: st.textBuilderVersion, wasTruncated: st.wasTruncated }
      : null;
  }
  const rows = space
    ? await db
        .select()
        .from(contentEmbeddings)
        .where(and(eq(contentEmbeddings.contentItemId, contentItemId), eq(contentEmbeddings.embeddingSpaceId, space.id)))
        .orderBy(contentEmbeddings.createdAt)
    : [];
  return {
    space: space ? spaceView(space) : null,
    embeddings: rows.map((r) => ({
      textHash: r.textHash,
      superseded: r.supersededAt !== null,
      createdAt: r.createdAt,
      dimension: r.dimension,
      provider: r.provider,
      model: r.model,
    })),
    semanticText,
  };
}
