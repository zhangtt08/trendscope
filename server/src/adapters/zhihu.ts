/**
 * ZhihuSourceAdapter (Stage 5 §16-23) — 知乎 Raw Item → TrendScope
 * NormalizedRecord。纯标准化,零网络请求,零 Zhihu 之外的知识。
 *
 * 依据 docs/connectors/ZHIHU_API_RESEARCH.md(官方字段表,2026-09-24 核对):
 *   search item : Title/ContentType/ContentID/ContentText/Url/CommentCount/
 *                 VoteUpCount/AuthorName/EditTime/AuthorityLevel/RankingScore…
 *   hotlist item: Title/Url/ThumbnailUrl/Summary(无 metrics/author/时间)
 *
 * 铁律:
 *   - VoteUpCount → upvotes(§23 语义正确,不硬塞 likes);
 *   - 官方没给的指标(views/shares/favorites)→ null,绝不 0(§22);
 *   - 官方没给 authorId → null(§21);
 *   - EditTime 为 Unix 秒 → UTC ISO(§26,dates.ts 已有 epoch 支持);
 *   - URL:官方给出则用官方;ID 只从稳定公开 URL 格式提取(§18/19);
 *   - 两种 item 形态按"必返字段"确定性判别(官方必返字段互斥,见 research 文档)。
 */
import type { NormalizeContext, SourceAdapter, RawValidationResult } from "./types";
import { NormalizationError, cleanText, cleanId, cleanUrl } from "./types";
import type { NormalizedRecord } from "./types";
import { parseDateToIso } from "../domain/dates";
import { computeDataQuality } from "../domain/quality";

/** strip <em> highlight tags from official search excerpts (not content) */
function stripEm(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/<\/?em>/gi, "");
}

/** 稳定公开 URL 格式提取 ID 与类型(research §19;解析失败 → null,不猜) */
function zhihuUrlIdentity(url: string | null): {
  id: string | null;
  contentType: NormalizedRecord["contentType"] | null;
} {
  if (!url) return { id: null, contentType: null };
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (host === "www.zhihu.com" || host === "zhihu.com") {
      const q = path.match(/^\/question\/(\d+)(?:\/|$)/);
      if (q) return { id: q[1], contentType: "question" };
      const a = path.match(/^\/answer\/(\d+)(?:\/|$)/);
      if (a) return { id: a[1], contentType: "answer" };
    }
    if (host === "zhuanlan.zhihu.com") {
      const p = path.match(/^\/p\/(\d+)(?:\/|$)/);
      if (p) return { id: p[1], contentType: "article" };
    }
  } catch {
    // unparseable — fall through
  }
  return { id: null, contentType: null };
}

/** 官方 ContentType(示例值 Answer/Article;未给完整枚举)→ 白名单映射(§17) */
function mapContentType(raw: string): NormalizedRecord["contentType"] {
  const v = raw.trim().toLowerCase();
  switch (v) {
    case "question":
      return "question";
    case "answer":
      return "answer";
    case "article":
      return "article";
    case "video":
      return "video";
    case "post":
      return "text_post";
    default:
      return "unknown"; // 只映射有证据的类型,不猜
  }
}

interface SearchItem {
  Title: string;
  ContentType: string;
  ContentID: string;
  ContentText: string;
  Url: string;
  CommentCount: number;
  VoteUpCount: number;
  AuthorName?: string;
  EditTime?: number;
  [k: string]: unknown;
}

interface HotListItem {
  Title: string;
  Url: string;
  ThumbnailUrl?: string;
  Summary?: string;
  [k: string]: unknown;
}

/** 非负 int:真实 0 保留 0;负数/非法 → null */
function metricOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** §18 canonical key:知乎跨类型数字 ID 可能撞号 → `type:id` 组合(null → null) */
function withTypePrefix(id: string | null, contentType: string | null): string | null {
  if (!id) return null;
  return `${contentType ?? "unknown"}:${id}`;
}

export class ZhihuSourceAdapter implements SourceAdapter {
  readonly id = "zhihu-adapter";

  getSourceType(): string {
    return "api";
  }

  getPlatform(): string {
    return "zhihu";
  }

  getSourceTimezone(): string | null {
    return "Asia/Shanghai"; // 仅用于 naive 日期;epoch/带 offset 时间不受影响
  }

  getCapabilities(): string[] {
    return ["search", "hotlist"];
  }

  validateRaw(input: unknown): RawValidationResult {
    if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: "知乎数据项必须是对象" };
    }
    const o = input as Record<string, unknown>;
    const isSearch = typeof o.ContentID === "string" && o.ContentID.length > 0;
    const isHotlist = typeof o.Title === "string" && typeof o.Url === "string" && o.ContentID === undefined;
    if (!isSearch && !isHotlist) {
      return { ok: false, error: "知乎数据项结构不匹配:既不是搜索结构(ContentID),也不是热榜结构(Title+Url)" };
    }
    return { ok: true };
  }

  normalize(input: unknown, ctx: NormalizeContext): NormalizedRecord {
    const v = this.validateRaw(input);
    if (!v.ok) throw new NormalizationError(v.error ?? "invalid zhihu item", input);
    const o = input as Record<string, unknown>;

    if (typeof o.ContentID === "string") {
      return this.normalizeSearch(o as SearchItem, ctx);
    }
    return this.normalizeHotList(o as HotListItem, ctx);
  }

  /* ---------------- search item(§17-23) ---------------- */

  private normalizeSearch(item: SearchItem, ctx: NormalizeContext): NormalizedRecord {
    const url = cleanUrl(item.Url);
    const urlIdentity = zhihuUrlIdentity(url);
    const contentType = mapContentType(item.ContentType);
    // §18:知乎 question/article 数字 ID 是独立空间,跨类型可能撞号 →
    // canonical key 采用 contentType 前缀(官方 ContentID 与 URL id 同 namespace,
    // 见 research 文档)。deterministic dedup 由此稳定。
    const platformContentId = withTypePrefix(
      cleanId(item.ContentID) ?? urlIdentity.id,
      contentType,
    );
    const publishedIso = item.EditTime !== undefined ? parseDateToIso(item.EditTime) : null;

    const record: NormalizedRecord = {
      platform: "zhihu",
      platformContentId,
      contentType,
      url,
      canonicalUrl: null, // pipeline canonicalizes centrally
      authorId: null, // 官方搜索 API 无 author id(§21)
      authorName: cleanText(item.AuthorName, 500),
      title: cleanText(item.Title, 1000),
      text: stripEm(cleanText(item.ContentText, 100_000)),
      transcript: null,
      hashtags: [],
      publishedAt: publishedIso,
      rawPublishedAt: item.EditTime !== undefined ? String(item.EditTime) : null,
      publishedTz: publishedIso ? "UTC" : null, // epoch 是绝对时间
      publishedTzAssumption: publishedIso ? "explicit_offset" : "unknown",
      metrics: {
        // VoteUpCount 语义 = 赞同 → upvotes(§23);likes 无来源 → null
        views: null,
        likes: null,
        comments: metricOf(item.CommentCount),
        shares: null,
        favorites: null,
        upvotes: metricOf(item.VoteUpCount),
      },
      authorMetrics: { followers: null },
    };
    void ctx;
    return this.gated(record, item);
  }

  /* ---------------- hotlist item(§28:rank 由 connector discovery 记录) ---------------- */

  private normalizeHotList(item: HotListItem, ctx: NormalizeContext): NormalizedRecord {
    const url = cleanUrl(item.Url);
    const identity = zhihuUrlIdentity(url);
    const summary = cleanText(item.Summary, 100_000);

    const record: NormalizedRecord = {
      platform: "zhihu",
      platformContentId: withTypePrefix(identity.id, identity.contentType), // §18 组合键;失败 → null
      contentType: identity.contentType ?? "unknown",
      url,
      canonicalUrl: null,
      authorId: null,
      authorName: null, // 官方热榜无 author 字段
      title: cleanText(item.Title, 1000),
      text: summary, // 官方摘要是全部可得内容(§20 不补全文)
      transcript: null,
      hashtags: [],
      publishedAt: null, // 官方热榜无时间字段 → null,绝不编造
      rawPublishedAt: null,
      publishedTz: null,
      publishedTzAssumption: "unknown",
      // 官方热榜无任何 metrics → 全 null(§22)
      metrics: { views: null, likes: null, comments: null, shares: null, favorites: null, upvotes: null },
      authorMetrics: { followers: null },
    };
    void ctx;
    return this.gated(record, item);
  }

  /** Zod 闸门:标准化结果必须满足 NormalizedRecord 形状(与 fieldMapping 管线同规) */
  private gated(record: NormalizedRecord, raw: unknown): NormalizedRecord {
    const q = computeDataQuality({
      platform: record.platform,
      platformContentId: record.platformContentId,
      url: record.url,
      canonicalUrl: null,
      urlWasProvided: Boolean(record.url),
      title: record.title,
      text: record.text,
      transcript: record.transcript,
      publishedAt: record.publishedAt,
      authorId: record.authorId,
      authorName: record.authorName,
      metrics: record.metrics,
    });
    if (q.quality === "invalid") {
      throw new NormalizationError(`zhihu item normalizes to invalid data: ${q.reasons.join(",")}`, raw);
    }
    return record;
  }
}
