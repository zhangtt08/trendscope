/**
 * Stage 7 unit tests:percentile/cohort/creatorBaseline/lifecycle 纯函数。
 * 全部确定性,不依赖真实时间(§CD)。
 */
import { describe, it, expect } from "vitest";
import { percentileRank, median, stddev, growthRatioScore, round1 } from "../../server/src/scoring/percentile";
import { ageBucketKey, resolveCohort } from "../../server/src/scoring/cohort";
import { CONTENT_BURST_PROFILE, LIFECYCLE_PROFILE } from "../../server/src/scoring/profiles";
import { interactionTotal, creatorKeyOf } from "../../server/src/scoring/creatorBaseline";
import { decideLifecycle, type LifecycleFactors } from "../../server/src/scoring/lifecycle";
import { engagementRatioOf } from "../../server/src/scoring/contentBurst";

describe("percentileRank(§M)", () => {
  it("空数组 → null;null 输入 → null", () => {
    expect(percentileRank(5, [])).toBeNull();
    expect(percentileRank(null as unknown as number, [1, 2])).toBeNull();
    expect(percentileRank(NaN, [1, 2])).toBeNull();
  });
  it("单样本 → 50(中位;不造假精确)", () => {
    expect(percentileRank(42, [42])).toBe(50);
  });
  it("并列值同分(mean-rank,无顺序伪影)", () => {
    const values = [10, 20, 20, 30];
    expect(percentileRank(20, values)).toBeCloseTo(50, 10);
    expect(percentileRank(10, values)).toBeCloseTo(12.5, 10);
    expect(percentileRank(30, values)).toBeCloseTo(87.5, 10);
  });
  it("极端值与普通值", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(percentileRank(-1000, values)).toBe(0);
    expect(percentileRank(1e9, values)).toBe(100);
    expect(percentileRank(50, values)).toBeCloseTo(50.5, 10); // mean-rank:(50 below + 0.5×自身)/100
  });
});

describe("median/stddev/growthRatioScore/round1", () => {
  it("median:奇偶与空", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("stddev:n<2 → null", () => {
    expect(stddev([5])).toBeNull();
    expect(stddev([])).toBeNull();
    expect(stddev([2, 2, 2])).toBe(0);
  });
  it("growthRatioScore:r=1 → 50;r=4 → 80;baseline 0 有增长 → 100;双 0 → 50", () => {
    expect(growthRatioScore(10, 10)).toBeCloseTo(50, 10);
    expect(growthRatioScore(40, 10)).toBeCloseTo(80, 10);
    expect(growthRatioScore(2.5, 10)).toBeCloseTo(20, 10);
    expect(growthRatioScore(5, 0)).toBe(100);
    expect(growthRatioScore(0, 0)).toBe(50);
    expect(growthRatioScore(-3, 10)).toBe(0);
  });
  it("round1:最多一位小数;null 穿透", () => {
    expect(round1(82.3471)).toBe(82.3);
    expect(round1(null)).toBeNull();
  });
});

describe("ageBucketKey(§J)", () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
  it("六档边界", () => {
    expect(ageBucketKey(h(5), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("0-6h");
    expect(ageBucketKey(h(6), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("6-24h");
    expect(ageBucketKey(h(23), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("6-24h");
    expect(ageBucketKey(h(24), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("1-3d");
    expect(ageBucketKey(h(71), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("1-3d");
    expect(ageBucketKey(h(72), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("3-7d");
    expect(ageBucketKey(h(167), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("3-7d");
    expect(ageBucketKey(h(168), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("7-30d");
    expect(ageBucketKey(h(719), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("7-30d");
    expect(ageBucketKey(h(720), now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("30d+");
  });
  it("publishedAt 未知 → unknown 独立桶(不与已知年龄混桶,§BE)", () => {
    expect(ageBucketKey(null, now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("unknown");
    expect(ageBucketKey("not-a-date", now, CONTENT_BURST_PROFILE.ageBuckets)).toBe("unknown");
  });
});

describe("resolveCohort 回退梯子(§K)", () => {
  const cand = { platform: "zhihu", contentType: "question", ageBucket: "1-3d", topicId: 7 };
  it("level0 足量即停(exact)", () => {
    const p = resolveCohort(cand, { l0: 30, l1: 100, l2: 200, l3: 500 }, CONTENT_BURST_PROFILE);
    expect(p.levelLabel).toBe("exact");
    expect(p.insufficient).toBe(false);
  });
  it("逐级放宽到首个 ≥30 的级别", () => {
    const p = resolveCohort(cand, { l0: 4, l1: 9, l2: 31, l3: 500 }, CONTENT_BURST_PROFILE);
    expect(p.levelLabel).toBe("broadened_twice");
    expect(p.key).toBe("zhihu|1-3d");
  });
  it("全部 <30 → platform 级兜底(platform_only)", () => {
    const p = resolveCohort(cand, { l0: 2, l1: 3, l2: 4, l3: 12 }, CONTENT_BURST_PROFILE);
    expect(p.levelLabel).toBe("platform_only");
    expect(p.size).toBe(12);
    expect(p.insufficient).toBe(false);
  });
  it("platform 级 < 5 → insufficient(禁 N=4 假精确)", () => {
    const p = resolveCohort(cand, { l0: 1, l1: 2, l2: 3, l3: 4 }, CONTENT_BURST_PROFILE);
    expect(p.insufficient).toBe(true);
  });
});

describe("creatorBaseline(§O/§P)", () => {
  it("interactionTotal:null 不按 0,全 null → null", () => {
    expect(interactionTotal({ likes: 10, comments: null, shares: 2, favorites: null, upvotes: null })).toBe(12);
    expect(interactionTotal({ likes: null, comments: null, shares: null, favorites: null, upvotes: null })).toBeNull();
    expect(interactionTotal({})).toBeNull();
  });
  it("creatorKey:id 优先,name 兜底,双缺 → null", () => {
    expect(creatorKeyOf("u1", "张三")).toBe("id:u1");
    expect(creatorKeyOf(null, "张三")).toBe("name:张三");
    expect(creatorKeyOf(null, null)).toBeNull();
  });
});

describe("engagementRatioOf(§V)", () => {
  it("深互动占比;任一深互动缺失 → null(null≠0 红线)", () => {
    expect(engagementRatioOf("generic", { capturedAt: "", views: null, likes: 100, comments: 10, shares: 5, favorites: 5, upvotes: null }).ratio).toBeCloseTo(0.1667, 3);
    expect(engagementRatioOf("generic", { capturedAt: "", views: null, likes: 100, comments: 10, shares: null, favorites: 5, upvotes: null }).ratio).toBeNull();
    expect(engagementRatioOf("generic", { capturedAt: "", views: null, likes: 0, comments: 0, shares: 0, favorites: 0, upvotes: null }).ratio).toBe(0);
  });
  it("zhihu 主互动是 upvotes 而非 likes(§Q)", () => {
    const r = engagementRatioOf("zhihu", { capturedAt: "", views: null, likes: null, comments: 10, shares: 5, favorites: 5, upvotes: 100 });
    expect(r.ratio).toBeCloseTo(0.1667, 3);
  });
});

function factors(over: Partial<LifecycleFactors>): LifecycleFactors {
  return {
    topicAgeDays: 10,
    memberCount: 10,
    recentNew: 5,
    baselineNew: 2,
    creatorGrowthPositive: true,
    acceleration: 3,
    trendScore: 70,
    burstDensity: 0.1,
    trendHistory: [],
    growthFlattening: null,
    creatorConcentration: null,
    ...over,
  };
}

describe("decideLifecycle(§AN-§AX)", () => {
  it("无趋势分 / 成员过少 → unknown(数据不足,不硬造)", () => {
    expect(decideLifecycle(factors({ trendScore: null }), LIFECYCLE_PROFILE).state).toBe("unknown");
    expect(decideLifecycle(factors({ memberCount: 2 }), LIFECYCLE_PROFILE).state).toBe("unknown");
  });
  it("emerging:年龄短 + 有新增 + 规模小", () => {
    const d = decideLifecycle(factors({ topicAgeDays: 2, memberCount: 8, recentNew: 4 }), LIFECYCLE_PROFILE);
    expect(d.state).toBe("emerging");
  });
  it("declining:近期零新增且基准有量(第一条优先排除)", () => {
    const d = decideLifecycle(factors({ recentNew: 0, baselineNew: 5, trendScore: 30 }), LIFECYCLE_PROFILE);
    expect(d.state).toBe("declining");
  });
  it("declining 需持续性:单日波动(基准有量但仍有新增)不判死", () => {
    const d = decideLifecycle(factors({ recentNew: 1, baselineNew: 5, trendScore: 30, trendHistory: [28] }), LIFECYCLE_PROFILE);
    expect(d.state).not.toBe("declining");
  });
  it("peak:高规模 + 高爆发密度 + 高趋势分", () => {
    const d = decideLifecycle(
      factors({ memberCount: 40, burstDensity: 0.4, trendScore: 80, recentNew: 8, baselineNew: 7, acceleration: 1 }),
      LIFECYCLE_PROFILE,
    );
    expect(d.state).toBe("peak");
  });
  it("rising:趋势分高 + 内容/创作者增长为正", () => {
    const d = decideLifecycle(factors({ trendScore: 75, recentNew: 9, baselineNew: 4, acceleration: 5 }), LIFECYCLE_PROFILE);
    expect(d.state).toBe("rising");
  });
  it("rising 被创作者负增长阻止(§AQ):兜底也不得归入 rising", () => {
    const d = decideLifecycle(
      factors({ trendScore: 75, recentNew: 9, baselineNew: 4, creatorGrowthPositive: false, acceleration: 5 }),
      LIFECYCLE_PROFILE,
    );
    expect(d.state).toBe("saturated");
  });
  it("saturated:高量 + 增长趋平 + 密度回落(初步饱和判断)", () => {
    const d = decideLifecycle(
      factors({ memberCount: 35, recentNew: 8, baselineNew: 7, burstDensity: 0.1, trendScore: 50, acceleration: 1 }),
      LIFECYCLE_PROFILE,
    );
    expect(d.state).toBe("saturated");
  });
  it("evergreen:长龄 + 低波动", () => {
    const d = decideLifecycle(
      factors({ topicAgeDays: 60, memberCount: 12, recentNew: 1, baselineNew: 1, trendScore: 45, trendHistory: [40, 42, 44], acceleration: 0 }),
      LIFECYCLE_PROFILE,
    );
    expect(d.state).toBe("evergreen");
  });
});
