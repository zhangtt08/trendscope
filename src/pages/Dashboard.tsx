/**
 * 数据总览(Release 1.0 · WP2 §32/§33/§36)。
 *
 * 这一页只回答四个问题:我现在有什么数据、数据能不能用、分析跑到哪一步了、
 * 下一步该做什么。所有数字都来自 /api/analysis/status 这一处真相 ——
 * 页面不再自己拼 SQL 式的多次请求,避免出现"这里说已完成、那里说没数据"。
 */
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  fmtDateTime,
  EM_DASH,
  SOURCE_TYPE_LABELS,
  CONTENT_TYPE_LABELS,
  QUALITY_LABELS,
  batchDisplayName,
} from "../lib/format";
import { BatchStatusChip, PlatformTag } from "../components/badges";
import { LoadError, RefreshHint } from "../components/RequestState";
import { PendingHint } from "../components/PendingHint";
import { FirstRunGuide, DataSourceStatus } from "../components/Onboarding";
import { FullAnalysisPanel } from "../components/FullAnalysisPanel";
import { HotCapturePanel } from "../components/HotCapture";
import type { AnalysisStatus } from "../types/analysis";

interface Stats {
  totalContent: number;
  byPlatform: { platform: string; n: number }[];
  platformCoverage?: {
    platform: string;
    items: number;
    latestAt: string | null;
    clustered: number;
    missingTime: number;
    noMetric: number;
  }[];
  byQuality: { quality: string; n: number }[];
  byContentType: { contentType: string; n: number }[];
}

interface Health {
  pendingDuplicateCandidates: number;
  failedRawRows: number;
  latestBatches: {
    id: number;
    name: string;
    sourceType: string;
    status: string;
    startedAt: string;
    totalRecords: number;
    failedRecords: number;
    duplicateRecords: number;
  }[];
}

function Coverage({ scored, total, last }: { scored: number; total: number; last: string | null }) {
  if (total === 0) return <div className="stat-sub">还没有可分析对象</div>;
  if (scored === 0) return <div className="stat-sub">尚未运行 · 用下方「刷新全部分析」</div>;
  return (
    <div className="stat-sub">
      {scored}/{total} 已评分 · 最近 {last ? fmtDateTime(last) : EM_DASH}
    </div>
  );
}

export default function Dashboard() {
  const statusRes = useResource<AnalysisStatus>("/analysis/status");
  const statsRes = useResource<Stats>("/stats");
  const healthRes = useResource<Health>("/health");
  const status = statusRes.data;

  if (statusRes.error && !status) return <LoadError message={statusRes.error} onRetry={statusRes.reload} />;
  if (!status) {
    return (
      <div className="fade-in">
        <div className="card">
          <div className="small muted">正在读取数据总览…</div>
          <PendingHint
            show
            why="本机库较大时,首屏这几条聚合查询要把数据逐页读进来;服务启动后已在后台预热过一次,通常很快,第一次冷启动可能慢一些。"
            alt="可以先去「内容浏览器」按条件翻页,或用「一键抓热点」采集。"
          />
        </div>
      </div>
    );
  }

  const stats = statsRes.data;
  const health = healthRes.data;
  const qualityTotal = stats ? Math.max(1, stats.byQuality.reduce((a, b) => a + b.n, 0)) : 1;
  const completeShare = stats && stats.totalContent > 0
    ? Math.round(((stats.byQuality.find((q) => q.quality === "complete")?.n ?? 0) / qualityTotal) * 100)
    : null;
  const maxPlatform = stats ? Math.max(1, ...stats.byPlatform.map((p) => p.n)) : 1;
  const sem = status.semantic;

  return (
    <div className="fade-in">
      <div className="section-head">
        <div>
          <h2>数据总览</h2>
          <div className="section-hint">
            数据规模、质量、分析进度与 AI 服务状态集中在这里 · 统计于 {fmtDateTime(status.generatedAt)}
          </div>
        </div>
        <RefreshHint show={statusRes.refreshing} text="正在更新…" />
      </div>

      {status.data.demoShare !== null && status.data.demoShare > 0 && (
        <div className="banner warn">
          当前库中有 {status.data.demoShare}% 的内容来自演示 / 回放数据。它们用于验证流程,
          <b>不代表真实热门内容</b>;需要真实结论请先导入或采集真实数据。
        </div>
      )}

      <FirstRunGuide status={status} />
      <HotCapturePanel onDone={statusRes.reload} />
      <FullAnalysisPanel status={status} onChanged={statusRes.reload} />

      <div className="stat-grid">
        <div className="card">
          <div className="stat-label">内容总量</div>
          <div className="stat-value">{status.data.contentTotal.toLocaleString()}</div>
          <div className="stat-sub">
            {Object.entries(status.data.sourceKinds)
              .map(([k, v]) => `${SOURCE_TYPE_LABELS[k] ?? k} ${v}`)
              .join(" · ") || "暂无来源记录"}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">最近采集 / 入库</div>
          <div className="stat-value" style={{ fontSize: 17, lineHeight: 1.35 }}>
            {status.data.latestCollectedAt ? fmtDateTime(status.data.latestCollectedAt) : EM_DASH}
          </div>
          <div className="stat-sub">
            {status.data.latestRun ? (
              <>
                最近一次采集 {status.data.latestRun.status === "completed" ? "完成" : status.data.latestRun.status} ·{" "}
                <Link to="/collection" className="mono" style={{ color: "var(--steel)" }}>
                  采集中心 →
                </Link>
              </>
            ) : (
              "尚无采集运行 · 可到导入中心手动导入"
            )}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">数据质量</div>
          <div className="stat-value">{completeShare === null ? EM_DASH : `${completeShare}%`}</div>
          <div className="stat-sub">
            完整占比 · 缺发布时间 {status.data.quality.missingPublishedAt} · 缺全部指标{" "}
            {status.data.quality.missingAnyMetric} · 缺作者 {status.data.quality.missingAuthor}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">活跃话题</div>
          <div className="stat-value">{status.topics.active}</div>
          <div className="stat-sub">
            共 {status.topics.total} 个 · {status.topics.unclustered} 条内容未归类 ·{" "}
            <Link to="/topics" style={{ color: "var(--steel)" }}>
              话题
            </Link>
          </div>
        </div>
        <div className="card">
          <div className="stat-label">话题趋势</div>
          <div className="stat-value">{status.engines.topicTrend.scored}</div>
          <Coverage
            scored={status.engines.topicTrend.scored}
            total={status.engines.topicTrend.total}
            last={status.engines.topicTrend.lastCalculatedAt}
          />
        </div>
        <div className="card">
          <div className="stat-label">爆发共性与饱和度</div>
          <div className="stat-value">{status.engines.intelligence.scored}</div>
          <Coverage
            scored={status.engines.intelligence.scored}
            total={status.engines.intelligence.total}
            last={status.engines.intelligence.lastCalculatedAt}
          />
        </div>
        <div className="card">
          <div className="stat-label">选题机会指数</div>
          <div className="stat-value">{status.engines.opportunity.scored}</div>
          <Coverage
            scored={status.engines.opportunity.scored}
            total={status.engines.opportunity.total}
            last={status.engines.opportunity.lastCalculatedAt}
          />
        </div>
        <div className="card">
          <div className="stat-label">语义 / AI 服务</div>
          <div className="stat-value" style={{ fontSize: 17, lineHeight: 1.35 }}>
            {sem.mode === "none" ? "词法基线未运行" : sem.mode === "lexical" ? "本地词法基线" : "语义向量"}
          </div>
          <div className="stat-sub">
            AI 生成服务 {status.studio.configured ? "已配置" : "未配置"} ·{" "}
            <Link to="/studio" style={{ color: "var(--steel)" }}>
              选题工作室
            </Link>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <div className="section-title">当前分析配置</div>
            <div className="section-hint">
              内容爆发指数已评分 {status.engines.contentBurst.scored} / {status.engines.contentBurst.total} 条;
              向量 {sem.embedded} 条已建,
              {sem.pending} 条待处理;采集任务 {status.data.enabledTasks} 个已启用
              {status.data.runningRuns > 0 ? `,${status.data.runningRuns} 次正在运行` : ""}。
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-head" style={{ marginBottom: 6 }}>
          <div className="section-title sub">平台分布</div>
          <span className="section-hint">每个平台采到多少、最近什么时候采的、有多少已归入话题</span>
        </div>
          {statsRes.error && !stats ? (
            <LoadError message={statsRes.error} onRetry={statsRes.reload} />
          ) : !stats ? (
            <div className="small muted">正在读取…</div>
          ) : stats.byPlatform.length === 0 ? (
            <div className="small muted">
              暂无数据 —— 到 <Link to="/import">导入中心</Link> 导入 CSV / JSON,或到{" "}
              <Link to="/collection">采集中心</Link> 运行采集任务。
            </div>
          ) : (
            <div className="table-wrap" style={{ border: "none" }}>
              <table className="ts">
              <thead>
                <tr>
                  <th>平台</th>
                  <th style={{ width: "26%" }}>条数</th>
                  <th style={{ width: "18%" }}>最近采集</th>
                  <th className="num">已归类</th>
                  <th className="num">缺发布时间</th>
                  <th className="num">缺任一指标</th>
                </tr>
              </thead>
              <tbody>
                {stats.byPlatform.map((p) => {
                  const cov = stats.platformCoverage?.find((c) => c.platform === p.platform);
                  return (
                    <tr key={p.platform}>
                      <td>
                        <PlatformTag platform={p.platform} />
                      </td>
                      <td>
                        <div className="row">
                          <span className="mono" style={{ minWidth: 40 }}>{p.n.toLocaleString()}</span>
                          <span
                            aria-hidden="true"
                            style={{
                              display: "block",
                              height: 6,
                              width: `${Math.max(2, Math.round((p.n / maxPlatform) * 100))}%`,
                              background: "var(--amber)",
                              borderRadius: 2,
                            }}
                          />
                        </div>
                      </td>
                      <td className="num small" style={{ whiteSpace: "nowrap" }}>
                        {cov?.latestAt ? fmtDateTime(cov.latestAt) : EM_DASH}
                      </td>
                      <td className="num">{cov ? cov.clustered.toLocaleString() : EM_DASH}</td>
                      <td className="num">{cov ? cov.missingTime.toLocaleString() : EM_DASH}</td>
                      <td className="num">{cov ? cov.noMetric.toLocaleString() : EM_DASH}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="section-title sub">数据质量构成</div>
          {!stats ? (
            <div className="small muted">正在读取…</div>
          ) : stats.byQuality.length === 0 ? (
            <div className="small muted">还没有内容可评估质量。</div>
          ) : (
            stats.byQuality.map((q) => (
              <div className="dist-row" key={q.quality}>
                <div className="dist-name">{QUALITY_LABELS[q.quality] ?? q.quality}</div>
                <div className="dist-bar">
                  <div
                    className="dist-fill"
                    style={{
                      width: `${Math.max(2, (q.n / qualityTotal) * 100)}%`,
                      background:
                        q.quality === "complete"
                          ? "var(--ok)"
                          : q.quality === "partial"
                            ? "var(--warn)"
                            : q.quality === "invalid"
                              ? "var(--bad)"
                              : "#52606d",
                    }}
                  />
                </div>
                <div className="dist-n">{q.n.toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="section-title sub">内容类型构成</div>
          {!stats ? (
            <div className="small muted">正在读取…</div>
          ) : stats.byContentType.length === 0 ? (
            <div className="small muted">还没有内容可统计类型。</div>
          ) : (
            stats.byContentType.map((c) => (
              <div className="dist-row" key={c.contentType}>
                <div className="dist-name">{CONTENT_TYPE_LABELS[c.contentType] ?? c.contentType}</div>
                <div className="dist-bar">
                  <div
                    className="dist-fill"
                    style={{
                      width: `${Math.max(2, (c.n / Math.max(1, ...stats.byContentType.map((x) => x.n))) * 100)}%`,
                    }}
                  />
                </div>
                <div className="dist-n">{c.n.toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <DataSourceStatus status={status} />

      <div className="section-head">
        <div>
          <div className="section-title sub">最近导入批次</div>
          <div className="section-hint">
            待处理重复 {health?.pendingDuplicateCandidates ?? EM_DASH} 组 · 采集失败行{" "}
            {health?.failedRawRows ?? EM_DASH}
          </div>
        </div>
      </div>
      {healthRes.error && !health ? (
        <LoadError message={healthRes.error} onRetry={healthRes.reload} />
      ) : !health ? (
        <div className="card">
          <div className="small muted">正在读取批次…</div>
        </div>
      ) : health.latestBatches.length === 0 ? (
        <div className="card">
          <div className="small muted">
            还没有导入批次。到 <Link to="/import">导入中心</Link> 选择 CSV / JSON 文件,或载入内置示例数据。
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">名称</th>
                <th scope="col">来源</th>
                <th scope="col">开始时间</th>
                <th scope="col" className="num">总数</th>
                <th scope="col" className="num">重复</th>
                <th scope="col" className="num">失败</th>
                <th scope="col">状态</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {health.latestBatches.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.id}</td>
                  <td className="wrap" style={{ minWidth: 150, maxWidth: 260 }}>
                    {batchDisplayName(b.name)}
                  </td>
                  <td>
                    <span className="plat-tag">{SOURCE_TYPE_LABELS[b.sourceType] ?? b.sourceType}</span>
                  </td>
                  <td className="mono small">{fmtDateTime(b.startedAt)}</td>
                  <td className="num">{b.totalRecords}</td>
                  <td className="num" style={{ color: "var(--warn)" }}>
                    {b.duplicateRecords}
                  </td>
                  <td className="num" style={{ color: b.failedRecords > 0 ? "var(--bad)" : undefined }}>
                    {b.failedRecords}
                  </td>
                  <td>
                    <BatchStatusChip status={b.status} />
                  </td>
                  <td>
                    <Link to={`/import/${b.id}`} className="mono small" style={{ color: "var(--steel)" }}>
                      详情 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export { api };
