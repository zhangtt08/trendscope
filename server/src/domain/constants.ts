/**
 * Domain constants. Never scatter raw platform strings through business logic —
 * always import from here. Zod schemas below are the single validation gate.
 */
import { z } from "zod";

export const PLATFORMS = [
  "douyin",
  "xiaohongshu",
  "zhihu",
  "bilibili",
  "weibo",
  "toutiao",
  "baidu",
  "ithome",
  "douban",
  "tieba",
  "manual",
  "other",
] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PlatformSchema = z.enum(PLATFORMS);

export const CONTENT_TYPES = [
  "video",
  "image_post",
  "text_post",
  "question",
  "answer",
  "article",
  "unknown",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const ContentTypeSchema = z.enum(CONTENT_TYPES);

export const SOURCE_TYPES = [
  "api",
  "playwright",
  "csv",
  "json",
  "manual",
  "fixture",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SourceTypeSchema = z.enum(SOURCE_TYPES);

export const DATA_QUALITIES = ["complete", "partial", "minimal", "invalid"] as const;
export type DataQuality = (typeof DATA_QUALITIES)[number];
export const DataQualitySchema = z.enum(DATA_QUALITIES);

export const IMPORT_STATUSES = [
  "pending",
  "processing",
  "completed",
  "partial",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const ImportStatusSchema = z.enum(IMPORT_STATUSES);

/** Metric fields tracked per content item / snapshot. All nullable — null means unknown. */
export const METRIC_FIELDS = [
  "views",
  "likes",
  "comments",
  "shares",
  "favorites",
  "upvotes",
] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

/** How a timezone-naive date was interpreted (Stage 2 provenance). */
export const TIMEZONE_ASSUMPTIONS = [
  "explicit_offset",
  "adapter_default",
  "user_selected",
  "unknown",
] as const;
export type TimezoneAssumption = (typeof TIMEZONE_ASSUMPTIONS)[number];
export const TimezoneAssumptionSchema = z.enum(TIMEZONE_ASSUMPTIONS);

/** Adapter capability declarations — contract only, Stage 2 does NOT implement them. */
export const ADAPTER_CAPABILITIES = [
  "search",
  "hotlist",
  "content_detail",
  "comments",
  "author",
  "metrics",
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];
export const AdapterCapabilitySchema = z.enum(ADAPTER_CAPABILITIES);

/** Duplicate candidate lifecycle (Stage 2 §11/12). */
export const DUPLICATE_STATUSES = [
  "pending",
  "confirmed_duplicate",
  "not_duplicate",
  "ignored",
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];
export const DuplicateStatusSchema = z.enum(DUPLICATE_STATUSES);

export const DUPLICATE_REASONS = ["fingerprint", "manual"] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/** ISO datetime string (normalized on ingest). */
export const IsoDateSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO date");

export const MetricsSchema = z.object({
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
  shares: z.number().int().nonnegative().nullable(),
  favorites: z.number().int().nonnegative().nullable(),
  upvotes: z.number().int().nonnegative().nullable(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const AuthorMetricsSchema = z.object({
  followers: z.number().int().nonnegative().nullable(),
});
export type AuthorMetrics = z.infer<typeof AuthorMetricsSchema>;

export const NULL_METRICS: Metrics = {
  views: null,
  likes: null,
  comments: null,
  shares: null,
  favorites: null,
  upvotes: null,
};

export const NULL_AUTHOR_METRICS: AuthorMetrics = { followers: null };

/** Import limits (safety & stability, spec §27). */
export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024, // 10 MB per upload
  maxRecordsPerImport: 10_000,
  previewRows: 25,
} as const;
