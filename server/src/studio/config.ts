/**
 * AI Topic Studio 配置(Stage 1.0 / Part 1)。
 *
 * 集中放置:证据预算(Token Budget)、版本号、Provider 默认值、环境变量名。
 * 版本号进 Run 记录 —— 换 prompt/schema/evidence 形状后,历史结果仍可解释(§17)。
 */

export const STUDIO_PROMPT_VERSION = "studio-prompt-v2";
export const STUDIO_SCHEMA_VERSION = "studio-output-v1";
export const STUDIO_EVIDENCE_VERSION = "evidence-package-v1";

/** §4 证据预算:Topic 内容再多也不能把 prompt 撑爆。 */
export const STUDIO_EVIDENCE_BUDGET = {
  representativeTopK: 5,
  burstTopK: 5,
  patternTopK: 8,
  angleTopK: 5,
  /** 单条内容摘要上限(标题全保,正文截断) */
  perContentTextChars: 220,
  /** 整个证据包的字符上限(超出则按优先级裁剪并置 evidenceTruncated) */
  maxPackageChars: 12_000,
} as const;

/** §13 不绑定单一厂商:baseUrl / model / secretRef 全部可配。 */
export const STUDIO_ENV = {
  apiKey: "STUDIO_API_KEY",
  baseUrl: "STUDIO_BASE_URL",
  model: "STUDIO_MODEL",
} as const;

export const STUDIO_DEFAULTS = {
  /** OpenAI 兼容 chat/completions */
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.4,
  maxTokens: 2000,
  timeoutMs: 60_000,
  /** JSON 模式:让结构化输出真的可解析(不支持时 provider 会退回文本+解析) */
  responseFormatJson: true,
} as const;

export interface StudioConfig {
  baseUrl: string;
  model: string;
  apiKeySecretRef: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** 默认开启 JSON 模式;个别兼容服务不支持时显式关掉。 */
  responseFormatJson?: boolean;
}

/** 数值型 env 越界时回落默认值:配置写错不该让服务起不来。 */
function numFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function defaultStudioConfig(): StudioConfig {
  return {
    baseUrl: process.env[STUDIO_ENV.baseUrl]?.trim() || STUDIO_DEFAULTS.baseUrl,
    model: process.env[STUDIO_ENV.model]?.trim() || STUDIO_DEFAULTS.model,
    apiKeySecretRef: `secretref:env:${STUDIO_ENV.apiKey}`,
    temperature: numFromEnv("STUDIO_TEMPERATURE", STUDIO_DEFAULTS.temperature, 0, 2),
    maxTokens: Math.round(numFromEnv("STUDIO_MAX_TOKENS", STUDIO_DEFAULTS.maxTokens, 256, 32_000)),
    timeoutMs: Math.round(numFromEnv("STUDIO_TIMEOUT_MS", STUDIO_DEFAULTS.timeoutMs, 5_000, 180_000)),
    responseFormatJson: process.env.STUDIO_RESPONSE_FORMAT_JSON?.trim() !== "0",
  };
}

/** 新鲜度:超过这个时长,Evidence Package 会标注陈旧(不阻止查看,只提醒)。 */
export const STUDIO_FRESHNESS_WARN_HOURS = 48;
