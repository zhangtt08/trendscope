/**
 * Stage 8 §72 性能:5000 内容 × 500 话题 —— 特征抽取/Pattern/饱和度/角度分析。
 * 话题内角度分析有 300 条上限(§32),不得出现 O(n²) 爆炸。
 */
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, topicMemberships, topics } from "../../server/src/db/schema";
import { runIntelligence } from "../../server/src/intelligence/service";
import { runContentScoring } from "../../server/src/scoring/service";

let db: DB;
afterAll(() => {
  const anyDb = db as unknown as { $client: { close(): void } };
  anyDb?.$client?.close();
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const N_CONTENT = 5000;
const N_TOPICS = 500;

describe("Stage 8 性能(§72:5000 内容 / 500 话题)", () => {
  it("情报全流程在预算内;无 O(n²) 爆炸", async () => {
    ({ db } = createTestDb());
    const ts = new Date(NOW).toISOString();
    const itemRows = [];
    for (let i = 0; i < N_CONTENT; i++) {
      itemRows.push({
        platform: i % 2 === 0 ? "xiaohongshu" : "zhihu",
        platformContentId: `p8-${i}`,
        contentType: "note",
        title: `性能话题内容第${i % 50}篇关于主题${i % 7}`,
        text: `这是性能测试正文第${i}条,包含数字 123 与金额 100 元`,
        hashtags: "[]",
        authorId: `perf-${i % 100}`,
        authorName: `性能作者-${i % 100}`,
        publishedAt: h(24 + (i % 200)),
        publishedTz: "UTC",
        publishedTzAssumption: "explicit_offset",
        dataQuality: "partial",
        sourceType: "manual",
        collectedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    const itemIds: number[] = [];
    for (let i = 0; i < itemRows.length; i += 500) {
      const inserted = await db.insert(contentItems).values(itemRows.slice(i, i + 500)).returning({ id: contentItems.id });
      itemIds.push(...inserted.map((r) => r.id));
    }
    const topicIds: number[] = [];
    for (let t = 0; t < N_TOPICS; t += 200) {
      const batch = Array.from({ length: Math.min(200, N_TOPICS - t) }, (_, k) => ({
        name: `性能话题 ${t + k}`,
        status: "active",
        embeddingSpaceId: "perf",
        namingSource: "keyword",
        memberCount: 10,
        keywords: "[]",
        hashtags: "[]",
        firstObservedAt: h(24 * 20),
        lastObservedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      }));
      const inserted = await db.insert(topics).values(batch).returning({ id: topics.id });
      topicIds.push(...inserted.map((r) => r.id));
    }
    const memRows = topicIds.flatMap((tid, t) =>
      Array.from({ length: 10 }, (_, k) => ({
        topicId: tid,
        contentItemId: itemIds[(t * 10 + k) % itemIds.length],
        assignmentMethod: "automatic",
        manualLock: 0,
        createdAt: h(24 * 10),
        updatedAt: h(24 * 10),
      })),
    );
    for (let i = 0; i < memRows.length; i += 500) {
      await db.insert(topicMemberships).values(memRows.slice(i, i + 500));
    }
    // 爆发分(先跑 Stage 7 内容评分,爆发组由分数决定)
    await runContentScoring(db, { now: NOW });

    const t0 = Date.now();
    const result = await runIntelligence(db, { now: NOW });
    const ms = Date.now() - t0;
    console.log(`[perf-8] intelligence=${ms}ms topics=${result.topicsAnalyzed} contents=${result.contentsAnalyzed} patternScorable=${result.patternScorable} satScorable=${result.saturatedScorable}`);
    // 预算:全流程(特征抽取 5000 + 500 话题三引擎)≤ 60s(本机较慢,余量充足;实测应为秒级)
    expect(ms).toBeLessThan(60_000);
    expect(result.contentsAnalyzed).toBe(N_CONTENT);
    const feat = Number((db.all(sql`SELECT COUNT(*) c FROM content_feature_records`)[0] as { c: number }).c);
    expect(feat).toBe(N_CONTENT);
  }, 300_000);
});
