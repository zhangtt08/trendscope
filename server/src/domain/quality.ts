/**
 * Data quality rules (spec §9 / Stage2 §16). Deterministic code — never AI.
 *
 * invalid  : no platform, or no content body
 * minimal  : has platform + body, but nothing else observable
 * partial  : has core + at least one observable extra, but not everything
 * complete : platform + id + body + publishedAt + author + at least one metric
 *
 * Every non-complete quality carries machine-readable reasons so the UI can
 * explain WHY (Stage 2 §16).
 */
import type { DataQuality } from "./constants";
import type { Metrics } from "./constants";

export const DATA_QUALITY_REASONS = [
  "missing_platform_id",
  "missing_title",
  "missing_text",
  "missing_metrics",
  "missing_author",
  "missing_published_at",
  "missing_body",
  "invalid_url",
] as const;
export type DataQualityReason = (typeof DATA_QUALITY_REASONS)[number];

export interface QualityInput {
  platform: string | null;
  platformContentId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  urlWasProvided: boolean;
  title: string | null;
  text: string | null;
  transcript: string | null;
  publishedAt: string | null;
  authorId: string | null;
  authorName: string | null;
  metrics: Metrics;
}

export interface QualityResult {
  quality: DataQuality;
  reasons: DataQualityReason[];
}

function hasBody(i: QualityInput): boolean {
  return Boolean(
    (i.title && i.title.trim().length > 0) ||
      (i.text && i.text.trim().length > 0) ||
      (i.transcript && i.transcript.trim().length > 0),
  );
}

function hasAnyMetric(m: Metrics): boolean {
  return (
    m.views !== null ||
    m.likes !== null ||
    m.comments !== null ||
    m.shares !== null ||
    m.favorites !== null ||
    m.upvotes !== null
  );
}

export function computeDataQuality(i: QualityInput): QualityResult {
  const reasons: DataQualityReason[] = [];
  if (!i.platform) {
    reasons.push("missing_platform_id");
    return { quality: "invalid", reasons };
  }
  if (!i.platformContentId) reasons.push("missing_platform_id");
  if (!hasBody(i)) reasons.push("missing_body");
  if (!i.title) reasons.push("missing_title");
  if (!i.text && !i.transcript) reasons.push("missing_text");
  if (!hasAnyMetric(i.metrics)) reasons.push("missing_metrics");
  if (!i.authorId && !i.authorName) reasons.push("missing_author");
  if (!i.publishedAt) reasons.push("missing_published_at");
  if (i.urlWasProvided && !i.canonicalUrl) reasons.push("invalid_url");

  const body = hasBody(i);
  if (!body) return { quality: "invalid", reasons };

  const hasId = Boolean(i.platformContentId);
  const hasDate = Boolean(i.publishedAt);
  const hasAuthor = Boolean(i.authorId || i.authorName);
  const hasMetrics = hasAnyMetric(i.metrics);

  if (hasId && hasDate && hasAuthor && hasMetrics) return { quality: "complete", reasons };
  if (!hasId && !hasDate && !hasAuthor && !hasMetrics) return { quality: "minimal", reasons };
  return { quality: "partial", reasons };
}
