/**
 * Agent API 错误类型:契约要求失败必须回 `{ok:false,error:{code,message}}`。
 * `code` 是给调用方(Agent)分支用的稳定标识,`message` 是给人看的那一句,
 * `hint` 给可执行出路。绝不把内部堆栈原样抛出去。
 */

export type AgentErrorCode =
  | "bad_input"
  | "unknown_tool"
  | "confirm_required"
  | "not_found"
  | "engine_busy"
  | "not_configured"
  | "provider_failed"
  | "internal_error";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly hint?: string;

  constructor(code: AgentErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.hint = hint;
  }
}

/** 未知异常 → 契约里的 internal_error(只带一句话,不带栈)。 */
export function toAgentError(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AgentError("internal_error", `工具执行失败:${msg}`);
}

/** code → HTTP 状态。契约正文只承诺 400/500,409/404/405 是更准的复用,响应形状不变。 */
export function agentHttpStatus(code: AgentErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "engine_busy":
    case "not_configured":
      return 409;
    case "provider_failed":
      return 502;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

/**
 * 服务层抛出的"带 HTTP 状态的业务错误"(StudioUserError / ProfileError …)原样冒到这里,
 * 会被折成 internal_error + 500 —— 那是把调用方的错说成服务器的错:话题不存在、AI 未配置、
 * 上一次生成失败,这三种出路完全不同,却得到同一句"工具执行失败"。
 * 实测踩过:POST generate_plan 打一个不存在的话题 id,拿到 500 而不是 404。
 * 这里按服务层已经算好的 status 折算成契约 code,并把可执行出路带上。
 */
export function mapServiceError(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const status = (e as { status?: unknown } | null | undefined)?.status;
  const msg = e instanceof Error ? e.message : String(e);
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
    return new AgentError("internal_error", `工具执行失败:${msg}`);
  }
  if (status === 404) return new AgentError("not_found", msg, "先用 list_topics / search_contents 拿真实 id,不要猜。");
  if (status === 409) {
    if (/正在运行|已在运行/.test(msg)) {
      return new AgentError("engine_busy", msg, "等那一次跑完再调;或先读 topic_detail 里已有的结论。");
    }
    return new AgentError("not_configured", msg, "配置项在界面「设置」页;只读的检索与详情工具不需要它,照常可用。");
  }
  if (status === 400) return new AgentError("bad_input", msg);
  if (status === 502 || status === 503) {
    return new AgentError(
      "provider_failed",
      msg,
      "这次调用失败并已如实记进生成历史(不会伪装成成功)。检查 AI 服务:设置页 → AI 生成服务;外部 API 看 STUDIO_API_KEY/STUDIO_BASE_URL,本机 CLI 看 STUDIO_CLI_COMMAND 是否在**服务进程**的 PATH 上。",
    );
  }
  return new AgentError("internal_error", `工具执行失败:${msg}`);
}
