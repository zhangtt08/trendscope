/** Content Detail 的内容爆发指数卡(§BR):分解 + 置信度 + Cohort + 证据。 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtDateTime, EM_DASH } from "../lib/format";
import { ConfidenceBadge, BreakdownBars, UNSCORABLE_ZH } from "./ScoringBadges";
import type { ContentScoreDetail } from "../types/scoring";

function parse<T>(v: string | T | null | undefined): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v;
}

interface BurstEvidence {
  cohort?: { key: string; level: string; size: number };
  creator?: { basis: string; historyCount: number | null };
  velocity?: { primaryWindow?: string; perHour?: number | null; windows?: Record<string, { 可用: boolean; 每小时动量: number | null }> };
  confidenceReasons?: string[];
  unavailableComponents?: string[];
  reason?: string;
}

export function BurstScoreCard({ contentItemId }: { contentItemId: number }) {
  const [data, setData] = useState<ContentScoreDetail | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    setData(null);
    setMiss(false);
    api<ContentScoreDetail>(`/scoring/content/${contentItemId}`)
      .then(setData)
      .catch(() => setMiss(true));
  }, [contentItemId]);

  if (miss) {
    return (
      <div className="card small" style={{ marginBottom: 12 }}>
        <div className="stat-label" style={{ marginBottom: 4 }}>内容爆发指数</div>
        <div className="muted">尚未运行内容评分 —— 到 <b>趋势中心 → 内容爆发</b> 点击「运行内容评分」。</div>
      </div>
    );
  }
  if (!data?.current) return null;
  const cur = data.current;
  const bd = parse<Record<string, unknown>>(cur.breakdown as string | null);
  const ev = parse<BurstEvidence>(cur.evidence) ?? {};
  const breakdown = (bd ?? {}) as Record<string, { score: number | null; weight: number; available: boolean }>;
  // 引擎把 missing-aware 重归一后的实际权重一起存在 breakdown JSON 里(§53 必须可见)
  const effectiveWeights = (bd?.weightsUsed ?? null) as Record<string, number> | null;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        内容爆发指数
        <span className="muted small" style={{ marginLeft: 8 }}>
          ({cur.scoreVersion};相对同组的异常表现量化,不是未来爆款概率)
        </span>
      </div>
      {cur.scorable === 0 ? (
        <div className="small muted">
          数据不足:{UNSCORABLE_ZH[cur.unscorableReason ?? ""] ?? cur.unscorableReason ?? EM_DASH}
          {ev.reason ? ` —— ${ev.reason}` : ""}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <div className="mono" style={{ fontSize: 32, fontWeight: 600 }}>
              {cur.overallScore !== null ? Math.round(cur.overallScore) : EM_DASH}
              <span className="small muted" style={{ fontSize: 12, marginLeft: 4 }}>/ 100</span>
            </div>
            <div className="small">
              <span className="muted">置信度:</span>
              <ConfidenceBadge confidence={cur.confidence} />
            </div>
            {ev.cohort && (
              <div className="small">
                <span className="muted">比较基准:</span>
                <span className="mono">
                  {ev.cohort.level} · n={ev.cohort.size}
                </span>
              </div>
            )}
            {ev.creator && (
              <div className="small">
                <span className="muted">相对基准:</span>
                {ev.creator.basis === "creator" ? `作者历史(中位,n=${ev.creator.historyCount ?? "—"})` : ev.creator.basis === "cohort" ? "同组内容" : "未知"}
              </div>
            )}
            {ev.velocity?.primaryWindow && (
              <div className="small">
                <span className="muted">速度窗口:</span>
                <span className="mono">{ev.velocity.primaryWindow}</span>
                {ev.velocity.perHour !== null && ev.velocity.perHour !== undefined && (
                  <span className="mono muted"> · {Math.round(ev.velocity.perHour)} 动量/小时</span>
                )}
              </div>
            )}
          </div>
          {bd && (
            <BreakdownBars
              breakdown={breakdown}
              order={["velocity", "reach", "engagementQuality", "relativePerformance", "interactionStructure"]}
              effectiveWeights={effectiveWeights}
            />
          )}
          {(ev.confidenceReasons?.length || ev.unavailableComponents?.length) && (
            <div className="small muted" style={{ marginTop: 6 }}>
              {ev.confidenceReasons?.join(";")}
              {ev.unavailableComponents?.length ? `${ev.confidenceReasons?.length ? ";" : ""}缺失信号(权重已重归一):${ev.unavailableComponents.join("、")}` : ""}
            </div>
          )}
          {data.history.length > 1 && (
            <div className="small mono muted" style={{ marginTop: 6 }}>
              历史评分:{data.history.slice(0, 5).map((hh) => `${fmtDateTime(hh.calculatedAt)}=${hh.overallScore !== null ? Math.round(hh.overallScore) : "—"}`).join(" · ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
