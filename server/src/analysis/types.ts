/** 一键全分析的类型(§37-§39)。UI 与 API 共用同一形状。 */

export type StepState = "pending" | "running" | "completed" | "failed" | "skipped";

export interface RefreshStep {
  key: string;
  label: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  /** 失败原因,或 skipped 的说明("为什么这一步没跑") */
  error: string | null;
  /** 可展示的事实摘要(条数/耗时),不放内部对象 */
  result: Record<string, unknown> | null;
}

export interface AnalysisRunRow {
  id: number;
  status: "running" | "completed" | "partial" | "failed";
  triggerSource: string;
  currentStep: string | null;
  steps: RefreshStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface FullRefreshResult extends AnalysisRunRow {
  runId: number;
  /** 与旧契约保持兼容:各引擎的原始返回仍在顶层 */
  scoring: Record<string, unknown> | null;
  trend: Record<string, unknown> | null;
  intelligence: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
}

export const STEP_KEYS: { key: string; label: string }[] = [
  { key: "embedding", label: "更新内容向量" },
  { key: "topics", label: "话题分析" },
  { key: "scoring", label: "内容爆发指数" },
  { key: "trend", label: "话题趋势与生命周期" },
  { key: "intelligence", label: "爆发共性与饱和度" },
  { key: "opportunity", label: "选题机会指数" },
];

export const STEP_STATE_ZH: Record<StepState, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export const RUN_STATUS_ZH: Record<AnalysisRunRow["status"], string> = {
  running: "正在运行",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
};
