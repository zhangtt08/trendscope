/**
 * GenericHttpConnector —— 配置驱动的 JSON-over-HTTP 数据源(多平台接入入口)。
 *
 * 目标:任何平台只要提供**你有权访问**的 HTTP JSON 接口,就能靠任务配置接进来,
 * 不必再为每个平台写一遍连接器。字段映射复用导入侧的同一套 mapping
 * (运行时会从 config.mapping 取);鉴权只接受密钥引用 `secretref:env:NAME`,
 * 明文密钥在建任务时就被拒。
 *
 * 边界(刻意的):只支持 GET;只允许 http/https;页数与每页条数有硬上限。
 * 这是"接入合法数据源",不是无节制抓取工具。
 */
import { z } from "zod";
import { PlatformSchema } from "../domain/constants";
import { ConnectorError, type PageResult, type RemotePageRequest } from "../domain/collection";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import { HttpConnectorBase } from "./httpConnectorBase";
import { SECRET_REF_PATTERN } from "./types";
import type { ConnectorMetadata, ConnectorPolicy, ConnectorRunContext } from "./types";

export const GENERIC_HTTP_CONNECTOR_ID = "generic-http";

const SECRET_REF_HINT = "必须以 secretref:env:<变量名> 引用,禁止写明文密钥";

const QueryValue = z.union([z.string().min(1).max(200), z.number().int().min(-1e12).max(1e12)]);

export const GenericHttpConfigSchema = z
  .object({
    url: z.string().regex(/^https?:\/\/[^\s]+$/i, "只支持 http/https 地址"),
    /** 响应里条目数组的位置,点路径,如 data.items;留空表示响应本身就是数组 */
    itemsPath: z.string().min(1).max(120).optional(),
    /** 固定查询参数(翻页参数由 pagination 自动追加) */
    query: z.record(QueryValue).optional(),
    /** 固定请求头;值可以是 secretref:env:NAME(会解析),禁止明文密钥 */
    headers: z.record(z.string().min(0).max(300)).optional(),
    pagination: z
      .object({
        kind: z.enum(["none", "page", "cursor"]).default("none"),
        pageParam: z.string().min(1).max(40).default("page"),
        pageSizeParam: z.string().min(1).max(40).optional(),
        startPage: z.number().int().min(0).max(100000).default(1),
        cursorParam: z.string().min(1).max(40).default("cursor"),
        /** 首次请求使用的游标值(留空表示不传) */
        cursorStart: z.string().max(200).optional(),
        /** 响应里下一页游标的位置 */
        cursorPath: z.string().min(1).max(120).optional(),
        /** 响应里"还有更多"的布尔位置(留空则按本页是否取满推断) */
        hasMorePath: z.string().min(1).max(120).optional(),
      })
      .strict()
      .default({ kind: "none", pageParam: "page", startPage: 1, cursorParam: "cursor" }),
    /** 每页请求条数(也用于"本页取满即可能还有"的推断) */
    pageSize: z.number().int().min(1).max(100).default(20),
    /** 单次 Run 最多取几页 —— 硬上限防失控 */
    maxPages: z.number().int().min(1).max(20).default(3),
    /** 与导入侧一致:目标字段 ← 源字段 */
    mapping: z.record(z.string().min(1).max(80)).optional(),
    /** 该源内容归属的平台代码(只用于归类展示,不做猜测) */
    /**
     * 该源内容归属的平台代码(仅用于归类展示,不猜测中文名)。
     * 必须是已知平台代码:写错会让整批内容在入库时逐行失败,而运行记录仍显示
     * "已抓取 N 条" —— 界面看起来像成功,实际一条都没进来(实测踩过:新增平台枚举时漏了这层)。
     */
    platform: PlatformSchema.default("other"),
    /** 整体鉴权引用:作为 Authorization 头(headers 里已自行给出 Authorization 时不覆盖) */
    secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_HINT).optional(),
  })
  .strict();

export type GenericHttpConfig = z.infer<typeof GenericHttpConfigSchema>;

/** 点路径取值:只走对象键。取不到就是取不到 —— 让源结构变化显式报错,不静默兜半个值。 */
function pickPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * 为嵌套字段补一组点号别名:真实接口常把指标放在 stat/owner 这类子对象里,
 * 而导入侧的 mapping 只按扁平键取值。这里只"加别名",原始键一个不动,
 * 所以既能让 mapping 写 stat.view,也不影响已有源的字段。
 */
function flattenDotted(item: unknown): Record<string, unknown> {
  if (item === null || typeof item !== "object") return {};
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if (v2 === null || typeof v2 === "object") continue;
      const alias = `${k}.${k2}`;
      if (out[alias] === undefined) out[alias] = v2;
    }
  }
  return out;
}

interface PageState {
  page: number;
  cursor?: string;
}

export class GenericHttpConnector extends HttpConnectorBase {
  readonly metadata: ConnectorMetadata = {
    id: GENERIC_HTTP_CONNECTOR_ID,
    name: "通用 HTTP 数据源(可配置)",
    platform: "other",
    connectorType: "api",
    sourceType: "json",
    version: "1.0.0",
    capabilities: ["search"],
    defaultTimezone: "UTC",
    description:
      "配置驱动的 JSON-over-HTTP 接入(仅 GET、仅 http/https、页数有上限)。字段映射与导入侧共用同一套 mapping;鉴权只接受密钥引用,不接受明文。",
    isDemo: false,
  };

  readonly configSchema = GenericHttpConfigSchema;

  /** 条目只要求是对象;具体字段交给 mapping,宽松 schema 供 SCHEMA_DRIFT 观测 */
  readonly itemSchema = z.object({}).passthrough();

  readonly defaultPolicy: ConnectorPolicy = {
    rateLimit: { rps: 2, concurrency: 1 },
    retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4_000 },
    breaker: { failureThreshold: 5, cooldownMs: 60_000 },
  };

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    const parsed = GenericHttpConfigSchema.safeParse(config ?? {});
    if (parsed.success) return { ok: true };
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? `${first.path.join(".")}: ${first.message}` : "配置无效" };
  }

  /**
   * 通用连接器没有"探活地址"这种东西(地址就是任务配置里的 url)。
   * 这里不调用外部地址,避免健康检查变成未经确认的任意请求。
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return {
      healthy: false,
      detail: "通用连接器按任务配置取数,请在「采集中心」建任务并运行一次来验证该地址",
    };
  }

  private decodeCursor(raw?: string | null): PageState {
    if (!raw) return { page: 0 };
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && "page" in v) {
        const o = v as { page?: unknown; cursor?: unknown };
        return {
          page: typeof o.page === "number" ? o.page : 0,
          cursor: typeof o.cursor === "string" ? o.cursor : undefined,
        };
      }
    } catch {
      /* 解不开就从头开始,不当失败 */
    }
    return { page: 0 };
  }

  async collectPage(
    req: RemotePageRequest,
    config: unknown,
    _ctx: ConnectorRunContext,
  ): Promise<PageResult<unknown>> {
    const cfg = GenericHttpConfigSchema.parse(config ?? {});
    const pageIndex = this.decodeCursor(req.cursor).page;
    if (pageIndex >= cfg.maxPages) return { items: [], hasMore: false, nextCursor: null };

    const url = new URL(cfg.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConnectorError("INVALID_CONFIG", "只支持 http/https 地址");
    }
    for (const [k, v] of Object.entries(cfg.query ?? {})) url.searchParams.set(k, String(v));
    const pg = cfg.pagination;
    if (pg.pageSizeParam) url.searchParams.set(pg.pageSizeParam, String(cfg.pageSize));
    if (pg.kind === "page") {
      url.searchParams.set(pg.pageParam, String(pg.startPage + pageIndex));
    } else if (pg.kind === "cursor") {
      const c = pageIndex === 0 ? pg.cursorStart : this.decodeCursor(req.cursor).cursor;
      if (c) url.searchParams.set(pg.cursorParam, c);
    }

    const headers: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      const r = this.resolveMaybeSecret(v);
      headers[k] = r.value;
      if (r.secret && r.value) secrets.push(r.value);
    }
    if (cfg.secretRef && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
      const r = this.resolveMaybeSecret(cfg.secretRef);
      headers["Authorization"] = r.value;
      if (r.secret && r.value) secrets.push(r.value);
    }

    let body: unknown;
    try {
      // fetchJson 已把非 2xx 归类成 ConnectorError(鉴权/限流/5xx/过大…);这里只做密钥脱敏
      const res = await this.http.fetchJson<unknown>(url.toString(), {
        method: "GET",
        headers,
        signal: req.signal,
        timeoutMs: 20_000,
        maxBytes: 8 * 1024 * 1024,
      });
      body = res.body;
    } catch (e) {
      if (e instanceof ConnectorError) throw new ConnectorError(e.code, this.redact(e.message, secrets));
      throw e;
    }

    const located = cfg.itemsPath ? pickPath(body, cfg.itemsPath) : body;
    if (!Array.isArray(located)) {
      throw new ConnectorError(
        "INVALID_CONFIG",
        cfg.itemsPath
          ? `itemsPath "${cfg.itemsPath}" 没指向数组 —— 本次返回 ${
              located === undefined ? "缺失该字段(源结构可能已变)" : `的是 ${typeof located}`
            }`
          : "响应本身不是数组:条目在子字段里时请配置 itemsPath(例如 data.items)",
      );
    }
    const items = located
      .filter((x) => x !== null && typeof x === "object")
      .map(flattenDotted);

    let hasMore = pg.kind !== "none" && items.length >= cfg.pageSize;
    let nextToken: string | undefined;
    if (pg.hasMorePath) hasMore = pickPath(body, pg.hasMorePath) === true;
    if (pg.kind === "cursor" && pg.cursorPath) {
      const c = pickPath(body, pg.cursorPath);
      nextToken = typeof c === "string" || typeof c === "number" ? String(c) : undefined;
      if (!nextToken) hasMore = false;
    }
    const nextPage = pageIndex + 1;
    if (nextPage >= cfg.maxPages) hasMore = false;

    return {
      items,
      hasMore,
      nextCursor: hasMore ? JSON.stringify({ page: nextPage, cursor: nextToken }) : null,
    };
  }

  /** 引用形式 → 解析成真实值(标记为密钥);普通字符串(User-Agent 等)原样使用 */
  private resolveMaybeSecret(value: string): { value: string; secret: boolean } {
    if (!value.startsWith("secretref:")) return { value, secret: false };
    const res = resolveSecretRef(value);
    if (!res.ok) {
      // 凭证缺失是配置问题,不是远程故障 —— 与知乎连接器同一口径
      throw new ConnectorError("INVALID_CONFIG", `密钥不可用:${res.detail}`);
    }
    return { value: res.value, secret: true };
  }

  private redact(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
    return out;
  }
}
