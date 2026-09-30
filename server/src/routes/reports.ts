/**
 * 自动分析报告 —— 只从已算好的结果里派生,不推断、不编造。
 *
 * 两条红线:
 * 1. 任何指标都来自既有计算(评分 / 情报 / 机会 / 趋势),这里一个公式都不写;
 * 2. 缺数据就写「数据不足」,不拿 0 顶替 null。
 *
 * 输出两份:给人读的 `markdown`(可复制、可另存),和给界面渲染的 `data`
 * (结构化,前端用 `src/lib/format.ts` 的标签渲染 —— 报告文案的中文标签在服务端另有一份,
 * 由 `tests/unit/reportLabels.test.ts` 比对,防两侧漂移)。
 */
import express, { Router } from "express";
import type { DB } from "../db/client";
import { getPlatformCoverage } from "../services/statsService";
import { getAnalysisStatus } from "../analysis/status";
import { listTopicTrends } from "../scoring/repository";
import { describeSecretSource } from "../services/secrets/secretResolver";
import { clientOrServerError } from "./errors";
import {
  INGEST_KIND_LABELS,
  confidenceZh,
  formatDateTimeZh,
  levelZh,
  lifecycleZh,
  platformZh,
} from "../domain/labels";

type Row = Record<string, any>;

export interface ReportPlatform {
  platform: string;
  label: string;
  items: number;
  latestAt: string | null;
  missingTime: number;
  noMetric: number;
  clustered: number;
}

export interface ReportTopic {
  rank: number;
  topicId: number;
  name: string;
  members: number;
  opportunity: number | null;
  confidence: string | null;
  level: string | null;
  lifecycle: string | null;
  trend: number | null;
  saturation: number | null;
  novelty: number | null;
  angles: string[];
}

export interface ReportData {
  generatedAt: string;
  overview: { label: string; value: string; hint?: string }[];
  platforms: ReportPlatform[];
  topics: ReportTopic[];
  capabilities: { label: string; ok: boolean; detail: string }[];
  gaps: string[];
}

function num(v: unknown, digits = 1): string {
  if (v === null || v === undefined) return "数据不足";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, "") : "数据不足";
}

function pct(v: unknown): string {
  if (v === null || v === undefined) return "数据不足";
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "数据不足";
}

export async function buildAutoReport(db: DB): Promise<{ markdown: string; sections: number; data: ReportData }> {
  const status = await getAnalysisStatus(db);
  const d = status.data;
  const platforms = (await getPlatformCoverage(db)).map((p) => ({ ...p, label: platformZh(p.platform) }));

  // 用选题机会页同一套富化查询(带趋势/饱和/新颖/机会),不在报告里重算任何指标。
  // 注意 sortBy/dir/page/pageSize 都是必填用途 —— 之前传错键名导致 limit(undefined) 直接 500。
  const topicList = (await listTopicTrends(db, {
    page: 1,
    pageSize: 30,
    sortBy: "opportunity",
  })) as unknown as { rows?: Row[] } | Row[];
  const topicRows = Array.isArray(topicList) ? topicList : (topicList.rows ?? []);
  const ranked = [...topicRows]
    .filter((t) => Number(t.memberCount ?? 0) > 0)
    .sort((a, b) => Number(b.opportunityScore ?? -1) - Number(a.opportunityScore ?? -1));

  const topics: ReportTopic[] = ranked.slice(0, 12).map((t, i) => ({
    rank: i + 1,
    topicId: Number(t.topicId ?? t.id),
    name: String(t.name ?? ""),
    members: Number(t.memberCount ?? 0),
    opportunity: t.opportunityScore == null ? null : Number(t.opportunityScore),
    confidence: t.confidence == null ? null : String(t.confidence),
    level: t.opportunityLevel == null ? null : String(t.opportunityLevel),
    lifecycle: t.lifecycle == null ? null : String(t.lifecycle),
    trend: t.trendScore == null ? t.score == null ? null : Number(t.score) : Number(t.trendScore),
    saturation: t.saturationScore == null ? null : Number(t.saturationScore),
    novelty: t.noveltyScore == null ? null : Number(t.noveltyScore),
    angles: Array.isArray(t.emergingAngles) ? t.emergingAngles.map(String).slice(0, 4) : [],
  }));

  const overview: ReportData["overview"] = [
    { label: "内容总量", value: `${d.contentTotal} 条` },
    { label: "覆盖平台", value: `${platforms.length} 个`, hint: platforms.map((p) => p.label).join("、") },
    { label: "真实采集占比", value: pct(1 - (d.demoShare ?? 0) / 100), hint: `演示/回放 ${pct((d.demoShare ?? 0) / 100)}` },
    { label: "最近采集", value: formatDateTimeZh(d.latestCollectedAt) },
    {
      label: "入库方式",
      value: d.sourceKinds
        ? Object.entries(d.sourceKinds as Row).map(([k, v]) => `${INGEST_KIND_LABELS[k] ?? k} ${v}`).join(" · ")
        : "无",
    },
    {
      label: "语义方式",
      value: `${status.semantic.mode === "semantic" ? "真实向量" : "词法基线(精度较低)"} · ${status.semantic.dimension ?? "—"} 维`,
    },
    { label: "活跃话题", value: `${status.topics.active} 个`, hint: `${status.topics.total} 个话题,${status.topics.unclustered} 条内容未归类` },
    {
      label: "数据质量缺口",
      value: `缺发布时间 ${d.quality.missingPublishedAt} · 缺任一指标 ${d.quality.missingAnyMetric} · 缺作者 ${d.quality.missingAuthor}`,
    },
  ];

  const capabilities: ReportData["capabilities"] = [
    {
      label: "知乎凭证",
      ok: d.zhihuCredential === "configured",
      detail: describeSecretSource("secretref:env:ZHIHU_ACCESS_SECRET"),
    },
    {
      label: "语义向量",
      ok: status.semantic.embeddingCredential === "configured",
      detail: status.semantic.embeddingCredential === "configured"
        ? "真实向量已启用"
        : "未配置,使用词法基线",
    },
    {
      label: "AI 选题服务",
      ok: status.studio.configured,
      detail: status.studio.sourceDetail,
    },
  ];

  const gaps: string[] = [
    `未归类内容 ${status.topics.unclustered} 条:多为热榜类条目(只有标题+热度,缺正文与发布时间),需要多次采样才能成簇。`,
    ...platforms
      .filter((p) => p.missingTime > p.items * 0.5)
      .map((p) => `${p.label} 有 ${p.missingTime} 条缺发布时间(该源不提供发布时间,趋势只能按采集时间推断)。`),
  ];

  const lines: string[] = [];
  lines.push(`# 热点分析报告`);
  lines.push(``);
  lines.push(`生成时间:${formatDateTimeZh(status.generatedAt)} · 数据来源:本机已采集内容,未使用任何外部推断。`);
  lines.push(``);

  lines.push(`## 一、数据面`);
  lines.push(``);
  lines.push(`| 项 | 数值 |`);
  lines.push(`| --- | --- |`);
  for (const o of overview) lines.push(`| ${o.label} | ${o.value}${o.hint && o.hint !== o.value ? `(${o.hint})` : ""} |`);
  lines.push(``);

  lines.push(`## 二、平台覆盖`);
  lines.push(``);
  lines.push(`| 平台 | 条数 | 最近采集 | 已归类 | 缺发布时间 | 缺任一指标 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  if (platforms.length === 0) lines.push(`| — | 尚无数据 | — | — | — | — |`);
  for (const p of platforms) {
    lines.push(
      `| ${p.label} | ${p.items} | ${formatDateTimeZh(p.latestAt)} | ${p.clustered} | ${p.missingTime} | ${p.noMetric} |`,
    );
  }
  lines.push(``);

  lines.push(`## 三、话题与机会排名`);
  lines.push(``);
  lines.push(`| 名次 | 话题 | 成员 | 机会指数 | 置信度 | 生命周期 | 饱和度 | 新颖度 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  if (topics.length === 0) lines.push(`| — | 尚无成簇话题(需要更多次采样累积) | — | — | — | — | — | — |`);
  for (const t of topics) {
    lines.push(
      `| ${t.rank} | ${t.name} (id ${t.topicId}) | ${t.members} | ${num(t.opportunity)} | ${confidenceZh(t.confidence)} | ${lifecycleZh(t.lifecycle)} | ${num(t.saturation)} | ${num(t.novelty)} |`,
    );
  }
  lines.push(``);

  lines.push(`## 四、选题建议(每条都指向具体证据)`);
  lines.push(``);
  if (topics.length === 0) {
    lines.push(`当前没有可支撑选题的话题簇 —— 结论:数据不足,先增加采集频次或扩大渠道,不做无依据建议。`);
  }
  for (const t of topics.slice(0, 6)) {
    lines.push(`### ${t.name}`);
    lines.push(``);
    lines.push(
      `- 机会指数 **${num(t.opportunity)}**(置信度 ${confidenceZh(t.confidence)} · 档位 ${levelZh(t.level)}) · 生命周期 ${lifecycleZh(t.lifecycle)} · 成员 ${t.members} 条`,
    );
    lines.push(`- 饱和度 ${num(t.saturation)} / 新颖度 ${num(t.novelty)} —— 饱和高=同类切法已多,新颖高=还有空白角度`);
    lines.push(`- 尚未被覆盖的角度:${t.angles.length ? t.angles.join("、") : "数据不足(需要内容情报步骤产出新兴角度)"}`);
    lines.push(`- 证据出处:\`topic:${t.topicId}\` · \`members:${t.members}\` · \`opportunity:${num(t.opportunity)}\``);
    lines.push(``);
  }

  lines.push(`## 五、外部能力与缺口`);
  lines.push(``);
  for (const c of capabilities) lines.push(`- ${c.label}:${c.ok ? "已配置" : "未配置"}(${c.detail})`);
  for (const g of gaps) lines.push(`- ${g}`);
  lines.push(``);
  lines.push(`> 本报告全部字段来自本机已算好的结果;凡缺数据处均标注"数据不足",不做推断。`);

  return {
    markdown: lines.join("\n"),
    sections: 5,
    data: {
      generatedAt: status.generatedAt,
      overview,
      platforms,
      topics,
      capabilities,
      gaps,
    },
  };
}

export function createReportsRouter(db: DB): Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  const send = async (res: express.Response) => {
    try {
      const { markdown, sections, data } = await buildAutoReport(db);
      res.json({ ok: true, sections, format: "markdown", markdown, data });
    } catch (e) {
      clientOrServerError(res, "report", e);
    }
  };

  router.get("/latest", (_req, res) => void send(res));
  router.post("/generate", (_req, res) => void send(res));

  return router;
}
