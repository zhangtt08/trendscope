/**
 * Stage 8 unit:确定性中文特征 / Lift 平滑 / 控制组梯子 / 角度文本 / HHI 集中度。
 */
import { describe, it, expect } from "vitest";
import { extractDeterministicFeatures } from "../../server/src/intelligence/features";
import { booleanLift, matchControlGroup, type FeatureRecord } from "../../server/src/intelligence/viralPattern";
import { buildAngleText } from "../../server/src/intelligence/angleText";
import { creatorConcentration } from "../../server/src/intelligence/saturation";
import { labelFromTitles } from "../../server/src/intelligence/novelty";
import { INTELLIGENCE_PROFILE } from "../../server/src/intelligence/profiles";

const BASE = {
  publishHour: null,
  publishWeekday: null,
  hashtags: null,
  publishedAt: null,
};

describe("确定性中文特征(§8/§9)", () => {
  it("问句结构:到底/是不是/为什么/还是/A还是B", () => {
    const f = extractDeterministicFeatures({ title: "情侣旅游到底该谁付打车费", text: "是不是男生应该全包?还是AA?", ...BASE });
    expect(f.hasQuestionStructure).toBe(true);
    expect(f.hasExplicitComparison).toBe(true);
    expect(f.hasQuestionMark).toBe(true);
  });
  it("金额表达:¥/元/多少钱/工资", () => {
    expect(extractDeterministicFeatures({ title: "月薪 5000 怎么存钱", text: null, ...BASE }).hasPriceOrMoneyExpression).toBe(true);
    expect(extractDeterministicFeatures({ title: "这顿饭花了 300 元", text: null, ...BASE }).hasPriceOrMoneyExpression).toBe(true);
    expect(extractDeterministicFeatures({ title: "今天天气不错", text: "散步", ...BASE }).hasPriceOrMoneyExpression).toBe(false);
  });
  it("地区词/身份词/第一/第二人称", () => {
    const f = extractDeterministicFeatures({ title: "上海打工人的一天", text: "我们这些北漂,你觉得累吗", ...BASE });
    expect(f.hasRegion).toBe(true);
    expect(f.hasIdentityExpression).toBe(true);
    expect(f.hasFirstPerson).toBe(true);
    expect(f.hasSecondPerson).toBe(true);
  });
  it("数字/清单/强标点/冒号/中文数字", () => {
    const f = extractDeterministicFeatures({ title: "三分钟学会", text: "1、第一步 2、第二步!!", ...BASE });
    expect(f.hasNumber).toBe(true);
    expect(f.hasListStructure).toBe(true);
    expect(f.hasStrongPunctuation).toBe(true);
    expect(f.hasColon).toBe(false);
    const g = extractDeterministicFeatures({ title: "避坑:五件事", text: null, ...BASE });
    expect(g.hasColon).toBe(true);
    expect(g.hasNumber).toBe(true);
  });
  it("话题标签", () => {
    expect(extractDeterministicFeatures({ ...BASE, title: "通勤穿搭", text: null, hashtags: ["穿搭"] }).hasHashtag).toBe(true);
  });
  it("连续特征不转 bool:titleLength/textLength/发布小时", () => {
    const f = extractDeterministicFeatures({ ...BASE, title: "一二三四五", text: "abcdef", publishedAt: "2026-09-25T08:30:00Z" });
    expect(f.titleLength).toBe(5);
    expect(f.textLength).toBe(6);
    expect(f.publishHour).toBe(8);
    expect(f.publishWeekday).toBe(5); // 2026-09-25 是周五(UTC)
  });
});

describe("Lift 平滑(§19)", () => {
  it("controlRate=0 → 平滑,不输出 Infinity", () => {
    const { lift, smoothingApplied } = booleanLift(6, 10, 0, 20, INTELLIGENCE_PROFILE);
    expect(smoothingApplied).toBe(true);
    expect(Number.isFinite(lift.lift)).toBe(true);
    expect(lift.controlRate).toBeGreaterThan(0);
    expect(lift.viralRate).toBeCloseTo(0.58, 2); // (6+1)/(10+2)
  });
  it("无零命中不平滑", () => {
    const { lift, smoothingApplied } = booleanLift(5, 10, 5, 10, INTELLIGENCE_PROFILE);
    expect(smoothingApplied).toBe(false);
    expect(lift.lift).toBe(1);
  });
});

function rec(id: number, platform: string, contentType: string, ageBucket: string, burst: number | null): FeatureRecord {
  return {
    contentItemId: id,
    platform,
    contentType,
    ageBucket,
    topicId: 1,
    authorKey: `a${id}`,
    publishedAt: null,
    burstScore: burst,
    deterministic: extractDeterministicFeatures({ title: `t${id}`, text: null, ...BASE }),
    semantic: null,
  };
}

describe("控制组匹配梯子(§4/§5)", () => {
  const viral = [rec(1, "zhihu", "question", "1-3d", 90), rec(2, "zhihu", "question", "1-3d", 85)];
  const topicPool = Array.from({ length: 16 }, (_, i) => rec(100 + i, "zhihu", "question", "1-3d", 40));
  const otherTypePool = Array.from({ length: 20 }, (_, i) => rec(200 + i, "zhihu", "article", "1-3d", 30));
  it("level0 足量即停(exact)", () => {
    const m = matchControlGroup(viral, topicPool, [], INTELLIGENCE_PROFILE);
    expect(m?.levelLabel).toBe("exact");
  });
  it("类型不足放宽到 topic_platform_age", () => {
    const m = matchControlGroup(viral, otherTypePool, [], INTELLIGENCE_PROFILE);
    expect(m?.levelLabel).toBe("topic_platform_age");
  });
  it("话题内不足 → platform_global(标注,不拿全站冒充)", () => {
    const m = matchControlGroup(viral, [], otherTypePool, INTELLIGENCE_PROFILE);
    expect(m?.levelLabel).toBe("platform_global");
  });
  it("两侧都不足 → null(insufficient_data,§6)", () => {
    expect(matchControlGroup(viral, topicPool.slice(0, 3), [], INTELLIGENCE_PROFILE)).toBeNull();
  });
});

describe("AngleText(§34)与集中度(§37)", () => {
  it("标题主导,弱化正文;URL 不参与", () => {
    const a = buildAngleText({ title: "情侣旅游费用大讨论", text: "长长长长正文".repeat(30), hashtags: ["情侣经济"] });
    expect(a.text.startsWith("情侣旅游费用大讨论")).toBe(true);
    expect(a.text.includes("长长长长正文长长")).toBe(false);
    expect(a.version).toBe("ANGLE_TEXT_V1");
    expect(a.hash).toHaveLength(64);
  });
  it("HHI:均匀 → 0;单作者 → 1;作者全缺失 → null", () => {
    expect(creatorConcentration(["a", "b", "c", "d"])).toBe(0);
    expect(creatorConcentration(["a", "a", "a"])).toBe(1);
    expect(creatorConcentration([null, null])).toBeNull();
  });
  it("角度命名回退(§50):高频 bigram", () => {
    const label = labelFromTitles(["打车费谁承担", "打车费该谁付", "打车费 discussion"]);
    expect(label).toContain("打车");
  });
});
