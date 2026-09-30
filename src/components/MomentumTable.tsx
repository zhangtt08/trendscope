/**
 * Shared momentum table (Stage 3) — used by Trends (leaderboard) and
 * Candidate Workbench (with decision actions). null metrics render as "—".
 */
import { Link } from "react-router-dom";
import { EM_DASH, fmtMetric, fmtDateTime, PLATFORM_LABELS, CONTENT_TYPE_LABELS } from "../lib/format";
import { ScoreBar } from "./ScoringBadges";
import type { MomentumRow } from "../types/trend";

function Delta({ v, suffix = "" }: { v: number | null | undefined; suffix?: string }) {
  if (v === null || v === undefined) return <span className="null-mark">—</span>;
  const cls = v > 0 ? "delta-up" : v < 0 ? "delta-down" : "delta-flat";
  return (
    <span className={cls}>
      {v > 0 ? "+" : ""}
      {fmtMetric(v)}
      {suffix}
    </span>
  );
}

export function PickStatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    candidate: { label: "候选", cls: "chip q-partial" },
    adopted: { label: "已采纳", cls: "chip q-ok" },
    rejected: { label: "已放弃", cls: "chip q-bad" },
  };
  const m = map[status];
  if (!m) return <span className="mono small">{status}</span>;
  return <span className={m.cls}>{m.label}</span>;
}

export interface BurstCell {
  score: number | null;
  scorable: boolean;
}

export default function MomentumTable({
  rows,
  actions,
  emptyHint,
  burstByItem,
}: {
  rows: MomentumRow[];
  actions?: (row: MomentumRow) => React.ReactNode;
  emptyHint?: string;
  /** Stage 7 §BS:可选的爆发指数列(未传 = 不显示,零回归) */
  burstByItem?: Map<number, BurstCell>;
}) {
  if (rows.length === 0) {
    return <div className="banner">{emptyHint ?? "当前筛选下没有带趋势证据的内容（需要窗口内 ≥2 个快照观测）"}</div>;
  }
  return (
    <div className="table-wrap">
      <table className="ts">
        <thead>
          <tr>
            <th style={{ minWidth: 220 }}>标题</th>
            <th scope="col">平台</th>
            <th scope="col" className="num">Δ点赞</th>
            <th scope="col" className="num">Δ赞同</th>
            <th scope="col" className="num">Δ评论</th>
            <th scope="col" className="num">Δ分享</th>
            <th scope="col" className="num">Δ收藏</th>
            <th scope="col" className="num">日增赞</th>
            <th scope="col" className="num">互动率</th>
            <th scope="col" className="num" style={{ color: "var(--amber)" }} title="原始互动动量:按平台语义加权 —— 知乎用赞同/评论/分享/收藏,其余平台用点赞/评论/分享/收藏;权重 1/2/3/2 透明可解释">原始互动动量</th>
            <th scope="col">所属话题</th>
            {burstByItem ? <th title="内容爆发指数:相对同组的异常表现量化,非爆款预测">爆发指数</th> : null}
            <th scope="col">最近快照</th>
            <th scope="col">决策</th>
            {actions ? <th scope="col">操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId}>
              <td style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                <Link to={`/content/${r.itemId}`} style={{ color: "var(--ink)" }}>
                  {r.title ?? <span className="null-mark">—</span>}
                </Link>
                {r.unknownComponents.length > 0 && (
                  <span
                    className="chip q-partial"
                    title={`未知分量: ${r.unknownComponents.join(", ")}（按 0 计入动量分）`}
                    style={{ marginLeft: 6 }}
                  >
                    部分未知
                  </span>
                )}
              </td>
              <td>
                <span className="plat-tag">{PLATFORM_LABELS[r.platform] ?? r.platform}</span>
                <div className="small muted">{CONTENT_TYPE_LABELS[r.contentType] ?? r.contentType}</div>
              </td>
              <td className="num"><Delta v={r.delta.likes} /></td>
              <td className="num"><Delta v={r.delta.upvotes} /></td>
              <td className="num"><Delta v={r.delta.comments} /></td>
              <td className="num"><Delta v={r.delta.shares} /></td>
              <td className="num"><Delta v={r.delta.favorites} /></td>
              <td className="num"><Delta v={r.daily.likes} suffix="/d" /></td>
              <td className="num">
                {r.engagement === null ? (
                  <span className="null-mark">—</span>
                ) : (
                  `${(r.engagement * 100).toFixed(1)}%`
                )}
              </td>
              <td className="num mono" style={{ fontWeight: 600 }}>
                {r.rawMomentumScore === null || r.rawMomentumScore === undefined ? (
                  <span className="null-mark">—</span>
                ) : (
                  r.rawMomentumScore
                )}
              </td>
              <td>
                {r.topic ? (
                  <Link
                    to={`/topics/${r.topic.id}`}
                    className="mono small"
                    style={{ color: "var(--steel)" }}
                    title={`成员 ${r.topic.memberCount} 条 · 打开话题`}
                  >
                    {r.topic.name.slice(0, 14)}…
                    <div className="small muted">
                      {r.topic.saturation !== null && r.topic.saturation !== undefined ? `饱和 ${Math.round(r.topic.saturation)}` : ""}
                      {r.topic.novelty !== null && r.topic.novelty !== undefined ? ` · 新颖 ${Math.round(r.topic.novelty)}` : ""}
                      {r.topic.opportunity !== null && r.topic.opportunity !== undefined ? ` · 机会 ${Math.round(r.topic.opportunity)}` : ""}
                    </div>
                  </Link>
                ) : (
                  <span className="null-mark">未归类</span>
                )}
              </td>
              {burstByItem ? (
                <td>
                  {(() => {
                    const b = burstByItem.get(r.itemId);
                    if (!b) return <span className="null-mark">—</span>;
                    return b.scorable ? <ScoreBar score={b.score} width={56} /> : <span className="small muted">数据不足</span>;
                  })()}
                </td>
              ) : null}
              <td className="mono small">{r.last ? fmtDateTime(r.last.capturedAt) : EM_DASH}</td>
              <td>{r.pick ? <PickStatusChip status={r.pick.status} /> : <span className="small muted">未评估</span>}</td>
              {actions ? <td>{actions(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
