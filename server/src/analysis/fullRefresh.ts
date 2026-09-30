/**
 * 一键全分析(Release 1.0 · WP2 §37-§39)。
 *
 * 三条不可协商的规矩:
 *  1. **只按序调用既有引擎**,这里不拥有任何业务逻辑 —— 编排器复制评分规则就等于造第二个真相;
 *  2. 每一步成功即落库,失败只停住自己与后续步骤,**不回滚前序结果**(§39);
 *  3. **绝不批量生成 AI 方案**(§37):选题方案只能由人在选题工作室单点生成。
 *
 * 进度写进 analysis_runs,页面刷新后仍然能看到"跑到哪一步 / 哪一步失败 / 为什么"(§38)。
 */
import { count, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { embeddingJobs, topicAnalysisRuns } from "../db/schema";
import { runContentScoring, runTopicTrendScoring } from "../scoring/service";
import { runIntelligence } from "../intelligence/service";
import { runOpportunity } from "../opportunity/service";
import { beginRun, conflictMessage, endRun, type EngineName } from "../services/engineLock";
import { getAnalysisStatus } from "./status";
import { resolveEmbeddingProvider } from "../semantic/providerFactory";
import { activateSpace, ensureSpaceProbed, getActiveSpace } from "../semantic/vectorRepository";
import { createEmbeddingJob, runEmbeddingJob } from "../semantic/embeddingService";
import { createAnalysisRun, runTopicAnalysis } from "../topics/analysis";
import { defaultConfigFor, mergeConfig } from "../topics/config";
import { topicNameProviderIfConfigured } from "../topics/nameProvider";
import { KeywordFallbackNaming } from "../topics/keywords";
import { blankSteps, createRun, finishRun, updateRun } from "./repository";
import type { FullRefreshResult, RefreshStep } from "./types";

export const REFRESH_ENGINES: EngineName[] = ["content", "trend", "intelligence", "opportunity"];

const num = (v: unknown): number => Number(v ?? 0);
const iso = () => new Date().toISOString();

interface StepDef {
  key: string;
  label: string;
  /** null = 需要跑;字符串 = 跳过原因(§37 "if needed" 必须可解释,不能静默消失) */
  gate: (db: DB) => Promise<string | null>;
  run: (db: DB, ctx: StepContext) => Promise<Record<string, unknown> | null>;
}

interface StepContext {
  /** manual | first-run | after-collection —— 自动补算不该消耗用户的模型登录态/额度 */
  trigger: string;
}

const isAutoPass = (ctx: StepContext) => ctx.trigger === "after-collection";

/** 同一引擎已有排队/进行中的任务时不再叠加启动(§72)。 */
async function busyReason(db: DB, table: typeof embeddingJobs | typeof topicAnalysisRuns): Promise<string | null> {
  const rows = await db.select({ c: count() }).from(table).where(inArray(table.status, ["queued", "running"]));
  return num(rows[0]?.c) > 0 ? "已有同类任务在进行中,本次跳过(不重复启动)。" : null;
}

async function topicCount(db: DB): Promise<number> {
  const rows = await db.select({ c: count() }).from(sql.raw("topics"));
  return num(rows[0]?.c);
}

export const STEP_DEFS: StepDef[] = [
  {
    key: "embedding",
    label: "更新内容向量",
    // 这一步总是执行:scope=missing 时没有待处理项就是空跑,
    // 但它同时保证"后面一定有可用的向量空间",不必让 UI 猜。
    gate: (db) => busyReason(db, embeddingJobs),
    run: async (db) => {
      const before = await getActiveSpace(db);
      const resolved = await resolveEmbeddingProvider(db, {});
      const space = await ensureSpaceProbed(db, resolved.provider);
      // 只在"还没有空间"或"词法→语义升级"时切换激活空间;永不静默降级(§50 同源约束)
      const upgrade = !before || (before.mode === "lexical" && space.mode === "api");
      if (upgrade) await activateSpace(db, space.id);
      const jobId = await createEmbeddingJob(db, space.id, "missing");
      const r = await runEmbeddingJob(db, jobId, resolved.provider);
      return {
        jobId,
        mode: resolved.source,
        status: r.status,
        total: r.total,
        succeeded: r.succeeded,
        failed: r.failed,
        skipped: r.skipped,
        spaceUpgraded: upgrade,
        note: resolved.reason,
      };
    },
  },
  {
    key: "topics",
    label: "话题分析",
    // 首跑必聚类;之后只在"有未归类内容"时做增量归入 —— 聚类器不会改动已有话题的成员
    // 与人工命名(实测:手动命名的话题在增量运行后仍保持原名原成员),
    // 而完全不跑的话,新采集的内容永远进不了话题/趋势/机会。
    gate: async (db) => {
      const status = await getAnalysisStatus(db);
      if (status.data.contentTotal === 0) return "还没有内容,无法聚类话题。";
      if (!status.semantic.activeSpaceId) return "还没有可用的向量空间:请先在语义中心运行向量化。";
      if (status.topics.total > 0 && status.topics.unclustered === 0) {
        return `已有 ${status.topics.active} 个活跃话题,且没有未归类内容;需要重新全量聚类请到「话题」页面手动运行(会保留人工命名)。`;
      }
      return busyReason(db, topicAnalysisRuns);
    },
    run: async (db, ctx) => {
      const space = await getActiveSpace(db);
      if (!space) throw new Error("没有激活的 Embedding Space");
      const cfg = mergeConfig(defaultConfigFor(space.mode), undefined as never);
      // 没有 AI 命名服务时回退到关键词命名(§19 已实现,只是这里之前没接上):
      // 之前传 undefined,于是所有新簇都落成"未命名话题"。
      // 自动补算这一路刻意只用关键词命名 —— AI 命名可能是本机登录态(按次消耗额度),
      // 每 30 分钟的定时采集都触发一次、每次给十几个簇起名,不该悄悄花用户的模型额度;
      // 想要 AI 名字请到「分析」页手动点一次全分析。
      const nameProvider = isAutoPass(ctx)
        ? new KeywordFallbackNaming()
        : topicNameProviderIfConfigured() ?? new KeywordFallbackNaming();
      let runId = await createAnalysisRun(db, space, {}, cfg);
      let r = await runTopicAnalysis(db, runId, { nameProvider } as never);
      let reembeddedAfterMissing = 0;
      let failureNote: string | null = null;

      if (r.status === "failed") {
        // 聚类开始之后又有内容落库(一键抓多平台时,十几个采集运行是并行收尾的),
        // 这批条目就没有向量。给人看的界面可以提示"请先运行向量化",
        // 自动流程没有人可点 —— 这一步的上一步就是向量化,正确做法是补一次再聚一次。
        try {
          const resolved = await resolveEmbeddingProvider(db, {});
          const jobId = await createEmbeddingJob(db, space.id, "missing");
          const ej = await runEmbeddingJob(db, jobId, resolved.provider);
          reembeddedAfterMissing = ej.succeeded;
          // 刻意不看 ej.succeeded:采集触发的那次自动补算可能正在并行跑同一批缺向量条目,
          // 它把向量补齐了,本次这个任务就只会报 succeeded=0。以"再试一次聚类"为准:
          // 仍缺向量时 runTopicAnalysis 在聚类前的检查里就返回 failed(analysis.ts 第 2 步),不会白跑。
          runId = await createAnalysisRun(db, space, {}, cfg);
          r = await runTopicAnalysis(db, runId, { nameProvider } as never);
        } catch (e) {
          failureNote = e instanceof Error ? e.message : String(e);
        }
      }

      if (r.status === "failed") {
        // 仍然失败必须让这一步显示为失败。此前它把 status 放进 result 就 return,
        // 于是整轮以 completed 收官:autoAnalysis 报"已完成",话题表里却是 failed + 0 个话题。
        const [row] = await db
          .select({ error: topicAnalysisRuns.error })
          .from(topicAnalysisRuns)
          .where(eq(topicAnalysisRuns.id, runId));
        throw new Error(row?.error ?? failureNote ?? "话题分析失败");
      }

      return {
        analysisRunId: runId,
        status: r.status,
        topicCount: r.report.topicCount,
        averageCohesion: r.report.averageCohesion,
        unclusteredRate: r.report.unclusteredRate,
        needsReviewCount: r.report.needsReviewCount,
        durationMs: r.timings.totalMs,
        ...(reembeddedAfterMissing > 0 ? { reembeddedAfterMissing } : {}),
      };
    },
  },
  {
    key: "scoring",
    label: "内容爆发指数",
    gate: async () => null,
    run: async (db) => {
      const r = await runContentScoring(db);
      return {
        runId: r.runId,
        contentCount: r.contentCount,
        scorableCount: r.scorableCount,
        unscorableCount: r.unscorableCount,
        durationMs: r.durationMs,
      };
    },
  },
  {
    key: "trend",
    label: "话题趋势与生命周期",
    gate: async (db) => ((await topicCount(db)) > 0 ? null : "还没有话题:趋势以话题为分析对象,请先运行话题分析。"),
    run: async (db) => {
      const r = await runTopicTrendScoring(db);
      return {
        runId: r.runId,
        topicCount: r.topicCount,
        scorableCount: r.scorableCount,
        unscorableCount: r.unscorableCount,
        transitions: r.lifecycleTransitions.length,
        durationMs: r.durationMs,
      };
    },
  },
  {
    key: "intelligence",
    label: "爆发共性与饱和度",
    gate: async (db) => ((await topicCount(db)) > 0 ? null : "还没有话题:共性对比以话题为分组,请先运行话题分析。"),
    run: async (db) => {
      const r = await runIntelligence(db);
      return {
        runId: r.runId,
        topicsAnalyzed: r.topicsAnalyzed,
        contentsAnalyzed: r.contentsAnalyzed,
        patternScorable: r.patternScorable,
        patternInsufficient: r.patternInsufficient,
        emergingAngleCount: r.emergingAngleCount,
        durationMs: r.durationMs,
      };
    },
  },
  {
    key: "opportunity",
    label: "选题机会指数",
    gate: async (db) => ((await topicCount(db)) > 0 ? null : "还没有话题:机会指数按话题计算,请先运行话题分析。"),
    run: async (db) => {
      const r = await runOpportunity(db);
      return {
        runId: r.runId,
        profileId: r.profileId,
        topicsConsidered: r.topicsConsidered,
        scored: r.scored,
        unscorable: r.unscorable,
        durationMs: r.durationMs,
      };
    },
  },
];

const LEGACY_KEY: Record<string, "scoring" | "trend" | "intelligence" | "opportunity"> = {
  scoring: "scoring",
  trend: "trend",
  intelligence: "intelligence",
  opportunity: "opportunity",
};

export interface RunOptions {
  trigger?: string;
  /** 调用方已占住引擎锁(例如经 withEngineLock) */
  preAcquired?: boolean;
  now?: number;
}

export async function runFullRefresh(db: DB, opts: RunOptions = {}): Promise<FullRefreshResult> {
  const started = opts.now ?? Date.now();
  if (!opts.preAcquired) {
    const lock = beginRun(REFRESH_ENGINES);
    if (!lock.ok) throw new Error(conflictMessage(lock.conflicts));
  }
  let runId = 0;
  const steps: RefreshStep[] = blankSteps();
  const legacy: Record<string, Record<string, unknown> | null> = { scoring: null, trend: null, intelligence: null, opportunity: null };
  try {
    const run = await createRun(db, { trigger: opts.trigger ?? "manual", steps, now: new Date(started).toISOString() });
    runId = run.id;
    let failure: string | null = null;
    let completed = 0;
    let skipped = 0;

    for (let i = 0; i < STEP_DEFS.length; i++) {
      const def = STEP_DEFS[i];
      const step = steps[i];
      const reason = await def.gate(db);
      if (reason !== null) {
        step.state = "skipped";
        step.error = reason;
        step.startedAt = iso();
        step.finishedAt = step.startedAt;
        skipped += 1;
        await updateRun(db, runId, { steps, currentStep: null });
        continue;
      }
      step.state = "running";
      step.startedAt = iso();
      await updateRun(db, runId, { steps, currentStep: def.key });
      try {
        const result = await def.run(db, { trigger: opts.trigger ?? "manual" });
        step.state = "completed";
        step.result = result;
        completed += 1;
        const key = LEGACY_KEY[def.key];
        if (key) legacy[key] = result;
      } catch (e) {
        step.state = "failed";
        step.error = e instanceof Error ? e.message : String(e);
        failure = `${def.label}失败:${step.error}`;
        step.finishedAt = iso();
        await updateRun(db, runId, { steps, currentStep: null });
        break;
      }
      step.finishedAt = iso();
      await updateRun(db, runId, { steps, currentStep: null });
    }

    const status: FullRefreshResult["status"] = failure
      ? completed > 0
        ? "partial"
        : "failed"
      : completed === 0 && skipped > 0
        ? "partial"
        : "completed";
    const durationMs = Date.now() - started;
    await finishRun(db, runId, { status, steps, error: failure, durationMs, now: iso() });
    return {
      id: runId,
      runId,
      status,
      triggerSource: opts.trigger ?? "manual",
      currentStep: null,
      steps,
      error: failure,
      startedAt: new Date(started).toISOString(),
      finishedAt: iso(),
      durationMs,
      scoring: legacy.scoring,
      trend: legacy.trend,
      intelligence: legacy.intelligence,
      opportunity: legacy.opportunity,
    };
  } finally {
    if (!opts.preAcquired) endRun(REFRESH_ENGINES);
  }
}
