/**
 * Agent 契约四端点的 HTTP 层测试(personal-agent-hub《AGENT_API_STANDARD.md》v1)。
 *
 * 为什么单独有一份:此前 http-contract.test.ts 覆盖了界面在用的一串 GET,但**四个契约
 * 端点一条测试都没有** —— 而它们恰恰是最容易被回归悄悄打挂的一类:
 *   ① 挂载顺序。`app.get("*")` 的 SPA 兜底会把任何未匹配路径返回 HTML。契约端点必须排在
 *      它之前,否则 curl POST /api/agent/tool 会拿到一整个 index.html,Agent 直接看不懂,
 *      而"看起来能跑"的界面完全不受影响 —— 只有 HTTP 层测得出来。
 *   ② 失败形状。契约要求失败也是 JSON `{ok:false,error:{code,message}}`,
 *      unknown_tool 还必须带机器可读的 `available` 数组(写在 message 里 Agent 解析不到)。
 *      这两种失败(缺参 bad_input / 未知工具 unknown_tool)一旦退化成 HTML 或缺 available,
 *      调用方就失去了自动纠正的出路。
 * 因此这里逐条断言状态码、content-type 必须是 JSON、以及成功/两种失败的确切形状。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { contentItems } from "../../server/src/db/schema";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let server: Server;
let base = "";
const NOW = "2026-10-02T12:00:00.000Z";

async function req(path: string, init?: RequestInit) {
  const r = await fetch(base + path, init);
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await r.json() : null;
  return { status: r.status, contentType: ct, body: body as Record<string, any> | null };
}
function postTool(payload: unknown) {
  return req("/api/agent/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;
  // 塞一条内容,让 overview / search 有真实数字可透出(而不是靠空库蒙混过关)。
  await db.insert(contentItems).values({
    platform: "zhihu",
    platformContentId: "answer:agent1",
    contentType: "answer",
    title: "契约测试内容",
    text: "正文",
    dataQuality: "partial",
    upvotes: 10,
    sourceType: "fixture",
    collectedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
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

describe("GET /api/health —— 契约信封 + 界面既有扁平字段,必须是 JSON", () => {
  it("ok:true + data.{project,version,agent_api,uptime_ms},且保留界面在读的 totalContent", async () => {
    const r = await req("/api/health");
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(true);
    expect(r.body?.data?.project).toBe("trendscope");
    expect(r.body?.data?.agent_api).toBe(1);
    expect(typeof r.body?.data?.version).toBe("string");
    expect(typeof r.body?.data?.uptime_ms).toBe("number");
    // 数据总览页一直在读顶层扁平字段(既有契约),这里不能因为加了信封就把它挤掉
    expect(r.body).toHaveProperty("totalContent");
    expect(typeof r.body.totalContent).toBe("number");
  });
});

describe("GET /api/agent/tools —— 契约本体,清单与 input_schema 同源透出", () => {
  it("返回 8 个工具,每个都带 name/description/input_schema/risk", async () => {
    const r = await req("/api/agent/tools");
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(true);
    const tools = r.body?.data as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(8);
    for (const t of tools as Record<string, any>[]) {
      expect(typeof t.name).toBe("string");
      expect(t.name.startsWith("trendscope.")).toBe(true);
      expect(typeof t.description).toBe("string");
      expect(t.input_schema).toBeTypeOf("object");
      expect(["read", "write", "exec"]).toContain(t.risk);
    }
    const names = (tools as { name: string }[]).map((t) => t.name);
    for (const need of [
      "trendscope.overview",
      "trendscope.search_contents",
      "trendscope.content_detail",
      "trendscope.list_topics",
      "trendscope.topic_detail",
      "trendscope.generate_plan",
      "trendscope.export_panel",
      "trendscope.scoring_profile",
    ]) {
      expect(names).toContain(need);
    }
  });
});

describe("GET /api/agent/manifest —— 项目身份 + base_url 只回环", () => {
  it("data.project/version/base_url/agent_api/tools 齐全,base_url 归一成 127.0.0.1", async () => {
    const r = await req("/api/agent/manifest");
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(true);
    expect(r.body?.data?.project).toBe("trendscope");
    expect(r.body?.data?.agent_api).toBe(1);
    expect(Array.isArray(r.body?.data?.tools)).toBe(true);
    // base_url 只回环:别的机器拿到这个地址应当连不上,这是设计意图
    expect(r.body?.data?.base_url).toContain("127.0.0.1");
  });
});

describe("POST /api/agent/tool —— 成功形状", () => {
  it("overview 走的是真实服务函数,返回 {ok,data,tool,ms} 且是 JSON", async () => {
    const r = await postTool({ tool: "trendscope.overview", input: {} });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(true);
    expect(r.body?.tool).toBe("trendscope.overview");
    expect(typeof r.body?.ms).toBe("number");
    // 数字来自本机 SQLite,不是示例数据:种子塞了 1 条内容,count 必须是 1
    expect(r.body?.data?.counts?.content_items).toBe(1);
    expect(r.body?.data?.project).toBe("trendscope");
  });

  it("scoring_profile 透出引擎当下在用的权重与口径(不是文档抄本)", async () => {
    const r = await postTool({ tool: "trendscope.scoring_profile", input: {} });
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    expect(r.body?.data?.content_burst?.weights).toBeTypeOf("object");
    expect(typeof r.body?.data?.config_snapshot).toBe("string");
    // 红线原样带给调用方:分数是对已观察数据的量化,不是爆款概率
    expect(JSON.stringify(r.body?.data?.red_line)).toContain("不是未来爆款概率");
  });
});

describe("POST /api/agent/tool —— 失败形状①:缺参 = bad_input,且仍是 JSON", () => {
  it("content_detail 缺 contentItemId → 400 {ok:false,error:{code:bad_input,message}}", async () => {
    const r = await postTool({ tool: "trendscope.content_detail", input: {} });
    expect(r.status).toBe(400);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error?.code).toBe("bad_input");
    expect(typeof r.body?.error?.message).toBe("string");
    expect(r.body?.error?.message).toContain("contentItemId");
  });

  it("连 tool 字段都没给 → 也是 bad_input,并给出可执行 hint", async () => {
    const r = await postTool({});
    expect(r.status).toBe(400);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.error?.code).toBe("bad_input");
    expect(typeof r.body?.error?.hint).toBe("string");
  });

  it("必填参数类型不对(字符串冒充整数 id)→ bad_input,不是 500", async () => {
    const r = await postTool({ tool: "trendscope.content_detail", input: { contentItemId: "abc" } });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe("bad_input");
  });
});

describe("POST /api/agent/tool —— 失败形状②:未知工具 = unknown_tool + available 数组", () => {
  it("不存在的工具名 → error.code=unknown_tool,且带机器可读的 available 清单", async () => {
    const r = await postTool({ tool: "trendscope.does_not_exist", input: {} });
    expect(r.status).toBe(400);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error?.code).toBe("unknown_tool");
    // available 必须是数组且列全本机 8 个工具 —— 这是调用方自我纠正的唯一出路
    expect(Array.isArray(r.body?.error?.available)).toBe(true);
    expect(r.body?.error?.available.length).toBe(8);
    expect(r.body?.error?.available).toContain("trendscope.overview");
  });
});

describe("真实 id 缺失 → not_found/404(不能把调用方的错说成服务器的错)", () => {
  it("content_detail 打一个不存在的 id → 404 {ok:false,error:{code:not_found}}", async () => {
    const r = await postTool({ tool: "trendscope.content_detail", input: { contentItemId: 999999 } });
    expect(r.status).toBe(404);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.error?.code).toBe("not_found");
    expect(typeof r.body?.error?.hint).toBe("string");
  });
});

describe("挂载顺序 —— agent 路径永远不能被 SPA 的 HTML 兜底吃掉", () => {
  it("GET /api/agent/tool(方法写错)→ 405 JSON,不是 index.html", async () => {
    const r = await req("/api/agent/tool");
    expect(r.status).toBe(405);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.ok).toBe(false);
    expect(r.body?.error?.code).toBe("bad_input");
  });

  it("GET /api/agent/bogus(路径拼错)→ 404 unknown_tool + available,绝不是 HTML", async () => {
    const r = await req("/api/agent/bogus");
    expect(r.status).toBe(404);
    expect(r.contentType).toContain("application/json");
    expect(r.body?.error?.code).toBe("unknown_tool");
    expect(Array.isArray(r.body?.error?.available)).toBe(true);
  });
});
