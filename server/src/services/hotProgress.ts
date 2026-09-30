/**
 * 「一键抓热点」与「按今日热点深挖」的实时进度。
 *
 * 为什么需要它:这两个操作是**逐个渠道 / 逐个检索词串行**跑的,每个还要等自己的采集运行结束
 * (慢的时候一条就能等上一两分钟)。之前只有最后一次性返回的响应,界面上就只有一句
 * "抓取中…" —— 使用者等了十分钟,分不清是程序卡住了还是本来就这么慢。
 *
 * 这里只记**真实发生的事**:总数、已完成数、当前在做哪一条、这一条从什么时候开始。
 * 百分比 = 已完成 / 总数,不做平滑、不猜 ETA。
 *
 * 两类任务**各占一个槽位**,不是共用一个:深挖除了手动点,还会在采集之后自动跑一轮。
 * 实测过共用一个槽的后果 —— 自动深挖一启动,手动抓热点的进度就被顶成"深挖 3/3 已完成",
 * 使用者看到的进度条和实际在跑的事就对不上了。
 *
 * 内存态即可:进程重启后没有正在跑的任务,进度条本来就该消失。
 */

export type JobKind = "capture" | "cascade";
export type ItemState = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobItem {
  label: string;
  state: ItemState;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Job {
  kind: JobKind;
  startedAt: string;
  items: JobItem[];
  finishedAt: string | null;
}

export interface JobSnapshot {
  kind: JobKind;
  startedAt: string;
  elapsedMs: number;
  total: number;
  done: number;
  /** 当前在做第几条(从 1 开始);没有在跑的就为 0 */
  position: number;
  currentLabel: string | null;
  /** 当前这一条已经跑了多久 —— 用来区分"卡住"和"就是慢" */
  currentItemMs: number;
  percent: number;
  finishedAt: string | null;
  items: JobItem[];
}

export interface ProgressSnapshot {
  capture: JobSnapshot | null;
  cascade: JobSnapshot | null;
}

const jobs = new Map<JobKind, Job>();

const nowIso = () => new Date().toISOString();

/** 开始一个任务;同一类任务同时只会有一个在跑(路由本身串行),新的直接覆盖上一轮的记录。 */
export function beginJob(kind: JobKind, labels: string[]): void {
  jobs.set(kind, {
    kind,
    startedAt: nowIso(),
    finishedAt: null,
    items: labels.map((label) => ({ label, state: "pending" as ItemState, detail: null, startedAt: null, finishedAt: null })),
  });
}

export function markRunning(kind: JobKind, index: number): void {
  const j = jobs.get(kind);
  if (!j || index < 0 || index >= j.items.length) return;
  j.items[index] = { ...j.items[index], state: "running", startedAt: nowIso() };
}

export function markFinished(kind: JobKind, index: number, state: Exclude<ItemState, "pending" | "running">, detail?: string | null): void {
  const j = jobs.get(kind);
  if (!j || index < 0 || index >= j.items.length) return;
  j.items[index] = { ...j.items[index], state, detail: detail ?? null, finishedAt: nowIso() };
}

export function endJob(kind: JobKind): void {
  const j = jobs.get(kind);
  if (j) j.finishedAt = nowIso();
}

function view(j: Job): JobSnapshot {
  const finished = j.items.filter((i) => i.state === "done" || i.state === "failed" || i.state === "skipped").length;
  const idx = j.items.findIndex((i) => i.state === "running");
  const running = idx >= 0 ? j.items[idx] : null;
  return {
    kind: j.kind,
    startedAt: j.startedAt,
    elapsedMs: Date.now() - Date.parse(j.startedAt),
    total: j.items.length,
    done: finished,
    position: idx >= 0 ? idx + 1 : 0,
    currentLabel: running ? running.label : null,
    currentItemMs: running && running.startedAt ? Date.now() - Date.parse(running.startedAt) : 0,
    percent: j.items.length === 0 ? 0 : Math.round((finished / j.items.length) * 100),
    finishedAt: j.finishedAt,
    items: j.items.map((i) => ({ ...i })),
  };
}

export function jobSnapshot(kind: JobKind): JobSnapshot | null {
  const j = jobs.get(kind);
  return j ? view(j) : null;
}

/** 两类任务一起给:界面按自己关心的那条读,互不顶替。 */
export function progressSnapshot(): ProgressSnapshot {
  return { capture: jobSnapshot("capture"), cascade: jobSnapshot("cascade") };
}

/** 测试用:清掉内存态。 */
export function resetJobs(): void {
  jobs.clear();
}
