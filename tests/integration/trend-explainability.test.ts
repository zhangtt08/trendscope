/**
 * Stage 9.5 §49-§59 趋势可解释性。
 * 两层都测:① 真 HTTP 契约(详情端点必须真的带分解/有效权重/不可用原因);
 * ② buildTrendBreakdown 的确定性单测 —— unknown 必须是 null,绝不能是 0。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Server } from "node:http";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import {
  contentItems,
  contentMetricSnapshots,
  topicMemberships,
  topicScoreCurrent,
  topicTrendSnapshots,
  topics,
} from "../../server/src/db/schema";
import { buildTrendBreakdown, type TopicTrendOutput } from "../../server/src/scoring/topicTrend";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let server: Server;
let base = "";
let topicId = 0;

const NOW = "2026-09-26T12:00:00.000Z";

async function get(p: string) {
  const r = await fetch(base + p);
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}
async function send(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;

  const [t] = await db
    .insert(topics)
    .values({
      name: "可解释性测试话题",
      status: "active",
      embeddingSpaceId: "lexical-hash:zh-lexical-v1:512:semantic-v1",
      namingSource: "keyword",
      memberCount: 3,
      keywords: "[]",
      hashtags: "[]",
      representativeItemIds: "[]",
      firstObservedAt: "2026-09-20T00:00:00.000Z",
      lastObservedAt: NOW,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: NOW,
    })
    .returning({ id: topics.id });
  topicId = t.id;

  for (let i = 1; i <= 3; i++) {
    const [item] = await db
      .insert(contentItems)
      .values({
        platform: "zhihu",
        platformContentId: `answer:exp${i}`,
        contentType: "answer",
        title: `可解释性内容 ${i}`,
        text: "正文",
        authorName: `作者${i}`,
        publishedAt: "2026-09-25T00:00:00.000Z",
        dataQuality: "complete",
        upvotes: 100 * i,
        comments: 10 * i,
        sourceType: "fixture",
        collectedAt: "2026-09-25T00:00:00.000Z",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: contentItems.id });
    await db.insert(topicMemberships).values({
      topicId,
      contentItemId: item.id,
      assignmentMethod: "auto",
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: NOW,
    });
    // 两次观测:让增速类组件真的有可比窗口
    await db.insert(contentMetricSnapshots).values([
      {
        contentItemId: item.id,
        capturedAt: "2026-09-25T00:00:00.000Z",
        upvotes: 100 * i,
        comments: 10 * i,
        source: "fixture",
        createdAt: NOW,
      },
      {
        contentItemId: item.id,
        capturedAt: "2026-09-26T00:00:00.000Z",
        upvotes: 180 * i,
        comments: 25 * i,
        source: "fixture",
        createdAt: NOW,
      },
    ]);
  }

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

describe("§51 话题趋势详情 API 必须自带完整分解", () => {
  it("跑完评分后 detail 含五组件/有效权重/证据/计算时间;unknown 是 null 不是 0", async () => {
    expect((await send("POST", "/api/scoring/content/run", { wait: true })).status).toBe(200);
    expect((await send("POST", "/api/scoring/trend/run", { wait: true })).status).toBe(200);

    const r = await get(`/api/topics/${topicId}/trend`);
    expect(r.status).toBe(200);
    const d = r.body?.detail as Record<string, any>;
    expect(d).toBeTruthy();
    expect(typeof d.overallScore === "number" || d.overallScore === null).toBe(true);
    expect(typeof d.scoreVersion).toBe("string");
    expect("lifecycle" in d).toBe(true);
    expect(typeof d.calculatedAt).toBe("string");
    for (const k of ["contentGrowth", "engagementGrowth", "creatorGrowth", "burstDensity", "acceleration"]) {
      expect(k in d).toBe(true);
    }

    // 3 名成员 × 每人 2 次观测:趋势必须真的可评,否则下面的断言会被静默跳过
    expect(d.scorable).toBe(true);
    expect(d.breakdownRecorded).toBe(true);
    const comps = d.components as Record<string, any>;
    expect(Object.keys(comps).sort()).toEqual(
      ["acceleration", "burstDensity", "contentGrowth", "creatorGrowth", "engagementGrowth"].sort(),
    );
    for (const [k, c] of Object.entries(comps)) {
      // §52:不可用 → score=null + reason,前端没有把 null 变 0 的机会
      if (c.available === false) {
        expect(c.score).toBeNull();
        expect(typeof c.reason).toBe("string");
        expect(c.effectiveWeight).toBeNull();
      } else {
        expect(typeof c.score).toBe("number");
        expect(typeof c.effectiveWeight).toBe("number");
        expect(c.reason).toBeNull();
      }
      expect(typeof c.label).toBe("string");
    }
    // §53:重归一后的有效权重总和恒为 1 —— 这是"缺失不当 0 计入"的算术证据
    const eff = d.effectiveWeights as Record<string, number>;
    const sum = Object.values(eff).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
    // §54:至少一组关键证据真的下发了
    const withEvidence = Object.values(comps).filter((c) => c.available && c.evidence);
    expect(withEvidence.length).toBeGreaterThan(0);
  });

  it("§55 重跑评分(upsert 路径)也必须刷新分解,不能停留在 NULL", async () => {
    // 这条是修出来的 bug:topic_score_current 的 onConflictDoUpdate set 列表原本漏了
    // components_json / effective_weights_json,导致同一话题第二次评分后分解永远是空 ——
    // 首次插入走 INSERT 分支看不出来,只有重跑才暴露。
    expect((await send("POST", "/api/scoring/trend/run", { wait: true })).status).toBe(200);
    const [cur] = await db.select().from(topicScoreCurrent).where(eq(topicScoreCurrent.topicId, topicId));
    expect(cur.componentsJson).toBeTruthy();
    expect(cur.effectiveWeightsJson).toBeTruthy();

    const r = await get(`/api/topics/${topicId}/trend`);
    const d = r.body?.detail as Record<string, any>;
    expect(d.breakdownRecorded).toBe(true);
    expect(Object.keys(d.components as object).length).toBe(5);
  });

  it("§55 落库的检查:current 与 snapshot 带着同一份分解", async () => {
    const [cur] = await db.select().from(topicScoreCurrent).where(eq(topicScoreCurrent.topicId, topicId));
    expect(cur).toBeTruthy();
    expect(cur.componentsJson).toBeTruthy();
    expect(cur.effectiveWeightsJson).toBeTruthy();
    const parsed = JSON.parse(cur.componentsJson as string) as Record<string, { label: string; available: boolean }>;
    expect(Object.keys(parsed).length).toBe(5);
    const [snap] = await db
      .select()
      .from(topicTrendSnapshots)
      .where(and(eq(topicTrendSnapshots.topicId, topicId), eq(topicTrendSnapshots.scoringRunId, cur.scoringRunId)))
      .limit(1);
    expect(snap, "current 指向的那次 Run 必须有对应快照").toBeTruthy();
    expect(snap.componentsJson).toBe(cur.componentsJson);
    expect(snap.effectiveWeightsJson).toBe(cur.effectiveWeightsJson);
  });

  it("坏 id → 400;没有评分的话题 → 404 带提示", async () => {
    expect((await get("/api/topics/notanumber/trend")).status).toBe(400);
    expect((await get("/api/topics/0/trend")).status).toBe(400);
    const missing = await get("/api/topics/424242/trend");
    expect(missing.status).toBe(404);
    expect(String((missing.body as { hint?: string })?.hint)).toContain("尚未");
  });
});

describe("§52/§53 buildTrendBreakdown 确定性单测(unknown ≠ 0)", () => {
  const baseOutput = (overrides: Partial<TopicTrendOutput>): TopicTrendOutput =>
    ({
      scorable: true,
      unscorableReason: null,
      score: 60,
      confidence: "medium",
      confidenceScore: 0.6,
      confidenceReasons: [],
      weightsUsed: { contentGrowth: 0.5, engagementGrowth: 0.5 },
      raw: {
        recentNew: 4,
        baselineNew: 2,
        currentCreators: 3,
        baselineCreators: 2,
        currentMomentum: 120,
        baselineMomentum: 80,
        burstDensityRatio: null,
        acceleration: 2,
      },
      evidence: {},
      components: {
        contentGrowth: { score: 66.7, weight: 0.35, available: true, reason: null },
        engagementGrowth: { score: 60, weight: 0.25, available: true, reason: null },
        creatorGrowth: { score: null, weight: 0.15, available: false, reason: "当前与基准窗口的活跃创作者数无法确定" },
        burstDensity: { score: null, weight: 0.15, available: false, reason: "成员还没有可用的爆发指数" },
        acceleration: { score: null, weight: 0.1, available: false, reason: "内容增长不可用时,二阶加速度无法计算" },
      },
      ...overrides,
    }) as unknown as TopicTrendOutput;

  it("缺失组件:score=null、effectiveWeight=null、reason 保留;可用组件给出有效权重", () => {
    const out = buildTrendBreakdown(baseOutput({}));
    expect(out).toBeTruthy();
    const c = out!.components;
    expect(c.creatorGrowth.available).toBe(false);
    expect(c.creatorGrowth.score).toBeNull();
    expect(c.creatorGrowth.effectiveWeight).toBeNull();
    expect(c.creatorGrowth.reason).toContain("创作者");
    expect(c.contentGrowth.available).toBe(true);
    expect(c.contentGrowth.effectiveWeight).toBe(0.5);
    expect(c.contentGrowth.score).toBe(66.7);
    // 关键证据随组件下发,前端不需要自己拼公式
    expect(c.contentGrowth.evidence).toMatchObject({ 当前窗口新增内容: 4, 基准窗口新增内容: 2 });
    expect(Object.keys(out!.unavailableReasons).sort()).toEqual([
      "acceleration",
      "burstDensity",
      "creatorGrowth",
    ]);
  });

  it("不可评分(components=null)不产出假分解", () => {
    expect(buildTrendBreakdown(baseOutput({ components: null, weightsUsed: null }))).toBeNull();
  });

  it("标签是中文业务说法,不是内部字段名", () => {
    const out = buildTrendBreakdown(baseOutput({}));
    expect(out!.components.engagementGrowth.label).toBe("互动增长");
    expect(out!.components.acceleration.label).toBe("增长加速度");
  });
});
