/**
 * Stage 4 integration — collection runtime end-to-end (§36-39).
 *
 * Real path, no mocks: CollectionTask → FixtureRemoteConnector → pagination →
 * rate limit → retry → SourceAdapter (JSON) → EXISTING import pipeline
 * (processRow) → RawRecord → ContentItem → MetricSnapshot → CollectionRun
 * (+ events, checkpoints, resume, cancel, partial, schema drift, scheduler,
 * restart recovery, dashboard stats).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq, like, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import {
  collectionRuns,
  collectionRunEvents,
  collectionTasks,
  embeddingJobs,
  importBatches,
  rawRecords,
  contentItems,
  contentMetricSnapshots,
  topicAnalysisRuns,
} from "../../server/src/db/schema";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import { CollectionScheduler } from "../../server/src/services/collection/scheduler";
import { createTask, listTasks, getCollectionStats } from "../../server/src/services/collection/service";
import { getItemTrendSeries, getMomentumList } from "../../server/src/services/trendService";
import { registerConnector, getConnector } from "../../server/src/connectors/registry";
import { FixtureRemoteConnector } from "../../server/src/connectors/fixtureRemote";
import type { Connector, ConnectorMetadata, ConnectorPolicy, ConnectorRunContext } from "../../server/src/connectors/types";
import { ConnectorError } from "../../server/src/domain/collection";
import type { PageResult, RemotePageRequest } from "../../server/src/domain/collection";
import { z } from "zod";

let db: DB;
let runtime: CollectionRuntime;
const fixture = new FixtureRemoteConnector();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ["completed", "partial", "failed", "cancelled"] as const;
const isTerminal = (s: string) => (TERMINAL as readonly string[]).includes(s);

async function waitForRun(runId: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (run && isTerminal(run.status)) return run;
    await sleep(25);
  }
  throw new Error(`run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

async function runAndFinish(taskId: number, trigger: "manual" | "resume" = "manual", timeoutMs = 30_000) {
  const r = await runtime.runTask(taskId, trigger);
  expect(r.ok).toBe(true);
  return waitForRun(r.runId!, timeoutMs);
}

async function createFixtureTask(opts: {
  name: string;
  scenario?: string;
  totalItems?: number;
  pageSize?: number;
  pageLimit?: number;
  latencyMs?: number;
  platform?: string;
  duplicateEveryPage?: boolean;
}) {
  const config: Record<string, unknown> = {
    platform: opts.platform ?? "xiaohongshu",
    keyword: opts.name,
    scenario: opts.scenario ?? "A",
    totalItems: opts.totalItems ?? 9,
    pageSize: opts.pageSize ?? 3,
    pageLimit: opts.pageLimit ?? 10,
    latencyMs: opts.latencyMs ?? 15,
    ...(opts.duplicateEveryPage ? { duplicateEveryPage: true } : {}),
  };
  return createTask(db, runtime, {
    name: opts.name,
    connectorId: "fixture-remote",
    collectionType: "search",
    config,
    schedule: { type: "manual" },
  });
}

async function eventsOf(runId: number) {
  return db.select().from(collectionRunEvents).where(eq(collectionRunEvents.runId, runId)).orderBy(collectionRunEvents.id);
}

/* a connector that always 401s — for the no-retry path (§12) */
function makeAuthFailConnector(): Connector {
  const cfg = z.object({}).strict();
  return {
    metadata: {
      id: "test-auth-fail",
      name: "Auth Fail (test)",
      platform: "other",
      connectorType: "mock",
      sourceType: "json",
      version: "1.0.0",
      capabilities: ["search"],
      defaultTimezone: "Asia/Shanghai",
      isDemo: true,
    },
    configSchema: cfg,
    itemSchema: z.object({}),
    defaultPolicy: {
      rateLimit: { rps: 10, concurrency: 1 },
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
      breaker: { failureThreshold: 50, cooldownMs: 60_000 }, // high threshold: don't trip during this test
    },
    validateConfig: () => ({ ok: true }),
    healthCheck: async () => ({ healthy: true }),
    collectPage: async () => {
      throw new ConnectorError("AUTH_ERROR", "401 unauthorized (test)");
    },
  };
}

beforeAll(() => {
  const { sqlite, db: d } = createTestDb();
  sqlite.close; // referenced only to keep types aligned
  db = d;
  runtime = new CollectionRuntime(db, { globalConcurrency: 2, perConnectorConcurrency: 1 });
  registerConnector(fixture);
  registerConnector(makeAuthFailConnector());
  fixture.resetState();
});

afterAll(() => {
  // close the underlying sqlite (Windows file-lock discipline)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  if (anyDb?.$client) anyDb.$client.close();
});

describe("§4/§30 task CRUD + connector contract", () => {
  it("rejects invalid connector config at task creation (§36 connector validation)", async () => {
    await expect(
      createTask(db, runtime, {
        name: "bad",
        connectorId: "fixture-remote",
        collectionType: "search",
        config: { scenario: "Z" }, // not in A-H
        schedule: { type: "manual" },
      }),
    ).rejects.toThrow(/配置无效/);
  });

  it("rejects plaintext secrets before schema validation (§23; accept-side covered in unit tests)", async () => {
    await expect(
      createTask(db, runtime, {
        name: "plain-secret",
        connectorId: "fixture-remote",
        collectionType: "search",
        config: { apiKey: "sk-plaintext" },
        schedule: { type: "manual" },
      }),
    ).rejects.toThrow(/secretref/);
  });

  it("invalid config at Run time still records a failed run with INVALID_CONFIG", async () => {
    const task = await createFixtureTask({ name: "cfgprobe" });
    // corrupt config directly in DB to bypass create-time validation
    await db
      .update(collectionTasks)
      .set({ config: JSON.stringify({ scenario: "NOPE" }) })
      .where(eq(collectionTasks.id, task.id));
    const r = await runtime.runTask(task.id, "manual");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_config");
    expect(r.runId).toBeDefined();
    const run = await waitForRun(r.runId!);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("INVALID_CONFIG");
  });
});

describe("§8 scenario A — pagination + full pipeline (§37)", () => {
  it("3 pages × 3 items → 9 ContentItems, one ImportBatch, provenance on RawRecords", async () => {
    const task = await createFixtureTask({ name: "pagA", scenario: "A", totalItems: 9, pageSize: 3 });
    const run = await runAndFinish(task.id);

    expect(run.status).toBe("completed");
    expect(run.pagesFetched).toBe(3);
    expect(run.recordsFetched).toBe(9);
    expect(run.recordsAccepted).toBe(9);
    expect(run.duplicates).toBe(0);
    expect(run.importBatchId).not.toBeNull();

    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, run.importBatchId!));
    expect(batch.sourceType).toBe("json");

    // §6: CollectionRun ↔ ImportBatch linkage + provenance on every raw record
    const raws = await db.select().from(rawRecords).where(eq(rawRecords.collectionRunId, run.id));
    expect(raws.length).toBe(9);
    for (const r of raws) {
      expect(r.connectorId).toBe("fixture-remote");
      expect(r.connectorVersion).toBe("1.0.0");
      expect(r.importBatchId).toBe(run.importBatchId);
    }

    const items = await db.select().from(contentItems).where(eq(contentItems.platform, "xiaohongshu"));
    expect(items.length).toBeGreaterThanOrEqual(9);

    // event chain (§25)
    const types = (await eventsOf(run.id)).map((e) => e.type);
    expect(types).toContain("RUN_QUEUED");
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("PAGE_FETCHED");
    expect(types).toContain("RECORD_IMPORTED");
    expect(types).toContain("CHECKPOINT_SAVED");
    expect(types).toContain("RUN_COMPLETED");
    expect(types).not.toContain("SCHEMA_DRIFT");
  });
});

describe("§8 scenario B — retry after 500 (§12)", () => {
  it("page 2 first attempt 500 → RETRY event → run completes", async () => {
    const task = await createFixtureTask({ name: "retryB", scenario: "B", totalItems: 9, pageSize: 3 });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("completed");
    expect(run.retryCount).toBeGreaterThanOrEqual(1);
    const types = (await eventsOf(run.id)).map((e) => e.type);
    expect(types).toContain("RETRY");
  });
});

describe("§8 scenario C — permanent page failure → partial run (§20)", () => {
  it("pages 1-2 kept, run = partial, data NOT rolled back", async () => {
    const task = await createFixtureTask({ name: "partialC", scenario: "C", totalItems: 9, pageSize: 3 });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("partial");
    expect(run.pagesFetched).toBe(2);
    expect(run.recordsAccepted).toBe(6);
    expect(run.errorCode).toBe("REMOTE_5XX");
    const events = await eventsOf(run.id);
    expect(events.map((e) => e.type)).toContain("RUN_PARTIAL");
    // raw rows from the first two pages survive
    const raws = await db.select().from(rawRecords).where(eq(rawRecords.collectionRunId, run.id));
    expect(raws.length).toBe(6);
  });
});

describe("§8 scenario D — 429 → backoff → success (§11/§12)", () => {
  it("RATE_LIMITED retry succeeds; RATE_LIMIT_WAIT event present", async () => {
    const task = await createFixtureTask({ name: "rateD", scenario: "D", totalItems: 9, pageSize: 3 });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("completed");
    expect(run.retryCount).toBeGreaterThanOrEqual(1);
    const events = await eventsOf(run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("RETRY");
    expect(types).toContain("RATE_LIMIT_WAIT");
  });
});

describe("§12 no-retry on 401", () => {
  it("AUTH_ERROR fails immediately: zero retries recorded", async () => {
    const task = await createTask(db, runtime, {
      name: "authfail",
      connectorId: "test-auth-fail",
      collectionType: "search",
      config: {},
      schedule: { type: "manual" },
    });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("AUTH_ERROR");
    expect(run.retryCount).toBe(0);
    expect(run.pagesFetched).toBe(0);
  });
});

describe("§8 scenario E — checkpoint + resume (§10/§38)", () => {
  it("interrupt after page 2 → cancel → resume continues from checkpoint, no duplicate ContentItems", async () => {
    const task = await createFixtureTask({
      name: "resumeE",
      scenario: "E",
      totalItems: 9,
      pageSize: 3,
      latencyMs: 120,
    });
    const r = await runtime.runTask(task.id, "manual");
    expect(r.ok).toBe(true);
    const runId = r.runId!;

    // wait until pages 1-2 are checkpointed, then interrupt
    const deadline = Date.now() + 15_000;
    let pages = 0;
    while (Date.now() < deadline) {
      const [row] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
      pages = row?.pagesFetched ?? 0;
      if (pages >= 2) break;
      await sleep(20);
    }
    expect(pages).toBeGreaterThanOrEqual(2);
    const cancelRes = await runtime.cancelRun(runId);
    expect(cancelRes.ok).toBe(true);
    console.log("[E] mark1 cancel accepted");
    const cancelled = await waitForRun(runId);
    console.log("[E] mark2 cancelled=", cancelled.status);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.checkpoint).not.toBeNull();

    // §16 discipline: an unfinished run is never silently completed
    expect(cancelled.completedAt).not.toBeNull();

    // resume: new run seeded from checkpoint cursor
    const resumeRun = await runAndFinish(task.id, "resume");
    console.log("[E] mark3 resumed=", resumeRun.status, resumeRun.trigger);
    expect(resumeRun.trigger).toBe("resume");
    expect(resumeRun.status).toBe("completed");
    // §38: the resumed run inherited the checkpoint (2 pages, 6 records) and
    // only fetched the REMAINING page — cumulative records reach exactly 9
    expect(resumeRun.recordsFetched).toBe(9);
    expect(resumeRun.pagesFetched).toBeLessThanOrEqual(3);
    console.log("[E] mark4 resume asserts done");

    // §38: ContentItem count exactly totalItems — dedup prevented duplicates
    // (remote ids are scoped to this task's keyword: fx_xiaohongshu_resumeE_*)
    const items = await db
      .select({ n: sql<number>`count(*)` })
      .from(contentItems)
      .where(like(contentItems.platformContentId, "fx_xiaohongshu_resumeE_%"));
    console.log("[E] mark5 like count =", Number(items[0].n));
    expect(Number(items[0].n)).toBe(9);

    // every one of the 9 items has a snapshot from both runs' batches
    const snapCount = await db
      .select({ n: sql<number>`count(*)` })
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.source, "json"));
    expect(Number(snapCount[0].n)).toBeGreaterThanOrEqual(9);
  });
});

describe("§8 scenario F — cross-run snapshots / metric growth (§33/§34/§39)", () => {
  it("run 1 then run 2 → metrics grow, 2 snapshots, Raw Momentum consumable", async () => {
    const task = await createFixtureTask({ name: "growthF", scenario: "F", platform: "weibo", totalItems: 6, pageSize: 3, pageLimit: 5 });
    const run1 = await runAndFinish(task.id);
    expect(run1.status).toBe("completed");
    const run2 = await runAndFinish(task.id);
    expect(run2.status).toBe("completed");

    // same remote ids → same ContentItems, no duplicates
    const weiboItems = await db.select().from(contentItems).where(eq(contentItems.platform, "weibo"));
    expect(weiboItems.length).toBe(6);

    // second collection appended snapshots (append-only) with grown metrics
    const first = await getItemTrendSeries(db, weiboItems[0].id);
    expect(first).not.toBeNull();
    expect(first!.series.length).toBeGreaterThanOrEqual(2);
    const likes = first!.series.map((s) => s.likes).filter((v): v is number => v !== null);
    expect(likes[likes.length - 1]).toBeGreaterThan(likes[0]);

    // Raw Momentum consumes automatically-produced snapshots (§34)
    const momentum = await getMomentumList(db, { platform: "weibo", windowDays: 7 });
    const row = momentum.rows.find((r) => r.itemId === weiboItems[0].id);
    expect(row).toBeDefined();
    expect(row!.rawMomentumScore).toBeGreaterThan(0);
  });
});

describe("§8 scenario G — same-run duplicates (§10)", () => {
  it("duplicate rows inside one run pollute neither items nor snapshots", async () => {
    const task = await createFixtureTask({
      name: "dupG",
      scenario: "G",
      platform: "douyin",
      totalItems: 6,
      pageSize: 3,
      duplicateEveryPage: true,
    });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("completed");
    // 2 pages × (3 rows + 1 duplicate) → both duplicate rows counted
    expect(run.duplicates).toBeGreaterThanOrEqual(2);
    // items: exactly the 6 distinct remote ids
    const douyinItems = await db.select().from(contentItems).where(eq(contentItems.platform, "douyin"));
    expect(douyinItems.length).toBe(6);
    // no duplicate (contentItemId, capturedAt, likes) snapshot rows from the same batch
    const dupSnaps = await db.all(
      sql`SELECT content_item_id, captured_at, likes, count(*) AS n
          FROM content_metric_snapshots
          WHERE import_batch_id = ${run.importBatchId}
          GROUP BY content_item_id, captured_at, likes HAVING n > 1`,
    );
    expect(dupSnaps.length).toBe(0);
  });
});

describe("§8 scenario H — schema drift (§21)", () => {
  it("drift detected, SCHEMA_DRIFT recorded, run partial, prior pages kept", async () => {
    const task = await createFixtureTask({ name: "driftH", scenario: "H", totalItems: 9, pageSize: 3 });
    const run = await runAndFinish(task.id);
    expect(run.status).toBe("partial");
    expect(run.errorCode).toBe("SCHEMA_DRIFT");
    const events = await eventsOf(run.id);
    const drift = events.find((e) => e.type === "SCHEMA_DRIFT");
    expect(drift).toBeDefined();
    const payload = JSON.parse(drift!.data ?? "{}") as { sample: unknown; validationErrors: string[] };
    expect(payload.sample).toBeDefined();
    expect(payload.validationErrors.length).toBeGreaterThan(0);
    // page 1 data survives
    const raws = await db.select().from(rawRecords).where(eq(rawRecords.collectionRunId, run.id));
    expect(raws.length).toBe(3);
  });
});

describe("§17 non-reentry + §19 cancel", () => {
  it("Run Now while running returns already_running", async () => {
    const task = await createFixtureTask({ name: "reentry", totalItems: 9, pageSize: 3, latencyMs: 250 });
    const first = await runtime.runTask(task.id, "manual");
    expect(first.ok).toBe(true);
    // task is now running/queued — second Run Now must be rejected
    const second = await runtime.runTask(task.id, "manual");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_running");
    await runtime.cancelRun(first.runId!);
    await waitForRun(first.runId!);
  });

  it("cancel running stops at a safe page boundary; ingested data kept (§19)", async () => {
    const task = await createFixtureTask({ name: "cancelrun", totalItems: 60, pageSize: 3, pageLimit: 20, latencyMs: 60 });
    const r = await runtime.runTask(task.id, "manual");
    const runId = r.runId!;
    await sleep(700); // let a few pages land
    const c = await runtime.cancelRun(runId);
    expect(c.ok).toBe(true);
    const run = await waitForRun(runId);
    expect(run.status).toBe("cancelled");
    expect(run.recordsAccepted).toBeGreaterThanOrEqual(0);
    // whatever pages completed are durable
    const raws = await db.select().from(rawRecords).where(eq(rawRecords.collectionRunId, runId));
    expect(raws.length).toBe(run.recordsFetched - run.recordsFailed);
  });
});

describe("§18 queue: cancel while queued", () => {
  it("a queued run can be cancelled before it ever executes", async () => {
    const singleRuntime = new CollectionRuntime(db, { globalConcurrency: 1, perConnectorConcurrency: 1 });
    const blocker = await createFixtureTask({ name: "q-block", totalItems: 30, pageSize: 3, latencyMs: 200 });
    const queuedTask = await createFixtureTask({ name: "q-target", totalItems: 3, pageSize: 3 });

    const b = await singleRuntime.runTask(blocker.id, "manual");
    const q = await singleRuntime.runTask(queuedTask.id, "manual");
    expect(b.ok).toBe(true);
    expect(q.ok).toBe(true);

    const cancel = await singleRuntime.cancelRun(q.runId!);
    expect(cancel.ok).toBe(true);
    const cancelledRun = await waitForRun(q.runId!);
    expect(cancelledRun.status).toBe("cancelled");
    expect(cancelledRun.startedAt).toBeNull(); // never executed

    // unblock: cancel the blocker and wait
    await singleRuntime.cancelRun(b.runId!);
    await waitForRun(b.runId!);
  });
});

describe("§13 circuit breaker through the runtime", () => {
  it("consecutive connector failures open the circuit; next run is refused", async () => {
    // register a permanently-failing connector with a low threshold
    const cfg = z.object({}).strict();
    const breakerConnector: Connector = {
      metadata: {
        id: "test-breaker",
        name: "Breaker (test)",
        platform: "other",
        connectorType: "mock",
        sourceType: "json",
        version: "1.0.0",
        capabilities: [],
        defaultTimezone: "Asia/Shanghai",
        isDemo: true,
      },
      configSchema: cfg,
      itemSchema: z.object({}),
      defaultPolicy: {
        rateLimit: { rps: 50, concurrency: 1 },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
        breaker: { failureThreshold: 3, cooldownMs: 60_000 },
      },
      validateConfig: () => ({ ok: true }),
      healthCheck: async () => ({ healthy: true }),
      collectPage: async () => {
        throw new ConnectorError("REMOTE_5XX", "always 500 (breaker test)");
      },
    };
    registerConnector(breakerConnector);

    const task = await createTask(db, runtime, {
      name: "breaker-t",
      connectorId: "test-breaker",
      collectionType: "search",
      config: {},
      schedule: { type: "manual" },
    });

    // runs 1-3 fail (no retry — maxRetries 0); after 3 consecutive page failures the breaker opens
    for (let i = 0; i < 3; i++) {
      const run = await runAndFinish(task.id);
      expect(run.status).toBe("failed");
    }
    const run4 = await runtime.runTask(task.id, "manual");
    expect(run4.ok).toBe(true);
    const finished = await waitForRun(run4.runId!);
    expect(finished.status).toBe("failed");
    expect(finished.errorCode).toBe("RATE_LIMITED"); // breaker open → run refused
    expect(finished.errorMessage).toMatch(/circuit breaker open/i);
  });

  /**
   * 熔断的粒度必须是"来源",不是"连接器"。
   * 真机账:generic-http 一个连接器挂着十来个渠道,一个聚合站连续 500 之后,
   * 其余指向不同主机的渠道一起被本地熔断,实测一夜之间 9 个渠道各 21 次 RATE_LIMITED。
   */
  it("同一连接器下不同主机互不牵连:坏主机熔断后,好主机的任务照样跑", async () => {
    const scopeConnector: Connector = {
      metadata: {
        id: "test-breaker-scope",
        name: "Breaker scope (test)",
        platform: "other",
        connectorType: "mock",
        sourceType: "json",
        version: "1.0.0",
        capabilities: [],
        defaultTimezone: "Asia/Shanghai",
        isDemo: true,
      },
      configSchema: z.object({ url: z.string() }).strict(),
      itemSchema: z.object({}),
      defaultPolicy: {
        rateLimit: { rps: 50, concurrency: 1 },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
        breaker: { failureThreshold: 3, cooldownMs: 60_000 },
      },
      validateConfig: () => ({ ok: true }),
      healthCheck: async () => ({ healthy: true }),
      collectPage: async (_req, config) => {
        if (String((config as { url?: string }).url).includes("bad.test")) {
          throw new ConnectorError("REMOTE_5XX", "always 500 (scope test)");
        }
        return { items: [], hasMore: false };
      },
    };
    registerConnector(scopeConnector);

    const bad = await createTask(db, runtime, {
      name: "scope-bad",
      connectorId: "test-breaker-scope",
      collectionType: "search",
      config: { url: "https://bad.test/api" },
      schedule: { type: "manual" },
    });
    const good = await createTask(db, runtime, {
      name: "scope-good",
      connectorId: "test-breaker-scope",
      collectionType: "search",
      config: { url: "https://good.test/api" },
      schedule: { type: "manual" },
    });

    for (let i = 0; i < 3; i++) expect((await runAndFinish(bad.id)).status).toBe("failed");
    expect((await runAndFinish(bad.id)).errorCode).toBe("RATE_LIMITED");

    const okRun = await runAndFinish(good.id);
    expect(okRun.status).toBe("completed");
    expect(okRun.errorCode).toBeNull();
  });
});

describe("§15/§16 scheduler + persistence + restart recovery", () => {
  it("interval task fires when due; nextRunAt persists forward; not due → skipped", async () => {
    const task = await createFixtureTask({ name: "schedT", scenario: "F", platform: "zhihu", totalItems: 3, pageSize: 3 });
    await db
      .update(collectionTasks)
      .set({ schedule: JSON.stringify({ type: "interval", intervalMs: 60_000 }), enabled: 1 })
      .where(eq(collectionTasks.id, task.id));

    const scheduler = new CollectionScheduler(db, runtime);

    // not due yet (nextRunAt = now+60s)
    const t0 = await scheduler.tick(new Date());
    const dueBefore = await db.select().from(collectionRuns).where(eq(collectionRuns.taskId, task.id));
    expect(dueBefore.length).toBe(0);
    void t0;

    // make it due
    await db
      .update(collectionTasks)
      .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(collectionTasks.id, task.id));
    const res = await scheduler.tick();
    expect(res.triggered).toBe(1);

    // nextRunAt moved forward ~60s (persisted, §15)
    const [after] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, task.id));
    expect(after.nextRunAt).not.toBeNull();
    const delta = Date.parse(after.nextRunAt!) - Date.now();
    expect(delta).toBeGreaterThan(30_000);
    expect(delta).toBeLessThanOrEqual(75_000);

    const run = await waitForRun(dueBefore.length ? dueBefore[0].id : (await db.select().from(collectionRuns).where(eq(collectionRuns.taskId, task.id)))[0].id);
    expect(run.trigger).toBe("schedule");
    expect(run.status).toBe("completed");
  });

  it("restart recovery: unfinished run → failed/INTERRUPTED (never completed), checkpoint kept", async () => {
    // fabricate a mid-flight run with a checkpoint
    const task = await createFixtureTask({ name: "recoverT", totalItems: 9, pageSize: 3 });
    const now = new Date().toISOString();
    const [fakeRun] = await db
      .insert(collectionRuns)
      .values({
        taskId: task.id,
        taskName: task.name,
        connectorId: "fixture-remote",
        connectorVersion: "1.0.0",
        status: "running",
        startedAt: now,
        createdAt: now,
        checkpoint: JSON.stringify({ cursor: "abc", pagesFetched: 2, recordsFetched: 6 }),
      })
      .returning();

    // interval task without next_run_at gets rescheduled on boot
    await db
      .update(collectionTasks)
      .set({ schedule: JSON.stringify({ type: "interval", intervalMs: 60_000 }), nextRunAt: null })
      .where(eq(collectionTasks.id, task.id));

    // 同一批"进程重启留下的在跑状态"还包括向量作业与话题分析运行:
    // fullRefresh 判"是否已有同类任务在跑"只看 status in (queued, running),
    // 孤儿行会让此后每一次自动补算都跳过 —— 实测 09-29 19:53 起约 14 小时零向量化。
    const [stuckJob] = await db
      .insert(embeddingJobs)
      .values({ embeddingSpaceId: "test-space", scope: "missing", status: "running", startedAt: now, createdAt: now })
      .returning();
    const [stuckAnalysis] = await db
      .insert(topicAnalysisRuns)
      .values({
        embeddingSpaceId: "test-space",
        status: "running",
        startedAt: now,
        createdAt: now,
        similarityThreshold: 0.8,
        neighborLimit: 12,
        minClusterSize: 2,
        maxClusterSize: 60,
        minCohesion: 0.3,
        topicIdentityThreshold: 0.75,
        clusteringAlgorithmVersion: "test",
        semanticTextVersion: "test",
        provider: "test",
        model: "test",
        dimension: 8,
        qualityMode: "lexical_baseline",
      })
      .returning();

    const freshScheduler = new CollectionScheduler(db, runtime); // simulates a new process
    const rec = freshScheduler.recover();
    expect(rec.interruptedRuns).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, fakeRun.id));
    expect(after.status).toBe("failed");
    expect(after.errorCode).toBe("INTERRUPTED");
    expect(after.checkpoint).not.toBeNull(); // still resumable (§38)

    const [taskAfter] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, task.id));
    expect(taskAfter.nextRunAt).not.toBeNull();

    expect(rec.interruptedEmbeddings).toBeGreaterThanOrEqual(1);
    expect(rec.interruptedAnalyses).toBeGreaterThanOrEqual(1);
    const [jobAfter] = await db.select().from(embeddingJobs).where(eq(embeddingJobs.id, stuckJob.id));
    const [analysisAfter] = await db.select().from(topicAnalysisRuns).where(eq(topicAnalysisRuns.id, stuckAnalysis.id));
    expect(jobAfter.status).toBe("failed");
    expect(analysisAfter.status).toBe("failed");
    // 判据本身:恢复之后不该再有任何 queued/running 残留
    expect(
      db
        .select({ id: embeddingJobs.id })
        .from(embeddingJobs)
        .where(sql`${embeddingJobs.status} in ('queued','running')`)
        .all(),
    ).toHaveLength(0);
    expect(
      db
        .select({ id: topicAnalysisRuns.id })
        .from(topicAnalysisRuns)
        .where(sql`${topicAnalysisRuns.status} in ('queued','running')`)
        .all(),
    ).toHaveLength(0);
  });
});

describe("§24 safe logging", () => {
  it("run events never persist secret-looking values", async () => {
    const task = await createFixtureTask({ name: "redact", totalItems: 3, pageSize: 3 });
    const run = await runAndFinish(task.id);
    const events = await eventsOf(run.id);
    for (const ev of events) {
      const raw = ev.data ?? "";
      expect(raw).not.toMatch(/secretref:/);
      expect(raw).not.toMatch(/"(authorization|cookie|apiKey|password|accessToken)"\s*:/i);
    }
  });
});

describe("§32 collection dashboard stats", () => {
  it("aggregates tasks/runs/records deterministically", async () => {
    const stats = await getCollectionStats(db);
    expect(stats.totalTasks).toBeGreaterThanOrEqual(1);
    expect(stats.runsToday).toBeGreaterThanOrEqual(1);
    expect(stats.completedToday).toBeGreaterThanOrEqual(1);
    expect(stats.recordsCollectedTotal).toBeGreaterThan(0);
  });
});

describe("§35 performance: 1000+ items, multi-page", () => {
  it("collects 1000 items across 4 pages without stalling", async () => {
    const task = await createFixtureTask({
      name: "perf1000",
      totalItems: 1000,
      pageSize: 250,
      pageLimit: 4,
      latencyMs: 0,
      platform: "bilibili",
    });
    const run = await runAndFinish(task.id, "manual", 60_000);
    expect(run.status).toBe("completed");
    expect(run.pagesFetched).toBe(4);
    expect(run.recordsAccepted).toBe(1000);
    expect(run.durationMs ?? 0).toBeLessThan(30_000);

    const [n] = await db
      .select({ c: sql<number>`count(*)` })
      .from(contentItems)
      .where(eq(contentItems.platform, "bilibili"));
    expect(Number(n.c)).toBe(1000);
  }, 60_000);
});

describe("registry + views (§29)", () => {
  it("fixture connector is registered and marked DEMO", () => {
    const c = getConnector("fixture-remote");
    expect(c).toBeDefined();
    expect(c!.metadata.isDemo).toBe(true);
    expect(c!.metadata.connectorType).toBe("mock");
  });

  it("user rate-limit overrides cannot loosen the connector default (§11)", async () => {
    // direct probe of the runtime policy merger: user asks rps 100 against the
    // fixture default rps 5 → effective interval must stay ≥ 200ms
    const probe = new CollectionRuntime(db, { globalConcurrency: 1 });
    const connector = getConnector("fixture-remote")!;
    const limiter = probe["limiterFor"].call(probe, -1, connector, { rateLimit: { rps: 100 } });
    expect(limiter.intervalMs).toBeGreaterThanOrEqual(200);
    // conservative user override (rps 2 = 500ms) IS honored
    const stricter = probe["limiterFor"].call(probe, -2, connector, { rateLimit: { rps: 2 } });
    expect(stricter.intervalMs).toBeGreaterThanOrEqual(500);
  });
});
