/**
 * 话题 (Stage 6B §38-48): Topic Explorer / Detail / Analysis / Governance.
 * 词法基线聚类明确标注(§51);人工治理(重命名/合并/拆分/移动/watch)齐全。
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, post, patch, del } from "../lib/api";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import { fmtDateTime, EM_DASH, PLATFORM_LABELS, CONTENT_TYPE_LABELS } from "../lib/format";
import { LifecycleBadge, ConfidenceBadge, ScoreBar } from "../components/ScoringBadges";
import { LifecycleExplain, TrendBreakdown } from "../components/TrendBreakdown";
import { PromptDialog, PickDialog, type PromptSpec } from "../components/Dialogs";
import { TopicIntelligenceSection } from "../components/TopicIntelligence";
import type { TopicTrendDetail } from "../types/scoring";

interface TopicRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  embeddingSpaceId: string;
  namingSource: string;
  memberCount: number;
  keywords: string[];
  hashtags: string[];
  representativeItemIds: number[];
  cohesion: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  watchState: string | null;
}

interface MemberRow {
  membershipId: number;
  contentItemId: number;
  title: string | null;
  platform: string;
  contentType: string;
  similarityScore: number | null;
  assignmentMethod: string;
  manualLock: number;
  publishedAt: string | null;
  likes: number | null;
  upvotes: number | null;
}

interface TopicDetail extends TopicRow {
  members: MemberRow[];
  snapshots: { capturedAt: string; memberCount: number; newContentCount: number; cohesion: number | null }[];
  evolution: { id: number; eventType: string; detail: string | null; createdAt: string }[];
  recentRuns: { id: number; qualityMode: string; similarityThreshold: number; clusteringAlgorithmVersion: string }[];
}

interface RunRow {
  id: number;
  status: string;
  contentsConsidered: number;
  clustersFound: number;
  topicsCreated: number;
  topicsUpdated: number;
  unclusteredCount: number;
  report: string | null;
  qualityMode: string;
  startedAt: string | null;
  completedAt: string | null;
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  active: { label: "活跃", cls: "chip b-completed" },
  needs_review: { label: "待复核", cls: "chip b-partial" },
  inactive: { label: "不活跃", cls: "chip b-processing" },
  archived: { label: "已归档", cls: "chip b-processing" },
};

function StatusChip({ status }: { status: string }) {
  const m = STATUS_LABEL[status];
  return m ? <span className={m.cls}>{m.label}</span> : <span className="mono small">{status}</span>;
}

function WatchChip({ state }: { state: string | null }) {
  if (!state) return <span className="small muted">—</span>;
  const map: Record<string, string> = { watching: "关注", review: "待看", ignored: "忽略" };
  const cls: Record<string, string> = { watching: "chip b-completed", review: "chip b-partial" };
  return <span className={cls[state] ?? "chip b-processing"}>{map[state] ?? state}</span>;
}

export default function TopicsExplorer() {
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [minMembers, setMinMembers] = useState("");
  const [platform, setPlatform] = useState("");
  // 话题详情由 URL 决定(可深链 /topics/:id、可前进后退、刷新不丢上下文)
  const params = useParams();
  const nav = useNavigate();
  const openId = params.id ? Number(params.id) : null;
  const [threshold, setThreshold] = useState("0.3");
  const [minClusterSize, setMinClusterSize] = useState("3");
  const [busy, setBusy] = useState(false);
  // 治理动作的输入用产品内对话框,不再依赖 window.prompt(原生弹窗不可样式化,也可能被宿主环境拦截)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [merge, setMerge] = useState<{ into: TopicRow; options: { value: string; label: string }[] } | null>(null);

  const debouncedSearch = useDebounced(search, 250);
  const debouncedMinMembers = useDebounced(minMembers, 250);

  const listRes = useResource<{ rows: TopicRow[] }>(
    `/topics${buildQuery({
      search: debouncedSearch,
      status: statusFilter,
      minMembers: debouncedMinMembers,
      platform,
    })}`,
  );
  const runsRes = useResource<{ rows: RunRow[] }>("/topic-analysis-runs");
  const detailRes = useResource<TopicDetail>(
    openId !== null && Number.isInteger(openId) && openId > 0 ? `/topics/${openId}` : null,
    { resetOnPathChange: true },
  );

  const rows = listRes.data?.rows ?? null;
  const runs = runsRes.data?.rows ?? [];
  const detail = openId === null ? null : detailRes.data;

  /** 治理写完之后要同时刷新列表与详情:成员数、状态、命名都会变。 */
  const reloadList = () => {
    listRes.reload();
    runsRes.reload();
  };

  // 保持原有行为:每 5 秒轮询一次列表与分析记录
  useEffect(() => {
    const t = setInterval(() => {
      listRes.reload();
      runsRes.reload();
    }, 5000);
    return () => clearInterval(t);
  }, [listRes.reload, runsRes.reload]);

  async function analyze() {
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      if (threshold) config.similarityThreshold = Number(threshold);
      if (minClusterSize) config.minClusterSize = Number(minClusterSize);
      const r = await post<{ runId: number; status: string; report?: { topicCount: number; averageCohesion: number; unclusteredRate: number } }>(
        "/topics/analyze",
        { config, wait: true },
      );
      if (r.report) {
        setNotice(
          `分析完成:话题 ${r.report.topicCount} 个 · 平均一致性 ${(r.report.averageCohesion * 100).toFixed(0)}% · 未归题率 ${(r.report.unclusteredRate * 100).toFixed(0)}%(词法基线聚类)`,
        );
      } else {
        setNotice(`分析任务 #${r.runId} 已创建`);
      }
      reloadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 治理类写操作统一走这里:失败必须可见,不能静默 reject。 */
  async function guard(label: string, fn:  () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(`${label}失败:${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return true;
  }

  async function setWatchState(id: number, state: string) {
    if (await guard("关注状态设置",  () => api(`/topics/${id}/watch`, { method: "PUT", body: JSON.stringify({ state }) }))) {
      reloadList();
      if (openId === id) detailRes.reload();
    }
  }

  async function rename(id: number, current: string) {
    setPrompt({
      title: "重命名话题",
      hint: "人工命名后,自动分析不会再覆盖这个名字。",
      initialValue: current,
      confirmLabel: "保存名称",
      onSubmit: async (name) => {
        if (!name || name === current) return;
        if (await guard("重命名", () => patch(`/topics/${id}`, { name }))) {
          setNotice("已重命名(namingSource=manual,自动分析不会覆盖)");
          reloadList();
          if (openId === id) detailRes.reload();
        }
      },
    });
  }

  async function mergeInto(a: TopicRow, bId: number) {
    if (!window.confirm(`把「${bId}」合并进「${a.name}」?成员将全部转移;被合并方保留为不活跃。`)) return;
    if (await guard("合并",  () => post("/topics/merge", { canonicalTopicId: a.id, mergedTopicId: bId }))) {
      setNotice("已合并(记录 manual_merge 事件)");
      reloadList();
      if (openId === a.id) detailRes.reload();
    }
  }

  async function removeFromTopic(itemId: number) {
    if (!openId) return;
    if (await guard("移出话题",  () => del(`/topics/${openId}/move-content`, { contentItemId: itemId }))) {
      detailRes.reload();
      reloadList();
    }
  }

  async function move(itemId: number, to: string) {
    if (!to) return;
    const target = openId;
    if (await guard("移动内容",  () => post(`/topics/${Number(to)}/move-content`, { contentItemId: itemId }))) {
      if (target) detailRes.reload();
      reloadList();
    }
  }

  const activeSpaceMode = runs[0]?.qualityMode === "semantic" ? "语义向量" : "词法基线聚类";

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>话题</h1>
        <span className="section-hint">话题聚类 · 相似图聚类 → 连通分量 → 可人工治理 · 当前模式:{activeSpaceMode}</span>
      </div>

      {listRes.error && <LoadError message={listRes.error} onRetry={listRes.reload} />}
      {err && <div className="banner err" role="alert">{err}</div>}
      {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}
      <RefreshHint show={listRes.refreshing} text="正在更新话题列表…" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="stat-label" style={{ marginBottom: 8 }}>运行话题分析</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small muted">相似度阈值</span>
          <input aria-label="相似度阈值" className="input" style={{ width: 80 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <span className="small muted">最小簇大小</span>
          <input aria-label="最小簇大小" className="input" style={{ width: 70 }} value={minClusterSize} onChange={(e) => setMinClusterSize(e.target.value)} />
          <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={busy} onClick={analyze}>
            {busy ? "分析中…" : "运行话题分析"}
          </button>
          <span className="small muted">词法基线默认 0.3(按真实相似度分布校准);高级参数可后续开放</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input aria-label="词法基线默认 0.3;高级参数可后续开放" className="input" style={{ width: 200 }} placeholder="搜索话题名/描述/关键词" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="词法基线默认 0.3;高级参数可后续开放" className="input" style={{ width: 120 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="active">活跃</option>
          <option value="needs_review">待复核</option>
          <option value="inactive">不活跃</option>
        </select>
        <select className="input" style={{ width: 130 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">全部平台</option>
          <option value="zhihu">知乎</option>
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
          <option value="weibo">微博</option>
        </select>
        <input aria-label="最少成员" className="input" style={{ width: 110 }} placeholder="最少成员" value={minMembers} onChange={(e) => setMinMembers(e.target.value)} />
      </div>

      {listRes.initialLoading ? (
        <div className="spinner">正在加载…</div>
      ) : rows === null ? (
        null
      ) : rows.length === 0 ? (
        <div className="banner">
          还没有话题 —— 话题分析需要先有内容向量。
          <Link to="/semantic">先到语义中心运行向量化</Link>;(未配置外部服务时会用本地词法基线,同样可以聚类)
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">话题名</th>
                <th scope="col">状态</th>
                <th scope="col" className="num">成员</th>
                <th scope="col">关键词</th>
                <th scope="col" className="num">一致性</th>
                <th scope="col">首次出现</th>
                <th scope="col">最后出现</th>
                <th scope="col">关注</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td>
                    <button
                      className="row-toggle"
                      aria-expanded={openId === t.id}
                      onClick={() => nav(openId === t.id ? "/topics" : `/topics/${t.id}`)}
                    >
                      {t.name}
                    </button>
                    {t.namingSource === "manual" && <span className="chip b-completed" style={{ marginLeft: 6 }}>手动命名</span>}
                    {t.description && <div className="small muted" style={{ maxWidth: 300 }}>{t.description}</div>}
                  </td>
                  <td><StatusChip status={t.status} /></td>
                  <td className="num mono">{t.memberCount}</td>
                  <td className="small muted" style={{ maxWidth: 200 }}>{t.keywords.slice(0, 4).join("、")}</td>
                  <td className="num mono">{t.cohesion !== null ? `${Math.round(t.cohesion * 100)}%` : EM_DASH}</td>
                  <td className="mono small">{t.firstObservedAt ? fmtDateTime(t.firstObservedAt) : EM_DASH}</td>
                  <td className="mono small">{t.lastObservedAt ? fmtDateTime(t.lastObservedAt) : EM_DASH}</td>
                  <td><WatchChip state={t.watchState} /></td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className={`btn-sm${t.watchState === "watching" ? " active" : ""}`} onClick={() => setWatchState(t.id, "watching")}>关注</button>
                      <button className={`btn-sm${t.watchState === "review" ? " active" : ""}`} onClick={() => setWatchState(t.id, "review")}>待看</button>
                      <button className={`btn-sm${t.watchState === "ignored" ? " active" : ""}`} onClick={() => setWatchState(t.id, "ignored")}>忽略</button>
                      {t.watchState && (
                        <button className="btn-sm" onClick={() => setWatchState(t.id, "none")} title="清除关注状态">
                          清除
                        </button>
                      )}
                      <button className="btn-sm" onClick={() => rename(t.id, t.name)}>重命名</button>
                      <button
                        className="btn-sm bad"
                        onClick={() => {
                          // 原先自动挑"第一个不相关的活跃话题"作为被合并方,只靠一个
                          // confirm 兜底,极易把错的话题并掉。改为显式选择目标。
                          const others = rows.filter((r) => r.id !== t.id && r.status === "active");
                          if (others.length === 0) {
                            setErr("没有另一个活跃话题可合并");
                            return;
                          }
                          setMerge({
                            into: t,
                            options: others.map((r) => ({ value: String(r.id), label: `#${r.id} ${r.name}(${r.memberCount} 成员)` })),
                          });
                        }}
                      >
                        合并入此
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="stat-label" style={{ marginBottom: 8 }}>
            话题 #{detail.id} · {detail.name} · 空间 <span className="mono">{detail.embeddingSpaceId.slice(0, 40)}…</span>
          </div>
          <div className="small muted" style={{ marginBottom: 10 }}>
            可解释性:成员因语义/词法相似被聚在一起 —— 代表内容与关键词即聚类证据;相似度与指派方式逐条可查。
          </div>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10 }} className="small">
            <div><span className="muted">状态:</span><StatusChip status={detail.status} /></div>
            <div><span className="muted">成员:</span>{detail.memberCount}</div>
            <div><span className="muted">一致性:</span>{detail.cohesion !== null ? `${Math.round(detail.cohesion * 100)}%` : EM_DASH}</div>
            <div><span className="muted">关键词:</span>{detail.keywords.join("、") || EM_DASH}</div>
            <div><span className="muted">话题标签:</span>{detail.hashtags.join(" ") || EM_DASH}</div>
          </div>

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>代表内容</div>
          <div className="small" style={{ marginBottom: 10 }}>
            {detail.representativeItemIds.map((rid) => {
              const m = detail.members.find((x) => x.contentItemId === rid);
              return (
                <div key={rid}>
                  <Link to={`/content/${rid}`} style={{ color: "var(--ink)" }}>{m?.title ?? `#${rid}`}</Link>
                </div>
              );
            })}
          </div>

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>全部成员({detail.members.length})</div>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>标题</th>
                  <th scope="col">平台</th>
                  <th scope="col" className="num">相似度</th>
                  <th scope="col">指派</th>
                  <th scope="col" className="num">动量</th>
                  <th scope="col">发布时间</th>
                  <th scope="col">移动到</th>
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => (
                  <tr key={m.membershipId}>
                    <td style={{ maxWidth: 300, overflowWrap: "anywhere" }}>
                      <Link to={`/content/${m.contentItemId}`} style={{ color: "var(--ink)" }}>{m.title ?? EM_DASH}</Link>
                      {m.manualLock === 1 && <span className="chip b-completed" style={{ marginLeft: 6 }}>已锁定</span>}
                    </td>
                    <td className="small">{PLATFORM_LABELS[m.platform] ?? m.platform}</td>
                    <td className="num mono">{m.similarityScore !== null ? `${(m.similarityScore * 100).toFixed(0)}%` : EM_DASH}</td>
                    <td className="small">{m.assignmentMethod}{m.manualLock === 1 ? " · 锁定" : ""}</td>
                    <td className="num mono">{m.upvotes ?? m.likes ?? EM_DASH}</td>
                    <td className="mono small">{m.publishedAt ? fmtDateTime(m.publishedAt) : EM_DASH}</td>
                    <td>
                      <select className="input" style={{ width: 140 }} value="" onChange={(e) => move(m.contentItemId, e.target.value)}>
                        <option value="">移动到…</option>
                        {(rows ?? []).filter((r) => r.id !== detail.id && r.status !== "inactive").map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      <button className="btn-sm bad" style={{ marginLeft: 4 }} onClick={() => removeFromTopic(m.contentItemId)}>移除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="stat-label" style={{ margin: "12px 0 6px" }}>快照历史（只追加，不覆盖）</div>
          <div className="small mono">
            {detail.snapshots.map((s) => (
              <div key={s.capturedAt + s.memberCount}>
                {fmtDateTime(s.capturedAt)} · 成员 {s.memberCount} · 新增 {s.newContentCount} · 一致性 {s.cohesion !== null ? `${Math.round(s.cohesion * 100)}%` : EM_DASH}
              </div>
            ))}
          </div>

          <div className="stat-label" style={{ margin: "12px 0 6px" }}>演化历史</div>
          <div className="small mono">
            {detail.evolution.slice(0, 10).map((e) => (
              <div key={e.id}>
                {fmtDateTime(e.createdAt)} · {e.eventType} {e.detail ? `· ${e.detail}` : ""}
              </div>
            ))}
          </div>

          <TopicTrendSection topicId={detail.id} />

          <TopicIntelligenceSection topicId={detail.id} />
        </div>
      )}

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>未归类内容</h2>
      </div>
      <UnclusteredView />

      {prompt && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
      {merge && (
        <PickDialog
          title={`把哪个话题合并进「${merge.into.name}」?`}
          hint="成员将全部转移到当前话题;被合并方保留为不活跃,不删除任何数据。"
          options={merge.options}
          confirmLabel="合并"
          onCancel={() => setMerge(null)}
          onPick={(v) => void mergeInto(merge.into, Number(v))}
        />
      )}
    </div>
  );
}

/** 话题趋势区(§BP):趋势指数/生命周期/置信度/分解/时间线/迁移历史/证据。 */
function TopicTrendSection({ topicId }: { topicId: number }) {
  const res = useResource<TopicTrendDetail>(`/topics/${topicId}/trend`, {
    resetOnPathChange: true,
  });
  const data = res.data;

  // 请求失败不等于"没有评分":旧实现一个 catch 把网络错误也写成"尚未运行趋势评分",
  // 那是把未知当结论(违反 null ≠ 0 同一条红线)。
  if (res.error && !data) return <LoadError message={res.error} onRetry={res.reload} />;
  if (!data) return null;

  if (!data.current) {
    return (
      <div>
        <div className="stat-label" style={{ margin: "12px 0 6px" }}>话题趋势</div>
        <div className="small muted">尚未运行趋势评分 —— 到「趋势中心 → 话题趋势」点击「运行评分」。</div>
      </div>
    );
  }
  const detail = data.detail ?? null;

  return (
    <div>
      <div className="stat-label" style={{ margin: "12px 0 6px" }}>
        话题趋势(基于已观察数据,非爆款预测)
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }} className="small">
        <div><span className="muted">趋势指数:</span><ScoreBar score={detail ? detail.overallScore : null} width={100} /></div>
        <div><span className="muted">生命周期:</span><LifecycleBadge state={detail?.lifecycle ?? null} /></div>
        <div><span className="muted">置信度:</span><ConfidenceBadge confidence={detail?.confidence ?? null} /></div>
      </div>

      {detail && !detail.scorable && (
        <div className="small muted">
          数据不足:{detail.unscorableReason ?? EM_DASH} —— 不显示 0 分。
        </div>
      )}

      {/* 分解、有效权重、关键证据一律来自服务端 detail;话题页不再自带一份权重表 */}
      {detail?.scorable && <TrendBreakdown detail={detail} />}
      {detail?.scorable && <LifecycleExplain detail={detail} events={data.lifecycleEvents} />}
      {!detail && (
        <div className="small muted">
          这一版评分没有记录组件分解 —— 到趋势中心重跑评分即可看到分解与有效权重;此处不做反推。
        </div>
      )}

      {data.history.length > 1 && (
        <div>
          <div className="stat-label" style={{ margin: "10px 0 6px" }}>趋势时间线(最近 {Math.min(data.history.length, 10)} 次)</div>
          <div className="small mono muted">
            {data.history
              .slice(0, 10)
              .reverse()
              .map((hh) => `${fmtDateTime(hh.calculatedAt)}=${hh.score !== null && hh.score !== undefined ? Math.round(hh.score) : "—"}`)
              .join(" → ")}
          </div>
        </div>
      )}

      {data.lifecycleEvents.length > 0 && (
        <div>
          <div className="stat-label" style={{ margin: "10px 0 6px" }}>生命周期迁移历史(只追加,不覆盖)</div>
          <div className="small mono">
            {data.lifecycleEvents.slice(0, 10).map((e) => (
              <div key={e.id}>
                {fmtDateTime(e.occurredAt)} · {e.fromState ?? "首次"} → {e.toState} · {e.reason}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UnclusteredView() {
  type UnclusteredRow = { id: number; title: string | null; platform: string; contentType: string };
  // 失败不再被吞成空数组("没有未归类内容"是个假结论)
  const res = useResource<{ rows: UnclusteredRow[] }>("/topics/unclustered?limit=30");
  const rows = res.data?.rows ?? null;
  if (res.initialLoading) return <div className="spinner">正在加载…</div>;
  if (res.error && !rows) return <LoadError message={res.error} onRetry={res.reload} />;
  if (!rows) return null;
  if (rows.length === 0) return <div className="banner">所有已向量化内容均已归题。</div>;
  return (
    <div className="table-wrap">
      <table className="ts">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th style={{ minWidth: 260 }}>标题</th>
            <th scope="col">平台</th>
            <th scope="col">类型</th>
            <th scope="col">详情</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                <Link to={`/content/${r.id}`} style={{ color: "var(--ink)" }}>{r.title ?? EM_DASH}</Link>
              </td>
              <td className="small">{PLATFORM_LABELS[r.platform] ?? r.platform}</td>
              <td className="small">{CONTENT_TYPE_LABELS[r.contentType] ?? r.contentType}</td>
              <td><Link to={`/content/${r.id}`} className="mono small" style={{ color: "var(--steel)" }}>详情 →</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
