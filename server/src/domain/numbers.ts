/**
 * Metric parsing: unknown → null, real 0 → 0.
 * Understands Chinese unit suffixes common in platform exports: 1.2万, 3.5亿, 1,234.
 */
import { isUnknownToken } from "./dates";

export function parseMetric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value);
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (isUnknownToken(raw)) return null;
    let s = raw.replace(/[,\s_]/g, "");
    // strip trailing non-unit junk like "次", "个"
    s = s.replace(/(次|个|条|人)$/, "");
    const wanMatch = s.match(/^(\+(?:\d+(?:\.\d+)?))(万|亿|w|W)?$/);
    if (!wanMatch) {
      // tolerate leading "+" (e.g. "+1.2万")
      s = s.replace(/^\+/, "");
    }
    const m = s.match(/^(\d+(?:\.\d+)?)(万|亿|w|W)?$/);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num < 0) return null;
    const unit = m[2];
    let result = num;
    if (unit === "万" || unit === "w" || unit === "W") result = num * 10_000;
    else if (unit === "亿") result = num * 100_000_000;
    return Math.round(result);
  }
  return null;
}

/** Parse a hashtag-ish value into a clean string array. */
export function parseHashtags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  let parts: string[] = [];
  if (Array.isArray(value)) {
    parts = value.map((v) => String(v));
  } else if (typeof value === "string") {
    const t = value.trim();
    if (!t || isUnknownToken(t)) return [];
    // "#a #b" | "a,b" | "#a,#b" | "a、b"
    parts = t.split(/[,\s、，]+|#+/).filter((p) => p.length > 0);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const tag = p.replace(/^#+|#+$/g, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Normalize free-text content type values (中英文别名) onto ContentType enum. */
const CONTENT_TYPE_ALIASES: Record<string, string> = {
  video: "video",
  视频: "video",
  短视频: "video",
  image: "image_post",
  imagepost: "image_post",
  image_post: "image_post",
  photo: "image_post",
  图文: "image_post",
  图片: "image_post",
  笔记: "image_post",
  note: "image_post",
  text: "text_post",
  textpost: "text_post",
  text_post: "text_post",
  post: "text_post",
  帖子: "text_post",
  文字: "text_post",
  微博: "text_post",
  question: "question",
  提问: "question",
  问题: "question",
  answer: "answer",
  回答: "answer",
  article: "article",
  文章: "article",
  专栏: "article",
};

export function parseContentType(value: unknown): import("./constants").ContentType | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || isUnknownToken(s)) return null;
  const mapped = CONTENT_TYPE_ALIASES[s];
  return (mapped as import("./constants").ContentType) ?? null;
}
