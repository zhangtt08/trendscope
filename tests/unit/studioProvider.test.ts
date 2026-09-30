/**
 * StudioProvider 契约测试(§30):全部通过 Replay Transport,不碰公网。
 * 覆盖请求形状、schema 严格性、坏响应、上游错误映射与 secret 不外泄。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectorError } from "../../server/src/domain/collection";
import { OpenAICompatibleStudioProvider, extractJsonObject } from "../../server/src/studio/provider";
import type { HttpTransport } from "../../server/src/connectors/httpClient";
import type { StudioConfig } from "../../server/src/studio/config";
import { STUDIO_OUTPUT_FIXTURE } from "../fixtures/studioOutput";

const SECRET = "sk-provider-test-secret-do-not-leak";
const msgs = [
  { role: "system" as const, content: "规则" },
  { role: "user" as const, content: "证据" },
];

let seen: { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } } | null = null;
let reply: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { choices: [{ message: { content: JSON.stringify(STUDIO_OUTPUT_FIXTURE) } }], usage: { total_tokens: 10 } },
});

const transport: HttpTransport = async (url, init) => {
  seen = { url, init };
  const r = reply();
  return r;
};

function make(over: Partial<StudioConfig> = {}) {
  return new OpenAICompatibleStudioProvider(
    {
      baseUrl: "https://ai.example.com/v1",
      model: "unit-model",
      apiKeySecretRef: "secretref:env:STUDIO_API_KEY",
      temperature: 0.3,
      maxTokens: 1200,
      timeoutMs: 10_000,
      ...over,
    },
    { transport },
  );
}

beforeEach(() => {
  process.env.STUDIO_API_KEY = SECRET;
  seen = null;
  reply = () => ({
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(STUDIO_OUTPUT_FIXTURE) } }], usage: { total_tokens: 10 } },
  });
});
afterEach(() => {
  delete process.env.STUDIO_API_KEY;
});

describe("请求形状", () => {
  it("POST chat/completions,Bearer 头带密钥,body 带模型与 JSON 模式", async () => {
    const p = make({ baseUrl: "https://ai.example.com/v1/" });
    const r = await p.generate(msgs);
    expect(seen!.url).toBe("https://ai.example.com/v1/chat/completions");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers!.Authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(seen!.init.body!);
    expect(body.model).toBe("unit-model");
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(1200);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toBe("规则");
    expect(r.model).toBe("unit-model");
    expect(r.usage).toEqual({ total_tokens: 10 });
  });

  it("metadata 带 provider 与版本号,describeRequest 不含密钥", async () => {
    const p = make();
    expect(p.metadata.providerId).toBe("openai-compatible");
    expect(p.metadata.promptVersion).toBe("studio-prompt-v2");
    expect(p.metadata.schemaVersion).toBe("studio-output-v1");
    expect(JSON.stringify(p.describeRequest())).not.toContain(SECRET);
  });

  it("关闭 responseFormatJson 时不再要求 JSON 模式", async () => {
    await make({ responseFormatJson: false } as Partial<StudioConfig>).generate(msgs);
    expect(JSON.parse(seen!.init.body!).response_format).toBeUndefined();
  });
});

describe("响应校验", () => {
  it("围栏 JSON 与前后解释文字都能取出对象", () => {
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractJsonObject("好的,这是结果:\n{\"a\":1}\n希望有帮助")).toEqual({ a: 1 });
    expect(() => extractJsonObject("完全没有任何对象")).toThrow(ConnectorError);
    expect(() => extractJsonObject("{不是合法 JSON}")).toThrow(ConnectorError);
  });

  it("缺字段的模型输出 → INVALID_RESPONSE,不产出半成品", async () => {
    reply = () => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ topicSummary: "只有一半" }) } }] } });
    const err = await make().generate(msgs).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("INVALID_RESPONSE");
    expect((err as ConnectorError).message).toContain("schema");
  });

  it("空内容 / 非 chat schema 响应都算失败", async () => {
    reply = () => ({ status: 200, body: { choices: [{ message: { content: "" } }] } });
    expect((await make().generate(msgs).catch((e) => e)) as ConnectorError).toBeInstanceOf(ConnectorError);
    reply = () => ({ status: 200, body: { notChoices: true } });
    const e2 = (await make().generate(msgs).catch((e) => e)) as ConnectorError;
    expect(e2.code).toBe("INVALID_RESPONSE");
  });

  it("响应里的密钥样式文本不会让 provider 崩溃(只是文本)", async () => {
    reply = () => ({
      status: 200,
      body: { choices: [{ message: { content: JSON.stringify({ ...STUDIO_OUTPUT_FIXTURE, confidenceNote: "参考 sk-abcdef" }) } }] },
    });
    const r = await make().generate(msgs);
    expect(r.output.confidenceNote).toContain("sk-abcdef");
  });
});

describe("上游错误映射与 secret 保护", () => {
  it("401/403/429/5xx → 对应错误码,错误信息不含密钥", async () => {
    const cases: [number, string][] = [
      [401, "AUTH_ERROR"],
      [403, "PERMISSION_DENIED"],
      [429, "RATE_LIMITED"],
      [500, "REMOTE_5XX"],
      [503, "REMOTE_5XX"],
    ];
    for (const [status, code] of cases) {
      reply = () => ({ status, body: { error: { message: `boom ${SECRET}` } } });
      const e = (await make().generate(msgs).catch((err) => err)) as ConnectorError;
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e.code).toBe(code);
      expect(e.message).not.toContain(SECRET);
      expect(JSON.stringify(e.detail ?? {})).not.toContain(SECRET);
      expect(e.retryable).toBe(code === "RATE_LIMITED" || code === "REMOTE_5XX");
    }
  });

  it("无凭证时在发请求之前就失败(INVALID_CONFIG)", async () => {
    delete process.env.STUDIO_API_KEY;
    const p = make();
    expect(p.validateConfig().ok).toBe(false);
    expect(p.validateConfig().error).toContain("STUDIO_API_KEY");
    const e = (await p.generate(msgs).catch((err) => err)) as ConnectorError;
    expect(e.code).toBe("INVALID_CONFIG");
    expect(seen).toBeNull();
  });

  it("配置不合法(baseUrl 不是 URL)在构造时就拒绝", () => {
    expect(() => make({ baseUrl: "不是 URL" })).toThrow();
    expect(() => make({ apiKeySecretRef: "明文密钥" as unknown as string })).toThrow();
  });

  it("AbortSignal 取消 → 不伪装成服务故障", async () => {
    reply = () => ({ status: 200, body: {} });
    const ac = new AbortController();
    ac.abort();
    const e = (await make().generate(msgs, ac.signal).catch((err) => err)) as Error;
    expect(e).toBeInstanceOf(Error);
    expect((e as ConnectorError).code).toBe("CANCELLED");
  });
});
