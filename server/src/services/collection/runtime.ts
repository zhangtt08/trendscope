/**
 * Collection runtime (Stage 4): orchestrates
 *   Task → Run(queued) → queue → running
 *        → per page: rate-limit → retry → collectPage → schema gate
 *          → EXISTING import pipeline (importRowsIntoBatch) → checkpoint
 *        → completed | partial | failed | cancelled
 *
 * 不变式:
 * - RawRecord → ContentItem 只有一条路径:importService.processRow(禁止第二套)。
 * - 调度核心不理解 keyword/cursor/search_id 等平台细节;cursor 对核心是不透明
 *   字符串,由 Connector 自己编解码(§9)。
 * - CollectionRun(外部获取)与 ImportBatch(进入标准管线)分离,经
 *   collection_runs.import_batch_id 关联(§6)。
 * - 每成功一页保存 checkpoint;重复获取由 Stage 1 去重兜底,不会产生重复
 *   ContentItem(§10)。
 * - 用户覆盖的 rate limit 只允许"更保守"(§11);无任何绕过平台限制的逻辑。
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db/client";
import {
  collectionRuns,
  collectionRunEvents,
  collectionTasks,
  contentDiscoveryObservations,
  importBatches,
} from "../../db/schema";
import type { Connector } from "../../connectors/types";
import type { RunLogger } from "../../connectors/types";
import { redactData } from "../../connectors/types";
import {
  ConnectorError,
  ConnectorCircuitBreaker,
  RateLimiter,
  RateLimitConfigSchema,
  computeBackoff,
  isAbortError,
  type PageResult,
  type RemotePageRequest,
  type RateLimitConfig,
} from "../../domain/collection";
import { startBatch } from "../importService";
import { importRowsIntoBatch } from "../importService";
import type { NormalizeContext, SourceAdapter } from "../../adapters/types";
import { JSONAdapter } from "../../adapters/json";
import { ZhihuSourceAdapter } from "../../adapters/zhihu";
import { ensureDefaultConnectors, getConnector } from "../../connectors/registry";
import { RUN_ERROR_ZH, RUN_STATUS_ZH, TRIGGER_ZH, runErrorZh } from "../../domain/collectionZh";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface RunCheckpoint {
  /** opaque cursor for the NEXT page (connector-owned semantics) */
  cursor: string | null;
  rawPaginationState?: unknown;
  pagesFetched: number;
  recordsFetched: number;
}

export interface CollectionPolicyOverride {
  rateLimit?: RateLimitConfig;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
}

export interface TaskRow {
  id: number;
  name: string;
  connectorId: string;
  platform: string;
  collectionType: string;
  config: string;
  schedule: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface RunRow {
  id: number;
  taskId: number;
  taskName: string;
  connectorId: string;
  connectorVersion: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  recordsFetched: number;
  recordsAccepted: number;
  recordsFailed: number;
  duplicates: number;
  pagesFetched: number;
  requestCount: number;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  checkpoint: string | null;
  importBatchId: number | null;
  durationMs: number | null;
  trigger: string;
  createdAt: string;
}

const SCHEMA_DRIFT_RATIO = 0.5; // >50% of a page failing itemSchema = drift (§21)

/* ------------------------------------------------------------------ */
/* runtime                                                             */
/* ------------------------------------------------------------------ */

const jsonAdapter = new JSONAdapter();
const zhihuAdapter = new ZhihuSourceAdapter();

/** sourceType (connector.metadata.sourceType) → SourceAdapter */
function adapterFor(sourceType: string): SourceAdapter {
  switch (sourceType) {
    case "api":
      return zhihuAdapter;
    case "json":
    case "fixture":
      return jsonAdapter;
    case "playwright":
      // 行结构与 JSON 完全一样,但**来源必须如实记成浏览器采集** ——
      // 直接落到 default 会让界面显示"接口采集",于是"这条数据是怎么来的"就说不清了。
      return Object.create(jsonAdapter, { getSourceType: { value: () => "playwright" } }) as SourceAdapter;
    default:
      // Stage 5+: further platform adapters plug in here with their own
      // SourceAdapter. Everything downstream stays untouched.
      return jsonAdapter;
  }
}

export interface RunTaskResult {
  ok: boolean;
  runId?: number;
  reason?: "already_running" | "task_not_found" | "connector_not_found" | "task_disabled" | "invalid_config";
  detail?: string;
}

/** 采集运行结束后传给上层的事实:只有真正入库了才值得补分析 */
export interface RunFinishInfo {
  runId: number;
  taskId: number;
  connectorId: string;
  platform: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  accepted: number;
}

export class CollectionRuntime {
  private readonly runningTasks = new Map<number, number>(); // taskId → runId (§17 防重入)
  private readonly aborts = new Map<number, AbortController>(); // runId → controller
  private readonly queue: number[] = []; // queued runIds, FIFO (§18)
  private readonly activeRuns = new Set<number>();
  private readonly connectorActive = new Map<string, number>(); // per-connector concurrency
  private readonly breakers = new Map<string, ConnectorCircuitBreaker>();
  private readonly limiters = new Map<number, RateLimiter>(); // per task (stable per task policy)
  readonly globalConcurrency: number;
  readonly perConnectorConcurrency: number;
  private readonly onRunFinished?: (info: RunFinishInfo) => void | Promise<void>;

  constructor(
    private readonly db: DB,
    opts: {
      globalConcurrency?: number;
      perConnectorConcurrency?: number;
      /** 一次 Run 落库后的回调(自动补分析的挂点);异常不能影响采集本身 */
      onRunFinished?: (info: RunFinishInfo) => void | Promise<void>;
    } = {},
  ) {
    this.globalConcurrency = opts.globalConcurrency ?? 2;
    this.perConnectorConcurrency = opts.perConnectorConcurrency ?? 1;
    this.onRunFinished = opts.onRunFinished;
    ensureDefaultConnectors();
  }

  /* ---------------- task → run entry ---------------- */

  async runTask(taskId: number, trigger: "manual" | "schedule" | "resume"): Promise<RunTaskResult> {
    const [task] = await this.db
      .select()
      .from(collectionTasks)
      .where(eq(collectionTasks.id, taskId))
      .limit(1);
    if (!task) return { ok: false, reason: "task_not_found" };
    if (!task.enabled) return { ok: false, reason: "task_disabled" };

    // §17 防重入:同一个 Task 不并发两次
    const activeRunId = this.runningTasks.get(taskId);
    if (activeRunId !== undefined) {
      return { ok: false, reason: "already_running", runId: activeRunId };
    }

    const connector = getConnector(task.connectorId);
    if (!connector) return { ok: false, reason: "connector_not_found" };

    // §23 secrets: plaintext under secret-ish keys is rejected outright
    const configRaw: unknown = JSON.parse(task.config);
    const { lintSecrets } = await import("../../connectors/types");
    const secretErr = lintSecrets(configRaw);
    if (secretErr) return { ok: false, reason: "invalid_config", detail: secretErr };

    const cfgCheck = connector.validateConfig(configRaw);
    if (!cfgCheck.ok) {
      // create a failed run so the history shows WHY (audit trail), then stop
      const runId = await this.insertRun(task, connector.metadata.version, trigger);
      await this.finalizeRun(runId, "failed", "INVALID_CONFIG", cfgCheck.error ?? "config invalid");
      return { ok: false, reason: "invalid_config", runId, detail: cfgCheck.error };
    }

    // resume: inherit the last run's checkpoint (§38)
    let inheritedCheckpoint: string | null = null;
    if (trigger === "resume") {
      const [last] = await this.db
        .select({ checkpoint: collectionRuns.checkpoint })
        .from(collectionRuns)
        .where(eq(collectionRuns.id, await this.lastResumableRunId(taskId)))
        .limit(1);
      inheritedCheckpoint = last?.checkpoint ?? null;
      if (!inheritedCheckpoint) {
        return { ok: false, reason: "invalid_config", detail: "没有可恢复的 checkpoint" };
      }
    }

    const runId = await this.insertRun(task, connector.metadata.version, trigger, inheritedCheckpoint);
    this.runningTasks.set(taskId, runId); // queued counts as active (§17)
    this.runCache.set(runId, { connectorId: task.connectorId });
    await this.logEvent(runId, "RUN_QUEUED", `任务「${task.name}」已排队(触发方式:${TRIGGER_ZH[trigger] ?? trigger})`);
    this.queue.push(runId);
    this.pump();
    return { ok: true, runId };
  }

  private async lastResumableRunId(taskId: number): Promise<number> {
    const rows = await this.db
      .select({ id: collectionRuns.id, checkpoint: collectionRuns.checkpoint })
      .from(collectionRuns)
      .where(and(eq(collectionRuns.taskId, taskId), inArray(collectionRuns.status, ["failed", "partial", "cancelled"])))
      .orderBy(collectionRuns.id);
    const withCp = rows.filter((r) => r.checkpoint);
    return withCp.length ? withCp[withCp.length - 1].id : -1;
  }

  private async insertRun(
    task: TaskRowLike,
    connectorVersion: string,
    trigger: string,
    checkpoint: string | null = null,
  ): Promise<number> {
    const [row] = await this.db
      .insert(collectionRuns)
      .values({
        taskId: task.id,
        taskName: task.name,
        connectorId: task.connectorId,
        connectorVersion,
        status: "queued",
        trigger,
        checkpoint,
        createdAt: new Date().toISOString(),
      })
      .returning({ id: collectionRuns.id });
    return row.id;
  }

  /* ---------------- queue (§18) ---------------- */

  private pump(): void {
    while (
      this.queue.length > 0 &&
      this.activeRuns.size < this.globalConcurrency
    ) {
      const runId = this.queue[0];
      // peek task to check per-connector capacity
      const run = this.runCacheGet(runId);
      if (!run) {
        this.queue.shift();
        continue;
      }
      const used = this.connectorActive.get(run.connectorId) ?? 0;
      if (used >= this.perConnectorConcurrency) {
        // head-of-line blocked by connector concurrency — stop draining (FIFO fairness)
        return;
      }
      this.queue.shift();
      this.connectorActive.set(run.connectorId, used + 1);
      this.activeRuns.add(runId);
      void this.executeRun(runId)
        .catch((e) => {
          console.error(`[collection] 运行 #${runId} 异常终止:`, e);
        })
        .finally(() => {
          this.activeRuns.delete(runId);
          const cur = this.connectorActive.get(run.connectorId) ?? 1;
          if (cur <= 1) this.connectorActive.delete(run.connectorId);
          else this.connectorActive.set(run.connectorId, cur - 1);
          this.pump();
        });
    }
  }

  /** lightweight in-memory shape to avoid re-querying inside pump */
  private runCache = new Map<number, { connectorId: string }>();
  private runCacheGet(runId: number): { connectorId: string } | undefined {
    return this.runCache.get(runId);
  }

  /* ---------------- cancel (§19) ---------------- */

  async cancelRun(runId: number): Promise<{ ok: boolean; status?: string; reason?: string }> {
    const [run] = await this.db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (!run) return { ok: false, reason: "run_not_found" };
    if (run.status === "queued") {
      const idx = this.queue.indexOf(runId);
      if (idx >= 0) this.queue.splice(idx, 1);
      await this.finalizeRun(runId, "cancelled", "CANCELLED", "cancelled while queued");
      // 排队中的 run 永远不会进 executeRun,所以它占用的任务锁必须在这里释放;
      // 否则该 task 之后每次 runTask 都返回 already_running,只能重启进程才能恢复。
      if (this.runningTasks.get(run.taskId) === runId) this.runningTasks.delete(run.taskId);
      this.runCache.delete(runId);
      return { ok: true, status: "cancelled" };
    }
    if (run.status === "running") {
      const ac = this.aborts.get(runId);
      if (ac) ac.abort(); // stops at the next safe page boundary
      return { ok: true, status: "cancelling" };
    }
    return { ok: false, reason: `run is ${run.status}, not cancellable` };
  }

  /* ---------------- execution ---------------- */

  private async executeRun(runId: number): Promise<void> {
    const db = this.db;
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (!run) return;
    const [task] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, run.taskId)).limit(1);
    if (!task) {
      await this.finalizeRun(runId, "failed", "INVALID_CONFIG", "task deleted while run queued");
      return;
    }
    const connector = getConnector(task.connectorId);
    if (!connector) {
      await this.finalizeRun(runId, "failed", "INVALID_CONFIG", `connector ${task.connectorId} not registered`);
      return;
    }

    const ac = new AbortController();
    this.aborts.set(runId, ac);
    const signal = ac.signal;
    const startedAt = new Date().toISOString();

    await db
      .update(collectionRuns)
      .set({ status: "running", startedAt })
      .where(eq(collectionRuns.id, runId));
    this.runCache.set(runId, { connectorId: task.connectorId });
    await this.logEvent(runId, "RUN_STARTED", `运行 #${runId} 开始(触发方式:${TRIGGER_ZH[run.trigger] ?? run.trigger})`);

    // breaker probe lifecycle: if we bail early, release a half-open probe
    // 熔断按"来源主机"而不是"连接器"计:一个聚合站连续 500,不该把 B站 / HN / IT之家 一起关在门外。
    const breaker = this.breakerFor(this.sourceScope(task.connectorId, task.config), connector);
    let breakerProbe = false;

    try {
      const configRaw: unknown = JSON.parse(task.config);
      const parsedConfig = connector.configSchema.safeParse(configRaw);
      if (!parsedConfig.success) {
        await this.finalizeRun(runId, "failed", "INVALID_CONFIG", "config failed schema at run start");
        return;
      }
      const cfg = parsedConfig.data as Record<string, unknown>;

      // policy: connector defaults, task overrides may only be MORE conservative (§11)
      const limiter = this.limiterFor(task.id, connector, cfg);
      const retryPolicy = this.retryFor(connector, cfg);

      // ONE ImportBatch per run (§6 linkage)
      const batchId = await startBatch(db, {
        name: `run:${runId}:${task.name}`,
        sourceType: connector.metadata.sourceType,
        platform: cfg["platform"] as string | undefined ?? task.platform,
        options: { collectionRunId: runId, connectorId: task.connectorId },
      });
      await db.update(collectionRuns).set({ importBatchId: batchId }).where(eq(collectionRuns.id, runId));

      const ctx: NormalizeContext = {
        sourceType: connector.metadata.sourceType,
        mapping: (cfg["mapping"] as Record<string, string> | undefined) ?? undefined,
        platformOverride: (cfg["platform"] as string | undefined) ?? task.platform,
        sourceTimezone: (cfg["sourceTimezone"] as string | undefined) ?? connector.metadata.defaultTimezone,
        tzProvenance: "adapter_default",
      };
      const adapter = adapterFor(connector.metadata.sourceType);

      // checkpoint state (resume support §38)
      let checkpoint: RunCheckpoint = run.checkpoint
        ? (JSON.parse(run.checkpoint) as RunCheckpoint)
        : { cursor: null, pagesFetched: 0, recordsFetched: 0 };

      const logger: RunLogger = {
        runId,
        event: (type, message, data) => {
          void this.logEvent(runId, type, message, data);
        },
      };
      const runCtx = { runId, taskId: task.id, signal, logger };

      const stats = {
        recordsFetched: checkpoint.recordsFetched,
        recordsAccepted: 0,
        recordsFailed: 0,
        duplicates: 0,
        pagesFetched: checkpoint.pagesFetched,
        requestCount: 0,
        retryCount: 0,
      };
      let cursor = checkpoint.cursor;
      let failure: { code: string; message: string } | null = null;

      const pageSize = typeof cfg["pageSize"] === "number" ? cfg["pageSize"] : 20;
      const pageLimit = typeof cfg["pageLimit"] === "number" ? cfg["pageLimit"] : 50;

      while (stats.pagesFetched < pageLimit) {
        if (signal.aborted) {
          failure = { code: "CANCELLED", message: "cancelled at safe page boundary" };
          break;
        }
        if (!breaker.canExecute()) {
          breakerProbe = false;
          failure = { code: "RATE_LIMITED", message: "circuit breaker open — run aborted to protect the source" };
          break;
        }
        breakerProbe = true;

        // --- rate limit + retry wrapped page fetch ---
        let page: PageResult<unknown> | null = null;
        try {
          page = await limiter.run(async () => {
            if (limiter.lastWaitMs > 0) {
              logger.event("RATE_LIMIT_WAIT", `等待限流窗口 ${limiter.lastWaitMs}ms`, {
                waitMs: limiter.lastWaitMs,
              });
            }
            let lastErr: unknown;
            for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
              if (signal.aborted) throw new ConnectorError("CANCELLED", "cancelled before page attempt");
              try {
                const req: RemotePageRequest = { cursor, pageSize, signal };
                stats.requestCount += 1;
                return await connector.collectPage(req, configRaw, runCtx);
              } catch (e) {
                lastErr = e;
                if (signal.aborted) {
                  throw e instanceof ConnectorError ? e : new ConnectorError("CANCELLED", "cancelled during page");
                }
                const ce =
                  e instanceof ConnectorError
                    ? e
                    : new ConnectorError("UNKNOWN", e instanceof Error ? e.message : String(e));
                if (ce.retryable && attempt < retryPolicy.maxRetries) {
                  stats.retryCount += 1;
                  const delay = computeBackoff(attempt, retryPolicy);
                  logger.event("RETRY", `${RUN_ERROR_ZH[ce.code] ?? ce.code}:${ce.message} —— ${delay}ms 后第 ${attempt + 1}/${retryPolicy.maxRetries} 次重试`, {
                    code: ce.code,
                    attempt: attempt + 1,
                    delayMs: delay,
                  });
                  await new Promise<void>((resolve, reject) => {
                    const t = setTimeout(resolve, delay);
                    signal.addEventListener(
                      "abort",
                      () => {
                        clearTimeout(t);
                        reject(new ConnectorError("CANCELLED", "cancelled during backoff"));
                      },
                      { once: true },
                    );
                  });
                  continue;
                }
                throw ce;
              }
            }
            throw lastErr instanceof Error
              ? lastErr
              : new ConnectorError("UNKNOWN", "unreachable: retry loop exhausted");
          }, signal);
        } catch (e) {
          const ce =
            e instanceof ConnectorError
              ? e
              : isAbortError(e)
                ? new ConnectorError("CANCELLED", "aborted during page fetch")
                : new ConnectorError("UNKNOWN", e instanceof Error ? e.message : String(e));
          breaker.recordFailure();
          if (ce.code === "CANCELLED" && signal.aborted) {
            failure = { code: "CANCELLED", message: ce.message };
          } else {
            failure = { code: ce.code, message: ce.message };
            logger.event("PAGE_FAILED", `${runErrorZh(ce.code)}:${ce.message}`, { code: ce.code });
          }
          break;
        }
        breaker.recordSuccess();

        // --- schema gate (§21): detect drift BEFORE normalization ---
        const items = page.items ?? [];
        stats.recordsFetched += items.length;
        let schemaBad = 0;
        const schemaErrors: string[] = [];
        for (const it of items) {
          const r = connector.itemSchema.safeParse(it);
          if (!r.success) {
            schemaBad += 1;
            if (schemaErrors.length < 5) {
              schemaErrors.push(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
            }
          }
        }
        const driftRatio = items.length > 0 ? schemaBad / items.length : 0;
        if (driftRatio > SCHEMA_DRIFT_RATIO) {
          logger.event("SCHEMA_DRIFT", `页面结构变化:${schemaBad}/${items.length} 条记录不符合条目结构`, {
            connectorVersion: connector.metadata.version,
            sample: redactData(items[0] ?? null),
            validationErrors: schemaErrors,
            driftRatio,
          });
          failure = { code: "SCHEMA_DRIFT", message: `结构漂移:${schemaBad}/${items.length} 条记录无法解析` };
          break;
        }

        stats.pagesFetched += 1;
        logger.event("PAGE_FETCHED", `第 ${stats.pagesFetched} 页:取回 ${items.length} 条`, {
          rows: items.length,
          schemaBad,
        });

        // --- EXISTING pipeline (importRowsIntoBatch → processRow) ---
        if (items.length > 0) {
          const summary = await importRowsIntoBatch(db, adapter, items, ctx, batchId, {
            collectionRunId: runId,
            connectorId: task.connectorId,
            connectorVersion: connector.metadata.version,
          });
          stats.recordsAccepted += summary.imported;
          stats.duplicates += summary.duplicates;
          stats.recordsFailed += summary.failed;
          logger.event("RECORD_IMPORTED", `第 ${stats.pagesFetched} 页:入库 ${summary.imported} 条 / 重复 ${summary.duplicates} 条 / 失败 ${summary.failed} 条`, {
            imported: summary.imported,
            duplicates: summary.duplicates,
            failed: summary.failed,
          });
          // Stage 5 §29/30: append-only discovery observations (search/hotlist rank)
          if (page.discovery) {
            await recordDiscoveries(db, runId, task.connectorId, page.discovery, summary);
            logger.event("RECORD_IMPORTED", `第 ${stats.pagesFetched} 页:记录了新的发现(${page.discovery.type})`, {
              discoveryType: page.discovery.type,
              observed: summary.rows.filter((r) => r.contentItemId !== undefined).length,
            });
          }
        }

        // --- checkpoint AFTER each successful page (§10) ---
        checkpoint = {
          cursor: page.nextCursor ?? null,
          rawPaginationState: page.rawPaginationState,
          pagesFetched: stats.pagesFetched,
          recordsFetched: stats.recordsFetched,
        };
        await db
          .update(collectionRuns)
          .set({ checkpoint: JSON.stringify(checkpoint), pagesFetched: stats.pagesFetched })
          .where(eq(collectionRuns.id, runId));
        logger.event("CHECKPOINT_SAVED", `第 ${stats.pagesFetched} 页已保存断点`, {
          cursor: checkpoint.cursor,
        });

        if (!page.hasMore) break;
        cursor = page.nextCursor ?? null;
      }

      await this.closeBatch(batchId, stats);

      // --- final status (§20 partial: keep everything already ingested) ---
      if (failure && failure.code === "CANCELLED") {
        await this.finalizeRun(runId, "cancelled", "CANCELLED", failure.message, stats);
      } else if (failure) {
        const status = stats.pagesFetched > 0 ? "partial" : "failed";
        if (status === "partial") await this.finalizeRun(runId, "partial", failure.code, failure.message, stats);
        else await this.finalizeRun(runId, "failed", failure.code, failure.message, stats);
      } else {
        await this.finalizeRun(runId, "completed", null, null, stats);
      }

      // connector-side per-run hook (fixture metrics growth across runs) —
      // only when a run actually fetched data; queued-cancel / config-failure
      // runs must NOT advance the simulated remote's clock.
      if (!failure || stats.pagesFetched > 0) {
        connector.notifyRunFinished?.(task.id);
      }

      if (this.onRunFinished) {
        const status = failure ? (stats.pagesFetched > 0 ? "partial" : "failed") : "completed";
        try {
          await this.onRunFinished({
            runId,
            taskId: task.id,
            connectorId: task.connectorId,
            platform: task.platform,
            status: status as RunFinishInfo["status"],
            accepted: stats.recordsAccepted,
          });
        } catch {
          // 自动分析失败不能让一次成功的采集变成失败;原因由分析运行自身记录
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.finalizeRun(runId, "failed", "UNKNOWN", msg);
    } finally {
      if (breakerProbe && this.activeRuns.has(runId)) breaker.resetProbe();
      this.aborts.delete(runId);
      this.runningTasks.delete(run.taskId);
      this.runCache.delete(runId);
    }
  }

  /* ---------------- policy derivation ---------------- */

  /**
   * 熔断范围 = 连接器 + 目标主机。
   * 同一个 generic-http 连接器下挂着十几个渠道,它们指向不同主机;
   * 按连接器熔断会让一个源的故障静默拖死其余全部源(实测一夜之间 9 个渠道各 21 次 RATE_LIMITED)。
   * 配置里没有可用 url 时退回连接器粒度,不改变原行为。
   */
  private sourceScope(connectorId: string, rawConfig: string): string {
    try {
      const c = JSON.parse(rawConfig) as { url?: unknown };
      if (typeof c.url === "string" && c.url) {
        const host = new URL(c.url).hostname.toLowerCase();
        if (host) return `${connectorId}|${host}`;
      }
    } catch {
      /* 配置不是合法 JSON 或 url 不是合法地址:按连接器粒度兜底 */
    }
    return connectorId;
  }

  private breakerFor(scope: string, connector: Connector): ConnectorCircuitBreaker {
    let b = this.breakers.get(scope);
    if (!b) {
      b = new ConnectorCircuitBreaker(
        {
          failureThreshold: connector.defaultPolicy.breaker.failureThreshold,
          cooldownMs: connector.defaultPolicy.breaker.cooldownMs,
        },
        scope,
      );
      this.breakers.set(scope, b);
    }
    return b;
  }

  /** user rate-limit overrides must be equal or MORE conservative (§11) */
  private limiterFor(taskId: number, connector: Connector, cfg: Record<string, unknown>): RateLimiter {
    const existing = this.limiters.get(taskId);
    if (existing) return existing;
    let effective: RateLimitConfig = { ...connector.defaultPolicy.rateLimit };
    const override = cfg["rateLimit"];
    if (override && typeof override === "object") {
      const parsed = RateLimitConfigSchema.safeParse(override);
      if (parsed.success) {
        const o = parsed.data;
        const candidate: RateLimitConfig = {
          rps: o.rps ?? effective.rps,
          rpm: o.rpm ?? effective.rpm,
          minIntervalMs: o.minIntervalMs ?? effective.minIntervalMs,
          concurrency: o.concurrency ?? effective.concurrency,
        };
        // keep override only where it does NOT loosen the connector default
        const effBase = RateLimitConfigSchema.parse(effective);
        const baseInterval = effectiveIntervalOf(effBase);
        const candInterval = effectiveIntervalOf(candidate);
        effective = {
          minIntervalMs: Math.max(candInterval, baseInterval),
          concurrency: Math.min(candidate.concurrency ?? 1, effBase.concurrency ?? 1),
        };
      }
    }
    const limiter = new RateLimiter(effective);
    this.limiters.set(taskId, limiter);
    return limiter;
  }

  private retryFor(connector: Connector, cfg: Record<string, unknown>): { maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
    const base = connector.defaultPolicy.retry;
    const override = cfg["retry"];
    if (override && typeof override === "object") {
      const o = override as Record<string, unknown>;
      return {
        maxRetries: typeof o.maxRetries === "number" ? Math.max(0, Math.min(o.maxRetries, base.maxRetries)) : base.maxRetries,
        baseDelayMs: typeof o.baseDelayMs === "number" ? Math.max(base.baseDelayMs, o.baseDelayMs) : base.baseDelayMs,
        maxDelayMs: typeof o.maxDelayMs === "number" ? Math.max(base.maxDelayMs, o.maxDelayMs) : base.maxDelayMs,
      };
    }
    return { ...base };
  }

  /* ---------------- db helpers ---------------- */

  private async closeBatch(batchId: number, stats: { recordsAccepted: number; duplicates: number; recordsFailed: number; recordsFetched: number }): Promise<void> {
    const failed = stats.recordsFailed;
    const total = stats.recordsFetched;
    const status = failed === 0 ? "completed" : failed === total ? "failed" : "partial";
    await this.db
      .update(importBatches)
      .set({
        totalRecords: total,
        successfulRecords: stats.recordsAccepted + stats.duplicates,
        failedRecords: failed,
        duplicateRecords: stats.duplicates,
        status,
        completedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId));
  }

  private async finalizeRun(
    runId: number,
    status: RunRow["status"],
    errorCode: string | null,
    errorMessage: string | null,
    stats?: {
      recordsFetched: number;
      recordsAccepted: number;
      recordsFailed: number;
      duplicates: number;
      pagesFetched: number;
      requestCount: number;
      retryCount: number;
    },
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const [run] = await this.db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    const durationMs =
      run?.startedAt ? Date.parse(completedAt) - Date.parse(run.startedAt) : null;
    const update: Record<string, unknown> = {
      status,
      completedAt,
      errorCode,
      errorMessage,
      durationMs,
    };
    if (stats) {
      update.recordsFetched = stats.recordsFetched;
      update.recordsAccepted = stats.recordsAccepted;
      update.recordsFailed = stats.recordsFailed;
      update.duplicates = stats.duplicates;
      update.pagesFetched = stats.pagesFetched;
      update.requestCount = stats.requestCount;
      update.retryCount = stats.retryCount;
    }
    await this.db.update(collectionRuns).set(update).where(eq(collectionRuns.id, runId));

    // task bookkeeping
    const [runRow] = run
      ? [run]
      : await this.db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
    if (runRow) {
      const now = completedAt;
      await this.db
        .update(collectionTasks)
        .set({ lastRunAt: now, updatedAt: now })
        .where(eq(collectionTasks.id, runRow.taskId));
    }

    const eventType: Record<string, Parameters<RunLogger["event"]>[0]> = {
      completed: "RUN_COMPLETED",
      partial: "RUN_PARTIAL",
      failed: "RUN_FAILED",
      cancelled: "RUN_CANCELLED",
    };
    const ev = eventType[status];
    if (ev) {
      await this.logEvent(
        runId,
        ev,
        `运行${RUN_STATUS_ZH[status] ?? status}${errorCode ? `(${RUN_ERROR_ZH[errorCode] ?? errorCode}:${errorMessage ?? ""})` : ""}`,
        stats
          ? {
              pagesFetched: stats.pagesFetched,
              recordsFetched: stats.recordsFetched,
              recordsAccepted: stats.recordsAccepted,
              duplicates: stats.duplicates,
              recordsFailed: stats.recordsFailed,
            }
          : undefined,
      );
    }
    void runRow; // task row kept for future bookkeeping; notify handled by caller
  }

  private async logEvent(
    runId: number,
    type: Parameters<RunLogger["event"]>[0],
    message?: string,
    data?: unknown,
  ): Promise<void> {
    try {
      await this.db.insert(collectionRunEvents).values({
        runId,
        at: new Date().toISOString(),
        type,
        message: message ?? null,
        data: data === undefined ? null : JSON.stringify(redactData(data)),
      });
    } catch (e) {
      console.error(`[collection] 事件写入失败(运行 #${runId},${type}):`, e);
    }
  }

  /* ---------------- process introspection ---------------- */

  isTaskRunning(taskId: number): boolean {
    return this.runningTasks.has(taskId);
  }

  /**
   * 该连接器名下的熔断状态。scope 现在按"连接器 + 来源主机"分,
   * 所以这里取**最坏**的那个源:任何一个源在熔断,健康检查就不该说"全部正常"。
   */
  breakerSnapshot(connectorId: string): ReturnType<ConnectorCircuitBreaker["snapshot"]> | null {
    let worst: { snap: ReturnType<ConnectorCircuitBreaker["snapshot"]>; rank: number } | null = null;
    for (const [scope, b] of this.breakers) {
      if (scope !== connectorId && !scope.startsWith(`${connectorId}|`)) continue;
      const snap = b.snapshot();
      const rank = snap.state === "open" ? 2 : snap.state === "half_open" ? 1 : 0;
      if (!worst || rank > worst.rank) worst = { snap, rank };
    }
    return worst ? worst.snap : null;
  }

  /** 正在熔断(或半开试探)的来源标识,给健康检查的说明文案用 —— 说清是哪一个源挂了。 */
  openBreakerSources(connectorId: string): string[] {
    const out: string[] = [];
    for (const [scope, b] of this.breakers) {
      if (scope !== connectorId && !scope.startsWith(`${connectorId}|`)) continue;
      const st = b.snapshot().state;
      if (st === "open" || st === "half_open") out.push(scope.includes("|") ? scope.slice(connectorId.length + 1) : scope);
    }
    return out;
  }
}

interface TaskRowLike {
  id: number;
  name: string;
  connectorId: string;
}

/**
 * Stage 5 §29/30: persist append-only discovery observations, index-aligned
 * with the page's import summary (summary.rows[i] ↔ items[i]). Rows that
 * failed to import have no contentItemId → no observation.
 */
async function recordDiscoveries(
  db: DB,
  runId: number,
  connectorId: string,
  discovery: NonNullable<PageResult<unknown>["discovery"]>,
  summary: { rows: { contentItemId?: number }[] },
): Promise<void> {
  const ts = new Date().toISOString();
  const values = summary.rows
    .map((row, i) => ({
      contentItemId: row.contentItemId,
      rank: discovery.ranks[i] ?? null,
    }))
    .filter((v): v is { contentItemId: number; rank: number | null } => v.contentItemId !== undefined)
    .map((v) => ({
      contentItemId: v.contentItemId,
      collectionRunId: runId,
      connectorId,
      discoveryType: discovery.type,
      query: discovery.query ?? null,
      rank: v.rank,
      capturedAt: ts,
      metadata: discovery.metadata === undefined || discovery.metadata === null ? null : JSON.stringify(discovery.metadata),
    }));
  if (values.length === 0) return;
  try {
    await db.insert(contentDiscoveryObservations).values(values);
  } catch (e) {
    // observation failure must not fail the run — log and continue
    console.error(`[collection] 发现记录写入失败(运行 #${runId}):`, e);
  }
}

function effectiveIntervalOf(c: RateLimitConfig): number {
  const candidates: number[] = [];
  if (c.minIntervalMs !== undefined) candidates.push(c.minIntervalMs);
  if (c.rps !== undefined) candidates.push(1000 / c.rps);
  if (c.rpm !== undefined) candidates.push(60_000 / c.rpm);
  return candidates.length ? Math.max(...candidates) : 1_000;
}
