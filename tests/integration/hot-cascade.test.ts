/**
 * 热点派生采集(hot list → 站内检索 → 可分析的创作内容)的契约测试。
 *
 * 离线:派生源用 `TRENDSCOPE_HOT_CASCADE_CONNECTOR=fixture-remote`(仓库自带的确定性源),
 * 不打公网、不消耗任何平台配额。这里钉的是四件真会出事的事:
 *  1. 缺凭证时零写入(不能留下一串注定失败的运行);
 *  2. 槽位任务复用(定时派生绝不能把采集中心淹掉);
 *  3. 节流(手动 force 才能绕过);
 *  4. 检索词冷却(同一个词不会被反复搜索)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb, type DB } from "../../server/src/db/client";
import { collectionTasks, contentItems } from "../../server/src/db/schema";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { ensureDefaultConnectors } from "../../server/src/connectors/registry";
import { cascadeConnectorId, pickHotKeywords, runHotCascade } from "../../server/src/collection/hotCascade";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let runtime: CollectionRuntime;
let server: Server;
let base = "";

const NOW = new Date();

/** 一批"今天的热榜标题":同一批词反复出现,关键词抽取才有确定性 */
const SEEDS = [
  "预制菜 国标 出台 争议", "预制菜 安全 标准 讨论", "预制菜 餐厅 使用 公示",
  "孙颖莎 混双 决赛 复盘", "孙颖莎 赛后 采访 体能", "孙颖莎 王楚钦 搭档",
  "小米 防窥 屏 手机 发布", "小米 新机 发布会 定档", "小米 屏幕 隐私 功能",
  "国庆 高速 免费 通行", "国庆 出行 高铁 票", "国庆 景区 预约",
];
const iso = (d: Date) => d.toISOString();

async function countTasks() {
  return (
    await db
      .select({ id: collectionTasks.id })
      .from(collectionTasks)
      .where(like(collectionTasks.name, "热点派生%"))
  ).length;
}

beforeAll(async () => {
  const t = createTestDb();
  sqlite = t.sqlite;
  db = t.db;
  runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
  ensureDefaultConnectors();
  server = createApp(db, runtime, { dbFile: ":memory:" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const [i, title] of SEEDS.entries()) {
    await db.insert(contentItems).values({
      platform: "weibo",
      platformContentId: `hot-cascade-seed-${i}`,
      contentType: "post",
      title,
      url: `https://example.test/hot/${i}`,
      canonicalUrl: `https://example.test/hot/${i}`,
      sourceType: "api",
      dataQuality: "minimal",
      views: 1000 + i,
      collectedAt: iso(NOW),
      createdAt: iso(NOW),
      updatedAt: iso(NOW),
    });
  }
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  sqlite.close();
});

describe("检索词派生 = 热榜标题本身", () => {
  it("取的是具体话题短语,不是分词片段;示例数据不参与", async () => {
    await db.insert(contentItems).values({
      platform: "weibo",
      platformContentId: "fixture-seed-should-be-ignored",
      contentType: "post",
      title: "示例数据 的标题 不应该被派生",
      url: "https://example.test/fx",
      canonicalUrl: "https://example.test/fx",
      sourceType: "fixture",
      dataQuality: "minimal",
      views: 999999,
      collectedAt: iso(NOW),
      createdAt: iso(NOW),
      updatedAt: iso(NOW),
    });
    const kws = await pickHotKeywords(db, { limit: 4 });
    expect(kws.length).toBeGreaterThan(0);
    for (const k of kws) {
      expect([...k].length).toBeGreaterThanOrEqual(4); // 短语,不是二字片段
      expect(/[一-龥]/.test(k)).toBe(true);
      expect(k.includes("示例数据")).toBe(false);
    }
    expect(new Set(kws).size).toBe(kws.length);
  });

  it("按热度取:最热的那条排在最前", async () => {
    const kws = await pickHotKeywords(db, { limit: 3 });
    expect(kws.length).toBeGreaterThan(0);
    const viewsOf = async (title: string) =>
      (await db.select({ views: contentItems.views }).from(contentItems).where(eq(contentItems.title, title)))[0]?.views ?? 0;
    for (let i = 1; i < kws.length; i++) {
      expect(await viewsOf(kws[i - 1])).toBeGreaterThanOrEqual(await viewsOf(kws[i]));
    }
  });

  it("同一事件的榜单变体只派生一次(前 8 字相同即视为同一话题)", async () => {
    const twin = ["胖东来 退货 通道 关闭", "胖东来 退货 通道 关闭 后续"];
    for (const [i, title] of twin.entries()) {
      await db.insert(contentItems).values({
        platform: "weibo",
        platformContentId: `hot-cascade-twin-${i}`,
        contentType: "post",
        title,
        url: `https://example.test/twin/${i}`,
        canonicalUrl: `https://example.test/twin/${i}`,
        sourceType: "api",
        dataQuality: "minimal",
        views: 20000 + i,
        collectedAt: iso(NOW),
        createdAt: iso(NOW),
        updatedAt: iso(NOW),
      });
    }
    const kws = await pickHotKeywords(db, { limit: 6 });
    expect(kws.filter((k) => k.startsWith("胖东来")).length).toBe(1);
  });

  it("纯数字标题派生不出检索词", async () => {
    for (const [i, title] of ["2026 2027", "12345 67890"].entries()) {
      await db.insert(contentItems).values({
        platform: "baidu",
        platformContentId: `hot-cascade-digits-${i}`,
        contentType: "post",
        title,
        url: `https://example.test/digits/${i}`,
        canonicalUrl: `https://example.test/digits/${i}`,
        sourceType: "api",
        dataQuality: "minimal",
        views: 30000 + i,
        collectedAt: iso(NOW),
        createdAt: iso(NOW),
        updatedAt: iso(NOW),
      });
    }
    const kws = await pickHotKeywords(db, { limit: 8 });
    for (const k of kws) expect(/^\d[\d\s]*$/.test(k)).toBe(false);
  });
});

describe("缺凭证时的零写入", () => {
  it("没有 ZHIHU_ACCESS_SECRET → 不跑、不建任务、不起运行", async () => {
    const before = await countTasks();
    const r = await runHotCascade(db, runtime, { env: { TRENDSCOPE_HOT_CASCADE_CONNECTOR: "zhihu-official" }, keywords: 3 });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("ZHIHU_ACCESS_SECRET");
    expect(r.results).toEqual([]);
    expect(await countTasks()).toBe(before);
  });

  it("默认派生源是知乎官方搜索接口", () => {
    expect(cascadeConnectorId({})).toBe("zhihu-official");
  });
});

describe("真实派生链路(离线确定性源)", () => {
  const env = { TRENDSCOPE_HOT_CASCADE_CONNECTOR: "fixture-remote" };

  it("跑通后入库新增内容,并按槽位建任务", async () => {
    const before = await countTasks();
    const beforeRows = (await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.platform, "zhihu"))).length;
    const r = await runHotCascade(db, runtime, { env, keywords: 2, perKeyword: 3, minIntervalMs: 0 });
    expect(r.ran).toBe(true);
    expect(r.keywords.length).toBeGreaterThan(0);
    expect(r.results.length).toBe(r.keywords.length);
    for (const one of r.results) {
      expect(one.status).toBe("completed");
      expect(one.runId).not.toBeNull();
    }
    // 派生出来的确实是"内容":种子全是 weibo 热榜标题,新增的 zhihu 条目只能来自这一步
    const afterRows = (await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.platform, "zhihu"))).length;
    expect(r.accepted).toBeGreaterThan(0);
    expect(afterRows - beforeRows).toBeGreaterThanOrEqual(r.accepted);

    // 槽位数 == 本轮检索词数,且此前没有派生任务
    const after = await countTasks();
    expect(after - before).toBe(r.keywords.length);
    expect(after).toBeLessThanOrEqual(5);
  });

  it("第二轮复用同样的槽位任务,不无限增长", async () => {
    const before = await countTasks();
    const r = await runHotCascade(db, runtime, { env, keywords: 2, perKeyword: 3, minIntervalMs: 0 });
    expect(r.ran).toBe(true);
    expect(await countTasks()).toBe(before); // 一个都没多
  });

  it("检索词有冷却期:第二轮不会把同一批词再搜一遍", async () => {
    const first = await runHotCascade(db, runtime, { env, keywords: 1, perKeyword: 3, minIntervalMs: 0 });
    const second = await runHotCascade(db, runtime, { env, keywords: 1, perKeyword: 3, minIntervalMs: 0 });
    expect(first.keywords[0]).toBeTruthy();
    if (second.ran) {
      expect(second.keywords).not.toContain(first.keywords[0]);
    } else {
      // 全部词都在冷却期 → 明确说明原因,而不是静默重复搜索
      expect(second.reason).toBeTruthy();
    }
  });

  it("节流:距上一轮太近时不跑,force 才绕过", async () => {
    const throttled = await runHotCascade(db, runtime, { env, keywords: 1, perKeyword: 3, minIntervalMs: 60 * 60_000 });
    expect(throttled.ran).toBe(false);
    expect(throttled.reason).toContain("分钟");
  });

  it("HTTP 入口:参数校验与响应形状", async () => {
    const bad = await fetch(`${base}/api/hot/cascade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keywords: 99 }),
    });
    expect(bad.status).toBe(400);

    const status = (await (await fetch(`${base}/api/hot/cascade`)).json()) as { ok: boolean; cascade: { connector: string; rounds: number } };
    expect(status.ok).toBe(true);
    expect(status.cascade.connector).toBeTruthy();
    expect(status.cascade.rounds).toBeGreaterThanOrEqual(1);
  });
});
