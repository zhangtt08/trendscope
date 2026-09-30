/**
 * OpenAICompatibleEmbeddingProvider (Stage 6A §11/§12) — OpenAI 兼容
 * /embeddings 协议,不绑定具体厂商:baseUrl 可指向 OpenAI / 本地兼容服务 /
 * 第三方兼容服务。复用 Stage 4 HttpClient(timeout/abort/retry 友好的错误
 * 映射)+ Stage 5 SecretResolver(§33:Key 绝不进日志/DB/前端)。
 *
 * 请求:POST {baseUrl}/embeddings  { model, input: string[] }
 * 响应:{ data: [{ embedding: number[], index? }], usage? }
 * 严格校验:返回向量数 = 输入数;每条维度 = 声明 dimension(如已声明)。
 */
import { z } from "zod";
import { ConnectorError } from "../domain/collection";
import { HttpClient, type HttpTransport } from "../connectors/httpClient";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import type { EmbeddingProvider, EmbeddingProviderMetadata } from "./provider";

export const EmbeddingProviderConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    /** secretref 引用,如 secretref:env:EMBEDDING_API_KEY */
    apiKeySecretRef: z.string().regex(/^secretref:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/),
    dimension: z.number().int().min(64).max(8192).optional(),
    batchSize: z.number().int().min(1).max(256).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  })
  .passthrough();

export type OpenAICompatibleConfig = z.infer<typeof EmbeddingProviderConfigSchema>;

const EmbeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().optional() })).min(1),
});

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "api" as const;
  readonly batchSize: number;
  readonly concurrency = 1;
  readonly minIntervalMs: number;
  private readonly cfg: OpenAICompatibleConfig;
  private readonly http: HttpClient;
  private readonly clock: () => number;

  readonly metadata: EmbeddingProviderMetadata;

  constructor(cfg: OpenAICompatibleConfig, opts: { transport?: HttpTransport; clock?: () => number } = {}) {
    const parsed = EmbeddingProviderConfigSchema.parse(cfg);
    this.cfg = parsed;
    // 本地/CPU 向量服务在长文本上一批 32 条可能几十秒,32/30s 的组合会让整批超时:
    // 实测单条 0.2s、8 条最慢 24s、32 条成倍超出 30s 默认值。
    // 默认值集中在这里,而不是散落到每个构造点(实测有 6 处各自 new 本 provider)。
    this.batchSize = parsed.batchSize ?? Number(process.env.EMBEDDING_BATCH_SIZE ?? 8);
    this.minIntervalMs = 250; // 保守默认(§32):约 4 req/s 上限,provider 可再收紧
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
    // retry 集成(§31):429/5xx/timeout 由 Collector 层的 RetryPolicy 语义在
    // job 层处理;这里 HttpClient 负责 timeout/abort/错误映射。
    this.http = new HttpClient(
      { timeoutMs: parsed.timeoutMs ?? Number(process.env.EMBEDDING_TIMEOUT_MS ?? 180_000), maxBytes: 32 * 1024 * 1024 },
      opts.transport,
    );
    this.metadata = {
      providerId: "openai-compatible",
      model: parsed.model,
      version: "1.0.0",
      dimension: parsed.dimension ?? 0, // 0 = 由首个响应确定并回填
    };
  }

  validateConfig(): { ok: boolean; error?: string } {
    const cred = resolveSecretRef(this.cfg.apiKeySecretRef);
    if (!cred.ok) return { ok: false, error: `credential unavailable: ${cred.detail}` };
    return { ok: true };
  }

  /** 实际维度:声明值优先;否则由首次响应确定(job 层记录) */
  effectiveDimension(sample: number[] | null): number {
    if (this.cfg.dimension) return this.cfg.dimension;
    if (sample && sample.length > 0) return sample.length;
    return 0;
  }

  private async call(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const cred = resolveSecretRef(this.cfg.apiKeySecretRef);
    if (!cred.ok) {
      throw new ConnectorError("INVALID_CONFIG", `embedding credential unavailable: ${cred.detail}`);
    }
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const res = await this.http.fetchJson<unknown>(url, {
      // HttpClient 此前没有 method/body 字段,这个调用发出去的是**无 body 的 GET**;
      // 底座补齐后这里显式 POST OpenAI 兼容请求体。
      method: "POST",
      body: JSON.stringify({ model: this.cfg.model, input }),
      headers: {
        Authorization: `Bearer ${cred.value}`,
        "Content-Type": "application/json",
        "X-Request-Timestamp": String(this.clock()),
      },
      signal,
      maxBytes: 64 * 1024 * 1024,
    });
    const parsed = EmbeddingsResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new ConnectorError("INVALID_RESPONSE", "embedding 响应不符合 OpenAI 兼容 schema", {
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const vectors = parsed.data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding);
    if (vectors.length !== input.length) {
      throw new ConnectorError("INVALID_RESPONSE", `embedding 数量不匹配: 返回 ${vectors.length},请求 ${input.length}`);
    }
    const dim = this.effectiveDimension(vectors[0] ?? null);
    if (dim > 0) {
      for (const v of vectors) {
        if (v.length !== dim) {
          throw new ConnectorError("INVALID_RESPONSE", `embedding 维度不一致: ${v.length} ≠ ${dim}`);
        }
      }
    }
    return vectors;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [v] = await this.call([text], signal);
    return v;
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.call(texts, signal);
  }
}
