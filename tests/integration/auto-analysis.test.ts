/**
 * 采完即算(FINAL RELEASE 1.0 之后的自动化补强)—— 自动补分析的触发规则。
 * 全部离线:采集走 fixture 远程源,分析走同一套引擎锁;不碰公网、不读真实库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { analysisRuns, collectionRuns } from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { createTask } from "../../server/src/services/collection/service";
import { createApp } from "../../server/src/app";
import { listFixtures } from "../../server/src/adapters/fixture";
import { ensureDefaultConnectors } from "../../server/src/connectors/registry";
import {
  autoAnalysisEnabled,
  autoAnalysisState,
  startAutoAnalysis,
} from "../../server/src/analysis/autoAnalysis";
import { REFRESH_ENGINES } from "../../server/src/analysis/fullRefresh";
import { beginRun, endRun } from "../../server/src/services/engineLock";

let db: DB;
let runtime: CollectionRuntime;
let sqlite: { close(): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitRuns<T>(read: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(120);
  }
}

beforeAll(async () => {
  const t = createTestDb();
  sqlite = t.sqlite;
  db = t.db;
  ensureDefaultConnectors();
  runtime = new CollectionRuntime(db, {
    onRunFinished: (info) => {
      startAutoAnalysis(db, { accepted: info.accepted, status: info.status });
    },
  });
});

afterAll(() => sqlite.close());

beforeEach(() => {
  autoAnalysisState.running = false;
  autoAnalysisState.lastStatus = null;
  autoAnalysisState.lastError = null;
  autoAnalysisState.skippedBusy = 0;
  autoAnalysisState.triggered = 0;
});

describe("触发规则", () => {
  it("环境变量是唯一开关,默认开", () => {
    expect(autoAnalysisEnabled({})).toBe(true);
    expect(autoAnalysisEnabled({ TRENDSCOPE_AUTO_ANALYSIS: "0" })).toBe(false);
    expect(autoAnalysisEnabled({ TRENDSCOPE_AUTO_ANALYSIS: "off" })).toBe(false);
    expect(autoAnalysisEnabled({ TRENDSCOPE_AUTO_ANALYSIS: "1" })).toBe(true);
  });

  it("没有新内容入库就不触发(空跑/取消跑不重算)", () => {
    expect(startAutoAnalysis(db, { accepted: 0, status: "completed" })).toBe(false);
    expect(startAutoAnalysis(db, { accepted: 5, status: "cancelled" })).toBe(false);
    expect(startAutoAnalysis(db, { accepted: 5, status: "completed" }, { TRENDSCOPE_AUTO_ANALYSIS: "0" })).toBe(false);
    expect(autoAnalysisState.triggered).toBe(0);
  });

  it("正在跑时不叠加(第二次触发直接跳过,不排队)", async () => {
    const first = startAutoAnalysis(db, { accepted: 3, status: "completed" });
    expect(first).toBe(true);
    expect(startAutoAnalysis(db, { accepted: 3, status: "completed" })).toBe(false);
    await waitRuns(async () => (autoAnalysisState.running ? null : "done"));
  });

  it("手动全分析占线时记为跳过,不算失败", async () => {
    const lock = beginRun(REFRESH_ENGINES);
    expect(lock.ok).toBe(true);
    try {
      expect(startAutoAnalysis(db, { accepted: 4, status: "completed" })).toBe(true);
      await waitRuns(async () => (autoAnalysisState.lastStatus ? autoAnalysisState.lastStatus : null));
    } finally {
      endRun(REFRESH_ENGINES);
    }
    expect(autoAnalysisState.lastStatus).toBe("skipped");
    expect(autoAnalysisState.skippedBusy).toBe(1);
    expect(autoAnalysisState.lastError).toContain("已跳过");
  });
});

describe("用户导入链路触发", () => {
  let server: import("node:http").Server;
  let base = "";
  let sqlite2: { close(): void };
  let db2: DB;

  beforeAll(async () => {
    const t = createTestDb();
    sqlite2 = t.sqlite;
    db2 = t.db;
    // 与 index.ts 同样的装配方式:导入挂点由组合根注入
    server = createApp(db2, new CollectionRuntime(db2, { globalConcurrency: 1 }), {
      dbFile: ":memory:",
      onImported: (summary) => {
        startAutoAnalysis(db2, { accepted: summary.imported, status: "completed" });
      },
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await waitRuns(async () => (autoAnalysisState.running ? null : "settled"));
    sqlite2.close();
  });

  it("CSV 导入手头数据后,自动补一次分析(不能让用户的数据配着旧排名看)", async () => {
    autoAnalysisState.triggered = 0;
    const r = await fetch(`${base}/api/import/csv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "我的数据.csv",
        content: "标题,链接,平台,浏览量\n导入链路验证,https://example.com/auto-analysis-1,zhihu,1200\n",
      }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { imported: number }).imported).toBe(1);
    expect(autoAnalysisState.triggered).toBe(1);

    await waitRuns(async () => {
      const rows = await db2
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(eq(analysisRuns.triggerSource, "after-collection"))
        .limit(1);
      return rows[0] ?? null;
    });
  });

  it("示例数据导入不触发:假数据不该被算成当前热点", async () => {
    const fixtures = listFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    await waitRuns(async () => (autoAnalysisState.running ? null : "settled"));

    autoAnalysisState.triggered = 0;
    const r = await fetch(`${base}/api/import/fixture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: fixtures[0].file, confirm: "LOAD_SAMPLE_INTO_CURRENT_DB" }),
    });
    expect(r.status).toBe(200);
    expect(autoAnalysisState.triggered).toBe(0);
  });
});

describe("真实采集链路触发", () => {
  it("fixture 源采到新内容后,自动留下一条 after-collection 分析运行", async () => {
    const task = await createTask(db, runtime, {
      name: "自动分析演练",
      connectorId: "fixture-remote",
      collectionType: "search",
      config: { platform: "xiaohongshu", keyword: "自动分析", scenario: "A", totalItems: 3, pageSize: 3 },
      schedule: { type: "manual" },
      enabled: true,
    });
    const started = await runtime.runTask(task.id, "manual");
    autoAnalysisState.triggered = 0;
    expect(started.ok).toBe(true);
    await waitRuns(async () => {
      const [r] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, started.runId!)).limit(1);
      return r && ["completed", "partial", "failed", "cancelled"].includes(r.status) ? r : null;
    });

    expect(autoAnalysisState.triggered).toBe(1);

    const run = await waitRuns(async () => {
      const rows = await db
        .select({ id: analysisRuns.id, triggerSource: analysisRuns.triggerSource })
        .from(analysisRuns)
        .where(eq(analysisRuns.triggerSource, "after-collection"))
        .orderBy(desc(analysisRuns.id))
        .limit(1);
      return rows[0] ?? null;
    });
    expect(run.triggerSource).toBe("after-collection");
    await waitRuns(async () => (autoAnalysisState.running ? null : "settled"));
    expect(["completed", "partial"]).toContain(autoAnalysisState.lastStatus ?? "completed");
  });
});
