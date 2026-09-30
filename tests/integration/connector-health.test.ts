/**
 * 连接器健康度语义回归测试(FINAL RELEASE 1.0 真机实采时发现的问题)。
 *
 * 现场症状:知乎凭证已配置、热榜 Run 成功入库 30 条,但连接器卡片显示 status="unknown"
 * 且"最近运行"永远是 0 —— 因为服务层用空配置探针判断连接器是否可用,
 * 而带 mode 判别联合的配置 schema 必然拒绝空配置。任务级参数由任务提供,不是故障。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestDb, type DB } from "../../server/src/db/client";
import { collectionRuns } from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { connectorView, createTask } from "../../server/src/services/collection/service";
import { registerConnector } from "../../server/src/connectors/registry";
import type { Connector } from "../../server/src/connectors/types";

let sqlite: { close(): void };
let db: DB;
let runtime: CollectionRuntime;

/** 一个"配置必须由任务提供"的连接器:空配置永远校验失败。 */
const hotlistCfg = z.object({ mode: z.literal("hotlist") });
const taskCfgConnector: Connector = {
  metadata: {
    id: "test-taskcfg",
    name: "Task Config Only (test)",
    platform: "other",
    connectorType: "mock",
    sourceType: "json",
    version: "1.0.0",
    capabilities: [],
    defaultTimezone: "Asia/Shanghai",
    isDemo: true,
  },
  configSchema: hotlistCfg,
  itemSchema: z.object({}),
  defaultPolicy: {
    rateLimit: { rps: 50, concurrency: 1 },
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    breaker: { failureThreshold: 3, cooldownMs: 60_000 },
  },
  validateConfig: (config) =>
    hotlistCfg.safeParse(config).success ? { ok: true } : { ok: false, error: "mode: 格式不正确" },
  healthCheck: async () => ({ healthy: true, detail: "凭证就绪" }),
  collectPage: async () => ({ items: [], hasMore: false }),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(runId: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (run && ["completed", "failed", "partial", "cancelled"].includes(run.status)) return run;
    await sleep(25);
  }
  throw new Error(`run ${runId} 未在期限内进入终态`);
}

beforeAll(() => {
  const ctx = createTestDb();
  sqlite = ctx.sqlite;
  db = ctx.db;
  runtime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
  registerConnector(taskCfgConnector);
});

afterAll(() => sqlite.close());

describe("连接器健康度:任务级配置不算故障", () => {
  it("凭证就绪但空配置被拒时,状态取自连接器自检,不再是 unknown", async () => {
    const view = await connectorView(db, runtime, "test-taskcfg");
    expect(view.health.status).toBe("healthy");
    expect(view.health.detail).toContain("采集参数由任务提供");
  });

  it("成功 Run 之后能读到最近运行统计(修之前在探针处就 return 了)", async () => {
    const task = await createTask(db, runtime, {
      name: "taskcfg-hotlist",
      connectorId: "test-taskcfg",
      collectionType: "hotlist",
      config: { mode: "hotlist" },
      schedule: { type: "manual" },
      enabled: true,
    });
    const started = await runtime.runTask(task.id, "manual");
    expect(started.ok).toBe(true);
    const run = await waitTerminal(started.runId!);
    expect(run.status).toBe("completed");

    const view = await connectorView(db, runtime, "test-taskcfg");
    expect(view.health.recentRuns.total).toBe(1);
    expect(view.health.recentRuns.completed).toBe(1);
    expect(view.health.status).toBe("healthy");
  });
});
