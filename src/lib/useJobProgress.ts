/**
 * 抓取 / 深挖进行时的进度轮询。
 *
 * 这两个操作是逐个渠道串行跑的,慢的时候一条就要一两分钟,而整个请求要到最后才返回。
 * 之前界面上只有一句"抓取中…",使用者分不清是程序卡住了还是本来就这么慢
 * (真实反馈:"在那界面等了十分钟也没搞完")。所以这里每 1.5 秒读一次服务端进度。
 *
 * 读进度失败**不该**影响正在跑的主操作:静默保留上一次的值,下一轮再试。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type JobItemState = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobItem {
  label: string;
  state: JobItemState;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobSnapshot {
  kind: "capture" | "cascade";
  startedAt: string;
  elapsedMs: number;
  total: number;
  done: number;
  position: number;
  currentLabel: string | null;
  currentItemMs: number;
  percent: number;
  finishedAt: string | null;
  items: JobItem[];
}

export interface ProgressSnapshot {
  capture: JobSnapshot | null;
  cascade: JobSnapshot | null;
}

const EMPTY: ProgressSnapshot = { capture: null, cascade: null };

/**
 * 只要面板挂着就轮询(默认 2 秒一次,读的是服务端内存里的状态,不碰数据库)。
 * 不能只在"本页面点了按钮"时才读 —— 那样换一个标签页看就看不见正在跑的任务,
 * 而使用者抱怨的正是"我不知道它到底在不在跑"。
 */
export function useJobProgress(intervalMs = 2000): ProgressSnapshot {
  const [job, setJob] = useState<ProgressSnapshot>(EMPTY);
  const gen = useRef(0);

  useEffect(() => {
    const my = ++gen.current;
    let stopped = false;
    async function tick() {
      try {
        const r = await api<ProgressSnapshot>("/hot/progress");
        if (!stopped && my === gen.current) setJob(r);
      } catch {
        /* 进度读不到就沿用上一次的值,不打断正在跑的操作 */
      }
    }
    void tick();
    const t = setInterval(tick, intervalMs);
    // 后台标签页的 setInterval 会被浏览器降频(可低到每分钟一次),用户切回来的那一刻
    // 必须立刻重读一次,否则进度条会停在旧数字上。
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return job;
}
