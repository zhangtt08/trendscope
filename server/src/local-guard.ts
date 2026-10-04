/**
 * 本机服务的入站边界判定 —— 与作品集里 `geo/src/lib/local-guard.ts` 同一套语义,逐条对齐。
 *
 * 为什么需要这一份(而不是"绑到 127.0.0.1 就完事"):
 * `server/src/index.ts` 过去 `app.listen(PORT)` 不带 host 参数,Node 的默认值是 **0.0.0.0** ——
 * 局域网里任何人都能直接打到这些接口(2026-10-05 实测:本机 192.168.1.7:5184 能拿到
 * /api/health,伪造 `Host: evil.example.com` 也照样 200)。
 * 而**光绑回环仍挡不住 DNS rebinding**:被诱导访问一个把域名解析到 127.0.0.1 的网页时,
 * 请求确实是从本机来的,浏览器还会把 `Origin` 与 `Host` 都写成那个外域域名 —— 看起来"同源"。
 * 回环地址分不出是谁在说话,**Host 头才分得出**。所以判定必须在应用层做,绑定地址只是第二层。
 *
 * 三条判定(顺序固定,见 evaluateRequestGuard):
 * 1. `Host` 必须逐字等于 `127.0.0.1:<port>`、`localhost:<port>` 或 `[::1]:<port>`;
 * 2. `Origin`/`Referer` 带了就必须同样落在回环 host:port 上 —— **绝不拿 Origin 跟请求自己的
 *    Host 比**(一比就正好把 rebinding 放行:rebinding 时两者都是攻击者的域名);
 * 3. 设置了 `TRENDSCOPE_LOCAL_TOKEN` 时,非 GET 请求必须带一致的 `x-agent-token`(常数时间比较)。
 *
 * 这个文件刻意写成**纯函数、零依赖、不 import express/node 运行时 API**:判定表能在单测里
 * 逐条驱动(不起服务),Express 那一层外壳只是它的一个适配器,住在 `server/src/app.ts`。
 */

/** 本服务的默认端口(与 `npm start`、agent/launch.json、桌面壳一致)。 */
export const DEFAULT_PORT = 5184;

/**
 * 唯一的绑定地址:启动、体检(doctor)、验收脚本都从这里读,不许在第二个地方再写一遍
 * —— "doctor 报端口空闲,服务却监听所有网卡"这种分叉就是这么长出来的。
 */
export const LOCAL_BIND_HOST = "127.0.0.1";

/** 共享令牌的变量名与请求头名(只列名,值永远不进代码/日志/界面)。 */
export const TOKEN_ENV_NAME = "TRENDSCOPE_LOCAL_TOKEN";
export const TOKEN_HEADER_NAME = "x-agent-token";

/**
 * 入站请求体上限。**必须高于本仓最大的合法写入请求**,否则闸门会抢在 body parser 之前拒绝,
 * 用户看到的原因就不是真的那个原因:导入路由自己允许 14 MB(`server/src/routes/api.ts` 的
 * `express.json({ limit: "14mb" })`),这里留到 32 MB —— 既放过真实导入,又挡住
 * "用大 body 把本机进程打满"。
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** 只允许这几个回环主机名。`::1` 的两种写法(带方括号与不带)都归一到 `[::1]`。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 会带请求体的动词:这几个才需要声明长度;GET/HEAD 按标准不查 body。 */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 需要令牌的判定里算只读的动词。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GuardRequest {
  /** `Host` 头原值(大小写不敏感由调用方处理)。 */
  host?: string | null;
  /** `Origin` 头,可缺。 */
  origin?: string | null;
  /** `Referer` 头,可缺。 */
  referer?: string | null;
  /** HTTP 方法(大写或不大写都接受)。 */
  method: string;
  /** `Content-Length` 头原值,可缺(缺 = 长度未知)。 */
  contentLength?: string | null;
  /** `Transfer-Encoding` 头原值,可缺。只有明确写了 chunked 才算"长度未知地带"。 */
  transferEncoding?: string | null;
  /** `x-agent-token` 头,可缺。 */
  token?: string | null;
}

export interface GuardPolicy {
  /**
   * 本服务**实际监听**的端口:`Host` 与 `Origin` 都必须落在这个端口上。
   * 端口只能来自运行时(app.listen 的那个值 / 连接实际落到的本机端口),
   * 绝不能取自请求头 —— 那是把判据交给被判定的一方。
   */
  port: number;
  /** `TRENDSCOPE_LOCAL_TOKEN`;未设置(空串/undefined)即不启用共享令牌这一道。 */
  token?: string | null;
  /** 请求体上限,默认 `MAX_REQUEST_BYTES`。 */
  maxBodyBytes?: number;
}

export interface GuardDenial {
  status: number;
  /** 机器可读的拒绝原因,调用方(含 Agent)按它分支,不靠读中文。 */
  code: string;
  message: string;
}

/** 通过 = null;拒绝 = 要回的那一份 JSON 错误体的字段。 */
export type GuardDecision = GuardDenial | null;

/**
 * `value` 不是合法回环 host:port 时返回 null;合法时返回归一后的 `{ host, port }`。
 * IPv6 必须带方括号(`[::1]:5184`),这是 URL 语法,也是浏览器发出来的形状。
 */
export function parseLoopbackAuthority(
  value: string | null | undefined,
): { host: string; port: number } | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  let host = "";
  let portText = "";
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return null;
    host = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (!rest) return null; // `[::1]` 不带端口不算合法 authority:判定要求逐字到端口
    if (!rest.startsWith(":")) return null;
    portText = rest.slice(1);
  } else {
    const firstColon = raw.indexOf(":");
    if (firstColon < 0) return null; // 不带端口同样不合法
    if (raw.indexOf(":", firstColon + 1) >= 0) return null; // 裸 IPv6(无方括号)不接受
    host = raw.slice(0, firstColon);
    portText = raw.slice(firstColon + 1);
  }
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  const normalized = host === "::1" ? "[::1]" : host;
  if (!LOOPBACK_HOSTS.has(normalized.toLowerCase())) return null;
  return { host: normalized.toLowerCase(), port };
}

/**
 * 常数时间字符串比较:不能用 `===` 逐字符短路,否则响应时间泄露令牌前缀,
 * 本机端口上多一个能测时延的人就多一条猜出来的路。
 * 长度不同可以立刻定论(长度本身不是秘密),但内容比较不提前退出。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * 拒绝时的 JSON 错误体(绝不是 HTML):两种外壳都给全 ——
 * `{ok:false,error:{code,message}}` 是 Agent 契约的形状,顶层 `message` 是界面读的字段。
 * 少任何一个,对应那一侧的调用方就只能读到一句 undefined 或一整个 HTML 页面。
 */
export function denialBody(denial: GuardDenial): Record<string, unknown> {
  return {
    ok: false,
    code: denial.code,
    message: denial.message,
    error: { code: denial.code, message: denial.message },
  };
}

/**
 * 从进程环境读出判定要用的那两样:监听端口与共享令牌。
 * 端口只来自运行时环境(`npm start` / 桌面壳 / agent/serve.mjs 都是 `PORT=...`),
 * 不接受任何请求头里的端口。抽成函数是为了能在单测里用假环境逐条驱动,不需要真的起服务。
 */
export function policyFromEnv(
  env: Record<string, string | undefined> = process.env,
  fallbackPort: number = DEFAULT_PORT,
): GuardPolicy {
  const raw = Number(env.PORT ?? fallbackPort);
  const port = Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : fallbackPort;
  return { port, token: env[TOKEN_ENV_NAME]?.trim() || null };
}

/**
 * 唯一的判定入口。顺序是有意的:先看 Host(不是本机就根本没有"同源"可言),
 * 再限量(超大 body 不必等到解析才被发现),再看 Origin/Referer,最后看令牌。
 */
export function evaluateRequestGuard(request: GuardRequest, policy: GuardPolicy): GuardDecision {
  const method = (request.method ?? "GET").toUpperCase();
  const port = policy.port;

  const host = parseLoopbackAuthority(request.host);
  if (!host) {
    return {
      status: 403,
      code: "forbidden_host",
      message:
        `只接受本机回环地址的访问(Host 必须是 127.0.0.1:${port}、localhost:${port} 或 [::1]:${port}),` +
        `收到的是「${(request.host ?? "").trim() || "空"}」。这一条拒绝与你的登录状态无关,` +
        `如果是从别的机器或别的域名打开的,请在本机用 http://127.0.0.1:${port} 访问。`,
    };
  }
  if (host.port !== port) {
    return {
      status: 403,
      code: "forbidden_host",
      message: `Host 头的端口是 ${host.port},本服务监听的是 ${port}。端口不符的请求一律拒绝。`,
    };
  }

  const maxBytes = policy.maxBodyBytes ?? MAX_REQUEST_BYTES;
  const declared = (request.contentLength ?? "").trim();
  const chunked = /chunked/i.test((request.transferEncoding ?? "").trim());
  if (declared) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
      return { status: 400, code: "bad_content_length", message: "Content-Length 不是合法的非负整数。" };
    }
    if (size > maxBytes) {
      return {
        status: 413,
        code: "payload_too_large",
        message: `请求体 ${size} 字节,超过本机服务允许的上限 ${maxBytes} 字节。`,
      };
    }
  } else if (BODY_METHODS.has(method) && chunked) {
    // 没声明长度的空 body 请求(浏览器与 undici 都这样发 DELETE)放过;
    // 明确用 `Transfer-Encoding: chunked` 送一个长度未知的 body 才是拦下的那一个。
    return {
      status: 411,
      code: "length_required",
      message: `${method} 用 chunked 送长度未知的请求体,本机服务一律拒绝(上限 ${maxBytes} 字节,请用 Content-Length 声明长度)。`,
    };
  }

  for (const [name, value] of [
    ["Origin", request.origin],
    ["Referer", request.referer],
  ] as const) {
    const header = (value ?? "").trim();
    if (!header) continue; // 没带就不参与判定(curl / 本机脚本 / 桌面壳都不带 Origin)
    let url: URL;
    try {
      url = new URL(header);
    } catch {
      return { status: 403, code: "forbidden_origin", message: `${name} 头不是可解析的地址:「${header}」。` };
    }
    const from = parseLoopbackAuthority(url.host);
    if (!from) {
      return {
        status: 403,
        code: "forbidden_origin",
        message:
          `${name} 来自「${header}」,不是本机回环地址(只允许 http://127.0.0.1:${port}、` +
          `http://localhost:${port}、http://[::1]:${port} 这一类)。` +
          "网页带着这个头发写入请求会被拒绝 —— 这是防 DNS rebinding 的那一道,不是你的操作有误。",
      };
    }
    if (from.port !== port) {
      return {
        status: 403,
        code: "forbidden_origin_port",
        message: `${name} 的端口是 ${from.port},本服务监听的是 ${port};端口不符一律拒绝。`,
      };
    }
  }

  const required = (policy.token ?? "").trim();
  if (required && !SAFE_METHODS.has(method)) {
    const provided = (request.token ?? "").trim();
    if (!provided || !constantTimeEquals(provided, required)) {
      return {
        status: 403,
        code: "token_required",
        message:
          `本服务已启用共享令牌(${TOKEN_ENV_NAME}):非 GET 请求必须带一致的 ${TOKEN_HEADER_NAME} 头。` +
          (provided ? "带是带了,但不对。" : "这一次没有带这个头。"),
      };
    }
  }

  return null;
}
