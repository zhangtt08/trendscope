/**
 * NormalizedRecord — the shape every adapter MUST produce.
 * Zod-validated at the boundary; unknown values are null, never 0.
 */
import { z } from "zod";
import {
  ContentTypeSchema,
  MetricsSchema,
  AuthorMetricsSchema,
  PlatformSchema,
  TimezoneAssumptionSchema,
} from "../domain/constants";

export const NormalizedRecordSchema = z.object({
  platform: PlatformSchema,
  platformContentId: z.string().min(1).nullable(),
  contentType: ContentTypeSchema,
  url: z.string().url().nullable(),
  canonicalUrl: z.string().url().nullable(),
  authorId: z.string().min(1).nullable(),
  authorName: z.string().min(1).nullable(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  transcript: z.string().nullable(),
  hashtags: z.array(z.string()),
  /** normalized UTC ISO or null */
  publishedAt: z.string().nullable(),
  /** Stage 2 time provenance */
  rawPublishedAt: z.unknown().nullable(),
  publishedTz: z.string().nullable(),
  publishedTzAssumption: TimezoneAssumptionSchema,
  metrics: MetricsSchema,
  authorMetrics: AuthorMetricsSchema,
});
export type NormalizedRecord = z.infer<typeof NormalizedRecordSchema>;

/** Adapter-facing option bag. */
export interface NormalizeContext {
  sourceType: string;
  /** field mapping: canonical key -> source column/property name (csv/json) */
  mapping?: Record<string, string> | null;
  /** explicit platform chosen by the user at import time (fills missing row values) */
  platformOverride?: string | null;
  /** Stage 2: timezone for timezone-NAIVE dates only (explicit offsets always win) */
  sourceTimezone?: string | null;
  /** provenance label for that timezone choice */
  tzProvenance?: "adapter_default" | "user_selected";
}

export interface RawValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * SourceAdapter (spec §11, Stage 2 §27 contract extension).
 *
 * Contract surface for future REAL platform adapters (Stage 3+):
 *   getPlatform()        → the single platform this adapter serves, or "any"
 *                          for format adapters (csv/json/manual/fixture)
 *   getSourceTimezone()  → default timezone for timezone-NAIVE dates
 *   getCapabilities()    → declared abilities (search/hotlist/content_detail/
 *                          comments/author/metrics). DECLARATION ≠ IMPLEMENTATION.
 */
export interface SourceAdapter {
  readonly id: string;
  getSourceType(): string;
  getPlatform(): string;
  getSourceTimezone(): string | null;
  getCapabilities(): string[];
  validateRaw(input: unknown): RawValidationResult;
  normalize(input: unknown, ctx: NormalizeContext): NormalizedRecord;
}

export class NormalizationError extends Error {
  constructor(
    message: string,
    public readonly row: unknown,
  ) {
    super(message);
    this.name = "NormalizationError";
  }
}

/** Trim a free-text value to a string or null; never emit empty strings. */
export function cleanText(value: unknown, maxLength = 100_000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

export function cleanId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // avoid scientific notation for big ids
    if (Number.isInteger(value)) return String(value);
    return null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (/^(null|none|undefined|n\/a|na|-|—|未知|无)$/i.test(s)) return null;
    // strip ".0" from spreadsheet-exported numeric ids
    return s.replace(/\.0+$/, "");
  }
  return null;
}

export function cleanUrl(value: unknown): string | null {
  const s = cleanText(value, 2048);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+\//.test(s)) return `https://${s}`;
    return null;
  }
  return s;
}
