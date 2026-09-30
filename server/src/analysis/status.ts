/**
 * 分析状态总览(Release 1.0 · WP2 §32/§33/§36/§40)。
 *
 * 这是"产品走到哪一步了"的唯一回答处:首页卡片、首次使用引导、各页面的依赖提示
 * 都读它 —— 不允许每个页面各自拼 SQL,否则同一个事实会在三处给出三个答案。
 * 未知一律 null,不折算成 0。
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  collectionRuns,
  collectionTasks,
  contentEmbeddings,
  contentItems,
  embeddingSpaces,
  topicAnalysisRuns,
  topicMemberships,
  topics,
} from "../db/schema";
import { getDataHealth } from "../services/healthService";
import { studioSettings } from "../studio/studioSettings";
import { resolveSecretRef } from "../services/secrets/secretResolver";
import { coverageView } from "./coverage";
import { autoAnalysisSnapshot, type AutoAnalysisState } from "./autoAnalysis";

export interface GuideStep {
  key: "data" | "semantic" | "topics" | "analysis" | "studio";
  state: "done" | "todo" | "optional" | "blocked";
  label: string;
  detail: string;
  /** 前端据此跳到该步骤的操作位置(§40 一键进入对应操作) */
  route: string;
}

export interface AnalysisStatus {
  generatedAt: string;
  isEmpty: boolean;
  data: {
    contentTotal: number;
    /** 数据来源构成 —— 演示数据必须看得出来是演示数据(§34) */
    sourceKinds: Record<string, number>;
    demoShare: number | null;
    latestCollectedAt: string | null;
    latestRun: { id: number; status: string; startedAt: string | null; completedAt: string | null } | null;
    runningRuns: number;
    enabledTasks: number;
    quality: { missingPublishedAt: number; missingAnyMetric: number; missingAuthor: number };
    zhihuCredential: "configured" | "missing";
  };
  semantic: {
    /** none = 还没跑过;lexical = 只有词法基线;semantic = 已用语义向量空间 */
    mode: "none" | "lexical" | "semantic";
    activeSpaceId: string | null;
    dimension: number | null;
    embedded: number;
    pending: number;
    embeddingCredential: "configured" | "missing";
  };
  topics: {
    total: number;
    active: number;
    unclustered: number;
    lastRun: { id: number; status: string; createdAt: string; completedAt: string | null; topicsCreated: number } | null;
  };
  engines: {
    contentBurst: { scored: number; total: number; lastCalculatedAt: string | null };
    topicTrend: { scored: number; total: number; lastCalculatedAt: string | null };
    intelligence: { scored: number; total: number; lastCalculatedAt: string | null };
    opportunity: { scored: number; total: number; lastCalculatedAt: string | null };
  };
  studio: { configured: boolean; secretStatus: "configured" | "missing"; source: "api" | "local-cli" | "none"; sourceDetail: string };
  autoAnalysis: AutoAnalysisState;
  /** 首次使用引导(§33):顺序即产品主路径 */
  guide: GuideStep[];
}

const num = (v: unknown): number => Number(v ?? 0);

export async function getAnalysisStatus(db: DB, now = Date.now()): Promise<AnalysisStatus> {
  const contentTotal = num((await db.select({ c: count() }).from(contentItems))[0]?.c);

  const sourceRows = await db.select({ kind: contentItems.sourceType, c: count() }).from(contentItems).groupBy(contentItems.sourceType);
  const sourceKinds: Record<string, number> = {};
  for (const s of sourceRows) sourceKinds[String(s.kind ?? "unknown")] = num(s.c);
  const demoRows = (sourceKinds.fixture ?? 0) + (sourceKinds.replay ?? 0);
  const demoShare = contentTotal > 0 ? Math.round((demoRows / contentTotal) * 1000) / 10 : null;

  const latestCollectedAt = (await db.select({ t: sql<string | null>`max(${contentItems.collectedAt})` }).from(contentItems))[0]?.t ?? null;
  const runningRuns = num((await db.select({ c: count() }).from(collectionRuns).where(eq(collectionRuns.status, "running")))[0]?.c);
  const enabledTasks = num((await db.select({ c: count() }).from(collectionTasks).where(eq(collectionTasks.enabled, 1)))[0]?.c);
  // embedded / pending 在解析出激活空间之后再算 —— 见下面"与聚类同一判据"那段
  const topicAgg =
    (
      await db
        .select({
          total: count(),
          active: sql<number>`sum(case when ${topics.status} = 'active' then 1 else 0 end)`,
        })
        .from(topics)
    )[0] ?? { total: 0, active: 0 };
  const unclustered = num(
    (
      await db
        .select({ c: count() })
        .from(contentItems)
        .leftJoin(topicMemberships, eq(topicMemberships.contentItemId, contentItems.id))
        .where(sql`${topicMemberships.id} IS NULL`)
    )[0]?.c,
  );
  const latestRun = (
    await db
      .select({
        id: collectionRuns.id,
        status: collectionRuns.status,
        startedAt: collectionRuns.startedAt,
        completedAt: collectionRuns.completedAt,
      })
      .from(collectionRuns)
      .orderBy(sql`${collectionRuns.createdAt} desc`)
      .limit(1)
  )[0];
  const lastAnalysis = (
    await db
      .select({
        id: topicAnalysisRuns.id,
        status: topicAnalysisRuns.status,
        createdAt: topicAnalysisRuns.createdAt,
        completedAt: topicAnalysisRuns.completedAt,
        topicsCreated: topicAnalysisRuns.topicsCreated,
      })
      .from(topicAnalysisRuns)
      .orderBy(sql`${topicAnalysisRuns.createdAt} desc`)
      .limit(1)
  )[0];

  const spaces = await db.select().from(embeddingSpaces);
  const activeSpace = spaces.find((s) => s.isActive === 1) ?? null;
  /*
   * "已建 / 待处理"必须和聚类那一步用**同一个判据**:激活空间里、未被作废的向量。
   * 原来 embedded 数的是 content_embeddings 全表行数(含已作废的历史行、也含另一个词法空间),
   * pending 用的是不带任何过滤的 left join(只要在任何空间有过一行就算已建)。
   * 真机代价:库里 577 条内容的向量行被误标 superseded 后,界面显示「4,057 条已建 / 1 条待处理」,
   * 而话题分析每轮报「576 条内容缺少向量」并失败 —— 同一个文件顶上的注释说的就是这种分裂。
   */
  const liveInActiveSpace = activeSpace
    ? and(eq(contentEmbeddings.embeddingSpaceId, activeSpace.id), isNull(contentEmbeddings.supersededAt))
    : sql`0`;
  const embedded = num((await db.select({ c: count() }).from(contentEmbeddings).where(liveInActiveSpace))[0]?.c);
  const pending = num(
    (
      await db
        .select({ c: count() })
        .from(contentItems)
        .leftJoin(contentEmbeddings, and(eq(contentEmbeddings.contentItemId, contentItems.id), liveInActiveSpace))
        .where(sql`${contentEmbeddings.id} IS NULL`)
    )[0]?.c,
  );
  const health = await getDataHealth(db);
  const [contentBurst, topicTrend, intelligence, opportunity] = await coverageView(db);
  const zhihuCred = resolveSecretRef("secretref:env:ZHIHU_ACCESS_SECRET");
  const embedCred = resolveSecretRef("secretref:env:EMBEDDING_API_KEY");
  const studio = studioSettings();
  const topicTotal = num(topicAgg.total);

  const status: AnalysisStatus = {
    generatedAt: new Date(now).toISOString(),
    isEmpty: contentTotal === 0,
    data: {
      contentTotal,
      sourceKinds,
      demoShare,
      latestCollectedAt,
      latestRun: latestRun
        ? { id: latestRun.id, status: latestRun.status, startedAt: latestRun.startedAt, completedAt: latestRun.completedAt }
        : null,
      runningRuns,
      enabledTasks,
      quality: {
        missingPublishedAt: health.missingPublishedAt,
        missingAnyMetric: health.missingAnyMetric,
        missingAuthor: health.missingAuthor,
      },
      zhihuCredential: zhihuCred.ok ? "configured" : "missing",
    },
    semantic: {
      mode: !activeSpace ? "none" : activeSpace.provider === "openai-compatible" ? "semantic" : "lexical",
      activeSpaceId: activeSpace?.id ?? null,
      dimension: activeSpace?.dimension ?? null,
      embedded,
      pending,
      embeddingCredential: embedCred.ok ? "configured" : "missing",
    },
    topics: {
      total: topicTotal,
      active: num(topicAgg.active),
      unclustered,
      lastRun: lastAnalysis
        ? {
            id: lastAnalysis.id,
            status: lastAnalysis.status,
            createdAt: lastAnalysis.createdAt,
            completedAt: lastAnalysis.completedAt,
            topicsCreated: num(lastAnalysis.topicsCreated),
          }
        : null,
    },
    engines: {
      contentBurst,
      topicTrend: { ...topicTrend, total: topicTotal },
      intelligence: { ...intelligence, total: topicTotal },
      opportunity: { ...opportunity, total: topicTotal },
    },
    studio: { configured: studio.configured, secretStatus: studio.secretStatus, source: studio.source, sourceDetail: studio.sourceDetail },
    autoAnalysis: autoAnalysisSnapshot(),
    guide: [],
  };

  status.guide = buildGuide(status);
  return status;
}

/** 首次使用引导(§33):顺序即主路径,每一步都说清"到哪了 / 下一步去哪"。 */
export function buildGuide(s: AnalysisStatus): GuideStep[] {
  const steps: GuideStep[] = [];
  steps.push(
    s.data.contentTotal > 0
      ? { key: "data", state: "done", label: "导入或采集数据", detail: `已有 ${s.data.contentTotal} 条内容。`, route: "/import" }
      : {
          key: "data",
          state: "todo",
          label: "导入或采集数据",
          detail: "还没有任何内容 —— 后面所有分析都以内容为输入。",
          route: "/import",
        },
  );

  const sem = s.semantic;
  steps.push(
    sem.mode === "none"
      ? {
          key: "semantic",
          state: "todo",
          label: "运行语义分析",
          detail:
            sem.embeddingCredential === "configured"
              ? "已配置向量服务,运行后可用语义相似度与语义话题。"
              : "未配置向量服务:可先运行本地词法基线,之后随时升级。",
          route: "/semantic",
        }
      : {
          key: "semantic",
          state: sem.pending > 0 ? "todo" : "done",
          label: "运行语义分析",
          detail: `${sem.mode === "lexical" ? "本地词法基线" : "语义向量"}:${sem.embedded} 条已向量化${
            sem.pending > 0 ? `,${sem.pending} 条待处理` : ""
          }。`,
          route: "/semantic",
        },
  );

  steps.push(
    s.topics.total === 0
      ? { key: "topics", state: "todo", label: "运行话题分析", detail: "还没有话题;话题是把内容聚成可分析对象的单位。", route: "/topics" }
      : {
          key: "topics",
          state: s.topics.unclustered > 0 ? "todo" : "done",
          label: "运行话题分析",
          detail: `${s.topics.active} 个活跃话题${s.topics.unclustered > 0 ? `,${s.topics.unclustered} 条内容尚未归类` : ""}。`,
          route: "/topics",
        },
  );

  const e = s.engines;
  const analysisDone = e.contentBurst.scored > 0 && e.topicTrend.scored > 0 && e.intelligence.scored > 0 && e.opportunity.scored > 0;
  steps.push({
    key: "analysis",
    state: analysisDone ? "done" : s.topics.total === 0 ? "blocked" : "todo",
    label: "运行趋势 / 情报 / 机会分析",
    detail: analysisDone
      ? `已评分内容 ${e.contentBurst.scored} 条 · 话题趋势 ${e.topicTrend.scored} 个 · 机会 ${e.opportunity.scored} 个。`
      : s.topics.total === 0
        ? "需要先有话题,才能算趋势与机会。"
        : "分析结果不完整,用首页「刷新全部分析」一次按序跑完。",
    route: analysisDone ? "/trends" : "/dashboard",
  });

  steps.push({
    key: "studio",
    state: s.studio.configured ? "done" : "optional",
    label: "配置 AI 生成服务(可选)",
    detail: s.studio.configured ? "选题工作室可用;不配置也不影响其余功能。" : "未配置 AI 服务:选题工作室仍提供确定性证据摘要,只是不生成方案。",
    route: "/studio",
  });
  return steps;
}
