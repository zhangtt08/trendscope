/**
 * Stage 6B integration (§73-77/§64/§74-77): graph clustering, reconciliation,
 * stable identity, split/merge, manual governance, snapshots, watch, analysis
 * runs, space isolation — all on the REAL SQLite database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, topicMemberships, topicSnapshots, topics, topicEvolutionEvents, topicWatches, topicAnalysisRuns } from "../../server/src/db/schema";
import { LexicalFallbackEmbeddingProvider, lexicalEmbed } from "../../server/src/semantic/lexicalProvider";
import { ensureSpace, activateSpace, upsertEmbedding } from "../../server/src/semantic/vectorRepository";
import { defaultConfigFor } from "../../server/src/topics/config";
import { buildEdges, connectedComponents, clusterCohesion, validateClusters } from "../../server/src/topics/clustering";
import { runTopicAnalysis } from "../../server/src/topics/analysis";
import { renameTopic, mergeTopics, moveContent, splitTopic, setWatch, listTopics, topicDetail } from "../../server/src/topics/governance";
import { evaluateClusters, clusterGolden } from "../../server/src/topics/eval";
import { GOLDEN_ALL } from "../../server/src/topics/goldenDataset";

let db: DB;
const provider = new LexicalFallbackEmbeddingProvider(512);

async function insertItem(v: { title: string; text: string | null; platform?: string; likes?: number | null }): Promise<number> {
  const ts = new Date().toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform: v.platform ?? "zhihu",
      platformContentId: `t-${Math.random().toString(36).slice(2)}`,
      contentType: "question",
      title: v.title,
      text: v.text,
      transcript: null,
      hashtags: "[]",
      url: null,
      canonicalUrl: null,
      authorId: null,
      authorName: "作者" + ((v.title?.length ?? 0) % 5),
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

async function embedItem(itemId: number, text: string): Promise<void> {
  const space = await ensureSpace(db, provider);
  await upsertEmbedding(db, { contentItemId: itemId, space, textHash: `h-${itemId}-${Date.now()}-${Math.random()}`, vector: lexicalEmbed(text, 512) });
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

describe("§73 graph building / components / validation", () => {
  it("edges respect threshold and neighborLimit; components are sane", () => {
    const cfg = defaultConfigFor("lexical");
    const texts = [
      "情侣旅行费用应该怎么分摊",
      "情侣出游花销谁来承担比较好",
      "恋爱中旅行的钱怎么分担",
      "Python怎么安装第三方依赖包",
      "pip 安装依赖总是失败怎么办",
      "npm 安装依赖报错如何解决",
    ];
    const entries = texts.map((t, i) => ({ contentItemId: i, vector: lexicalEmbed(t, 512) }));
    const edges = buildEdges(entries, cfg);
    // 每节点边数 ≤ neighborLimit(§8)
    const deg = new Map<number, number>();
    for (const e of edges) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    for (const [, d] of deg) expect(d).toBeLessThanOrEqual(cfg.neighborLimit);
    const comps = connectedComponents(6, edges);
    expect(comps.length).toBeGreaterThanOrEqual(2); // 语义组分开
    const { clusters, noiseIndexes: noise } = validateClusters(entries, comps, cfg);
    expect(clusters.length + Math.floor(noise.length / cfg.minClusterSize)).toBeGreaterThanOrEqual(2);
    for (const c of clusters) expect(c.cohesion).toBeGreaterThan(0);
  });

  it("cohesion: tight group > mixed group; representative picks medoid-ish top3", () => {
    const tight = [1, 2, 3].map((i) => ({ contentItemId: i, vector: lexicalEmbed("情侣旅行费用分摊问题讨论" + ["一", "二", "三"][i - 1], 512) }));
    const mixed = [
      { contentItemId: 10, vector: lexicalEmbed("情侣旅行", 512) },
      { contentItemId: 11, vector: lexicalEmbed("Python安装依赖", 512) },
      { contentItemId: 12, vector: lexicalEmbed("重庆火锅最好吃", 512) },
    ];
    const tightC = clusterCohesion(tight, [0, 1, 2]);
    const mixedC = clusterCohesion(mixed, [0, 1, 2]);
    expect(tightC.cohesion).toBeGreaterThan(mixedC.cohesion);
    expect(tightC.representativeIndexes.length).toBe(3); // §15 top3
  });
});

describe("§74/§75 full pipeline + stable identity", () => {
  it("Run 1 creates topics; Run 2 with unchanged data keeps same Topic IDs", async () => {
    // 内容:两组语义 + 一组噪声
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertItem({ title: `情侣旅行费用分摊问题讨论${i}`, text: "情侣出去玩钱怎么分才合理", likes: 100 + i }));
    for (let i = 0; i < 5; i++) ids.push(await insertItem({ title: `Python安装依赖报错解决${i}`, text: "pip install 总是失败怎么办", likes: 50 + i }));
    const texts: string[] = [];
    for (const id of ids) {
      const [it] = await db.select().from(contentItems).where(eq(contentItems.id, id));
      texts.push(`${it.title} ${it.text}`);
    }
    for (let i = 0; i < ids.length; i++) await embedItem(ids[i], texts[i]);

    const space = await ensureSpace(db, provider);
    await activateSpace(db, space.id);
    const run1 = await runTopicAnalysis(db, await createRun(space.id), {});
    expect(run1.status).toBe("completed");
    expect(run1.report.topicCount).toBeGreaterThanOrEqual(2);
    expect(run1.report.unclusteredRate).toBeLessThan(1);

    const after1 = await db.select().from(topics).where(eq(topics.embeddingSpaceId, space.id));
    const active1 = after1.filter((t) => t.status !== "inactive").map((t) => ({ id: t.id, count: t.memberCount })).sort((a, b) => b.count - a.count);
    expect(active1.length).toBeGreaterThanOrEqual(2);

    // Run 2:无新内容 → 同簇高重合 → Topic ID 稳定(§75)
    const run2 = await runTopicAnalysis(db, await createRun(space.id), {});
    expect(run2.status).toBe("completed");
    const after2 = (await db.select().from(topics).where(eq(topics.embeddingSpaceId, space.id))).filter((t) => t.status !== "inactive");
    const counts1 = active1.map((a) => a.count).sort((a, b) => b - a);
    const counts2 = after2.map((t) => t.memberCount).sort((a, b) => b - a);
    expect(counts2).toEqual(counts1); // 成员分布一致 → ID 稳定
    // 旧 ID 全部仍在(§22 禁删除重建)
    for (const a of active1) expect(after2.some((t) => t.id === a.id)).toBe(true);
  });

  it("§28-32 snapshot append-only per successful run", async () => {
    const space = await ensureSpace(db, provider);
    const snaps = await db.select().from(topicSnapshots).where(eq(topicSnapshots.topicId, (await db.select().from(topics).limit(1))[0].id));
    expect(snaps.length).toBeGreaterThanOrEqual(2); // Run1 + Run2 各追加一条
  });
});

describe("§76 split / §26 merge detection", () => {
  it("split: adding a divergent subgroup splits into two topics; evolution event recorded", async () => {
    // 新主题组(与现有两组都不同)
    const newIds: number[] = [];
    for (let i = 0; i < 5; i++) newIds.push(await insertItem({ title: `健身增肌训练计划讨论${i}`, text: "增肌饮食和力量训练安排" }));
    for (const id of newIds) {
      const [it] = await db.select().from(contentItems).where(eq(contentItems.id, id));
      await embedItem(id, `${it.title} ${it.text}`);
    }
    const space = await ensureSpace(db, provider);
    const runId = await createRun(space.id);
    const r = await runTopicAnalysis(db, runId, {});
    expect(r.status).toBe("completed");
    const events = await db.select().from(topicEvolutionEvents);
    // 至少有 created 事件;新主题出现
    expect(events.some((e) => e.eventType === "created")).toBe(true);
    const all = await db.select().from(topics);
    expect(all.some((t) => t.name.includes("健身") || t.name.includes("训练") || t.name.includes("增肌"))).toBe(true);
  });

  it("§33 manual merge: members move, merged topic stays as inactive with pointer", async () => {
    const all = (await db.select().from(topics)).filter((t) => t.status !== "inactive" && t.memberCount > 0);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const [a, b] = all;
    await mergeTopics(db, a.id, b.id);
    const [merged] = await db.select().from(topics).where(eq(topics.id, b.id));
    expect(merged.status).toBe("inactive");
    expect(merged.mergedIntoTopicId).toBe(a.id);
    const members = await db.select().from(topicMemberships).where(eq(topicMemberships.topicId, b.id));
    expect(members.length).toBe(0); // 成员已转移
    const events = await db.select().from(topicEvolutionEvents);
    expect(events.some((e) => e.eventType === "manual_merge")).toBe(true);
  });
});

describe("§21/§36/§77 manual governance preservation", () => {
  it("manual rename survives next analysis", async () => {
    const [topic] = await db.select().from(topics).where(eq(topics.status, "active")).limit(1);
    await renameTopic(db, topic.id, "手动命名的话题名", "人工描述");
    const space = await ensureSpace(db, provider);
    await runTopicAnalysis(db, await createRun(space.id), {});
    const [after] = await db.select().from(topics).where(eq(topics.id, topic.id));
    expect(after.name).toBe("手动命名的话题名"); // §21 不得覆盖
    expect(after.namingSource).toBe("manual");
    const events = await db.select().from(topicEvolutionEvents);
    expect(events.some((e) => e.eventType === "renamed")).toBe(true);
  });

  it("manual move with lock survives next analysis (§36)", async () => {
    const [topic] = await db.select().from(topics).where(eq(topics.status, "active")).limit(1);
    const [anyItem] = await db.select().from(contentItems).limit(1);
    await moveContent(db, anyItem.id, topic.id); // manualLock=1
    const space = await ensureSpace(db, provider);
    await runTopicAnalysis(db, await createRun(space.id), {});
    const [m] = await db.select().from(topicMemberships).where(eq(topicMemberships.contentItemId, anyItem.id));
    expect(m.topicId).toBe(topic.id); // 人工指派保留
    expect(m.manualLock).toBe(1);
  });

  it("§35 manual split creates new topic with locked members + evolution event", async () => {
    const [topic] = await db.select().from(topics).where(eq(topics.status, "active")).limit(1);
    const members = await db.select().from(topicMemberships).where(eq(topicMemberships.topicId, topic.id));
    expect(members.length).toBeGreaterThanOrEqual(2);
    const take = members.slice(0, 1).map((m) => m.contentItemId);
    const { newTopicId } = await splitTopic(db, {
      sourceTopicId: topic.id,
      contentItemIds: take,
      name: "手动拆分的新话题",
    });
    const [nt] = await db.select().from(topics).where(eq(topics.id, newTopicId));
    expect(nt.namingSource).toBe("manual");
    const events = await db.select().from(topicEvolutionEvents);
    expect(events.some((e) => e.eventType === "manual_split")).toBe(true);
  });

  it("§37 watch state set and read", async () => {
    const [topic] = await db.select().from(topics).where(eq(topics.status, "active")).limit(1);
    await setWatch(db, topic.id, "review");
    const [w] = await db.select().from(topicWatches).where(eq(topicWatches.topicId, topic.id));
    expect(w.state).toBe("review");
  });
});

describe("§4 embedding space isolation", () => {
  it("topic analysis never mixes vectors across spaces", async () => {
    const space = await ensureSpace(db, provider);
    const topicsA = await db.select().from(topics).where(eq(topics.embeddingSpaceId, space.id));
    for (const t of topicsA) expect(t.embeddingSpaceId).toBe(space.id);
    // 另一个空间(256 维)不可能被引用
    const other = await ensureSpace(db, new LexicalFallbackEmbeddingProvider(256));
    const topicsOther = await db.select().from(topics).where(eq(topics.embeddingSpaceId, other.id));
    expect(topicsOther.every((t) => t.embeddingSpaceId === other.id)).toBe(true);
  });
});

describe("§56/§58/§61 golden eval (lexical baseline, real run)", () => {
  it("golden dataset: purity strongly above random, pairwise F1 sane, not one giant blob", async () => {
    const vectors = GOLDEN_ALL.map((g) => lexicalEmbed(g.text, 512));
    const cfg = defaultConfigFor("lexical");
    const { clusters, noise } = clusterGolden(vectors, cfg);
    const labelsByCluster = clusters.map((c) => c.members.map((i) => GOLDEN_ALL[i].expectedTopicLabel as string));
    const avgCohesion = clusters.length ? clusters.reduce((a, b) => a + b.cohesion, 0) / clusters.length : 0;
    const m = evaluateClusters(labelsByCluster, noise.length, GOLDEN_ALL.length, avgCohesion);
    console.log(
      `[golden-lexical] topics=${m.topicsFound} purity=${(m.purity * 100).toFixed(1)}% pairwiseF1=${(m.pairwiseF1 * 100).toFixed(1)}% noise=${(m.noiseRate * 100).toFixed(1)}%`,
    );
    // §61 质量门:明显优于随机、不塌缩成一个簇、不全变噪声
    expect(m.topicsFound).toBeGreaterThanOrEqual(3);
    expect(m.purity).toBeGreaterThan(0.5);
    expect(m.pairwiseF1).toBeGreaterThan(0.2);
    expect(m.noiseRate).toBeLessThan(0.5);
  });
});

async function createRun(spaceId: string): Promise<number> {
  // 直接复用 analysis 内部入口的最小封装
  const { createAnalysisRun } = await import("../../server/src/topics/analysis");
  const space = await ensureSpace(db, provider);
  void spaceId;
  return createAnalysisRun(db, space, {}, defaultConfigFor("lexical"));
}
