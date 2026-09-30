/**
 * Stage 7 §CI/§DM 性能:5000 内容 × 500 话题等效数据。
 * 目标:批量评分允许合理耗时,但列表查询必须快(非几十秒);预算留足余量
 * (本机较慢 —— 6B 性能测试教训),禁止靠调大 timeout"变绿"。
 */
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, contentMetricSnapshots, topicMemberships, topicSnapshots, topics } from "../../server/src/db/schema";
import { runContentScoring, runTopicTrendScoring } from "../../server/src/scoring/service";
import { listContentScores, listTopicTrends } from "../../server/src/scoring/repository";

let db: DB;
afterAll(() => {
  const anyDb = db as unknown as { $client: { close(): void } };
  anyDb?.$client?.close();
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const N_CONTENT = 5000;
const N_TOPICS = 500;

describe("Stage 7 性能(§CI:5000 内容 / 500 话题)", () => {
  it("批量评分在预算内;列表查询 ms 级", async () => {
    ({ db } = createTestDb());
    const ts = new Date(NOW).toISOString();
    // 5000 内容:100 作者 × 50 条;两类平台;2 条快照(2 天前 + 1 小时前)
    const itemIds: number[] = [];
    const rows = [];
    for (let i = 0; i < N_CONTENT; i++) {
      rows.push({
        platform: i % 2 === 0 ? "xiaohongshu" : "zhihu",
        platformContentId: `p7-${i}`,
        contentType: i % 3 === 0 ? "note" : "question",
        title: `性能内容 ${i}`,
        text: "性能测试正文",
        hashtags: "[]",
        authorId: `perf-${i % 100}`,
        authorName: `性能作者-${i % 100}`,
        publishedAt: h(30 + (i % 100)),
        publishedTz: "UTC",
        publishedTzAssumption: "explicit_offset",
        dataQuality: "partial",
        sourceType: "manual",
        collectedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const inserted = await db.insert(contentItems).values(rows.slice(i, i + 500)).returning({ id: contentItems.id });
      itemIds.push(...inserted.map((r) => r.id));
    }
    const snapRows = [];
    for (let i = 0; i < itemIds.length; i++) {
      snapRows.push({ contentItemId: itemIds[i], capturedAt: h(48), views: null, likes: 100 + (i % 50), comments: 5, shares: 1, favorites: 2, upvotes: i % 2 === 0 ? null : 80, source: "perf" });
      snapRows.push({ contentItemId: itemIds[i], capturedAt: h(1), views: null, likes: 100 + (i % 50) + (i % 7), comments: 5 + (i % 3), shares: 1, favorites: 2, upvotes: i % 2 === 0 ? null : 80 + (i % 11), source: "perf" });
    }
    for (let i = 0; i < snapRows.length; i += 1000) {
      await db.insert(contentMetricSnapshots).values(snapRows.slice(i, i + 1000));
    }
    // 500 话题 × 10 成员;每话题 4 条 topic snapshot
    const topicIds: number[] = [];
    const topicRows = [];
    for (let t = 0; t < N_TOPICS; t++) {
      topicRows.push({
        name: `性能话题 ${t}`,
        status: "active",
        embeddingSpaceId: "perf-space",
        namingSource: "keyword",
        memberCount: 10,
        keywords: "[]",
        hashtags: "[]",
        firstObservedAt: h(24 * 15),
        lastObservedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    for (let i = 0; i < topicRows.length; i += 200) {
      const inserted = await db.insert(topics).values(topicRows.slice(i, i + 200)).returning({ id: topics.id });
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
    const tSnapRows = topicIds.flatMap((tid) =>
      [13, 9, 6, 2].map((daysAgo, idx) => ({
        topicId: tid,
        analysisRunId: idx + 1,
        capturedAt: h(daysAgo * 24),
        memberCount: 10,
        newContentCount: 2 + (daysAgo % 3),
        activeCreatorCount: 4 + idx,
        platformCount: 1,
        averageRawMomentum: 10 + idx * 15,
        rawEngagementDelta: null,
        cohesion: 0.7,
        platformDistribution: '{"xiaohongshu":1}',
      })),
    );
    for (let i = 0; i < tSnapRows.length; i += 500) {
      await db.insert(topicSnapshots).values(tSnapRows.slice(i, i + 500));
    }

    const t0 = Date.now();
    const content = await runContentScoring(db, { now: NOW });
    const contentMs = Date.now() - t0;
    const t1 = Date.now();
    const topic = await runTopicTrendScoring(db, { now: NOW });
    const topicMs = Date.now() - t1;
    const t2 = Date.now();
    const trendList = await listTopicTrends(db, { page: 1, pageSize: 20, sortBy: "score" });
    const trendListMs = Date.now() - t2;
    const t3 = Date.now();
    const burstList = await listContentScores(db, { page: 1, pageSize: 20, scorable: "yes" });
    const burstListMs = Date.now() - t3;

    console.log(
      `[perf-7] content=${contentMs}ms (${content.scorableCount}/${content.contentCount} scorable) topic=${topicMs}ms (${topic.scorableCount}/${topic.topicCount}) trendList=${trendListMs}ms burstList=${burstListMs}ms`,
    );
    // 预算:批量评分允许分钟内;列表查询必须快(§CI 普通查询非几十秒)
    expect(contentMs).toBeLessThan(120_000);
    expect(topicMs).toBeLessThan(60_000);
    expect(trendListMs).toBeLessThan(2_000);
    expect(burstListMs).toBeLessThan(2_000);
    expect(trendList.total).toBe(N_TOPICS);
    expect(burstList.total).toBeGreaterThan(0);
    // 全部内容都有 current 行(含 unscorable)
    const cur = Number((db.all(sql`SELECT COUNT(*) c FROM content_score_current`)[0] as { c: number }).c);
    expect(cur).toBe(N_CONTENT);
  }, 240_000);
});
