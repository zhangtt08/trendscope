/**
 * Candidate Workbench / 内容候选工作台(Stage 3 → Stage 4 §0 语义修正):
 * 把趋势证据转成候选决策。原"Topic Workbench"更名(操作对象是 ContentItem,
 * 未来真正的 Topic Engine 不得复用本概念)。
 *
 * Filter Preset(Stage 4 §0 第一条):
 *   All(默认)/ Mid-tier Discovery / High Engagement / Custom。
 *   Mid-tier Discovery(点赞 300–5000)是【用户筛选预设】——用户偏好腰部内容
 *   的可选项,不是系统对"潜力内容"的科学定义。
 * 分数列 = Raw Momentum Score(原始互动动量),透明启发式,非任何潜力评分。
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../lib/api";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import { PLATFORM_LABELS, fmtMetric, fmtDateTime, EM_DASH } from "../lib/format";
import MomentumTable, { PickStatusChip, type BurstCell } from "../components/MomentumTable";
import type { ContentScoreRow, Paged } from "../types/scoring";
import type { MomentumResult, PickListResult, MomentumRow } from "../types/trend";

type Tab = "pool" | "adopted" | "rejected" | "candidate";
type Preset = "all" | "mid" | "high" | "custom";

const TABS: { key: Tab; label: string }[] = [
  { key: "pool", label: "动量池" },
  { key: "candidate", label: "候选" },
  { key: "adopted", label: "已采纳" },
  { key: "rejected", label: "已放弃" },
];

const PRESETS: { key: Preset; label: string; hint: string }[] = [
  { key: "all", label: "全部", hint: "全部内容(默认)" },
  { key: "mid", label: "腰部内容", hint: "用户筛选预设:点赞 300–5000 的腰部内容偏好,非科学定义" },
  { key: "high", label: "高互动", hint: "按互动率降序(需要点赞/评论/分享/收藏/播放全已知)" },
  { key: "custom", label: "自定义", hint: "手动指定点赞区间" },
];

export default function Workbench() {
  const [tab, setTab] = useState<Tab>("pool");
  const [windowDays, setWindowDays] = useState(7);
  const [preset, setPreset] = useState<Preset>("all");
  const [likesMin, setLikesMin] = useState("300");
  const [likesMax, setLikesMax] = useState("5000");
  const [platform, setPlatform] = useState("");
  const [keyword, setKeyword] = useState("");

  const [opErr, setOpErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [noteOpen, setNoteOpen] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");

  const debouncedKeyword = useDebounced(keyword, 250);

  const picksRes = useResource<PickListResult>(
    `/picks${buildQuery(tab === "pool" ? { pageSize: 200 } : { status: tab, pageSize: 200 })}`,
  );

  // 只有候选池需要动量榜;tab 切走时 path=null → hook 不发请求也不留旧请求的尾巴
  const momentumPath = (() => {
    if (tab !== "pool") return null;
    const q: Record<string, string | number> = { windowDays, pageSize: 50 };
    if (preset === "mid") {
      q.likesMin = likesMin || "300";
      q.likesMax = likesMax || "5000";
    } else if (preset === "custom") {
      if (likesMin) q.likesMin = likesMin;
      if (likesMax) q.likesMax = likesMax;
    } else if (preset === "high") {
      q.sortBy = "engagement";
    } // all: no extra filters
    if (platform) q.platform = platform;
    if (debouncedKeyword) q.keyword = debouncedKeyword;
    return `/trends/momentum${buildQuery(q)}`;
  })();
  const momentumRes = useResource<MomentumResult>(momentumPath);

  const burstRes = useResource<Paged<ContentScoreRow>>("/trends/contents?page=1&pageSize=100");
  const burstByItem = useMemo(() => {
    if (!burstRes.data) return null;
    const m = new Map<number, BurstCell>();
    for (const row of burstRes.data.rows) {
      m.set(row.contentItemId, { score: row.score, scorable: row.scorable === 1 });
    }
    return m;
  }, [burstRes.data]);

  const picks = picksRes.data;
  const momentum = momentumRes.data;
  const counts = picks?.counts ?? {};

  const reloadAll = () => {
    picksRes.reload();
    momentumRes.reload();
  };

  async function decide(
    row: MomentumRow | { itemId: number; rawMomentumScore?: number },
    status: string,
    note?: string | null,
  ) {
    setBusy(row.itemId);
    setOpErr(null);
    try {
      await post("/picks", {
        contentItemId: row.itemId,
        status,
        note: note ?? null,
        rawMomentumScore: row.rawMomentumScore ?? null,
        windowDays,
      });
      setNoteOpen(null);
      setNoteText("");
      reloadAll();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function unpick(itemId: number) {
    setBusy(itemId);
    setOpErr(null);
    try {
      await api(`/picks/${itemId}`, { method: "DELETE" });
      reloadAll();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const countOf = (s: string) => counts[s] ?? 0;

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>内容候选工作台</h1>
        <span className="section-hint">
          筛选预设可在「全部」与自定义之间切换 · 决策时快照当时的原始互动动量,可回溯{" "}
          <RefreshHint show={picksRes.refreshing || momentumRes.refreshing} />
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn-sm${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key !== "pool" ? ` (${countOf(t.key)})` : ""}
          </button>
        ))}
      </div>

      {tab === "pool" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span className="small muted">筛选预设</span>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={`btn-sm${preset === p.key ? " active" : ""}`}
                title={p.hint}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
            {preset === "mid" && (
              <span className="small muted" title={PRESETS[1].hint}>
                = 用户筛选预设(腰部内容偏好),非“潜力内容”的科学定义
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span className="small muted">窗口</span>
            {[1, 7, 14, 30].map((w) => (
              <button key={w} className={`btn-sm${windowDays === w ? " active" : ""}`} onClick={() => setWindowDays(w)}>
                {w}天
              </button>
            ))}
            {(preset === "mid" || preset === "custom") && (
              <>
                <span className="small muted" style={{ marginLeft: 12 }}>点赞区间</span>
                <input aria-label="点赞区间下限" className="input" style={{ width: 90 }} value={likesMin} onChange={(e) => setLikesMin(e.target.value)} placeholder="下限" />
                <span className="small muted">–</span>
                <input aria-label="点赞区间上限" className="input" style={{ width: 90 }} value={likesMax} onChange={(e) => setLikesMax(e.target.value)} placeholder="上限" />
              </>
            )}
            <select aria-label="平台筛选" className="input" style={{ width: 130 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">全部平台</option>
              {Object.entries(PLATFORM_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <input aria-label="标题/正文关键词" className="input" style={{ width: 150 }} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="标题/正文关键词" />
          </div>
        </>
      )}

      {picksRes.error && <LoadError message={picksRes.error} onRetry={picksRes.reload} />
      }
      {momentumRes.error && <LoadError message={momentumRes.error} onRetry={momentumRes.reload} />
      }
      {opErr && <div className="banner err" role="alert">{opErr}</div>}

      {tab === "pool" ? (
        momentum ? (
          <MomentumTable
            burstByItem={burstByItem ?? undefined}
            rows={momentum.rows}
            emptyHint="当前筛选下没有带趋势证据的内容——需要窗口内 ≥2 个快照观测。到采集中心跑一次采集,或到导入中心导入一批数据即可产生增量。"
            actions={(r) => (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <button className="btn-sm ok" disabled={busy === r.itemId} onClick={() => decide(r, "adopted")} title="采纳为选题">
                  采纳
                </button>
                <button className="btn-sm bad" disabled={busy === r.itemId} onClick={() => decide(r, "rejected")} title="放弃">
                  放弃
                </button>
                <button
                  className="btn-sm"
                  disabled={busy === r.itemId}
                  onClick={() => {
                    if (noteOpen === r.itemId) {
                      decide(r, "candidate", noteText || null);
                    } else {
                      setNoteOpen(r.itemId);
                      setNoteText("");
                    }
                  }}
                  title="标记候选（可附备注）"
                >
                  {noteOpen === r.itemId ? "存备注" : "候选"}
                </button>
                {noteOpen === r.itemId && (
                  <input aria-label="备注"
                    className="input"
                    style={{ width: 160 }}
                    autoFocus
                    value={noteText}
                    placeholder="备注（可空）"
                    onChange={(e) => setNoteText(e.target.value)}
                  />
                )}
                {r.pick && (
                  <button className="btn-sm" disabled={busy === r.itemId} onClick={() => unpick(r.itemId)} title="移除决策记录">
                    ✕
                  </button>
                )}
              </div>
            )}
          />
        ) : null
      ) : picks ? (
        picks.rows.length === 0 ? (
          <div className="banner">
            当前筛选状态下没有候选内容 —— 换一个状态标签,或到「内容浏览器」放宽筛选条件。
            候选清单来自内容评分结果,尚未运行评分时这里本来就该是空的。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>标题</th>
                  <th scope="col">平台</th>
                  <th scope="col" className="num">当时点赞</th>
                  <th scope="col" className="num">原始互动动量</th>
                  <th scope="col">状态</th>
                  <th scope="col">备注</th>
                  <th scope="col">更新时间</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {picks.rows.map((p) => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                      <Link to={`/content/${p.contentItemId}`} style={{ color: "var(--ink)" }}>
                        {p.title ?? <span className="null-mark">—</span>}
                      </Link>
                    </td>
                    <td>
                      <span className="plat-tag">{PLATFORM_LABELS[p.platform] ?? p.platform}</span>
                    </td>
                    <td className="num">{fmtMetric(p.likes)}</td>
                    <td className="num mono">{p.rawMomentumScore ?? EM_DASH}</td>
                    <td><PickStatusChip status={p.status} /></td>
                    <td className="small" style={{ maxWidth: 200, overflowWrap: "anywhere" }}>{p.note ?? EM_DASH}</td>
                    <td className="mono small">{fmtDateTime(p.updatedAt)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {p.status !== "adopted" && (
                          <button title={busy === p.contentItemId ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={busy === p.contentItemId} onClick={() => decide({ itemId: p.contentItemId, rawMomentumScore: p.rawMomentumScore ?? undefined }, "adopted")}>
                            采纳
                          </button>
                        )}
                        {p.status !== "rejected" && (
                          <button title={busy === p.contentItemId ? "正在处理,请稍候" : undefined} className="btn-sm bad" disabled={busy === p.contentItemId} onClick={() => decide({ itemId: p.contentItemId, rawMomentumScore: p.rawMomentumScore ?? undefined }, "rejected")}>
                            放弃
                          </button>
                        )}
                        {p.status !== "candidate" && (
                          <button title={busy === p.contentItemId ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busy === p.contentItemId} onClick={() => decide({ itemId: p.contentItemId, rawMomentumScore: p.rawMomentumScore ?? undefined }, "candidate")}>
                            回候选
                          </button>
                        )}
                        <button className="btn-sm" disabled={busy === p.contentItemId} onClick={() => unpick(p.contentItemId)} title="移除决策记录">
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
