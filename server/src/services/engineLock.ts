/**
 * Cross-router engine lock.
 *
 * Why: each analysis router kept its own `running` Set and only consulted it
 * on the fire-and-forget path, so `wait:true` requests bypassed the lock and
 * `POST /full-refresh` (which calls the engine functions directly) could run
 * concurrently with an individual engine run — duplicate/interleaved runs.
 * One module-level registry covers every entry point. Node is single-threaded,
 * so the check-then-add below is atomic with respect to other requests.
 */
export type EngineName = "content" | "trend" | "intelligence" | "opportunity" | "studio";

const busy = new Set<EngineName>();

const LABELS: Record<EngineName, string> = {
  content: "内容爆发评分",
  trend: "话题趋势评分",
  intelligence: "内容情报分析",
  opportunity: "机会指数分析",
  studio: "选题方案生成",
};

export type LockResult = { ok: true } | { ok: false; conflicts: EngineName[] };

/** 原子地占用一组引擎;任一被占用则全部不占用并返回冲突项。 */
export function beginRun(names: EngineName[]): LockResult {
  const conflicts = names.filter((n) => busy.has(n));
  if (conflicts.length > 0) return { ok: false, conflicts };
  for (const n of names) busy.add(n);
  return { ok: true };
}

export function endRun(names: EngineName[]): void {
  for (const n of names) busy.delete(n);
}

export function conflictMessage(conflicts: EngineName[]): string {
  return `${conflicts.map((c) => LABELS[c]).join("、")}正在运行中,请等待完成`;
}

/** 仅供测试/诊断:当前占用中的引擎。 */
export function busyEngines(): EngineName[] {
  return [...busy];
}

/**
 * 所有"运行某引擎"端点的统一语义:
 *   - 无论 wait 与否都先拿锁(旧实现只在后台分支拿,wait:true 可并发重复跑)
 *   - wait:true  → 同步跑完,返回 200 + 结果(202 表示"尚未完成",用错语义)
 *   - wait:false → 立刻 202 {started},后台跑,跑完释放锁
 * 抛出时释放锁并把错误交给调用方的 catch。
 */
export async function withEngineLock(
  res: import("express").Response,
  engines: EngineName[],
  tag: string,
  wait: boolean,
  work: () => Promise<unknown>,
): Promise<void> {
  const lock = beginRun(engines);
  if (!lock.ok) {
    res.status(409).json({ error: conflictMessage(lock.conflicts) });
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    endRun(engines);
  };
  try {
    if (wait) {
      const result = await work();
      release();
      res.status(200).json(result);
      return;
    }
    res.status(202).json({ started: true });
    work()
      .catch((e) => console.error(`[${tag}] 后台运行异常终止:`, e))
      .finally(release);
  } catch (e) {
    release();
    throw e;
  }
}
