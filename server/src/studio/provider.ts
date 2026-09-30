/**
 * StudioProvider 抽象 + OpenAI 兼容实现(Part 1 §12-§13)。
 *
 * 复用既有底座,不另起一套:HttpClient(timeout/abort/大小上限/错误映射 + 头部 redact)
 * 与 SecretResolver(secretref: 唯一解密点)。测试全部走 Replay Transport,不依赖公网。
 */
import { z } from "zod";
import { ConnectorError } from "../domain/collection";
import { HttpClient, type HttpTransport } from "../connectors/httpClient";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import { STUDIO_PROMPT_VERSION, STUDIO_SCHEMA_VERSION, type StudioConfig } from "./config";
import { studioOutputSchema, type StudioOutput } from "./schema";

export interface StudioProviderMetadata {
  providerId: string;
  model: string;
  version: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface StudioGenerateResult {
  output: StudioOutput;
  /** provider 回执(usage/finish reason),仅用于可观测,不参与业务判断 */
  usage: Record<string, unknown> | null;
  model: string;
}

export interface StudioProvider {
  readonly metadata: StudioProviderMetadata;
  validateConfig(): { ok: boolean; error?: string };
  generate(
    messages: { role: "system" | "user"; content: string }[],
    signal?: AbortSignal,
  ): Promise<StudioGenerateResult>;
}

export const StudioConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeySecretRef: z.string().regex(/^secretref:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(256).max(32_000).optional(),
    timeoutMs: z.number().int().min(5_000).max(180_000).optional(),
    responseFormatJson: z.boolean().optional(),
  })
  .strict();

/** 从模型文本里取出 JSON 对象:容忍 ```json 围栏与前后解释性文字。 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ConnectorError("INVALID_RESPONSE", "模型返回中找不到 JSON 对象");
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ConnectorError("INVALID_RESPONSE", "模型返回的 JSON 无法解析");
  }
}

const ChatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.union([z.string(), z.null()]).optional() }), finish_reason: z.string().optional() }))
    .min(1),
  usage: z.record(z.unknown()).optional(),
});

export class OpenAICompatibleStudioProvider implements StudioProvider {
  readonly metadata: StudioProviderMetadata;
  private readonly cfg: z.infer<typeof StudioConfigSchema>;
  private readonly http: HttpClient;

  constructor(cfg: StudioConfig, opts: { transport?: HttpTransport } = {}) {
    const parsed = StudioConfigSchema.parse(cfg);
    this.cfg = parsed;
    this.http = new HttpClient({ timeoutMs: parsed.timeoutMs ?? 60_000, maxBytes: 8 * 1024 * 1024 }, opts.transport);
    this.metadata = {
      providerId: "openai-compatible",
      model: parsed.model,
      version: "1.0.0",
      promptVersion: STUDIO_PROMPT_VERSION,
      schemaVersion: STUDIO_SCHEMA_VERSION,
    };
  }

  validateConfig(): { ok: boolean; error?: string } {
    const cred = resolveSecretRef(this.cfg.apiKeySecretRef);
    if (!cred.ok) return { ok: false, error: `AI 凭据不可用：${cred.detail}` };
    return { ok: true };
  }

  /** 供设置页展示的请求形状(绝不包含解析后的密钥值)。 */
  describeRequest(): { url: string; model: string; temperature: number; maxTokens: number } {
    return {
      url: `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      model: this.cfg.model,
      temperature: this.cfg.temperature ?? 0.4,
      maxTokens: this.cfg.maxTokens ?? 2000,
    };
  }

  async generate(
    messages: { role: "system" | "user"; content: string }[],
    signal?: AbortSignal,
  ): Promise<StudioGenerateResult> {
    const cred = resolveSecretRef(this.cfg.apiKeySecretRef);
    if (!cred.ok) {
      throw new ConnectorError("INVALID_CONFIG", `AI 凭据不可用：${cred.detail}`);
    }
    const req = this.describeRequest();
    const res = await this.http.fetchJson<unknown>(req.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        ...(this.cfg.responseFormatJson !== false ? { response_format: { type: "json_object" } } : {}),
      }),
      signal,
    });
    const parsed = ChatResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new ConnectorError("INVALID_RESPONSE", "AI 服务响应不符合 OpenAI 兼容 chat schema", {
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const content = parsed.data.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new ConnectorError("INVALID_RESPONSE", "AI 服务返回空内容");
    }
    const raw = extractJsonObject(content);
    const checked = studioOutputSchema.safeParse(raw);
    if (!checked.success) {
      // 不合规模型 = 失败。不做"尽力解析"半成品:历史与 UI 都要引用它。
      throw new ConnectorError("INVALID_RESPONSE", "AI 输出不符合选题方案 schema", {
        issues: checked.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
      });
    }
    return { output: checked.data, usage: (parsed.data.usage as Record<string, unknown>) ?? null, model: req.model };
  }
}
