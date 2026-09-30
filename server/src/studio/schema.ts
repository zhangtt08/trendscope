/**
 * Studio 输出 Schema(Part 1 §5-§10)。严格校验:模型返回不合规模型就当失败,
 * 不做"尽力解析"—— 因为下游 UI 与历史都要引用它,半条结果比没有更糟。
 */
import { z } from "zod";

const trimmed = (max: number, min = 2) => z.string().trim().min(min).max(max);

/** §10:所有关键 angle 必须引用证据包里的 ref。 */
export const evidenceRefSchema = z.string().trim().regex(/^[a-z][a-z-]*-\d+$/, "evidenceRef 形如 trend-1 / pattern-2 / angle-1");

export const recommendedAngleSchema = z
  .object({
    name: trimmed(60),
    coreIdea: trimmed(400),
    targetAudience: trimmed(200),
    conflict: trimmed(200),
    whyItMayBeInteresting: trimmed(400),
    evidenceRefs: z.array(evidenceRefSchema).min(1, "每个角度必须至少引用一条证据"),
    saturationRisk: z.enum(["low", "medium", "high", "unknown"]),
    noveltyBasis: trimmed(300),
  })
  .strict();

export const hookSchema = z
  .object({
    /** §7:只是创作建议的角度类型,不是保证有效的方法 */
    kind: z.enum(["question", "counter_intuitive", "conflict_of_interest", "identity", "data", "experience", "other"]),
    text: trimmed(240),
    evidenceRefs: z.array(evidenceRefSchema).default([]),
  })
  .strict();

export const titleDirectionSchema = z
  .object({
    text: trimmed(160),
    basedOn: trimmed(300),
    evidenceRefs: z.array(evidenceRefSchema).min(1, "标题方向必须基于证据"),
    /** §8:没有证据支持的数字/权威说法必须自行标记为待核实 */
    needsExternalVerification: z.boolean().default(false),
  })
  .strict();

export const stanceSchema = z
  .object({
    label: trimmed(60),
    summary: trimmed(400),
    audienceFit: trimmed(200),
    risks: trimmed(300),
    evidenceRefs: z.array(evidenceRefSchema).default([]),
  })
  .strict();

export const contentStructureSchema = z
  .object({
    name: trimmed(60),
    outline: z.array(trimmed(240)).min(1).max(12),
    rationale: trimmed(300),
    evidenceRefs: z.array(evidenceRefSchema).default([]),
  })
  .strict();

export const studioOutputSchema = z
  .object({
    topicSummary: trimmed(600),
    whyNow: trimmed(600),
    targetAudience: trimmed(400),
    recommendedAngles: z.array(recommendedAngleSchema).min(1).max(8),
    hooks: z.array(hookSchema).max(10).default([]),
    titleDirections: z.array(titleDirectionSchema).max(10).default([]),
    contentStructures: z.array(contentStructureSchema).max(6).default([]),
    stanceOptions: z.array(stanceSchema).max(5).default([]),
    risks: z.array(trimmed(300)).max(10).default([]),
    avoidAngles: z.array(trimmed(300)).max(10).default([]),
    evidenceReferences: z.array(evidenceRefSchema).min(1, "至少要引用一条证据"),
    confidenceNote: trimmed(400),
  })
  .strict();

export type StudioOutput = z.infer<typeof studioOutputSchema>;
export type RecommendedAngle = z.infer<typeof recommendedAngleSchema>;

/** §11 幻觉护栏:这些说法只有证据包里真有才允许出现。 */
export const UNSUPPORTED_CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\d+\s*[%％]/, label: "百分比数字" },
  { re: /\d+\s*(万|亿|千人|万人)/, label: "量级数字" },
  { re: /专家证明|研究表明|研究发现|权威机构|官方数据/, label: "权威背书" },
  { re: /\d+\s*人(投票|调研|实测)/, label: "调研样本" },
];

/**
 * 扫描输出中"看起来像事实断言"的片段,并核对相应数字是否真的来自证据包。
 * 命中而证据里没有 → 标记待外部核实(不静默通过,也不假装它是结论)。
 */
export function findUnsupportedClaims(output: StudioOutput, evidenceText: string): string[] {
  const haystack = evidenceText.toLowerCase();
  const flags: string[] = [];
  const texts: string[] = [];
  for (const a of output.recommendedAngles) texts.push(`${a.name} ${a.coreIdea} ${a.whyItMayBeInteresting} ${a.noveltyBasis}`);
  for (const h of output.hooks) texts.push(h.text);
  for (const t of output.titleDirections) texts.push(`${t.text} ${t.basedOn}`);
  for (const s of output.stanceOptions) texts.push(`${s.label} ${s.summary}`);
  texts.push(output.topicSummary, output.whyNow, output.targetAudience);

  for (const line of texts) {
    for (const { re, label } of UNSUPPORTED_CLAIM_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const token = m[0].trim().toLowerCase();
      if (!haystack.includes(token)) flags.push(`${label}「${m[0]}」不在证据包内`);
    }
  }
  return [...new Set(flags)].slice(0, 12);
}

/**
 * §10 可追溯性:模型可能凭空造一个 `pattern-99`。语法合规但证据包里不存在的 ref
 * 同样要如实报出来 —— 否则"每条建议都能回查证据"只是一句口号。
 */
export function findUnknownEvidenceRefs(output: StudioOutput, knownIds: Set<string>): string[] {
  const used = new Set<string>();
  for (const a of output.recommendedAngles) a.evidenceRefs.forEach((r) => used.add(r));
  output.hooks.forEach((h) => h.evidenceRefs.forEach((r) => used.add(r)));
  output.titleDirections.forEach((t) => t.evidenceRefs.forEach((r) => used.add(r)));
  output.contentStructures.forEach((c) => c.evidenceRefs.forEach((r) => used.add(r)));
  output.stanceOptions.forEach((s) => s.evidenceRefs.forEach((r) => used.add(r)));
  output.evidenceReferences.forEach((r) => used.add(r));
  return [...used].filter((r) => !knownIds.has(r)).sort().slice(0, 12);
}
