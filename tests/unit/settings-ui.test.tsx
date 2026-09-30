// @vitest-environment jsdom
/**
 * 设置页(§120/§121)的前端集成测试。
 *
 * 这个页面的唯一"危险面"是密钥:它必须只报状态与变量名,绝不把值渲染出来。
 * 同时它是四项外部能力的集中视图,所以状态错报(未配置说成已配置)也算缺陷。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import SettingsCenter from "../../src/pages/SettingsCenter";

const SECRET = "sk-should-never-render-0123456789";

let container: HTMLDivElement;
let root: Root;
let configured: { zhihu: boolean; embedding: boolean; studio: boolean };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (url.includes("/api/analysis/status")) {
        return json({
          generatedAt: "2026-09-27T10:00:00.000Z",
          isEmpty: false,
          data: {
            contentTotal: 1234,
            sourceKinds: { manual: 1234 },
            demoShare: 0,
            latestCollectedAt: null,
            latestRun: null,
            runningRuns: 0,
            enabledTasks: 0,
            quality: { missingPublishedAt: 0, missingAnyMetric: 0, missingAuthor: 0 },
            zhihuCredential: configured.zhihu ? "configured" : "missing",
          },
          semantic: {
            mode: configured.embedding ? "semantic" : "lexical",
            activeSpaceId: "s1",
            dimension: configured.embedding ? 1024 : 512,
            embedded: 10,
            pending: 0,
            embeddingCredential: configured.embedding ? "configured" : "missing",
          },
          topics: { total: 3, active: 3, unclustered: 0, lastRun: null },
          engines: {},
          studio: { configured: configured.studio, secretStatus: configured.studio ? "configured" : "missing" },
          guide: [],
        });
      }
      if (url.includes("/api/studio/settings")) {
        return json({
          configured: configured.studio,
          provider: "openai-compatible",
          baseUrl: "https://llm.example.test/v1",
          model: "some-model",
          temperature: 0.4,
          maxTokens: 2600,
          timeoutMs: 45000,
          secretStatus: configured.studio ? "configured" : "missing",
          secretSource: "环境变量 STUDIO_API_KEY",
          missingEnvNames: configured.studio ? [] : ["STUDIO_API_KEY"],
          usingDefaults: ["STUDIO_BASE_URL"],
          promptVersion: "studio-prompt-v1",
          schemaVersion: "studio-output-v1",
          evidenceVersion: "studio-evidence-v1",
        });
      }
      if (url.includes("/api/embedding/settings")) {
        return json({
          activeSpaceId: "s1",
          provider: configured.embedding ? "openai-compatible" : "lexical",
          lexical: { providerId: "lexical-hash", model: "zh-lexical-v1", mode: "lexical" },
          api: {
            secretSource: "环境变量 EMBEDDING_API_KEY",
            credential: configured.embedding ? "CONFIGURED" : "MISSING",
            baseUrl: configured.embedding ? "https://emb.example.test/v1" : null,
            model: configured.embedding ? "emb-model" : null,
          },
          spaces: [],
        });
      }
      if (url.includes("/api/opportunity/profiles")) {
        return json({
          rows: [{ id: 7, profileKey: "balanced", name: "均衡默认", version: "v1", status: "active", isActive: true }],
          activeId: 7,
          note: "机会模型只是分析偏好与权重配置。",
        });
      }
      if (url.includes("/api/demo/status")) {
        return json({ demoMode: false, contentTotal: 1234, dbDisplay: "data/trendscope.db" });
      }
      return json({});
    }),
  );
}

function render(node: ReactNode) {
  act(() => root.render(node));
}

const text = () => container.textContent ?? "";

async function mount() {
  stubFetch();
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsCenter />
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  configured = { zhihu: false, embedding: false, studio: false };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("设置页(§120/§121)", () => {
  it("四项能力都给出状态,未配置时点名环境变量", async () => {
    await mount();
    const t = text();
    for (const label of ["运行信息", "知乎官方接口", "语义向量", "AI 选题服务", "机会模型"]) {
      expect(t).toContain(label);
    }
    expect(t).toContain("ZHIHU_ACCESS_SECRET");
    expect(t).toContain("STUDIO_API_KEY");
    expect(t).toContain("EMBEDDING_API_KEY");
    expect(t.match(/未配置/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("已配置时如实翻成已配置,并显示非密钥参数", async () => {
    configured = { zhihu: true, embedding: true, studio: true };
    await mount();
    const t = text();
    expect(t).toContain("已配置");
    expect(t).toContain("some-model");
    expect(t).toContain("https://llm.example.test/v1");
    expect(t).toContain("均衡默认");
    expect(t).not.toContain("缺少 STUDIO_API_KEY");
  });

  it("页面绝不渲染密钥值,即使环境变量里真有", async () => {
    process.env.STUDIO_API_KEY = SECRET;
    process.env.EMBEDDING_API_KEY = SECRET;
    configured = { zhihu: true, embedding: true, studio: true };
    await mount();
    expect(text()).not.toContain(SECRET);
    delete process.env.STUDIO_API_KEY;
    delete process.env.EMBEDDING_API_KEY;
  });

  it("显示当前数据文件与版本,便于确认在动哪个库", async () => {
    await mount();
    const t = text();
    expect(t).toContain("data/trendscope.db");
    expect(t).toContain(`v${__APP_VERSION__}`);
    expect(t).toContain("正式库");
  });

  it("读取失败给错误与重试,不是空白页", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "服务不可用" }) }) as unknown as Response),
    );
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsCenter />
      </MemoryRouter>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).toContain("重试");
  });
});
