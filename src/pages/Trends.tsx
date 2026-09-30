/**
 * 趋势中心 (Stage 7 §BM):两个视图 —— 话题趋势(默认)/ 内容爆发。
 * 话题趋势表(§BN):话题/生命周期/趋势指数/置信度/成员数/近期新增/活跃创作者/
 * 爆发内容占比/原始互动动量/更新时间;行展开 = 趋势分解 + 证据(§AZ evidence first)。
 * 内容爆发视图:爆发指数榜(§CS 分页) + 既有 Raw Momentum 动量榜(保留,D2)。
 * 全部中文;无假精确(§BV);数据不足显式标注;请求失败横幅 + 重试(§DB)。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import { fmtDateTime, EM_DASH, PLATFORM_LABELS } from "../lib/format";
import MomentumTable from "../components/MomentumTable";
import { LifecycleBadge, ConfidenceBadge, ScoreBar } from "../components/ScoringBadges";
import { LifecycleExplain, TrendBreakdown, formatNum as num } from "../components/TrendBreakdown";
import type { MomentumResult, TrendOverview } from "../types/trend";
import type {
  ContentScoreRow,
  LifecycleEvent,
  Paged,
  TopicTrendListRow,
  TrendDetailPayload,
} from "../types/scoring";

const WINDOWS = [1, 7, 14, 30];

function BucketBars({ buckets }: { buckets: TrendOverview["buckets"] }) {
  if (buckets.length === 0)
    return (
      <div className="small muted">
        窗口内暂无快照活动 —— 趋势来自多次采集的指标快照;单次采集算不出趋势,这不是数据坏了。
      </div>
    );
  const max = Math.max(...buckets.map((b) => b.snapshots));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, paddingTop: 8 }}>
      {buckets.map((b) => (
        <div key={b.date} style={{ flex: 1, textAlign: "center" }} title={`${b.date} · ${b.snapshots} 快照 · ${b.distinctItems} 条内容`}>
          <div
            style={{
              height: `${Math.max(4, (b.snapshots / max) * 100)}%`,
              background: "var(--amber)",
              opacity: 0.85,
              minHeight: 4,
              borderRadius: 1,
            }}
          />
          <div className="mono" style={{ fontSize: 9, color: "var(--ink-sub)", marginTop: 4 }}>
            {b.date.slice(5)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================= 话题趋势(默认视图,§BM/§BN) ================= */

function TopicTrendPanel() {
  const [opErr, setOpErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState("");
  const [confidence, setConfidence] = useState("");
  const [saturation, setSaturation] = useState("");
  const [sortBy, setSortBy] = useState("score");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);

  const listPath = `/trends/topics${buildQuery({
    page,
    pageSize: 20,
    sortBy,
    order: "desc",
    lifecycle,
    confidence,
    saturation,
  })}`;
  const res = useResource<Paged<TopicTrendListRow>>(listPath);
  const data = res.data;

  async function runScoring() {
    setOpErr(null);
    setNotice(null);
    setRunning(true);
    try {
      // 顺序硬约束:内容爆发先于话题趋势(Layer 2 → Layer 3)
      const c = await post<{ scorableCount: number; contentCount: number; durationMs: number }>("/scoring/content/run", { wait: true });
      const t = await post<{ scorableCount: number; topicCount: number; durationMs: number }>("/scoring/trend/run", { wait: true, includeContent: false });
      setNotice(
        `评分完成:内容爆发 ${c.scorableCount}/${c.contentCount} 条可评(${c.durationMs}ms)· 话题趋势 ${t.scorableCount}/${t.topicCount} 个可评(${t.durationMs}ms)`,
      );
      res.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <button title={running ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={running} onClick={runScoring}>
          {running ? "评分中…" : "运行评分(内容 → 话题)"}
        </button>
        <button title={res.loading ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={res.loading} onClick={res.reload}>刷新</button>
        <span className="small muted">生命周期</span>
        <select aria-label="生命周期" className="input" style={{ width: 110 }} value={lifecycle} onChange={(e) => { setPage(1); setLifecycle(e.target.value); }}>
          <option value="">全部</option>
          <option value="emerging">新兴</option>
          <option value="rising">上升</option>
          <option value="peak">高位</option>
          <option value="saturated">饱和</option>
          <option value="declining">下降</option>
          <option value="evergreen">常青</option>
          <option value="unknown">数据不足</option>
        </select>
        <span className="small muted">置信度</span>
        <select aria-label="置信度" className="input" style={{ width: 90 }} value={confidence} onChange={(e) => { setPage(1); setConfidence(e.target.value); }}>
          <option value="">全部</option>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
        <span className="small muted">饱和度</span>
        <select aria-label="饱和度" className="input" style={{ width: 90 }} value={saturation} onChange={(e) => { setPage(1); setSaturation(e.target.value); }}>
          <option value="">全部</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
        <span className="small muted">排序</span>
        <select aria-label="排序" className="input" style={{ width: 130 }} value={sortBy} onChange={(e) => { setPage(1); setSortBy(e.target.value); }}>
          <option value="score">趋势指数</option>
          <option value="memberCount">成员数</option>
          <option value="recentNew">近期新增</option>
          <option value="updatedAt">更新时间</option>
          <option value="saturation">饱和度</option>
          <option value="novelty">新颖度</option>
          <option value="opportunity">机会指数</option>
        </select>
      </div>

      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {opErr && <div className="banner err" role="alert">{opErr}</div>}
      {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}
      <RefreshHint show={res.refreshing} />

      {res.initialLoading ? (
        <div className="spinner">正在加载…</div>
      ) : !data ? (
        null
      ) : data.rows.length === 0 ? (
        <div className="banner">
          暂无话题趋势数据 —— 点本页「运行评分」按序计算;需要先有话题(
          <Link to="/topics">到话题页面运行话题分析</Link>
          ),并且每条内容至少 1 次指标快照。
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th style={{ minWidth: 180 }}>话题</th>
                  <th scope="col">生命周期</th>
                  <th scope="col">趋势指数</th>
                  <th scope="col">置信度</th>
                  <th scope="col" className="num">成员</th>
                  <th scope="col" className="num">近期新增</th>
                  <th scope="col" className="num">活跃创作者</th>
                  <th scope="col" className="num">爆发占比</th>
                  <th scope="col" className="num">原始互动动量</th>
                  <th scope="col">饱和度</th>
                  <th scope="col">新颖度</th>
                  <th scope="col">机会指数</th>
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
                    </td>
                    <td><LifecycleBadge state={r.lifecycle} /></td>
                    <td><ScoreBar score={r.score} /></td>
                    <td><ConfidenceBadge confidence={r.confidence} /></td>
                    <td className="num mono">{r.memberCount}</td>
                    <td className="num mono">{r.recentNewContent ?? EM_DASH}</td>
                    <td className="num mono">{r.activeCreators ?? EM_DASH}</td>
                    <td className="num mono">{r.burstDensity !== null ? `${Math.round(r.burstDensity)}%` : EM_DASH}</td>
                    <td className="num mono">{r.avgRawMomentum !== null ? Math.round(r.avgRawMomentum).toLocaleString() : EM_DASH}</td>
                    <td>
                      {r.saturationScore === null || r.saturationScore === undefined ? (
                        <span className="small muted">数据不足</span>
                      ) : (
                        <span className="small mono">{Math.round(r.saturationScore)} <span className="muted">{r.saturationScore < 34 ? "低" : r.saturationScore < 67 ? "中" : "高"}</span></span>
                      )}
                    </td>
                    <td>
                      {r.noveltyScore === null || r.noveltyScore === undefined ? (
                        <span className="small muted">数据不足</span>
                      ) : (
                        <span className="small mono">{Math.round(r.noveltyScore)}{r.emergingAngleCount ? <span className="chip b-completed" style={{ marginLeft: 4 }}>新兴 {r.emergingAngleCount}</span> : null}</span>
                      )}
                    </td>
                    <td>
                      {r.opportunityScore === null || r.opportunityScore === undefined ? (
                        <span className="small muted">数据不足</span>
                      ) : (
                        <span className="small mono">{Math.round(r.opportunityScore)} <span className="muted">{r.opportunityLevel === "high" ? "较高" : r.opportunityLevel === "medium" ? "中等" : "较低"}</span></span>
                      )}
                    </td>
                    <td className="mono small">{r.calculatedAt ? fmtDateTime(r.calculatedAt) : EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button title={page <= 1 ? "已是第一页" : undefined} className="btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="small muted mono">第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页 · 共 {data.total} 个话题</span>
            <button title={page >= Math.ceil(data.total / data.pageSize) ? "已是最后一页" : undefined} className="btn-sm" disabled={page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
          {openId !== null && <TopicTrendEvidence topicId={openId} />}
        </>
      )}
    </div>
  );
}

/** 行展开:趋势分解 + 证据。分解全部读服务端 detail,前端不参与计算。 */
interface TrendDetailResponse {
  detail?: TrendDetailPayload;
  current: Record<string, unknown> | null;
  lifecycleEvents?: LifecycleEvent[];
}

function TopicTrendEvidence({ topicId }: { topicId: number }) {
  const res = useResource<TrendDetailResponse>(`/topics/${topicId}/trend`, {
    resetOnPathChange: true,
  });
  if (res.initialLoading) {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <span className="spinner">趋势证据加载中…</span>
      </div>
    );
  }
  if (res.error) return <LoadError message={res.error} onRetry={res.reload} />;
  const detail = res.data?.detail ?? null;
  if (!detail) {
    return <div className="banner" style={{ marginTop: 10 }}>该话题尚未评分或数据不足。</div>;
  }
  const ev = (detail.evidence ?? {}) as {
    saturationProxy?: { note: string; creatorConcentration: number | null };
  };
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        话题 #{topicId} 趋势证据
        <span className="muted small" style={{ marginLeft: 8 }}>
          {detail.scoreVersion} · {detail.calculatedAt ? fmtDateTime(detail.calculatedAt) : EM_DASH}
        </span>
      </div>
      {detail.scorable ? (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <ScoreBar score={detail.overallScore} />
            <ConfidenceBadge confidence={detail.confidence} />
            <LifecycleBadge state={detail.lifecycle} />
          </div>
          <TrendBreakdown detail={detail} />
          {ev.saturationProxy && (
            <div className="small muted" style={{ marginTop: 8 }}>
              初步饱和判断:{ev.saturationProxy.note};创作者集中度 {num(ev.saturationProxy.creatorConcentration)}
            </div>
          )}
          <LifecycleExplain detail={detail} events={res.data?.lifecycleEvents} />
        </>
      ) : (
        <div className="small muted">
          数据不足:{detail.unscorableReason ?? "快照或成员不足以计算趋势"} —— 不显示 0 分。
        </div>
      )}
    </div>
  );
}

/* ================= 内容爆发视图(既有动量能力 + 爆发榜) ================= */

function ContentBurstPanel() {
  const [windowDays, setWindowDays] = useState(7);
  const [platform, setPlatform] = useState("");
  const [opErr, setOpErr] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 两个独立请求各自持有 abort/代次守卫:切窗口时旧的 overview 与旧的 momentum
  // 都不可能覆盖新结果(此前它们共用一个 Promise.all,任一慢回来都会串台)
  const overviewRes = useResource<TrendOverview>(
    `/trends/overview${buildQuery({ windowDays, platform })}`,
  );
  const momentumRes = useResource<MomentumResult>(
    `/trends/momentum${buildQuery({ windowDays, platform, pageSize: 50 })}`,
  );
  const overview = overviewRes.data;
  const momentum = momentumRes.data;
  const loading = overviewRes.loading || momentumRes.loading;
  const err = overviewRes.error ?? momentumRes.error;

  async function runContentScoring() {
    setOpErr(null);
    setNotice(null);
    setScoring(true);
    try {
      const r = await post<{ scorableCount: number; contentCount: number; durationMs: number }>("/scoring/content/run", { wait: true });
      setNotice(`内容评分完成:${r.scorableCount}/${r.contentCount} 条可评(${r.durationMs}ms)`);
      overviewRes.reload();
      momentumRes.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScoring(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn-sm ok" disabled={scoring} onClick={runContentScoring}>
          {scoring ? "评分中…" : "运行内容评分"}
        </button>
        {notice && <span className="small" style={{ color: "var(--ok)" }} role="status" aria-live="polite">{notice}</span>}
      </div>
      <BurstTable platform={platform} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "18px 0 12px", flexWrap: "wrap" }}>
        <span className="small muted">动量窗口</span>
        {WINDOWS.map((w) => (
          <button key={w} className={`btn-sm${windowDays === w ? " active" : ""}`} onClick={() => setWindowDays(w)}>
            {w}天
          </button>
        ))}
        <span className="small muted" style={{ marginLeft: 12 }}>平台</span>
        <select aria-label="平台" className="input" style={{ width: 140 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">全部</option>
          {Object.entries(PLATFORM_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        {loading && <span className="spinner" style={{ marginLeft: 8 }}>…</span>}
      </div>
      {err && (
        <LoadError
          message={err}
          onRetry={() => {
            overviewRes.reload();
            momentumRes.reload();
          }}
        />
      )}
      {opErr && <div className="banner err" role="alert">{opErr}</div>}
      {overview && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
            <div className="card" style={{ padding: "10px 14px" }}>
              <div className="stat-label">窗口快照数</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{overview.totalSnapshots.toLocaleString()}</div>
            </div>
            <div className="card" style={{ padding: "10px 14px" }}>
              <div className="stat-label">活跃内容</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{overview.activeItems.toLocaleString()}</div>
            </div>
            <div className="card" style={{ padding: "10px 14px" }}>
              <div className="stat-label">可算动量条目</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
                {momentum ? momentum.total.toLocaleString() : "—"}
              </div>
            </div>
            <div className="card" style={{ padding: "10px 14px" }}>
              <div className="stat-label">基线回看条目</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
                {momentum ? momentum.baselineUsedCount.toLocaleString() : "—"}
              </div>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="stat-label" style={{ marginBottom: 2 }}>
              每日快照活动(UTC 日粒度 · 窗口 {overview.windowDays} 天)
            </div>
            <BucketBars buckets={overview.buckets} />
          </div>
          {overview.platformMix.length > 0 && (
            <div className="card small" style={{ marginBottom: 16 }}>
              <div className="stat-label" style={{ marginBottom: 6 }}>窗口内平台分布</div>
              {overview.platformMix.map((p) => (
                <span key={p.platform} className="plat-tag" style={{ marginRight: 8 }}>
                  {PLATFORM_LABELS[p.platform] ?? p.platform} · {p.items} 条 / {p.snapshots} 快照
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>动量榜 Top {momentum?.rows.length ?? 0}</h2>
        <span className="section-hint">
          原始互动动量 = Δ点赞 + 2×Δ评论 + 2×Δ收藏 + 3×Δ分享(原始互动增量,非潜力评分)· <Link to="/workbench">进入内容候选工作台 →</Link>
        </span>
      </div>
      {momentum && <MomentumTable rows={momentum.rows} />}
    </div>
  );
}

/** 内容爆发指数榜(§CT 筛选 + §CS 分页;SQL 排序)。 */
function BurstTable({ platform }: { platform: string }) {
  const [minScore, setMinScore] = useState("");
  const [conf, setConf] = useState("");
  const [page, setPage] = useState(1);

  const debouncedMin = useDebounced(minScore, 250);
  const res = useResource<Paged<ContentScoreRow>>(
    `/trends/contents${buildQuery({
      page,
      pageSize: 15,
      sortBy: "score",
      order: "desc",
      platform,
      minScore: debouncedMin,
      confidence: conf,
    })}`,
  );
  const data = res.data;

  return (
    <div>
      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>内容爆发指数榜</h2>
        <span className="section-hint">相对同组内容的异常表现量化(0-100);不是未来爆款概率 · 点击标题看分解证据</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="small muted">平台</span>
        <select aria-label="平台" className="input" style={{ width: 120 }} value={platform} disabled>
          <option value="">{platform || "全部(随上方筛选)"}</option>
        </select>
        <span className="small muted">最低分</span>
        <input aria-label="最低分" className="input" style={{ width: 80 }} placeholder="如 80" value={minScore} onChange={(e) => { setPage(1); setMinScore(e.target.value); }} />
        <span className="small muted">置信度</span>
        <select aria-label="置信度" className="input" style={{ width: 90 }} value={conf} onChange={(e) => { setPage(1); setConf(e.target.value); }}>
          <option value="">全部</option>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
        <button title={res.loading ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={res.loading} onClick={res.reload}>刷新</button>
        <RefreshHint show={res.refreshing} />
      </div>
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {res.initialLoading ? (
        <div className="spinner">正在加载…</div>
      ) : !data ? (
        null
      ) : data.rows.length === 0 ? (
        <div className="banner">暂无评分数据 —— 先「运行内容评分」;需要每条内容至少 1 次指标快照。</div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>内容</th>
                  <th scope="col">平台</th>
                  <th scope="col">爆发指数</th>
                  <th scope="col">置信度</th>
                  <th scope="col">发布时间</th>
                  <th scope="col">评分时间</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.contentItemId}>
                    <td style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                      <Link to={`/content/${r.contentItemId}`} style={{ color: "var(--ink)" }}>{r.title ?? EM_DASH}</Link>
                      {r.scorable === 0 && (
                        <span className="chip b-processing" style={{ marginLeft: 6 }} title={r.unscorableReason ?? ""}>
                          数据不足
                        </span>
                      )}
                    </td>
                    <td className="small">{PLATFORM_LABELS[r.platform] ?? r.platform}</td>
                    <td>{r.scorable === 0 ? <span className="small muted">数据不足</span> : <ScoreBar score={r.score} />}</td>
                    <td><ConfidenceBadge confidence={r.confidence} /></td>
                    <td className="mono small">{r.publishedAt ? fmtDateTime(r.publishedAt) : EM_DASH}</td>
                    <td className="mono small">{r.calculatedAt ? fmtDateTime(r.calculatedAt) : EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button title={page <= 1 ? "已是第一页" : undefined} className="btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="small muted mono">第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页 · 共 {data.total} 条</span>
            <button title={page >= Math.ceil(data.total / data.pageSize) ? "已是最后一页" : undefined} className="btn-sm" disabled={page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ================= 页面壳 ================= */

export default function Trends() {
  const [tab, setTab] = useState<"topics" | "content">("topics");
  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>趋势中心</h1>
        <span className="section-hint">
          内容爆发指数 = 相对同组的异常表现量化;话题趋势指数 = 内容/互动/创作者增长 + 爆发密度 + 加速度。
          基于已观察数据,不是未来爆款预测。
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className={`btn-sm${tab === "topics" ? " active" : ""}`} onClick={() => setTab("topics")}>话题趋势</button>
        <button className={`btn-sm${tab === "content" ? " active" : ""}`} onClick={() => setTab("content")}>内容爆发</button>
      </div>
      {tab === "topics" ? <TopicTrendPanel /> : <ContentBurstPanel />}
    </div>
  );
}
