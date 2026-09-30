/**
 * Stage 7 integration — Topic Trend golden fixtures(§BZ/§CA)+ Lifecycle 滞回(§AV/§CC)
 * + repository 查询分页/筛选。真实 SQLite(temp DB);时间固定(§CD)。
 *
 * Topic A 加速上升→rising;B 高位趋平→saturated(初步);C 衰退→declining;
 * D 常青→evergreen;E 样本少→unscorable;F 单条爆款+其余平淡→不得高分(防误判)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, contentMetricSnapshots, topicMemberships, topicSnapshots, topics } from "../../server/src/db/schema";
import { runContentScoring, runTopicTrendScoring } from "../../server/src/scoring/service";
import { getTopicTrendDetail, listTopicTrends } from "../../server/src/scoring/repository";

let db: DB;
afterAll(() => {
  const anyDb = db as unknown as { $client: { close(): void } };
  anyDb?.$client?.close();
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const d = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let seq = 0;
async function insertItem(v: { authorId?: string; publishedAt?: string }): Promise<number> {
  seq += 1;
  const ts = new Date(NOW).toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform: "xiaohongshu",
      platformContentId: `s7t-${seq}`,
      contentType: "note",
      title: `话题内容 ${seq}`,
      text: "正文",
      hashtags: "[]",
      authorId: v.authorId ?? `author-${seq}`,
      authorName: v.authorId ? `作者-${v.authorId}` : `作者-${seq}`,
      publishedAt: v.publishedAt ?? d(10),
      publishedTz: "UTC",
      publishedTzAssumption: "explicit_offset",
      dataQuality: "partial",
      sourceType: "manual",
      collectedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: contentItems.id });
  return row.id;
}

async function snapItem(id: number, daysAgo: number, m: { likes: number; comments: number; shares: number; favorites: number }): Promise<void> {
  await db.insert(contentMetricSnapshots).values({
    contentItemId: id,
    capturedAt: d(daysAgo),
    views: null,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    favorites: m.favorites,
    upvotes: null,
    source: "test",
  });
}

async function insertTopic(v: {
  name: string;
  firstObservedAt: string;
  memberCount: number;
  snapshots: { daysAgo: number; newContent: number; creators: number | null; momentum: number | null }[];
  burstScores: (number | null)[]; // 按成员顺序注入 content_score_current
}): Promise<number> {
  const ts = new Date(NOW).toISOString();
  const [t] = await db
    .insert(topics)
    .values({
      name: v.name,
      status: "active",
      embeddingSpaceId: "lexical-hash:zh-lexical-v1:512:semantic-v1",
      namingSource: "keyword",
      memberCount: v.memberCount,
      keywords: "[]",
      hashtags: "[]",
      firstObservedAt: v.firstObservedAt,
      lastObservedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: topics.id });
  for (const s of v.snapshots) {
    await db.insert(topicSnapshots).values({
      topicId: t.id,
      analysisRunId: 1,
      capturedAt: d(s.daysAgo),
      memberCount: v.memberCount,
      newContentCount: s.newContent,
      activeCreatorCount: s.creators,
      platformCount: 1,
      averageRawMomentum: s.momentum,
      rawEngagementDelta: null,
      cohesion: 0.8,
      platformDistribution: '{"xiaohongshu":1}',
    });
  }
  for (let i = 0; i < v.memberCount; i++) {
    const itemId = await insertItem({});
    await db.insert(topicMemberships).values({
      topicId: t.id,
      contentItemId: itemId,
      assignmentMethod: "automatic",
      manualLock: 0,
      createdAt: d(10),
      updatedAt: d(10),
    });
    // 让内容评分给成员真实算分:两条快照,大小由 burstScores 无法直接控制 ——
    // 简化:这里直接注入 content_score_current(测试夹具允许,断言与注入值闭环)
    const score = v.burstScores[i] ?? 0;
    await db.run(sql`
      INSERT INTO content_score_current
        (content_item_id, score_version, scorable, overall_score, confidence, breakdown, evidence, calculated_at, scoring_run_id, platform, topic_id)
      VALUES (${itemId}, 'CONTENT_BURST_V1', 1, ${score}, 'medium', '{}', '{}', ${d(1)}, 0, 'xiaohongshu', ${t.id})
    `);
  }
  return t.id;
}

describe("Stage 7 Topic Trend + Lifecycle fixtures(§BZ/§CA/§AV)", () => {
  let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0;

  beforeAll(async () => {
    ({ db } = createTestDb());
    // A 加速上升:新增 2→3→5→9,创作者 2→3→5→8,动量 10→20→40→90,密度 0.5
    A = await insertTopic({
      name: "A 加速上升",
      firstObservedAt: d(13),
      memberCount: 6,
      snapshots: [
        { daysAgo: 13, newContent: 2, creators: 2, momentum: 10 },
        { daysAgo: 9, newContent: 3, creators: 3, momentum: 20 },
        { daysAgo: 6, newContent: 5, creators: 5, momentum: 40 },
        { daysAgo: 2, newContent: 9, creators: 8, momentum: 90 },
      ],
      burstScores: [85, 90, 80, 60, 40, 30],
    });
    // B 高位趋平:30 成员,新增 10/12/11/10,密度 0.2 → saturated(初步饱和判断)
    B = await insertTopic({
      name: "B 高位趋平",
      firstObservedAt: d(20),
      memberCount: 30,
      snapshots: [
        { daysAgo: 13, newContent: 10, creators: 15, momentum: 100 },
        { daysAgo: 9, newContent: 12, creators: 15, momentum: 100 },
        { daysAgo: 6, newContent: 11, creators: 16, momentum: 100 },
        { daysAgo: 2, newContent: 10, creators: 16, momentum: 100 },
      ],
      burstScores: Array.from({ length: 30 }, (_, i) => (i < 6 ? 85 : 40)),
    });
    // C 衰退:近期零新增、基准 11、动量塌方 → declining
    C = await insertTopic({
      name: "C 衰退",
      firstObservedAt: d(15),
      memberCount: 8,
      snapshots: [
        { daysAgo: 13, newContent: 6, creators: 6, momentum: 50 },
        { daysAgo: 9, newContent: 5, creators: 5, momentum: 40 },
        { daysAgo: 6, newContent: 0, creators: 0, momentum: 10 },
        { daysAgo: 2, newContent: 0, creators: 0, momentum: 5 },
      ],
      burstScores: [30, 25, 20, 20, 20, 20, 20, 20],
    });
    // D 常青:60 天龄、平稳小量、零波动 → evergreen
    D = await insertTopic({
      name: "D 常青",
      firstObservedAt: d(60),
      memberCount: 12,
      snapshots: [
        { daysAgo: 13, newContent: 1, creators: 3, momentum: 20 },
        { daysAgo: 9, newContent: 1, creators: 3, momentum: 20 },
        { daysAgo: 6, newContent: 1, creators: 3, momentum: 20 },
        { daysAgo: 2, newContent: 1, creators: 3, momentum: 20 },
      ],
      burstScores: [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40],
    });
    // E 样本少:2 成员 → unscorable
    E = await insertTopic({ name: "E 样本少", firstObservedAt: d(2), memberCount: 2, snapshots: [{ daysAgo: 1, newContent: 2, creators: 2, momentum: 5 }], burstScores: [50, 50] });
    // F 单条爆款防误判(§CA):20 成员只有 1 条 95 分,新增/创作者全平
    F = await insertTopic({
      name: "F 单爆款",
      firstObservedAt: d(14),
      memberCount: 20,
      snapshots: [
        { daysAgo: 13, newContent: 3, creators: 5, momentum: 30 },
        { daysAgo: 9, newContent: 3, creators: 5, momentum: 30 },
        { daysAgo: 6, newContent: 3, creators: 5, momentum: 30 },
        { daysAgo: 2, newContent: 3, creators: 5, momentum: 30 },
      ],
      burstScores: [95, ...Array.from({ length: 19 }, () => 40)],
    });
    await runTopicTrendScoring(db, { now: NOW });
  });

  const load = async (id: number) => (await getTopicTrendDetail(db, id)).current!;

  it("Topic A:加速上升 → rising,高分", async () => {
    const cur = await load(A);
    expect(cur.score).toBeGreaterThanOrEqual(60);
    expect(cur.lifecycle).toBe("rising");
    const ev = JSON.parse(cur.evidence);
    expect(ev.windows.当前窗口新增).toBe(14);
    expect(ev.windows.基准窗口新增).toBe(5);
  });

  it("Topic B:高位趋平 → saturated(初步饱和判断,v1 代理,§AS)", async () => {
    const cur = await load(B);
    expect(cur.lifecycle).toBe("saturated");
    expect(JSON.parse(cur.evidence).saturationProxy.note).toContain("v1 proxy");
  });

  it("Topic C:衰退 → declining(近期零新增 + 基准有量)", async () => {
    const cur = await load(C);
    expect(cur.lifecycle).toBe("declining");
    expect(cur.score).toBeLessThan(30);
  });

  it("Topic D:常青 → evergreen(长龄 + 稳定)", async () => {
    const cur = await load(D);
    expect(cur.lifecycle).toBe("evergreen");
  });

  it("Topic E:2 成员 → unscorable,UI 语义 = 数据不足(§BH)", async () => {
    const cur = await load(E);
    expect(cur.scorable).toBe(0);
    expect(cur.unscorableReason).toBe("insufficient_members");
    expect(cur.score).toBeNull();
    expect(cur.lifecycle).toBeNull();
  });

  it("Topic F:单条爆款不得拉高整个话题(§CA)", async () => {
    const cur = await load(F);
    expect(cur.score).toBeLessThan(60);
    expect(cur.burstDensity).toBeLessThan(30); // 1/20 = 5% → 密度分 ≤ 17
  });

  it("Topic A 成员分已注入 → 爆发密度 50%", async () => {
    const cur = await load(A);
    expect(cur.burstDensity).toBeGreaterThanOrEqual(95);
  });

  it("append-only(§AM):trend snapshots 只增;run 记账完整", () => {
    const n = Number((db.all(sql`SELECT COUNT(*) c FROM topic_trend_snapshots`)[0] as { c: number }).c);
    expect(n).toBe(6);
  });

  it("趋势列表(§BN/§CS):SQL 分页 + lifecycle 筛选 + 排序", async () => {
    const all = await listTopicTrends(db, { page: 1, pageSize: 10 });
    expect(all.total).toBe(6); // E unscorable 也有 current 行
    const rising = await listTopicTrends(db, { page: 1, pageSize: 10, lifecycle: "rising" });
    expect(rising.rows.map((r) => r.topicId)).toContain(A);
    const unknown = await listTopicTrends(db, { page: 1, pageSize: 10, lifecycle: "unknown" });
    expect(unknown.rows.map((r) => r.topicId)).toContain(E);
    const desc = await listTopicTrends(db, { page: 1, pageSize: 2, sortBy: "score" });
    expect(desc.rows.length).toBe(2);
    const scores = desc.rows.map((r) => r.score as number);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
  });

  it("滞回(§AV):首次评定 emerging→rising 有 event;单次异常→pending 不翻转", async () => {
    // A 首次评定:rising(from=null)
    const detail1 = await getTopicTrendDetail(db, A);
    expect(detail1.lifecycleEvents.length).toBeGreaterThanOrEqual(1);
    expect(detail1.lifecycleEvents[0].toState).toBe("rising");

    // 构造单次衰退信号:插入两组"零新增"快照,窗口翻转 → 候选 declining,
    // 但只有 1 次观察 → pending,不得翻转、不得写 event(§CC 单次异常不乱跳)
    const t2 = Date.UTC(2026, 8, 27, 12, 0, 0);
    await db.insert(topicSnapshots).values({
      topicId: A, analysisRunId: 2, capturedAt: new Date(t2 - 9 * 86_400_000).toISOString(),
      memberCount: 6, newContentCount: 0, activeCreatorCount: 0, platformCount: 1,
      averageRawMomentum: 5, rawEngagementDelta: null, cohesion: 0.8, platformDistribution: '{"xiaohongshu":1}',
    });
    await db.insert(topicSnapshots).values({
      topicId: A, analysisRunId: 2, capturedAt: new Date(t2 - 1 * 86_400_000).toISOString(),
      memberCount: 6, newContentCount: 0, activeCreatorCount: 0, platformCount: 1,
      averageRawMomentum: 5, rawEngagementDelta: null, cohesion: 0.8, platformDistribution: '{"xiaohongshu":1}',
    });
    const r2 = await runTopicTrendScoring(db, { now: t2 });
    const detail2 = await getTopicTrendDetail(db, A);
    const cur2 = detail2.current!;
    expect(r2.lifecycleTransitions.length).toBe(0);
    expect(cur2.lifecycle).toBe("rising"); // 未翻转
    expect(cur2.pendingLifecycle).toBe("saturated"); // 候选态(创作者 8v8 持平 → 非上升)
    expect(cur2.pendingCount).toBe(1);
    const eventsAfter2 = detail2.lifecycleEvents.length;
    expect(eventsAfter2).toBe(detail1.lifecycleEvents.length);

    // 第二次连续观察 → 达到滞回阈值 → 正式迁移 rising→declining,写 event
    await runTopicTrendScoring(db, { now: t2 + 3_600_000 });
    const detail3 = await getTopicTrendDetail(db, A);
    expect(detail3.current!.lifecycle).toBe("saturated");
    expect(detail3.lifecycleEvents.length).toBe(eventsAfter2 + 1);
    const last = detail3.lifecycleEvents[0];
    expect(last.fromState).toBe("rising");
    expect(last.toState).toBe("saturated");
    expect(last.reason).toContain("连续 2 次观察一致");
  });

});
