/**
 * Opportunity evaluation (Stage 9 §66):npm run eval:opportunity
 * Golden Topic A-F:输出 Score/Confidence/Level/正向与限制原因 + 排序(不只 PASS)。
 * 阈值 = 产品默认;禁止为 fixture 调权重(§67,fixture 只用于发现明显逻辑错误)。
 */
import { sql } from "drizzle-orm";
import { createTestDb } from "../server/src/db/client";
import { contentItems, topicMemberships, topics } from "../server/src/db/schema";
import { runOpportunity } from "../server/src/opportunity/service";
import { getTopicOpportunityDetail } from "../server/src/opportunity/repository";
import { REASON_ZH } from "../server/src/opportunity/profiles";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const d = (n: number) => iso(NOW - n * 86_400_000);
const { db, sqlite } = createTestDb();

let seq = 0;
async function seedTopic(
  name: string,
  v: {
    trend: { score: number | null; confidence?: string; lifecycle: string | null; burstDensity?: number | null };
    novelty?: { score: number | null; emerging?: number; satScore?: number | null; satConf?: string };
    memberCount?: number;
    memberScores?: number[];
    patterns?: { evidenceQuality: string; lift: number | null; delta: number | null; featureKind: string }[];
  },
): Promise<number> {
  seq += 1;
  const ts = iso(NOW);
  const [t] = await db
    .insert(topics)
    .values({
      name, status: "active", embeddingSpaceId: "lexical-eval", namingSource: "keyword",
      memberCount: v.memberCount ?? (v.memberScores?.length ?? 5), keywords: "[]", hashtags: "[]",
      firstObservedAt: d(20), lastObservedAt: ts, createdAt: ts, updatedAt: ts,
    })
    .returning({ id: topics.id });
  await db.run(sql`
    INSERT INTO topic_score_current
      (topic_id, score_version, scorable, score, confidence, lifecycle, pending_lifecycle, pending_count,
       content_growth, engagement_growth, creator_growth, burst_density, acceleration, member_count,
       recent_new_content, active_creators, avg_raw_momentum, evidence, calculated_at, scoring_run_id)
    VALUES (${t.id}, 'TOPIC_TREND_V1', 1, ${v.trend.score}, ${v.trend.confidence ?? 'medium'}, ${v.trend.lifecycle}, NULL, 0,
            60, 55, 50, ${v.trend.burstDensity ?? 10}, 55, ${v.memberCount ?? (v.memberScores?.length ?? 5)},
            3, 4, 100, '{}', ${d(1)}, 0)
  `);
  if (v.novelty !== undefined) {
    await db.run(sql`
      INSERT INTO topic_intelligence_current
        (topic_id, saturation_score, saturated_confidence, saturation_version, novelty_score, emerging_angle_count,
         novelty_confidence, novelty_version, calculated_at, run_id)
      VALUES (${t.id}, ${v.novelty.satScore ?? null}, ${v.novelty.satConf ?? 'medium'}, 'SATURATION_V1',
              ${v.novelty.score}, ${v.novelty.emerging ?? 0}, ${v.novelty.confidence ?? 'medium'}, 'NOVELTY_V1', ${d(1)}, 0)
    `);
  }
  for (const s of v.memberScores ?? []) {
    const [it] = await db
      .insert(contentItems)
      .values({
        platform: "xiaohongshu", platformContentId: `eval9-${seq}-${Math.random().toString(36).slice(2, 8)}`,
        contentType: "note", title: `评测 ${seq}`, text: "正文", hashtags: "[]",
        authorId: `a-${seq}`, authorName: `作者-${seq}`, publishedAt: d(1),
        publishedTz: "UTC", publishedTzAssumption: "explicit_offset", dataQuality: "partial",
        sourceType: "manual", collectedAt: ts, createdAt: ts, updatedAt: ts,
      })
      .returning({ id: contentItems.id });
    await db.run(sql`
      INSERT INTO content_score_current
        (content_item_id, score_version, scorable, overall_score, confidence, breakdown, evidence, calculated_at, scoring_run_id, platform, topic_id)
      VALUES (${it.id}, 'CONTENT_BURST_V1', 1, ${s}, 'medium', '{}', '{}', ${d(1)}, 0, 'xiaohongshu', ${t.id})
    `);
  }
  for (const p of v.patterns ?? []) {
    await db.run(sql`
      INSERT INTO pattern_results
        (run_id, scope, topic_id, platform, window_hours, feature, feature_kind, viral_value, control_value,
         lift, delta, viral_sample_size, control_sample_size, evidence_quality, notes, feature_version, pattern_version, calculated_at)
      VALUES (0, 'topic', ${t.id}, NULL, 720, 'hasQuestionStructure', ${p.featureKind}, '{}', '{}',
              ${p.lift}, ${p.delta}, 12, 28, ${p.evidenceQuality}, '{"direction":"positive"}', 'CONTENT_FEATURES_V1', 'VIRAL_PATTERN_V1', ${d(1)})
    `);
  }
  return t.id;
}

function main(): void {
  void (async () => {
    const A = await seedTopic("A 上升优质", {
      memberCount: 12,
      trend: { score: 85, confidence: "high", lifecycle: "rising", burstDensity: 50 },
      novelty: { score: 76, emerging: 2, satScore: 43, satConf: "high" },
      memberScores: [85, 80, 78, 75, 72, 70, 68, 65, 60, 55, 50, 45],
      patterns: [
        { evidenceQuality: "high", lift: 2.7, delta: null, featureKind: "boolean" },
        { evidenceQuality: "high", lift: 2.1, delta: null, featureKind: "boolean" },
      ],
    });
    const B = await seedTopic("B 高位饱和", {
      trend: { score: 80, confidence: "high", lifecycle: "peak", burstDensity: 30 },
      novelty: { score: 20, emerging: 0, satScore: 85, satConf: "high" },
      memberScores: [60, 55, 50, 45, 40],
    });
    const C = await seedTopic("C 新兴小样本", {
      memberCount: 3,
      trend: { score: 55, confidence: "medium", lifecycle: "emerging", burstDensity: 20 },
      novelty: { score: 90, emerging: 1, satScore: 20, satConf: "medium" },
      memberScores: [70, 60, 50],
    });
    const D = await seedTopic("D 衰退", {
      trend: { score: 25, confidence: "medium", lifecycle: "declining", burstDensity: 5 },
      novelty: { score: 10, emerging: 0, satScore: 80, satConf: "medium" },
      memberScores: [20, 15, 10],
    });
    const E = await seedTopic("E 常青", {
      trend: { score: 50, confidence: "medium", lifecycle: "evergreen", burstDensity: 15 },
      novelty: { score: 40, emerging: 0, satScore: 50, satConf: "high" },
      memberScores: [50, 45, 40, 40],
      patterns: [{ evidenceQuality: "medium", lift: 1.5, delta: null, featureKind: "boolean" }],
    });
    const F = await seedTopic("F 单爆款", {
      trend: { score: 92, confidence: "medium", lifecycle: "rising", burstDensity: 5 },
      novelty: { score: 15, emerging: 0, satScore: 60, satConf: "medium" },
      memberScores: [95, 30, 25, 20],
    });
    const run = await runOpportunity(db, { now: NOW });
    const rows: { id: number; name: string; score: number | null; confidence: string | null; level: string | null; pos: string[]; lim: string[] }[] = [];
    for (const [name, id] of [["A 上升优质", A], ["B 高位饱和", B], ["C 新兴小样本", C], ["D 衰退", D], ["E 常青", E], ["F 单爆款", F]] as [string, number][]) {
      const detail = await getTopicOpportunityDetail(db, id);
      const cur = detail.current!;
      const ev = JSON.parse(cur.evidence) as { positiveReasons: string[]; limitingReasons: string[] };
      rows.push({ id, name, score: cur.score, confidence: cur.confidence, level: cur.opportunityLevel, pos: ev.positiveReasons ?? [], lim: ev.limitingReasons ?? [] });
    }
    console.log("== Golden Opportunity Topics(阈值=产品默认,时钟固定)==");
    for (const r of rows) {
      const levelZh = r.level === "high" ? "较高机会" : r.level === "medium" ? "中等机会" : "较低机会";
      console.log(`  ${r.name}: 机会指数=${r.score} 置信=${r.confidence} 档位=${levelZh}`);
      console.log(`    正向: ${r.pos.join(";") || "—"}`);
      console.log(`    限制: ${r.lim.join(";") || "—"}`);
    }
    const sorted = [...rows].filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    console.log("\n排序(机会指数降序,不代表未来结果):");
    console.log(`  ${sorted.map((r) => `${r.name.split(" ")[0]}=${r.score}`).join(" > ")}`);
    console.log(`\n(runId=${run.runId} scored=${run.scored}/${run.topicsConsidered} ${run.durationMs}ms;FUNCTIONAL EVAL — 可控 fixture,非真实选题建议)`);
    sqlite.close();
  })();
}

main();
