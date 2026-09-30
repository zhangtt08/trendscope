/**
 * 「一键抓热点」路由契约测试。
 *
 * 纪律:不访问公网。因此这里只测**校验分支与不产生写入**这两件事
 * (成功路径已在真机用知乎官方/B站公开接口验证过,数字记在 docs/TEST_STATUS.md);
 * 若将来接 replay 传输,可在此补成功分支。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { ensureDefaultConnectors } from "../../server/src/connectors/registry";
import { createTask } from "../../server/src/services/collection/service";
import { collectionRuns, collectionTasks } from "../../server/src/db/schema";
import { autoAnalysisSnapshot } from "../../server/src/analysis/autoAnalysis";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let runtime: CollectionRuntime;
let server: Server;
let base = "";

async function get(p: string) {
  const r = await fetch(base + p);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function send(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保留原文即可 */
  }
  return { status: r.status, body: json, text };
}

const counts = () => ({
  tasks: db.select().from(collectionTasks).all().length,
  runs: db.select().from(collectionRuns).all().length,
});

beforeAll(async () => {
  const t = createTestDb();
  sqlite = t.sqlite;
  db = t.db;
  runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
  ensureDefaultConnectors();
  const app = createApp(db, runtime, { dbFile: ":memory:" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  sqlite.close();
});

describe("GET /api/hot/channels", () => {
  it("返回全部预置渠道与拒绝清单,字段齐全", async () => {
    const r = await get("/api/hot/channels");
    expect(r.status).toBe(200);
    const keys = (r.body.channels as any[]).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["zhihu-hot", "bilibili-popular", "hn-front", "weibo-hot"]));
    // 渠道只增不减:新增的公开聚合源一旦回退,"没有多平台数据"会原样复现
    expect(keys).toEqual(
      expect.arrayContaining(["tieba-hot", "douban-movie-weekly", "douban-tv-weekly", "baidu-hot", "ithome-rank"]),
    );
    // 浏览器渠道也是交付的一部分:静默缺席就等于抖音又只剩话题了
    expect(keys).toContain("douyin-hot-videos");
    const list = r.body.channels as any[];
    for (const c of list) {
      expect(typeof c.label).toBe("string");
      expect(typeof c.note).toBe("string");
      expect(typeof c.available).toBe("boolean");
      if (c.onDemandOnly) {
        // 会弹窗口的渠道不进定时档:界面显示"按需",调度器永不拾取
        expect(c.intervalMinutes).toBeNull();
      } else {
        expect(c.intervalMinutes).toBeGreaterThanOrEqual(30);
      }
    }
    expect(list.filter((c) => c.onDemandOnly).length).toBeGreaterThan(0);
    // 明确写出"哪些平台不做、为什么",不能静默缺席
    expect((r.body.refused as any[]).length).toBeGreaterThan(0);
    expect(r.body.refused.every((x: any) => x.label && x.reason)).toBe(true);
  });

  it("微博渠道的可用性只由 WEIBO_COOKIE 决定", async () => {
    delete process.env.WEIBO_COOKIE;
    const off = await get("/api/hot/channels");
    const weiboOff = (off.body.channels as any[]).find((c) => c.key === "weibo-hot");
    expect(weiboOff.available).toBe(false);
    expect(weiboOff.requiresEnv).toBe("WEIBO_COOKIE");

    process.env.WEIBO_COOKIE = "fake=1";
    try {
      const on = await get("/api/hot/channels");
      expect((on.body.channels as any[]).find((c) => c.key === "weibo-hot").available).toBe(true);
    } finally {
      delete process.env.WEIBO_COOKIE;
    }
  });
});

describe("POST /api/hot/capture 的参数校验", () => {
  it("未知渠道 → 400,并且不创建任何任务或运行", async () => {
    const before = counts();
    const r = await send("POST", "/api/hot/capture", { channels: ["no-such-channel"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("存在未知渠道");
    const after = counts();
    expect(after).toEqual(before);
  });

  it("多余字段 → 400(strict schema,避免静默忽略拼写错误)", async () => {
    const r = await send("POST", "/api/hot/capture", { chnels: ["hn-front"] });
    expect(r.status).toBe(400);
  });

  it("渠道存在但都不在当前环境可用时,不产生任何写入", async () => {
    const before = counts();
    const r = await send("POST", "/api/hot/capture", { channels: ["weibo-hot"], analyze: false });
    expect(r.status).toBe(200);
    // weibo 需要 WEIBO_COOKIE;未配置时这一路必须被跳过而不是编造数据
    const rows = (r.body.channels as any[]).filter((c) => c.channel === "微博热搜");
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toContain("WEIBO_COOKIE");
    expect(r.body.accepted).toBe(0);
    const after = counts();
    // 缺凭证的渠道必须一条记录都不留:不建任务、不起运行
    expect(after.tasks).toBe(before.tasks);
    expect(after.runs).toBe(before.runs);
  });

  it("analyze:true 但没有新内容入库时,响应里的 analysis 必须说没触发", async () => {
    const beforeTriggers = autoAnalysisSnapshot().triggered;
    const r = await send("POST", "/api/hot/capture", { channels: ["weibo-hot"], analyze: true });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(0);
    expect(r.body.analysis).toMatchObject({ triggered: false, running: false });
    expect(autoAnalysisSnapshot().triggered).toBe(beforeTriggers);
  });
});

/**
 * 试采接口:配置不合法时必须 400 且**零写入** —— 它的定位就是"看一眼再保存",
 * 不该留下任务、运行记录或内容行。成功路径由 browser-connector 的契约测试与真机覆盖
 * (这里不启动真浏览器:测试纪律是不碰公网、不开窗口)。
 */
describe("POST /api/hot/browser-preview", () => {
  it("配置不合法 → 400,不创建任务也不写内容", async () => {
    const before = counts();
    const r = await send("POST", "/api/hot/browser-preview", { config: { url: "http://不是https.test", itemSelector: "li" } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("配置不合法");
    expect(counts()).toEqual(before);
  });

  it("缺 config → 400,同样零写入", async () => {
    const before = counts();
    const r = await send("POST", "/api/hot/browser-preview", {});
    expect(r.status).toBe(400);
    expect(counts()).toEqual(before);
  });
});

/**
 * 渠道任务的定时档。
 *
 * 实测:一键抓取建出来的 12 条渠道任务里有 7 条停在 schedule=manual,
 * 调度器永不拾取 —— 用户点完一次之后再也看不到新数据,表现就是"根本没有多平台数据"。
 * 这里用仓库自带的 fixture-remote 顶替同名渠道任务,离线跑真实代码路径
 * (findOrCreateTask 按任务名查找,不校验 config,所以顶替是可信的)。
 * 超时依据:capture 路由按 1 秒间隔轮询运行状态,单渠道最短约 1 秒。
 */
describe("POST /api/hot/capture 的定时档修复", () => {
  async function rawTask(name: string) {
    const [row] = await db.select().from(collectionTasks).where(eq(collectionTasks.name, name)).limit(1);
    return row ? { ...row, schedule: JSON.parse(String(row.schedule)) as { type: string; intervalMs?: number } } : null;
  }

  it("停在手动档的渠道任务会被升回 interval 档,且不会多建一条任务", async () => {
    const created = await createTask(db, runtime, {
      name: "热点渠道:B站热门",
      connectorId: "fixture-remote",
      collectionType: "hotlist",
      config: { platform: "bilibili", keyword: "hot", totalItems: 3, pageSize: 3, pageLimit: 1, latencyMs: 0 },
      schedule: { type: "manual" },
      enabled: true,
    });
    const before = counts();

    const r = await send("POST", "/api/hot/capture", { channels: ["bilibili-popular"], analyze: false });
    expect(r.status).toBe(200);
    expect((r.body.channels as any[])[0].status).not.toBe("skipped");

    const row = await rawTask("热点渠道:B站热门");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(created.id);
    expect(row!.schedule.type).toBe("interval");
    expect(row!.schedule.intervalMs).toBe(30 * 60_000);
    expect(row!.nextRunAt).not.toBeNull();
    expect(row!.enabled).toBe(1);

    const after = counts();
    expect(after.tasks).toBe(before.tasks);
  }, 20_000);

  it("用户自己调过的间隔不被覆盖回默认值", async () => {
    await createTask(db, runtime, {
      name: "热点渠道:百度热搜",
      connectorId: "fixture-remote",
      collectionType: "hotlist",
      config: { platform: "other", keyword: "hot", totalItems: 3, pageSize: 3, pageLimit: 1, latencyMs: 0 },
      schedule: { type: "interval", intervalMs: 90 * 60_000 },
      enabled: true,
    });
    const before = counts();

    const r = await send("POST", "/api/hot/capture", { channels: ["baidu-hot"], analyze: false });
    expect(r.status).toBe(200);

    const row = await rawTask("热点渠道:百度热搜");
    expect(row!.schedule.type).toBe("interval");
    expect(row!.schedule.intervalMs).toBe(90 * 60_000);
    expect(counts().tasks).toBe(before.tasks);
  }, 20_000);
});

/**
 * 进度端点的契约:使用者点「抓取热点」之后要能看见"第几条 / 已等多久",
 * 而不是盯着一句"抓取中…"猜十分钟(这是使用者的原话)。
 * 这里跑一次真实(桩数据)抓取,验证进度确实被路由更新过 ——
 * 漏掉 beginJob / markFinished 任何一处,这条就会红。
 */
describe("GET /api/hot/progress", () => {
  it("抓完之后:每条都有下落,任务标记结束,百分比到 100", async () => {
    await createTask(db, runtime, {
      name: "热点渠道:IT之家热榜",
      connectorId: "fixture-remote",
      collectionType: "hotlist",
      config: { platform: "other", keyword: "hot", totalItems: 3, pageSize: 3, pageLimit: 1, latencyMs: 0 },
      schedule: { type: "manual" },
      enabled: true,
    });

    const r = await send("POST", "/api/hot/capture", { channels: ["ithome-rank"], analyze: false });
    expect(r.status).toBe(200);

    const p = await get("/api/hot/progress");
    expect(p.status).toBe(200);
    const job = p.body.capture;
    expect(p.body.cascade).toBeNull();
    expect(job).not.toBeNull();
    expect(job.kind).toBe("capture");
    expect(job.total).toBe(1);
    expect(job.finishedAt).not.toBeNull();
    expect(job.percent).toBe(100);
    expect(job.done).toBe(job.total);
    // 结束后不该再有"正在采"或"排队中"残留
    expect(job.items.every((i: any) => i.state === "done" || i.state === "failed" || i.state === "skipped")).toBe(true);
    expect(String(job.items[0].detail)).toContain("入库");
    // 已经不在跑的那条渠道,进度里也不能出现"这一条已等了 N 毫秒"
    expect(job.currentLabel).toBeNull();
    expect(job.currentItemMs).toBe(0);
  }, 30_000);
});
