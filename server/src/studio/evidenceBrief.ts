/**
 * Evidence Brief —— 无 AI 凭据时的**确定性**摘要(Part 1 §15-§16)。
 *
 * 它不是创作方案,只是把引擎已经算出的事实组织成人能读的段落。
 * UI 必须标成「证据摘要」,绝不标成「AI 建议」—— 用规则生成内容再贴 AI 标签是
 * spec 明令禁止的假 AI(§16)。
 */
import type { StudioEvidencePackage } from "./evidencePackage";
import { LIFECYCLE_LABELS_ZH } from "../scoring/lifecycle";

export interface EvidenceBriefSection {
  key: "status" | "positive" | "limiting" | "angles" | "patterns" | "saturation" | "novelty" | "caution";
  title: string;
  lines: string[];
  /** 空段的诚实说明 —— 不是"没有内容",而是"证据不足/尚未运行" */
  emptyNote?: string;
}

export interface EvidenceBrief {
  generatedAt: string;
  /** 让 UI 能一句话自证身份 */
  kind: "deterministic_evidence_brief";
  deterministic: true;
  isAiGenerated: false;
  topicId: number;
  topicName: string;
  sections: EvidenceBriefSection[];
}

const n = (v: number | null | undefined, suffix = ""): string =>
  v === null || v === undefined ? "数据不足" : `${v}${suffix}`;

/** §78:面向用户的文案不出现裸英文码;内部与 DB 仍用英文 code。 */
const PLATFORM_ZH: Record<string, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  zhihu: "知乎",
  bilibili: "B站",
  weibo: "微博",
  manual: "手动",
  other: "其他",
};
const CONFIDENCE_ZH: Record<string, string> = { high: "高", medium: "中", low: "低" };
const LEVEL_ZH: Record<string, string> = { high: "较高机会", medium: "中等机会", low: "较低机会" };
const QUALITY_ZH: Record<string, string> = { high: "高", medium: "中", low: "低", insufficient: "不足" };

const platform = (k: string): string => PLATFORM_ZH[k] ?? k;
const conf = (v: string | null): string => (v ? CONFIDENCE_ZH[v] ?? v : "未知");
const level = (v: string | null): string => (v ? LEVEL_ZH[v] ?? v : "未知");
const lifecycle = (v: string | null): string =>
  v ? LIFECYCLE_LABELS_ZH[v as keyof typeof LIFECYCLE_LABELS_ZH] ?? v : "数据不足";

export function buildEvidenceBrief(pkg: StudioEvidencePackage, now = Date.now()): EvidenceBrief {
  const sections: EvidenceBriefSection[] = [];

  sections.push({
    key: "status",
    title: "话题现状",
    lines: [
      `成员 ${pkg.memberCount} 条 · 平台 ${
        Object.entries(pkg.platformDistribution)
          .map(([k, v]) => `${platform(k)} ${v}`)
          .join("、") || "未知"
      }`,
      `选题机会指数 ${n(pkg.opportunityScore)}（置信 ${conf(pkg.opportunityConfidence)},档位 ${level(pkg.opportunityLevel)}）`,
      `话题趋势指数 ${n(pkg.trendScore)} · 生命周期 ${lifecycle(pkg.lifecycle)}`,
      `关键词：${pkg.topKeywords.slice(0, 8).join("、") || "无"}`,
    ],
  });

  sections.push({
    key: "positive",
    title: "正向信号",
    lines: pkg.positiveOpportunityReasons.length ? pkg.positiveOpportunityReasons : [],
    emptyNote: "当前证据没有形成正向信号（不代表话题差，只是尚未观测到）。",
  });

  sections.push({
    key: "limiting",
    title: "限制因素",
    lines: pkg.limitingOpportunityReasons.length ? pkg.limitingOpportunityReasons : [],
    emptyNote: "引擎未给出限制因素。",
  });

  sections.push({
    key: "angles",
    title: "新兴角度",
    lines: pkg.emergingAngles.map(
      (a) => `${a.label ?? "(未命名)"} · 成员 ${a.memberCount} · 新颖度 ${n(a.noveltyScore)}${a.isEmerging ? " · 已标记新兴" : ""}`,
    ),
    emptyNote: "暂未识别出新的表达角度（需要话题内出现一簇相近的新内容）。",
  });

  sections.push({
    key: "patterns",
    title: "爆发共性（观察到的关联，非因果）",
    lines: pkg.viralPatterns.map(
      (p) =>
        `${p.feature} · 爆发组 ${n(p.viralRate)} vs 对照组 ${n(p.controlRate)} · 差异倍数 ${n(p.lift)} · 证据质量 ${
          p.evidenceQuality ? QUALITY_ZH[p.evidenceQuality] ?? p.evidenceQuality : "未知"
        }`,
    ),
    emptyNote: "爆发内容样本不足，暂无法形成稳定共性（不做伪统计）。",
  });

  sections.push({
    key: "saturation",
    title: "同质化与新颖度",
    lines: [`饱和度 ${n(pkg.saturationScore)}（${pkg.saturationBand ?? "未知"}档） · 新颖度 ${n(pkg.noveltyScore)}`],
    emptyNote: "饱和度/新颖度尚未计算。",
  });

  const cautions: string[] = [];
  if (pkg.demoData) cautions.push("当前成员以演示/回放数据为主，以上数字不是真实市场结论。");
  if (pkg.dataFreshness.stale) cautions.push("部分引擎结果已超过新鲜度窗口，建议重跑「刷新全部分析」。");
  if (pkg.qualityMode.includes("lexical")) cautions.push("话题与角度为词法基线，升级为语义向量后更可靠。");
  if (Object.keys(pkg.trendUnavailableReasons ?? {}).length) {
    cautions.push(`趋势有组件不可用（权重已重归一）：${Object.values(pkg.trendUnavailableReasons ?? {}).join("；")}`);
  }
  if (pkg.evidenceTruncated.packageSize) cautions.push("证据过长已按预算裁剪，展示内容非全量。");
  sections.push({
    key: "caution",
    title: "读这些数字时要注意",
    lines: cautions,
    emptyNote: "无额外提醒。",
  });

  return {
    generatedAt: new Date(now).toISOString(),
    kind: "deterministic_evidence_brief",
    deterministic: true,
    isAiGenerated: false,
    topicId: pkg.topicId,
    topicName: pkg.topicName,
    sections,
  };
}
