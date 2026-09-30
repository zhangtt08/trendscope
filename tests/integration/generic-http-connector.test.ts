/**
 * 通用 HTTP 连接器契约测试 —— 全部走注入的 replay transport,不碰公网,不使用真实密钥。
 * 覆盖:条目定位、翻页(页码/游标)、页数上限、鉴权引用解析、密钥脱敏、
 * 错误分类(429/5xx/401)、配置错误的中文说明,以及 mapping + 平台归属的真实入库路径。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems } from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { createTask } from "../../server/src/services/collection/service";
import { ConnectorError, type RemotePageRequest } from "../../server/src/domain/collection";
import { GenericHttpConnector, GENERIC_HTTP_CONNECTOR_ID } from "../../server/src/connectors/genericHttp";
import type { ConnectorRunContext } from "../../server/src/connectors/types";
import type { HttpTransport } from "../../server/src/connectors/httpClient";
import { ensureDefaultConnectors, getConnector } from "../../server/src/connectors/registry";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function replay(responses: { status: number; body: unknown }[]) {
  const calls: Recorded[] = [];
  let i = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, headers: init.headers ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

const ctxStub = (): ConnectorRunContext =>
  ({
    runId: 1,
    taskId: 1,
    signal: new AbortController().signal,
    logger: { event: () => {} },
  }) as unknown as ConnectorRunContext;

const pageReq = (cursor?: string | null): RemotePageRequest => ({ cursor, pageSize: 20, signal: new AbortController().signal });

const FX_URL = "https://example.test/api/hot";

describe("通用 HTTP 连接器:取数与翻页", () => {
  it("itemsPath 定位数组,页码翻页,到 maxPages 停下", async () => {
    const { transport, calls } = replay([
      { status: 200, body: { data: { items: [{ id: "1", title: "A" }, { id: "2", title: "B" }] } } },
      { status: 200, body: { data: { items: [{ id: "3", title: "C" }] } } },
      { status: 200, body: { data: { items: [] } } },
    ]);
    const c = new GenericHttpConnector(undefined, transport);
    const cfg = { url: FX_URL, itemsPath: "data.items", pagination: { kind: "page", pageParam: "p" }, pageSize: 2, maxPages: 3 };

    const p1 = await c.collectPage(pageReq(null), cfg, ctxStub());
    expect(p1.items.map((x) => (x as { id: string }).id)).toEqual(["1", "2"]);
    expect(p1.hasMore).toBe(true);

    const p2 = await c.collectPage(pageReq(p1.nextCursor), cfg, ctxStub());
    expect(new URL(calls[1].url).searchParams.get("p")).toBe("2");
    expect(p2.hasMore).toBe(false);

    const p3 = await c.collectPage(pageReq(p2.nextCursor), cfg, ctxStub());
    expect(p3.items).toEqual([]);
  });

  it("游标翻页取响应里的 next token,取不到就结束", async () => {
    const { transport, calls } = replay([
      { status: 200, body: { rows: [{ id: "1" }], next: "abc123" } },
      { status: 200, body: { rows: [{ id: "2" }], next: "" } },
    ]);
    const c = new GenericHttpConnector(undefined, transport);
    const cfg = {
      url: FX_URL,
      itemsPath: "rows",
      pageSize: 1,
      maxPages: 5,
      pagination: { kind: "cursor" as const, cursorParam: "after", cursorPath: "next", cursorStart: "start0" },
    };
    const p1 = await c.collectPage(pageReq(null), cfg, ctxStub());
    expect(p1.hasMore).toBe(true);
    const p2 = await c.collectPage(pageReq(p1.nextCursor), cfg, ctxStub());
    expect(new URL(calls[1].url).searchParams.get("after")).toBe("abc123");
    expect(p2.hasMore).toBe(false);
  });

  it("itemsPath 指不到数组时,报错说清楚返回了什么(而不是静默空页)", async () => {
    const { transport } = replay([{ status: 200, body: { data: { item: { id: "1" } } } }]);
    const c = new GenericHttpConnector(undefined, transport);
    await expect(c.collectPage(pageReq(null), { url: FX_URL, itemsPath: "data.items" }, ctxStub())).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});

describe("通用 HTTP 连接器:鉴权与密钥", () => {
  const KEY = "fake-key-for-tests-9f3c";

  beforeAll(() => {
    process.env.GENERIC_TEST_KEY = KEY;
  });
  afterAll(() => {
    delete process.env.GENERIC_TEST_KEY;
  });

  it("secretref 引用被解析成真实头,且明文密钥不接受为 secretRef", async () => {
    const { transport, calls } = replay([{ status: 200, body: [{ id: "1" }] }]);
    const c = new GenericHttpConnector(undefined, transport);
    await c.collectPage(pageReq(null), { url: FX_URL, secretRef: "secretref:env:GENERIC_TEST_KEY" }, ctxStub());
    expect(calls[0].headers["Authorization"]).toBe(KEY);
    expect(c.validateConfig({ url: FX_URL, secretRef: KEY }).ok).toBe(false);
  });

  it("headers 里的 secretref 同样解析;错误信息里不出现密钥本身", async () => {
    const { transport, calls } = replay([{ status: 401, body: { message: `bad token ${KEY}` } }]);
    const c = new GenericHttpConnector(undefined, transport);
    const cfg = { url: FX_URL, headers: { "X-Api-Key": "secretref:env:GENERIC_TEST_KEY" } };
    let err: unknown;
    try {
      await c.collectPage(pageReq(null), cfg, ctxStub());
    } catch (e) {
      err = e;
    }
    expect(calls[0].headers["X-Api-Key"]).toBe(KEY);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).message).not.toContain(KEY);
  });

  it("环境变量没配 → 凭证不可用是配置问题,不是远程故障", async () => {
    const { transport } = replay([{ status: 200, body: [] }]);
    const c = new GenericHttpConnector(undefined, transport);
    await expect(
      c.collectPage(pageReq(null), { url: FX_URL, headers: { Authorization: "secretref:env:GENERIC_ABSENT_KEY" } }, ctxStub()),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("429 与 5xx 归类为可重试错误交给运行时", async () => {
    const a = replay([{ status: 429, body: {} }]);
    await expect(new GenericHttpConnector(undefined, a.transport).collectPage(pageReq(null), { url: FX_URL }, ctxStub())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const b = replay([{ status: 503, body: {} }]);
    await expect(new GenericHttpConnector(undefined, b.transport).collectPage(pageReq(null), { url: FX_URL }, ctxStub())).rejects.toMatchObject({
      code: "REMOTE_5XX",
    });
  });

  it("只接受 http/https 地址", () => {
    const c = new GenericHttpConnector();
    expect(c.validateConfig({ url: "ftp://example.test/x" }).ok).toBe(false);
    expect(c.validateConfig({ url: "file:///C:/secrets.json" }).ok).toBe(false);
    expect(c.validateConfig({ url: FX_URL }).ok).toBe(true);
  });

  it("平台代码必须是已知枚举:写错不能让大家静默进不了库", () => {
    // 踩过的坑:新接一个平台时只加了渠道配置、忘了加平台枚举 —— 50 条内容逐行导入失败,
    // 而运行记录显示 completed。归类字段现在在配置校验阶段就挡住。
    // 反例刻意用"永远不可能成为平台代码"的形状:此前用 douban 当反例,
    // 后来豆瓣真成了渠道平台,反例自己失效了(测试变红才被发现)。
    const c = new GenericHttpConnector();
    expect(c.validateConfig({ url: FX_URL, platform: "not_a_platform" }).ok).toBe(false);
    expect(c.validateConfig({ url: FX_URL, platform: "百度热搜" }).ok).toBe(false);
    expect(c.validateConfig({ url: FX_URL, platform: "baidu" }).ok).toBe(true);
    expect(c.validateConfig({ url: FX_URL, platform: "ithome" }).ok).toBe(true);
    expect(c.validateConfig({ url: FX_URL, platform: "douban" }).ok).toBe(true);
    expect(c.validateConfig({ url: FX_URL, platform: "tieba" }).ok).toBe(true);
  });
});

describe("通用 HTTP 连接器:真实入库路径(mapping + 平台归属)", () => {
  let db: DB;
  let runtime: CollectionRuntime;
  let sqlite: { close(): void };

  beforeAll(async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    db = t.db;
    runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
    ensureDefaultConnectors();
    expect(getConnector(GENERIC_HTTP_CONNECTOR_ID)).toBeDefined();
  });

  afterAll(() => sqlite.close());

  it("远程条目经 mapping 落库,平台按任务声明归类,缺失指标留空不是 0", async () => {
    const { transport } = replay([
      {
        status: 200,
        body: [
          { note_id: "n1", title: "示例标题", link: "https://example.test/n1", create_time: "2026-09-28T01:00:00Z", like_num: 42 },
          { note_id: "n2", title: "第二条", link: "https://example.test/n2" },
        ],
      },
    ]);
    const connector = new GenericHttpConnector(undefined, transport);
    // 用带 replay 的实例替换注册表里的默认实例(仅测试进程内)
    const { registerConnector } = await import("../../server/src/connectors/registry");
    registerConnector(connector);

    const task = await createTask(db, runtime, {
      name: "多平台演练",
      connectorId: GENERIC_HTTP_CONNECTOR_ID,
      collectionType: "search",
      config: {
        url: FX_URL,
        platform: "xiaohongshu",
        pagination: { kind: "none" },
        mapping: {
          platformContentId: "note_id",
          title: "title",
          url: "link",
          publishedAt: "create_time",
          likes: "like_num",
        },
      },
      schedule: { type: "manual" },
      enabled: true,
    });
    expect(task.platform).toBe("xiaohongshu");

    const started = await runtime.runTask(task.id, "manual");
    expect(started.ok).toBe(true);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const rows = await db.select().from(contentItems).where(eq(contentItems.platform, "xiaohongshu"));
      if (rows.length >= 2) {
        const first = rows.find((r) => r.title === "示例标题");
        expect(first?.likes).toBe(42);
        const second = rows.find((r) => r.title === "第二条");
        expect(second?.likes ?? null).toBeNull(); // 缺失指标留空,不填 0
        return;
      }
    }
    throw new Error("通用连接器采集没有落库");
  });
});
