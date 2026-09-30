/**
 * Stage 7 评分徽章与展示件(§BO/§BL/§BV):
 * 全中文标签;不出现裸英文状态;无假精确(整数或一位小数);数据不足显式标注。
 */
import type { BurstComponent, LifecycleState } from "../types/scoring";

export const LIFECYCLE_ZH: Record<LifecycleState | "unknown", string> = {
  emerging: "新兴",
  rising: "上升",
  peak: "高位",
  saturated: "饱和",
  declining: "下降",
  evergreen: "常青",
  unknown: "数据不足",
};

/** 颜色沿用现有设计系统(b-* 系列徽章),不新增彩虹配色(§BO)。 */
const LIFECYCLE_CLS: Record<LifecycleState | "unknown", string> = {
  emerging: "chip b-processing",
  rising: "chip b-completed",
  peak: "chip b-completed",
  saturated: "chip b-partial",
  declining: "chip b-failed",
  evergreen: "chip b-completed",
  unknown: "chip b-processing",
};

export function LifecycleBadge({ state }: { state: string | null }) {
  const key = (state ?? "unknown") as LifecycleState | "unknown";
  return (
    <span
      className={LIFECYCLE_CLS[key] ?? "chip b-processing"}
      title={key === "unknown" ? "历史不足或尚未运行趋势评分;Topic.status(活跃/待复核)与生命周期是两个概念" : `生命周期: ${LIFECYCLE_ZH[key]}`}
    >
      {LIFECYCLE_ZH[key] ?? state}
    </span>
  );
}

export const CONFIDENCE_ZH: Record<string, string> = { high: "高", medium: "中", low: "低" };
const CONFIDENCE_CLS: Record<string, string> = { high: "chip b-completed", medium: "chip b-partial", low: "chip b-failed" };

export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return <span className="null-mark">—</span>;
  return (
    <span className={CONFIDENCE_CLS[confidence] ?? "chip b-processing"} title={`置信度: ${CONFIDENCE_ZH[confidence] ?? confidence}`}>
      {CONFIDENCE_ZH[confidence] ?? confidence}
    </span>
  );
}

export const UNSCORABLE_ZH: Record<string, string> = {
  insufficient_snapshots: "快照不足(需多次采集)",
  insufficient_metrics: "关键指标缺失",
  insufficient_cohort: "可比样本不足",
  insufficient_members: "成员数不足",
};

/** 0-100 分 + 细条;null 显示 数据不足(绝不显示 0 分冒充)。 */
export function ScoreBar({ score, width = 72 }: { score: number | null; width?: number }) {
  if (score === null || score === undefined) return <span className="small muted">数据不足</span>;
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 70 ? "var(--ok)" : clamped >= 40 ? "var(--amber)" : "var(--ink-faint)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="mono" style={{ minWidth: 34, textAlign: "right" }}>{Math.round(clamped)}</span>
      <span style={{ display: "inline-block", width, height: 6, background: "var(--panel-2)", borderRadius: 1 }}>
        <span style={{ display: "block", width: `${clamped}%`, height: "100%", background: color }} />
      </span>
    </span>
  );
}

/** 组件分解条(§Y):velocity/reach/EQ/relative/structure;不可用 = 未计入(权重已重归一)。 */
const COMPONENT_ZH: Record<string, string> = {
  velocity: "互动增速",
  reach: "触达",
  engagementQuality: "互动质量",
  relativePerformance: "相对表现",
  interactionStructure: "互动结构",
  contentGrowth: "内容增长",
  engagementGrowth: "互动增长",
  creatorGrowth: "创作者增长",
  burstDensity: "爆发密度",
  acceleration: "加速度",
};

/**
 * 组件分解条。`effectiveWeights` 是 missing-aware 重归一后的实际权重(§53):
 * 只显示名义权重会误导 —— 缺一个组件时,名义值加起来根本不是 100%。
 */
export function BreakdownBars({
  breakdown,
  order,
  effectiveWeights,
}: {
  breakdown: Record<string, BurstComponent>;
  order: string[];
  effectiveWeights?: Record<string, number> | null;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px 16px" }}>
      {order.map((k) => {
        const c = breakdown[k];
        if (!c) return null;
        const eff = effectiveWeights?.[k];
        return (
          <div
            key={k}
            className="small"
            title={
              c.available
                ? `名义权重 ${(c.weight * 100).toFixed(0)}%${eff !== undefined ? ` · 实际有效 ${(eff * 100).toFixed(0)}%` : ""}`
                : "该信号缺失,未计入(权重已重归一)"
            }
          >
            <span style={{ display: "inline-flex", justifyContent: "space-between", width: "100%" }}>
              <span>
                {COMPONENT_ZH[k] ?? k}
                {!c.available && <span className="muted">(缺失)</span>}
              </span>
              <span className="mono muted">
                {eff !== undefined && eff !== c.weight ? `${Math.round(eff * 1000) / 10}%` : `${Math.round(c.weight * 100)}%`}
              </span>
            </span>
            <ScoreBar score={c.available ? c.score : null} width={110} />
          </div>
        );
      })}
    </div>
  );
}
