/**
 * 本机 CLI 作为 AI 能力来源的契约测试。
 *
 * 纪律:这里不调用真正的大模型(耗时,而且按次消耗使用者的登录额度)。
 * 但被测的是真进程:命令名校验、启动、退出码与 stderr 回传都走真实路径,
 * 用必然存在的 node 当"那个会失败的 CLI" —— 它认不了这套参数,退出码非 0。
 */
import { describe, it, expect, afterEach } from "vitest";
import { LocalCliStudioProvider, localCliCommand, STUDIO_CLI_ENV } from "../../server/src/studio/localCli";
import { STUDIO_ENV } from "../../server/src/studio/config";
import { studioChatSource } from "../../server/src/studio/chatBridge";

const saved: Record<string, string | undefined> = {};
function withEnv(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of [STUDIO_ENV.apiKey, STUDIO_ENV.baseUrl, STUDIO_ENV.model, STUDIO_CLI_ENV.command]) {
    if (!(k in saved)) delete process.env[k];
  }
});

describe("STUDIO_CLI_COMMAND 校验", () => {
  it("未设置就是没有本机来源", () => {
    expect(localCliCommand({})).toBeNull();
  });

  it("只接受裸命令名:空格、路径、元字符一律拒绝", () => {
    expect(localCliCommand({ [STUDIO_CLI_ENV.command]: "claude" })).toBe("claude");
    expect(localCliCommand({ [STUDIO_CLI_ENV.command]: "claude.cmd" })).toBe("claude.cmd");
    for (const bad of ["claude; rm -rf /", "C:\\Program Files\\claude", "$(whoami)", "claude --model x", "a|b", "a&&b"]) {
      expect(() => localCliCommand({ [STUDIO_CLI_ENV.command]: bad })).toThrow(/裸命令名/);
    }
  });

  it("提示词只走 stdin,所以参数表里没有任何可注入面", () => {
    // 这条测试存在的原因:Windows 上必须借助 shell 才能解析 npm 全局的 .cmd 垫片。
    // 用它的安全前提就是"命令与 --model 都先过裸命令名校验,其余参数是常量"。
    expect(() => localCliCommand({ [STUDIO_CLI_ENV.command]: "a b" })).toThrow();
  });
});

describe("AI 能力来源判定(话题命名与选题工作室共用这一份)", () => {
  it("没 Key、没 CLI 时如实说没有 AI 能力", () => {
    withEnv(STUDIO_ENV.apiKey, undefined);
    withEnv(STUDIO_ENV.baseUrl, undefined);
    withEnv(STUDIO_ENV.model, undefined);
    withEnv(STUDIO_CLI_ENV.command, undefined);
    const s = studioChatSource();
    expect(s.available).toBe(false);
    expect(s.kind).toBe("none");
    expect(s.detail).toContain(STUDIO_ENV.apiKey);
  });

  it("没 Key 但设了本机命令 → 来源是本机 CLI,不谎称外部服务", () => {
    withEnv(STUDIO_ENV.apiKey, undefined);
    withEnv(STUDIO_CLI_ENV.command, "claude");
    expect(studioChatSource()).toMatchObject({ available: true, kind: "local-cli" });
    expect(studioChatSource().detail).toContain("claude");
  });

  it("有 Key → 优先走外部服务", () => {
    withEnv(STUDIO_ENV.apiKey, "test-key");
    withEnv(STUDIO_ENV.baseUrl, "https://example.invalid/v1");
    withEnv(STUDIO_ENV.model, "some-model");
    withEnv(STUDIO_CLI_ENV.command, "claude");
    expect(studioChatSource()).toMatchObject({ available: true, kind: "api" });
  });

  it("本机 CLI 的模型名如实标注,不冒充云端模型", () => {
    const p = new LocalCliStudioProvider({ [STUDIO_CLI_ENV.command]: "claude" });
    expect(p.metadata.providerId).toBe("local-cli");
    expect(p.metadata.model).toContain("本机登录态");
    expect(p.validateConfig()).toEqual({ ok: true });
  });

  it("未配置命令时 generate 直接拒绝,不会返回空方案", async () => {
    const p = new LocalCliStudioProvider({});
    await expect(p.generate([{ role: "user", content: "hi" }])).rejects.toThrow(STUDIO_CLI_ENV.command);
  });

  it("命令真实启动后非 0 退出要映射成可读错误(真进程,非 mock)", async () => {
    // node 不认 -p/--output-format 这组参数:一定会以非 0 退出并把原因写到 stderr
    const p = new LocalCliStudioProvider({ [STUDIO_CLI_ENV.command]: "node" });
    await expect(p.generate([{ role: "user", content: "hi" }])).rejects.toThrow(/退出码|启动失败/);
  });
});
