/**
 * "这台机器上有没有一个能对话的模型?" —— 只有一个地方回答这个问题。
 *
 * 之前答案是两处各说各话:话题命名读 EMBEDDING_*(指向一个只提供向量化的本机服务,
 * 根本没有 chat 接口),选题工作室读 STUDIO_*。结果是全分析跑完,话题名永远是关键词碎片,
 * 而设置页说"AI 未配置"。现在命名与工作室共用这一份判定,不会再出现两套行为。
 *
 * 优先级:显式的 Key(HTTP)> 本机 CLI 登录态。都没有则返回 null,调用方回退到
 * 确定性算法(关键词命名 / 证据摘要),界面据实说明,绝不假装是模型写的。
 */
import { HttpClient } from "../connectors/httpClient";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import { STUDIO_ENV } from "./config";
import { localCliChat, STUDIO_CLI_ENV } from "./localCli";

export type ChatFetch = (prompt: string, signal?: AbortSignal) => Promise<string>;

const http = new HttpClient({ timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });

export function studioChatFetch(env: NodeJS.ProcessEnv = process.env): ChatFetch | null {
  const base = env[STUDIO_ENV.baseUrl]?.trim();
  const model = env[STUDIO_ENV.model]?.trim();
  const cred = resolveSecretRef(`secretref:env:${STUDIO_ENV.apiKey}`);
  if (base && model && cred.ok) {
    const url = `${base.replace(/\/+$/, "")}/chat/completions`;
    return async (prompt, signal) => {
      const res = await http.fetchJson<{ choices?: { message?: { content?: string } }[] }>(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cred.value}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
        signal,
      });
      return res.body?.choices?.[0]?.message?.content ?? "";
    };
  }
  if (env[STUDIO_CLI_ENV.command]?.trim()) {
    return (prompt, signal) => localCliChat(prompt, { signal, env });
  }
  return null;
}

/** 给设置页/状态端点用的一句人话,不暴露任何密钥值。 */
export function studioChatSource(env: NodeJS.ProcessEnv = process.env): {
  available: boolean;
  kind: "api" | "local-cli" | "none";
  detail: string;
} {
  const base = env[STUDIO_ENV.baseUrl]?.trim();
  const model = env[STUDIO_ENV.model]?.trim();
  const cred = resolveSecretRef(`secretref:env:${STUDIO_ENV.apiKey}`);
  if (base && model && cred.ok) {
    return { available: true, kind: "api", detail: `外部服务 ${model}` };
  }
  const cli = env[STUDIO_CLI_ENV.command]?.trim();
  const cliModel = env[STUDIO_CLI_ENV.model]?.trim();
  if (cli) {
    return {
      available: true,
      kind: "local-cli",
      detail: `本机命令 ${cli}${cliModel ? `(${cliModel})` : ""}`,
    };
  }
  return { available: false, kind: "none", detail: `未配置 ${STUDIO_ENV.apiKey},也未设置 ${STUDIO_CLI_ENV.command}` };
}
