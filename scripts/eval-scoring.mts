/**
 * Scoring quality evaluation (Stage 7 §CE): npm run eval:scoring
 * 在可控时序 fixture 上运行与生产完全相同的 Content Burst / Topic Trend /
 * Lifecycle 路径,输出每个用例的结果明细(不是只输出 PASS)。
 * 全部确定性(固定时钟);阈值 = 产品默认,不为数据调参。
 */
import { createTestDb } from "../server/src/db/client";
import { eq } from "drizzle-orm";
import { contentItems, contentMetricSnapshots, contentScoreCurrent, topicMemberships, topicSnapshots, topics } from "../server/src/db/schema";
import { runContentScoring, runTopicTrendScoring } from "../server/src/scoring/service";
import { getTopicTrendDetail } from "../server/src/scoring/repository";
import { LIFECYCLE_LABELS_ZH } from "../server/src/scoring/lifecycle";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const { db, sqlite } = createTestDb();

let seq = 0;
async function insertItem(platform: string, authorId: string | null, publishedHoursAgo: number): Promise<number> {
  seq += 1;
  const ts = new Date(NOW).toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform,
      platformContentId: `eval-${seq}`,
      contentType: platform === "zhihu" ? "question" : "note",
      title: `评测内容 ${seq}`,
      text: "评测正文",
      hashtags: "[]",
      authorId,
      authorName: authorId ? `作者-${authorId}` : null,
      publishedAt: h(publishedHoursAgo),
      publishedTz: "UTC",
      publishedTzAssumption: "explicit_offset",
      dataQuality: "partial",
      sourceType: "manual",
      collectedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: contentItems.id });
  return row.id;
}
async function snapItem(id: number, hoursAgo: number, m: Record<string, number | null>): Promise<void> {
  await db.insert(contentMetricSnapshots).values({
    contentItemId: id, capturedAt: h(hoursAgo), views: m.views ?? null, likes: m.likes ?? null,
    comments: m.comments ?? null, shares: m.shares ?? null, favorites: m.favorites ?? null,
    upvotes: m.upvotes ?? null, source: "eval",
  });
}

async function main(): Promise<void> {
  /* ---------- 内容爆发 fixtures(§BY) ---------- */
  const cohortIds: number[] = [];
  for (let i = 0; i < 40; i++) {
    const id = await insertItem("xiaohongshu", `bg-${i}`, 48);
    await snapItem(id, 47, { likes: 100, comments: 5, shares: 1, favorites: 2 });
    await snapItem(id, 1, { likes: 100 + i, comments: 5 + (i % 3), shares: 1, favorites: 2 });
    cohortIds.push(id);
  }
  const caseA = await insertItem("xiaohongshu", "A", 48);
  await snapItem(caseA, 7, { likes: 10, comments: 1, shares: 0, favorites: 1 });
  await snapItem(caseA, 1, { likes: 900, comments: 81, shares: 3, favorites: 20 });

  for (let i = 0; i < 5; i++) {
    const hid = await insertItem("xiaohongshu", "BIG", 24 * 60);
    await snapItem(hid, 30 * 24, { likes: 9000, comments: 500, shares: 200, favorites: 300 });
    await snapItem(hid, 28 * 24, { likes: 9000 + i, comments: 500, shares: 200, favorites: 300 });
  }
  const caseB = await insertItem("xiaohongshu", "BIG", 48);
  await snapItem(caseB, 47, { likes: 9000, comments: 500, shares: 200, favorites: 300 });
  await snapItem(caseB, 1, { likes: 9002, comments: 500, shares: 200, favorites: 300 });

  const caseC = await insertItem("xiaohongshu", "C", 48);
  await snapItem(caseC, 47, { likes: 3, comments: 0, shares: 0, favorites: 0 });
  await snapItem(caseC, 1, { likes: 3, comments: 0, shares: 0, favorites: 0 });

  const caseD = await insertItem("xiaohongshu", "D", 48);
  await snapItem(caseD, 1, { likes: 500, comments: 40, shares: 10, favorites: 25 });

  const caseE = await insertItem("xiaohongshu", "E", 48);
  await snapItem(caseE, 47, { likes: 400, comments: 40, shares: null, favorites: 20 });
  await snapItem(caseE, 1, { likes: 500, comments: 50, shares: null, favorites: 20 });
  const caseF = await insertItem("xiaohongshu", "E", 48);
  await snapItem(caseF, 47, { likes: 400, comments: 40, shares: 0, favorites: 20 });
  await snapItem(caseF, 1, { likes: 500, comments: 50, shares: 0, favorites: 20 });

  const caseG = await insertItem("xiaohongshu", "G", 48); // 无快照
  const caseH = await insertItem("zhihu", null, 48); // 全 null 指标(热榜形态)
  await snapItem(caseH, 1, {});

  const content = await runContentScoring(db, { now: NOW });
  const burst = async (id: number) => {
    const [row] = await db.select().from(contentScoreCurrent).where(eq(contentScoreCurrent.contentItemId, id));
    return row;
  };
  const fmt = (v: number | null) => (v === null ? "数据不足" : String(v));

  console.log("== Content Burst Fixtures(阈值=产品默认,时钟固定)==");
  for (const [name, id, expect] of [
    ["Case A 小账号短时异常增长", caseA, "高分(≥85),velocity 主窗口 24h"],
    ["Case B 大账号相对作者正常", caseB, "creator 基线,分位≈50"],
    ["Case C 低互动(真实 0)", caseC, "低分,0 保留 0 语义"],
    ["Case D 仅 1 次快照", caseD, "velocity 不可用,置信度非 high"],
    ["Case E shares 缺失", caseE, "EQ 不可用(缺失≠0),权重重归一"],
    ["Case F shares 真实 0", caseF, "EQ 可用且可区分于 E"],
    ["Case G 无任何快照", caseG, "unscorable:insufficient_snapshots"],
    ["Case H 全 null 指标(热榜形态)", caseH, "unscorable:insufficient_metrics"],
  ] as [string, number, string][]) {
    const r = await burst(id);
    const bd = r ? JSON.parse(r.breakdown) : null;
    const detail = bd
      ? `overall=${fmt(r?.overallScore ?? null)} 置信=${r?.confidence ?? "—"} velocity=${bd.velocity?.available ? "✓" : "✗"} EQ=${bd.engagementQuality?.available ? "✓" : "✗"} relative=${bd.relativePerformance?.available ? "✓" : "✗"}`
      : "无记录";
    console.log(`  ${name}: ${detail}`);
    console.log(`    期望: ${expect}`);
  }
  console.log(`  运行记账: content=${content.contentCount} scorable=${content.scorableCount} unscorable=${JSON.stringify(content.unscorableBreakdown)} ${content.durationMs}ms`);

  /* ---------- Topic Trend / Lifecycle fixtures(§BZ/§CA) ---------- */
  const mkTopic = async (name: string, ageDaysAgo: number, snaps: { daysAgo: number; nw: number; cr: number | null; mo: number | null }[]) => {
    const ts = new Date(NOW).toISOString();
    const [t] = await db
      .insert(topics)
      .values({
        name, status: "active", embeddingSpaceId: "eval-space", namingSource: "keyword",
        memberCount: 6, keywords: "[]", hashtags: "[]", firstObservedAt: h(ageDaysAgo * 24),
        lastObservedAt: ts, createdAt: ts, updatedAt: ts,
      })
      .returning({ id: topics.id });
    for (const s of snaps) {
      await db.insert(topicSnapshots).values({
        topicId: t.id, analysisRunId: 1, capturedAt: h(s.daysAgo * 24), memberCount: 6,
        newContentCount: s.nw, activeCreatorCount: s.cr, platformCount: 1, averageRawMomentum: s.mo,
        rawEngagementDelta: null, cohesion: 0.8, platformDistribution: '{"xiaohongshu":6}',
      });
    }
    for (let i = 0; i < 6; i++) {
      const itemId = await insertItem("xiaohongshu", `${name}-${i}`, 24 * 10);
      await snapItem(itemId, 24 * 9, { likes: 50, comments: 5, shares: 1, favorites: 2 });
      await snapItem(itemId, 1, { likes: 55, comments: 6, shares: 1, favorites: 2 });
      await db.insert(topicMemberships).values({
        topicId: t.id, contentItemId: itemId, assignmentMethod: "automatic",
        manualLock: 0, createdAt: h(24 * 10), updatedAt: h(24 * 10),
      });
    }
    return t.id;
  };
  const tA = await mkTopic("评测A 加速上升", 13, [
    { daysAgo: 13, nw: 2, cr: 2, mo: 10 }, { daysAgo: 9, nw: 3, cr: 3, mo: 20 },
    { daysAgo: 6, nw: 5, cr: 5, mo: 40 }, { daysAgo: 2, nw: 9, cr: 8, mo: 90 },
  ]);
  const tC = await mkTopic("评测C 衰退", 15, [
    { daysAgo: 13, nw: 6, cr: 6, mo: 50 }, { daysAgo: 9, nw: 5, cr: 5, mo: 40 },
    { daysAgo: 6, nw: 0, cr: 0, mo: 10 }, { daysAgo: 2, nw: 0, cr: 0, mo: 5 },
  ]);
  const tD = await mkTopic("评测D 常青", 60, [
    { daysAgo: 13, nw: 1, cr: 3, mo: 20 }, { daysAgo: 9, nw: 1, cr: 3, mo: 20 },
    { daysAgo: 6, nw: 1, cr: 3, mo: 20 }, { daysAgo: 2, nw: 1, cr: 3, mo: 20 },
  ]);
  const tE = await mkTopic("评测E 样本少", 2, [{ daysAgo: 1, nw: 2, cr: 2, mo: 5 }]);

  const topic = await runTopicTrendScoring(db, { now: NOW });
  console.log("\n== Topic Trend / Lifecycle Fixtures(阈值=产品默认)==");
  for (const [name, id, expect] of [
    ["Topic A 加速上升", tA, "rising(上升),高分"],
    ["Topic C 衰退", tC, "declining(下降),低分"],
    ["Topic D 常青", tD, "evergreen(常青)"],
    ["Topic E 样本少(仅 1 组快照+6 成员)", tE, "可评但低置信 / 或 lifecycle=数据不足"],
  ] as [string, number, string][]) {
    const detail = await getTopicTrendDetail(db, id);
    const cur = detail.current!;
    const label = cur.lifecycle ? LIFECYCLE_LABELS_ZH[cur.lifecycle as keyof typeof LIFECYCLE_LABELS_ZH] : "数据不足";
    console.log(`  ${name}: trend=${fmt(cur.score)} 置信=${cur.confidence ?? "—"} lifecycle=${label}${cur.pendingLifecycle ? `(pending:${cur.pendingLifecycle})` : ""}`);
    console.log(`    期望: ${expect}`);
  }
  console.log(`  运行记账: topics=${topic.topicCount} scorable=${topic.scorableCount} ${topic.durationMs}ms;迁移事件=${topic.lifecycleTransitions.length}`);
  console.log("\n(FUNCTIONAL EVAL — 可控时序 fixture,非真实市场结论;无 LLM 参与,全部确定性)");
  sqlite.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
