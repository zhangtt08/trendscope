/**
 * 本机边界闸门的判定表单测(`server/src/local-guard.ts`)。
 *
 * 这一份不需要起服务:判定是纯函数,所以每条都能逐字驱动。
 * 最关键的是 test「DNS rebinding 的形状」—— **Origin 与 Host 同为外域**时必须仍然被拒。
 * 任何"拿 Origin 跟请求自己的 Host 比"的实现(一比就把 rebinding 放行)在这里就会红。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PORT,
  LOCAL_BIND_HOST,
  MAX_REQUEST_BYTES,
  TOKEN_ENV_NAME,
  constantTimeEquals,
  denialBody,
  evaluateRequestGuard,
  parseLoopbackAuthority,
  policyFromEnv,
} from "../../server/src/local-guard";

const PORT = 5184;

function decide(input: Parameters<typeof evaluateRequestGuard>[0], policy: Partial<Parameters<typeof evaluateRequestGuard>[1]> = {}) {
  return evaluateRequestGuard({ method: "GET", ...input }, { port: PORT, token: null, ...policy });
}

/* ---------- authority 解析:只认三种写法,且必须带端口 ---------- */

describe("回环 authority 解析", () => {
  it("只接受 127.0.0.1 / localhost / [::1] 这三种带端口的写法", () => {
    expect(parseLoopbackAuthority("127.0.0.1:5184")).toEqual({ host: "127.0.0.1", port: 5184 });
    expect(parseLoopbackAuthority("LOCALHOST:5184")).toEqual({ host: "localhost", port: 5184 });
    expect(parseLoopbackAuthority("[::1]:5184")).toEqual({ host: "[::1]", port: 5184 });
    // ::1 的两种写法归一到带方括号的那一种(URL 的形状)
    expect(parseLoopbackAuthority("[::1]:5184")!.host).toBe("[::1]");
  });

  it("不带端口 / 空 / 裸 IPv6 / 越界端口都不合法", () => {
    expect(parseLoopbackAuthority("127.0.0.1")).toBeNull();
    expect(parseLoopbackAuthority("[::1]")).toBeNull();
    expect(parseLoopbackAuthority("")).toBeNull();
    expect(parseLoopbackAuthority(null)).toBeNull();
    expect(parseLoopbackAuthority(undefined)).toBeNull();
    expect(parseLoopbackAuthority("::1:5184")).toBeNull();
    expect(parseLoopbackAuthority("127.0.0.1:70000")).toBeNull();
    expect(parseLoopbackAuthority("127.0.0.1:abc")).toBeNull();
    expect(parseLoopbackAuthority("127.0.0.1:0")).toBeNull();
  });

  it("非回环主机名一律不合法(含前缀伪装与局域网地址)", () => {
    for (const bad of [
      "evil.example.com:5184",
      "localhost.evil.com:5184",
      "evil-localhost.com:5184",
      "192.168.1.7:5184",
      "10.0.0.5:5184",
      "0.0.0.0:5184",
      "127.1:5184",
      "127.0.0.1.evil.com:5184",
    ]) {
      expect(parseLoopbackAuthority(bad), bad).toBeNull();
    }
  });
});

/* ---------- 1. Host ---------- */

describe("Host 判定", () => {
  it("非回环 Host 一律 403(局域网直连与 DNS rebinding 都在这条上被挡)", () => {
    for (const host of ["evil.example.com", "192.168.1.7:5184", "0.0.0.0:5184", "localhost.evil.com:5184"]) {
      const denial = decide({ host, method: "GET" });
      expect(denial?.status, `Host=${host} 应当被拒`).toBe(403);
      expect(denial?.code).toBe("forbidden_host");
    }
    expect(decide({ host: null })?.code).toBe("forbidden_host");
    expect(decide({ host: "" })?.code).toBe("forbidden_host");
    expect(decide({ host: "   " })?.code).toBe("forbidden_host");
  });

  it("三种回环写法都放行", () => {
    expect(decide({ host: "127.0.0.1:5184" })).toBeNull();
    expect(decide({ host: "localhost:5184" })).toBeNull();
    expect(decide({ host: "[::1]:5184" })).toBeNull();
    expect(decide({ host: "LocalHost:5184" })).toBeNull();
  });

  it("回环 Host 但端口不是本服务监听的端口 → 403", () => {
    expect(decide({ host: "127.0.0.1:5185" })?.code).toBe("forbidden_host");
    expect(decide({ host: "127.0.0.1:80" })?.code).toBe("forbidden_host");
    expect(decide({ host: "127.0.0.1:5184" })).toBeNull();
  });

  it("判定用的端口来自运行时环境,不是请求头", () => {
    expect(policyFromEnv({ PORT: "5199" })).toEqual({ port: 5199, token: null });
    expect(policyFromEnv({})).toEqual({ port: DEFAULT_PORT, token: null });
    expect(policyFromEnv({ PORT: "not-a-port" })).toEqual({ port: DEFAULT_PORT, token: null });
    expect(policyFromEnv({ PORT: "0" })).toEqual({ port: DEFAULT_PORT, token: null });
    expect(
      policyFromEnv({ PORT: "5199", [TOKEN_ENV_NAME]: "  secret  " }),
    ).toEqual({ port: 5199, token: "secret" });
    // 换一台端口时,同一份 Host 的结论会变 —— 证明它比较的是运行时端口
    expect(evaluateRequestGuard({ host: "127.0.0.1:5199", method: "GET" }, { port: 5199, token: null })).toBeNull();
    expect(evaluateRequestGuard({ host: "127.0.0.1:5199", method: "GET" }, { port: 5184, token: null })?.code).toBe(
      "forbidden_host",
    );
  });

  it("绑定地址常量就是 IPv4 回环(0.0.0.0 会让局域网直连)", () => {
    expect(LOCAL_BIND_HOST).toBe("127.0.0.1");
  });
});

/* ---------- 2. Origin / Referer:绝不与请求自己的 Host 比 ---------- */

describe("Origin / Referer 判定", () => {
  it("必须同样落在回环 host:port 上", () => {
    expect(decide({ host: "127.0.0.1:5184", origin: "http://localhost:5184" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", referer: "http://127.0.0.1:5184/topics" })).toBeNull();
    expect(decide({ host: "[::1]:5184", origin: "http://[::1]:5184" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", origin: "https://evil.example.com" })?.code).toBe("forbidden_origin");
    expect(decide({ host: "127.0.0.1:5184", origin: "http://127.0.0.1:9999" })?.code).toBe("forbidden_origin_port");
    expect(decide({ host: "127.0.0.1:5184", referer: "http://evil.test/x" })?.code).toBe("forbidden_origin");
    expect(decide({ host: "127.0.0.1:5184", referer: "http://192.168.1.7:5184/" })?.code).toBe("forbidden_origin");
    expect(decide({ host: "127.0.0.1:5184", origin: "not a url" })?.code).toBe("forbidden_origin");
  });

  it("没带 Origin/Referer 不参与判定(curl、本机脚本、桌面壳、Agent 都不带)", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "12" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "POST", origin: "" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "POST", origin: "   " })).toBeNull();
  });

  it("DNS rebinding 的形状:Origin 与 Host 同为外域时仍然 403", () => {
    // 这一条专打"Origin === Host 就算同源"的那种实现。
    const denial = decide({
      host: "evil.example.com:5184",
      origin: "http://evil.example.com:5184",
      referer: "http://evil.example.com:5184/attack",
      method: "PUT",
      contentLength: "20",
    });
    expect(denial?.status).toBe(403);
    expect(denial?.code).toBe("forbidden_host");
  });

  it("把外域伪装成回环前缀也算外域(不因包含 localhost 而放行)", () => {
    expect(
      decide({ host: "127.0.0.1.localhost.evil.com:5184", origin: "http://localhost:5184", method: "POST" })?.code,
    ).toBe("forbidden_host");
  });
});

/* ---------- 3. 可选共享令牌 ---------- */

describe("共享令牌", () => {
  const policy = { token: "let-me-in" };

  it("设置了令牌后,非 GET 必须带一致的值", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "GET" }, policy)).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "HEAD" }, policy)).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "OPTIONS" }, policy)).toBeNull();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(decide({ host: "127.0.0.1:5184", method, contentLength: "5" }, policy)?.code).toBe("token_required");
      expect(
        decide({ host: "127.0.0.1:5184", method, contentLength: "5", token: "let-me-in" }, policy),
      ).toBeNull();
    }
  });

  it("带了但不一致 → 拒绝;前缀对也要拒(不许逐字符短路)", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "POST", contentLength: "5", token: "let-me-inX" }, policy)?.code).toBe(
      "token_required",
    );
    expect(decide({ host: "127.0.0.1:5184", method: "POST", contentLength: "5", token: "let-me-i" }, policy)?.code).toBe(
      "token_required",
    );
    expect(decide({ host: "127.0.0.1:5184", method: "POST", contentLength: "5", token: "" }, policy)?.code).toBe(
      "token_required",
    );
  });

  it("没设令牌 = 这一道不启用(标准里它是可选的)", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "5" }, { token: null })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "5" }, { token: "" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "5" }, { token: "   " })).toBeNull();
  });

  it("constantTimeEquals 只在完全一致时为真", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "ab")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("a".repeat(64), "a".repeat(63) + "b")).toBe(false);
  });
});

/* ---------- 4. 入站 body 上限 ---------- */

describe("请求体上限", () => {
  it("声明过大 / 长度未知的 chunked 都先拒", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: String(MAX_REQUEST_BYTES + 1) })?.code).toBe(
      "payload_too_large",
    );
    expect(decide({ host: "127.0.0.1:5184", method: "POST", transferEncoding: "chunked" })?.code).toBe("length_required");
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "-5" })?.code).toBe("bad_content_length");
    expect(decide({ host: "127.0.0.1:5184", method: "PUT", contentLength: "abc" })?.code).toBe("bad_content_length");
  });

  it("没有 body 的 DELETE(浏览器不写 Content-Length)不被误伤", () => {
    expect(decide({ host: "127.0.0.1:5184", method: "DELETE" })).toBeNull();
    expect(decide({ host: "127.0.0.1:5184", method: "GET", transferEncoding: "chunked" })).toBeNull();
  });

  it("上限必须高于本仓最大的合法写入请求(导入路由允许 14 MB)", () => {
    // 闸门抢在 body parser 前面拒 = 用户看到的原因不是真的原因。
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(14 * 1024 * 1024);
    expect(decide({ host: "127.0.0.1:5184", method: "POST", contentLength: String(14 * 1024 * 1024) })).toBeNull();
  });

  it("上限可以按调用方给的值收紧", () => {
    expect(
      decide({ host: "127.0.0.1:5184", method: "POST", contentLength: "200" }, { maxBodyBytes: 100 })?.code,
    ).toBe("payload_too_large");
  });
});

/* ---------- 拒绝体必须是 JSON,且两种外壳都给全 ---------- */

describe("拒绝体形状", () => {
  it("同时给出 Agent 契约的 error{code,message} 与界面读的 message", () => {
    const denial = evaluateRequestGuard({ host: "evil.example.com:5184", method: "GET" }, { port: PORT, token: null })!;
    const body = denialBody(denial);
    expect(body.ok).toBe(false);
    expect(typeof body.message).toBe("string");
    expect((body.error as { code: string }).code).toBe("forbidden_host");
    expect((body.error as { message: string }).message).toBe(denial.message);
    expect(body.code).toBe("forbidden_host");
    // 拒绝理由必须可操作:说清要用什么地址访问
    expect(denial.message).toContain("127.0.0.1:5184");
    expect(JSON.parse(JSON.stringify(body)).error.message).toBe(denial.message);
  });

  it("每条拒绝都有非空中文 message 与机器可读 code", () => {
    const cases = [
      { host: "evil.example.com:5184", method: "GET" },
      { host: "127.0.0.1:5185", method: "GET" },
      { host: "127.0.0.1:5184", method: "POST", origin: "https://evil.example.com" },
      { host: "127.0.0.1:5184", method: "POST", contentLength: String(MAX_REQUEST_BYTES + 1) },
      { host: "127.0.0.1:5184", method: "POST", transferEncoding: "chunked" },
    ] as const;
    for (const c of cases) {
      const d = decide(c, { token: "need" });
      expect(d, JSON.stringify(c)).not.toBeNull();
      expect(d!.status).toBeGreaterThanOrEqual(400);
      expect(typeof d!.code).toBe("string");
      expect(d!.message.length).toBeGreaterThan(10);
    }
  });
});
