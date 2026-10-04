// @vitest-environment jsdom
/**
 * §55-§57/§64:趋势分解展示。核心是"unknown 不能长成一个数字",
 * 以及话题页与趋势中心共用同一份实现(否则两处必然漂移)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LifecycleExplain, TrendBreakdown } from "../../src/components/TrendBreakdown";
import type { TrendDetailPayload } from "../../src/types/scoring";

// 现在 TrendBreakdown / LifecycleExplain 内嵌了 MethodNote,它会异步读 /api/scoring/profile。
// 给个最小 stub 让那次读取能落定,免得 render 之后又有一次未冲刷的 setState 触发 act 警告。
// 注意:这只喂 MethodNote 的外部读取,不改动下面任何一条 §55-§59 的断言。
const METHOD_STUB = {
  burst: {
    version: "B", weights: { velocity: 0.35 }, velocityWindows: [{ key: "24h", hours: 24 }],
    velocityFallback: ["72h"], minSnapshotsForVelocity: 2,
    cohort: { minSample: 20, floorSample: 5, levelLabels: ["A", "B"] }, creatorMinHistory: 5,
    ageBuckets: [{ key: "0-6h", maxHours: 6 }], confidence: {},
  },
  trend: { version: "T", weights: { contentGrowth: 0.35 }, windowHours: 168, burstDensityThreshold: 60, minMembers: 5, confidence: {} },
  lifecycle: { risingTrendMin: 60, hysteresisConsecutive: 3, hysteresisStrongJump: 25 },
  configSnapshot: "snap", note: "note",
};

let container: HTMLDivElement;
let root: Root | null = null;

const comp = (over: Partial<TrendDetailPayload["components"] extends Record<string, infer C> ? C : never> = {}) => ({
  label: "内容增长",
  score: 66.7 as number | null,
  weight: 0.35,
  effectiveWeight: 0.5 as number | null,
  available: true,
  reason: null as string | null,
  evidence: { 当前窗口新增内容: 4, 基准窗口新增内容: 2 } as Record<string, unknown> | null,
  ...over,
});

function payload(over: Partial<TrendDetailPayload> = {}): TrendDetailPayload {
  return {
    topicId: 1,
    overallScore: 63.4567,
    confidence: "medium",
    scoreVersion: "TOPIC_TREND_V1",
    scorable: true,
    unscorableReason: null,
    lifecycle: "rising",
    pendingLifecycle: null,
    pendingCount: 0,
    contentGrowth: 66.7,
    engagementGrowth: 60,
    creatorGrowth: null,
    burstDensity: null,
    acceleration: null,
    components: {
      contentGrowth: comp(),
      engagementGrowth: comp({ label: "互动增长", score: 60, effectiveWeight: 0.5 }),
      creatorGrowth: comp({
        label: "创作者增长",
        score: null,
        available: false,
        effectiveWeight: null,
        reason: "当前与基准窗口的活跃创作者数无法确定",
        evidence: null,
      }),
      burstDensity: comp({
        label: "爆发密度",
        score: null,
        available: false,
        effectiveWeight: null,
        reason: "成员还没有可用的爆发指数(未运行内容评分,或评分覆盖为 0)",
        evidence: null,
      }),
      acceleration: comp({ label: "增长加速度", score: null, available: false, effectiveWeight: null, reason: "内容增长不可用时,二阶加速度无法计算", evidence: null }),
    },
    effectiveWeights: { contentGrowth: 0.5, engagementGrowth: 0.5 },
    unavailableReasons: {
      creatorGrowth: "当前与基准窗口的活跃创作者数无法确定",
      burstDensity: "成员还没有可用的爆发指数(未运行内容评分,或评分覆盖为 0)",
      acceleration: "内容增长不可用时,二阶加速度无法计算",
    },
    breakdownRecorded: true,
    evidence: {},
    memberCount: 3,
    recentNewContent: 4,
    activeCreators: 3,
    avgRawMomentum: 120,
    calculatedAt: "2026-09-26T12:00:00.000Z",
    ...over,
  } as TrendDetailPayload;
}

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
      if (url.includes("/api/opportunity/profile")) return json({ profiles: [], note: "n" });
      if (url.includes("/api/scoring/profile")) return json(METHOD_STUB);
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

// MethodNote 挂载后异步读一次口径;在同一个 act 里把微任务冲刷干净,免得落定发生在 act 之外。
async function render(node: ReactNode) {
  const rr = root!;
  await act(async () => {
    rr.render(node);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TrendBreakdown", () => {
  it("§52 不可用组件显示「数据不足 + 原因」,不出现冒充分数的 0", async () => {
    await render(createElement(TrendBreakdown, { detail: payload() }));
    const text = container.textContent ?? "";
    expect(text).toContain("数据不足");
    expect(text).toContain("当前与基准窗口的活跃创作者数无法确定");
    expect(text).toContain("创作者增长(不可用)");
    // 可用组件仍然给出数值
    expect(text).toContain("内容增长");
    expect(text).toContain("有效 50%");
    // §53 缺失清单说明重归一,而不是悄悄加总
    expect(text).toContain("缺失信号(权重已按比例重归一");
  });

  it("§57 没有假精确:63.4567 不会原样出现在证据里", async () => {
    await render(
      createElement(TrendBreakdown, {
        detail: payload({
          components: {
            contentGrowth: comp({ evidence: { 当前窗口新增内容: 63.4567, 基准窗口新增内容: 2.12345 } }),
            engagementGrowth: comp({ label: "互动增长" }),
            creatorGrowth: comp({ label: "创作者增长", available: true, score: 1, effectiveWeight: 0.2 }),
            burstDensity: comp({ label: "爆发密度", available: true, score: 2, effectiveWeight: 0.2 }),
            acceleration: comp({ label: "增长加速度", available: true, score: 3, effectiveWeight: 0.1 }),
          },
        }),
      }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("63.4567");
    expect(text).toContain("63.5");
    expect(text).toContain("2.1");
  });

  it("§50/§55 旧 Run 没记录分解 → 明说未记录,不按当前权重重算冒充", async () => {
    await render(createElement(TrendBreakdown, { detail: payload({ breakdownRecorded: false, components: null }) }));
    const text = container.textContent ?? "";
    expect(text).toContain("没有记录组件分解");
    expect(text).not.toContain("有效 ");
  });

  it("§58/§59 生命周期:当前阶段 + 最近迁移原因 + 待确认滞回", async () => {
    await render(
      createElement(LifecycleExplain, {
        detail: { lifecycle: "rising", pendingLifecycle: "peak", pendingCount: 1 },
        events: [
          {
            id: 1,
            fromState: "emerging",
            toState: "rising",
            trendScore: 61,
            reason: "趋势指数 61 ≥ 60,内容增长为正,创作者未退潮",
            scoreVersion: "TOPIC_TREND_V1",
            occurredAt: "2026-09-26T10:00:00.000Z",
          },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("当前阶段:");
    expect(text).toContain("最近迁移:新兴 → 上升");
    expect(text).toContain("检测到高位信号,等待连续观察确认");
    expect(text).toContain("第 1 次");
  });
});
