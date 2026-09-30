/**
 * 选题机会工作台 (Stage 9 §31-§35/§80):机会指数 = 对当前已观察数据的结构化量化,
 * 不是未来结果概率;UI 禁"推荐/必做/最佳"话术(§78),只有排序依据与证据(§79)。
 * 默认排序:机会指数 DESC → 置信度(§33);全部 SQL 分页(§71)。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { patch } from "../lib/api";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import { fmtDateTime, EM_DASH } from "../lib/format";
import { LifecycleBadge, ConfidenceBadge, ScoreBar } from "../components/ScoringBadges";
import { RefreshBar, useFullRefresh } from "../components/FullAnalysisPanel";
import type { AnalysisStatus } from "../types/analysis";
import { LoadError, RefreshHint } from "../components/RequestState";
import type { Paged } from "../types/scoring";

const LEVEL_ZH: Record<string, string> = { high: "较高机会", medium: "中等机会", low: "较低机会" };
const LEVEL_CLS: Record<string, string> = { high: "chip b-completed", medium: "chip b-partial", low: "chip b-processing" };
const DECISION_ZH: Record<string, string> = { shortlisted: "已入选", reviewing: "观察中", dismissed: "已搁置", none: "—" };

function OppLevelBadge({ level }: { level: string | null }) {
  if (!level) return <span className="small muted">数据不足</span>;
  return <span className={LEVEL_CLS[level] ?? "chip b-processing"}>{LEVEL_ZH[level] ?? level}</span>;
}

interface OppRow {
  topicId: number;
  name: string;
  memberCount: number;
  score: number | null;
  confidence: string | null;
  opportunityLevel: string | null;
  deltaScore: number | null;
  calculatedAt: string | null;
  trendScore: number | null;
  lifecycle: string | null;
  burstDensity: number | null;
  saturationScore: number | null;
  noveltyScore: number | null;
  emergingAngleCount: number | null;
  decision: string | null;
  watchState: string | null;
}

export default function OpportunityWorkbench() {
  const [notice, setNotice] = useState<string | null>(null);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [minScore, setMinScore] = useState("");
  const [confidence, setConfidence] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [maxSat, setMaxSat] = useState("");
  const [minNovelty, setMinNovelty] = useState("");
  const [decision, setDecision] = useState("");
  const [sortBy, setSortBy] = useState("score");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyDecision, setBusyDecision] = useState<number | null>(null);

  // 数字输入框逐字符发请求没有意义 → 只给它们防抖;select/排序保持立即请求(§11)
  const debouncedMin = useDebounced(minScore, 250);
  const debouncedMaxSat = useDebounced(maxSat, 250);
  const debouncedMinNovelty = useDebounced(minNovelty, 250);

  const listPath = `/opportunity/topics${buildQuery({
    page,
    pageSize: 20,
    sortBy,
    order: "desc",
    minOpportunity: debouncedMin,
    confidence,
    lifecycle,
    maxSaturation: debouncedMaxSat,
    minNovelty: debouncedMinNovelty,
    decision,
  })}`;
  const res = useResource<Paged<OppRow>>(listPath);

  // 证据展开区也走同一个 hook。话题 id 变了就必须丢掉上一个话题的载荷,
  // 否则旧详情会短暂挂在新话题名下(§16 的实体级 stale)
  const detailRes = useResource<DetailData>(
    openId === null ? null : `/opportunity/topics/${openId}`,
    { resetOnPathChange: true },
  );

  // 编排统一走首页那一条流水线(§37):这里不再自己顺序 POST 四个引擎,
  // 否则同一个产品里会同时存在两套"刷新全部分析"的次序与错误处理。
  const statusRes = useResource<AnalysisStatus>("/analysis/status");
  const refresh = useFullRefresh(() => {
    res.reload();
    detailRes.reload();
  });

  async function applyDecision(id: number, status: string) {
    setBusyDecision(id);
    setOpErr(null);
    try {
      await patch(`/opportunity/topics/${id}/decision`, { status });
      setNotice(`已更新人工决策:${DECISION_ZH[status] ?? status}(决策不影响机会指数)`);
      res.reload();
      if (openId === id) detailRes.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyDecision(null);
    }
  }

  const data = res.data;
  const satBand = (v: number | null): string =>
    v === null || v === undefined ? EM_DASH : `${Math.round(v)} ${v < 34 ? "低" : v < 67 ? "中" : "高"}`;

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>选题机会</h1>
        <span className="section-hint">
          机会指数 = 基于已观察的趋势/爆发/新颖度/内容空间/共性/阶段的量化,用于比较当前数据条件下的话题;
          不是未来结果概率,不构成选题建议。 <RefreshHint show={res.refreshing} />
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <RefreshBar state={refresh} />
        <button title={res.loading ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={res.loading} onClick={res.reload}>刷新</button>
        <span className="small muted">最低指数</span>
        <input aria-label="最低指数" className="input" style={{ width: 80 }} placeholder="如 60" value={minScore} onChange={(e) => { setPage(1); setMinScore(e.target.value); }} />
        <span className="small muted">置信度</span>
        <select aria-label="置信度" className="input" style={{ width: 90 }} value={confidence} onChange={(e) => { setPage(1); setConfidence(e.target.value); }}>
          <option value="">全部</option>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
        <span className="small muted">生命周期</span>
        <select aria-label="生命周期" className="input" style={{ width: 100 }} value={lifecycle} onChange={(e) => { setPage(1); setLifecycle(e.target.value); }}>
          <option value="">全部</option>
          <option value="emerging">新兴</option>
          <option value="rising">上升</option>
          <option value="peak">高位</option>
          <option value="saturated">饱和</option>
          <option value="declining">下降</option>
          <option value="evergreen">常青</option>
        </select>
        <span className="small muted">饱和度≤</span>
        <input aria-label="饱和度≤" className="input" style={{ width: 70 }} placeholder="如 50" value={maxSat} onChange={(e) => { setPage(1); setMaxSat(e.target.value); }} />
        <span className="small muted">新颖度≥</span>
        <input aria-label="新颖度≥" className="input" style={{ width: 70 }} placeholder="如 60" value={minNovelty} onChange={(e) => { setPage(1); setMinNovelty(e.target.value); }} />
        <span className="small muted">决策</span>
        <select aria-label="决策" className="input" style={{ width: 100 }} value={decision} onChange={(e) => { setPage(1); setDecision(e.target.value); }}>
          <option value="">全部</option>
          <option value="shortlisted">已入选</option>
          <option value="reviewing">观察中</option>
          <option value="dismissed">已搁置</option>
        </select>
        <span className="small muted">排序</span>
        <select aria-label="排序" className="input" style={{ width: 120 }} value={sortBy} onChange={(e) => { setPage(1); setSortBy(e.target.value); }}>
          <option value="score">机会指数</option>
          <option value="delta">近期提升</option>
          <option value="trend">趋势指数</option>
          <option value="novelty">新颖度</option>
          <option value="memberCount">成员数</option>
          <option value="updatedAt">更新时间</option>
        </select>
      </div>

      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {opErr && <div className="banner err" role="alert">{opErr}</div>}
      {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}

      {res.initialLoading ? (
        <div className="spinner">正在加载…</div>
      ) : !data ? (
        null
      ) : data.rows.length === 0 ? (
        <div className="banner">
          {statusRes.data && statusRes.data.topics.total === 0 ? (
            <>
              还没有话题 —— 机会指数按话题计算。
              <Link to="/topics"> 先到话题页面运行话题分析 →</Link>
            </>
          ) : statusRes.data && statusRes.data.engines.opportunity.scored === 0 ? (
            <>
              已有 {statusRes.data.topics.active} 个活跃话题,但还没有机会结果 ——
              点上方「刷新全部分析」按序跑完趋势、情报与机会。
            </>
          ) : (
            <>当前筛选条件下没有话题可显示:先清空筛选条件,或点「刷新全部分析」更新结果。</>
          )}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th style={{ minWidth: 170 }}>话题</th>
                  <th scope="col">机会指数</th>
                  <th scope="col">置信度</th>
                  <th scope="col">生命周期</th>
                  <th scope="col" className="num">趋势</th>
                  <th scope="col" className="num">饱和度</th>
                  <th scope="col" className="num">新颖度</th>
                  <th scope="col" className="num">新兴角度</th>
                  <th scope="col" className="num">爆发占比</th>
                  <th scope="col" className="num">成员</th>
                  <th scope="col" className="num">近期变化</th>
                  <th scope="col">决策</th>
                  <th scope="col">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.topicId}>
                    <td>
                      <button
                        className="row-toggle"
                        aria-expanded={openId === r.topicId}
                        onClick={() => setOpenId(openId === r.topicId ? null : r.topicId)}
                      >
                        {r.name}
                      </button>
                      <Link to={`/topics/${r.topicId}`} className="mono small" style={{ marginLeft: 6, color: "var(--steel)" }}>话题详情 →</Link>
                      {r.decision && r.decision !== "none" && (
                        <span className="chip b-completed" style={{ marginLeft: 6 }}>{DECISION_ZH[r.decision] ?? r.decision}</span>
                      )}
                    </td>
                    <td>
                      {r.score === null ? (
                        <span className="small muted">数据不足</span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <ScoreBar score={r.score} width={56} />
                          <OppLevelBadge level={r.opportunityLevel} />
                        </span>
                      )}
                    </td>
                    <td><ConfidenceBadge confidence={r.confidence} /></td>
                    <td><LifecycleBadge state={r.lifecycle} /></td>
                    <td className="num mono">{r.trendScore !== null ? Math.round(r.trendScore) : EM_DASH}</td>
                    <td className="num mono">{satBand(r.saturationScore)}</td>
                    <td className="num mono">{r.noveltyScore !== null ? Math.round(r.noveltyScore) : EM_DASH}</td>
                    <td className="num mono">{r.emergingAngleCount ?? EM_DASH}</td>
                    <td className="num mono">{r.burstDensity !== null ? `${Math.round(r.burstDensity)}%` : EM_DASH}</td>
                    <td className="num mono">{r.memberCount}</td>
                    <td className="num mono">
                      {r.deltaScore !== null ? (
                        <span className={r.deltaScore > 0 ? "delta-up" : r.deltaScore < 0 ? "delta-down" : "muted"}>
                          {r.deltaScore > 0 ? "+" : ""}{Math.round(r.deltaScore * 10) / 10}
                        </span>
                      ) : EM_DASH}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button title={busyDecision === r.topicId ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busyDecision === r.topicId} onClick={() => applyDecision(r.topicId, "shortlisted")}>入选</button>
                        <button title={busyDecision === r.topicId ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busyDecision === r.topicId} onClick={() => applyDecision(r.topicId, "reviewing")}>观察</button>
                        <button title={busyDecision === r.topicId ? "正在处理,请稍候" : undefined} className="btn-sm bad" disabled={busyDecision === r.topicId} onClick={() => applyDecision(r.topicId, "dismissed")}>搁置</button>
                      </div>
                    </td>
                    <td className="mono small">{r.calculatedAt ? fmtDateTime(r.calculatedAt) : EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 证据面板紧跟表格:原先渲染在分页控件下方,和它所属的行在视觉上断开 */}
          {openId !== null && detailRes.initialLoading && (
            <div className="card" style={{ marginTop: 10 }}>
              <span className="spinner">证据加载中…</span>
            </div>
          )}
          {openId !== null && detailRes.error && !detailRes.data && (
            <LoadError message={detailRes.error} onRetry={detailRes.reload} />
          )}
          {openId !== null && detailRes.data && <OppDetail id={openId} detail={detailRes.data} />}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button title={page <= 1 ? "已是第一页" : undefined} className="btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="small muted mono">第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页 · 共 {data.total} 个话题</span>
            <button title={page >= Math.ceil(data.total / data.pageSize) ? "已是最后一页" : undefined} className="btn-sm" disabled={page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </>
      )}
    </div>
  );
}

interface DetailData {
  current: {
    score: number | null;
    confidence: string | null;
    opportunityLevel: string | null;
    unscorableReason: string | null;
    deltaScore: number | null;
    scoreVersion?: string | null;
    profileId?: string | null;
    profileVersion?: string | null;
    evidence: {
      reasonCodes?: string[];
      positiveReasons?: string[];
      limitingReasons?: string[];
      whyChanged?: { component: string; delta: number }[] | null;
      components?: Record<string, { raw: number | null; available: boolean; contribution: number | null }>;
      qualityMode?: string | null;
    } | Record<string, unknown>;
    calculatedAt: string;
  } | null;
  history: {
    id: number;
    score: number | null;
    calculatedAt: string;
    whyChanged?: string | null;
  }[];
  /** §61:来自本次 Run 的快照,不是前端按名义权重还原 */
  effectiveWeights?: Record<string, number> | null;
  decision: { status: string; note: string | null } | null;
}

const COMPONENT_LINKS: Record<string, { label: string; href: string }> = {
  trend: { label: "趋势贡献", href: "/topics" },
  burst: { label: "爆发信号", href: "/trends" },
  novelty: { label: "新颖度", href: "/topics" },
  whitespace: { label: "内容空间", href: "/topics" },
  pattern: { label: "共性信号", href: "/topics" },
  lifecycle: { label: "生命周期适配", href: "/topics" },
};

function OppDetail({ id, detail }: { id: number; detail: DetailData }) {
  if (!detail.current) {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <div className="stat-label" style={{ marginBottom: 6 }}>话题 #{id} 机会分析</div>
        <div className="small muted">数据不足 —— 该话题缺少核心证据(趋势/新颖度),先运行完整分析。</div>
      </div>
    );
  }
  const cur = detail.current;
  const ev = cur.evidence as {
    reasonCodes?: string[];
    positiveReasons?: string[];
    limitingReasons?: string[];
    whyChanged?: { component: string; delta: number }[] | null;
    components?: Record<string, { raw: number | null; available: boolean; contribution: number | null }>;
    qualityMode?: string | null;
  };
  const components = ev.components ?? {};
  const why = ev.whyChanged ?? [];
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        话题 #{id} 机会证据
        <span className="muted small" style={{ marginLeft: 8 }}>
          {cur.scoreVersion} · 模型 {cur.profileId ?? "balanced"} {cur.profileVersion ?? ""}
        </span>
        {cur.deltaScore !== null && (
          <span className={cur.deltaScore > 0 ? "delta-up" : "delta-down"} style={{ marginLeft: 8 }}>
            近期变化 {cur.deltaScore > 0 ? "+" : ""}{cur.deltaScore}
          </span>
        )}
      </div>
      <BreakdownMini components={components} effectiveWeights={detail.effectiveWeights ?? null} />
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 }} className="small">
        <div>
          <span className="muted">正向信号:</span>
          {(ev.positiveReasons ?? []).join(";") || EM_DASH}
        </div>
        <div>
          <span className="muted">限制因素:</span>
          {(ev.limitingReasons ?? []).join(";") || EM_DASH}
        </div>
        {cur.deltaScore !== null && why.length > 0 && (
          <div>
            <span className="muted">变化来源:</span>
            {why.map((w) => `${w.component} ${w.delta > 0 ? "+" : ""}${w.delta}`).join(" · ")}
          </div>
        )}
        {ev.qualityMode === "lexical_baseline" && (
          <div className="muted">话题质量模式:词法基线(升级语义向量后更可靠)</div>
        )}
      </div>
      {detail.history.length > 1 && (
        <div className="small mono muted" style={{ marginTop: 6 }}>
          历史机会指数:{detail.history.slice(0, 8).reverse().map((hh) => `${fmtDateTime(hh.calculatedAt)}=${hh.score !== null ? Math.round(hh.score) : "—"}`).join(" → ")}
        </div>
      )}
    </div>
  );
}

function BreakdownMini({ components, effectiveWeights }: { components: Record<string, { raw: number | null; available: boolean; contribution: number | null }>; effectiveWeights: Record<string, number> | null }) {
  const order = ["trend", "burst", "novelty", "whitespace", "pattern", "lifecycle"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "4px 14px" }}>
      {order.map((k) => {
        const c = components[k];
        if (!c) return null;
        return (
          <div key={k} className="small" title={c.available ? "点击话题页对应证据区可下钻" : "该信号缺失,权重已重归一"}>
            <span style={{ display: "inline-flex", justifyContent: "space-between", width: "100%" }}>
              <span>{COMPONENT_LINKS[k]?.label ?? k}{!c.available && <span className="muted">(缺失)</span>}</span>
              <span className="mono">
                {c.contribution !== null ? Math.round(c.contribution) : "—"}
                {effectiveWeights?.[k] !== undefined && (
                  <span className="muted"> · 有效 {Math.round(effectiveWeights[k] * 1000) / 10}%</span>
                )}
              </span>
            </span>
            <ScoreBar score={c.raw} width={80} />
          </div>
        );
      })}
    </div>
  );
}
