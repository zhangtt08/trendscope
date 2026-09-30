/**
 * Field mapping: canonical field -> source column.
 * Auto-detection scores candidate header names (EN + CN aliases used by real
 * platform exports). Users can override every slot in the Import Center UI.
 */
import { isUnknownToken } from "../domain/dates";
import { cleanText, cleanId, cleanUrl } from "./types";
import { parseMetric, parseHashtags, parseContentType } from "../domain/numbers";
import type { Metrics, AuthorMetrics, Platform, ContentType } from "../domain/constants";
import { PlatformSchema } from "../domain/constants";
import type { NormalizedRecord, NormalizeContext, SourceAdapter } from "./types";
import { NormalizationError, NormalizedRecordSchema } from "./types";
import { canonicalizeUrl } from "../domain/url";
import { normalizeDate } from "../domain/timezone";
import { zodIssueLines } from "../domain/zodMessage";

export type CanonicalField =
  | "platform"
  | "platformContentId"
  | "contentType"
  | "url"
  | "authorId"
  | "authorName"
  | "title"
  | "text"
  | "hashtags"
  | "publishedAt"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "favorites"
  | "upvotes"
  | "authorFollowers";

export const CANONICAL_FIELDS: CanonicalField[] = [
  "platform",
  "platformContentId",
  "contentType",
  "url",
  "authorId",
  "authorName",
  "title",
  "text",
  "hashtags",
  "publishedAt",
  "views",
  "likes",
  "comments",
  "shares",
  "favorites",
  "upvotes",
  "authorFollowers",
];

const FIELD_CANDIDATES: Record<CanonicalField, string[]> = {
  platform: ["platform", "平台", "platform_name", "source", "渠道"],
  platformContentId: [
    "id",
    "content_id",
    "contentid",
    "platformcontentid",
    "video_id",
    "aweme_id",
    "note_id",
    "item_id",
    "作品id",
    "视频id",
    "内容id",
    "id_",
    "文章id",
  ],
  contentType: ["content_type", "contenttype", "type", "类型", "内容类型"],
  url: [
    "url",
    "link",
    "链接",
    "分享链接",
    "share_url",
    "share_url_1",
    "video_url",
    "content_url",
    "网页链接",
  ],
  authorId: ["author_id", "authorid", "user_id", "uid", "author_uid", "作者id", "用户id"],
  authorName: [
    "author",
    "author_name",
    "nickname",
    "user_name",
    "username",
    "creator",
    "作者",
    "昵称",
    "博主",
    "up主",
    "up主名称",
    "用户名",
  ],
  title: ["title", "标题", "name", "video_title", "题目", "标题名称"],
  text: [
    "text",
    "content",
    "description",
    "desc",
    "body",
    "caption",
    "正文",
    "内容",
    "简介",
    "描述",
    "文案",
  ],
  hashtags: ["hashtags", "tags", "tag", "hashtag", "话题", "标签", "话题标签"],
  publishedAt: [
    "published_at",
    "publishedat",
    "publish_time",
    "published_time",
    "create_time",
    "created_at",
    "createat",
    "date",
    "发布时间",
    "发布日期",
    "时间",
    "创建时间",
  ],
  views: [
    "views",
    "view_count",
    "viewcount",
    "play_count",
    "plays",
    "playcount",
    "watch_count",
    "播放量",
    "播放",
    "播放数",
    "观看数",
    "浏览量",
    "阅读数",
    "阅读量",
  ],
  likes: [
    "likes",
    "like_count",
    "likecount",
    "digg_count",
    "liked_count",
    "点赞",
    "点赞数",
    "点赞量",
    "赞",
    "获赞",
  ],
  comments: ["comments", "comment_count", "commentcount", "评论", "评论数", "评论量"],
  shares: ["shares", "share_count", "sharecount", "reposts", "分享", "分享数", "转发", "转发数"],
  favorites: [
    "favorites",
    "favorite_count",
    "favoritecount",
    "collect_count",
    "collects",
    "收藏",
    "收藏数",
    "收藏量",
  ],
  upvotes: ["upvotes", "upvote_count", "agree_count", "赞同", "赞同数", "同意"],
  authorFollowers: [
    "followers",
    "follower_count",
    "followercount",
    "fans",
    "fans_count",
    "粉丝",
    "粉丝数",
  ],
};

const normalizeHeader = (h: string) =>
  h.trim().toLowerCase().replace(/[\s_-]+/g, "").replace(/\d+$/, "");

/** Best-effort auto detection from observed headers/column keys. */
export function detectMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const used = new Set<string>();
  for (const field of CANONICAL_FIELDS) {
    const candidates = FIELD_CANDIDATES[field].map(normalizeHeader);
    let best: { raw: string; score: number } | null = null;
    for (const h of normalized) {
      if (used.has(h.raw)) continue;
      const idx = candidates.indexOf(h.norm);
      if (idx === -1) continue;
      // earlier candidate = stronger alias
      const score = candidates.length - idx;
      if (!best || score > best.score) best = { raw: h.raw, score };
    }
    if (best) {
      mapping[field] = best.raw;
      used.add(best.raw);
    }
  }
  return mapping;
}

const PLATFORM_ALIASES: Record<string, Platform> = {
  douyin: "douyin",
  抖音: "douyin",
  dy: "douyin",
  tiktok: "douyin",
  xiaohongshu: "xiaohongshu",
  小红书: "xiaohongshu",
  xhs: "xiaohongshu",
  rednote: "xiaohongshu",
  zhihu: "zhihu",
  知乎: "zhihu",
  bilibili: "bilibili",
  B站: "bilibili",
  b站: "bilibili",
  bili: "bilibili",
  weibo: "weibo",
  微博: "weibo",
  manual: "manual",
  手动: "manual",
  手工: "manual",
  other: "other",
  其他: "other",
};

export function normalizePlatform(value: unknown): Platform | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || isUnknownToken(s)) return null;
  const mapped = PLATFORM_ALIASES[s] ?? PLATFORM_ALIASES[s.replace(/\s+/g, "")];
  if (mapped) return mapped;
  // allow exact enum values pass-through
  const parsed = PlatformSchema.safeParse(s);
  return parsed.success ? parsed.data : null;
}

/**
 * Shared row → NormalizedRecord transformer used by CSV / JSON / Fixture adapters.
 * `mapping` maps canonical field -> source column/property. Missing values are
 * null; unknown metric tokens ("N/A", "-", "未知") are null; "0" stays 0.
 */
export function mappedRowToNormalized(
  row: Record<string, unknown>,
  ctx: NormalizeContext,
  _adapterId: string,
): NormalizedRecord {
  const mapping = ctx.mapping ?? {};
  const pick = (field: CanonicalField): unknown => {
    const key = mapping[field] ?? field; // unmapped → canonical key itself
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    // case-insensitive fallback
    const lower = key.toLowerCase();
    for (const k of Object.keys(row)) {
      if (k.toLowerCase() === lower) return row[k];
    }
    return undefined;
  };

  // row's own platform value wins; user/chosen override fills the gaps
  const platform =
    normalizePlatform(pick("platform")) ??
    (ctx.platformOverride ? normalizePlatform(ctx.platformOverride) : null);
  if (!platform) {
    throw new NormalizationError("平台字段缺失或无法识别", row);
  }

  const platformContentId = cleanId(pick("platformContentId"));
  const title = cleanText(pick("title"), 2000);
  const hashtagsRaw = pick("hashtags");
  const text = cleanText(pick("text"), 100_000);
  // no dedicated hashtags column → extract only explicit "#tag" tokens from text
  const hashtags =
    hashtagsRaw !== undefined
      ? parseHashtags(hashtagsRaw)
      : text
        ? [...text.matchAll(/#([^#\s，,、。;；！!？?]+)/g)].map((m) => m[1]).filter(Boolean)
        : [];
  const url = cleanUrl(pick("url"));
  const rawPublishedAt = pick("publishedAt");
  const rawPublishedCleaned =
    rawPublishedAt === undefined || typeof rawPublishedAt === "object" ? null : rawPublishedAt;
  const instant = normalizeDate(
    rawPublishedCleaned,
    ctx.sourceTimezone ?? null,
    ctx.tzProvenance ?? "adapter_default",
  );
  const publishedAt = instant.iso;
  const parsedType = parseContentType(pick("contentType"));
  const contentType = parsedType ?? inferContentType(url, platform);

  const metrics: Metrics = {
    views: parseMetric(pick("views")),
    likes: parseMetric(pick("likes")),
    comments: parseMetric(pick("comments")),
    shares: parseMetric(pick("shares")),
    favorites: parseMetric(pick("favorites")),
    upvotes: parseMetric(pick("upvotes")),
  };
  const authorMetrics: AuthorMetrics = {
    followers: parseMetric(pick("authorFollowers")),
  };

  const candidate: NormalizedRecord = {
    platform,
    platformContentId,
    contentType,
    url,
    canonicalUrl: canonicalizeUrl(url),
    authorId: cleanId(pick("authorId")),
    authorName: cleanText(pick("authorName"), 500),
    title,
    text,
    transcript: null,
    hashtags,
    publishedAt,
    rawPublishedAt: rawPublishedCleaned,
    publishedTz: instant.appliedTimezone,
    publishedTzAssumption: instant.assumption,
    metrics,
    authorMetrics,
  };

  const parsed = NormalizedRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new NormalizationError(
      `规范化记录未通过结构校验: ${zodIssueLines(parsed.error)}`,
      row,
    );
  }
  return parsed.data;
}

/** Tiny content-type inference from URL shape. Conservative → unknown. */
export function inferContentType(
  url: string | null,
  platform: Platform,
): ContentType {
  if (!url) return "unknown";
  const u = url.toLowerCase();
  if (u.includes("/video/") || u.includes("video")) return "video";
  if (platform === "zhihu") {
    if (u.includes("/question/")) return "question";
    if (u.includes("/answer/")) return "answer";
    if (u.includes("/p/") || u.includes("zhuanlan")) return "article";
  }
  if (platform === "xiaohongshu" && (u.includes("/explore/") || u.includes("/discovery/"))) {
    return "image_post";
  }
  return "unknown";
}

/** Mixin for format adapters that normalize mapped rows. */
export function makeRowAdapter(
  id: string,
  sourceType: string,
): Pick<SourceAdapter, "id" | "getSourceType"> {
  return {
    id,
    getSourceType: () => sourceType,
  };
}
