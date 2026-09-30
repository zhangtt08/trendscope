/** 分析状态与一键全分析的前端契约(与 server/src/analysis 同形)。 */

export interface GuideStep {
  key: "data" | "semantic" | "topics" | "analysis" | "studio";
  state: "done" | "todo" | "optional" | "blocked";
  label: string;
  detail: string;
  route: string;
}

export interface AnalysisStatus {
  generatedAt: string;
  isEmpty: boolean;
  data: {
    contentTotal: number;
    sourceKinds: Record<string, number>;
    demoShare: number | null;
    latestCollectedAt: string | null;
    latestRun: { id: number; status: string; startedAt: string | null; completedAt: string | null } | null;
    runningRuns: number;
    enabledTasks: number;
    quality: { missingPublishedAt: number; missingAnyMetric: number; missingAuthor: number };
    zhihuCredential: "configured" | "missing";
  };
  semantic: {
    mode: "none" | "lexical" | "semantic";
    activeSpaceId: string | null;
    dimension: number | null;
    embedded: number;
    pending: number;
    embeddingCredential: "configured" | "missing";
  };
  topics: {
    total: number;
    active: number;
    unclustered: number;
    lastRun: { id: number; status: string; createdAt: string; completedAt: string | null; topicsCreated: number } | null;
  };
  engines: {
    contentBurst: { scored: number; total: number; lastCalculatedAt: string | null };
    topicTrend: { scored: number; total: number; lastCalculatedAt: string | null };
    intelligence: { scored: number; total: number; lastCalculatedAt: string | null };
    opportunity: { scored: number; total: number; lastCalculatedAt: string | null };
  };
  autoAnalysis?: {
    enabled: boolean;
    running: boolean;
    lastTriggeredAt: string | null;
    lastFinishedAt: string | null;
    lastStatus: "completed" | "partial" | "failed" | "skipped" | null;
    lastError: string | null;
    skippedBusy: number;
    triggered: number;
  };
  studio: { configured: boolean; secretStatus: "configured" | "missing" };
  guide: GuideStep[];
}

export type StepState = "pending" | "running" | "completed" | "failed" | "skipped";

export interface RefreshStep {
  key: string;
  label: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

export interface AnalysisRun {
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

export const STEP_STATE_ZH: Record<StepState, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export const RUN_STATUS_ZH: Record<AnalysisRun["status"], string> = {
  running: "正在运行",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
};

export const STEP_STATE_CLS: Record<StepState, string> = {
  pending: "chip",
  running: "chip b-processing",
  completed: "chip b-completed",
  failed: "chip b-failed",
  skipped: "chip b-partial",
};
