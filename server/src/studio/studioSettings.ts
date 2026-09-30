/**
 * Studio 设置视图(§28/§120/§121)。
 *
 * 红线:这里只产出**密钥状态**,绝不产出密钥值。整个对象会被序列化进 HTTP 响应,
 * 所以它的类型里根本不存在 value 字段 —— 泄漏面在源头就被封死,而不是靠上层 redact。
 */
import { describeSecretSource, resolveSecretRef } from "../services/secrets/secretResolver";
import { localCliCommand, STUDIO_CLI_ENV } from "./localCli";
import {
  defaultStudioConfig,
  STUDIO_ENV,
  STUDIO_EVIDENCE_VERSION,
  STUDIO_PROMPT_VERSION,
  STUDIO_SCHEMA_VERSION,
  type StudioConfig,
} from "./config";

export interface StudioSettingsView {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** 密钥状态:只有这两种取值。前端据此 disabled 生成按钮并说明配置方法。 */
  secretStatus: "configured" | "missing";
  /** 密钥**来源**描述,如 "环境变量 STUDIO_API_KEY" —— 来源可展示,值不可。 */
  secretSource: string;
  missingEnvNames: string[];
  /** AI 能力的真实来源:外部 API / 本机 CLI / 无。界面据此决定"已配置"怎么说。 */
  source: "api" | "local-cli" | "none";
  /** 一句人话(绝不含密钥值)。 */
  sourceDetail: string;
  /** baseUrl/model 未显式配置时走的是内置默认值,如实告知。 */
  usingDefaults: string[];
  promptVersion: string;
  schemaVersion: string;
  evidenceVersion: string;
}

export function studioSettings(cfg: StudioConfig = defaultStudioConfig()): StudioSettingsView {
  const cred = resolveSecretRef(cfg.apiKeySecretRef);
  // 本机 CLI 是同等级别的合法来源:个人项目常常没有 Key,而这台机器上的 CLI 已经登录。
  // 注意它不产生任何密钥,所以 secretStatus 仍然如实说"未配置"。
  let cli: string | null = null;
  try {
    cli = localCliCommand();
  } catch {
    cli = null;
  }
  const usingCli = !cred.ok && cli !== null;
  const missingEnvNames = cred.ok || usingCli ? [] : [STUDIO_ENV.apiKey];
  const usingDefaults: string[] = [];
  if (!process.env[STUDIO_ENV.baseUrl]?.trim()) usingDefaults.push(STUDIO_ENV.baseUrl);
  if (!process.env[STUDIO_ENV.model]?.trim()) usingDefaults.push(STUDIO_ENV.model);
  return {
    configured: cred.ok || usingCli,
    provider: usingCli ? "local-cli" : "openai-compatible",
    baseUrl: cfg.baseUrl,
    model: usingCli ? `${cli}(本机登录态)` : cfg.model,
    source: cred.ok ? "api" : usingCli ? "local-cli" : "none",
    sourceDetail: usingCli
      ? `使用本机命令 ${cli} 的登录态,不调用外部 API;清空 ${STUDIO_CLI_ENV.command} 即可关闭`
      : cred.ok
        ? `使用 ${describeSecretSource(cfg.apiKeySecretRef)}`
        : `未配置:需要 ${STUDIO_ENV.apiKey} 或 ${STUDIO_CLI_ENV.command}`,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    secretStatus: cred.ok ? "configured" : "missing",
    secretSource: describeSecretSource(cfg.apiKeySecretRef),
    missingEnvNames,
    usingDefaults,
    promptVersion: STUDIO_PROMPT_VERSION,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    evidenceVersion: STUDIO_EVIDENCE_VERSION,
  };
}
