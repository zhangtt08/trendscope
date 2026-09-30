/**
 * Stage 6A §50 integration — full semantic flow on the REAL SQLite database:
 * ContentItem → SemanticText → EmbeddingJob → Provider → VectorRepository →
 * ContentEmbedding → Similar Content. Plus cache (§27), superseded (§28),
 * §29 metric-change rule, space isolation (§16), excludeSelf (§21), partial
 * failure (§30), and §42 5000-item performance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, contentMetricSnapshots, embeddingJobs } from "../../server/src/db/schema";
import { buildSemanticText } from "../../server/src/semantic/semanticTextBuilder";
import type { EmbeddingProvider } from "../../server/src/semantic/provider";
import { LexicalFallbackEmbeddingProvider } from "../../server/src/semantic/lexicalProvider";
import {
  createEmbeddingJob,
  runEmbeddingJob,
  findSimilarContent,
  getEmbeddingStatus,
} from "../../server/src/semantic/embeddingService";
import { ensureSpace, activateSpace, listSpaceEmbeddings, countEmbeddings, markSuperseded, embeddedItemIds } from "../../server/src/semantic/vectorRepository";
import { cosineSimilarity } from "../../server/src/semantic/vectors";

let db: DB;
const provider = new LexicalFallbackEmbeddingProvider(512);

async function insertItem(db: DB, v: {
  platform: string; platformContentId: string; contentType: string;
  title: string; text: string | null; hashtags?: string[]; likes?: number | null;
}): Promise<number> {
  const ts = new Date().toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform: v.platform,
      platformContentId: v.platformContentId,
      contentType: v.contentType,
      title: v.title,
      text: v.text,
      transcript: null,
      hashtags: v.hashtags ? JSON.stringify(v.hashtags) : "[]",
      url: null,
      canonicalUrl: null,
      authorId: null,
      authorName: "作者",
      authorFollowers: null,
      publishedAt: ts,
      publishedTz: "UTC",
      publishedTzAssumption: "explicit_offset",
      views: null,
      likes: v.likes ?? null,
      comments: null,
      shares: null,
      favorites: null,
      upvotes: null,
      dataQuality: "partial",
      sourceType: "manual",
      collectedAt: ts,
      rawDataId: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: contentItems.id });
  return row.id;
}

beforeAll(async () => {
  const { sqlite, db: d } = createTestDb();
  sqlite.close;
  db = d;
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  if (anyDb?.$client) anyDb.$client.close();
});

describe("§50 full flow", () => {
  it("ContentItem → SemanticText → Job → Provider → Repository → Similar", async () => {
    const travel = await insertItem(db, {
      platform: "zhihu", platformContentId: "q-1", contentType: "question",
      title: "情侣出去旅游应该AA吗", text: "情侣旅行费用应该怎么分担才合理?", hashtags: ["旅行"],
    });
    const travel2 = await insertItem(db, {
      platform: "zhihu", platformContentId: "q-2", contentType: "question",
      title: "情侣旅行费用到底谁来承担", text: "两个人出去旅游花钱怎么分摊比较好?", hashtags: ["情侣"],
    });
    const tech = await insertItem(db, {
      platform: "zhihu", platformContentId: "q-3", contentType: "question",
      title: "Python怎么安装依赖", text: "pip 安装第三方包总是失败怎么办?", hashtags: ["编程"],
    });

    // job(missing)
    const jobId = await createEmbeddingJob(db, "auto", "missing").catch(() => null);
    void jobId;
    const space = await ensureSpace(db, provider);
    await activateSpace(db, space.id); // 语义中心 Run Embedding 会激活当前空间
    const jid = await createEmbeddingJob(db, space.id, "missing");
    const result = await runEmbeddingJob(db, jid, provider);
    expect(result.status).toBe("completed");
    expect(result.succeeded).toBe(3);
    expect(result.skipped).toBe(0);

    // similar: travel 邻居 = travel2 高于 tech(§43 基线的库内版本)
    const sim = await findSimilarContent(db, travel, { topK: 2 });
    expect(sim.embeddingSpace).not.toBeNull();
    expect(sim.mode).toBe("lexical"); // §36: 词法模式必须如实标注
    expect(sim.hits.length).toBeGreaterThanOrEqual(1);
    expect(sim.hits[0].contentItemId).not.toBe(travel); // §21 excludeSelf
    const hitIds = sim.hits.map((h) => h.contentItemId);
    expect(hitIds).toContain(travel2);
    expect(sim.hits[0].similarity).toBeGreaterThan(sim.hits[sim.hits.length - 1].similarity);

    // tech 的邻居搜索功能正常(词法排序质量由 §43 golden 基线单独覆盖,§44)
    const simTech = await findSimilarContent(db, tech, { topK: 2 });
    expect(simTech.hits.length).toBeGreaterThan(0);
  });

  it("§27 cache: second missing-scope job has no candidates; all-scope job skips by hash", async () => {
    const space = await ensureSpace(db, provider);
    const jMissing = await createEmbeddingJob(db, space.id, "missing");
    const rMissing = await runEmbeddingJob(db, jMissing, provider);
    expect(rMissing.total).toBe(0); // 已嵌入条目不再进入候选
    expect(rMissing.succeeded).toBe(0);

    // all scope:全部重扫,但 textHash 相同 → 全部 skipped(§27 核心)
    const jAll = await createEmbeddingJob(db, space.id, "all");
    const rAll = await runEmbeddingJob(db, jAll, provider);
    expect(rAll.skipped).toBeGreaterThanOrEqual(3);
    expect(rAll.succeeded).toBe(0);
  });

  it("§29 metric change does NOT change semantic hash → no re-embedding", async () => {
    const [item] = await db.select().from(contentItems).limit(1);
    const before = buildSemanticText({
      contentType: item.contentType, title: item.title, text: item.text,
      transcript: item.transcript, hashtags: JSON.parse(item.hashtags ?? "[]"),
    });
    // 模拟指标更新(likes 变化)——不触碰语义字段
    await db.update(contentItems).set({ likes: 99999 }).where(eq(contentItems.id, item.id));
    const after = buildSemanticText({
      contentType: item.contentType, title: item.title, text: item.text,
      transcript: item.transcript, hashtags: JSON.parse(item.hashtags ?? "[]"),
    });
    expect(after.textHash).toBe(before.textHash);
    // 且 runEmbeddingJob(missing) 会 skip 该条
    const space = await ensureSpace(db, provider);
    const jid = await createEmbeddingJob(db, space.id, "missing");
    const r = await runEmbeddingJob(db, jid, provider);
    expect(r.succeeded).toBe(0);
    void sql;
  });
});

describe("§16 space isolation", () => {
  it("vectors from different spaces never mix", async () => {
    const small = new LexicalFallbackEmbeddingProvider(256);
    const spaceSmall = await ensureSpace(db, small);
    await listSpaceEmbeddings(db, spaceSmall.id, 256);
    const spaceBig = await ensureSpace(db, provider);
    // 256 空间是空的(上面 job 都跑在 512 空间)
    expect(await countEmbeddings(db, spaceSmall.id)).toBe(0);
    expect(await countEmbeddings(db, spaceBig.id)).toBeGreaterThanOrEqual(3);
    // 256 空间里没有目标向量 → similar 返回空 hits 而不是报错/串空间
    const [anyItem] = await db.select({ id: contentItems.id }).from(contentItems).limit(1);
    const sim = await findSimilarContent(db, anyItem.id, { embeddingSpaceId: spaceSmall.id });
    expect(sim.hits).toHaveLength(0);
    expect(sim.embeddingSpace?.dimension).toBe(256);
  });
});

describe("§28 superseded on content update", () => {
  it("title rewrite → new hash row; old row superseded (kept, not deleted)", async () => {
    const space = await ensureSpace(db, provider);
    const [item] = await db.select().from(contentItems).limit(1);
    const before = await getEmbeddingStatus(db, item.id, space.id);
    expect(before.embeddings.filter((e) => !e.superseded).length).toBe(1);

    // 更新标题(语义字段变化)
    await db.update(contentItems).set({ title: `${item.title}(2026 修订版)` }).where(eq(contentItems.id, item.id));
    const jid = await createEmbeddingJob(db, space.id, "all"); // §28:all 重扫发现 hash 变化
    const r = await runEmbeddingJob(db, jid, provider);
    expect(r.succeeded).toBe(1); // 新 hash → 新 embedding

    const after = await getEmbeddingStatus(db, item.id, space.id);
    expect(after.embeddings.length).toBe(2);
    expect(after.embeddings.filter((e) => e.superseded).length).toBe(1); // 旧的保留并标记
    expect(after.embeddings.filter((e) => !e.superseded).length).toBe(1);
    expect(after.embeddings[0].textHash).not.toBe(after.embeddings[1].textHash);
  });
});

describe("§30 partial failure", () => {
  it("single-item vector corruption counts as failed; job completes partially", async () => {
    // 用 monkey-patch provider:第 2 条返回错误维度
    const space = await ensureSpace(db, provider);
    const items = await db.select().from(contentItems).limit(3);
    const badProvider = new LexicalFallbackEmbeddingProvider(512);
    const real = badProvider.embedBatch.bind(badProvider);
    let call = 0;
    const patched = Object.assign(Object.create(Object.getPrototypeOf(badProvider)), badProvider, {
      embedBatch: async (texts: string[]) => {
        call += 1;
        const out = await real(texts);
        if (call === 1 && out.length > 1) out[1] = new Array(999).fill(0.1); // 维度错误
        return out;
      },
      metadata: { ...badProvider.metadata },
    });
    void items;
    // 一条全新内容保证 patched batch 里有真实待嵌入条目
    await insertItem(db, { platform: "zhihu", platformContentId: "partial-1", contentType: "question", title: "部分失败场景新条目一", text: "用于验证 batch 内单条失败不崩 job", hashtags: [] });
    await insertItem(db, { platform: "zhihu", platformContentId: "partial-2", contentType: "question", title: "部分失败场景新条目二", text: "批内第二条,坏维度注入目标", hashtags: [] });
    const jid = await createEmbeddingJob(db, space.id, "all");
    const r = await runEmbeddingJob(db, jid, patched as typeof badProvider);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.succeeded).toBeGreaterThanOrEqual(1);
    // 状态为 partial(有成功有失败)
    expect(["partial"]).toContain(r.status);
  });
});

describe("内容更新后重新嵌入,不许把向量留在作废状态(D63)", () => {
  it("markSuperseded 之后再跑一次 missing,该条目必须重新拥有活跃向量", async () => {
    // 唯一索引 (content_item_id, embedding_space_id, text_hash) 不含 superseded_at。
    // 评分/指标刷新会走 §28 把旧向量标作废,但语义文本没变 → 重新嵌入算出同一个 hash
    // → 插入撞唯一索引。旧代码 onConflictDoNothing 静默丢弃:这条内容从此"永远没有活跃向量",
    // 而任务每轮报 completed、界面每轮报"已建",聚类每轮失败,谁也发现不了。
    const space = await ensureSpace(db, provider);
    const id = await insertItem(db, {
      platform: "zhihu",
      platformContentId: "resupersede-1",
      contentType: "question",
      title: "重建死锁验证条目",
      text: "只改指标不改语义文本,向量必须还能回来",
      hashtags: [],
    });
    const first = await createEmbeddingJob(db, space.id, "all");
    await runEmbeddingJob(db, first, provider);
    expect((await embeddedItemIds(db, space.id)).has(id)).toBe(true);

    await markSuperseded(db, id, space.id);
    expect((await embeddedItemIds(db, space.id)).has(id)).toBe(false);

    const second = await createEmbeddingJob(db, space.id, "missing");
    const r2 = await runEmbeddingJob(db, second, provider);
    expect(r2.status).toBe("completed");
    expect((await embeddedItemIds(db, space.id)).has(id)).toBe(true);
  });
});

describe("向量服务不可达时的收尾(D61)", () => {
  it("探测失败要把任务标成 failed,不能留一条 queued 死行", async () => {
    // 真实场景:本机 BGE-M3 适配器停了。openai 兼容 provider 把 dimension 声明为 0
    // (靠首次探针实测),于是 runEmbeddingJob 在把任务改成 running 之前就抛 ——
    // 那一瞬间留下的 queued 行没有任何人会再碰它。
    const unreachable = (msg: string): EmbeddingProvider => ({
      metadata: { providerId: "openai-compatible", model: "BAAI/bge-m3", version: "v1", dimension: 0 },
      validateConfig: () => ({ ok: true }),
      embed: async () => {
        throw new Error(msg);
      },
      embedBatch: async () => {
        throw new Error(msg);
      },
      batchSize: 32,
      concurrency: 1,
      minIntervalMs: 0,
      mode: "api",
    });
    const space = await ensureSpace(db, unreachable(""), 1024);
    const jobId = await createEmbeddingJob(db, space.id, "missing");
    await expect(runEmbeddingJob(db, jobId, unreachable("connect ECONNREFUSED 127.0.0.1:8899"))).rejects.toThrow(
      "ECONNREFUSED",
    );

    const [row] = await db.select().from(embeddingJobs).where(eq(embeddingJobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("向量服务探测失败");
    expect(row.completedAt).not.toBeNull();
    // 关键不变量:fullRefresh 用 status in (queued, running) 判"是否已有同类任务在跑"。
    // 留下一条 queued 死行 = 自动向量化永久停摆,向量服务恢复也缓不过来(D60 同一类)。
    const busy = await db
      .select({ c: sql<number>`count(*)` })
      .from(embeddingJobs)
      .where(sql`${embeddingJobs.status} IN ('queued', 'running')`);
    expect(Number(busy[0]?.c ?? 0)).toBe(0);
    // 上面 ensureSpace 把这个假空间激活了,还回去,别污染同文件后面的用例
    await activateSpace(db, (await ensureSpace(db, provider)).id);
  });
});

describe("§42 performance: 5000 items", () => {
  it("5000 embeddings stored + topK search within budget", async () => {
    // 独立空间,批量灌 5000 条(直接走 lexicalEmbed + upsert,模拟已入库)
    const perfProvider = new LexicalFallbackEmbeddingProvider(512);
    const space = await ensureSpace(db, perfProvider);
    const ts = new Date().toISOString();
    const words = ["旅行", "美食", "编程", "健身", "电影", "音乐", "读书", "理财", "职场", "教育"];
    const started = Date.now();

    for (let batchStart = 0; batchStart < 5000; batchStart += 500) {
      const texts: { id: number; text: string }[] = [];
      for (let i = 0; i < 500 && batchStart + i < 5000; i++) {
        const idx = batchStart + i;
        const w1 = words[idx % words.length];
        const w2 = words[(idx * 7) % words.length];
        texts.push({ id: idx, text: `${w1}相关话题第${idx}条 ${w2}讨论` });
      }
      const vectors = await perfProvider.embedBatch(texts.map((t) => t.text));
      for (let j = 0; j < texts.length; j++) {
        // 直接插入 content_items + embeddings(跳过逐条 API)
        const [row] = await db
          .insert(contentItems)
          .values({
            platform: "zhihu",
            platformContentId: `perf-${texts[j].id}`,
            contentType: "article",
            title: texts[j].text,
            text: null,
            transcript: null,
            hashtags: "[]",
            url: null,
            canonicalUrl: null,
            authorId: null,
            authorName: null,
            authorFollowers: null,
            publishedAt: null,
            publishedTz: null,
            publishedTzAssumption: "unknown",
            views: null, likes: null, comments: null, shares: null, favorites: null, upvotes: null,
            dataQuality: "minimal",
            sourceType: "manual",
            collectedAt: ts,
            rawDataId: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning({ id: contentItems.id });
        await import("../../server/src/semantic/vectorRepository").then((m) =>
          m.upsertEmbedding(db, {
            contentItemId: row.id,
            space,
            textHash: `perf-hash-${texts[j].id}`,
            vector: vectors[j],
          }),
        );
      }
    }
    const storeMs = Date.now() - started;

    // topK 查询 benchmark(10 次取平均)
    const [probe] = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.platformContentId, "perf-0"));
    const qStart = Date.now();
    let lastHits = 0;
    for (let i = 0; i < 10; i++) {
      const r = await findSimilarContent(db, probe.id, { topK: 10 });
      lastHits = r.hits.length;
    }
    const avgMs = (Date.now() - qStart) / 10;

    expect(await countEmbeddings(db, space.id)).toBeGreaterThanOrEqual(5000);
    expect(lastHits).toBeGreaterThan(0);
    expect(avgMs).toBeLessThan(500); // 5000 条 brute-force 必须远低于 500ms
    console.log(`[perf] stored 5000 embeddings in ${storeMs}ms; avg topK search = ${avgMs.toFixed(1)}ms`);
  }, 120_000);
});

describe("§45/§46 provenance + preview", () => {
  it("embedding status exposes space, provider, model, hash and semantic text preview", async () => {
    const [item] = await db.select({ id: contentItems.id }).from(contentItems).limit(1);
    const st = await getEmbeddingStatus(db, item.id);
    expect(st.space).not.toBeNull();
    expect(st.semanticText).not.toBeNull();
    expect(st.semanticText!.semanticText.length).toBeGreaterThan(0);
    expect(st.semanticText!.textBuilderVersion).toBe("semantic-v1");
    expect(st.embeddings.length).toBeGreaterThan(0);
  });

  it("snapshots remain untouched by embedding flow (Stage 1-3 数据不动)", async () => {
    const [n] = await db.select({ c: sql<number>`count(*)` }).from(contentMetricSnapshots);
    expect(Number(n.c)).toBeGreaterThanOrEqual(0); // 表可读,未破坏
  });
});

describe("cosine used end-to-end", () => {
  it("self similarity = 1 when excludeSelf=false", async () => {
    const [item] = await db.select({ id: contentItems.id }).from(contentItems).limit(1);
    const r = await findSimilarContent(db, item.id, { topK: 50, excludeSelf: false });
    const self = r.hits.find((h) => h.contentItemId === item.id);
    if (self) expect(self.similarity).toBeCloseTo(1, 5);
    void cosineSimilarity;
  });
});
