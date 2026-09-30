/**
 * Embedding Provider 解析(§13/§36 同源约束):环境变量决定能否用语义向量,
 * 否则回落本地词法基线。编排器与设置页共用这一份判定,避免"设置页说有 API,
 * 实际跑的是词法"这类自相矛盾。
 */
import type { DB } from "../db/client";
import { LexicalFallbackEmbeddingProvider } from "./lexicalProvider";
import { OpenAICompatibleEmbeddingProvider, EmbeddingProviderConfigSchema } from "./openaiProvider";
import { getActiveSpace } from "./vectorRepository";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import type { EmbeddingProvider } from "./provider";

export interface ResolvedEmbedding {
  provider: EmbeddingProvider;
  source: "api" | "lexical";
  /** 人类可读的回落原因,给 UI 如实说明为什么是词法基线 */
  reason: string;
  dimension: number;
  model: string;
  providerId: string;
}

export function embeddingApiConfigured(): boolean {
  const key = resolveSecretRef("secretref:env:EMBEDDING_API_KEY");
  return key.ok && Boolean(process.env.EMBEDDING_BASE_URL?.trim()) && Boolean(process.env.EMBEDDING_MODEL?.trim());
}

export async function resolveEmbeddingProvider(db: DB, opts: { prefer?: "lexical" | "api"; dimension?: number } = {}): Promise<ResolvedEmbedding> {
  const active = await getActiveSpace(db);
  const wanted = opts.prefer ?? "api";
  if (wanted === "api" && embeddingApiConfigured()) {
    const cfg = EmbeddingProviderConfigSchema.parse({
      baseUrl: process.env.EMBEDDING_BASE_URL,
      model: process.env.EMBEDDING_MODEL,
      apiKeySecretRef: "secretref:env:EMBEDDING_API_KEY",
      // 不要把当前激活空间的维度塞给 API provider:激活的往往是词法空间(512),
      // 而外部模型的真实输出维度由 provider 自己在首个响应里确定(声明 0 = 待定)。
      // 继承过来会让空间被标成错误维度,随后每条向量都因长度不符被拒 —— 表现为
      // "步骤 completed 但一条都没向量化"。
      dimension: opts.dimension ?? undefined,
      // 超时与批量默认值集中在 openaiProvider 里(所有构造点共用同一个来源)
    });
    const provider = new OpenAICompatibleEmbeddingProvider(cfg);
    return {
      provider,
      source: "api",
      reason: "使用已配置的外部 Embedding 服务。",
      dimension: provider.metadata.dimension,
      model: provider.metadata.model,
      providerId: provider.metadata.providerId,
    };
  }
  const dimension = opts.dimension ?? (active?.mode === "lexical" ? active.dimension : undefined) ?? 512;
  const provider = new LexicalFallbackEmbeddingProvider(dimension);
  return {
    provider,
    source: "lexical",
    reason:
      wanted === "api"
        ? "未配置 Embedding 服务(缺少 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL),已使用本地词法基线。"
        : "按选择使用本地词法基线。",
    dimension: provider.metadata.dimension,
    model: provider.metadata.model,
    providerId: provider.metadata.providerId,
  };
}
