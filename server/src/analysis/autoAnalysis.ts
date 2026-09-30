/**
 * 采完即算 —— 采集运行落了新内容之后自动补一次分析,不需要人再点「刷新全部分析」。
 *
 * 边界(刻意的):
 * - 只在**本次真的入库了新内容**时触发;空跑、失败跑、取消跑不触发。
 * - 同一进程内只跑一个自动分析;手动全分析正在跑时这次自动跳过(不算失败,
 *   下一轮采集还会再来),绝不排队堆积。
 * - **AI 选题方案不在这里生成**:自动批量产内容不是本产品的职责,仍由用户在工作室点击。
 * - 关掉它不需要改代码:`TRENDSCOPE_AUTO_ANALYSIS=0`(默认开)。
 */
import type { DB } from "../db/client";
import { runFullRefresh } from "./fullRefresh";

export type AutoAnalysisStatus = "completed" | "partial" | "failed" | "skipped";

export interface AutoAnalysisState {
  enabled: boolean;
  running: boolean;
  lastTriggeredAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: AutoAnalysisStatus | null;
  lastError: string | null;
  /** 因手动分析占线而跳过的次数(用于界面解释"为什么这次没自动算") */
  skippedBusy: number;
  /** 累计自动触发次数 */
  triggered: number;
}

export const autoAnalysisState: AutoAnalysisState = {
  enabled: true,
  running: false,
  lastTriggeredAt: null,
  lastFinishedAt: null,
  lastStatus: null,
  lastError: null,
  skippedBusy: 0,
  triggered: 0,
};

export function autoAnalysisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TRENDSCOPE_AUTO_ANALYSIS?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** 采集运行结束后的挂点:同步返回,内部异步跑,绝不把异常抛回采集流程 */
export function startAutoAnalysis(
  db: DB,
  info: { accepted: number; status: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  autoAnalysisState.enabled = autoAnalysisEnabled(env);
  if (!autoAnalysisState.enabled) return false;
  if (info.accepted <= 0) return false;
  if (info.status === "cancelled") return false;
  if (autoAnalysisState.running) return false;

  autoAnalysisState.running = true;
  autoAnalysisState.triggered += 1;
  autoAnalysisState.enabled = true;
  autoAnalysisState.lastTriggeredAt = new Date().toISOString();

  void runFullRefresh(db, { trigger: "after-collection" })
    .then((res) => {
      const s = (res as { status?: string }).status;
      autoAnalysisState.lastStatus = s === "partial" ? "partial" : "completed";
      autoAnalysisState.lastError = (res as { error?: string | null }).error ?? null;
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // 引擎锁冲突不是故障:说明有人正在手动跑
      if (msg.includes("正在运行中")) {
        autoAnalysisState.lastStatus = "skipped";
        autoAnalysisState.skippedBusy += 1;
        autoAnalysisState.lastError = "手动分析正在运行,本次自动分析已跳过";
      } else {
        autoAnalysisState.lastStatus = "failed";
        autoAnalysisState.lastError = msg;
      }
    })
    .finally(() => {
      autoAnalysisState.running = false;
      autoAnalysisState.lastFinishedAt = new Date().toISOString();
    });

  return true;
}

/** 给状态端点用的快照(不返回任何密钥或外部地址) */
export function autoAnalysisSnapshot(): Omit<AutoAnalysisState, "enabled"> & { enabled: boolean } {
  autoAnalysisState.enabled = autoAnalysisEnabled();
  return { ...autoAnalysisState };
}
