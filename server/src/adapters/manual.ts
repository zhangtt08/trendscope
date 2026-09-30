/**
 * ManualAdapter — one record from the manual form. Payload is already canonical;
 * validation + normalization still run through the same Zod gate as every other
 * source (no exceptions for humans).
 */
import { z } from "zod";
import type { NormalizeContext, SourceAdapter, RawValidationResult } from "./types";
import { NormalizationError } from "./types";
import {
  PlatformSchema,
  ContentTypeSchema,
  NULL_AUTHOR_METRICS,
} from "../domain/constants";
import type { NormalizedRecord } from "./types";
import { canonicalizeUrl } from "../domain/url";
import { normalizeDate } from "../domain/timezone";
import { zodIssueLines } from "../domain/zodMessage";

export const ManualInputSchema = z.object({
  platform: PlatformSchema,
  contentType: ContentTypeSchema.default("unknown"),
  platformContentId: z.string().trim().min(1).nullable().optional(),
  url: z.string().trim().nullable().optional(),
  authorId: z.string().trim().nullable().optional(),
  authorName: z.string().trim().nullable().optional(),
  title: z.string().trim().nullable().optional(),
  text: z.string().trim().nullable().optional(),
  publishedAt: z.string().trim().nullable().optional(),
  views: z.number().int().nonnegative().nullable().optional(),
  likes: z.number().int().nonnegative().nullable().optional(),
  comments: z.number().int().nonnegative().nullable().optional(),
  shares: z.number().int().nonnegative().nullable().optional(),
  favorites: z.number().int().nonnegative().nullable().optional(),
  upvotes: z.number().int().nonnegative().nullable().optional(),
  followers: z.number().int().nonnegative().nullable().optional(),
});
export type ManualInput = z.infer<typeof ManualInputSchema>;

export class ManualAdapter implements SourceAdapter {
  readonly id = "manual-adapter";

  getSourceType(): string {
    return "manual";
  }

  getPlatform(): string {
    return "any";
  }

  getSourceTimezone(): string | null {
    return null; // the form sends the user-selected timezone explicitly
  }

  getCapabilities(): string[] {
    return [];
  }

  validateRaw(input: unknown): RawValidationResult {
    const parsed = ManualInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: zodIssueLines(parsed.error),
      };
    }
    return { ok: true };
  }

  normalize(input: unknown, ctx: NormalizeContext): NormalizedRecord {
    const parsed = ManualInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new NormalizationError(zodIssueLines(parsed.error), input);
    }
    const d = parsed.data;
    const url = d.url && d.url.length > 0 ? d.url : null;
    const instant = normalizeDate(
      d.publishedAt,
      ctx.sourceTimezone ?? null,
      "user_selected",
    );
    const record: NormalizedRecord = {
      platform: d.platform,
      platformContentId: d.platformContentId ?? null,
      contentType: d.contentType,
      url,
      canonicalUrl: canonicalizeUrl(url),
      authorId: d.authorId ?? null,
      authorName: d.authorName ?? null,
      title: d.title ?? null,
      text: d.text ?? null,
      transcript: null,
      hashtags: [],
      publishedAt: instant.iso,
      rawPublishedAt: d.publishedAt ?? null,
      publishedTz: instant.appliedTimezone,
      publishedTzAssumption: instant.assumption,
      metrics: {
        views: d.views ?? null,
        likes: d.likes ?? null,
        comments: d.comments ?? null,
        shares: d.shares ?? null,
        favorites: d.favorites ?? null,
        upvotes: d.upvotes ?? null,
      },
      authorMetrics: { followers: d.followers ?? NULL_AUTHOR_METRICS.followers },
    };
    return record;
  }
}
