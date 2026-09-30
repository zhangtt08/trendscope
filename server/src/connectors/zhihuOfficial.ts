/**
 * ZhihuOfficialConnector (Stage 5) — the first REAL external-platform connector.
 *
 * 依据:docs/connectors/ZHIHU_API_RESEARCH.md(官方文档核对于 2026-09-24,
 * 来源 developer.zhihu.com/docs 与官方 CDN zhihu-cli skill 包 references/http-api.md)。
 *
 * 端点(全部官方公开能力,§0 禁止任何绕过/逆向/抓取):
 *   GET https://developer.zhihu.com/api/v1/content/zhihu_search   (search)
 *   GET https://developer.zhihu.com/api/v1/content/hot_list       (hotlist)
 *   GET https://developer.zhihu.com/api/v1/quota                  (health,不耗业务额度)
 *
 * 鉴权(动态注入,§12):
 *   Authorization: Bearer <Access Secret>      ← SecretResolver 从 secretref 解析
 *   X-Request-Timestamp: <秒级 Unix 时间戳>     ← 可注入 Clock(§13)
 * Secret 永不进入 Task config 值 / RawRecord / 事件 / 日志(仅引用)。
 *
 * 复用 Stage 4:HttpConnectorBase(timeout/abort/size-limit/error mapping)、
 * RateLimiter、RetryPolicy、CircuitBreaker、CollectionRunner —— 绝不裸 fetch(§11)。
 * Replay Transport(§36)可注入,生产不传 → 真实 HTTP。
 */
import { z } from "zod";
import { ConnectorError, type PageResult, type RemotePageRequest } from "../domain/collection";
import type { HttpTransport } from "./httpClient";
import { extractProviderCode } from "./httpClient";
import { HttpConnectorBase } from "./httpConnectorBase";
import type {
  ConnectorMetadata,
  ConnectorPolicy,
  ConnectorRunContext,
} from "./types";
import { SECRET_REF_PATTERN } from "./types";
import { resolveSecretRef, describeSecretSource } from "../services/secrets/secretResolver";
import { zodIssueLines, zodIssueLine } from "../domain/zodMessage";

const ZHIHU_API_BASE = "https://developer.zhihu.com/api/v1";

/* ------------------------------------------------------------------ */
/* Config: Search 与 Hotlist 分离(§10),不搞 if-undefined 兜底          */
/* ------------------------------------------------------------------ */

export const ZhihuSearchConfigSchema = z
  .object({
    mode: z.literal("search"),
    query: z.string().min(1).max(100),
    /** 官方:默认 10,最大 10(>10 服务端截断)—— 如实收窄 */
    count: z.number().int().min(1).max(10).optional(),
    /** Secret 引用(默认约定环境变量名);仅为 secretref: 引用,永不接受明文 */
    secretRef: z.string().regex(SECRET_REF_PATTERN).optional(),
  })
  .passthrough();

export const ZhihuHotListConfigSchema = z
  .object({
    mode: z.literal("hotlist"),
    /** 官方:默认 30,最大 30 */
    limit: z.number().int().min(1).max(30).optional(),
    secretRef: z.string().regex(SECRET_REF_PATTERN).optional(),
  })
  .passthrough();

export const ZhihuConfigSchema = z.discriminatedUnion("mode", [
  ZhihuSearchConfigSchema,
  ZhihuHotListConfigSchema,
]);

export type ZhihuConfig = z.infer<typeof ZhihuConfigSchema>;

export const DEFAULT_ZHIHU_SECRET_REF = "secretref:env:ZHIHU_ACCESS_SECRET";

/* ------------------------------------------------------------------ */
/* Response schemas(§14):核心字段严格,额外字段放行(不用 strict)      */
/* ------------------------------------------------------------------ */

/** 官方错误码(0 成功 / 10001 参数 / 20001 鉴权 / 30001 频率 / 90001 内部) */
const ZHIHU_ERROR_CODES = [0, 10001, 20001, 30001, 90001] as const;

const EnvelopeSchema = z.object({
  Code: z.number(),
  Message: z.string().optional(),
  Data: z.unknown().optional(),
});

const SearchItemSchema = z.object({
  Title: z.string(),
  ContentType: z.string(),
  ContentID: z.string(),
  ContentText: z.string(),
  Url: z.string(),
  CommentCount: z.number(),
  VoteUpCount: z.number(),
  AuthorName: z.string(),
  EditTime: z.number(),
});

const ZhihuSearchResponseSchema = EnvelopeSchema.extend({
  Data: z
    .object({
      HasMore: z.boolean(),
      SearchHashId: z.string().optional(),
      Items: z.array(SearchItemSchema.passthrough()),
      EmptyReason: z.string().optional(),
    })
    .passthrough(),
});

const HotListItemSchema = z.object({
  Title: z.string(),
  Url: z.string(),
  ThumbnailUrl: z.string(),
  Summary: z.string(),
});

const ZhihuHotListResponseSchema = EnvelopeSchema.extend({
  Data: z
    .object({
      Total: z.number(),
      Items: z.array(HotListItemSchema.passthrough()),
    })
    .passthrough(),
});

const QuotaResponseSchema = EnvelopeSchema.extend({
  Data: z
    .array(
      z.object({
        APIID: z.string(),
        APIName: z.string().optional(),
        TotalQuota: z.number().optional(),
        TotalUsed: z.number().optional(),
        RemainingQuota: z.number().optional(),
      }),
    )
    .optional(),
});

/* ------------------------------------------------------------------ */
/* 知乎 Code → ConnectorError 映射(§33)                                */
/* ------------------------------------------------------------------ */

export function mapZhihuCode(code: number, message: string): ConnectorError {
  switch (code) {
    case 0:
      throw new ConnectorError("INVALID_RESPONSE", "mapZhihuCode called with success code 0");
    case 10001:
      return new ConnectorError("INVALID_RESPONSE", `知乎参数错误: ${message}`, { providerErrorCode: code });
    case 20001:
      return new ConnectorError("AUTH_ERROR", `知乎鉴权失败: ${message}`, { providerErrorCode: code });
    case 30001:
      return new ConnectorError("RATE_LIMITED", `知乎频率/额度限制: ${message}`, { providerErrorCode: code });
    case 90001:
      return new ConnectorError("REMOTE_5XX", `知乎内部错误: ${message}`, { providerErrorCode: code });
    default:
      return new ConnectorError("INVALID_RESPONSE", `知乎未知错误码 ${code}: ${message}`, {
        providerErrorCode: code,
      });
  }
}
void ZHIHU_ERROR_CODES;

/* ------------------------------------------------------------------ */
/* Connector                                                            */
/* ------------------------------------------------------------------ */

export class ZhihuOfficialConnector extends HttpConnectorBase {
  private readonly clock: () => number;
  private readonly defaultSecretRef: string;

  readonly metadata: ConnectorMetadata = {
    id: "zhihu-official",
    name: "知乎官方接口",
    platform: "zhihu",
    connectorType: "api",
    sourceType: "api",
    version: "1.0.0",
    capabilities: ["search", "hotlist"], // 只声明真正完成的 capability(§5)
    defaultTimezone: "Asia/Shanghai",
    description:
      "知乎数据开放平台官方 API(zhihu_search / hot_list)。需要 Access Secret(env ZHIHU_ACCESS_SECRET),不抓网页、不逆向接口。",
    isDemo: false,
  };

  readonly configSchema = ZhihuConfigSchema;

  /** 核心 item 字段 —— 用于 §21 Schema Drift 检测(核心缺失=漂移) */
  readonly itemSchema = z.union([
    // search item 核心:身份 + 指标字段存在
    z.object({
      ContentID: z.string(),
      Title: z.string(),
      ContentType: z.string(),
      VoteUpCount: z.number(),
      CommentCount: z.number(),
    }),
    // hotlist item 核心:标题 + 链接(官方就是这四字段)
    z.object({
      Title: z.string(),
      Url: z.string(),
    }),
  ]);

  readonly defaultPolicy: ConnectorPolicy = {
    // 官方未公布每秒频率上限(§32 不虚构);热榜日额度仅 100 次 → 保守 1 req/s、串行
    rateLimit: { rps: 1, concurrency: 1 },
    // 429(30001)允许一次退避重试;5xx(90001)同;鉴权/参数绝不重试
    retry: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 },
    breaker: { failureThreshold: 5, cooldownMs: 60_000 },
  };

  constructor(opts: { transport?: HttpTransport; clock?: () => number; secretRef?: string } = {}) {
    super({ timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 }, opts.transport);
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
    this.defaultSecretRef = opts.secretRef ?? DEFAULT_ZHIHU_SECRET_REF;
  }

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    const r = ZhihuConfigSchema.safeParse(config);
    if (!r.success) {
      return {
        ok: false,
        error: zodIssueLines(r.error),
      };
    }
    // secretRef 字段若出现,必须是合法引用(明文在此处就会被拒)
    const ref = (r.data as { secretRef?: string }).secretRef;
    if (ref !== undefined && !SECRET_REF_PATTERN.test(ref)) {
      return { ok: false, error: "secretRef: 必须是 secretref:<source>:<name> 引用,禁止明文" };
    }
    return { ok: true };
  }

  /** Secret 生命周期状态(§7/§41):缺失/格式错误 ≠ Unavailable */
  checkCredential(config?: unknown): {
    state: "configured" | "missing" | "invalid";
    source: string;
    detail: string;
  } {
    const ref = this.secretRefOf(config);
    const source = describeSecretSource(ref);
    const res = resolveSecretRef(ref);
    if (res.ok) return { state: "configured", source, detail: "凭证已配置(来源不展示值)" };
    if (res.reason === "env_not_set") {
      return { state: "missing", source, detail: `凭证未配置 —— ${res.detail}` };
    }
    return { state: "invalid", source, detail: res.detail };
  }

  /**
   * 真实 healthCheck(§7):查询统一额度(官方声明该查询不消耗业务额度),
   * 区分 Healthy / 鉴权失败 / 频率限制 / 网络故障 —— 不只返回 true/false。
   */
  async healthCheck(ctx: { signal?: AbortSignal }): Promise<{ healthy: boolean; detail?: string }> {
    const probe = this.checkCredential();
    if (probe.state !== "configured") {
      return { healthy: false, detail: `${probe.detail}(来源:${probe.source})` };
    }
    try {
      const body = await this.authorizedJson(
        `${ZHIHU_API_BASE}/quota?APIIDs=zhihu_search,hot_list`,
        this.secretRefOf(),
        ctx.signal,
      );
      // 先判 Code(错误响应可能没有 Data 字段,不能让 schema 校验先误报 drift)
      const envelope = EnvelopeSchema.safeParse(body);
      if (envelope.success && envelope.data.Code !== 0) {
        const err = mapZhihuCode(envelope.data.Code, envelope.data.Message ?? "");
        return { healthy: false, detail: `${err.code}: ${err.message}` };
      }
      const parsed = QuotaResponseSchema.safeParse(body);
      if (!parsed.success) {
        return { healthy: false, detail: `额度查询响应不符合官方数据结构: ${zodIssueLines(parsed.error, 1)}` };
      }
      const quotas = parsed.data.Data ?? [];
      const brief = quotas
        .filter((q) => q.APIID === "zhihu_search" || q.APIID === "hot_list")
        .map((q) => `${q.APIID} 剩余 ${q.RemainingQuota ?? "?"}/${q.TotalQuota ?? "?"}`)
        .join("; ");
      return { healthy: true, detail: `官方 API 可达(${brief || "quota 为空"})` };
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError("UNKNOWN", String(e));
      return { healthy: false, detail: `${err.code}: ${err.message}` };
    }
  }

  async collectPage(
    req: RemotePageRequest,
    rawConfig: unknown,
    ctx: ConnectorRunContext,
  ): Promise<PageResult<unknown>> {
    const parsed = ZhihuConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ConnectorError("INVALID_CONFIG", `知乎任务配置不合法: ${zodIssueLines(parsed.error)}`);
    }
    const cfg = parsed.data;

    // 官方两个内容接口均为单页返回(HasMore 恒 false)——第二次翻页请求无意义
    if (req.cursor) {
      throw new ConnectorError("INVALID_RESPONSE", "知乎接口为单页返回,不应出现分页游标");
    }

    let url: string;
    let discovery: { type: "search" | "hotlist"; query?: string | null; ranks: (number | null)[]; metadata: unknown };
    if (cfg.mode === "search") {
      const params = new URLSearchParams();
      params.set("Query", cfg.query);
      if (cfg.count !== undefined) params.set("Count", String(cfg.count));
      url = `${ZHIHU_API_BASE}/content/zhihu_search?${params.toString()}`;
      discovery = { type: "search", query: cfg.query, ranks: [], metadata: null };
    } else {
      const params = new URLSearchParams();
      if (cfg.limit !== undefined) params.set("Limit", String(cfg.limit));
      url = `${ZHIHU_API_BASE}/content/hot_list?${params.toString()}`;
      discovery = { type: "hotlist", query: null, ranks: [], metadata: null };
    }

    const body = await this.authorizedJson(url, this.secretRefOf(cfg), ctx.signal);

    // 先判官方错误码(错误响应没有 Data 字段;不能让严格 schema 校验误报 drift)
    const envelope = EnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new ConnectorError("SCHEMA_DRIFT", "zhihu 响应外层结构(Code/Message/Data)不符合官方 schema", {
        providerErrorCode: extractProviderCode(body),
      });
    }
    if (envelope.data.Code !== 0) {
      throw mapZhihuCode(envelope.data.Code, envelope.data.Message ?? "");
    }

    if (cfg.mode === "search") {
      const check = ZhihuSearchResponseSchema.safeParse(body);
      if (!check.success) {
        throw new ConnectorError("SCHEMA_DRIFT", "知乎搜索响应核心字段缺失或结构变化", {
          providerErrorCode: extractProviderCode(body),
          validationErrors: check.error.issues.slice(0, 5).map(zodIssueLine),
        });
      }
      const data = check.data.Data;
      discovery.ranks = data.Items.map((_, i) => i + 1);
      discovery.metadata = { searchHashId: data.SearchHashId ?? null, emptyReason: data.EmptyReason ?? null };
      return {
        items: data.Items as unknown as Record<string, unknown>[],
        // 官方语义:当前实现固定 false —— 如实透传,不虚构翻页
        hasMore: data.HasMore,
        nextCursor: null,
        rawPaginationState: { endpoint: "zhihu_search", searchHashId: data.SearchHashId ?? null },
        discovery,
      };
    }

    const check = ZhihuHotListResponseSchema.safeParse(body);
    if (!check.success) {
      throw new ConnectorError("SCHEMA_DRIFT", "知乎热榜响应核心字段缺失或结构变化", {
        providerErrorCode: extractProviderCode(body),
        validationErrors: check.error.issues.slice(0, 5).map(zodIssueLine),
      });
    }
    const data = check.data.Data;
    // 官方按榜单顺序返回 Items → rank = 下标 + 1(确定性,记录在 Observation)
    discovery.ranks = data.Items.map((_, i) => i + 1);
    discovery.metadata = { total: data.Total };
    return {
      items: data.Items as unknown as Record<string, unknown>[],
      hasMore: false,
      nextCursor: null,
      rawPaginationState: { endpoint: "hot_list", total: data.Total },
      discovery,
    };
  }

  /* ---------------- internals ---------------- */

  private secretRefOf(cfg?: unknown): string {
    const ref = cfg && typeof cfg === "object" ? (cfg as { secretRef?: string }).secretRef : undefined;
    return ref ?? this.defaultSecretRef;
  }

  /** 动态注入鉴权头(§12);Secret 只在此函数栈内存在,绝不写入任何持久层。 */
  private async authorizedJson(url: string, secretRef: string, signal?: AbortSignal): Promise<unknown> {
    const resolved = resolveSecretRef(secretRef);
    if (!resolved.ok) {
      // 凭证缺失是配置问题(INVALID_CONFIG),不是远程故障
      throw new ConnectorError("INVALID_CONFIG", `credential unavailable: ${resolved.detail}`);
    }
    const res = await this.http.fetchJson<unknown>(url, {
      headers: {
        Authorization: `Bearer ${resolved.value}`,
        "X-Request-Timestamp": String(this.clock()),
        "Content-Type": "application/json",
      },
      signal,
    });
    return res.body;
  }
}
