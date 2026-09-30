/**
 * Content fingerprint for FUZZY duplicate detection (spec §15).
 * A fingerprint match can only FLAG a possible duplicate — it never merges or
 * blocks ingestion by itself. Confirm-before-merge is a future, explicit action.
 */
import { createHash } from "node:crypto";

export interface FingerprintInput {
  platform: string | null;
  authorId: string | null;
  authorName: string | null;
  title: string | null;
  publishedAt: string | null;
}

function normalizeText(s: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, "") // remove ALL whitespace: exports insert spaces/newlines unpredictably
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();
}

export function computeFingerprint(i: FingerprintInput): string | null {
  if (!i.platform) return null;
  // date is truncated to day: re-collections & timezone skew shouldn't break it
  const day = i.publishedAt ? i.publishedAt.slice(0, 10) : "";
  const parts = [
    i.platform,
    i.authorId ?? i.authorName ?? "",
    normalizeText(i.title),
    day,
  ].join("|");
  // title-less + author-less fingerprints are too weak to be useful
  if (!normalizeText(i.title)) return null;
  return createHash("sha256").update(parts).digest("hex");
}
