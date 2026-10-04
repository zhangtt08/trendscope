/**
 * 本机边界闸门的 HTTP 层测试 —— 起真服务、发真请求,判据落在**连接与响应**上。
 *
 * 为什么不能只有 `tests/unit/local-guard.test.ts`:判定表可以是对的,接线却可能是错的 ——
 *   · 中间件注册在 `app.get("*")` 之后 → 被拒的请求拿到的是 index.html + 200,不是 JSON 403;
 *   · `app.listen(PORT)` 少写 host 参数 → Node 默认绑 0.0.0.0,局域网里谁都连得上;
 *   · 闸门本身写反(拿 Origin 比 Host)→ rebinding 被放行。
 * 这三件事都只有真监听、真连接才量得出来。
 *
 * 数据隔离与其余集成测试同一套做法:`createTestDb()`(:memory: + 完整迁移),
 * 绝不碰 `data/trendscope.db`(使用者的真实库)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, type DB } from "../../server/src/db/client";
import { contentItems } from "../../server/src/db/schema";
import { createApp, listenLocal } from "../../server/src/app";
import { LOCAL_BIND_HOST, MAX_REQUEST_BYTES } from "../../server/src/local-guard";
import { CollectionRuntime } from "../../server/src/services/collection/runtime";

const NOW = "2026-10-05T12:00:00.000Z";

interface Handle {
  server: Server;
  port: number;
  address: string;
  family: string;
  base: string;
}

const handles: Handle[] = [];
const servers: Server[] = [];

interface Reply {
  status: number;
  contentType: string;
  text: string;
  json: any | null;
  error?: string;
}

/** 预先占一个空闲端口拿到号码,再立刻放开:测试要**显式**把端口告诉闸门(index.ts 走的就是这条路)。 */
async function pickFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((res) => probe.listen(0, LOCAL_BIND_HOST, () => res()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

async function start(
  db: DB,
  opts: { guardPort?: number; token?: string | null } = {},
): Promise<Handle> {
  const build = async (port: number): Promise<{ server: Server; addr: AddressInfo }> => {
    const app = createApp(db, new CollectionRuntime(db), {
      dbFile: ":memory:",
      localGuard: {
        ...(opts.guardPort ? { port } : {}),
        ...(opts.token !== undefined ? { token: opts.token } : {}),
      },
    });
    const server = listenLocal(app, port);
    servers.push(server);
    await new Promise<void>((res, rej) => {
      server.once("listening", () => res());
      server.once("error", rej);
    });
    return { server, addr: server.address() as AddressInfo };
  };

  if (opts.guardPort) {
    // 端口是预先挑的,极小概率被别的进程抢走 —— 换号重试,而不是让整份测试因为撞车而红。
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { server, addr } = await build(opts.guardPort);
        const handle: Handle = {
          server,
          port: addr.port,
          address: addr.address,
          family: addr.family,
          base: `http://127.0.0.1:${addr.port}`,
        };
        handles.push(handle);
        return handle;
      } catch (e) {
        last = e;
        opts.guardPort = await pickFreePort();
      }
    }
    throw last;
  }

  const { server, addr } = await build(0);
  const handle: Handle = {
    server,
    port: addr.port,
    address: addr.address,
    family: addr.family,
    base: `http://127.0.0.1:${addr.port}`,
  };
  handles.push(handle);
  return handle;
}

/**
 * 真发一条请求,`Host` 头由调用方逐字决定 —— 必须用 `node:http`:浏览器与 fetch 都会把 Host
 * 规范化成目标地址,伪造不出 rebinding 的形状。`hostHeader: undefined` 表示用合法回环值。
 *
 * 带 body 时**显式声明 Content-Length**:Node 的 ClientRequest 在不声明长度时会自动改用
 * chunked 编码,而闸门对"长度未知的 chunked body"另有判定(411)—— 那样测的就不是这一条了。
 * 要测 chunked 请走 `rawSocket()` 手搓请求。
 */
function raw(
  handle: Handle,
  opts: {
    method?: string;
    path?: string;
    hostHeader?: string;
    headers?: Record<string, string>;
    body?: string;
    connectHost?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Host: opts.hostHeader ?? `127.0.0.1:${handle.port}`,
      ...opts.headers,
    };
    if (opts.body !== undefined && !hasHeader(headers, "content-length")) {
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      {
        host: opts.connectHost ?? "127.0.0.1",
        port: handle.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/api/health",
        headers,
        timeout: 8000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 响应 —— 那正是这里要抓的形状 */
          }
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text, json });
        });
      },
    );
    req.on("error", (e) =>
      resolve({ status: 0, contentType: "", text: "", json: null, error: (e as NodeJS.ErrnoException).code }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, contentType: "", text: "", json: null, error: "ETIMEDOUT" });
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** 手搓一条不带 Host 头的 HTTP/1.0 请求 —— Node 的 ClientRequest 做不到"不发 Host"。 */
function rawSocket(handle: Handle, request: string): Promise<Reply> {
  return new Promise((resolve) => {
    const socket = net.connect(handle.port, "127.0.0.1");
    let text = "";
    socket.setTimeout(8000);
    socket.on("data", (c) => (text += c.toString("utf8")));
    const done = () => {
      const head = text.split("\r\n\r\n")[0] ?? "";
      const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) ?? [])[1] ?? 0);
      const contentType = (head.match(/^content-type: (.*)$/im) ?? [])[1] ?? "";
      const body = text.slice(text.indexOf("\r\n\r\n") + 4);
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {
        /* 同上 */
      }
      resolve({ status, contentType, text: body, json });
      socket.end();
    };
    socket.on("end", done);
    socket.on("close", () => {
      if (!text) resolve({ status: 0, contentType: "", text: "", json: null, error: "ECONNRESET" });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ status: 0, contentType: "", text: "", json: null, error: "ETIMEDOUT" });
    });
    socket.on("error", (e) =>
      resolve({ status: 0, contentType: "", text: "", json: null, error: (e as NodeJS.ErrnoException).code }),
    );
    socket.write(request);
  });
}

let db: DB;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let auto: Handle; // 不配端口:闸门取连接实际落到的本机端口(listen(0) 那条路)
let fixed: Handle; // 显式把监听端口交给闸门(与 index.ts 同一条路)
let tokened: Handle; // 配了共享令牌

beforeAll(async () => {
  const made = createTestDb();
  db = made.db;
  sqlite = made.sqlite;
  await db.insert(contentItems).values({
    platform: "zhihu",
    platformContentId: "answer:guard1",
    contentType: "answer",
    title: "边界闸门测试内容",
    text: "正文",
    dataQuality: "partial",
    upvotes: 1,
    sourceType: "fixture",
    collectedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  auto = await start(db);
  fixed = await start(db, { guardPort: await pickFreePort() });
  tokened = await start(db, { token: "unit-secret" });
});

afterAll(() => {
  for (const s of servers) s.close();
  sqlite?.close();
});

/* ---------- 绑定地址:0.0.0.0 就是「局域网里谁都连得上」 ---------- */

describe("绑定地址", () => {
  it("server.address() 回来的就是本机回环,不是 0.0.0.0", () => {
    for (const h of [auto, fixed, tokened]) {
      expect(h.address, `实际监听地址是 ${h.address}`).toBe(LOCAL_BIND_HOST);
      expect(h.address).not.toBe("0.0.0.0");
      expect(h.family).toBe("IPv4");
    }
  });

  it("回环段里的另一个地址(127.0.0.2)连不上 —— 证明没有绑到全部网卡", async () => {
    for (const h of [auto, fixed]) {
      const r = await raw(h, { connectHost: "127.0.0.2" });
      expect(r.status, `连 127.0.0.2:${h.port} 竟然拿到了 ${r.status}`).toBe(0);
      expect(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]).toContain(r.error);
    }
  });

  it("listenLocal 的回调报回内核实际选定的端口与地址(PORT=0 时只有这里能拿到)", async () => {
    const app = createApp(db, new CollectionRuntime(db), { dbFile: ":memory:" });
    let seen: AddressInfo | null = null;
    const server = listenLocal(app, 0, (bound) => {
      seen = { address: bound.address, port: bound.port, family: bound.family } as AddressInfo;
    });
    await new Promise<void>((res) => server.once("listening", () => res()));
    const addr = server.address() as AddressInfo;
    const reply = await raw({ server, port: addr.port, address: addr.address, family: addr.family, base: "" });
    expect(reply.status).toBe(200);
    expect(seen).not.toBeNull();
    expect((seen as AddressInfo).address).toBe(LOCAL_BIND_HOST);
    // 回读到的端口必须等于 server.address() 的端口:日志、闸门判定、体检报告都得是这一个数
    expect((seen as AddressInfo).port).toBe(addr.port);
    await new Promise<void>((res) => server.close(() => res()));
  });
});

/* ---------- 1. 伪造 Host ---------- */

describe("伪造 Host 一律 403 JSON", () => {
  for (const hostHeader of [
    "evil.example.com",
    "evil.example.com:5184",
    "192.168.1.7:5184",
    "0.0.0.0:5184",
    "localhost.evil.com:5184",
    "127.0.0.1.evil.com:5184",
    "127.0.0.1:80",
  ]) {
    it(`GET /api/health with Host: ${hostHeader}`, async () => {
      const r = await raw(fixed, { hostHeader });
      expect(r.status).toBe(403);
      expect(r.contentType).toContain("application/json");
      expect(r.json?.ok).toBe(false);
      expect(r.json?.error?.code).toBe("forbidden_host");
      expect(r.text).not.toContain("<!DOCTYPE");
    });
  }

  it("不带 Host 头(HTTP/1.0 客户端)同样被拒", async () => {
    const r = await rawSocket(fixed, `GET /api/health HTTP/1.0\r\nConnection: close\r\n\r\n`);
    expect(r.status).toBe(403);
    expect(r.contentType).toContain("application/json");
    expect(r.json?.error?.code).toBe("forbidden_host");
  });

  it("Host 不带端口不合法(判定逐字到端口)", async () => {
    const r = await raw(fixed, { hostHeader: "127.0.0.1" });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("forbidden_host");
  });

  it("回环但端口不是本服务监听的端口 → 拒,并说清监听的是哪一个", async () => {
    const r = await raw(fixed, { hostHeader: `127.0.0.1:${fixed.port + 1}` });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("forbidden_host");
    expect(r.json?.error?.message).toContain(String(fixed.port));
  });
});

/* ---------- 2. 跨站 Origin / Referer ---------- */

describe("跨站来源的写入一律 403 JSON", () => {
  it("evil Origin 的 POST 进不了 handler", async () => {
    const r = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(r.status).toBe(403);
    expect(r.contentType).toContain("application/json");
    expect(r.json?.error?.code).toBe("forbidden_origin");
    expect(r.json?.message).toBe(r.json?.error?.message);
  });

  it("evil Referer 的 PUT 同样被拒", async () => {
    const r = await raw(fixed, {
      method: "PUT",
      path: "/api/topics/1/watch",
      headers: { Referer: "http://evil.test/attack", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("forbidden_origin");
  });

  it("Origin 端口不是本服务端口 → forbidden_origin_port(同机不同端口也不算同源)", async () => {
    const r = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: `http://localhost:${fixed.port + 1}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("forbidden_origin_port");
  });

  it("DNS rebinding 的形状:Host 与 Origin 同为外域时,判的是「Host 是否回环」,绝不是「两者是否相等」", async () => {
    const r = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: `http://rebind.example.test:${fixed.port}`, "Content-Type": "application/json" },
      hostHeader: `rebind.example.test:${fixed.port}`,
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe("forbidden_host");
  });

  it("拒绝响应里没有任何 Access-Control-* 头", async () => {
    const denied = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    expect(denied.text.toLowerCase()).not.toContain("access-control-allow-origin");
    const viaFetch = await fetch(fixed.base + "/api/agent/tools");
    expect(viaFetch.headers.get("access-control-allow-origin")).toBeNull();
    expect(viaFetch.headers.get("access-control-allow-methods")).toBeNull();
    expect(viaFetch.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

/* ---------- 3. 合法本机请求 ---------- */

describe("本机回环的合法请求照常工作", () => {
  it("三种回环 Host 写法都放行", async () => {
    for (const hostHeader of [
      `127.0.0.1:${fixed.port}`,
      `localhost:${fixed.port}`,
      `[::1]:${fixed.port}`,
      `LOCALHOST:${fixed.port}`,
    ]) {
      const r = await raw(fixed, { hostHeader });
      expect(r.status, `Host=${hostHeader}`).toBe(200);
      expect(r.json?.ok).toBe(true);
    }
  });

  it("Agent 契约四个端点都过闸门(闸门没有把契约挡在门外)", async () => {
    const health = await fetch(fixed.base + "/api/health");
    expect(health.status).toBe(200);
    const manifest = await fetch(fixed.base + "/api/agent/manifest");
    expect(manifest.status).toBe(200);
    const tools = await fetch(fixed.base + "/api/agent/tools");
    expect(tools.status).toBe(200);
    const tool = await fetch(fixed.base + "/api/agent/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://localhost:${fixed.port}` },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(tool.status).toBe(200);
  });

  it("界面实际会打的写入端点(带同源 Origin)照常通过", async () => {
    const r = await raw(fixed, {
      method: "POST",
      path: "/api/analysis/full-refresh",
      headers: { Origin: `http://127.0.0.1:${fixed.port}`, Referer: `http://127.0.0.1:${fixed.port}/`, "Content-Type": "application/json" },
      body: JSON.stringify({ wait: true }),
    });
    expect(r.status).toBe(200);
  });

  it("没配令牌时(默认)非 GET 不需要 x-agent-token", async () => {
    const r = await raw(auto, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(r.status).toBe(200);
    expect(r.json?.ok).toBe(true);
  });

  it("闸门不改变既有业务错误形状:未知工具仍是契约的 unknown_tool", async () => {
    const r = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "trendscope.nope", input: {} }),
    });
    expect(r.status).toBe(400);
    expect(r.json?.error?.code).toBe("unknown_tool");
    expect(Array.isArray(r.json?.error?.available)).toBe(true);
  });
});

/* ---------- 4. 注册顺序:先于 SPA 兜底 ---------- */

describe("闸门注册在 SPA 兜底之前", () => {
  it("SPA 路由上的伪造 Host 得到 JSON 403,不是 index.html", async () => {
    const r = await raw(fixed, { path: "/topics", hostHeader: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.contentType).toContain("application/json");
    expect(r.json?.error?.code).toBe("forbidden_host");
    expect(r.text).not.toMatch(/<div id="root"/);
  });

  it("本机访问 SPA 路由仍然返回 HTML(闸门没有把界面挡掉)", async () => {
    if (!fs.existsSync(path.resolve(process.cwd(), "dist", "index.html"))) return; // 未构建时由 verify:release 的产物新鲜度兜住
    const r = await raw(fixed, { path: "/topics" });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/html");
  });

  it("根路径上的伪造 Host 同样被拒(HTML 外壳也不外发)", async () => {
    const r = await raw(fixed, { path: "/", hostHeader: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.contentType).toContain("application/json");
  });
});

/* ---------- 5. 可选共享令牌 ---------- */

describe("配置了 TRENDSCOPE_LOCAL_TOKEN 时", () => {
  it("非 GET 必须带一致的 x-agent-token", async () => {
    const noToken = await raw(tokened, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noToken.status).toBe(403);
    expect(noToken.json?.error?.code).toBe("token_required");

    const wrongToken = await raw(tokened, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json", "x-agent-token": "unit-secreu" },
      body: "{}",
    });
    expect(wrongToken.json?.error?.code).toBe("token_required");

    const okToken = await raw(tokened, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json", "x-agent-token": "unit-secret" },
      body: JSON.stringify({ tool: "trendscope.overview", input: {} }),
    });
    expect(okToken.status).toBe(200);
    expect(okToken.json?.ok).toBe(true);
  });

  it("GET 不查令牌(界面只读的功能照常)", async () => {
    const r = await raw(tokened, { path: "/api/health" });
    expect(r.status).toBe(200);
  });

  it("令牌判定排在 Host 之后:外域带对令牌也是 forbidden_host", async () => {
    const r = await raw(tokened, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json", "x-agent-token": "unit-secret" },
      hostHeader: "evil.example.com",
      body: "{}",
    });
    expect(r.json?.error?.code).toBe("forbidden_host");
  });

  it("令牌值不出现在错误体里,但说要带哪个头", async () => {
    const r = await raw(tokened, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { "Content-Type": "application/json", "x-agent-token": "wrong" },
      body: "{}",
    });
    expect(r.text).not.toContain("unit-secret");
    expect(r.text).toContain("x-agent-token");
  });
});

/* ---------- 6. 入站 body 上限 ---------- */

describe("入站请求体上限在进入 handler 之前生效", () => {
  it("声明过大 → 413 JSON(手搓请求,因为长度本身就是谎报的)", async () => {
    const text = await new Promise<string>(async (resolve) => {
      const socket = net.connect(fixed.port, "127.0.0.1");
      let acc = "";
      socket.on("data", (c) => (acc += c.toString("utf8")));
      socket.on("close", () => resolve(acc));
      socket.on("error", () => resolve(acc));
      socket.setTimeout(8000, () => {
        socket.destroy();
        resolve(acc);
      });
      socket.write(
        `POST /api/agent/tool HTTP/1.1\r\nHost: 127.0.0.1:${fixed.port}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${MAX_REQUEST_BYTES + 1}\r\nConnection: close\r\n\r\n{}`,
      );
    });
    expect(text).toContain("HTTP/1.1 413");
    expect(text).toContain("application/json");
    expect(text).toContain("payload_too_large");
  });

  it("chunked 且长度未知 → 411 JSON", async () => {
    const text = await new Promise<string>(async (resolve) => {
      const socket = net.connect(fixed.port, "127.0.0.1");
      let acc = "";
      socket.on("data", (c) => (acc += c.toString("utf8")));
      socket.on("close", () => resolve(acc));
      socket.on("error", () => resolve(acc));
      socket.setTimeout(8000, () => {
        socket.destroy();
        resolve(acc);
      });
      socket.write(
        `POST /api/agent/tool HTTP/1.1\r\nHost: 127.0.0.1:${fixed.port}\r\n` +
          `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
      );
    });
    expect(text).toContain("HTTP/1.1 411");
    expect(text).toContain("length_required");
  });

  it("被拒的请求不会打挂服务:随后本机请求照常", async () => {
    const denied = await raw(fixed, {
      method: "POST",
      path: "/api/agent/tool",
      headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    const after = await fetch(fixed.base + "/api/health");
    expect(after.status).toBe(200);
  });
});
