/**
 * Stage 8 integration — 三引擎 golden fixtures(§66-§71/§79),真实 SQLite。
 * Pattern:问句高频爆发组 vs 陈述组(lift 方向)+ 反伪统计(N=2/3);
 * Saturation:同质话题 vs 多样话题;Novelty:新兴角度 + 噪声护栏 + 稳定 ID。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems, topicMemberships, topics } from "../../server/src/db/schema";
import { runIntelligence, getTopicPatterns, getContentFeatureRecord } from "../../server/src/intelligence/service";
import { runTopicTrendScoring } from "../../server/src/scoring/service";
import { getTopicAngles } from "../../server/src/intelligence/repository";
import { getTopicSaturationDetail, getTopicNoveltyDetail } from "../../server/src/intelligence/repository";

let db: DB;
afterAll(() => {
  const anyDb = db as unknown as { $client: { close(): void } };
  anyDb?.$client?.close();
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const d = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let seq = 0;
async function insertItem(v: {
  title: string;
  text?: string | null;
  authorId?: string;
  publishedAt?: string;
}): Promise<number> {
  seq += 1;
  const ts = new Date(NOW).toISOString();
  const [row] = await db
    .insert(contentItems)
    .values({
      platform: "xiaohongshu",
      platformContentId: `s8-${seq}`,
      contentType: "note",
      title: v.title,
      text: v.text ?? "正文内容",
      hashtags: "[]",
      authorId: v.authorId ?? `author-${seq}`,
      authorName: `作者-${v.authorId ?? seq}`,
      publishedAt: v.publishedAt ?? d(10),
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

async function injectBurst(itemId: number, score: number | null): Promise<void> {
  await db.run(sql`
    INSERT INTO content_score_current
      (content_item_id, score_version, scorable, overall_score, confidence, breakdown, evidence, calculated_at, scoring_run_id, platform, topic_id)
    VALUES (${itemId}, 'CONTENT_BURST_V1', ${score === null ? 0 : 1}, ${score}, ${score === null ? null : 'medium'}, '{}', '{}', ${d(1)}, 0, 'xiaohongshu', NULL)
  `);
}

async function insertTopic(name: string, memberBursts: { title: string; burst: number | null; authorId?: string; publishedAt?: string }[]): Promise<number> {
  const ts = new Date(NOW).toISOString();
  const [t] = await db
    .insert(topics)
    .values({
      name,
      status: "active",
      embeddingSpaceId: "lexical-eval",
      namingSource: "keyword",
      memberCount: memberBursts.length,
      keywords: "[]",
      hashtags: "[]",
      firstObservedAt: d(30),
      lastObservedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: topics.id });
  for (const m of memberBursts) {
    const itemId = await insertItem({ title: m.title, authorId: m.authorId, publishedAt: m.publishedAt });
    await db.insert(topicMemberships).values({
      topicId: t.id,
      contentItemId: itemId,
      assignmentMethod: "automatic",
      manualLock: 0,
      createdAt: d(10),
      updatedAt: d(10),
    });
    await injectBurst(itemId, m.burst);
  }
  return t.id;
}

const Q_VIRAL = (i: number) => `该谁付钱?是不是应该AA第${i}篇`;
const FLAT_CONTROL = (i: number) => `今天天气不错去公园散步很舒服记录一下心情第${i}篇`;

describe("Stage 8 Content Intelligence(§66-§71)", () => {
  let T1 = 0, T2 = 0, S1 = 0, S2 = 0, N1 = 0, N3 = 0;
  let run1: Awaited<ReturnType<typeof runIntelligence>>;

  beforeAll(async () => {
    ({ db } = createTestDb());
    // T1 爆发共性 golden(§66):12 条问句型爆发 + 28 条陈述型普通
    T1 = await insertTopic("T1 爆发共性", [
      ...Array.from({ length: 12 }, (_, i) => ({ title: Q_VIRAL(i), burst: 85 + (i % 10), authorId: `viral-${i}` })),
      ...Array.from({ length: 28 }, (_, i) => ({ title: FLAT_CONTROL(i), burst: 20 + (i % 15), authorId: `ctrl-${i}` })),
    ]);
    // T2 反伪统计(§67):viral N=2 / control N=3
    T2 = await insertTopic("T2 反伪统计", [
      { title: Q_VIRAL(90), burst: 99 },
      { title: Q_VIRAL(91), burst: 95 },
      { title: FLAT_CONTROL(90), burst: 10 },
      { title: FLAT_CONTROL(91), burst: 11 },
      { title: FLAT_CONTROL(92), burst: 12 },
    ]);
    // S1 高饱和(§68):标题同质 + 少数作者 + 高频发布
    S1 = await insertTopic("S1 高饱和", [
      ...Array.from({ length: 20 }, (_, i) => ({
        title: "减脂餐搭配打卡",
        burst: 30,
        authorId: `s1a-${i % 2}`,
        publishedAt: d(i % 6),
      })),
    ]);
    // S2 低饱和:数量相当,角度多样 + 创作者多样
    const diverse = [
      "日本旅行七日攻略", "Python 编程入门", "家常红烧肉做法", "健身增肌计划表", "考研英语备考",
      "婴儿辅食添加顺序", "租房合同避坑", "吉他自学路线", "多肉植物养护", "马拉松训练日记",
      "咖啡手冲入门", "中古相机收藏", "露营装备清单", "粤语学习", "魔方还原教程",
      "理财基金定投", "宠物猫绝育", "瑜伽拉伸", "摄影构图", "围棋入门",
    ];
    S2 = await insertTopic("S2 低饱和", diverse.map((t, i) => ({ title: t, burst: 30, authorId: `s2a-${i}`, publishedAt: d(i % 6) })));
    // N1 新兴角度(§69):历史 AA制/礼物 + 近期 打车费
    N1 = await insertTopic("N1 新兴角度", [
      ...Array.from({ length: 3 }, (_, i) => ({ title: `情侣AA制规则讨论第${i}篇`, burst: 40, publishedAt: d(20 - i) })),
      ...Array.from({ length: 3 }, (_, i) => ({ title: `情侣礼物送什么第${i}篇`, burst: 40, publishedAt: d(15 - i) })),
      ...Array.from({ length: 4 }, (_, i) => ({ title: `打车费谁承担才合理第${i}篇`, burst: 40, authorId: `n1-${i}`, publishedAt: d(2 - i * 0.2) })),
    ]);
    // N3 噪声护栏(§70):4 条同角度 + 1 条离群(单条不成角度)
    N3 = await insertTopic("N3 噪声护栏", [
      ...Array.from({ length: 4 }, (_, i) => ({ title: `周末爬山路线分享第${i}篇`, burst: 40, publishedAt: d(3) })),
      { title: "量子物理漫谈", burst: 40, publishedAt: d(1) },
    ]);
    run1 = await runIntelligence(db, { now: NOW });
  });

  it("Run 记账(§60):版本齐全/话题数/样本数", () => {
    expect(run1.topicsAnalyzed).toBe(6);
    expect(run1.contentsAnalyzed).toBe(12 + 28 + 5 + 20 + 20 + 10 + 5);
    expect(run1.patternScorable).toBeGreaterThanOrEqual(1);
    expect(run1.patternInsufficient).toBeGreaterThanOrEqual(1);
    expect(run1.saturatedScorable).toBeGreaterThanOrEqual(2);
  });

  it("Pattern golden(§66):问句结构在爆发组更常见,lift 方向正确", async () => {
    const rows = await getTopicPatterns(db, T1);
    const qs = rows.find((r) => r.feature === "hasQuestionStructure");
    expect(qs).toBeDefined();
    const viral = JSON.parse(qs!.viralValue) as { viralRate: number };
    const control = JSON.parse(qs!.controlValue) as { hits: number };
    expect(viral.viralRate).toBeGreaterThan(0.9);
    expect(control.hits).toBe(0);
    expect(qs!.lift!).toBeGreaterThan(2);
    const notes = JSON.parse(qs!.notes) as { direction: string; smoothingApplied: boolean; controlMatchLevel: string };
    expect(notes.direction).toBe("positive");
    expect(notes.smoothingApplied).toBe(true); // control 0 命中 → 平滑(§19)
    expect(notes.controlMatchLevel).toBe("exact");
    expect(qs!.evidenceQuality).toBe("medium"); // min(12,28)=12
  });

  it("负向模式(§27):爆发组标题更短(median 差为负)", async () => {
    const rows = await getTopicPatterns(db, T1);
    const tl = rows.find((r) => r.feature === "titleLength");
    expect(tl).toBeDefined();
    expect(tl!.delta!).toBeLessThan(0);
    const viral = JSON.parse(tl!.viralValue) as { viralMedian: number; viralIqr: [number, number] };
    expect(viral.viralMedian).toBeGreaterThan(0);
    expect(viral.viralIqr[0]).toBeLessThanOrEqual(viral.viralIqr[1]);
  });

  it("反伪统计(§67):viral N=2 → insufficient,不落 pattern 行", async () => {
    const rows = await getTopicPatterns(db, T2);
    expect(rows.length).toBe(0);
    expect(run1.patternInsufficient).toBeGreaterThanOrEqual(1);
  });

  it("排序(§26):证据质量优先,不让小样本夸张结果排前", async () => {
    const rows = await getTopicPatterns(db, T1);
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2, insufficient: 3 };
    for (let i = 1; i < rows.length; i++) {
      expect(rank[rows[i].evidenceQuality]).toBeGreaterThanOrEqual(rank[rows[i - 1].evidenceQuality]);
    }
  });

  it("饱和度(§68):同质话题显著高于多样话题", async () => {
    const s1 = (await getTopicSaturationDetail(db, S1)).current!;
    const s2 = (await getTopicSaturationDetail(db, S2)).current!;
    expect(s1.score).not.toBeNull();
    expect(s2.score).not.toBeNull();
    expect(s1.score!).toBeGreaterThan(s2.score! + 20);
    expect(s1.score!).toBeGreaterThanOrEqual(67); // high 档
    expect(s2.score!).toBeLessThanOrEqual(45);
    const bd = JSON.parse(s1.breakdown) as { breakdown: Record<string, { score: number | null }> };
    expect(bd.breakdown.repetitionRatio.score!).toBeGreaterThan(bd.breakdown.angleSimilarity.score! - 0.001);
    expect(s1.version).toBe("SATURATION_V1");
  });

  it("新兴角度(§69):近期新簇被判 emerging,历史簇不是", async () => {
    const angles = await getTopicAngles(db, N1);
    const emerging = angles.filter((a) => a.isEmerging === 1);
    expect(emerging.length).toBe(1);
    expect(emerging[0].label).toContain("打车");
    expect(emerging[0].memberCount).toBe(4);
    expect(emerging[0].noveltyScore!).toBeGreaterThan(50);
    expect(emerging[0].firstObservedAt >= d(7)).toBe(true);
    const novelty = (await getTopicNoveltyDetail(db, N1)).current!;
    expect(novelty.emergingAngleCount).toBe(1);
    expect(novelty.score).toBeGreaterThan(50);
    expect(novelty.version).toBe("NOVELTY_V1");
  });

  it("噪声护栏(§70):单条离群不成角度;稳定 ID 跨 Run 继承", async () => {
    const angles = await getTopicAngles(db, N3);
    expect(angles.every((a) => a.memberCount >= 3)).toBe(true);
    // 二次运行:A3 簇 ID 稳定继承;新兴标记保留(曾识别为新兴)
    const before = (await getTopicAngles(db, N1)).find((a) => a.isEmerging === 1)!;
    await runIntelligence(db, { now: NOW + 3_600_000 });
    const after = await getTopicAngles(db, N1);
    const inherited = after.find((a) => a.id === before.id);
    expect(inherited).toBeDefined();
    expect(inherited!.label).toBe(before.label);
    // 特征缓存(§15):第二次运行不再新增 feature 记录
    const count1 = Number((db.all(sql`SELECT COUNT(*) c FROM content_feature_records`)[0] as { c: number }).c);
    await runIntelligence(db, { now: NOW + 7_200_000 });
    const count2 = Number((db.all(sql`SELECT COUNT(*) c FROM content_feature_records`)[0] as { c: number }).c);
    expect(count2).toBe(count1);
    const fr = await getContentFeatureRecord(db, (await db.select({ id: contentItems.id }).from(contentItems).limit(1))[0].id);
    expect(fr).not.toBeNull();
    const features = JSON.parse(fr!.features) as { deterministic: { hasQuestionMark: boolean } };
    expect(typeof features.deterministic.hasQuestionMark).toBe("boolean");
  });

  it("append-only 快照(§62/§63/§64):再跑一次只增不覆盖", async () => {
    const beforeS = Number((db.all(sql`SELECT COUNT(*) c FROM topic_saturation_snapshots`)[0] as { c: number }).c);
    const beforeN = Number((db.all(sql`SELECT COUNT(*) c FROM topic_novelty_snapshots`)[0] as { c: number }).c);
    await runIntelligence(db, { now: NOW + 10_800_000 });
    const afterS = Number((db.all(sql`SELECT COUNT(*) c FROM topic_saturation_snapshots`)[0] as { c: number }).c);
    const afterN = Number((db.all(sql`SELECT COUNT(*) c FROM topic_novelty_snapshots`)[0] as { c: number }).c);
    expect(afterS).toBe(beforeS + 6);
    expect(afterN).toBe(beforeN + 6);
  });

  it("语义特征(§10-§12):RuleBased 恒可用,Zod 枚举合法;AI 缺凭证标 unavailable", async () => {
    const fr = await getContentFeatureRecord(db, (await db.select({ id: contentItems.id }).from(contentItems).limit(1))[0].id);
    const features = JSON.parse(fr!.features) as {
      semantic: { hookType: string; contentStructure: string; conflictIntensity: number } | null;
      semanticUnavailable: string | null;
    };
    expect(features.semantic).not.toBeNull();
    expect(["question", "contrast", "list", "story", "number", "opinion", "none"]).toContain(features.semantic!.hookType);
    expect(["list", "narrative", "qa", "shortTake", "guide"]).toContain(features.semantic!.contentStructure);
    expect(features.semanticUnavailable).toBe("SEMANTIC_FEATURE_CREDENTIAL_MISSING");
    expect(fr!.featureVersion).toBe("CONTENT_FEATURES_V1");
  });

  it("主题列表联合筛选(§74):饱和度/新颖度过滤与 SQL 排序", async () => {
    const { listTopicTrends } = await import("../../server/src/scoring/repository");
    // listTopicTrends 基线是 topic_score_current(INNER JOIN)—— 先跑一次 Stage 7 趋势评分
    await runTopicTrendScoring(db, { now: NOW });
    const high = await listTopicTrends(db, { page: 1, pageSize: 10, saturation: "high" });
    expect(high.rows.map((r) => r.topicId)).toContain(S1);
    expect(high.rows.map((r) => r.topicId)).not.toContain(S2);
    const bySat = await listTopicTrends(db, { page: 1, pageSize: 10, sortBy: "saturation" });
    const scores = bySat.rows.map((r) => r.saturationScore ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
