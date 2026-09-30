/**
 * 本机 CLI 作为 AI 能力来源 —— 没有 STUDIO_API_KEY 也能出选题方案与话题命名。
 *
 * 为什么需要:目标链路是"采集 → 向量/混合推断热点 → 生成选题"。后两步都依赖一个
 * 会写中文的模型;而个人项目通常没有 Key,于是话题永远停在关键词碎片名
 * ("magic9 荣耀 机发" 这种)。这台机器上 `claude` CLI 已登录,直接复用它比
 * 要求使用者去申请一个 Key 更现实。
 *
 * 边界(刻意的):
 * - 必须显式设置 STUDIO_CLI_COMMAND 才启用;不偷偷扫描 PATH,也不代替用户装东西。
 * - 命令名与 --model 值都只接受裸 token(无空格/引号/元字符);Windows 上需要 shell
 *   才能解析 npm 全局的 .cmd 垫片,所以把"不允许任何 metachar"放在校验里,
 *   而不是把提示词拼进命令行 —— 提示词只走 stdin。
 * - 禁用工具调用:这是一个"出文本"的调用,不需要模型动文件系统。
 * - 超时/取消都杀进程;stdout 有上限,防止一次失控输出撑爆内存。
 */
import { spawn } from "node:child_process";
import { ConnectorError } from "../domain/collection";
import { STUDIO_PROMPT_VERSION, STUDIO_SCHEMA_VERSION } from "./config";
import {
  extractJsonObject,
  type StudioGenerateResult,
  type StudioProvider,
  type StudioProviderMetadata,
} from "./provider";
import { studioOutputSchema } from "./schema";

export const STUDIO_CLI_ENV = {
  command: "STUDIO_CLI_COMMAND",
  model: "STUDIO_CLI_MODEL",
  timeoutMs: "STUDIO_CLI_TIMEOUT_MS",
} as const;

/** 裸命令名:claude / claude.cmd / my-cli-v2 —— 别的一律拒绝 */
const BARE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_OUTPUT_CHARS = 4_000_000;
const MAX_STDERR_CHARS = 4_000;

export function localCliCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STUDIO_CLI_ENV.command]?.trim();
  if (!raw) return null;
  if (!BARE_TOKEN.test(raw)) {
    throw new ConnectorError(
      "INVALID_CONFIG",
      `${STUDIO_CLI_ENV.command} 只能是裸命令名(例如 claude),不能包含空格、引号或路径`,
    );
  }
  return raw;
}

function cliTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[STUDIO_CLI_ENV.timeoutMs]?.trim());
  return Number.isFinite(n) && n >= 5_000 && n <= 300_000 ? Math.round(n) : 120_000;
}

function cliArgs(env: NodeJS.ProcessEnv): string[] {
  const args = ["-p", "--output-format", "text", "--disallowed-tools", "Bash,Edit,Write,WebFetch,Read"];
  const model = env[STUDIO_CLI_ENV.model]?.trim();
  if (model) {
    if (!BARE_TOKEN.test(model)) {
      throw new ConnectorError("INVALID_CONFIG", `${STUDIO_CLI_ENV.model} 含非法字符`);
    }
    args.push("--model", model);
  }
  return args;
}

/** 一次问答:提示词进 stdin,返回模型输出的纯文本。 */
export function localCliChat(
  prompt: string,
  opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const command = localCliCommand(env);
  if (!command) {
    return Promise.reject(new ConnectorError("INVALID_CONFIG", `未配置 ${STUDIO_CLI_ENV.command}`));
  }
  let args: string[];
  try {
    args = cliArgs(env);
  } catch (e) {
    return Promise.reject(e instanceof ConnectorError ? e : new ConnectorError("INVALID_CONFIG", String(e)));
  }

  return new Promise<string>((resolve, reject) => {
    // Windows:claude 这类命令是 npm 全局的 .cmd 垫片,Node 不允许直接 spawn .cmd,
    // 也不允许 shell:false 时靠 PATH 解析它。这里显式启动 cmd.exe 并把命令与参数作为
    // 独立 argv 传入(shell:false) —— 比 {shell:true} 少一条弃用告警,也更清楚。
    // 之所以还敢用 cmd.exe:命令名与 --model 都先过 BARE_TOKEN(无空格/引号/元字符),
    // 其余参数是常量,提示词只走 stdin,命令行里没有任何用户文本可注入。
    const win = process.platform === "win32";
    const child = win
      ? spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], { shell: false, windowsHide: true })
      : spawn(command, args, { shell: false, windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;

    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      f();
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    };
    const onAbort = () =>
      finish(() => {
        kill();
        reject(new ConnectorError("CANCELLED", "AI 调用已取消"));
      });
    const timer = setTimeout(() => {
      finish(() => {
        kill();
        reject(new ConnectorError("TIMEOUT", `${command} 超过 ${cliTimeoutMs(env)}ms 未返回`));
      });
    }, cliTimeoutMs(env));

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_OUTPUT_CHARS) {
        finish(() => {
          kill();
          reject(new ConnectorError("INVALID_RESPONSE", `${command} 输出超过上限,已中止`));
        });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < MAX_STDERR_CHARS) err += chunk.toString("utf8");
    });
    // 进程提前退出时 stdin.write 会 EPIPE;真正的失败由 close/error 报出,这里静默。
    child.stdin?.on("error", () => {});
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(() => {
        const hint = e.code === "ENOENT" ? `未找到命令 ${command}(或它不在服务进程的路径里)` : e.message;
        reject(new ConnectorError("INVALID_CONFIG", `本机 AI 调用启动失败:${hint}`));
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const firstLine = err.trim().split("\n")[0] ?? "";
          reject(new ConnectorError("REMOTE_5XX", `${command} 退出码 ${code}${firstLine ? `:${firstLine.slice(0, 200)}` : ""}`));
          return;
        }
        const text = out.trim();
        if (!text) reject(new ConnectorError("INVALID_RESPONSE", `${command} 没有返回内容`));
        else resolve(text);
      });
    });

    child.stdin?.write(prompt, "utf8");
    child.stdin?.end();
  });
}

export class LocalCliStudioProvider implements StudioProvider {
  readonly metadata: StudioProviderMetadata;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    const command = localCliCommand(env) ?? "claude";
    this.metadata = {
      providerId: "local-cli",
      model: env[STUDIO_CLI_ENV.model]?.trim() || `${command}(本机登录态)`,
      version: "1.0.0",
      promptVersion: STUDIO_PROMPT_VERSION,
      schemaVersion: STUDIO_SCHEMA_VERSION,
    };
  }

  validateConfig(): { ok: boolean; error?: string } {
    try {
      return localCliCommand(this.env) ? { ok: true } : { ok: false, error: "未配置 STUDIO_CLI_COMMAND" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async generate(
    messages: { role: "system" | "user"; content: string }[],
    signal?: AbortSignal,
  ): Promise<StudioGenerateResult> {
    const prompt = messages.map((m) => `${m.role}:\n${m.content}`).join("\n\n");
    const text = await localCliChat(prompt, { signal, env: this.env });
    const raw = extractJsonObject(text);
    const checked = studioOutputSchema.safeParse(raw);
    if (!checked.success) {
      // 与 HTTP 通道同一条红线:不合规模型算失败,不"尽力解析"半成品。
      throw new ConnectorError("INVALID_RESPONSE", "本机 AI 输出不符合选题方案 schema", {
        issues: checked.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
      });
    }
    return { output: checked.data, usage: { source: "local-cli" }, model: this.metadata.model };
  }
}
