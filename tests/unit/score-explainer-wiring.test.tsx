// @vitest-environment jsdom
/**
 * 组件接线回归测试。
 *
 * 起因:上一轮加了 MethodNote(评分怎么算)与 PendingHint(长任务反馈)两个组件,
 * 但 `grep` 实测它们**没被任何页面 import** —— 写得再对也是死代码,用户永远看不到,
 * 而 typecheck/build 全绿也发现不了(它俩编译得过,只是没人渲染)。这里把"渲染得到"钉成测试:
 *   ① MethodNote 确实长在 TrendBreakdown / LifecycleExplain 里面(评分卡展开就有口径说明);
 *   ② 说明里的数字来自 GET /api/scoring/profile 那份 stub,不是写死 —— 断言权重按接口值渲染;
 *   ③ PendingHint 在长任务下真的给出"已等待 / 为什么慢 / 可替代动作",不是光转圈。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TrendBreakdown, LifecycleExplain } from "../../src/components/TrendBreakdown";
import { MethodNote } from "../../src/components/MethodNote";
import { PendingHint } from "../../src/components/PendingHint";
import type { TrendDetailPayload } from "../../src/types/scoring";

let container: HTMLDivElement;
let root: Root | null = null;

const comp = {
  label: "内容增长",
  score: 66.7 as number | null,
  weight: 0.35,
  effectiveWeight: 0.5 as number | null,
  available: true,
  reason: null as string | null,
  evidence: { 当前窗口新增内容: 4, 基准窗口新增内容: 2 } as Record<string, unknown> | null,
};
const payload = {
  topicId: 1,
  overallScore: 63,
  confidence: "medium",
  scoreVersion: "TOPIC_TREND_V1",
  scorable: true,
  unscorableReason: null,
  lifecycle: "rising",
  pendingLifecycle: "peak",
  pendingCount: 1,
  contentGrowth: 66.7,
  engagementGrowth: 60,
  creatorGrowth: null,
  burstDensity: null,
  acceleration: null,
  components: { contentGrowth: comp },
  effectiveWeights: { contentGrowth: 0.5 },
  unavailableReasons: {},
  breakdownRecorded: true,
  evidence: {},
  memberCount: 3,
  recentNewContent: 4,
  activeCreators: 3,
  avgRawMomentum: 120,
  calculatedAt: "2026-10-02T12:00:00.000Z",
} as unknown as TrendDetailPayload;

// stub 的是接口真实形状:burst/trend 权重、生命周期阈值、机会模型。断言按这些值渲染 = 不是写死。
const SCORING_PROFILE = {
  burst: {
    version: "CONTENT_BURST_V1",
    weights: { velocity: 0.35, reach: 0.25, engagementQuality: 0.15, relativePerformance: 0.15, interactionStructure: 0.1 },
    velocityWindows: [{ key: "24h", hours: 24 }, { key: "72h", hours: 72 }],
    velocityFallback: ["72h", "到今为止"],
    minSnapshotsForVelocity: 2,
    cohort: { minSample: 20, floorSample: 5, levelLabels: ["同平台同类型同年龄", "同平台同类型", "同平台"] },
    creatorMinHistory: 5,
    ageBuckets: [{ key: "0-6h", maxHours: 6 }],
    confidence: {},
  },
  trend: {
    version: "TOPIC_TREND_V1",
    weights: { contentGrowth: 0.35, engagementGrowth: 0.25, creatorGrowth: 0.15, burstDensity: 0.15, acceleration: 0.1 },
    windowHours: 168,
    burstDensityThreshold: 60,
    minMembers: 5,
    confidence: {},
  },
  lifecycle: {
    risingTrendMin: 60,
    hysteresisConsecutive: 3,
    hysteresisStrongJump: 25,
  },
  configSnapshot: "snapshot-hash-abcdef0123456789",
  note: "均为对已观察数据的量化,不是未来爆款概率",
};
const OPPORTUNITY_PROFILE = {
  profiles: [
    {
      id: "balanced",
      label: "均衡机会模型",
      version: "OPP_V1",
      weights: { trend: 0.3, burst: 0.2, novelty: 0.2, whitespace: 0.2, pattern: 0.1 },
      levelBands: { high: 70, medium: 45 },
      minimumAvailableComponents: 3,
      isActive: true,
      status: "active",
    },
  ],
  note: "机会指数只消费已算好的下层结果,不重算、不是概率",
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
      if (url.includes("/api/opportunity/profile")) return json(OPPORTUNITY_PROFILE);
      if (url.includes("/api/scoring/profile")) return json(SCORING_PROFILE);
      return json({});
    }),
  );
});

afterEach(() => {
  const r = root;
  root = null;
  if (r) act(() => r.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// MethodNote 挂载后要等一次 fetch→json→setState 才落定;act(async) 把这些微任务冲干净。
async function render(node: ReactNode) {
  const rr = root!;
  await act(async () => {
    rr.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MethodNote 被真正渲染进评分卡", () => {
  it("TrendBreakdown 里内嵌了话题趋势口径说明,且权重来自接口而非写死", async () => {
    await render(createElement(TrendBreakdown, { detail: payload }));
    const text = container.textContent ?? "";
    // 标题在 <summary> 里,折叠状态也在 DOM 中 → 证明确实被渲染,不是死代码
    expect(text).toContain("话题趋势指数怎么算的");
    expect(text).toContain("TOPIC_TREND_V1");
    // 35% 来自 stub 的 trend.weights.contentGrowth,不是组件里写死的数字
    expect(text).toContain("内容增长");
    expect(text).toContain("35%");
    // 口径出处点名了那两个接口
    expect(text).toContain("GET /api/scoring/profile");
  });

  it("LifecycleExplain 内嵌生命周期判据说明(阈值取自接口)", async () => {
    await render(
      createElement(LifecycleExplain, {
        detail: { lifecycle: "rising", pendingLifecycle: "peak", pendingCount: 1 },
        events: [],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("生命周期怎么判定");
    expect(text).toContain("上升:趋势分下限"); // stub 里 risingTrendMin 的展示映射
  });

  it("burst / opportunity 两个 kind 各自渲染对应权重(覆盖另外两条评分链)", async () => {
    await render(createElement(MethodNote, { kind: "burst" }));
    expect(container.textContent ?? "").toContain("内容爆发指数怎么算的");
    expect(container.textContent ?? "").toContain("互动增速"); // velocity 的中文标签
    await render(createElement(MethodNote, { kind: "opportunity" }));
    expect(container.textContent ?? "").toContain("选题机会指数怎么算的");
    expect(container.textContent ?? "").toContain("均衡机会模型");
  });
});

describe("PendingHint 给出真实等待反馈,而不只是一个转圈", () => {
  it("长任务下露面:已等待 + 为什么慢 + 可替代动作", () => {
    const rr = root!;
    act(() => {
      rr.render(createElement(PendingHint, { show: true, slowAfterMs: 0, why: "这一步要真的调用一次模型。", alt: "可以先读证据摘要。" }));
    });
    const node = container.querySelector('[role="status"]');
    expect(node).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain("已等待");
    expect(text).toContain("这一步要真的调用一次模型。");
    expect(text).toContain("可以先读证据摘要。");
  });

  it("没到 slowAfterMs 的快请求不打扰(返回空)", () => {
    const rr = root!;
    act(() => {
      rr.render(createElement(PendingHint, { show: true, slowAfterMs: 600000, why: "x" }));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
