/**
 * Stage 9.5 · Opportunity Profile 治理(§23-§33/§40/§41/§42/§47/§48/§63/§64)。
 *
 * 全部走真实 HTTP(createApp + listen(0)),因为本项目已经吃过教训:
 * service 层绿灯掩盖过"UI 打不存在的端点/参数触发 500"。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Server } from "node:http";
import { createTestDb, type DB } from "../../server/src/db/client";
import { createApp } from "../../server/src/app";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";
import {
  contentItems,
  opportunityRuns,
  topicMemberships,
  topicOpportunitySnapshots,
  topics,
} from "../../server/src/db/schema";
import { BALANCED_PROFILE, EARLY_DISCOVERY_PROFILE } from "../../server/src/opportunity/profiles";
import { listProfileRows, rowToProfile } from "../../server/src/opportunity/profileStore";
import { runOpportunity } from "../../server/src/opportunity/service";

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let server: Server;
let base = "";
let topicId = 0;

const NOW = "2026-09-27T00:00:00.000Z";

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

/** 一份合法草稿(权重故意不归一,验证保存时归一化 §32)。 */
function draft(over: Record<string, unknown> = {}) {
  return {
    name: "测试模型",
    description: "仅用于回归",
    weights: { trend: 30, burst: 20, novelty: 20, whitespace: 15, pattern: 10, lifecycle: 15 },
    minimumEvidence: { minimumAvailableComponents: 3 },
    lifecycleFit: {
      emerging: 65,
      rising: 85,
      peak: 70,
      saturated: 45,
      declining: 25,
      evergreen: 55,
      unknown: null,
    },
    freshness: { trendMaxAgeHours: 24, intelligenceMaxAgeHours: 48, penaltyStale: 0.1 },
    ...over,
  };
}

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;

  const [item] = await db
    .insert(contentItems)
    .values({
      platform: "zhihu",
      platformContentId: "answer:prof1",
      contentType: "answer",
      title: "治理测试内容",
      text: "正文",
      dataQuality: "partial",
      upvotes: 10,
      sourceType: "fixture",
      collectedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: contentItems.id });
  const [t] = await db
    .insert(topics)
    .values({
      name: "治理测试话题",
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
  topicId = t.id;
  await db.insert(topicMemberships).values({
    topicId,
    contentItemId: item.id,
    assignmentMethod: "auto",
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

describe("§23/§26 种子模型 = 代码常量(迁移不得破坏 Balanced)", () => {
  it("opportunity_profiles 里有内置两行,且逐字段等于代码里的 profile", async () => {
    const rows = await listProfileRows(db);
    expect(rows.map((r) => r.profileKey).sort()).toEqual(["balanced", "early_discovery"]);
    const balanced = rows.find((r) => r.profileKey === "balanced")!;
    const early = rows.find((r) => r.profileKey === "early_discovery")!;
    expect(rowToProfile(balanced)).toEqual(BALANCED_PROFILE);
    expect(rowToProfile(early)).toEqual(EARLY_DISCOVERY_PROFILE);
  });

  it("有且只有一个当前模型,且默认是 balanced", async () => {
    const rows = await listProfileRows(db);
    const active = rows.filter((r) => r.isActive === 1);
    expect(active).toHaveLength(1);
    expect(active[0].profileKey).toBe("balanced");
    expect(active[0].version).toBe("BALANCED_V1");
  });
});

describe("§63 Profile HTTP 契约", () => {
  it("列表 / 详情 / 兼容端点都存在且形状正确", async () => {
    const list = await get("/api/opportunity/profiles");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body?.rows)).toBe(true);
    expect(typeof list.body?.activeId).toBe("number");
    expect(list.body?.defaultDraft).toBeTruthy();

    const activeId = list.body?.activeId as number;
    const one = await get(`/api/opportunity/profiles/${activeId}`);
    expect(one.status).toBe(200);
    const p = one.body?.profile as Record<string, unknown>;
    expect(p.isActive).toBe(true);
    expect(p.usage).toBeTruthy();
    expect(Object.keys(p.weights as object).sort()).toEqual(
      ["burst", "lifecycle", "novelty", "pattern", "trend", "whitespace"].sort(),
    );

    // 旧端点形状不变(http-contract 断言 profiles 键存在)
    const legacy = await get("/api/opportunity/profile");
    expect(legacy.status).toBe(200);
    expect(Array.isArray(legacy.body?.profiles)).toBe(true);

    expect((await get("/api/opportunity/profiles/424242")).status).toBe(404);
    expect((await get("/api/opportunity/profiles/notanumber")).status).toBe(400);
  });

  it("§32 权重保存时归一化;UI 拿到的是有效权重", async () => {
    const list = await get("/api/opportunity/profiles");
    const baseRow = list.body?.activeId as number;
    const created = await send("POST", `/api/opportunity/profiles/${baseRow}/versions`, draft());
    expect(created.status).toBe(201);
    const w = (created.body?.profile as Record<string, unknown>).weights as Record<string, number>;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    expect(w.trend).toBeCloseTo(30 / 110, 5);
  });

  it("§33 全 0 权重 → 400;负权重 → 400;未知字段 → 400", async () => {
    const list = await get("/api/opportunity/profiles");
    const id = list.body?.activeId as number;
    const zero = await send(
      "POST",
      `/api/opportunity/profiles/${id}/versions`,
      draft({ weights: { trend: 0, burst: 0, novelty: 0, whitespace: 0, pattern: 0, lifecycle: 0 } }),
    );
    expect(zero.status).toBe(400);
    expect(String((zero.body as { error?: string })?.error)).toContain("权重");

    const negative = await send(
      "POST",
      `/api/opportunity/profiles/${id}/versions`,
      draft({ weights: { trend: -1, burst: 1, novelty: 1, whitespace: 1, pattern: 1, lifecycle: 1 } }),
    );
    expect(negative.status).toBe(400);

    const extra = await send("POST", `/api/opportunity/profiles/${id}/versions`, {
      ...draft(),
      hacked: true,
    });
    expect(extra.status).toBe(400);
  });

  it("§34 新鲜度按小时配置并有边界;不允许直接填毫秒级巨值", async () => {
    const list = await get("/api/opportunity/profiles");
    const id = list.body?.activeId as number;
    const silly = await send(
      "POST",
      `/api/opportunity/profiles/${id}/versions`,
      draft({ freshness: { trendMaxAgeHours: 999999, intelligenceMaxAgeHours: 48, penaltyStale: 0.1 } }),
    );
    expect(silly.status).toBe(400);
    const zero = await send(
      "POST",
      `/api/opportunity/profiles/${id}/versions`,
      draft({ freshness: { trendMaxAgeHours: 0, intelligenceMaxAgeHours: 48, penaltyStale: 0.1 } }),
    );
    expect(zero.status).toBe(400);
  });

  it("§40 历史版本不可原地修改:PATCH → 409,且内容确实没变", async () => {
    const list = await get("/api/opportunity/profiles");
    const id = list.body?.activeId as number;
    const before = await get(`/api/opportunity/profiles/${id}`);
    const patched = await send("PATCH", `/api/opportunity/profiles/${id}`, draft({ name: "偷偷改掉历史" }));
    expect(patched.status).toBe(409);
    const after = await get(`/api/opportunity/profiles/${id}`);
    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));
  });

  it("§29/§30 激活切换:任何时刻仍只有一个当前模型", async () => {
    const list = await get("/api/opportunity/profiles");
    const rows = list.body?.rows as { id: number; profileKey: string; isActive: boolean }[];
    const early = rows.find((r) => r.profileKey === "early_discovery" && r.version.endsWith("_V1"))!;
    const act = await send("POST", `/api/opportunity/profiles/${early.id}/activate`, {});
    expect(act.status).toBe(200);
    const after = await get("/api/opportunity/profiles");
    const rowsAfter = after.body?.rows as { isActive: boolean }[];
    expect(rowsAfter.filter((r) => r.isActive).length).toBe(1);
    expect((after.body?.rows as { profileKey: string; isActive: boolean }[]).find((r) => r.isActive)!.profileKey).toBe(
      "early_discovery",
    );
    // 切回 balanced,后续用例继续用它
    const bal = (after.body?.rows as { id: number; profileKey: string; version: string }[]).find(
      (r) => r.profileKey === "balanced" && r.version === "BALANCED_V1",
    )!;
    expect((await send("POST", `/api/opportunity/profiles/${bal.id}/activate`, {})).status).toBe(200);
  });

  it("§42 当前模型不能归档;非当前模型归档后仍在列表里(不物理删除)", async () => {
    const list = await get("/api/opportunity/profiles");
    const rows = list.body?.rows as { id: number; profileKey: string; version: string; isActive: boolean }[];
    const active = rows.find((r) => r.isActive)!;
    expect((await send("POST", `/api/opportunity/profiles/${active.id}/archive`, {})).status).toBe(409);

    const early = rows.find((r) => r.profileKey === "early_discovery" && r.version.endsWith("_V1"))!;
    const arch = await send("POST", `/api/opportunity/profiles/${early.id}/archive`, {});
    expect(arch.status).toBe(200);
    const again = await get("/api/opportunity/profiles");
    const still = (again.body?.rows as { id: number; status: string }[]).find((r) => r.id === early.id);
    expect(still?.status).toBe("archived");
    // 归档后不能当当前模型
    expect((await send("POST", `/api/opportunity/profiles/${early.id}/activate`, {})).status).toBe(409);
    // 恢复给后面的用例用
    await send("POST", `/api/opportunity/profiles/${early.id}/versions`, {
      ...draft(),
      name: "早期发现",
      weights: { trend: 25, burst: 15, novelty: 25, whitespace: 20, pattern: 5, lifecycle: 10 },
    });
  });

  it("§28 复制为新 profile:新 key 首版 V1;非法 key → 400", async () => {
    const created = await send("POST", "/api/opportunity/profiles", {
      ...draft(),
      profileKey: "audit_temp",
      name: "AUDIT_TEMP 临时",
    });
    expect(created.status).toBe(201);
    const p = created.body?.profile as Record<string, unknown>;
    expect(p.profileKey).toBe("audit_temp");
    expect(String(p.version)).toBe("AUDIT_TEMP_V1");
    expect(p.isActive).toBe(false);

    const bad = await send("POST", "/api/opportunity/profiles", { ...draft(), profileKey: "Bad Key" });
    expect(bad.status).toBe(400);
  });

  it("§75 同一份草稿快速重复提交不产生多个相同版本", async () => {
    const list = await get("/api/opportunity/profiles");
    const temp = (list.body?.rows as { id: number; profileKey: string }[]).find((r) => r.profileKey === "audit_temp")!;
    const a = await send("POST", `/api/opportunity/profiles/${temp.id}/versions`, draft());
    const b = await send("POST", `/api/opportunity/profiles/${temp.id}/versions`, draft());
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body?.created).toBe(false);
    expect((b.body?.profile as Record<string, unknown>).version).toBe(
      (a.body?.profile as Record<string, unknown>).version,
    );
    const after = await get("/api/opportunity/profiles");
    const temps = (after.body?.rows as { profileKey: string }[]).filter((r) => r.profileKey === "audit_temp");
    expect(temps.length).toBe(2); // V1 + 刚创建的 V2,没有第三份
  });

  it("run 的 profileId 只接受存在的模型:未知 key → 404", async () => {
    const r = await send("POST", "/api/opportunity/run", { wait: true, profileId: "does_not_exist" });
    expect(r.status).toBe(404);
  });
});

describe("§47/§48 版本化与可复现", () => {
  it("旧快照继续指向它计算时的那个版本,新 Run 用新激活的版本", async () => {
    // 1) 用当前激活版本跑一次,记下版本与那批快照
    await runOpportunity(db, { now: Date.parse("2026-09-27T01:00:00.000Z") });
    const [run1] = await db
      .select()
      .from(opportunityRuns)
      .orderBy(sql`${opportunityRuns.id} DESC`)
      .limit(1);
    const versionBefore = run1.profileVersion;
    const snapBefore = await db
      .select()
      .from(topicOpportunitySnapshots)
      .where(eq(topicOpportunitySnapshots.runId, run1.id));
    expect(snapBefore.length).toBeGreaterThan(0);

    // 2) 建一个权重明显不同的新版本并激活
    const list = await get("/api/opportunity/profiles");
    const activeRow = (list.body?.rows as { id: number; isActive: boolean }[]).find((r) => r.isActive)!;
    const made = await send("POST", `/api/opportunity/profiles/${activeRow.id}/versions`, {
      ...draft(),
      name: "重趋势版",
      weights: { trend: 40, burst: 20, novelty: 10, whitespace: 10, pattern: 10, lifecycle: 10 },
    });
    expect([200, 201]).toContain(made.status); // 幂等:若这份草稿已存在则不再建重复版本
    const newId = (made.body?.profile as Record<string, unknown>).id as number;
    const newVersion = String((made.body?.profile as Record<string, unknown>).version);
    expect((await send("POST", `/api/opportunity/profiles/${newId}/activate`, {})).status).toBe(200);

    // 3) 再跑:新 Run 记录新版本;旧那批快照一行都没被改写
    await runOpportunity(db, { now: Date.parse("2026-09-27T02:00:00.000Z") });
    const [run2] = await db
      .select()
      .from(opportunityRuns)
      .orderBy(sql`${opportunityRuns.id} DESC`)
      .limit(1);
    expect(run2.profileVersion).toBe(newVersion);
    expect(run2.profileVersion).not.toBe(versionBefore);

    const snapOld = await db
      .select()
      .from(topicOpportunitySnapshots)
      .where(eq(topicOpportunitySnapshots.runId, run1.id));
    expect(snapOld.map((s) => `${s.topicId}:${s.profileVersion}:${s.score}`).sort()).toEqual(
      snapBefore.map((s) => `${s.topicId}:${s.profileVersion}:${s.score}`).sort(),
    );
    const snapNew = await db
      .select()
      .from(topicOpportunitySnapshots)
      .where(eq(topicOpportunitySnapshots.runId, run2.id));
    expect(snapNew.length).toBe(snapBefore.length);
    expect(snapNew.every((s) => s.profileVersion === newVersion)).toBe(true);

    // 4) §41:旧版本的用量能在列表里看到(这就是"不可原地改"的证据)
    const oldView = await get(`/api/opportunity/profiles/${activeRow.id}`);
    const usage = (oldView.body?.profile as Record<string, unknown>).usage as { runs: number; snapshots: number };
    expect(usage.runs).toBeGreaterThanOrEqual(1);
    expect(usage.snapshots).toBeGreaterThanOrEqual(1);

    // 5) §30 反证:归档过的版本不能被设为当前模型(拿前面造的 audit_temp 版本试,
    //    不动 balanced 的状态,避免用例之间互相污染)
    const temp = (list.body?.rows as { id: number; profileKey: string }[]).find((r) => r.profileKey === "audit_temp")!;
    await send("POST", `/api/opportunity/profiles/${temp.id}/archive`, {});
    expect((await send("POST", `/api/opportunity/profiles/${temp.id}/activate`, {})).status).toBe(409);

    // 收尾:把当前模型切回均衡 V1,后面的用例从确定状态出发
    const balV1 = (
      (await get("/api/opportunity/profiles")).body?.rows as { id: number; profileKey: string; version: string }[]
    ).find((r) => r.profileKey === "balanced" && r.version === "BALANCED_V1")!;
    expect((await send("POST", `/api/opportunity/profiles/${balV1.id}/activate`, {})).status).toBe(200);
  });

  it("§48 同 profile 版本 + 同输入 + 同时钟 → 分数逐位一致", async () => {
    const list = await get("/api/opportunity/profiles");
    const active = (list.body?.rows as { id: number; isActive: boolean }[]).find((r) => r.isActive)!;
    const made = await send("POST", `/api/opportunity/profiles/${active.id}/versions`, {
      ...draft(),
      name: "可复现验证版",
      weights: { trend: 35, burst: 25, novelty: 15, whitespace: 10, pattern: 8, lifecycle: 7 },
    });
    const vId = (made.body?.profile as Record<string, unknown>).id as number;
    await send("POST", `/api/opportunity/profiles/${vId}/activate`, {});

    const batch = async () => {
      const [run] = await db
        .select({ id: opportunityRuns.id })
        .from(opportunityRuns)
        .orderBy(sql`${opportunityRuns.id} DESC`)
        .limit(1);
      const snap = await db
        .select({ topicId: topicOpportunitySnapshots.topicId, score: topicOpportunitySnapshots.score })
        .from(topicOpportunitySnapshots)
        .where(eq(topicOpportunitySnapshots.runId, run.id));
      return snap.map((s) => `${s.topicId}=${s.score === null ? "null" : s.score.toFixed(6)}`).sort();
    };

    const stamp = Date.parse("2026-09-27T09:00:00.000Z");
    await runOpportunity(db, { now: stamp });
    const first = await batch();
    await runOpportunity(db, { now: stamp });
    const second = await batch();
    // 同一 profile 版本、同一输入、同一时钟:两批逐位相同(引擎无随机、Clock 注入)
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
