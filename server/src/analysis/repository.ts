/**
 * analysis_runs 读写(§38/§39)。steps 是一整块 JSON:步骤数量有限、单步状态必须整体一致,
 * 拆成多行只会让"读到一个跑一半的进度"成为可能。
 */
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { analysisRuns } from "../db/schema";
import type { AnalysisRunRow, RefreshStep } from "./types";
import { STEP_KEYS } from "./types";

const num = (v: unknown): number => Number(v ?? 0);

/** 步骤清单与执行顺序都在这里定义(§37)。 */
export function blankSteps(): RefreshStep[] {
  return STEP_KEYS.map((k) => ({
    key: k.key,
    label: k.label,
    state: "pending" as const,
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
  }));
}

function parseSteps(raw: string | null | undefined): RefreshStep[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as RefreshStep[]) : [];
  } catch {
    return [];
  }
}

function toRow(r: typeof analysisRuns.$inferSelect): AnalysisRunRow {
  return {
    id: r.id,
    status: r.status as AnalysisRunRow["status"],
    triggerSource: r.triggerSource,
    currentStep: r.currentStep,
    steps: parseSteps(r.steps),
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs === null || r.durationMs === undefined ? null : Number(r.durationMs),
  };
}

export async function createRun(db: DB, opts: { trigger: string; steps: RefreshStep[]; now: string }): Promise<AnalysisRunRow> {
  const [row] = await db
    .insert(analysisRuns)
    .values({
      status: "running",
      triggerSource: opts.trigger,
      currentStep: opts.steps[0]?.key ?? null,
      steps: JSON.stringify(opts.steps),
      startedAt: opts.now,
    })
    .returning();
  return toRow(row);
}

export async function updateRun(
  db: DB,
  id: number,
  patch: { currentStep?: string | null; steps?: RefreshStep[]; error?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.currentStep !== undefined) set.currentStep = patch.currentStep;
  if (patch.steps !== undefined) set.steps = JSON.stringify(patch.steps);
  if (patch.error !== undefined) set.error = patch.error;
  if (Object.keys(set).length === 0) return;
  await db.update(analysisRuns).set(set).where(eq(analysisRuns.id, id));
}

export async function finishRun(
  db: DB,
  id: number,
  patch: { status: AnalysisRunRow["status"]; steps: RefreshStep[]; error: string | null; durationMs: number; now: string },
): Promise<void> {
  await db
    .update(analysisRuns)
    .set({
      status: patch.status,
      steps: JSON.stringify(patch.steps),
      error: patch.error,
      currentStep: null,
      finishedAt: patch.now,
      durationMs: Math.max(0, Math.round(patch.durationMs)),
    })
    .where(eq(analysisRuns.id, id));
}

export async function getRun(db: DB, id: number): Promise<AnalysisRunRow | null> {
  const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, id));
  return row ? toRow(row) : null;
}

export async function latestRun(db: DB): Promise<AnalysisRunRow | null> {
  const [row] = await db.select().from(analysisRuns).orderBy(desc(analysisRuns.id)).limit(1);
  return row ? toRow(row) : null;
}

/**
 * 进程被强杀时留下的 running 记录既不是"在跑"也不是"完成"。
 * 启动时把它们标成 failed —— 否则 UI 会永远显示"正在进行中"。
 */
export async function reapInterruptedRuns(db: DB, now = new Date().toISOString()): Promise<number> {
  const rows = await db
    .update(analysisRuns)
    .set({ status: "failed", error: "上次运行未正常结束(进程中断),请重跑对应步骤。", finishedAt: now, currentStep: null })
    .where(sql`${analysisRuns.status} = 'running'`)
    .returning({ id: analysisRuns.id });
  return rows.length;
}

export async function countRuns(db: DB): Promise<number> {
  const [r] = await db.select({ c: sql<number>`count(*)` }).from(analysisRuns);
  return num(r?.c);
}
