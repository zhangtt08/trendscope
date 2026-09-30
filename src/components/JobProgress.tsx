/**
 * 抓取 / 深挖的实时进度条。
 *
 * 只呈现服务端真实记下的事:总共几条、完成几条、现在在做哪一条、这一条已经等了多久。
 * 百分比 = 已完成 / 总数,不做平滑、不猜 ETA —— 宁可数字跳,也不给一个看起来准其实是编的进度。
 */
import type { JobItemState, JobSnapshot } from "../lib/useJobProgress";
import { elapsedZh } from "../lib/format";

const STATE_ZH: Record<JobItemState, string> = {
  pending: "排队中",
  running: "正在采",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export function JobProgress({ job }: { job: JobSnapshot | null }) {
  if (!job || job.total === 0) return null;
  const title = job.kind === "capture" ? "正在抓取热点" : "正在深挖内容";
  return (
    <div className="jobprog" role="status" aria-live="polite">
      <div className="jobprog-head">
        <span className="jobprog-title">
          {title}:{job.currentLabel ? `第 ${job.position} / ${job.total} 条 · ${job.currentLabel}` : `${job.done} / ${job.total} 条已完成`}
        </span>
        <span className="muted small">
          已等待 {elapsedZh(job.elapsedMs)}
          {job.currentLabel ? ` · 这一条已 ${elapsedZh(job.currentItemMs)}` : ""}
        </span>
      </div>
      <div
        className="jobprog-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.percent}
        aria-label={`${title}进度 ${job.percent}%`}
      >
        <div className="jobprog-fill" style={{ width: `${Math.max(2, job.percent)}%` }} />
      </div>
      <ol className="jobprog-list">
        {job.items.map((it, i) => (
          <li key={`${it.label}-${i}`} className={`jobprog-item s-${it.state}`}>
            <span className="jobprog-state">{STATE_ZH[it.state]}</span>
            <span className="jobprog-label">{it.label}</span>
            {it.detail ? <span className="muted small">{it.detail}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
