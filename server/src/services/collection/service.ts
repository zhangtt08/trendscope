/**
 * Collection service (Stage 4): task CRUD, run/event queries, connector
 * health aggregation (§14 — deterministic rules only, no AI) and collection
 * stats for the dashboard (§32).
 */
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client";
import { collectionRuns, collectionRunEvents, collectionTasks } from "../../db/schema";
import { getConnector, listConnectors } from "../../connectors/registry";
import type { ConnectorMetadata } from "../../connectors/types";
import { lintSecrets } from "../../connectors/types";
import type { CollectionRuntime } from "./runtime";
import type { BreakerState } from "../../domain/collection";

/* ---------------- zod gates ---------------- */

export const ScheduleSchema = z.union([
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("interval"), intervalMs: z.number().int().min(60_000).max(2_592_000_000) }),
]);

export const CreateTaskSchema = z.object({
  name: z.string().min(1).max(200),
  connectorId: z.string().min(1),
  collectionType: z.enum(["search", "hotlist", "content", "author", "custom"]),
  config: z.record(z.unknown()),
  schedule: ScheduleSchema.default({ type: "manual" }),
  enabled: z.boolean().default(true),
});

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  collectionType: z.enum(["search", "hotlist", "content", "author", "custom"]).optional(),
  config: z.record(z.unknown()).optional(),
  schedule: ScheduleSchema.optional(),
  enabled: z.boolean().optional(),
});

/* ---------------- connector listing + health (§14/§29) ---------------- */

export type ConnectorHealthStatus = "healthy" | "degraded" | "unavailable" | "misconfigured" | "unknown";

export interface ConnectorView {
  metadata: ConnectorMetadata;
  isDemo: boolean;
  health: {
    status: ConnectorHealthStatus;
    detail: string | null;
    circuitState: BreakerState;
    lastCheck: string;
    recentRuns: { total: number; failed: number; partial: number; completed: number };
  };
}

export async function listConnectorViews(db: DB, runtime: CollectionRuntime): Promise<ConnectorView[]> {
  const views: ConnectorView[] = [];
  for (const connector of listConnectors()) {
    views.push(await connectorView(db, runtime, connector.metadata.id));
  }
  return views;
}

export async function connectorView(db: DB, runtime: CollectionRuntime, connectorId: string): Promise<ConnectorView> {
  const connector = getConnector(connectorId);
  if (!connector) throw new Error(`连接器不存在: ${connectorId}`);
  const lastCheck = new Date().toISOString();

  // 0) credential lifecycle first (Stage 5 §41): a missing/invalid secret means
  // unverified — NOT service down. This must not be masked by config-probe or
  // breaker checks.
  type CredentialChecker = { checkCredential(config?: unknown): { state: string; source: string; detail: string } };
  const credCheck = (getConnector(connectorId) as unknown as CredentialChecker | undefined)?.checkCredential;
  if (typeof credCheck === "function") {
    const cred = credCheck.call(getConnector(connectorId));
    if (cred.state !== "configured") {
      return {
        metadata: connector.metadata,
        isDemo: connector.metadata.isDemo ?? false,
        health: {
          status: "misconfigured",
          detail: `${cred.detail}(密钥来源:${cred.source})`,
          circuitState: runtime.breakerSnapshot(connectorId)?.state ?? "closed",
          lastCheck,
          recentRuns: { total: 0, failed: 0, partial: 0, completed: 0 },
        },
      };
    }
  }

  // 1) 空配置被拒是正常形态(采集参数由任务提供),不是故障。
  //    以前在这里直接返回 unknown,导致凭证已配、Run 也成功的连接器照样显示"未知",
  //    并且下面的最近运行统计永远读不到。现在只记下事实,继续判活。
  const needsTaskConfig = !connector.validateConfig({}).ok;

  // 2) recent runs (last 5 for this connector)
  const runs = await db
    .select({ status: collectionRuns.status })
    .from(collectionRuns)
    .where(eq(collectionRuns.connectorId, connectorId))
    .orderBy(desc(collectionRuns.id))
    .limit(5);
  const recentRuns = {
    total: runs.length,
    failed: runs.filter((r) => r.status === "failed").length,
    partial: runs.filter((r) => r.status === "partial").length,
    completed: runs.filter((r) => r.status === "completed").length,
  };

  // 3) circuit breaker state
  const snap = runtime.breakerSnapshot(connectorId);
  const circuitState: BreakerState = snap?.state ?? "closed";
  // 熔断按"连接器 + 来源主机"分,所以说明里要点出是哪一个源挂了 ——
  // 只说"熔断器已打开"会让人以为整个采集器坏了(实测一夜之间一个聚合站能牵连 9 个渠道)。
  const openSources = circuitState === "open" ? runtime.openBreakerSources(connectorId) : [];
  if (circuitState === "open") {
    return {
      metadata: connector.metadata,
      isDemo: connector.metadata.isDemo ?? false,
      health: {
        status: "unavailable",
        detail:
          "熔断器已打开(连续失败达到阈值,冷却后自动进入试探恢复)" +
          (openSources.length > 0 ? `;当前挂掉的来源:${openSources.join("、")}` : ""),
        circuitState,
        lastCheck,
        recentRuns,
      },
    };
  }

  // 3.5) live credential state is already reflected above; configs bearing
  // their own secretRef could still differ — skip duplicate checks here.

  // 4) live health check (connector-owned, deterministic)
  const check = await connector.healthCheck({ signal: undefined });
  if (!check.healthy) {
    return {
      metadata: connector.metadata,
      isDemo: connector.metadata.isDemo ?? false,
      health: {
        status: "unavailable",
        detail: check.detail ?? "healthCheck failed",
        circuitState,
        lastCheck,
        recentRuns,
      },
    };
  }

  // 5) degraded when recent history is shaky
  let status: ConnectorHealthStatus = "healthy";
  let detail: string | null = check.detail ?? null;
  if (recentRuns.total >= 2 && recentRuns.failed === recentRuns.total) {
    status = "unavailable";
    detail = "最近全部 Run 失败";
  } else if (recentRuns.total > 0 && recentRuns.failed + recentRuns.partial > 0) {
    status = "degraded";
    detail = `最近 ${recentRuns.total} 次运行中有 ${recentRuns.failed} 失败 / ${recentRuns.partial} 部分成功`;
  }

  const finalDetail =
    needsTaskConfig && status === "healthy"
      ? detail
        ? `${detail};采集参数由任务提供`
        : "采集参数由任务提供"
      : detail;

  return {
    metadata: connector.metadata,
    isDemo: connector.metadata.isDemo ?? false,
    health: { status, detail: finalDetail, circuitState, lastCheck, recentRuns },
  };
}

/* ---------------- task CRUD ---------------- */

export interface TaskView {
  id: number;
  name: string;
  connectorId: string;
  platform: string;
  collectionType: string;
  config: unknown;
  schedule: unknown;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  connectorName: string | null;
  isRunning: boolean;
  lastRun: {
    id: number;
    status: string;
    createdAt: string;
    recordsAccepted: number;
  } | null;
}

function taskView(row: typeof collectionTasks.$inferSelect, runtime: CollectionRuntime, connectorName: string | null, lastRun: TaskView["lastRun"]): TaskView {
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    platform: row.platform,
    collectionType: row.collectionType,
    config: safeJson(row.config),
    schedule: row.schedule ? safeJson(row.schedule) : { type: "manual" },
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    connectorName,
    isRunning: runtime.isTaskRunning(row.id),
    lastRun,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function lastRunOf(db: DB, taskId: number): Promise<TaskView["lastRun"]> {
  const [row] = await db
    .select({ id: collectionRuns.id, status: collectionRuns.status, createdAt: collectionRuns.createdAt, recordsAccepted: collectionRuns.recordsAccepted })
    .from(collectionRuns)
    .where(eq(collectionRuns.taskId, taskId))
    .orderBy(desc(collectionRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * 任务归属平台:通用连接器一个 id 服务多个平台,因此任务可用 config.platform 声明归属代码;
 * 未声明时回落到连接器自身声明的平台。未知代码原样保留(不猜测、不硬编中文标签)。
 */
function taskPlatform(config: Record<string, unknown> | undefined, fallback: string): string {
  const v = typeof config?.platform === "string" ? config.platform.trim().toLowerCase() : "";
  return v ? v.slice(0, 40) : fallback;
}

export async function createTask(db: DB, runtime: CollectionRuntime, input: unknown): Promise<TaskView> {
  const parsed = CreateTaskSchema.parse(input);
  const connector = getConnector(parsed.connectorId);
  if (!connector) throw new Error(`connector 不存在: ${parsed.connectorId}`);

  // §23 secrets FIRST — plaintext is rejected before any schema lenience can let it through
  const secretErr = lintSecrets(parsed.config);
  if (secretErr) throw new Error(secretErr);

  const cfg = connector.validateConfig(parsed.config);
  if (!cfg.ok) throw new Error(`connector 配置无效: ${cfg.error}`);

  const now = new Date().toISOString();
  const nextRunAt =
    parsed.schedule.type === "interval" && parsed.enabled
      ? new Date(Date.now() + parsed.schedule.intervalMs).toISOString()
      : null;
  const [row] = await db
    .insert(collectionTasks)
    .values({
      name: parsed.name,
      connectorId: parsed.connectorId,
      platform: taskPlatform(parsed.config, connector.metadata.platform),
      collectionType: parsed.collectionType,
      config: JSON.stringify(parsed.config),
      schedule: JSON.stringify(parsed.schedule),
      enabled: parsed.enabled ? 1 : 0,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return taskView(row, runtime, connector.metadata.name, null);
}

export async function updateTask(db: DB, runtime: CollectionRuntime, taskId: number, input: unknown): Promise<TaskView> {
  const parsed = UpdateTaskSchema.parse(input);
  const [row] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, taskId)).limit(1);
  if (!row) throw new Error("采集任务不存在");

  const schedule = parsed.schedule ?? (row.schedule ? (safeJson(row.schedule) as z.infer<typeof ScheduleSchema>) : { type: "manual" as const });
  const config = parsed.config ?? (safeJson(row.config) as Record<string, unknown> | null) ?? {};
  const enabled = parsed.enabled ?? row.enabled === 1;

  // config/schedule changes revalidate against the connector contract
  if (parsed.config !== undefined) {
    const secretErr = lintSecrets(parsed.config);
    if (secretErr) throw new Error(secretErr);
    const connector = getConnector(row.connectorId);
    if (!connector) throw new Error(`connector 不存在: ${row.connectorId}`);
    const cfg = connector.validateConfig(config);
    if (!cfg.ok) throw new Error(`connector 配置无效: ${cfg.error}`);
  }

  let nextRunAt = row.nextRunAt;
  if (parsed.schedule !== undefined || parsed.enabled !== undefined) {
    nextRunAt =
      schedule.type === "interval" && enabled
        ? row.nextRunAt ?? new Date(Date.now() + (schedule as { intervalMs: number }).intervalMs).toISOString()
        : null;
  }

  const now = new Date().toISOString();
  const [updated] = await db
    .update(collectionTasks)
    .set({
      name: parsed.name ?? row.name,
      collectionType: parsed.collectionType ?? row.collectionType,
      platform:
        parsed.config !== undefined
          ? taskPlatform(parsed.config, getConnector(row.connectorId)?.metadata.platform ?? row.platform)
          : row.platform,
      config: JSON.stringify(config),
      schedule: JSON.stringify(schedule),
      enabled: enabled ? 1 : 0,
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(collectionTasks.id, taskId))
    .returning();
  const connector = getConnector(updated.connectorId);
  return taskView(updated, runtime, connector?.metadata.name ?? null, await lastRunOf(db, taskId));
}

export async function deleteTask(db: DB, taskId: number): Promise<boolean> {
  // §30: deleting a task NEVER deletes history — runs reference task_name/task_id denormalized
  const res = await db.delete(collectionTasks).where(eq(collectionTasks.id, taskId));
  return (res.changes ?? 0) > 0;
}

export async function listTasks(db: DB, runtime: CollectionRuntime): Promise<TaskView[]> {
  const rows = await db.select().from(collectionTasks).orderBy(desc(collectionTasks.id));
  const out: TaskView[] = [];
  for (const row of rows) {
    const connector = getConnector(row.connectorId);
    out.push(taskView(row, runtime, connector?.metadata.name ?? null, await lastRunOf(db, row.id)));
  }
  return out;
}

export async function getTask(db: DB, runtime: CollectionRuntime, taskId: number): Promise<TaskView | null> {
  const [row] = await db.select().from(collectionTasks).where(eq(collectionTasks.id, taskId)).limit(1);
  if (!row) return null;
  const connector = getConnector(row.connectorId);
  return taskView(row, runtime, connector?.metadata.name ?? null, await lastRunOf(db, taskId));
}

/* ---------------- run queries (§31) ---------------- */

export async function listRuns(
  db: DB,
  q: { taskId?: number; status?: string; page?: number; pageSize?: number },
): Promise<{ rows: (typeof collectionRuns.$inferSelect)[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(q.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(q.pageSize ?? 30)));
  const conds = [];
  if (q.taskId) conds.push(eq(collectionRuns.taskId, q.taskId));
  if (q.status) conds.push(eq(collectionRuns.status, q.status));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(collectionRuns)
    .where(where)
    .orderBy(desc(collectionRuns.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [totalRow] = await db.select({ n: count() }).from(collectionRuns).where(where);
  return { rows, total: Number(totalRow?.n ?? 0), page, pageSize };
}

export async function getRun(db: DB, runId: number) {
  const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, runId)).limit(1);
  if (!run) return null;
  const events = await db
    .select()
    .from(collectionRunEvents)
    .where(eq(collectionRunEvents.runId, runId))
    .orderBy(collectionRunEvents.id);
  return { run, events };
}

/* ---------------- dashboard stats (§32) ---------------- */

export interface CollectionStats {
  activeTasks: number;
  totalTasks: number;
  runsToday: number;
  completedToday: number;
  partialToday: number;
  failedToday: number;
  runningNow: number;
  recordsCollectedToday: number;
  recordsCollectedTotal: number;
}

export async function getCollectionStats(db: DB): Promise<CollectionStats> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  const [totals] = await db
    .select({
      totalTasks: count(),
      activeTasks: sql<number>`sum(case when ${collectionTasks.enabled} = 1 then 1 else 0 end)`,
    })
    .from(collectionTasks);

  // 字段名是 *Today,筛选窗口也必须是今天:原先 WHERE 用 90 天,只有
  // recordsCollectedToday 在 SUM 里再卡了一次日界,导致"今日运行 2 / 今日入库 0"。
  const [today] = await db
    .select({
      runsToday: count(),
      completedToday: sql<number>`sum(case when ${collectionRuns.status} = 'completed' then 1 else 0 end)`,
      partialToday: sql<number>`sum(case when ${collectionRuns.status} = 'partial' then 1 else 0 end)`,
      failedToday: sql<number>`sum(case when ${collectionRuns.status} = 'failed' then 1 else 0 end)`,
      recordsCollectedToday: sql<number>`coalesce(sum(${collectionRuns.recordsAccepted}), 0)`,
    })
    .from(collectionRuns)
    .where(gte(collectionRuns.createdAt, dayStartIso));

  // runningNow 不是"今日"概念:跨天仍在跑的任务也要算
  const [running] = await db
    .select({
      runningNow: sql<number>`sum(case when ${collectionRuns.status} IN ('running','queued') then 1 else 0 end)`,
    })
    .from(collectionRuns);

  const [collectedTotal] = await db
    .select({ n: sql<number>`coalesce(sum(${collectionRuns.recordsAccepted}), 0)` })
    .from(collectionRuns);

  return {
    activeTasks: Number(totals?.activeTasks ?? 0),
    totalTasks: Number(totals?.totalTasks ?? 0),
    runsToday: Number(today?.runsToday ?? 0),
    completedToday: Number(today?.completedToday ?? 0),
    partialToday: Number(today?.partialToday ?? 0),
    failedToday: Number(today?.failedToday ?? 0),
    runningNow: Number(running?.runningNow ?? 0),
    recordsCollectedToday: Number(today?.recordsCollectedToday ?? 0),
    recordsCollectedTotal: Number(collectedTotal?.n ?? 0),
  };
}
