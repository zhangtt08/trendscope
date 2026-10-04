/**
 * 趋势分解展示(Stage 9.5 §55-§59)。
 *
 * 唯一一份实现:趋势中心的展开行和话题详情的趋势区共用它。此前话题页自己写死了
 * 一套权重(0.35/0.25/0.15/0.15/0.10)来还原分解,而趋势中心读的是另一个字段 ——
 * 两处必然随引擎漂移,现在统一成"服务端给什么就显示什么"(§50)。
 */
import { ScoreBar, LifecycleBadge } from "./ScoringBadges";
import { MethodNote } from "./MethodNote";
import type { TrendComponentView, TrendDetailPayload } from "../types/scoring";
import { fmtDateTime, EM_DASH } from "../lib/format";

const ORDER = ["contentGrowth", "engagementGrowth", "creatorGrowth", "burstDensity", "acceleration"];

/** §56:每组件一句话说明,说清算的是什么,不夸大成预测。 */
const TOOLTIPS: Record<string, string> = {
  contentGrowth: "当前窗口新增内容数 ÷ 基准窗口新增内容数的增长映射;持平=50,4 倍≈80。",
  engagementGrowth: "成员的平均原始互动动量在两个窗口间的变化(按平台权重归一,不跨平台原值相加)。",
  creatorGrowth: "当前窗口活跃创作者数相对基准窗口的变化。",
  burstDensity: "近期内容中,内容爆发指数达到阈值的占比。",
  acceleration: "内容增长的二阶变化:当前窗口新增 − 基准窗口新增。",
};

/** §57:整数或最多一位小数,绝不 83.239847。 */
export function formatNum(v: unknown): string {
  if (v === null || v === undefined) return EM_DASH;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return EM_DASH;
    return String(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  }
  return String(v);
}

function evidenceLines(c: TrendComponentView): [string, string][] {
  if (!c.evidence) return [];
  return Object.entries(c.evidence).map(([k, v]) => [k, formatNum(v)]);
}

export function TrendBreakdown({ detail }: { detail: TrendDetailPayload }) {
  if (!detail.breakdownRecorded || !detail.components) {
    return (
      <div className="small muted">
        这一版评分没有记录组件分解(早于可解释性升级)。
        到趋势中心重新运行评分后,即可看到每个组件的分数、有效权重与关键证据 ——
        在此之前不做任何反推冒充。
      </div>
    );
  }

  const unavailable = Object.entries(detail.unavailableReasons ?? {});

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          gap: "8px 16px",
        }}
      >
        {ORDER.map((k) => {
          const c = detail.components?.[k];
          if (!c) return null;
          const lines = evidenceLines(c);
          return (
            <div key={k} className="small" title={TOOLTIPS[k]}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>
                  {c.label}
                  {!c.available && <span className="muted">(不可用)</span>}
                </span>
                <span className="mono muted">
                  有效 {c.effectiveWeight === null ? "—" : `${Math.round(c.effectiveWeight * 1000) / 10}%`}
                </span>
              </span>
              {c.available ? (
                <>
                  <ScoreBar score={c.score} width={120} />
                  {lines.length > 0 && (
                    <span className="mono small muted" style={{ display: "block", marginTop: 2 }}>
                      {lines.map(([kk, vv]) => `${kk} ${vv}`).join(" · ")}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted" style={{ display: "block" }}>
                  数据不足 —— {c.reason ?? "该组件当前无法计算"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {unavailable.length > 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>
          缺失信号(权重已按比例重归一,未当 0 计入):
          {unavailable.map(([k, r]) => `${detail.components?.[k]?.label ?? k}(${r})`).join("、")}
        </div>
      )}

      <MethodNote kind="trend" ctx={{ scoreVersion: detail.scoreVersion, calculatedAt: detail.calculatedAt }} />
    </div>
  );
}

/** §58/§59:当前阶段 + 最近一次迁移及原因 + 待确认的滞回状态。 */
export function LifecycleExplain({
  detail,
  events,
}: {
  detail: Pick<TrendDetailPayload, "lifecycle" | "pendingLifecycle" | "pendingCount">;
  events?: { fromState: string | null; toState: string; reason: string; occurredAt: string }[];
}) {
  const last = events?.[0] ?? null;
  const pendingZh: Record<string, string> = {
    emerging: "新兴",
    rising: "上升",
    peak: "高位",
    saturated: "饱和",
    declining: "下降",
    evergreen: "常青",
  };
  return (
    <div className="small" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted">当前阶段:</span>
        <LifecycleBadge state={detail.lifecycle} />
      </div>
      {last && (
        <div className="muted" style={{ marginTop: 4 }}>
          最近迁移:{last.fromState ? `${pendingZh[last.fromState] ?? last.fromState} → ` : ""}
          {pendingZh[last.toState] ?? last.toState} · {fmtDateTime(last.occurredAt)} · 依据:{last.reason}
        </div>
      )}
      {detail.pendingLifecycle && (
        <div className="chip b-partial" style={{ marginTop: 6 }}>
          检测到{pendingZh[detail.pendingLifecycle] ?? detail.pendingLifecycle}信号,等待连续观察确认
          (第 {detail.pendingCount} 次)
        </div>
      )}
      <MethodNote kind="lifecycle" />
    </div>
  );
}
