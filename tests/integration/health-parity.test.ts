/**
 * getDataHealth 合并查询的语义对照。
 *
 * 背景:/api/health 与 /api/analysis/status 每次都对 content_items 打聚合。此前是 4 条
 * 独立 count(*)(总览 / 缺发布时间 / 无任何指标 / 缺作者),冷库上这是首屏慢的主要来源。
 * 现在折成一次扫描:`SUM(col IS NULL)` 取代 `count(*) WHERE col IS NULL`。
 *
 * 这个测试就是那条"逐字段语义一字不差"的证据 —— 不是性能测试,是**正确性**测试:
 * 一旦有人把 AND 写成 OR、或漏掉 merged 排除,这里立刻变红。数值全部手算写死。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems } from "../../server/src/db/schema";
import { getDataHealth } from "../../server/src/services/healthService";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
const NOW = "2026-10-02T12:00:00.000Z";

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;

  const base = {
    sourceType: "manual",
    collectedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;

  const [a] = await db
    .insert(contentItems)
    .values({
      ...base,
      platform: "zhihu",
      platformContentId: "answer:parity-a",
      contentType: "answer",
      title: "甲",
      dataQuality: "complete",
      publishedAt: NOW,
      views: 5,
      authorName: "甲",
    })
    .returning({ id: contentItems.id });

  // 乙:发布时间缺 + 六个指标全缺 + 作者两列都缺 → 三个 missing 都 +1
  await db.insert(contentItems).values({
    ...base,
    platform: "weibo",
    platformContentId: "post:parity-b",
    contentType: "post",
    title: "乙",
    dataQuality: "minimal",
  });

  // 丁:发布时间有;views 缺但 likes 有 → 不算"无任何指标";作者有 → 三个 missing 都不 +1
  await db.insert(contentItems).values({
    ...base,
    platform: "weibo",
    platformContentId: "post:parity-d",
    contentType: "post",
    title: "丁",
    dataQuality: "partial",
    publishedAt: NOW,
    likes: 3,
    authorName: "丁",
  });

  // 丙:被并入甲 → 从所有聚合里排除(与合并前每条 count 的 WHERE 前缀一致)
  await db.insert(contentItems).values({
    ...base,
    platform: "zhihu",
    platformContentId: "answer:parity-c",
    contentType: "answer",
    title: "丙",
    dataQuality: "invalid",
    mergedIntoContentItemId: a.id,
  });
});

afterAll(() => sqlite?.close());

describe("合并成一次扫描后,四条 count 的结果必须与逐条扫描完全相同", () => {
  it("totalContent=3、三个 missing 各=1、byPlatform/byQuality 只统计未合并行", async () => {
    const h = await getDataHealth(db);
    expect(h.totalContent).toBe(3); // 甲/乙/丁;丙被合并排除
    expect(h.missingPublishedAt).toBe(1); // 乙
    expect(h.missingAnyMetric).toBe(1); // 乙(丁有 likes,故"全缺"不成立)
    expect(h.missingAuthor).toBe(1); // 乙
    // 分组也只含 3 条未合并行(丙不在)
    const platform = Object.fromEntries(h.byPlatform.map((p) => [p.platform, p.n]));
    expect(platform).toEqual({ zhihu: 1, weibo: 2 });
    const quality = Object.fromEntries(h.byQuality.map((q) => [q.quality, q.n]));
    expect(quality).toEqual({ complete: 1, minimal: 1, partial: 1 });
    expect(h.latestBatches).toEqual([]);
    expect(h.pendingDuplicateCandidates).toBe(0);
    expect(h.failedRawRows).toBe(0);
  });
});

describe("空库:SUM 的 NULL 必须折回 0,不能把'没有行'冒成 null", () => {
  it("全新测试库各项计数为 0,分组为空数组", async () => {
    const made = createTestDb();
    try {
      const h = await getDataHealth(made.db);
      expect(h.totalContent).toBe(0);
      expect(h.missingPublishedAt).toBe(0);
      expect(h.missingAnyMetric).toBe(0);
      expect(h.missingAuthor).toBe(0);
      expect(h.byPlatform).toEqual([]);
      expect(h.byQuality).toEqual([]);
    } finally {
      made.sqlite.close();
    }
  });
});
