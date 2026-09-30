/**
 * Stage 5 §38-40 integration — Zhihu Official Connector through the REAL
 * Stage 4 runtime (queue → rate limit → connector → replay HTTP → adapter →
 * existing import pipeline → RawRecord/ContentItem/Snapshot →
 * DiscoveryObservation → CollectionRun). No mocks of the pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import {
  collectionRuns,
  collectionTasks,
  contentItems,
  contentMetricSnapshots,
  contentDiscoveryObservations,
  rawRecords,
} from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { createTask } from "../../server/src/services/collection/service";
import { getItemTrendSeries, getMomentumList } from "../../server/src/services/trendService";
import { registerConnector } from "../../server/src/connectors/registry";
import { ZhihuOfficialConnector } from "../../server/src/connectors/zhihuOfficial";
import type { HttpTransport } from "../../server/src/connectors/httpClient";

const FX = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/zhihu", name), "utf-8")) as Record<string, unknown>;

let db: DB;
let runtime: CollectionRuntime;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ["completed", "partial", "failed", "cancelled"];

function replayZhihu(responses: { status: number; body: unknown }[]): void {
  let i = 0;
  const transport: HttpTransport = async (url, init) => {
    void init;
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { status: r.status, body: r.body };
  };
  process.env.ZHIHU_ACCESS_SECRET = "test-access-secret-NOT-A-REAL-ONE";
  registerConnector(new ZhihuOfficialConnector({ transport, clock: () => 1742822400 }));
}

async function waitForRun(runId: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (run && TERMINAL.includes(run.status)) return run;
    await sleep(20);
  }
  throw new Error(`run ${runId} not terminal in time`);
}

async function runTask(taskId: number) {
  const r = await runtime.runTask(taskId, "manual");
  expect(r.ok).toBe(true);
  return waitForRun(r.runId!);
}

beforeAll(() => {
  const { sqlite, db: d } = createTestDb();
  sqlite.close;
  db = d;
  runtime = new CollectionRuntime(db, { globalConcurrency: 2, perConnectorConcurrency: 1 });
  replayZhihu([{ status: 200, body: FX("search.page1.replay.json") }]);
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  if (anyDb?.$client) anyDb.$client.close();
  delete process.env.ZHIHU_ACCESS_SECRET;
});

describe("§38 search integration through Stage 4 runtime", () => {
  it("Task → Connector → Replay HTTP → adapter → pipeline → Item/Snapshot/Observation/Run", async () => {
    const task = await createTask(db, runtime, {
      name: "知乎搜索·减脂餐",
      connectorId: "zhihu-official",
      collectionType: "search",
      config: { mode: "search", query: "减脂餐", count: 10 },
      schedule: { type: "manual" },
    });
    const run = await runTask(task.id);

    expect(run.status).toBe("completed");
    expect(run.connectorId).toBe("zhihu-official");
    expect(run.connectorVersion).toBe("1.0.0");
    expect(run.pagesFetched).toBe(1); // 官方单页语义
    expect(run.recordsAccepted).toBe(3);

    // RawRecord provenance(§6/§50 lineage 起点)
    const raws = await db.select().from(rawRecords).where(eq(rawRecords.collectionRunId, run.id));
    expect(raws.length).toBe(3);
    for (const r of raws) {
      expect(r.connectorId).toBe("zhihu-official");
      expect(r.connectorVersion).toBe("1.0.0");
      expect(r.sourceType).toBe("api");
      expect(JSON.stringify(r.payload)).not.toContain("NOT-A-REAL-ONE"); // secret 不入 RawRecord
    }

    // ContentItem + Snapshot
    const items = await db.select().from(contentItems).where(eq(contentItems.platform, "zhihu"));
    expect(items.length).toBe(3);
    const article = items.find((i) => i.platformContentId === "article:123456789")!;
    expect(article.contentType).toBe("article");
    expect(article.upvotes).toBe(100); // VoteUpCount → upvotes(§23)
    expect(article.likes).toBeNull(); // 官方无 likes → null(§22)
    expect(article.views).toBeNull();
    const zero = items.find((i) => i.platformContentId === "answer:1903044959663284716")!;
    expect(zero.upvotes).toBe(0); // 0 保留 0(§40)
    expect(zero.comments).toBe(0);
    expect(article.publishedAt).toBe("2024-03-09T16:00:00.000Z"); // EditTime epoch → UTC

    // MetricSnapshot
    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, article.id));
    expect(snaps.length).toBe(1);
    expect(snaps[0].upvotes).toBe(100);
    expect(snaps[0].source).toBe("api");

    // DiscoveryObservation(§29): search rank = 数组序
    const obs = await db
      .select()
      .from(contentDiscoveryObservations)
      .where(eq(contentDiscoveryObservations.collectionRunId, run.id));
    expect(obs.length).toBe(3);
    expect(obs[0].discoveryType).toBe("search");
    expect(obs[0].query).toBe("减脂餐");
    expect(obs[0].rank).toBe(1);
    expect(JSON.stringify(obs[0].metadata)).toContain("987654321"); // searchHashId
  });
});

describe("§39 hotlist integration — append-only rank observations", () => {
  it("two runs: same ContentItems (no duplicates), observations accumulate over time", async () => {
    replayZhihu([{ status: 200, body: FX("hotlist.replay.json") }]);
    const task = await createTask(db, runtime, {
      name: "知乎热榜采集",
      connectorId: "zhihu-official",
      collectionType: "hotlist",
      config: { mode: "hotlist", limit: 30 },
      schedule: { type: "manual" },
    });

    const run1 = await runTask(task.id);
    expect(run1.status).toBe("completed");
    expect(run1.recordsAccepted).toBe(3);

    const items = await db.select().from(contentItems).where(eq(contentItems.platform, "zhihu"));
    const hotQ = items.find((i) => i.platformContentId === "question:123456789")!; // 热榜 question(URL 提取)
    expect(hotQ.contentType).toBe("question");
    expect(hotQ.upvotes).toBeNull(); // 官方热榜无 metrics
    expect(hotQ.publishedAt).toBeNull(); // 官方热榜无时间

    const obsAfterRun1 = await db
      .select()
      .from(contentDiscoveryObservations)
      .where(and(eq(contentDiscoveryObservations.collectionRunId, run1.id), eq(contentDiscoveryObservations.discoveryType, "hotlist")));
    expect(obsAfterRun1.length).toBe(3);
    expect(obsAfterRun1[0].rank).toBe(1);
    expect(obsAfterRun1[1].rank).toBe(2);
    expect(obsAfterRun1[2].rank).toBe(3);

    // 第二次采集:ContentItem 不重复,Observation 追加(§30/§31)
    const countBefore = await db
      .select({ n: sql<number>`count(*)` })
      .from(contentDiscoveryObservations)
      .where(eq(contentDiscoveryObservations.contentItemId, hotQ.id));
    const run2 = await runTask(task.id);
    expect(run2.status).toBe("completed");
    expect(run2.recordsAccepted).toBe(0); // 全部 duplicate(幂等)
    expect(run2.duplicates).toBe(3);

    const itemsAfter = await db.select().from(contentItems).where(eq(contentItems.platform, "zhihu"));
    expect(itemsAfter.length).toBe(items.length); // 无重复

    const countAfter = await db
      .select({ n: sql<number>`count(*)` })
      .from(contentDiscoveryObservations)
      .where(eq(contentDiscoveryObservations.contentItemId, hotQ.id));
    expect(Number(countAfter[0].n)).toBe(Number(countBefore[0].n) + 1); // append-only rank over time(§31)

    const obsRun2 = await db
      .select()
      .from(contentDiscoveryObservations)
      .where(eq(contentDiscoveryObservations.collectionRunId, run2.id));
    expect(obsRun2.length).toBe(3);
    expect(obsRun2[0].rank).toBe(1);
    expect(new Date(obsRun2[0].capturedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(obsAfterRun1[0].capturedAt).getTime(),
    );
  });
});

describe("§40 cross-run metric growth → Raw Momentum (upvotes semantics)", () => {
  it("run1 (100/20) → run2 (160/38): 1 item, 2 snapshots, momentum = 60·1 + 18·2 = 96", async () => {
    replayZhihu([
      { status: 200, body: FX("search.growth1.replay.json") },
      { status: 200, body: FX("search.growth2.replay.json") },
    ]);
    const task = await createTask(db, runtime, {
      name: "知乎搜索·指标增长",
      connectorId: "zhihu-official",
      collectionType: "search",
      config: { mode: "search", query: "RAG", count: 10 },
      schedule: { type: "manual" },
    });

    const run1 = await runTask(task.id);
    expect(run1.recordsAccepted).toBe(1);

    // 第二次采集:同 ContentID,指标增长 → duplicate 分支 + 新 Snapshot
    const run2 = await runTask(task.id);
    expect(run2.status).toBe("completed");
    expect(run2.duplicates).toBe(1);

    const items = await db.select().from(contentItems).where(eq(contentItems.platform, "zhihu"));
    const article = items.filter((i) => i.platformContentId === "article:990000001");
    expect(article.length).toBe(1); // ContentItem 仍只有 1 条(§40)
    expect(article[0].upvotes).toBe(160);

    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, article[0].id))
      .orderBy(contentMetricSnapshots.capturedAt);
    expect(snaps.length).toBe(2); // append-only observation
    expect(snaps[0].upvotes).toBe(100);
    expect(snaps[1].upvotes).toBe(160);

    // Raw Momentum 消费(§24/§25/§49):zhihu 权重 upvotes 1 / comments 2
    const series = await getItemTrendSeries(db, article[0].id);
    expect(series!.delta.upvotes).toBe(60);
    expect(series!.delta.comments).toBe(18);

    const momentum = await getMomentumList(db, { platform: "zhihu", windowDays: 7 });
    const row = momentum.rows.find((r) => r.itemId === article[0].id);
    expect(row).toBeDefined();
    expect(row!.rawMomentumScore).toBe(60 * 1 + 18 * 2); // 96 — 透明可解释
    expect(row!.unknownComponents).not.toContain("upvotes");
    expect(row!.unknownComponents).toContain("likes"); // 知乎无 likes → 未知分量如实标注
  });
});

describe("§15/§21 schema drift through the runtime", () => {
  it("drift response → run failed with SCHEMA_DRIFT, prior data untouched", async () => {
    replayZhihu([{ status: 200, body: FX("search.drift.replay.json") }]);
    const task = await createTask(db, runtime, {
      name: "知乎搜索·漂移检测",
      connectorId: "zhihu-official",
      collectionType: "search",
      config: { mode: "search", query: "drift" },
      schedule: { type: "manual" },
    });
    const run = await runTask(task.id);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("SCHEMA_DRIFT");
    expect(run.recordsAccepted).toBe(0); // 低质量数据绝不入库(§15)
  });
});

describe("§50 data lineage + §45 regression safety", () => {
  it("ContentItem ← RawRecord ← ImportBatch ← Run ← Task chain intact", async () => {
    const items = await db.select().from(contentItems).where(eq(contentItems.platform, "zhihu")).limit(1);
    const item = items[0];
    const [raw] = await db.select().from(rawRecords).where(eq(rawRecords.id, item.rawDataId!));
    expect(raw.collectionRunId).not.toBeNull();
    const [batch] = await db.select().from(rawRecords).where(eq(rawRecords.id, raw.id));
    expect(batch.importBatchId).not.toBeNull();
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, raw.collectionRunId!));
    expect(run.connectorId).toBe("zhihu-official");
    const [task] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, run.taskId));
    expect(task.connectorId).toBe("zhihu-official");
    // 最新 Run 的 events 记录了完整链路
    const events = await db
      .select()
      .from(collectionRuns)
      .where(eq(collectionRuns.taskId, task.id))
      .orderBy(desc(collectionRuns.id))
      .limit(1);
    expect(events.length).toBe(1);
  });
});
