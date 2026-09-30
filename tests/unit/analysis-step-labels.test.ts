/**
 * 分析步骤明细的展示口径(§78)。
 *
 * 起因:数据总览「刷新全部分析」的步骤明细里,用户能看到
 * `averageCohesion 0.9 · unclusteredRate 0.8 · needsReviewCount 0`
 * `patternInsufficient 28`、`profileId balanced` —— 渲染函数在标签表缺键时
 * 会把 camelCase 内部键名原样打出来。静态扫描看不见这类文案,因为它来自服务端结果对象。
 * 这里用服务端真实返回的形状把它钉住。
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resultLine } from "../../src/components/FullAnalysisPanel";

const STEP_RESULTS: Record<string, Record<string, unknown>> = {
  向量化: {
    jobId: 95, mode: "api", status: "completed", total: 62, succeeded: 62, failed: 0, skipped: 1, spaceUpgraded: false,
  },
  话题分析: {
    analysisRunId: 146, status: "completed", topicCount: 28, averageCohesion: 0.9, medianCohesion: 0.9,
    unclusteredRate: 0.8, needsReviewCount: 0, durationMs: 480, reembeddedAfterMissing: 62,
  },
  内容评分: { runId: 229, contentCount: 1009, scorableCount: 836, unscorableCount: 173, durationMs: 202 },
  趋势: { runId: 230, topicCount: 28, scorableCount: 28, unscorableCount: 0, transitions: 0, durationMs: 51 },
  内容情报: {
    runId: 115, topicsAnalyzed: 28, contentsAnalyzed: 1009, patternScorable: 0, patternInsufficient: 28, emergingAngleCount: 0,
  },
  选题机会: {
    runId: 118, profileId: "balanced", profileVersion: "opportunity-v3", topicsConsidered: 28, scored: 28, unscorable: 0,
  },
};

describe("分析步骤明细不泄漏内部键名与英文枚举值", () => {
  for (const [step, result] of Object.entries(STEP_RESULTS)) {
    it(`${step}:明细文案全中文标签`, () => {
      const line = resultLine(result);
      expect(line.length).toBeGreaterThan(0);
      // camelCase 键名(averageCohesion 这种)
      expect(line, `${step} → ${line}`).not.toMatch(/[a-z]+[A-Z][A-Za-z]+/);
      // 蛇形键名与英文枚举值(early_discovery / completed / balanced 这种)
      expect(line, `${step} → ${line}`).not.toMatch(/\b(completed|partial|cancelled|balanced|early_discovery|lexical)\b/);
    });
  }

  it("补向量重聚这一步的新字段也有中文标签", () => {
    expect(resultLine({ reembeddedAfterMissing: 62 })).toContain("补向量");
    expect(resultLine({ needsReviewCount: 3 })).toContain("待复核");
  });
});
