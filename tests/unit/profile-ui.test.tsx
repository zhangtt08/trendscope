// @vitest-environment jsdom
/**
 * Stage 9.5 §64:机会模型页面的前端集成测试。
 *
 * 前端此前零测试覆盖,而项目已经两次栽在"tsc 全绿但页面是坏的"上
 * (表头/单元格错位、按钮点了没反应)。所以这里渲染真实组件、
 * 断言真实 DOM 与真实请求,而不是只看类型。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import OpportunityProfile from "../../src/pages/OpportunityProfile";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

const records: Recorded[] = [];
let listFailures = 0;
let saveStatus = 201;
let container: HTMLDivElement;
let root: Root | null = null;

const WEIGHTS = { trend: 0.3, burst: 0.2, novelty: 0.15, whitespace: 0.15, pattern: 0.1, lifecycle: 0.1 };
const FIT = { emerging: 65, rising: 85, peak: 70, saturated: 45, declining: 25, evergreen: 55, unknown: null };
const FRESH = { trendMaxAgeHours: 24, intelligenceMaxAgeHours: 48, penaltyStale: 0.1 };

function row(over: Record<string, unknown>) {
  return {
    id: 1,
    profileKey: "balanced",
    name: "均衡",
    description: "默认分析偏好",
    version: "BALANCED_V1",
    status: "active",
    isActive: true,
    weights: WEIGHTS,
    freshness: FRESH,
    minimumEvidence: { minimumAvailableComponents: 3 },
    lifecycleFit: FIT,
    levelBands: { high: 70, medium: 40 },
    createdAt: "2026-09-27T00:00:00.000Z",
    activatedAt: null,
    archivedAt: null,
    createdFromProfileId: null,
    usage: { runs: 3, snapshots: 12 },
    diff: null,
    ...over,
  };
}

function profilesPayload() {
  return {
    rows: [
      row({}),
      row({
        id: 2,
        version: "BALANCED_V2",
        name: "重趋势版",
        isActive: false,
        weights: { ...WEIGHTS, trend: 0.4, burst: 0.2, novelty: 0.1, whitespace: 0.1, pattern: 0.1, lifecycle: 0.1 },
        createdFromProfileId: 1,
        diff: { trend: { from: 0.3, to: 0.4 }, novelty: { from: 0.15, to: 0.1 } },
        usage: { runs: 1, snapshots: 4 },
      }),
    ],
    activeId: 1,
    defaultDraft: {
      name: "均衡",
      description: "默认分析偏好",
      weights: WEIGHTS,
      minimumEvidence: { minimumAvailableComponents: 3 },
      lifecycleFit: FIT,
      freshness: FRESH,
    },
    note: "机会模型只是分析偏好与权重配置。",
  };
}

const flush = async (ms = 30, rounds = 3) => {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};

function click(text: string): boolean {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) return false;
  act(() => {
    (btn as HTMLButtonElement).click();
  });
  return true;
}

function setInput(id: string, value: string) {
  const el = container.querySelector(`#${id}`) as HTMLInputElement | null;
  if (!el) throw new Error(`input #${id} not found`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  records.length = 0;
  listFailures = 0;
  saveStatus = 201;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      records.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && listFailures > 0) {
        listFailures -= 1;
        return { ok: false, status: 500, json: async () => ({ error: "服务端错误: 模拟失败" }) } as unknown as Response;
      }
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => profilesPayload() } as unknown as Response;
      }
      if (url.endsWith("/versions")) {
        const sent = JSON.parse(String(init?.body)) as { weights: Record<string, number>; name: string };
        return {
          ok: saveStatus >= 200 && saveStatus < 300,
          status: saveStatus,
          json: async () =>
            saveStatus === 400
              ? { error: "参数不合法：权重不能全部为 0" }
              : {
                  created: true,
                  profile: row({ id: 9, version: "BALANCED_V3", name: sent.name, isActive: false, weights: sent.weights }),
                },
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ profile: row({ id: 1 }) }) } as unknown as Response;
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

async function mount() {
  const rr = root!;
  await act(async () => {
    rr.render(<OpportunityProfile /> as ReactNode);
  });
  await flush();
}

describe("机会模型页 · 渲染", () => {
  it("当前模型卡片 + 版本表都渲染出来,表头列数等于单元格列数", async () => {
    await mount();
    expect(container.textContent).toContain("当前模型");
    expect(container.textContent).toContain("BALANCED_V1");
    expect(container.textContent).toContain("被 3 次 Run / 12 条快照使用");

    const table = container.querySelector("table.ts") as HTMLTableElement;
    const heads = table.querySelectorAll("thead th").length;
    const firstRowCells = table.querySelectorAll("tbody tr")[0].querySelectorAll("td").length;
    // 这条断言锁死 MomentumTable 那类整列错位事故在本页复发
    expect(heads).toBe(8);
    expect(firstRowCells).toBe(heads);
    expect(table.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("§72 首屏失败给可读错误 + 重试,重试后能出数据", async () => {
    listFailures = 1;
    await mount();
    expect(container.querySelector(".banner.err")?.textContent).toContain("模拟失败");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("重试"));
    expect(retry).toBeTruthy();
    act(() => retry!.click());
    await flush();
    expect(container.textContent).toContain("BALANCED_V1");
    expect(container.querySelector(".banner.err")).toBeNull();
  });

  it("当前模型的「设为当前模型」按钮是禁用的,非当前模型的可点", async () => {
    await mount();
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const activeBtn = Array.from(rows[0].querySelectorAll("button")).find((b) => b.textContent === "设为当前模型")!;
    const inactiveBtn = Array.from(rows[1].querySelectorAll("button")).find((b) => b.textContent === "设为当前模型")!;
    expect(activeBtn.disabled).toBe(true);
    expect(inactiveBtn.disabled).toBe(false);

    records.length = 0;
    act(() => inactiveBtn.click());
    await flush();
    expect(records.some((r) => r.method === "POST" && r.url.endsWith("/api/opportunity/profiles/2/activate"))).toBe(true);
  });
});

describe("机会模型页 · 编辑草稿到新版本(§45)", () => {
  it("编辑 → 改权重 → 差异可见 → 保存为新版本(POST 原始权重,归一化交给服务端)", async () => {
    await mount();
    expect(click("编辑(另存新版本)")).toBe(true);
    expect(container.textContent).toContain("编辑草稿");

    setInput("w-trend", "40");
    // 差异预览在保存前就能看到(§46 高价值)。
    // 输入 40 是"任意非负权重",有效权重 = 40/(40+20+15+15+10+10) = 36.4% —— 归一化在保存时由服务端做,
    // UI 立刻显示换算后的有效值,用户看到的和存进去的是同一个口径。
    expect(container.textContent).toMatch(/趋势强度:30% → 36.4%/);

    records.length = 0;
    expect(click("保存为新版本")).toBe(true);
    await flush();

    const saved = records.find((r) => r.method === "POST" && r.url.endsWith("/versions"));
    expect(saved).toBeTruthy();
    expect((saved!.body as { weights: Record<string, number> }).weights.trend).toBe(40);
    expect(container.textContent).toContain("已保存为新版本 BALANCED_V3");
  });

  it("§74 保存请求在飞时按钮 disabled,快速连点只发一次", async () => {
    await mount();
    click("编辑(另存新版本)");
    setInput("w-burst", "25");
    records.length = 0;

    await act(async () => {
      const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "保存为新版本")!;
      save.click();
      save.click();
      save.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    await flush();
    const posts = records.filter((r) => r.method === "POST" && r.url.endsWith("/versions"));
    expect(posts.length).toBe(1);
  });

  it("§33 权重全 0:本地就警告,服务端 400 也会显示出来", async () => {
    await mount();
    click("编辑(另存新版本)");
    for (const k of ["trend", "burst", "novelty", "whitespace", "pattern", "lifecycle"]) setInput(`w-${k}`, "0");
    expect(container.textContent).toContain("权重全部为 0 无法保存");

    saveStatus = 400;
    records.length = 0;
    click("保存为新版本");
    await flush();
    expect(records.some((r) => r.method === "POST" && r.url.endsWith("/versions"))).toBe(true);
    expect(container.querySelector(".banner.err")?.textContent).toContain("权重");
  });

  it("§27 恢复默认只动草稿,不覆盖已保存版本", async () => {
    await mount();
    click("编辑(另存新版本)");
    setInput("w-trend", "99");
    expect(click("恢复默认参数")).toBe(true);
    expect(container.textContent).toContain("草稿已恢复为系统默认参数");
    // 编辑框用人看得懂的 0-100 刻度:默认 0.3 → 显示 30
    expect((container.querySelector("#w-trend") as HTMLInputElement).value).toBe("30");
    const posts = records.filter((r) => r.method === "POST");
    expect(posts.length).toBe(0); // 没有任何写请求发生
  });

  it("§37 高级参数默认折叠,展开后能看到新鲜度/最低证据/生命周期适配", async () => {
    await mount();
    click("编辑(另存新版本)");
    expect(container.querySelector("#f-trend")).toBeNull();
    expect(click("展开高级参数(数据新鲜度 / 最低证据 / 生命周期适配)")).toBe(true);
    expect(container.querySelector("#f-trend")).toBeTruthy();
    expect(container.querySelector("#lc-emerging")).toBeTruthy();
    // §34:单位给人看,不是裸毫秒
    expect(container.textContent).toContain("1 天(24 小时)");
  });
});
