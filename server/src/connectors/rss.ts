/**
 * RssConnector —— RSS 2.0 / Atom 订阅源连接器(零凭证渠道)。
 *
 * 为什么需要它:通用 HTTP 连接器只解析 JSON,而大量站点(少数派、36氪、知乎日报、
 * 自建 RSSHub 路由等)对外提供的就是 RSS/Atom。实测 `https://sspai.com/feed` 返回
 * 200 + 10 条 XML,但走通用连接器只能报"响应不是数组"。
 *
 * 刻意的边界:
 *  - 不引入新的第三方依赖(项目现在没有 XML 解析器),用**受限的行内解析**只取所需字段;
 *    解析不出条目就如实报错,不猜结构。
 *  - 只读 GET、只允许 http/https、单次 Run 有页数硬上限;链接源、限速、重试、熔断、
 *    断点续采全部复用现有采集运行时。
 *  - 输出的键就是规范字段名(JSONAdapter 对已是规范键的对象无需 mapping),
 *    缺失指标一律留空,不填 0。
 */
import { z } from "zod";
import { PlatformSchema } from "../domain/constants";
import { ConnectorError, type PageResult, type RemotePageRequest } from "../domain/collection";
import { HttpConnectorBase } from "./httpConnectorBase";
import type { ConnectorMetadata, ConnectorPolicy } from "./types";

export const RSS_CONNECTOR_ID = "rss";

const MAX_BYTES = 6 * 1024 * 1024;

function unwrap(text: string): string {
  const t = text.trim();
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  return (m ? m[1] : t)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();
}

/** 取标签内容:优先带属性的闭合标签(如 `<link href="x"/>` 的 href),再取文本标签。 */
function tag(block: string, name: string): string | null {
  const selfClosing = new RegExp(`<${name}\\b[^>]*?href\\s*=\\s*"([^"]+)"`, "i").exec(block);
  if (selfClosing) return selfClosing[1].trim();
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? unwrap(m[1]) : null;
}

export const RssConfigSchema = z
  .object({
    url: z.string().regex(/^https?:\/\/\S+$/i, "只支持 http/https 地址"),
    /**
     * 该源内容归属的平台代码(仅用于归类展示,不猜测中文名)。
     * 必须是已知平台代码:写错会让整批内容在入库时逐行失败,而运行记录仍显示
     * "已抓取 N 条" —— 界面看起来像成功,实际一条都没进来(实测踩过:新增平台枚举时漏了这层)。
     */
    platform: PlatformSchema.default("other"),
    /** 一次 Run 最多取几页,每页最多多少条 —— 硬上限 */
    maxPages: z.number().int().min(1).max(10).default(2),
    pageSize: z.number().int().min(1).max(100).default(30),
    /** 部分源在 query 上翻页 */
    pageParam: z.string().min(1).max(40).optional(),
    pageStart: z.number().int().min(0).max(10000).default(1),
  })
  .strict();

export type RssConfig = z.infer<typeof RssConfigSchema>;

export interface RssItem {
  platformContentId: string;
  title: string;
  url: string | null;
  text: string | null;
  authorName: string | null;
  publishedAt: string | null;
}

/** 纯函数,便于单测:XML 文本 → 规范键条目。RSS 的 item 与 Atom 的 entry 同等处理。 */
export function parseFeed(xml: string, limit: number): RssItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)];
  const items: RssItem[] = [];
  for (const b of blocks.slice(0, limit)) {
    const block = b[2];
    const title = tag(block, "title");
    const link = tag(block, "link") ?? tag(block, "id");
    if (!title && !link) continue; // 无题无链的条目不入库(不编造标题)
    const published = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "date");
    let iso: string | null = null;
    if (published) {
      const t = Date.parse(published);
      if (!Number.isNaN(t)) iso = new Date(t).toISOString();
    }
    items.push({
      platformContentId: link ?? title ?? "",
      title: title ?? "(无标题)",
      url: link,
      text: tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content"),
      authorName: tag(block, "name") ?? tag(block, "author"),
      publishedAt: iso,
    });
  }
  return items;
}

export class RssConnector extends HttpConnectorBase {
  readonly metadata: ConnectorMetadata = {
    id: RSS_CONNECTOR_ID,
    name: "RSS / Atom 订阅源",
    platform: "other",
    connectorType: "api",
    sourceType: "json", // 解析后已是规范键对象,复用 JSON 行的同一套入库路径
    version: "1.0.0",
    capabilities: ["hotlist"],
    defaultTimezone: "UTC",
    description:
      "读取 RSS 2.0 / Atom 订阅源(零凭证):少数派、36氪、知乎日报、自建 RSSHub 路由等。只取标题/链接/时间/作者,缺失留空不填 0。",
    isDemo: false,
  };

  readonly configSchema = RssConfigSchema;

  readonly itemSchema = z.object({}).passthrough();

  readonly defaultPolicy: ConnectorPolicy = {
    rateLimit: { rps: 1, concurrency: 1 },
    retry: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 },
    breaker: { failureThreshold: 4, cooldownMs: 120_000 },
  };

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: false, detail: "订阅源地址由采集任务提供,请在「采集中心」建任务并运行一次来验证" };
  }

  async collectPage(
    req: RemotePageRequest,
    config: unknown,
    _ctx: { runId: number; taskId: number; signal: AbortSignal },
  ): Promise<PageResult<unknown>> {
    const cfg = RssConfigSchema.parse(config ?? {});
    const state = (() => {
      if (!req.cursor) return { page: 0 };
      try {
        const v = JSON.parse(req.cursor) as { page?: number };
        return { page: typeof v.page === "number" ? v.page : 0 };
      } catch {
        return { page: 0 };
      }
    })();
    if (state.page >= cfg.maxPages) return { items: [], hasMore: false, nextCursor: null };

    const url = new URL(cfg.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConnectorError("INVALID_CONFIG", "只支持 http/https 地址");
    }
    if (state.page > 0 && cfg.pageParam) {
      url.searchParams.set(cfg.pageParam, String(cfg.pageStart + state.page));
    }

    let xml: string;
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { "user-agent": "trendscope-local/1.0", accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
        signal: req.signal ?? AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const code = res.status === 401 || res.status === 403 ? "AUTH_ERROR" : res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "REMOTE_5XX" : "INVALID_RESPONSE";
        throw new ConnectorError(code, `订阅源返回 HTTP ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        throw new ConnectorError("INVALID_RESPONSE", `订阅源响应过大:${buf.byteLength} 字节,上限 ${MAX_BYTES}`);
      }
      xml = new TextDecoder("utf-8").decode(buf);
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ConnectorError(/timeout|abort/i.test(msg) ? "TIMEOUT" : "NETWORK_ERROR", `读取订阅源失败:${msg.slice(0, 120)}`);
    }

    const items = parseFeed(xml, cfg.pageSize);
    if (items.length === 0) {
      throw new ConnectorError("INVALID_RESPONSE", "订阅源里没解析出任何 <item>/<entry> —— 地址可能不是 RSS/Atom,或结构不标准");
    }
    const nextPage = state.page + 1;
    const hasMore = nextPage < cfg.maxPages && items.length >= Math.min(cfg.pageSize, 25);
    return {
      items: items as unknown as Record<string, unknown>[],
      hasMore,
      nextCursor: hasMore ? JSON.stringify({ page: nextPage }) : null,
    };
  }
}
