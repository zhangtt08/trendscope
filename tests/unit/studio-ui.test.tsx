// @vitest-environment jsdom
/**
 * 选题工作室前端集成测试(§22-§27、§70、§71、§75)。
 *
 * 和 profile-ui 同一理由:这个项目两次栽在"tsc 全绿但页面是坏的"上。
 * 这里渲染真实组件、打真实 fetch,断言的是用户看得见的东西:
 * 无凭据时按钮禁用但证据照常可读、连点不会重复生成、切换话题不串台、
 * 未知显示为"—"而不是 0、失败显示错误与重试而不是"暂无数据"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TopicStudio from "../../src/pages/TopicStudio";
import type { StudioView } from "../../src/types/studio";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

const records: Recorded[] = [];
let generateCount = 0;
let generateDelayMs = 0;
let viewFailures = 0;
let configured = false;
let container: HTMLDivElement;
let root: Root | null = null;

function evidenceOver(over: Record<string, unknown>): Record<string, unknown> {
  return {
    evidenceVersion: "evidence-package-v1",
    evidenceHash: "ev-aaa111",
    builtAt: "2026-09-26T12:00:00.000Z",
    topicId: 1,
    topicName: "减脂餐",
    topicDescription: "围绕减脂餐的提问集合",
    memberCount: 6,
    topKeywords: ["减脂", "餐"],
    topHashtags: [],
    platformDistribution: { xiaohongshu: 6 },
    opportunityScore: 32.9,
    opportunityConfidence: "medium",
    opportunityLevel: "low",
    opportunityScoreVersion: "opportunity_v1",
    positiveOpportunityReasons: ["新兴话题"],
    limitingOpportunityReasons: ["饱和度 68,内容重复度较高"],
    lifecycle: "rising",
    lifecycleReason: null,
    pendingLifecycle: null,
    trendScore: 50,
    trendConfidence: "low",
    trendEvidence: null,
    trendEffectiveWeights: null,
    trendUnavailableReasons: null,
    burstDensity: 0,
    topBurstContents: [],
    representativeContent: [
      {
        refId: "rep-1",
        contentItemId: 11,
        title: "减脂餐怎么安排",
        excerpt: "正文摘要",
        platform: "xiaohongshu",
        contentType: "answer",
        authorName: null,
        burstScore: 71,
        burstConfidence: "medium",
        likes: 12,
        comments: null,
        publishedAt: null,
        truncated: false,
      },
    ],
    viralPatterns: [
      {
        refId: "pattern-1",
        feature: "带步骤清单",
        featureKind: "structure",
        viralRate: 0.44,
        controlRate: 0.21,
        lift: 2.1,
        delta: 0.23,
        viralSampleSize: 9,
        controlSampleSize: 40,
        evidenceQuality: "medium",
        direction: "more_common",
        controlMatchLevel: "topic",
        smoothingApplied: false,
      },
    ],
    saturationScore: 68,
    saturationBand: "高",
    saturationEvidence: null,
    noveltyScore: null,
    noveltyConfidence: null,
    emergingAngles: [
      {
        refId: "angle-1",
        label: "上班族快手版",
        labelSource: "keyword",
        memberCount: 2,
        noveltyScore: 67.5,
        isEmerging: true,
        firstObservedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    dataFreshness: {
      trendCalculatedAt: "2026-09-26T10:00:00.000Z",
      intelligenceCalculatedAt: null,
      opportunityCalculatedAt: "2026-09-26T11:00:00.000Z",
      ageHours: { trend: 2, intelligence: null, opportunity: 1 },
      stale: false,
    },
    qualityMode: "lexical_baseline",
    sourceKinds: { manual: 6 },
    demoData: false,
    evidenceTruncated: { representative: false, burstContents: false, patterns: false, angles: false, packageSize: false },
    evidenceIndex: [
      { id: "topic-1", kind: "topic", label: "话题 减脂餐(6 条成员)" },
      { id: "trend-1", kind: "trend", label: "话题趋势指数 50(生命周期 上升)" },
      { id: "opportunity-1", kind: "opportunity", label: "选题机会指数 32.9" },
      { id: "saturation-1", kind: "saturation", label: "饱和度 68(高)" },
      { id: "pattern-1", kind: "pattern", label: "共性 带步骤清单 ×2.1" },
      { id: "angle-1", kind: "angle", label: "角度 上班族快手版" },
      { id: "rep-1", kind: "representative", label: "代表内容 减脂餐怎么安排" },
    ],
    charCount: 5200,
    ...over,
  };
}

function outputFixture() {
  return {
    topicSummary: "话题概述文本",
    whyNow: "趋势处于上升段,机会指数的正向信号来自新兴话题。",
    targetAudience: "内容运营",
    recommendedAngles: [
      {
        name: "把共识拆成步骤",
        coreIdea: "给出可复述的清单。",
        targetAudience: "入门读者",
        conflict: "共识多细节少",
        whyItMayBeInteresting: "趋势与机会指标为正向。",
        evidenceRefs: ["trend-1", "pattern-1"],
        saturationRisk: "medium",
        noveltyBasis: "清单式表达较少。",
      },
      {
        name: "第二条角度",
        coreIdea: "另一个切法。",
        targetAudience: "已有判断的读者",
        conflict: "争议点",
        whyItMayBeInteresting: "角度样本稀少。",
        evidenceRefs: ["angle-1"],
        saturationRisk: "low",
        noveltyBasis: "新兴角度。",
      },
    ],
    hooks: [{ kind: "question", text: "为什么今年被反复提问?", evidenceRefs: ["trend-1"] }],
    titleDirections: [{ text: "被反复提问的三个细节", basedOn: "趋势上升", evidenceRefs: ["trend-1"], needsExternalVerification: false }],
    contentStructures: [{ name: "观察 → 步骤", outline: ["第一步", "第二步"], rationale: "对齐提问", evidenceRefs: ["rep-1"] }],
    stanceOptions: [{ label: "支持清单", summary: "清单更有价值", audienceFit: "入门", risks: "泛泛而谈", evidenceRefs: [] }],
    risks: ["样本量偏小"],
    avoidAngles: ["重复共识清单"],
    evidenceReferences: ["trend-1", "opportunity-1"],
    confidenceNote: "只基于本机已采集证据。",
  };
}

let marksWritten: { angleIndex: number | null; state: string; note: string | null }[] = [];
let generated = false;

function viewFixture(topicId: number, over: Partial<StudioView> = {}): StudioView {
  const evidence = evidenceOver({ topicId, topicName: topicId === 1 ? "减脂餐" : "另一个话题" }) as StudioView["evidence"];
  return {
    brief: {
      generatedAt: "2026-09-26T12:00:00.000Z",
      kind: "deterministic_evidence_brief",
      deterministic: true,
      isAiGenerated: false,
      topicId,
      topicName: evidence.topicName,
      sections: [
        { key: "status", title: "话题现状", lines: ["成员 6 条 · 平台 小红书 6", "选题机会指数 32.9(置信 中,档位 较低机会)", "新颖度 数据不足"] },
        { key: "positive", title: "正向信号", lines: ["新兴话题"], emptyNote: "无正向信号。" },
        { key: "patterns", title: "爆发共性(观察到的关联,非因果)", lines: [], emptyNote: "样本不足。" },
      ],
    },
    evidence,
    settings: {
      configured,
      provider: "openai-compatible",
      baseUrl: "https://ai.example.com/v1",
      model: "unit-model",
      temperature: 0.4,
      maxTokens: 2000,
      timeoutMs: 60000,
      secretStatus: configured ? "configured" : "missing",
      secretSource: "环境变量 STUDIO_API_KEY",
      missingEnvNames: configured ? [] : ["STUDIO_API_KEY"],
      usingDefaults: [],
      promptVersion: "studio-prompt-v1",
      schemaVersion: "studio-output-v1",
      evidenceVersion: "evidence-package-v1",
    },
    versions: { promptVersion: "studio-prompt-v1", schemaVersion: "studio-output-v1", evidenceVersion: "evidence-package-v1" },
    history:
      generated && topicId === 1
        ? [
            {
              id: 7,
              topicId: 1,
              status: "completed",
              kind: "ai",
              provider: "openai-compatible",
              model: "unit-model",
              promptVersion: "studio-prompt-v1",
              schemaVersion: "studio-output-v1",
              evidenceVersion: "evidence-package-v1",
              evidenceHash: "ev-aaa111",
              output: outputFixture() as never,
              unsupportedClaims: [],
              error: null,
              demoData: false,
              staleEvidence: false,
              evidenceTruncated: null,
              startedAt: "2026-09-26T12:00:00.000Z",
              completedAt: "2026-09-26T12:00:01.000Z",
              createdAt: "2026-09-26T12:00:00.000Z",
              durationMs: 12,
              marks: marksWritten,
            },
          ]
        : [],
    ...over,
  } as StudioView;
}

const flush = async (ms = 25, rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};

const text = () => container.textContent || "";
const buttons = () => Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];

function clickButton(label: string, match: "exact" | "has" = "exact"): boolean {
  const btn = buttons().find((b) => (match === "exact" ? b.textContent?.trim() === label : (b.textContent || "").includes(label)));
  if (!btn) return false;
  act(() => {
    btn.click();
  });
  return true;
}

function renderAt(path: string) {
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/studio/:topicId?" element={<TopicStudio />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  records.length = 0;
  generateCount = 0;
  generateDelayMs = 0;
  marksWritten = [];
  generated = false;
  viewFailures = 0;
  configured = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      records.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) =>
        ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

      if (method === "GET" && /\/api\/studio\/topics\?/.test(url)) {
        return json({
          topics: [
            {
              topicId: 1,
              name: "减脂餐",
              status: "active",
              namingSource: "keyword",
              memberCount: 6,
              updatedAt: "2026-09-26T11:00:00.000Z",
              opportunityScore: 32.9,
              opportunityLevel: "low",
              opportunityConfidence: "medium",
              trendScore: 50,
              lifecycle: "rising",
              lastRunAt: null,
              runCount: 0,
            },
            {
              topicId: 2,
              name: "未评分话题",
              status: "active",
              namingSource: "keyword",
              memberCount: 3,
              updatedAt: "2026-09-25T11:00:00.000Z",
              opportunityScore: null,
              opportunityLevel: null,
              opportunityConfidence: null,
              trendScore: null,
              lifecycle: null,
              lastRunAt: null,
              runCount: 0,
            },
          ],
        });
      }
      if (method === "GET" && /\/api\/studio\/topics\/(\d+)$/.test(url)) {
        if (viewFailures > 0) {
          viewFailures -= 1;
          return json({ error: "服务端错误: 模拟失败" }, 500);
        }
        const topicId = Number(url.match(/topics\/(\d+)$/)![1]);
        return json(viewFixture(topicId));
      }
      if (method === "POST" && /\/generate$/.test(url)) {
        generateCount += 1;
        if (generateDelayMs) await new Promise((r) => setTimeout(r, generateDelayMs));
        if (configured) generated = true;
        if (!configured) {
          return json({ error: "尚未配置 AI 生成服务(缺少环境变量 STUDIO_API_KEY)。" }, 409);
        }
        return json({
          runId: 7,
          status: "completed",
          reused: false,
          output: outputFixture(),
          unsupportedClaims: [],
          error: null,
          provider: "openai-compatible",
          model: "unit-model",
          durationMs: 12,
          evidenceHash: "ev-aaa111",
          evidenceTruncated: { representative: false, burstContents: false, patterns: false, angles: false, packageSize: false },
          demoData: false,
          staleEvidence: false,
        });
      }
      if (method === "POST" && /\/mark$/.test(url)) {
        const b = JSON.parse(String(init!.body)) as { angleIndex?: number | null; state?: string; note?: string | null };
        const key = b.angleIndex ?? null;
        marksWritten =
          b.state === "none"
            ? marksWritten.filter((m) => m.angleIndex !== key)
            : [...marksWritten.filter((m) => m.angleIndex !== key), { angleIndex: key, state: String(b.state), note: b.note ?? null }];
        return json({ mark: { id: 1, runId: 7, topicId: 1, angleIndex: key, state: b.state, note: b.note ?? null } });
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("选题工作室:无 AI 凭据(§14/§15/§25)", () => {
  it("证据与摘要照常可读,生成按钮禁用并说明配置方法", async () => {
    renderAt("/studio/1");
    await flush();
    expect(text()).toContain("证据面板");
    expect(text()).toContain("证据摘要(确定性,非 AI)");
    expect(text()).toContain("尚未配置 AI 生成服务");
    expect(text()).toContain("STUDIO_API_KEY");
    const gen = buttons().find((b) => (b.textContent || "").includes("生成选题方案"))!;
    expect(gen.disabled).toBe(true);
    const regen = buttons().find((b) => (b.textContent || "").includes("重新生成"))!;
    expect(regen.disabled).toBe(true);
    expect(gen.title).toContain("STUDIO_API_KEY");
    expect(records.some((r) => r.method === "POST")).toBe(false);
  });

  it("摘要不会被标成 AI 建议,平台与档位是全中文(§78)", async () => {
    renderAt("/studio/1");
    await flush();
    expect(text()).toContain("小红书 6");
    expect(text()).toContain("较低机会");
    expect(text()).not.toContain("xiaohongshu");
    expect(text()).not.toMatch(/AI 建议/);
  });

  it("未知指标显示为数据不足/破折号,不是 0(§75)", async () => {
    renderAt("/studio/1");
    await flush();
    expect(text()).toContain("新颖度");
    expect(text()).toContain("数据不足");
    const panel = container.querySelector(".content") ?? container;
    expect(panel.textContent || "").not.toMatch(/新颖度\s*0\s*置信/);
  });
});

describe("选题工作室:生成与人工状态", () => {
  it("连点生成只发一次请求,方案渲染并带证据编号(§71/§10)", async () => {
    configured = true;
    generateDelayMs = 40;
    renderAt("/studio/1");
    await flush();
    const gen = () => clickButton("生成选题方案");
    act(() => {
      gen();
      gen();
      gen();
    });
    await flush(30, 6);
    expect(generateCount).toBe(1);
    expect(text()).toContain("选题方案已生成");
    expect(text()).toContain("把共识拆成步骤");
    expect(text()).toContain("trend-1·话题趋势指数 50(生命周期 上升)");
    expect(container.querySelectorAll(".angle-card").length).toBeGreaterThan(0);
  });

  it("切换话题后旧方案不会挂在新话题上(§70 实体级 stale)", async () => {
    configured = true;
    renderAt("/studio/1");
    await flush();
    clickButton("生成选题方案");
    await flush(30, 5);
    expect(text()).toContain("把共识拆成步骤");
    // 通过话题列表切到 #2
    const picks = buttons().filter((b) => (b.textContent || "").includes("查看证据"));
    expect(picks.length).toBe(2);
    act(() => {
      picks[1].click();
    });
    await flush(30, 5);
    const second = records.filter((r) => r.method === "GET" && /topics\/2$/.test(r.url));
    expect(second.length).toBeGreaterThan(0);
    expect(text()).toContain("另一个话题");
    expect(text()).not.toContain("把共识拆成步骤");
  });

  it("收藏与保存都会打到 /runs/:id/mark(§21)", async () => {
    configured = true;
    renderAt("/studio/1");
    await flush();
    clickButton("生成选题方案");
    await flush(30, 5);
    expect(clickButton("收藏", "has")).toBe(true);
    await flush(20, 3);
    const mark = records.find((r) => r.method === "POST" && /runs\/\d+\/mark$/.test(r.url));
    expect(mark).toBeTruthy();
    expect((mark!.body as { state: string }).state).toBe("favorite");
    expect(text()).toContain("已收藏");
    clickButton("已收藏", "has");
    await flush(20, 4);
    const calls = records.filter((r) => r.method === "POST" && /mark$/.test(r.url));
    expect((calls[calls.length - 1]!.body as { state: string }).state).toBe("none");
    expect(text()).toContain("收藏");
  });

  it("生成失败显示错误与原因,不伪装成没有数据", async () => {
    configured = true;
    renderAt("/studio/1");
    await flush();
    configured = false; // 让 fetch 返回 409
    clickButton("生成选题方案");
    await flush(20, 4);
    expect(text()).toContain("尚未配置 AI 生成服务");
    expect(container.querySelector(".banner.err")).not.toBeNull();
  });
});

describe("选题工作室:加载状态与错误状态", () => {
  it("证据加载失败 → 错误 + 重试按钮(§42)", async () => {
    viewFailures = 1;
    renderAt("/studio/1");
    await flush();
    expect(text()).toContain("模拟失败");
    expect(clickButton("重试", "has")).toBe(true);
    viewFailures = 0;
    await flush(30, 5);
    expect(text()).toContain("证据面板");
  });

  it("没有可选话题时给出下一步指引,不是空表格(§41)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (/topics\?/.test(url)) return { ok: true, status: 200, json: async () => ({ topics: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }));
    renderAt("/studio");
    await flush();
    expect(text()).toContain("没有可选话题");
    expect(text()).toContain("话题分析");
  });
});

describe("选题工作室:复制按钮必须给出结果反馈(§67 死按钮)", () => {
  it("剪贴板不可用时说明失败并提示手动选择,而不是静默无反应", async () => {
    renderAt("/studio/1");
    await flush();
    // jsdom 既没有 navigator.clipboard,也没有 document.execCommand —— 复制必然失败
    expect(clickButton("复制摘要", "has")).toBe(true);
    await flush();
    expect(text()).toContain("复制失败,请手动选择文本");
  });

  it("剪贴板可用时显示已复制", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => { written.push(s); } },
    });
    renderAt("/studio/1");
    await flush();
    expect(clickButton("复制摘要", "has")).toBe(true);
    await flush();
    expect(text()).toContain("已复制");
    expect(written.length).toBe(1);
    expect(written[0].length).toBeGreaterThan(0);
    delete (navigator as { clipboard?: unknown }).clipboard;
  });
});
