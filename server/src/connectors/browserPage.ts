/**
 * 浏览器页面采集连接器(playwright-core)。
 *
 * 为什么需要它:抖音 / 小红书的网页热榜由前端 JS 渲染,并且它们的服务端会拒绝
 * 非浏览器请求 —— 小红书更进一步,未签名的接口直接 500、无登录态的探索页跳登录。
 * 本连接器**不伪造签名、不绕过验证码、不做指纹伪装**:它启动使用者本机已装的
 * 真实 Chrome / Edge,用一份属于用户自己的持久化档案打开页面,读页面渲染出来的内容。
 *
 * 刻意保持"像人在用"的三条:
 *  1. 默认有头(headless:false)—— 不隐藏自己在做什么;用户看得见窗口;
 *  2. 一次只开一个页面、只取一屏热榜(maxItems 有上限),不做翻页爬取、不点进详情页;
 *  3. 请求频率由采集任务的定时档控制(默认很长的间隔或手动),不并发。
 *
 * 遇到登录墙 / 风控页时**停下来如实报错**,不尝试绕过 —— 由用户自己在那个窗口里登录一次。
 */
import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ConnectorError, type Connector, type ConnectorMetadata, type ConnectorPolicy, type ConnectorRunContext } from "./types";
import { validateWithSchema } from "./types";
import type { PageResult, RemotePageRequest } from "../domain/collection";
import { PlatformSchema } from "../domain/constants";

export const BROWSER_PAGE_CONNECTOR_ID = "browser-page";

/** 字段取法:`CSS 选择器` 或 `CSS 选择器::属性名`(默认取可见文字) */
const FieldSpecSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((v) => v.split("::")[0]!.trim().length > 0, "字段选择器不能为空");

export const BrowserPageConfigSchema = z
  .object({
    url: z.string().regex(/^https:\/\/[^\s]+$/i, "浏览器采集只支持 https 地址"),
    /**
     * dom = 按 CSS 选择器读渲染后的页面;
     * network = 读**页面自己请求回来的 JSON**(平台的热榜数据几乎都走这一步,
     *   签名由页面自己的脚本完成,我们只是读它已经收到的东西 —— 不伪造、不绕验证)。
     * network 模式的好处是不用猜 class:抖音改版时 class 变了选择器就废,而接口结构稳定得多。
     */
    mode: z.enum(["dom", "network"]).default("dom"),
    /** network:响应 URL 命中这个子串才算候选(如 "hot/search/list") */
    urlPattern: z.string().min(1).max(300).optional(),
    /** network:JSON 里数组的点路径(如 data.word_list);留空则在本条响应里自动找对象数组 */
    pickPath: z.string().min(1).max(300).optional(),
    /** 热榜条目容器;取到多少个就采多少条(上限 maxItems) */
    itemSelector: z.string().min(1).max(300).default("li"),
    /** 目标字段 ← 条目内的取法,如 { title: "a", url: "a::href", views: "[class*=hot]" } */
    fields: z.record(FieldSpecSchema).default({}),
    /**
     * 整批固定的字段。典型用法是 network 模式采视频流时写 { contentType: "video" } ——
     * 接口里没有这个键,但不写的话这些条目会归到"未知类型",内容类型构成那张表就说假话。
     */
    constants: z.record(z.string().min(1).max(60)).default({}),
    platform: PlatformSchema.default("other"),
    /** 等这个选择器出现再动手;留空则等 itemSelector */
    waitSelector: z.string().min(1).max(300).optional(),
    waitMs: z.number().int().min(0).max(60_000).default(20_000),
    /** 稳定等待:页面还在异步渲染时先等一下再判定,避免把"还没渲染"误判成"没有数据" */
    settleMs: z.number().int().min(0).max(30_000).default(4_000),
    maxItems: z.number().int().min(1).max(100).default(30),
    headless: z.boolean().default(false),
    /** 最终 URL 命中这些前缀 = 被要求登录 */
    loginUrlPrefixes: z.array(z.string().min(1).max(300)).default([]),
    /** 页面上出现这些选择器 = 被要求登录 / 被风控 */
    blockedSelectors: z.array(z.string().min(1).max(300)).default([]),
  })
  .strict();

export type BrowserPageConfig = z.infer<typeof BrowserPageConfigSchema>;

/** 用户自己的浏览器档案目录(登录态就在这里,永不进数据库、永不出本机)。 */
export function browserProfileDir(): string {
  const p = process.env.TRENDSCOPE_BROWSER_PROFILE?.trim() || resolve(process.cwd(), "data/browser-profile");
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/** 本机已装的 Chromium 系浏览器;找不到就明确报错,不悄悄下载几百 MB 浏览器。 */
export async function launchInstalledBrowser(headless: boolean): Promise<BrowserLike> {
  const pw = await import("playwright-core").catch(() => null);
  if (!pw?.chromium) {
    throw new ConnectorError("INVALID_CONFIG", "缺少 playwright-core 依赖:npm install playwright-core 之后再运行");
  }
  let lastErr: unknown = null;
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return (await pw.chromium.launchPersistentContext(browserProfileDir(), {
        channel,
        headless,
      })) as unknown as BrowserLike;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new ConnectorError(
    "NETWORK_ERROR",
    `没能在本机找到可驱动的 Chrome 或 Edge —— 浏览器采集需要你已安装的浏览器。` +
      `最后一次尝试的错误:${lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr)}`,
  );
}

function parseFieldSpec(spec: string): { selector: string; attr: string | null } {
  const [sel, attr] = spec.split("::");
  return { selector: (sel ?? "").trim(), attr: attr?.trim() ? attr.trim() : null };
}

/* 只声明本连接器真正用到的那几个 API —— 测试可以用同一形状替身,不需要真浏览器。 */
interface ElementLike {
  $(sel: string): Promise<ElementLike | null>;
  innerText(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
}
interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
}
interface PageLike {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
  url(): string;
  waitForSelector(sel: string, opts: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  $$(sel: string): Promise<ElementLike[]>;
  locator(sel: string): { first(): { isVisible(): Promise<boolean> } };
  on(event: string, handler: (res: ResponseLike) => void): void;
}
interface BrowserLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export type BrowserLauncher = (headless: boolean) => Promise<BrowserLike>;
export type { BrowserLike };

/** 网络捕获模式下,字段值可以带变换标记:`statistics.digg_count`、`create_time#unix`(秒级时间戳) */
function pickValue(obj: Record<string, unknown>, spec: string): unknown {
  const [path, transform] = spec.split("#");
  let cur: unknown = obj;
  for (const key of String(path ?? "").split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  if (transform === "unix" && typeof cur === "number" && cur > 0) {
    // 秒级 unix 时间戳 → ISO。抖音的 create_time 就是这种,不换算会显示成 1970。
    return new Date(cur * 1000).toISOString();
  }
  return cur;
}

/** 在 JSON 里按点路径找数组;找不到就看能不能自动认出一个"对象数组"(热榜接口通常只有一两个)。 */
function locateArray(root: unknown, pickPath?: string): Record<string, unknown>[] | null {
  if (pickPath) {
    let cur: unknown = root;
    for (const key of pickPath.split(".")) {
      if (cur === null || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[key];
      if (cur === undefined) return null;
    }
    return Array.isArray(cur) ? (cur as Record<string, unknown>[]) : null;
  }
  const arrays: Record<string, unknown>[][] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.length >= 3 && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
        arrays.push(v as Record<string, unknown>[]);
      }
      return;
    }
    for (const child of Object.values(v as Record<string, unknown>)) walk(child, depth + 1);
  };
  walk(root, 0);
  if (arrays.length === 0) return null;
  // 自动识别只在本条响应里挑"最长的那个数组";跨响应的取舍由 urlPattern 决定,不靠猜。
  return arrays.sort((a, b) => b.length - a.length)[0]!;
}

export class BrowserPageConnector implements Connector {
  /** 测试可以注入替身浏览器;默认走本机已装的 Chrome / Edge。 */
  constructor(private readonly launch: BrowserLauncher = launchInstalledBrowser) {}

  readonly metadata: ConnectorMetadata = {
    id: BROWSER_PAGE_CONNECTOR_ID,
    name: "浏览器页面采集",
    platform: "other",
    connectorType: "browser",
    sourceType: "playwright",
    version: "1.0.0",
    capabilities: ["hotlist"],
    defaultTimezone: "Asia/Shanghai",
    description:
      "用本机已装的 Chrome / Edge 打开网页版热榜,读页面渲染出来的内容。" +
      "不伪造接口签名、不绕过验证码、不做指纹伪装;需要登录的平台由你在那个窗口里登录一次。",
    isDemo: false,
  };

  readonly configSchema = BrowserPageConfigSchema;

  /** 页面结构会变,条目字段只要求有 title —— 其余留空,不编 0。 */
  readonly itemSchema = z.object({ title: z.string().min(1) }).passthrough();

  readonly defaultPolicy: ConnectorPolicy = {
    // 一次打开就是一整屏,没有"翻页重试"的意义;并发 1、最小间隔 1 分钟,尽量像人而不是像爬虫
    rateLimit: { concurrency: 1, minIntervalMs: 60_000 },
    retry: { maxRetries: 0, baseDelayMs: 1000, maxDelayMs: 1000 },
    breaker: { failureThreshold: 3, cooldownMs: 15 * 60_000 },
  };

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    return validateWithSchema(BrowserPageConfigSchema, config);
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return {
      healthy: false,
      detail: "浏览器采集要真实打开页面,不在健康检查里启动浏览器;请在「采集中心」建任务并运行一次来验证",
    };
  }

  async collectPage(_req: RemotePageRequest, rawConfig: unknown, ctx: ConnectorRunContext): Promise<PageResult<unknown>> {
    const parsed = BrowserPageConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw new ConnectorError("INVALID_CONFIG", "浏览器采集配置不合法");

    const cfg = parsed.data;
    ctx.logger.event("PAGE_REQUESTED", `打开 ${cfg.url}`);
    const browser = await this.launch(cfg.headless);

    try {
      const page = browser.pages()[0] ?? (await browser.newPage());
      /**
       * network 模式:先挂监听再导航,否则会漏掉首屏那条请求。
       * 只留 URL 命中 urlPattern 的 JSON 响应,单条超过 8MB 直接丢 ——
       * 热榜接口不可能那么大,超了说明匹配太宽,宁可少读也别把内存吃掉。
       * 注意:响应体里常有 authentication_token 这类字段,我们**只按 fields 白名单取值**,
       * 整包既不入库也不落日志。
       */
      const captured: { url: string; json: unknown }[] = [];
      if (cfg.mode === "network") {
        page.on("response", (res) => {
          void (async () => {
            try {
              const u = res.url();
              if (cfg.urlPattern && !u.includes(cfg.urlPattern)) return;
              const ct = String(res.headers()?.["content-type"] ?? "");
              if (!ct.includes("json")) return;
              const text = await res.text();
              if (!text || text.length > 8_000_000) return;
              captured.push({ url: u, json: JSON.parse(text) });
            } catch {
              /* 读不到或不是 JSON 的响应直接放过 */
            }
          })();
        });
      }

      await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: cfg.waitMs });
      if (cfg.mode === "dom") {
        await page
          .waitForSelector(cfg.waitSelector ?? cfg.itemSelector, { timeout: cfg.waitMs })
          .catch(() => undefined);
      }
      await page.waitForTimeout(cfg.settleMs);

      const finalUrl = page.url();
      if (cfg.loginUrlPrefixes.some((p) => finalUrl.startsWith(p))) {
        throw new ConnectorError(
          "AUTH_ERROR",
          `页面跳到了登录页(${finalUrl.slice(0, 120)})。` +
            "请在弹出的浏览器窗口里用自己的账号登录一次(登录态保存在本机 data/browser-profile,不入库、不出本机),然后再运行这个任务。",
        );
      }
      for (const sel of cfg.blockedSelectors) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) {
          throw new ConnectorError(
            "AUTH_ERROR",
            `页面出现"需要登录 / 安全验证"的提示(选择器 ${sel})。本产品不会绕过验证,请你自己在那个窗口里完成一次登录。`,
          );
        }
      }

      if (cfg.mode === "network") {
        const items: Record<string, unknown>[] = [];
        const deadline = Date.now() + cfg.waitMs;
        let picked: { url: string; rows: Record<string, unknown>[] } | null = null;
        while (!picked && Date.now() < deadline) {
          for (const c of captured) {
            const rows = locateArray(c.json, cfg.pickPath);
            if (rows && rows.length > 0) {
              picked = { url: c.url, rows };
              break;
            }
          }
          if (!picked) await page.waitForTimeout(500);
        }
        if (!picked) {
          const urls = captured.map((c) => c.url.slice(0, 90));
          throw new ConnectorError(
            "SCHEMA_DRIFT",
            `页面打开了,但没能从它自己收到的响应里定位出热榜数组。` +
              (cfg.urlPattern ? `URL 含「${cfg.urlPattern}」的 JSON 响应 ${captured.length} 条` : `未设 urlPattern,候选 JSON 响应 ${captured.length} 条`) +
              `;pickPath=${cfg.pickPath ?? "(自动)"}.` +
              (urls.length ? ` 看到的地址:${urls.slice(0, 3).join(" | ")}` : " 一条都没抓到(可能要等更久或页面结构已变)。") +
              " 请用「试采一次」核对,不要靠猜。",
          );
        }
        for (const row of picked.rows.slice(0, cfg.maxItems)) {
          const mapped: Record<string, unknown> = { ...cfg.constants };
          for (const [target, spec] of Object.entries(cfg.fields)) {
            const v = pickValue(row, spec);
            if (v !== undefined && v !== null && v !== "") mapped[target] = v;
          }
          if (typeof mapped.title === "string" && mapped.title.length > 0) items.push(mapped);
        }
        if (items.length === 0) {
          throw new ConnectorError(
            "SCHEMA_DRIFT",
            `找到了 ${picked.rows.length} 条数组元素,但按 fields 映射后一条像样的都没有 ——` +
              ` 说明 title 对应的源字段名不对(当前来自 ${picked.url.slice(0, 70)})。用「试采一次」核对字段名。`,
          );
        }
        ctx.logger.event("PAGE_FETCHED", `从页面自身的请求里取到 ${items.length} 条`);
        return { items, hasMore: false, nextCursor: null };
      }

      const handles = await page.$$(cfg.itemSelector);
      const items: Record<string, unknown>[] = [];
      for (const h of handles.slice(0, cfg.maxItems)) {
        const row: Record<string, unknown> = { ...cfg.constants };
        for (const [target, spec] of Object.entries(cfg.fields)) {
          const { selector, attr } = parseFieldSpec(spec);
          // "." 表示条目自身;否则在条目内再找一层
          const sub = selector === "." ? h : await h.$(selector).catch(() => null);
          if (!sub) continue;
          const value = attr
            ? await sub.getAttribute(attr).catch(() => null)
            : await sub.innerText().catch(() => null);
          const text = (value ?? "").replace(/\s+/g, " ").trim();
          if (text) row[target] = text;
        }
        if (typeof row.title === "string" && row.title.length > 0) {
          // 相对链接补成绝对链接,否则用户点不开
          if (typeof row.url === "string" && row.url.startsWith("/")) {
            row.url = new URL(row.url, cfg.url).toString();
          }
          items.push(row);
        }
      }

      if (items.length === 0) {
        throw new ConnectorError(
          "SCHEMA_DRIFT",
          `页面打开了,但按选择器 ${cfg.itemSelector} 一条都没取到 —— 平台可能改了页面结构,或这一屏还没渲染出来。` +
            "请把这条渠道的 itemSelector 重新核对一遍(不猜测、不静默返回空)。",
        );
      }
      ctx.logger.event("PAGE_FETCHED", `取到 ${items.length} 条`);
      return { items, hasMore: false, nextCursor: null };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
