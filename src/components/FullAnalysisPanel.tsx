/**
 * 一键全分析(§37-§39)的唯一前端实现。
 *
 * 提供三样东西:
 *  - `useFullRefresh`:启动 + 轮询进度(所有页面共用,不再各自顺序 POST 四个引擎);
 *  - `<FullAnalysisPanel>`:首页用的完整卡片(当前第几步 / 哪一步失败 / 为什么);
 *  - `<RefreshBar>`:工作台里的一行式紧凑触发器。
 *
 * 已跑完的步骤结果不会被后续失败回滚;AI 选题方案不在这条流水线里。
 */
import { useEffect, useRef, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { post } from "../lib/api";
import { useResource } from "../lib/useResource";
import { fmtDateTime, fmtMetric } from "../lib/format";
import { LoadError, RefreshHint } from "./RequestState";
import { RUN_STATUS_ZH, STEP_STATE_CLS, STEP_STATE_ZH, type AnalysisRun, type AnalysisStatus } from "../types/analysis";

const VALUE_ZH: Record<string, string> = {
  lexical: "本地词法基线",
  api: "语义向量",
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  balanced: "均衡",
  early_discovery: "早期发现",
};

const RESULT_LABELS: Record<string, string> = {
  runId: "运行编号",
  jobId: "向量任务",
  analysisRunId: "话题分析编号",
  mode: "模式",
  status: "结果",
  total: "总计",
  succeeded: "成功",
  failed: "失败",
  skipped: "跳过",
  topicCount: "话题数",
  topicsCreated: "新建话题",
  contentsAnalyzed: "分析内容数",
  topicsAnalyzed: "分析话题数",
  contentCount: "内容数",
  scorableCount: "可评分",
  unscorableCount: "不可评分",
  scored: "已评分",
  considered: "参与统计",
  topicsConsidered: "参与话题",
  patternScorable: "共性可评",
  emergingAngleCount: "新兴角度",
  transitions: "阶段切换",
  durationMs: "耗时(ms)",
  spaceUpgraded: "升级到语义空间",
  note: "说明",
  // 下面这些是截图里真泄漏给用户的内部键名(2026-09-29):标签表不全时
  // 渲染函数会把 camelCase 原样打出来,所以补齐 + 由测试钉住"不出现裸键名"。
  averageCohesion: "平均内聚度",
  medianCohesion: "中位内聚度",
  unclusteredRate: "未归类比例",
  needsReviewCount: "待复核话题",
  reembeddedAfterMissing: "补向量后重聚条数",
  patternInsufficient: "共性样本不足",
  profileId: "机会模型",
  profileVersion: "模型版本",
  unscorable: "不可评分",
  giantClusterCount: "超大簇",
  scoreVersion: "评分版本",
};

/** 导出只为让测试能钉住「界面不许出现裸键名」这条口径。 */
export function resultLine(result: Record<string, unknown> | null): string {
  if (!result) return "";
  return Object.entries(result)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${RESULT_LABELS[k] ?? k} ${typeof v === "boolean" ? (v ? "是" : "否") : typeof v === "number" ? fmtMetric(v) : VALUE_ZH[String(v)] ?? String(v)}`)
    .slice(0, 6)
    .join(" · ");
}

export interface FullRefreshState {
  run: AnalysisRun | null;
  running: boolean;
  starting: boolean;
  error: string | null;
  start: () => void;
  loadError: string | null;
  reload: () => void;
}

export function useFullRefresh(onChanged?: () => void, trigger?: "manual" | "first-run"): FullRefreshState {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // 提交之后到"看得见进度"之间有一段空档:运行记录是在后台任务里创建的,
  // 首帧可能还没有它。只看 status==='running' 会永远等不到第一次轮询 —— 所以
  // 提交后先固定跟踪一段时间,等进度真的出现后再由 running 接手。
  const [tracking, setTracking] = useState(false);
  const busyRef = useRef(false);
  const runRes = useResource<{ run: AnalysisRun | null }>("/analysis/full-refresh/latest");
  const run = runRes.data?.run ?? null;
  const running = run?.status === "running";
  const handledRef = useRef<number | null>(null);
  const trackingSinceRef = useRef<number>(0);

  useEffect(() => {
    if (!running && !tracking) return;
    if (tracking && trackingSinceRef.current && Date.now() - trackingSinceRef.current > 90_000) {
      setTracking(false);
      return;
    }
    const t = window.setInterval(() => runRes.reload(), 1500);
    return () => window.clearInterval(t);
  }, [running, tracking, runRes.reload]);

  // 一次运行结束后只通知调用方一次(轮询会反复拿到同一行已完成记录)
  useEffect(() => {
    if (!run || run.status === "running") return;
    setTracking(false);
    if (handledRef.current === run.id) return;
    handledRef.current = run.id;
    onChanged?.();
  }, [run?.id, run?.status]);

  function start() {
    if (busyRef.current) return;
    busyRef.current = true;
    setStarting(true);
    setError(null);
    void post("/analysis/full-refresh", { wait: false, trigger: trigger ?? "manual" })
      .then(() => {
        trackingSinceRef.current = Date.now();
        setTracking(true);
        window.setTimeout(() => runRes.reload(), 300);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busyRef.current = false;
        setStarting(false);
      });
  }

  return { run, running: running || tracking, starting, error, start, loadError: runRes.error, reload: runRes.reload };
}

export function RefreshBar({ state, onDone }: { state: FullRefreshState; onDone?: () => void }) {
  const { run, running, starting, error, start } = state;
  void onDone;
  const current = run?.steps.find((s) => s.key === run.currentStep) ?? null;
  const done = run?.steps.filter((s) => s.state === "completed" || s.state === "skipped").length ?? 0;
  return (
    <>
      <button className="btn-sm ok" disabled={running || starting} onClick={start} title="按序执行:向量 → 话题(仅首跑) → 爆发指数 → 趋势 → 共性/饱和 → 机会指数">
        {running ? <RefreshCw size={12} className="spin" /> : <Play size={12} />} {running ? "分析运行中…" : "刷新全部分析"}
      </button>
      <RefreshHint show={starting || running} text={current ? `正在执行:第 ${done + 1} 步 ${current.label}` : "正在启动…"} />
      {error && <span className="small" style={{ color: "var(--bad)" }}>{error}</span>}
    </>
  );
}

export function FullAnalysisPanel({ status, onChanged }: { status: AnalysisStatus | null; onChanged?: () => void }) {
  const state = useFullRefresh(onChanged, status?.isEmpty ? "first-run" : "manual");
  const { run, running, starting, error, start, loadError, reload } = state;
  // 提交后到进度行出现之间有一两秒:这段不能继续显示上一次的步骤还挂着"正在运行",
  // 否则用户会以为上次那批步骤是本次的结果。
  const waitingForProgress = running && run?.status !== "running";

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">刷新全部分析</div>
          <div className="section-hint">
            按序执行:更新内容向量 → 首次话题分析 → 内容爆发指数 → 话题趋势与生命周期 → 爆发共性与饱和度 → 选题机会指数。
            已完成的步骤不会因后续失败被回滚;AI 选题方案不在其中(那需要你逐项点击生成)。
          </div>
        </div>
        <div className="row-actions">
          <RefreshHint
            show={starting || running}
            text={waitingForProgress ? "已提交,等待进度出现…" : running ? "正在运行…" : "正在启动…"}
          />
          <button title={running || starting ? "正在处理,请稍候" : undefined} type="button" className="btn accent" onClick={start} disabled={running || starting}>
            {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />} {running ? "正在运行" : "刷新全部分析"}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner err" role="alert">
          <span style={{ flex: 1 }}>启动失败:{error}</span>
          <button type="button" className="btn secondary" onClick={start}>
            重试
          </button>
        </div>
      )}
      {loadError && !run && <LoadError message={loadError} onRetry={reload} />}
      {run?.error && (
        <div className="banner err" role="alert">
          <b>{RUN_STATUS_ZH[run.status]}:</b>
          <div>
            <div>{run.error}</div>
            <div className="small muted">前面已完成步骤的结果仍然保留;修好原因后可直接重跑整条流水线。</div>
          </div>
        </div>
      )}

      {!run ? (
        <div className="small muted">还没有运行记录。点「刷新全部分析」即可按序执行,不需要逐个引擎手点。</div>
      ) : (
        <>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {waitingForProgress && <span style={{ color: "var(--amber)" }}>下列步骤是上一次运行的结果</span>}
            {!waitingForProgress && "最近一次"}:{fmtDateTime(run.startedAt)} · {RUN_STATUS_ZH[run.status]}
            {run.durationMs !== null ? ` · ${run.durationMs}ms` : ""} · 触发方式{" "}
            {run.triggerSource === "first-run" ? "首次使用" : "手动"}
          </div>
          <ol className="refresh-steps">
            {run.steps.map((s) => (
              <li key={s.key} className={`step step-${s.state}`}>
                <span className={`chip-wrap ${STEP_STATE_CLS[s.state]}`}>{STEP_STATE_ZH[s.state]}</span>
                <div className="step-body">
                  <b>{s.label}</b>
                  {s.state === "failed" && s.error && <div className="small" style={{ color: "var(--bad)" }}>{s.error}</div>}
                  {s.state === "skipped" && s.error && <div className="small muted">{s.error}</div>}
                  {s.state === "completed" && s.result && <div className="small muted">{resultLine(s.result)}</div>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
