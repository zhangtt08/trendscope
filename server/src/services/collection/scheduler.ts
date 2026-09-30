/**
 * Local scheduler (Stage 4 §15/§16).
 *
 - Interval schedules ("every N minutes/hours") persisted on
 *   collection_tasks.next_run_at; manual tasks never get a next_run_at.
 * - Restart recovery (§16): a crash must NOT silently lose scheduled tasks and
 *   must NOT mark unfinished runs as completed — unfinished runs become
 *   failed/INTERRUPTED, and a surviving checkpoint keeps them resumable.
 * - No cron dependency (not required this stage); tick is injectable for tests
 *   (fake-clock friendly: tests call tick() manually).
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { DB } from "../../db/client";
import { collectionRuns, collectionTasks, embeddingJobs, topicAnalysisRuns } from "../../db/schema";
import { CollectionRuntime } from "./runtime";

const INTERVAL_MARK = '%"type":"interval"%';

export class CollectionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly db: DB,
    private readonly runtime: CollectionRuntime,
    private readonly tickIntervalMs = 15_000,
  ) {}

  start(): void {
    this.recover();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error("[scheduler] 调度轮询失败:", e));
    }, this.tickIntervalMs);
    // fire one immediate tick so persisted nextRunAt in the past runs right away
    void this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * §16 Restart recovery. Deterministic, idempotent, called on every boot:
   * 1. runs stuck in queued/running → failed with INTERRUPTED (never
   *    completed); checkpoint column keeps them resumable (§38).
   * 2. enabled interval tasks without next_run_at → scheduled for "now".
   * 3. stuck embedding jobs / topic-analysis runs → failed, so the
   *    "已有同类任务在跑" guard in fullRefresh can't stay true forever.
   */
  recover(): {
    interruptedRuns: number;
    rescheduledTasks: number;
    interruptedEmbeddings: number;
    interruptedAnalyses: number;
  } {
    const now = new Date().toISOString();

    const interrupted = this.db
      .update(collectionRuns)
      .set({
        status: "failed",
        errorCode: "INTERRUPTED",
        errorMessage: "application restarted while the run was active (resumable if checkpoint exists)",
        completedAt: now,
      })
      .where(sql`${collectionRuns.status} IN ('queued', 'running')`)
      .run();
    const interruptedRuns = interrupted.changes ?? 0;

    const rescheduled = this.db
      .update(collectionTasks)
      .set({ nextRunAt: now, updatedAt: now })
      .where(
        and(
          eq(collectionTasks.enabled, 1),
          isNull(collectionTasks.nextRunAt),
          sql`${collectionTasks.schedule} LIKE ${INTERVAL_MARK}`,
        ),
      )
      .run();
    const rescheduledTasks = rescheduled.changes ?? 0;

    // 3. 向量作业与话题分析运行同样要恢复。fullRefresh 判"是否已有同类任务在跑"
    //    只看 status in (queued, running):进程被杀/重启后留下的孤儿行会让
    //    **每一次**自动补算都跳过这两步,而且界面只显示"已跳过",看不出原因。
    //    实测账目:3 条 running 的向量作业 + 1 条 running 的话题分析,
    //    让向量化从 09-29 19:53 起到 09-30 上午约 14 小时零增长(2,909 条内容里 703 条没有向量)。
    const interruptedEmb = this.db
      .update(embeddingJobs)
      .set({
        status: "failed",
        error: "应用重启时该作业仍在进行(内容没有变化,重新发起即可继续;已算好的向量不会重算)",
        completedAt: now,
      })
      .where(sql`${embeddingJobs.status} IN ('queued', 'running')`)
      .run();
    const interruptedTopicRuns = this.db
      .update(topicAnalysisRuns)
      .set({
        status: "failed",
        error: "应用重启时该分析仍在进行(可重新发起)",
        completedAt: now,
      })
      .where(sql`${topicAnalysisRuns.status} IN ('queued', 'running')`)
      .run();

    const interruptedEmbeddings = interruptedEmb.changes ?? 0;
    const interruptedAnalyses = interruptedTopicRuns.changes ?? 0;
    if (interruptedRuns > 0 || rescheduledTasks > 0 || interruptedEmbeddings > 0 || interruptedAnalyses > 0) {
      console.log(
        `[scheduler] 恢复:标记 ${interruptedRuns} 条中断的采集运行,重排 ${rescheduledTasks} 个定时任务,` +
          `释放 ${interruptedEmbeddings} 条中断的向量作业与 ${interruptedAnalyses} 条中断的话题分析`,
      );
    }
    return { interruptedRuns, rescheduledTasks, interruptedEmbeddings, interruptedAnalyses };
  }

  /** One scheduling pass: run every enabled interval task whose next_run_at ≤ now. */
  async tick(now: Date = new Date()): Promise<{ triggered: number; skipped: number }> {
    const nowIso = now.toISOString();
    const due = await this.db
      .select({
        id: collectionTasks.id,
        schedule: collectionTasks.schedule,
      })
      .from(collectionTasks)
      .where(
        and(
          eq(collectionTasks.enabled, 1),
          lte(collectionTasks.nextRunAt, nowIso),
          sql`${collectionTasks.schedule} LIKE ${INTERVAL_MARK}`,
        ),
      );

    let triggered = 0;
    let skipped = 0;
    for (const task of due) {
      const intervalMs = parseIntervalMs(task.schedule);
      if (intervalMs === null) {
        skipped += 1;
        continue;
      }
      const result = await this.runtime.runTask(task.id, "schedule");
      if (result.ok) triggered += 1;
      else skipped += 1; // already_running / disabled — next tick will retry

      // persist next window regardless of outcome (no busy-looping on failures)
      const next = new Date(now.getTime() + intervalMs).toISOString();
      await this.db
        .update(collectionTasks)
        .set({ nextRunAt: next, updatedAt: nowIso })
        .where(eq(collectionTasks.id, task.id));
    }
    return { triggered, skipped };
  }
}

function parseIntervalMs(schedule: string | null): number | null {
  if (!schedule) return null;
  try {
    const s = JSON.parse(schedule) as { type?: string; intervalMs?: number };
    if (s.type !== "interval" || typeof s.intervalMs !== "number") return null;
    if (s.intervalMs < 60_000) return null; // floor: 1 minute
    return s.intervalMs;
  } catch {
    return null;
  }
}
