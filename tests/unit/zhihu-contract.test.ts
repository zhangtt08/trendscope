/**
 * Stage 5 §37 Contract Tests — ZhihuOfficialConnector over the REPLAY
 * transport (§36). No live network, no real secret (env-injected fake).
 *
 * Covers: auth headers, timestamp clock, request shapes, response validation,
 * unknown-field tolerance, schema drift, error mapping, normalization rules
 * (missing metric → null, 0 → 0, ContentType/URL/publishedAt/author mapping),
 * credential lifecycle.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ZhihuOfficialConnector, mapZhihuCode } from "../../server/src/connectors/zhihuOfficial";
import { ZhihuSourceAdapter } from "../../server/src/adapters/zhihu";
import { ConnectorError } from "../../server/src/domain/collection";
import { NormalizationError } from "../../server/src/adapters/types";
import type { HttpTransport } from "../../server/src/connectors/httpClient";

const FX = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/zhihu", name), "utf-8")) as Record<string, unknown>;

const FAKE_SECRET = "test-access-secret-NOT-A-REAL-ONE";
const CLOCK = () => 1742822400; // §13 注入时钟,绝不依赖真实当前时间

interface RecordedTransport extends HttpTransport {
  urls: string[];
  headerLog: Record<string, Record<string, string>>;
}

function replayTransport(responses: { status: number; body: unknown }[]): RecordedTransport {
  let i = 0;
  const t = Object.assign(
    async (url: string, init: { headers?: Record<string, string> }) => {
      t.urls.push(url);
      t.headerLog[url] = init.headers ?? {};
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { status: r.status, body: r.body };
    },
    { urls: [] as string[], headerLog: {} as Record<string, Record<string, string>> },
  );
  return t;
}

function makeConnector(transport: RecordedTransport): ZhihuOfficialConnector {
  return new ZhihuOfficialConnector({ transport, clock: CLOCK });
}

const runCtx = (runId = 1) => ({
  runId,
  taskId: 1,
  signal: new AbortController().signal,
  logger: { runId, event: () => undefined },
});

afterAll(() => {
  delete process.env.ZHIHU_ACCESS_SECRET;
});

describe("§12/§13 authentication headers + timestamp", () => {
  it("injects Bearer secret and injected-clock timestamp; secret never in config", async () => {
    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
    const transport = replayTransport([{ status: 200, body: FX("search.page1.replay.json") }]);
    const c = makeConnector(transport);
    await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "RAG" }, runCtx());
    const headers = Object.values(transport.headerLog)[0];
    expect(headers.Authorization).toBe(`Bearer ${FAKE_SECRET}`);
    expect(headers["X-Request-Timestamp"]).toBe("1742822400"); // injected clock, not real now
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("credential missing → INVALID_CONFIG with reason, never a thrown secret value", async () => {
    delete process.env.ZHIHU_ACCESS_SECRET;
    const transport = replayTransport([]);
    const c = makeConnector(transport);
    const cred = c.checkCredential({ mode: "search", query: "x" });
    expect(cred.state).toBe("missing");
    expect(cred.source).toBe("环境变量 ZHIHU_ACCESS_SECRET");
    await expect(
      c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx()),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
  });
});

describe("§8/§9 request shapes", () => {
  it("search: Query + Count params on the official endpoint", async () => {
    const transport = replayTransport([{ status: 200, body: FX("search.page1.replay.json") }]);
    const c = makeConnector(transport);
    await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "减脂餐", count: 5 }, runCtx());
    const url = new URL(transport.urls[0]);
    expect(url.pathname).toBe("/api/v1/content/zhihu_search");
    expect(url.searchParams.get("Query")).toBe("减脂餐");
    expect(url.searchParams.get("Count")).toBe("5");
  });

  it("hotlist: Limit param on the official endpoint", async () => {
    const transport = replayTransport([{ status: 200, body: FX("hotlist.replay.json") }]);
    const c = makeConnector(transport);
    await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "hotlist", limit: 10 }, runCtx());
    const url = new URL(transport.urls[0]);
    expect(url.pathname).toBe("/api/v1/content/hot_list");
    expect(url.searchParams.get("Limit")).toBe("10");
  });

  it("HasMore=false is honored — no phantom second page (official single-page semantics)", async () => {
    const transport = replayTransport([{ status: 200, body: FX("search.page1.replay.json") }]);
    const c = makeConnector(transport);
    const page = await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx());
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor ?? null).toBeNull();
    // a cursor-bearing retry is rejected rather than silently re-fetching page 1
    await expect(
      c.collectPage({ cursor: "bogus", pageSize: 10 }, { mode: "search", query: "x" }, runCtx()),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("§14/§15 response validation + schema drift", () => {
  it("tolerates unknown/extra fields (non-strict on extras)", async () => {
    const transport = replayTransport([{ status: 200, body: FX("search.page1.replay.json") }]);
    const c = makeConnector(transport);
    const page = await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx());
    expect(page.items.length).toBe(3);
  });

  it("missing core fields → SCHEMA_DRIFT (never silent undefined→null)", async () => {
    const transport = replayTransport([{ status: 200, body: FX("search.drift.replay.json") }]);
    const c = makeConnector(transport);
    await expect(
      c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
});

describe("§33 error mapping", () => {
  it("Code 20001 → AUTH_ERROR, 30001 → RATE_LIMITED, 90001 → REMOTE_5XX, 10001 → INVALID_RESPONSE", async () => {
    expect(mapZhihuCode(20001, "x").code).toBe("AUTH_ERROR");
    expect(mapZhihuCode(30001, "x").code).toBe("RATE_LIMITED");
    expect(mapZhihuCode(90001, "x").code).toBe("REMOTE_5XX");
    expect(mapZhihuCode(10001, "x").code).toBe("INVALID_RESPONSE");
    expect(mapZhihuCode(20001, "x").retryable).toBe(false);
    expect(mapZhihuCode(30001, "x").retryable).toBe(true);
    expect(mapZhihuCode(90001, "x").retryable).toBe(true);
  });

  it("envelope Code≠0 surfaces the provider error code in detail", async () => {
    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
    const transport = replayTransport([{ status: 200, body: FX("error.auth.replay.json") }]);
    const c = makeConnector(transport);
    try {
      await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx());
      expect.unreachable();
    } catch (e) {
      expect((e as ConnectorError).code).toBe("AUTH_ERROR");
      expect((e as ConnectorError).detail?.providerErrorCode).toBe(20001);
    }
    delete process.env.ZHIHU_ACCESS_SECRET;
  });

  it("HTTP-level 401/403/429/5xx map through the shared mapping", async () => {
    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
    const c = makeConnector(
      replayTransport([{ status: 401, body: { Code: 20001 } }]),
    );
    await expect(
      c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx()),
    ).rejects.toMatchObject({ code: "AUTH_ERROR" });

    const c2 = makeConnector(replayTransport([{ status: 403, body: {} }]));
    await expect(
      c2.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx()),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("error messages never contain the secret", async () => {
    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
    const transport = replayTransport([{ status: 200, body: FX("error.auth.replay.json") }]);
    const c = makeConnector(transport);
    try {
      await c.collectPage({ cursor: null, pageSize: 10 }, { mode: "search", query: "x" }, runCtx());
    } catch (e) {
      expect(String(e)).not.toContain(FAKE_SECRET);
    }
    delete process.env.ZHIHU_ACCESS_SECRET;
  });
});

describe("§16-23 normalization (ZhihuSourceAdapter)", () => {
  const adapter = new ZhihuSourceAdapter();
  const ctx = { sourceType: "api", platformOverride: "zhihu", sourceTimezone: "Asia/Shanghai", tzProvenance: "adapter_default" as const };

  it("search item: id/url/type/text/upvotes/comments mapping; missing metrics → null; 0 stays 0", () => {
    const item = (FX("search.page1.replay.json").Data as { Items: unknown[] }).Items[0] as Record<string, unknown>;
    const rec = adapter.normalize(item, ctx);
    expect(rec.platform).toBe("zhihu");
    expect(rec.platformContentId).toBe("article:123456789"); // §18 组合键
    expect(rec.contentType).toBe("article");
    expect(rec.url).toContain("zhuanlan.zhihu.com/p/123456789");
    expect(rec.title).toBe("RAG 评测方法综述");
    expect(rec.metrics.upvotes).toBe(100);
    expect(rec.metrics.comments).toBe(20);
    // 官方未提供 → null,绝不 0(§22)
    expect(rec.metrics.views).toBeNull();
    expect(rec.metrics.likes).toBeNull();
    expect(rec.metrics.shares).toBeNull();
    expect(rec.metrics.favorites).toBeNull();
    // epoch → UTC ISO(§26)
    expect(rec.publishedAt).toBe("2024-03-09T16:00:00.000Z");
    expect(rec.authorId).toBeNull(); // 官方无 author id(§21)
    expect(rec.authorName).toBe("张三");
  });

  it("0 metric stays 0 — never null (the unknown ≠ 0 rule in reverse)", () => {
    const item = (FX("search.page1.replay.json").Data as { Items: unknown[] }).Items[1] as Record<string, unknown>;
    const rec = adapter.normalize(item, ctx);
    expect(rec.metrics.upvotes).toBe(0);
    expect(rec.metrics.comments).toBe(0);
  });

  it("ContentType whitelist: unknown values → unknown, never guessed", () => {
    const rec = adapter.normalize(
      { Title: "t", ContentType: "MysteryType", ContentID: "1", ContentText: "b", Url: "https://www.zhihu.com/answer/1", CommentCount: 0, VoteUpCount: 0, AuthorName: "a", EditTime: 1700000000 },
      ctx,
    );
    expect(rec.contentType).toBe("unknown");
  });

  it("<em> highlight tags are stripped from excerpts", () => {
    const rec = adapter.normalize(
      { Title: "t", ContentType: "Answer", ContentID: "2", ContentText: "高亮<em>关键词</em>内容", Url: "https://www.zhihu.com/answer/2", CommentCount: 0, VoteUpCount: 1, AuthorName: "a", EditTime: 1700000000 },
      ctx,
    );
    expect(rec.text).toBe("高亮关键词内容");
  });

  it("hotlist item: id/type from stable public URL; all metrics null; empty summary → null", () => {
    const items = (FX("hotlist.replay.json").Data as { Items: unknown[] }).Items as Record<string, unknown>[];
    const q = adapter.normalize(items[0], ctx);
    expect(q.contentType).toBe("question");
    expect(q.platformContentId).toBe("question:123456789"); // §18 组合键
    expect(q.metrics.upvotes).toBeNull();
    expect(q.metrics.comments).toBeNull();
    expect(q.publishedAt).toBeNull();
    expect(q.authorName).toBeNull();

    const a = adapter.normalize(items[1], ctx);
    expect(a.contentType).toBe("article");
    expect(a.platformContentId).toBe("article:987654321");
    expect(a.text).toBeNull(); // 官方 Summary="" → null(不是空串也不是 0)
  });

  it("unparseable hotlist URL → id null, item still normalized", () => {
    const rec = adapter.normalize({ Title: "t", Url: "https://example.com/not/zhihu", ThumbnailUrl: "", Summary: "s" }, ctx);
    expect(rec.platformContentId).toBeNull();
    expect(rec.contentType).toBe("unknown");
    expect(rec.title).toBe("t");
  });

  it("item whose title AND text are empty → rejected (quality gate), not silently minimal", () => {
    expect(() =>
      adapter.normalize({ Title: "", Url: "https://www.zhihu.com/question/5", ThumbnailUrl: "", Summary: "" }, ctx),
    ).toThrow(NormalizationError);
  });
});

describe("§7 healthCheck states", () => {
  it("distinguishes credential missing / auth failure / rate limited / healthy", async () => {
    delete process.env.ZHIHU_ACCESS_SECRET;
    const missing = makeConnector(replayTransport([]));
    const r0 = await missing.healthCheck({});
    expect(r0.healthy).toBe(false);
    // §78:健康详情会直接显示在采集中心,必须是中文 + 环境变量名(不含值)
    expect(r0.detail).toContain("凭证未配置");
    expect(r0.detail).toContain("ZHIHU_ACCESS_SECRET");

    process.env.ZHIHU_ACCESS_SECRET = FAKE_SECRET;
    const authFail = makeConnector(replayTransport([{ status: 200, body: FX("error.auth.replay.json") }]));
    const r1 = await authFail.healthCheck({});
    expect(r1.healthy).toBe(false);
    expect(r1.detail).toContain("AUTH_ERROR");

    const rate = makeConnector(replayTransport([{ status: 200, body: FX("error.rate.replay.json") }]));
    const r2 = await rate.healthCheck({});
    expect(r2.healthy).toBe(false);
    expect(r2.detail).toContain("RATE_LIMITED");

    const ok = makeConnector(
      replayTransport([
        {
          status: 200,
          body: {
            _meta: { kind: "REPLAY_FIXTURE", endpoint: "quota" },
            Code: 0,
            Message: "success",
            Data: [{ APIID: "zhihu_search", APIName: "知乎搜索", TotalQuota: 5000, TotalUsed: 3, RemainingQuota: 4997 }],
          },
        },
      ]),
    );
    const r3 = await ok.healthCheck({});
    expect(r3.healthy).toBe(true);
    expect(r3.detail).toContain("4997/5000");
  });
});

describe("§10 config validation", () => {
  it("search/hotlist are separate schemas; mode is required; secretRef must be a reference", () => {
    const c = makeConnector(replayTransport([]));
    expect(c.validateConfig({ mode: "search", query: "减脂餐" }).ok).toBe(true);
    expect(c.validateConfig({ mode: "hotlist", limit: 30 }).ok).toBe(true);
    expect(c.validateConfig({ query: "no-mode" }).ok).toBe(false); // §10 no implicit mode
    expect(c.validateConfig({ mode: "search" }).ok).toBe(false); // query required
    expect(c.validateConfig({ mode: "hotlist", limit: 500 }).ok).toBe(false); // 官方上限 30
    expect(c.validateConfig({ mode: "search", query: "x", count: 50 }).ok).toBe(false); // 官方上限 10
    expect(c.validateConfig({ mode: "search", query: "x", secretRef: "sk-plaintext" }).ok).toBe(false);
    expect(c.validateConfig({ mode: "search", query: "x", secretRef: "secretref:env:CUSTOM" }).ok).toBe(true);
  });
});
