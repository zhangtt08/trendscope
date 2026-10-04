/**
 * 界面错误读出层(`src/lib/api.ts`)的形状测试。
 *
 * 为什么必须有:本机边界闸门(403)回的是 Agent 契约形状 `{error:{code,message}}` + 顶层
 * `message`,而界面旧的读法只认 `{error:"字符串"}`。不接这条,用户被闸门拒掉时看到的是
 * 一句 `[object Object]`,而那句中文拒绝理由("这一条拒绝与你的登录状态无关…")永远到不了眼前。
 * 这里把三种既有形状各钉一条,并钉住"什么都不认识时也要有可读数"。
 */
import { describe, it, expect, afterEach } from "vitest";
import { api, isAbortError } from "../../src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function reply(status: number, body: unknown, contentType = "application/json") {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": contentType },
    })) as typeof fetch;
}

async function messageOf(path: string): Promise<string> {
  try {
    await api(path);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("预期的请求没有失败");
}

describe("界面读错误体的三种形状", () => {
  it("闸门/契约形状 {error:{code,message}} → 读出 message 原文", async () => {
    reply(403, {
      ok: false,
      code: "forbidden_origin",
      message: "这一条拒绝与你的登录状态无关。",
      error: { code: "forbidden_origin", message: "这一条拒绝与你的登录状态无关。" },
    });
    expect(await messageOf("/topics")).toBe("这一条拒绝与你的登录状态无关。");
  });

  it("只有顶层 message 时也读得出来", async () => {
    reply(403, { ok: false, message: "只接受本机回环地址的访问。" });
    expect(await messageOf("/topics")).toBe("只接受本机回环地址的访问。");
  });

  it("既有业务形状 {error:\"字符串\"} 不变", async () => {
    reply(400, { error: "话题 id 必须是数字" });
    expect(await messageOf("/topics/abc")).toBe("话题 id 必须是数字");
  });

  it("错误体是空对象 / 不是 JSON 时,给出带状态码的可读数而不是 [object Object]", async () => {
    reply(500, {});
    expect(await messageOf("/topics")).toBe("请求失败（HTTP 500）");
    reply(502, "<!DOCTYPE html><h1>Bad Gateway</h1>", "text/html");
    expect(await messageOf("/topics")).toBe("请求失败（HTTP 502）");
  });

  it("error 是对象但没有 message 时不许显示 [object Object]", async () => {
    reply(409, { error: { code: "engine_busy" } });
    expect(await messageOf("/topics")).toBe("请求失败（HTTP 409）");
  });

  it("成功响应原样交出去(错误分支没有吃掉正常路径)", async () => {
    reply(200, { rows: [{ id: 1 }] });
    expect(await api("/topics")).toEqual({ rows: [{ id: 1 }] });
  });

  it("取消请求仍然按 AbortError 抛出,不折成服务不可达", async () => {
    globalThis.fetch = (async () => {
      const e = new DOMException(" aborted", "AbortError");
      throw e;
    }) as typeof fetch;
    const err = await api("/topics").catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });
});
