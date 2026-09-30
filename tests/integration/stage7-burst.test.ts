/**
 * Stage 7 integration — Content Burst golden fixtures(§BY)+ missing-aware +
 * unscorable + versioning/append-only + 可复现性(§CD)。真实 SQLite(temp DB)。
 *
 * Case A 小账号短时异常增长 → 高分;B 大账号相对作者正常(creator 基线);
 * C 低互动;D 单快照(velocity unknown,置信度必降);E shares 缺失 vs F 真实 0
 * (null≠0 红线);另:无快照/全 null 指标/样本不足 → unscorable。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, contentMetricSnapshots, contentScoreCurrent, contentScoreSnapshots, scoringRuns } from "../../server/src/db/schema";
import { runContentScoring } from "../../server/src/scoring/service";
import { getContentScoreDetail, listContentScores } from "../../server/src/scoring/repository";

let db: DB;
afterAll(() => {
  const anyDb = db as unknown as { $client: { close(): void } };
  anyDb?.$client?.close();
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

let idSeq = 0;
async function insertItem(v: {
  platform?: string;
  contentType?: string;
  authorId?: string | null;
  publishedAt?: string | null;
}): Promise<number> {
  idSeq += 1;
  const ts = new Date(NOW).toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform: v.platform ?? "xiaohongshu",
      platformContentId: `s7-${idSeq}`,
      contentType: v.contentType ?? "question",
      title: `Stage7 内容 ${idSeq}`,
      text: "测试正文",
      hashtags: "[]",
      authorId: v.authorId ?? null,
      authorName: v.authorId ? `作者-${v.authorId}` : null,
      publishedAt: v.publishedAt === undefined ? h(48) : v.publishedAt,
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

type Metrics = { views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; favorites?: number | null; upvotes?: number | null };
async function insertSnapshot(itemId: number, at: string, m: Metrics): Promise<void> {
  await db.insert(contentMetricSnapshots).values({
    contentItemId: itemId,
    capturedAt: at,
    views: m.views ?? null,
    likes: m.likes ?? null,
    comments: m.comments ?? null,
    shares: m.shares ?? null,
    favorites: m.favorites ?? null,
    upvotes: m.upvotes ?? null,
    source: "test",
  });
}

/** 40 条同组背景内容(zhihu/question,1-3d 桶):低速正常增长,构成 cohort 分布。 */
async function seedBackground(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const id = await insertItem({});
    await insertSnapshot(id, h(47), { likes: 100, comments: 5, shares: 1, favorites: 2 });
    await insertSnapshot(id, h(1), { likes: 100 + i, comments: 5 + (i % 3), shares: 1, favorites: 2 });
  }
}

describe("Stage 7 Content Burst fixtures(§BY)", () => {
  let aId = 0, bId = 0, cId = 0, dId = 0, eId = 0, fId = 0;
  let noSnapId = 0, hotlistId = 0, weiboIds: number[] = [];
  let result: Awaited<ReturnType<typeof runContentScoring>>;

  const load = async (id: number) => {
    const detail = await getContentScoreDetail(db, id);
    return detail.current!;
  };

  beforeAll(async () => {
    ({ db } = createTestDb());
    await seedBackground();
    // Case A:小账号,6 小时内动量暴涨(likes +890 / comments +80)
    aId = await insertItem({ authorId: "A" });
    await insertSnapshot(aId, h(7), { likes: 10, comments: 1, shares: 0, favorites: 1 });
    await insertSnapshot(aId, h(1), { likes: 900, comments: 81, shares: 3, favorites: 20 });
    // Case B:大账号,绝对值高但相对作者历史正常(5 条历史各 ~10000)
    for (let i = 0; i < 5; i++) {
      const hid = await insertItem({ authorId: "BIG", publishedAt: h(24 * 60) });
      await insertSnapshot(hid, h(30 * 24), { likes: 9000, comments: 500, shares: 200, favorites: 300 });
      await insertSnapshot(hid, h(28 * 24), { likes: 9000 + i, comments: 500, shares: 200, favorites: 300 });
    }
    bId = await insertItem({ authorId: "BIG" });
    await insertSnapshot(bId, h(47), { likes: 9000, comments: 500, shares: 200, favorites: 300 });
    await insertSnapshot(bId, h(1), { likes: 9002, comments: 500, shares: 200, favorites: 300 });
    // Case C:低互动(真实 0 深互动)
    cId = await insertItem({ authorId: "C" });
    await insertSnapshot(cId, h(47), { likes: 3, comments: 0, shares: 0, favorites: 0 });
    await insertSnapshot(cId, h(1), { likes: 3, comments: 0, shares: 0, favorites: 0 });
    // Case D:只有 1 次快照(velocity unknown)
    dId = await insertItem({ authorId: "D" });
    await insertSnapshot(dId, h(1), { likes: 500, comments: 40, shares: 10, favorites: 25 });
    // Case E(shares 缺失)与 F(shares 真实 0):同作者、同形态双胞胎
    eId = await insertItem({ authorId: "E" });
    await insertSnapshot(eId, h(47), { likes: 400, comments: 40, shares: null, favorites: 20 });
    await insertSnapshot(eId, h(1), { likes: 500, comments: 50, shares: null, favorites: 20 });
    fId = await insertItem({ authorId: "E" });
    await insertSnapshot(fId, h(47), { likes: 400, comments: 40, shares: 0, favorites: 20 });
    await insertSnapshot(fId, h(1), { likes: 500, comments: 50, shares: 0, favorites: 20 });
    // 不可评分:无快照 / 全 null 指标(知乎热榜形态)/ 平台样本不足(weibo×3)
    noSnapId = await insertItem({});
    hotlistId = await insertItem({ platform: "zhihu" });
    await insertSnapshot(hotlistId, h(1), {});
    for (let i = 0; i < 3; i++) {
      const wid = await insertItem({ platform: "weibo", authorId: `W${i}` });
      await insertSnapshot(wid, h(47), { likes: 100, comments: 5, shares: 1, favorites: 2 });
      await insertSnapshot(wid, h(1), { likes: 110, comments: 6, shares: 1, favorites: 2 });
      weiboIds.push(wid);
    }
    result = await runContentScoring(db, { now: NOW });
  });

  it("Case A:短时异常增长 → 高分且 velocity 证据完整", async () => {
    const cur = await load(aId);
    expect(cur.scorable).toBe(1);
    expect(cur.overallScore).toBeGreaterThanOrEqual(85);
    const ev = JSON.parse(cur.evidence);
    expect(ev.velocity.primaryWindow).toBe("24h");
    expect(ev.cohort.level).toBe("exact");
  });

  it("Case B:大账号相对作者正常 → relativeBasis=creator,分位≈50(§O median)", async () => {
    const cur = await load(bId);
    expect(cur.scorable).toBe(1);
    const bd = JSON.parse(cur.breakdown);
    expect(bd.relativePerformance.available).toBe(true);
    expect(bd.relativePerformance.score).toBeGreaterThanOrEqual(45);
    expect(bd.relativePerformance.score).toBeLessThanOrEqual(55);
    const ev = JSON.parse(cur.evidence);
    expect(ev.creator.basis).toBe("creator");
    expect(cur.overallScore).toBeLessThan((await load(aId)).overallScore!);
  });

  it("Case C:低互动(真实 0)→ 分数显著低于 Case A,且不为 NaN", async () => {
    const cur = await load(cId);
    expect(cur.scorable).toBe(1);
    expect(cur.overallScore).not.toBeNull();
    expect(cur.overallScore).toBeLessThan(50);
    expect(cur.overallScore).toBeLessThan((await load(aId)).overallScore!);
  });

  it("Case D:单快照 → velocity 不可用 + 权重重归一 + 置信度非 high(§Z)", async () => {
    const cur = await load(dId);
    expect(cur.scorable).toBe(1);
    const bd = JSON.parse(cur.breakdown);
    expect(bd.velocity.available).toBe(false);
    const sum = Object.values(bd.weightsUsed).reduce((s: number, v) => s + (v as number), 0);
    expect(sum).toBeCloseTo(1, 2); // 权重展示值保留 3 位小数
    expect(cur.confidence).not.toBe("high");
  });

  it("Case E vs F:shares 缺失 → EQ 不可用;真实 0 → EQ 可用(null≠0 红线,§N)", async () => {
    const e = await load(eId);
    const f = await load(fId);
    const eb = JSON.parse(e.breakdown);
    const fb = JSON.parse(f.breakdown);
    expect(eb.engagementQuality.available).toBe(false);
    expect(fb.engagementQuality.available).toBe(true);
    expect(fb.engagementQuality.score).not.toBeNull();
    // E 的 overall 用重归一权重算出,不得等于 0,也不得等于 F(Evidence 可区分)
    expect(e.overallScore).not.toBeNull();
    expect(e.evidence).not.toBe(f.evidence);
  });

  it("不可评分:无快照 → insufficient_snapshots;全 null 指标 → insufficient_metrics(§BG)", async () => {
    const noSnap = await load(noSnapId);
    expect(noSnap.scorable).toBe(0);
    expect(noSnap.unscorableReason).toBe("insufficient_snapshots");
    expect(noSnap.overallScore).toBeNull();
    const hot = await load(hotlistId);
    expect(hot.scorable).toBe(0);
    expect(hot.unscorableReason).toBe("insufficient_metrics");
    expect(hot.overallScore).toBeNull();
  });

  it("不可评分:平台样本不足(weibo n=3 <5)→ insufficient_cohort(§K)", async () => {
    for (const wid of weiboIds) {
      const cur = await load(wid);
      expect(cur.scorable).toBe(0);
      expect(cur.unscorableReason).toBe("insufficient_cohort");
    }
  });

  it("Run 记账:version/configSnapshot/counts 正确(§AD)", () => {
    expect(result.scoreVersion).toBe("CONTENT_BURST_V1");
    expect(result.contentCount).toBe(56);
    expect(result.scorableCount).toBe(51);
    expect(result.unscorableBreakdown).toMatchObject({ insufficient_snapshots: 1, insufficient_metrics: 1, insufficient_cohort: 3 });
    const [run] = db.select().from(scoringRuns).all().slice(-1);
    expect(run.status).toBe("completed");
    const cfg = JSON.parse(run.configSnapshot);
    expect(cfg.burst.weights.velocity).toBe(0.35);
  });

  it("可复现性(§CD):同 DB 同 now 两次运行 → 分数逐位一致", async () => {
    const first = await listContentScores(db, { page: 1, pageSize: 100 });
    await runContentScoring(db, { now: NOW });
    const second = await listContentScores(db, { page: 1, pageSize: 100 });
    const key = (r: (typeof first.rows)[number]) => `${r.contentItemId}:${r.score}:${r.confidence}`;
    expect(second.rows.map(key).sort()).toEqual(first.rows.map(key).sort());
  });

  it("append-only(§AB):两次运行后 snapshots 双倍,current 只有最新", async () => {
    const snapCount = Number((db.all(sql`SELECT COUNT(*) c FROM content_score_snapshots`)[0] as { c: number }).c);
    const curCount = Number((db.all(sql`SELECT COUNT(*) c FROM content_score_current`)[0] as { c: number }).c);
    expect(snapCount).toBe(result.contentCount * 2);
    expect(curCount).toBe(result.contentCount);
  });

  it("列表查询(§CS):分页与 SQL 排序降序", async () => {
    const page1 = await listContentScores(db, { page: 1, pageSize: 10, scorable: "yes" });
    expect(page1.rows.length).toBe(10);
    expect(page1.total).toBe(51);
    const scores = page1.rows.map((r) => r.score as number);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("平台筛选(§CT)", async () => {
    const rows = await listContentScores(db, { page: 1, pageSize: 50, platform: "weibo" });
    expect(rows.total).toBe(3);
    expect(rows.rows.every((r) => r.scorable === 0)).toBe(true);
  });
});
