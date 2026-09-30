/**
 * HTTP 层契约测试。
 *
 * 存在理由:此前没有任何测试经过 HTTP。365 个绿灯与下面这些真实故障共存 ——
 *   · UI 用 POST 打只注册了 PUT 的 /topics/:id/watch  -> 404,按钮永远无效
 *   · UI 用 DELETE /topics/:id/move-content/:itemId,服务端要的是 JSON body -> 404
 *   · /trends/topics?minOpportunity=N -> 500(count 查询缺 join)
 *   · 非法查询参数 -> 500(应为 400)
 *   · 文档里的 /api/analysis/full-refresh 实际挂在 /api/full-refresh -> 404
 * 因此这里按"前端实际会打的每一个端点"逐一断言状态码与响应形状。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { contentItems, topics, topicMemberships } from "../../server/src/db/schema";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let server: Server;
let base = "";

const NOW = "2026-09-25T12:00:00.000Z";

async function seed() {
  const info = await db
    .insert(contentItems)
    .values({
      platform: "zhihu",
      platformContentId: "answer:http1",
      contentType: "answer",
      title: "契约测试内容",
      text: "正文",
      dataQuality: "partial",
      upvotes: 10,
      sourceType: "fixture",
      collectedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: contentItems.id });
  const itemId = info[0].id;
  const t = await db
    .insert(topics)
    .values({
      name: "契约测试话题",
      status: "active",
      embeddingSpaceId: "lexical-hash:zh-lexical-v1:512:semantic-v1",
      namingSource: "keyword",
      memberCount: 1,
      keywords: "[]",
      hashtags: "[]",
      representativeItemIds: "[]",
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: topics.id });
  const topicId = t[0].id;
  await db.insert(topicMemberships).values({
    topicId,
    contentItemId: itemId,
    assignmentMethod: "auto",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { itemId, topicId };
}

async function get(p: string) {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function send(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let topicId = 0;
let itemId = 0;

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;
  const s = await seed();
  topicId = s.topicId;
  itemId = s.itemId;
  const runtime = new CollectionRuntime(db);
  server = createApp(db, runtime).listen(0);
  await new Promise<void>((res) => server.once("listening", () => res()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  sqlite?.close();
});

describe("前端实际调用的每个 GET 端点都必须存在(不是 404)且不崩(不是 500)", () => {
  const paths: [string, string[]][] = [
    ["/api/health", ["totalContent"]],
    ["/api/stats", ["totalContent", "byPlatform"]],
    ["/api/fixtures", ["fixtures"]],
    ["/api/content?pageSize=2", ["rows", "total", "page", "pageSize"]],
    ["/api/duplicates", ["rows"]],
    ["/api/import/batches", ["rows"]],
    ["/api/trends/overview", ["windowDays", "buckets"]],
    ["/api/trends/momentum?pageSize=3", ["rows", "total"]],
    ["/api/trends/topics?pageSize=3", ["rows", "total"]],
    ["/api/trends/contents?pageSize=3", ["rows", "total"]],
    ["/api/picks?pageSize=5", ["rows", "total", "counts"]],
    ["/api/collection/connectors", ["rows"]],
    ["/api/collection/tasks", ["rows"]],
    ["/api/collection/runs?pageSize=3", ["rows", "total"]],
    ["/api/collection/stats", ["activeTasks", "runsToday"]],
    ["/api/embedding/spaces", ["rows"]],
    ["/api/embedding/jobs?pageSize=3", ["rows", "page"]],
    ["/api/embedding/settings", ["activeSpaceId", "provider", "lexical", "api"]],
    ["/api/studio/settings", ["configured", "provider", "baseUrl", "model", "secretStatus", "secretSource", "promptVersion", "schemaVersion", "evidenceVersion"]],
    ["/api/studio/topics?pageSize=5", ["topics"]],
    ["/api/studio/topics/{topic}/marks", ["marks"]],
    ["/api/topics?pageSize=3", ["rows"]],
    ["/api/topics/unclustered?limit=3", ["rows"]],
    ["/api/topic-analysis-runs", ["rows"]],
    ["/api/scoring/profile", ["burst", "trend", "lifecycle"]],
    ["/api/scoring/runs", ["rows"]],
    ["/api/intelligence/runs", ["rows"]],
    ["/api/opportunity/profile", ["profiles"]],
    ["/api/opportunity/runs", ["rows"]],
    ["/api/opportunity/topics?pageSize=5", ["rows", "total"]],
    ["/api/topics/{topic}/patterns", ["rows"]],
    ["/api/topics/{topic}/angles", ["rows"]],
    ["/api/content/{item}/similar?topK=3", ["hits", "mode"]],
    ["/api/content/{item}/embedding-status", ["space", "embeddings"]],
  ];

  for (const [tpl, keys] of paths) {
    it(`GET ${tpl}`, async () => {
      // id 在 beforeAll 里才确定,所以模板要到执行时才展开
      const p = tpl.replace("{topic}", String(topicId)).replace("{item}", String(itemId));
      const r = await get(p);
      expect(r.status, `${p} -> ${JSON.stringify(r.body)}`).toBe(200);
      for (const k of keys) expect(r.body).toHaveProperty(k);
    });
  }
});

describe("跑完引擎后,评分/情报/趋势端点必须返回数据(而不是 404)", () => {
  beforeAll(async () => {
    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(r.status).toBe(200);
  });

  const afterRun: [string, string[]][] = [
    ["/api/topics/{topic}/trend", ["current", "history", "lifecycleEvents"]],
    ["/api/topics/{topic}/saturation", ["current", "history"]],
    ["/api/topics/{topic}/novelty", ["current", "history"]],
    ["/api/intelligence/content/{item}/features", []],
    ["/api/scoring/content/{item}", ["current", "history"]],
    ["/api/opportunity/topics/{topic}", ["current", "history", "decision"]],
    ["/api/studio/topics/{topic}", ["brief", "evidence", "settings", "versions", "history"]],
    ["/api/trends/topics?minOpportunity=0", ["rows", "total"]],
  ];
  for (const [tpl, keys] of afterRun) {
    it(`GET ${tpl}`, async () => {
      const p = tpl.replace("{topic}", String(topicId)).replace("{item}", String(itemId));
      const r = await get(p);
      expect(r.status, `${p} -> ${JSON.stringify(r.body)}`).toBe(200);
      for (const k of keys) expect(r.body).toHaveProperty(k);
    });
  }
});

describe("动词与路径必须和前端调用一致", () => {
  it("watch 是 PUT(前端已从 POST 改为 PUT)", async () => {
    expect((await send("PUT", `/api/topics/${topicId}/watch`, { state: "watching" })).status).toBe(200);
    // 旧的 POST 调用会得到 404 —— 这正是当初按钮失效的原因
    expect((await send("POST", `/api/topics/${topicId}/watch`, { state: "watching" })).status).toBe(404);
  });

  it("移出话题是 DELETE + JSON body(不是路径参数)", async () => {
    const ok = await send("DELETE", `/api/topics/${topicId}/move-content`, { contentItemId: itemId });
    expect(ok.status).toBe(200);
    expect((await send("DELETE", `/api/topics/${topicId}/move-content/${itemId}`)).status).toBe(404);
  });

  it("watch 可以清除(state=none),不是一旦标了就撤不掉", async () => {
    expect((await send("PUT", `/api/topics/${topicId}/watch`, { state: "review" })).status).toBe(200);
    const listed = await get("/api/topics?pageSize=10");
    const row = (listed.body.rows as { id: number; watchState: string | null }[]).find((r) => r.id === topicId);
    expect(row?.watchState).toBe("review");

    expect((await send("PUT", `/api/topics/${topicId}/watch`, { state: "none" })).status).toBe(200);
    const after = await get("/api/topics?pageSize=10");
    const row2 = (after.body.rows as { id: number; watchState: string | null }[]).find((r) => r.id === topicId);
    expect(row2?.watchState ?? null).toBeNull();
  });

  it("未知 watch 值仍被拒绝", async () => {
    expect((await send("PUT", `/api/topics/${topicId}/watch`, { state: "bogus" })).status).toBe(400);
  });

  it("文档承诺的 /api/analysis/full-refresh 必须可达", async () => {
    const r = await send("POST", "/api/analysis/full-refresh", { wait: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scoring: expect.any(Object), trend: expect.any(Object) });
  });
});

describe("参数错误必须是 400,不能伪装成服务器故障", () => {
  const bad = [
    "/api/opportunity/topics?minOpportunity=abc",
    "/api/opportunity/topics?pageSize=0",
    "/api/trends/topics?minScore=abc",
    "/api/scoring/content/notanumber",
    "/api/opportunity/topics/notanumber",
    "/api/studio/topics/notanumber",
    "/api/studio/topics/notanumber/marks",
  ];
  for (const p of bad) {
    it(`GET ${p} -> 400`, async () => {
      const r = await get(p);
      expect(r.status).toBe(400);
      expect(typeof r.body?.error).toBe("string");
    });
  }

  it("生成记录的标记接口:非法 id 与非法状态值都是 400(不是 500)", async () => {
    expect((await send("POST", "/api/studio/runs/notanumber/mark", { state: "saved" })).status).toBe(400);
    expect((await send("POST", `/api/studio/runs/1/mark`, { state: "publish" })).status).toBe(400);
    // 未配置的 AI 服务:诚实拒绝,并点名缺少哪个环境变量
    const gen = await send("POST", `/api/studio/topics/${topicId}/generate`, {});
    expect([200, 409, 502]).toContain(gen.status);
    if (gen.status === 409) expect(String(gen.body.error)).toContain("STUDIO_API_KEY");
  });

  it("决策枚举与长度受校验", async () => {
    expect((await send("PATCH", `/api/opportunity/topics/${topicId}/decision`, { status: "garbage" })).status).toBe(400);
    expect((await send("PATCH", `/api/opportunity/topics/${topicId}/decision`, { status: "reviewing", note: "x".repeat(400) })).status).toBe(400);
  });
});

describe("回归:曾经 500 或静默错误的查询", () => {
  it("/trends/topics?minOpportunity 不再因缺 join 而 500", async () => {
    const r = await get("/api/trends/topics?minOpportunity=1");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rows)).toBe(true);
  });

  it("minOpportunity 的 total 与 rows 用同一组 join(不再自相矛盾)", async () => {
    const all = await get("/api/trends/topics?pageSize=50");
    const filtered = await get("/api/trends/topics?minOpportunity=99&pageSize=50");
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBeLessThanOrEqual(all.body.total);
    expect(filtered.body.rows.length).toBe(filtered.body.total);
  });

  it("move-content 拒绝不存在的条目,不制造孤儿 membership", async () => {
    const before = sqlite.prepare("select count(*) c from topic_memberships").get().c;
    const r = await send("POST", `/api/topics/${topicId}/move-content`, { contentItemId: 999999 });
    expect(r.status).toBe(404);
    const after = sqlite.prepare("select count(*) c from topic_memberships").get().c;
    expect(after).toBe(before);
  });

  it("日期上界包含结束当天(SQLite 字符串比较陷阱)", async () => {
    sqlite.prepare("update content_items set published_at=? where id=?").run("2024-05-01T08:34:37Z", itemId);
    const hit = await get("/api/content?publishedFrom=2024-05-01&publishedTo=2024-05-01");
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);
  });

  it("embedding/settings 在只有词法空间时不得谎报 openai-compatible", async () => {
    const r = await get("/api/embedding/settings");
    expect(r.body.provider).toBe("lexical");
  });

  it("分页参数被夹取,不会把全表倒出来", async () => {
    const r = await get("/api/content?pageSize=99999");
    expect(r.status).toBe(200);
    expect(r.body.pageSize).toBeLessThanOrEqual(100);
  });
});

describe("MomentumTable 契约(表头列数必须等于单元格数)", () => {
  it("动量行提供 UI 渲染的每个字段", async () => {
    const r = await get("/api/trends/momentum?pageSize=5");
    expect(r.status).toBe(200);
    for (const row of r.body.rows) {
      for (const k of ["itemId", "title", "platform", "contentType", "delta", "daily", "engagement", "rawMomentumScore", "topic", "last", "unknownComponents"]) {
        expect(row, `row missing ${k}`).toHaveProperty(k);
      }
      expect(row.delta).toHaveProperty("upvotes");
      // topic 为空时 UI 渲染"未归类",非空时必须有 id 供深链
      if (row.topic) expect(typeof row.topic.id).toBe("number");
    }
  });
});

describe("示例导入不得无声写进正式库(2026-09-28 数据污染事故的守卫)", () => {
  it("非演示库 + 无显式确认 → 409,并说清怎么才可以", async () => {
    const list = await get("/api/fixtures");
    const file = (list.body.fixtures ?? list.body.rows ?? [])[0]?.file ?? (list.body.fixtures ?? [])[0];
    expect(typeof file).toBe("string");
    const before = (await get("/api/stats")).body.totalContent;
    const r = await send("POST", "/api/import/fixture", { file });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("不是演示库");
    expect((await get("/api/stats")).body.totalContent).toBe(before); // 被拒就不能写进任何东西
  });

  it("带显式确认 → 允许入库(界面按钮正是这么调的)", async () => {
    const list = await get("/api/fixtures");
    const file = (list.body.fixtures ?? list.body.rows ?? [])[0]?.file ?? (list.body.fixtures ?? [])[0];
    const r = await send("POST", "/api/import/fixture", { file, confirm: "LOAD_SAMPLE_INTO_CURRENT_DB" });
    expect(r.status).toBe(200);
  });
});
