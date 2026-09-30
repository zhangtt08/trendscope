/**
 * WP2 完整产品工作流的契约测试(§32-§42)。
 *
 * 覆盖三件最容易出事的事:
 *  1. 状态端点必须诚实 —— 空库说"没有数据",而不是显示 0 或报 500;
 *  2. 一键全分析必须能显示"第几步 / 哪一步失败 / 为什么",并且前序结果保留;
 *  3. 演示模式的重置只能作用于演示库 —— 正式库必须被拒绝(这条不能靠约定,要有测试)。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { contentEmbeddings, contentItems, embeddingSpaces, topicMemberships, topics } from "../../server/src/db/schema";
import { LexicalFallbackEmbeddingProvider } from "../../server/src/semantic/lexicalProvider";
import { activateSpace, ensureSpace, upsertEmbedding } from "../../server/src/semantic/vectorRepository";
import { reapInterruptedRuns } from "../../server/src/analysis/repository";
import { beginRun, endRun } from "../../server/src/services/engineLock";

const NOW = "2026-09-26T12:00:00.000Z";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
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
    /* ignore */
  }
  return { status: r.status, body: json, text };
}

async function seedContent(n: number, sourceType = "manual") {
  for (let i = 0; i < n; i++) {
    await db.insert(contentItems).values({
      platform: "zhihu",
      platformContentId: `answer:wp2-${sourceType}-${i}`,
      contentType: "answer",
      title: `WP2 内容 ${i}`,
      text: "正文",
      dataQuality: "partial",
      upvotes: 10 + i,
      sourceType,
      publishedAt: NOW,
      collectedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;
  // 传入实例文件路径:/api/demo/status 的 dbDisplay 必须来自"当前实例",而不是写死的库名
  server = createApp(db, new CollectionRuntime(db), { dbFile: "data/trendscope.db" }).listen(0);
  await new Promise<void>((res) => server.once("listening", () => res()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  sqlite?.close();
});

beforeEach(() => {
  // 用例之间要一个干净的库。清空方式与演示重置走同一条路:事务内 defer_foreign_keys,
  // 并跳过 FTS 虚拟表/影子表(直接删它们 SQLite 会拒绝)。
  sqlite.pragma("foreign_keys = OFF");
  const virtual = (
    sqlite.prepare("select name from sqlite_master where type='table' and sql like 'CREATE VIRTUAL TABLE%'").all() as { name: string }[]
  ).flatMap((v) => [v.name, ...["_data", "_idx", "_docsize", "_config", "_content"].map((s) => v.name + s)]);
  const skip = new Set(["__drizzle_migrations", ...virtual]);
  const tables = (
    sqlite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as { name: string }[]
  ).filter((t) => !skip.has(t.name));
  for (const t of tables) sqlite.prepare(`delete from "${t.name}"`).run();
  sqlite.pragma("foreign_keys = ON");
  delete process.env.TRENDSCOPE_DEMO;
});

afterEach(() => {
  delete process.env.TRENDSCOPE_DEMO;
});

describe("GET /api/analysis/status(首页与引导的唯一真相源)", () => {
  it("空库:全 0 是真实计数,引导指向第一步,不是 500", async () => {
    const r = await get("/api/analysis/status");
    expect(r.status).toBe(200);
    expect(r.body.isEmpty).toBe(true);
    expect(r.body.data.contentTotal).toBe(0);
    expect(r.body.topics.total).toBe(0);
    expect(r.body.semantic.mode).toBe("none");
    expect(r.body.guide.map((g: { key: string; state: string }) => `${g.key}:${g.state}`)).toEqual([
      "data:todo",
      "semantic:todo",
      "topics:todo",
      "analysis:blocked",
      "studio:optional",
    ]);
    expect(r.body.guide.every((g: { detail: string }) => g.detail.length > 0)).toBe(true);
  });

  it("有内容无话题:分析步骤标 blocked,并说明原因;演示占比如实标出", async () => {
    await seedContent(3, "manual");
    await seedContent(2, "fixture");
    const r = await get("/api/analysis/status");
    expect(r.body.isEmpty).toBe(false);
    expect(r.body.data.contentTotal).toBe(5);
    expect(r.body.data.demoShare).toBe(40);
    expect(r.body.data.sourceKinds).toEqual({ manual: 3, fixture: 2 });
    expect(r.body.guide.find((g: { key: string }) => g.key === "data").state).toBe("done");
    const analysis = r.body.guide.find((g: { key: string }) => g.key === "analysis");
    expect(analysis.state).toBe("blocked");
    expect(analysis.detail).toContain("话题");
    expect(r.body.topics.unclustered).toBe(5);
  });

  it("未知指标保持 null,不折算成 0(§75)", async () => {
    await seedContent(1);
    const r = await get("/api/analysis/status");
    expect(r.body.data.latestCollectedAt).toBeTruthy();
    expect(r.body.data.latestRun).toBeNull();
    expect(r.body.topics.lastRun).toBeNull();
    expect(r.body.engines.topicTrend.lastCalculatedAt).toBeNull();
    expect(r.body.semantic.dimension).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain("NaN");
    expect(JSON.stringify(r.body)).not.toContain("null,\"\");");
  });

  it("「已建 / 待处理」与聚类用同一判据:只数激活空间里未作废的向量", async () => {
    await seedContent(3, "manual");
    const items = await db.select({ id: contentItems.id }).from(contentItems).orderBy(contentItems.id);
    const p = new LexicalFallbackEmbeddingProvider(512);
    const space = await ensureSpace(db, p);
    await activateSpace(db, space.id); // ensureSpace 只建不激活,判据读的是激活空间
    const vec = await p.embed("探针文本");
    for (const it of items.slice(0, 2)) {
      await upsertEmbedding(db, { contentItemId: it.id, space, textHash: `h-${it.id}`, vector: vec });
    }
    let r = await get("/api/analysis/status");
    expect(r.body.semantic.embedded).toBe(2);
    expect(r.body.semantic.pending).toBe(1);

    // 把其中一条标成作废(全量重建时上一句会做这件事)—— 它必须立刻重新算作"待处理"。
    // 旧实现数的是全表行数、pending 用不带过滤的 left join,于是这一步之后界面仍然显示
    // "2 条已建 / 0 条待处理",而聚类那边每轮报"有内容缺少向量"并失败。
    await db
      .update(contentEmbeddings)
      .set({ supersededAt: new Date().toISOString() })
      .where(eq(contentEmbeddings.contentItemId, items[0].id));
    r = await get("/api/analysis/status");
    expect(r.body.semantic.embedded).toBe(1);
    expect(r.body.semantic.pending).toBe(2);
  });

  it("凭证缺失只报告状态,不回显任何密钥", async () => {
    const r = await get("/api/analysis/status");
    expect(r.body.data.zhihuCredential).toBe("missing");
    expect(r.body.semantic.embeddingCredential).toBe("missing");
    expect(r.body.studio.secretStatus).toBe("missing");
    expect(JSON.stringify(r.body)).not.toMatch(/sk-/);
  });
});

describe("POST /api/analysis/full-refresh(§37-§39)", () => {
  it("无话题时按序跳过不适用的步骤,并给出可执行原因", async () => {
    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(r.status).toBe(200);
    // 跳过不是失败:流水线把能做的都做了,状态是 completed,但每一步的跳过原因必须可见
    expect(r.body.status).toBe("completed");
    expect(r.body.error).toBeNull();
    const byKey = Object.fromEntries(r.body.steps.map((s: { key: string }) => [s.key, s]));
    expect(byKey.embedding.state).toBe("completed");
    expect(byKey.topics.state).toBe("skipped");
    expect(byKey.topics.error).toContain("还没有内容");
    expect(byKey.trend.state).toBe("skipped");
    expect(byKey.trend.error).toContain("话题");
    expect(byKey.opportunity.state).toBe("skipped");
    // 顶层仍保留旧契约的引擎结果键(此前有测试断言 scoring/trend 形状)
    expect(r.body.scoring).toBeTypeOf("object");
  });

  it("进度落库可轮询,并保留最近一次运行", async () => {
    await seedContent(2);
    const r = await send("POST", "/api/analysis/full-refresh", { wait: true, trigger: "first-run" });
    expect(r.status).toBe(200);
    const latest = await get("/api/analysis/full-refresh/latest");
    expect(latest.status).toBe(200);
    expect(latest.body.run.id).toBe(r.body.runId);
    expect(latest.body.run.status).toBe(r.body.status);
    expect(latest.body.run.steps.length).toBe(6);
    expect(latest.body.run.currentStep).toBeNull();
    expect(latest.body.run.triggerSource).toBe("first-run");
    const one = await get(`/api/analysis/runs/${r.body.runId}`);
    expect(one.status).toBe(200);
    expect(one.body.run.startedAt).toBeTruthy();
  });

  it("有未归类内容时全分析会增量归入(新采内容不再被挡在分析链之外)", async () => {
    await seedContent(2);
    await db.insert(topics).values({
      name: "人工命名的话题",
      status: "active",
      embeddingSpaceId: "lexical-hash:zh-lexical-v1:512:semantic-v1",
      namingSource: "manual",
      memberCount: 0,
      keywords: "[]",
      hashtags: "[]",
      representativeItemIds: "[]",
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    const topicsStep = r.body.steps.find((s: { key: string }) => s.key === "topics");
    expect(topicsStep.state).toBe("completed");

    // 不变量:增量归入不覆盖人工治理结果 —— 话题名与命名来源保持不变
    const kept = await db.select().from(topics).where(eq(topics.name, "人工命名的话题"));
    expect(kept.length).toBe(1);
    expect(kept[0].namingSource).toBe("manual");
  });

  it("话题齐全且没有未归类内容时,全分析不动聚类结构", async () => {
    // 自建夹具:每条内容都已归入一个人工锁定的话题 → 没有未归类内容
    await seedContent(2);
    const [tp] = await db
      .insert(topics)
      .values({
        name: "已归齐的话题",
        status: "active",
        embeddingSpaceId: "lexical-hash:zh-lexical-v1:512:semantic-v1",
        namingSource: "manual",
        memberCount: 0,
        keywords: "[]",
        hashtags: "[]",
        representativeItemIds: "[]",
        firstObservedAt: NOW,
        lastObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: topics.id });
    const topicId = tp.id;
    const contents = await db.select({ id: contentItems.id }).from(contentItems);
    expect(contents.length).toBeGreaterThan(0);
    for (const c of contents) {
      await db.insert(topicMemberships).values({
        topicId,
        contentItemId: c.id,
        assignmentMethod: "manual",
        manualLock: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    await db.update(topics).set({ memberCount: contents.length }).where(eq(topics.id, topicId));

    const before = Number((sqlite.prepare("select count(*) c from topic_analysis_runs").get() as { c: number }).c);
    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    const topicsStep = r.body.steps.find((s: { key: string }) => s.key === "topics");
    expect(topicsStep.state).toBe("skipped");
    expect(topicsStep.error).toContain("没有未归类内容");
    const after = Number((sqlite.prepare("select count(*) c from topic_analysis_runs").get() as { c: number }).c);
    expect(after).toBe(before);
  });

  it("话题步骤失败时整轮必须记为 partial,不能挂着 completed 收官", async () => {
    // 复现真机事故:一键抓多平台时,采集运行与自动分析并行收尾,聚类开始之后落库的内容
    // 还没有向量。此前话题分析把 status:"failed" 放进返回值就正常 return,于是
    // 流水线、autoAnalysis.lastStatus 全说"已完成",而话题表里是 failed + 0 个话题。
    await seedContent(2);
    await db.update(embeddingSpaces).set({ isActive: 0 });
    await db.insert(embeddingSpaces).values({
      id: "openai-compatible:test-large:1024:semantic-v1",
      provider: "openai-compatible",
      model: "test-large",
      dimension: 1024,
      textBuilderVersion: "semantic-v1",
      mode: "api",
      isActive: 1,
      createdAt: NOW,
    });

    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.body.steps.map((s: { key: string }) => [s.key, s]));
    expect(byKey.topics.state).toBe("failed");
    expect(byKey.topics.error).toContain("缺少向量");
    // 前面的步骤再成功,也不能把整轮抬成 completed
    expect(r.body.status).toBe("partial");
    expect(r.body.error).toContain("缺少向量");
    // 失败之后的步骤不许拿"没聚出话题"的库继续算趋势
    expect(byKey.trend.state).not.toBe("completed");

    // 失败原因必须留在话题分析历史里,而不只活在流水线文案中
    const failed = sqlite
      .prepare("SELECT error FROM topic_analysis_runs WHERE status='failed' ORDER BY id DESC LIMIT 1")
      .get() as { error: string } | undefined;
    expect(failed?.error).toContain("缺少向量");
  });

  it("非法 body → 400;不存在的运行 → 404;非法 id → 400", async () => {
    expect((await send("POST", "/api/analysis/full-refresh", { wait: true, extra: 1 })).status).toBe(400);
    expect((await send("POST", "/api/analysis/full-refresh", { trigger: "nope" })).status).toBe(400);
    expect((await get("/api/analysis/runs/999999")).status).toBe(404);
    expect((await get("/api/analysis/runs/abc")).status).toBe(400);
    expect((await get("/api/analysis/full-refresh/latest")).status).toBe(200);
  });

  it("引擎被占用时提交被拒绝(§72)", async () => {
    await seedContent(2);
    // 小数据下整条流水线只要几毫秒,靠两个请求撞车来测锁会时灵时不灵;
    // 直接占住锁再提交,测的才是锁本身而不是时序运气。
    expect(beginRun(["content", "trend", "intelligence", "opportunity"])).toEqual({ ok: true });
    const second = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("正在运行中");
    endRun(["content", "trend", "intelligence", "opportunity"]);
    const third = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(third.status).toBe(200);
  });
});

describe("演示模式(§34/§35)", () => {
  it("正式模式:状态说清楚,load/reset 一律 409,不会碰到正式库", async () => {
    await seedContent(4, "manual");
    const s = await get("/api/demo/status");
    expect(s.status).toBe(200);
    expect(s.body.demoMode).toBe(false);
    // 回归:这里曾经固定返回 trendscope-demo.db,正式实例会误报自己在用演示库
    expect(s.body.dbDisplay.replaceAll("\\", "/")).toBe("data/trendscope.db");
    expect(s.body.contentTotal).toBe(4);
    expect(Array.isArray(s.body.availableFixtures)).toBe(true);

    const load = await send("POST", "/api/demo/load", { confirm: "LOAD_DEMO" });
    expect(load.status).toBe(409);
    expect(load.body.error).toContain("演示");
    const reset = await send("POST", "/api/demo/reset", { confirm: "RESET_DEMO" });
    expect(reset.status).toBe(409);
    expect(sqlite.prepare("select count(*) c from content_items").get()).toEqual({ c: 4 });
  });

  it("缺显式确认时先拒 400(不允许一个 GET 式误点毁数据)", async () => {
    expect((await send("POST", "/api/demo/reset", {})).status).toBe(400);
    expect((await send("POST", "/api/demo/load", {})).status).toBe(400);
    expect((await send("POST", "/api/demo/reset", { confirm: "RESET" })).status).toBe(400);
  });

  // 这两条用例要把整个示例语料库(约 5300 行)走一遍真实导入管线:逐行 dedup + 多次插入,
  // 实测单遍 13s、装载+重置 21s(WAL+synchronous=NORMAL 之后;FULL 时是 15s / 29.7s —— 已经贴到 vitest 默认 30s 上限并真超时过一次)。
  // 超时给到 90s 是留给"套件与本机应用争 CPU"的余量,不是为了掩盖变慢。
  it("演示模式:装载内置示例数据,内容全部标记为演示来源", { timeout: 90_000 }, async () => {
    process.env.TRENDSCOPE_DEMO = "1";
    const s = await get("/api/demo/status");
    expect(s.body.demoMode).toBe(true);
    const load = await send("POST", "/api/demo/load", { confirm: "LOAD_DEMO" });
    expect(load.status).toBe(200);
    expect(load.body.loaded).toBeGreaterThan(0);
    const after = await get("/api/demo/status");
    expect(after.body.fixtureRows).toBeGreaterThan(0);
    expect(after.body.contentTotal).toBe(after.body.fixtureRows);
    const batches = sqlite.prepare("select name from import_batches order by id").all() as { name: string }[];
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((b) => b.name.startsWith("演示数据:"))).toBe(true);
  });

  it("演示模式 reset:清空后重新装载,不会留下半空状态", { timeout: 90_000 }, async () => {
    process.env.TRENDSCOPE_DEMO = "1";
    await send("POST", "/api/demo/load", { confirm: "LOAD_DEMO" });
    const r = await send("POST", "/api/demo/reset", { confirm: "RESET_DEMO" });
    expect(r.status).toBe(200);
    expect(r.body.reloaded).toBeGreaterThan(0);
    const after = await get("/api/demo/status");
    expect(after.body.contentTotal).toBe(after.body.fixtureRows);
    expect(after.body.replayRows).toBe(0);
  });
});

describe("启动清理", () => {
  it("上次进程中断留下的 running 记录会被标成失败(UI 不会永远转圈)", async () => {
    await send("POST", "/api/analysis/full-refresh", { wait: true });
    sqlite.prepare("update analysis_runs set status = 'running', finished_at = null, error = null").run();
    expect((await get("/api/analysis/full-refresh/latest")).body.run.status).toBe("running");
    const n = await reapInterruptedRuns(db);
    expect(n).toBe(1);
    const after = await get("/api/analysis/full-refresh/latest");
    expect(after.body.run.status).toBe("failed");
    expect(after.body.run.error).toContain("未正常结束");
    expect(await reapInterruptedRuns(db)).toBe(0);
  });

  it("analysis_runs 不引用任何业务表,但也不能被写坏:steps 必须是合法 JSON 数组", async () => {
    await send("POST", "/api/analysis/full-refresh", { wait: true });
    const rows = sqlite.prepare("select steps from analysis_runs").all() as { steps: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const parsed = JSON.parse(r.steps);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.every((s: { state: string }) => ["pending", "running", "completed", "failed", "skipped"].includes(s.state))).toBe(true);
    }
    void sql;
  });
});
