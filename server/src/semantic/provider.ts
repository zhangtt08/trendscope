/**
 * EmbeddingProvider contract (Stage 6A §9/§10) — 业务层只依赖此接口,
 * 绝不直接 import 任何厂商 SDK。未来 OpenAI / BGE-M3 / 本地服务 均经此接入。
 */
export interface EmbeddingProviderMetadata {
  /** space id 前缀,如 lexical-hash / openai-compatible(不含冒号) */
  providerId: string;
  model: string;
  version: string;
  dimension: number;
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  validateConfig(): { ok: boolean; error?: string };
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** §32: provider 自声明的批大小/并发/最小间隔(运行时尊重,不无限并发) */
  readonly batchSize: number;
  readonly concurrency: number;
  readonly minIntervalMs: number;
  /** §36: UI 必须如实标注模式 —— lexical / api */
  readonly mode: "lexical" | "api";
}
