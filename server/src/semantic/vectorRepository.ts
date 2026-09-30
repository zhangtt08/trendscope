/**
 * VectorRepository (Stage 6A §18/§19) — 业务代码不感知 BLOB 细节。
 * SQLite 存储(Float32 BLOB);未来换专用向量库只动这一个文件。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentEmbeddings, embeddingSpaces } from "../db/schema";
import { deserializeVector, serializeVector, embeddingSpaceId } from "./vectors";
import { SEMANTIC_TEXT_BUILDER_VERSION } from "./semanticTextBuilder";
import type { EmbeddingProvider } from "./provider";

export interface SpaceRow {
  id: string;
  provider: string;
  model: string;
  dimension: number;
  textBuilderVersion: string;
  mode: string;
  isActive: number;
  createdAt: string;
}

/**
 * 建立空间,但对"维度由首个响应决定"的 provider 先发一条探针。
 * 放在这里而不是各调用点:全分析、语义中心、相似内容都走同一条路,
 * 少补一处就会出现"步骤报成功但一条都没向量化"的假象。
 */
export async function ensureSpaceProbed(
  db: DB,
  provider: EmbeddingProvider,
  signal?: AbortSignal,
): Promise<SpaceRow> {
  const declared = provider.metadata.dimension;
  if (declared && declared > 0) return ensureSpace(db, provider, declared);
  const probe = await provider.embedBatch(["维度探针:主流平台热点话题聚合"], signal);
  const sample = probe[0] ?? null;
  const eff = (provider as { effectiveDimension?: (s: number[] | null) => number }).effectiveDimension;
  const resolved = typeof eff === "function" ? eff.call(provider, sample) : (sample?.length ?? 0);
  if (!resolved || resolved <= 0) {
    throw new Error(`provider ${provider.metadata.providerId} 探针未返回有效向量,无法确定维度`);
  }
  return ensureSpace(db, provider, resolved);
}

/** §35: 空间不存在则创建;同时把其它空间 is_active 置 0(单 active 语义) */
export async function ensureSpace(
  db: DB,
  provider: EmbeddingProvider,
  resolvedDimension?: number,
): Promise<SpaceRow> {
  // 外部 provider 常把维度声明为 0(= 由首个真实响应确定,见 openaiProvider.effectiveDimension)。
  // 以前这里只看声明值,于是"探针"根本没机会发生,任务直接失败;现在由调用方把实测维度传进来。
  const dimension = resolvedDimension && resolvedDimension > 0 ? resolvedDimension : provider.metadata.dimension;
  if (!dimension || dimension <= 0) {
    throw new Error(`provider ${provider.metadata.providerId} 无法确定向量维度(声明为 0,且没有实测样本)`);
  }
  const id = embeddingSpaceId(provider.metadata.providerId, provider.metadata.model, dimension, SEMANTIC_TEXT_BUILDER_VERSION);
  const now = new Date().toISOString();
  await db
    .insert(embeddingSpaces)
    .values({
      id,
      provider: provider.metadata.providerId,
      model: provider.metadata.model,
      dimension,
      textBuilderVersion: SEMANTIC_TEXT_BUILDER_VERSION,
      mode: provider.mode,
      isActive: 0,
      createdAt: now,
    })
    .onConflictDoNothing();
  return (await db.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, id)).limit(1))[0];
}

export async function activateSpace(db: DB, spaceId: string): Promise<void> {
  await db.update(embeddingSpaces).set({ isActive: 0 });
  await db.update(embeddingSpaces).set({ isActive: 1 }).where(eq(embeddingSpaces.id, spaceId));
}

export async function listSpaces(db: DB): Promise<SpaceRow[]> {
  return db.select().from(embeddingSpaces).orderBy(sql`created_at`);
}

export async function getSpace(db: DB, spaceId: string): Promise<SpaceRow | undefined> {
  return (await db.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, spaceId)).limit(1))[0];
}

export async function getActiveSpace(db: DB): Promise<SpaceRow | undefined> {
  return (
    await db
      .select()
      .from(embeddingSpaces)
      .where(eq(embeddingSpaces.isActive, 1))
      .orderBy(sql`created_at desc`)
      .limit(1)
  )[0];
}

export interface UpsertEmbeddingInput {
  contentItemId: number;
  space: SpaceRow;
  textHash: string;
  vector: number[];
  now?: string;
}

/**
 * §27/§28: 唯一约束 (item, space, textHash) — 冲突即缓存命中(调用方先查,
 * 这里兜底 onConflictDoNothing)。同 item 旧行(不同 hash)标 superseded。
 */
export async function upsertEmbedding(db: DB, input: UpsertEmbeddingInput): Promise<void> {
  const { contentItemId, space, textHash, vector } = input;
  if (vector.length !== space.dimension) {
    throw new Error(
      `vector dimension mismatch on write: got ${vector.length}, space ${space.id} declares ${space.dimension}`,
    );
  }
  const now = input.now ?? new Date().toISOString();
  const blob = serializeVector(vector);

  // 旧行(不同 hash,未 superseded)→ superseded(§28 保留历史)
  await db
    .update(contentEmbeddings)
    .set({ supersededAt: now })
    .where(
      and(
        eq(contentEmbeddings.contentItemId, contentItemId),
        eq(contentEmbeddings.embeddingSpaceId, space.id),
        isNull(contentEmbeddings.supersededAt),
      ),
    );

  // 同 (内容, 空间, hash) 的行可能已经存在但被标了 superseded —— 唯一索引不含 superseded_at。
  // 以前这里是 onConflictDoNothing:上一句刚把该行标废,这一句的插入就被静默丢弃,
  // 于是这条内容"永远没有活跃向量"(向量化每轮重嵌、每轮白烧,聚类每轮失败)。
  // 同一个 hash 就是同一份语义文本,原向量仍然有效 —— 复活它,不重写。
  await db
    .insert(contentEmbeddings)
    .values({
      contentItemId,
      embeddingSpaceId: space.id,
      provider: space.provider,
      model: space.model,
      dimension: space.dimension,
      textHash,
      vector: blob,
      textBuilderVersion: space.textBuilderVersion,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [contentEmbeddings.contentItemId, contentEmbeddings.embeddingSpaceId, contentEmbeddings.textHash],
      set: { supersededAt: null, vector: blob, textBuilderVersion: space.textBuilderVersion, updatedAt: now },
    });
}

export async function markSuperseded(db: DB, contentItemId: number, spaceId: string, keepHash?: string): Promise<void> {
  const rows = await db
    .select({ id: contentEmbeddings.id, textHash: contentEmbeddings.textHash })
    .from(contentEmbeddings)
    .where(and(eq(contentEmbeddings.contentItemId, contentItemId), eq(contentEmbeddings.embeddingSpaceId, spaceId), isNull(contentEmbeddings.supersededAt)));
  const now = new Date().toISOString();
  for (const r of rows) {
    if (keepHash && r.textHash === keepHash) continue;
    await db.update(contentEmbeddings).set({ supersededAt: now }).where(eq(contentEmbeddings.id, r.id));
  }
}

export interface StoredEmbedding {
  contentItemId: number;
  textHash: string;
  vector: number[];
}

/** 某空间内某 item 的当前(未 superseded)向量 */
export async function getEmbedding(db: DB, spaceId: string, contentItemId: number): Promise<StoredEmbedding | undefined> {
  const [row] = await db
    .select()
    .from(contentEmbeddings)
    .where(
      and(
        eq(contentEmbeddings.embeddingSpaceId, spaceId),
        eq(contentEmbeddings.contentItemId, contentItemId),
        isNull(contentEmbeddings.supersededAt),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  return {
    contentItemId: row.contentItemId,
    textHash: row.textHash,
    vector: deserializeVector(row.vector, row.dimension),
  };
}

/** §40/§41: 批量读整个空间的活跃向量(一次查询;5000 条 brute-force 实测足够快) */
export async function listSpaceEmbeddings(db: DB, spaceId: string, dimension: number): Promise<StoredEmbedding[]> {
  const rows = await db
    .select({
      contentItemId: contentEmbeddings.contentItemId,
      textHash: contentEmbeddings.textHash,
      vector: contentEmbeddings.vector,
    })
    .from(contentEmbeddings)
    .where(and(eq(contentEmbeddings.embeddingSpaceId, spaceId), isNull(contentEmbeddings.supersededAt)));
  return rows.map((r) => ({
    contentItemId: r.contentItemId,
    textHash: r.textHash,
    vector: deserializeVector(r.vector, dimension),
  }));
}

/** 该空间已入库(有活跃向量)的 contentItemId 集合(§38 missing scope 用) */
export async function embeddedItemIds(db: DB, spaceId: string): Promise<Set<number>> {
  const rows = await db
    .select({ contentItemId: contentEmbeddings.contentItemId })
    .from(contentEmbeddings)
    .where(and(eq(contentEmbeddings.embeddingSpaceId, spaceId), isNull(contentEmbeddings.supersededAt)));
  return new Set(rows.map((r) => r.contentItemId));
}

export async function countEmbeddings(db: DB, spaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(contentEmbeddings)
    .where(and(eq(contentEmbeddings.embeddingSpaceId, spaceId), isNull(contentEmbeddings.supersededAt)));
  return Number(row?.n ?? 0);
}
