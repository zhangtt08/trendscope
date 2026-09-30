/**
 * SemanticTextBuilder (Stage 6A §2-8) — 决定一条 ContentItem 拿什么文本做语义分析。
 *
 * 规则:
 * - 按 contentType 选择参与字段(§3);URL/作者/指标/ID/时间 一律不参与(非正文语义)
 * - 优先级 title > text > transcript > hashtags(§4);完全相同的文本段只保留一次
 * - 清洗(§5):HTML strip → decode entities → 空白归一化 → 去重 hashtag →
 *   压缩过量标点 → trim → 空检查;绝不修改 RawRecord,只产出 semanticText
 * - 截断(§6):maxSemanticTextLength(默认 2000 字符);策略 = title 全保 +
 *   正文前部 + hashtags 保尾;输出 wasTruncated
 * - 版本(§7):SEMANTIC_TEXT_BUILDER_VERSION;写入 ContentEmbedding,
 *   规则变更后旧向量不可被误认为一致
 * - textHash(§8):sha256(semanticText) — contentItemId + embeddingSpace +
 *   textHash 均未变时禁止重复 embedding
 */
import { createHash } from "node:crypto";

export const SEMANTIC_TEXT_BUILDER_VERSION = "semantic-v1";
export const DEFAULT_MAX_SEMANTIC_TEXT_LENGTH = 2000;

export type SemanticContentType =
  | "video"
  | "image_post"
  | "text_post"
  | "question"
  | "answer"
  | "article"
  | "unknown";

export interface SemanticInput {
  contentType: string;
  title: string | null;
  text: string | null;
  transcript: string | null;
  hashtags: string[] | null;
}

export interface SemanticTextResult {
  semanticText: string;
  textHash: string;
  textBuilderVersion: string;
  wasTruncated: boolean;
  /** 参与构建的段落(调试/Preview 用),已清洗去重,不含截断标记行 */
  parts: string[];
}

/* ------------------------------------------------------------------ */
/* §3: per-contentType field selection                                 */
/* ------------------------------------------------------------------ */

interface FieldPlan {
  useTitle: boolean;
  useText: boolean;
  useTranscript: boolean;
  useHashtags: boolean;
  /** question context(§3:answer 可带问题上下文——由调用方经 questionContext 传入) */
}

const FIELD_PLANS: Record<string, FieldPlan> = {
  video: { useTitle: true, useText: true, useTranscript: true, useHashtags: true },
  image_post: { useTitle: true, useText: true, useTranscript: false, useHashtags: true },
  text_post: { useTitle: true, useText: true, useTranscript: false, useHashtags: true },
  question: { useTitle: true, useText: true, useTranscript: false, useHashtags: true },
  answer: { useTitle: true, useText: true, useTranscript: false, useHashtags: true },
  article: { useTitle: true, useText: true, useTranscript: false, useHashtags: true },
  unknown: { useTitle: true, useText: true, useTranscript: true, useHashtags: true },
};

export function fieldPlanFor(contentType: string): FieldPlan {
  return FIELD_PLANS[contentType] ?? FIELD_PLANS.unknown;
}

/* ------------------------------------------------------------------ */
/* §5: cleaning                                                        */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&mdash;": "—",
  "&middot;": "·",
};

/** strip tags, decode common entities (no external deps) */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => ENTITIES[m] ?? (m.startsWith("&#") ? safeCodePoint(m) : m));
}

function safeCodePoint(entity: string): string {
  const n = Number(entity.replace(/[&#;]/g, ""));
  return Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
}

export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\v\f\u00a0\u200b]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/** 压缩过量标点(§5):3+ 连续同标点 → 1 个(省略号 … 保留到 2) */
export function collapsePunctuation(input: string): string {
  return input
    .replace(/([!@#$%^&*()_+=\[\]{};':"\\|,.<>/?~`\-])\1{2,}/g, "$1")
    .replace(/([。!?!?,、;:~—])\1{2,}/g, "$1")
    .replace(/\.{4,}/g, "…")
    .replace(/…{3,}/g, "…");
}

export function cleanTextPart(input: string | null | undefined): string {
  if (!input) return "";
  const stripped = stripHtml(input);
  const normalized = normalizeWhitespace(stripped).trim();
  return collapsePunctuation(normalized).trim();
}

export function cleanHashtags(hashtags: string[] | null | undefined): string[] {
  if (!hashtags || hashtags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hashtags) {
    if (typeof raw !== "string") continue;
    const t = cleanTextPart(raw).replace(/^#+/, "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue; // 去重 hashtag(§5)
    seen.add(key);
    out.push(`#${t}`);
  }
  return out.slice(0, 15); // 话题过多对语义无益,封顶
}

/* ------------------------------------------------------------------ */
/* §4: assembly with priority + dedup                                  */
/* ------------------------------------------------------------------ */

function dedupeParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue; // 完全一致(忽略空白/大小写)只保留一次(§4)
    seen.add(key);
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* §6: truncation                                                      */
/* ------------------------------------------------------------------ */

export function truncateSemanticText(parts: string[], maxLength: number): { text: string; wasTruncated: boolean } {
  const total = parts.join("\n").length;
  if (total <= maxLength) return { text: parts.join("\n"), wasTruncated: false };

  // 可解释策略:title(parts[0])全保 → 正文段顺序保留前部 → hashtags(尾段)保尾
  const isHashtagPart = (p: string) => p.startsWith("#");
  const titlePart = parts[0] && !isHashtagPart(parts[0]) ? parts[0] : "";
  const middle = parts.slice(titlePart ? 1 : 0).filter((p) => !isHashtagPart(p));
  const tags = parts.filter(isHashtagPart);

  let used = titlePart.length;
  const kept: string[] = titlePart ? [titlePart] : [];

  const tagsText = tags.join(" ");
  const reserveTags = tagsText ? tagsText.length + 1 : 0;

  for (const m of middle) {
    const budget = Math.max(0, maxLength - used - reserveTags - 1);
    if (budget <= 8) break;
    if (m.length <= budget) {
      kept.push(m);
      used += m.length + 1;
    } else {
      kept.push(`${m.slice(0, budget)}…`);
      used += budget + 1;
      break;
    }
  }
  if (tagsText && used + tagsText.length + 1 <= maxLength) {
    kept.push(tagsText);
  }
  return { text: kept.join("\n"), wasTruncated: true };
}

/* ------------------------------------------------------------------ */
/* main entry                                                          */
/* ------------------------------------------------------------------ */

export function buildSemanticText(
  input: SemanticInput,
  opts: {
    maxSemanticTextLength?: number;
    /** answer 的提问上下文(如有),拼接在标题前(§3 示例) */
    questionContext?: string | null;
  } = {},
): SemanticTextResult {
  const plan = fieldPlanFor(input.contentType);
  const maxLen = Math.max(64, opts.maxSemanticTextLength ?? DEFAULT_MAX_SEMANTIC_TEXT_LENGTH);

  const rawParts: string[] = [];
  const q = cleanTextPart(opts.questionContext);
  if (input.contentType === "answer" && q) rawParts.push(`问题:${q}`);

  if (plan.useTitle) rawParts.push(cleanTextPart(input.title));
  if (plan.useText) rawParts.push(cleanTextPart(input.text));
  if (plan.useTranscript) rawParts.push(cleanTextPart(input.transcript));
  if (plan.useHashtags) {
    const tags = cleanHashtags(input.hashtags);
    if (tags.length) rawParts.push(tags.join(" "));
  }

  const parts = dedupeParts(rawParts.filter((p) => p.length > 0));
  if (parts.length === 0) {
    // 空检查(§5):无任何语义文本 → 空 hash(调用方应跳过 embedding)
    return {
      semanticText: "",
      textHash: "",
      textBuilderVersion: SEMANTIC_TEXT_BUILDER_VERSION,
      wasTruncated: false,
      parts: [],
    };
  }

  const { text, wasTruncated } = truncateSemanticText(parts, maxLen);
  const textHash = hashSemanticText(text);
  return { semanticText: text, textHash, textBuilderVersion: SEMANTIC_TEXT_BUILDER_VERSION, wasTruncated, parts };
}

export function hashSemanticText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
