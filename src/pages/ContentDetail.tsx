import { useEffect, useState } from "react";
import { BurstScoreCard } from "../components/BurstScoreCard";
import { ContentFeatureCard } from "../components/ContentFeatureCard";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import {
  fmtMetric,
  fmtDateTime,
  CONTENT_TYPE_LABELS,
  batchDisplayName,
  DUP_REASON_LABELS,
  DUP_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
  parseHashtagsJson,
} from "../lib/format";
import { QualityBadge, PlatformTag, Null } from "../components/badges";
import type { SimilarContentResult, EmbeddingStatus } from "../types/semantic";
import LineChart from "../components/LineChart";
import type { ChartSeries } from "../components/LineChart";

interface Detail {
  item: {
    id: number;
    platform: string;
    platformContentId: string | null;
    contentType: string;
    url: string | null;
    canonicalUrl: string | null;
    authorId: string | null;
    authorName: string | null;
    title: string | null;
    text: string | null;
    transcript: string | null;
    hashtags: string | null;
    publishedAt: string | null;
    rawPublishedAt: string | null;
    publishedTz: string | null;
    publishedTzAssumption: string | null;
    collectedAt: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    favorites: number | null;
    upvotes: number | null;
    authorFollowers: number | null;
    dataQuality: string;
    qualityReasons: string | null;
    mergedIntoContentItemId: number | null;
    sourceType: string;
    fingerprint: string | null;
    createdAt: string;
    updatedAt: string;
  };
  snapshots: {
    id: number;
    capturedAt: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    favorites: number | null;
    upvotes: number | null;
    source: string;
    importBatchId: number | null;
  }[];
  raw: {
    id: number;
    sourceType: string;
    platform: string | null;
    adapter: string;
    importBatchId: number | null;
    payload: string;
    fieldNames: string | null;
    note: string | null;
    createdAt: string;
  } | null;
  batch: { id: number; name: string; sourceType: string; startedAt: string } | null;
  mergedInto: { id: number; title: string | null } | null;
  mergedSources: {
    item: { id: number; title: string | null; platformContentId: string | null };
    raw: { id: number; payload: string } | null;
  }[];
  mergeRecords: {
    id: number;
    sourceContentId: number;
    targetContentId: number;
    reason: string;
    resolvedAt: string;
  }[];
  candidates: { id: number; status: string; contentItemA: number; contentItemB: number }[];
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>
        <Null>{children}</Null>
      </dd>
    </div>
  );
}

function MetricCells({ s }: { s: Detail["snapshots"][number] }) {
  return (
    <>
      <td className="num">{fmtMetric(s.views)}</td>
      <td className="num">{fmtMetric(s.likes)}</td>
      <td className="num">{fmtMetric(s.comments)}</td>
      <td className="num">{fmtMetric(s.shares)}</td>
      <td className="num">{fmtMetric(s.favorites)}</td>
      <td className="num">{fmtMetric(s.upvotes)}</td>
    </>
  );
}

export default function ContentDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [similar, setSimilar] = useState<SimilarContentResult | null>(null);
  const [embStatus, setEmbStatus] = useState<EmbeddingStatus | null>(null);
  // 附属面板(相似内容 / 向量状态)取不到时必须说出来:
  // 静默留白会被读成"这条内容没有相似项",那是把失败当成了结论。
  const [auxError, setAuxError] = useState<string | null>(null);
  const [auxNonce, setAuxNonce] = useState(0);

  useEffect(() => {
    setSimilar(null);
    setEmbStatus(null);
    setAuxError(null);
    const idNum = Number(id);
    if (!Number.isFinite(idNum)) return;
    let cancelled = false;
    // 两个附属请求任一失败都要说出来,不能 .catch 掉当无事发生
    Promise.allSettled([
      api<SimilarContentResult>(`/content/${idNum}/similar?topK=8`),
      api<EmbeddingStatus>(`/content/${idNum}/embedding-status`),
    ]).then(([s, e]) => {
      if (cancelled) return;
      if (s.status === "fulfilled") setSimilar(s.value);
      if (e.status === "fulfilled") setEmbStatus(e.value);
      const firstError = [s, e].find((x) => x.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      if (firstError) {
        setAuxError(firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, auxNonce]);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setErr(null);
    api<Detail>(`/content/${id}`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [id]);

  if (err)
    return (
      <div>
        <Link to="/explorer" className="backlink">
          <ArrowLeft size={14} /> 返回内容浏览器
        </Link>
        <div className="banner err" role="alert">{err}</div>
      </div>
    );
  if (!data) return <div className="spinner">正在加载…</div>;

  const { item, snapshots, raw, batch, mergedInto, mergedSources, mergeRecords, candidates } = data;
  let prettyRaw = "—";
  if (raw?.payload) {
    try {
      prettyRaw = JSON.stringify(JSON.parse(raw.payload), null, 2);
    } catch {
      prettyRaw = raw.payload;
    }
  }

  const trendSeries: ChartSeries[] = (
    [
      ["likes", "点赞", "var(--amber)"],
      ["comments", "评论", "var(--steel)"],
      ["shares", "分享", "var(--bad)"],
      ["favorites", "收藏", "var(--ok)"],
      ["views", "播放/阅读", "var(--ink-faint)"],
    ] as const
  )
    .map(([key, label, color]) => ({
      key,
      label,
      color,
      points: snapshots.map((s) => ({ t: Date.parse(s.capturedAt), v: s[key] })),
    }))
    .filter((s) => s.points.some((p) => p.v !== null));

  return (
    <div className="fade-in">
      <Link to="/explorer" className="backlink">
        <ArrowLeft size={14} /> 返回内容浏览器
      </Link>

      {item.mergedIntoContentItemId && mergedInto && (
        <div className="banner warn">
          本条已被合并进{" "}
          <Link to={`/content/${mergedInto.id}`} style={{ color: "var(--steel)" }}>
            #{mergedInto.id} {mergedInto.title ?? ""}
          </Link>
          （原始记录与快照历史均保留；快照已迁移至目标条目）
        </div>
      )}

      <div className="section-head">
        <span className="section-no">#{item.id} /</span>
        <h1 className="section-title" style={{ fontSize: 18, maxWidth: 760, overflowWrap: "anywhere" }}>
          {item.title ?? <span className="null-mark">—</span>}
        </h1>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {(parseHashtagsJson(item.qualityReasons) as unknown as string[]).map((r) => (
            <span key={r} className="chip q-partial" title="数据质量原因（确定性规则计算）">
              {r}
            </span>
          ))}
          <QualityBadge q={item.dataQuality} />
        </span>
      </div>

      <BurstScoreCard contentItemId={item.id} />
      <ContentFeatureCard contentItemId={item.id} />

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>
          标准化数据
        </h2>
        <span className="section-hint">
          空白 = 未知 · 0 = 真实值 · 可在此核对标准化有没有搞错
        </span>
      </div>
      <div className="card">
        <dl className="kv-grid" style={{ margin: 0 }}>
          <KV label="平台">
            <PlatformTag platform={item.platform} />
          </KV>
          <KV label="内容 ID">
            <span className="mono">{item.platformContentId ?? "—"}</span>
          </KV>
          <KV label="内容类型">{CONTENT_TYPE_LABELS[item.contentType] ?? item.contentType}</KV>
          <KV label="作者">
            {item.authorName ?? "—"}
            {item.authorId ? <span className="mono small muted"> ({item.authorId})</span> : null}
          </KV>
          <div className="kv" style={{ gridColumn: "1 / -1" }}>
            <dt>链接</dt>
            <dd className="mono small">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" style={{ color: "var(--steel)" }}>
                  {item.url}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="kv" style={{ gridColumn: "1 / -1" }}>
            <dt>规范链接（已去除跟踪参数）</dt>
            <dd className="mono small">{item.canonicalUrl ?? "—"}</dd>
          </div>
          <div className="kv" style={{ gridColumn: "1 / -1" }}>
            <dt>正文</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{item.text ?? "—"}</dd>
          </div>
          <div className="kv" style={{ gridColumn: "1 / -1" }}>
            <dt>话题</dt>
            <dd>
              {parseHashtagsJson(item.hashtags).length > 0
                ? parseHashtagsJson(item.hashtags).map((t) => (
                    <span key={t} className="plat-tag" style={{ marginRight: 6 }}>
                      #{t}
                    </span>
                  ))
                : "—"}
            </dd>
          </div>
          <KV label="发布时间">
            <span className="mono">{fmtDateTime(item.publishedAt)}</span>
          </KV>
          <KV label="原始时间值">
            <span className="mono">{item.rawPublishedAt ?? "—"}</span>
          </KV>
          <KV label="来源时区">{item.publishedTz ?? "—"}</KV>
          <KV label="时区语义">{item.publishedTzAssumption ?? "—"}</KV>
          <KV label="采集时间">
            <span className="mono">{fmtDateTime(item.collectedAt)}</span>
          </KV>
          <KV label="数据来源">{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</KV>
          <KV label="作者粉丝">{fmtMetric(item.authorFollowers)}</KV>
        </dl>
      </div>

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>
          最新指标
        </h2>
      </div>
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        {(
          [
            ["views", "播放/阅读", item.views],
            ["likes", "点赞", item.likes],
            ["comments", "评论", item.comments],
            ["shares", "分享", item.shares],
            ["favorites", "收藏", item.favorites],
            ["upvotes", "赞同", item.upvotes],
          ] as const
        ).map(([key, label, v]) => (
          <div className="card" key={key} style={{ padding: "10px 14px" }}>
            <div className="stat-label">{label}</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>
              {v === null ? <span className="null-mark">—</span> : v.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>
          指标快照历史（append-only，{snapshots.length} 条）
        </h2>
        <span className="section-hint">历史快照不可覆盖,重新采集只会新增 · 本页显示精确数值,列表页用万/亿紧凑格式</span>
      </div>
      {trendSeries.length > 0 && snapshots.length >= 2 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="stat-label" style={{ marginBottom: 6 }}>指标时序（快照连线，空白 = 该点未知，不与 0 混淆）</div>
          <LineChart series={trendSeries} />
        </div>
      )}
      <div className="table-wrap">
        <table className="ts">
          <thead>
            <tr>
              <th scope="col">快照时间</th>
              <th scope="col" className="num">播放</th>
              <th scope="col" className="num">点赞</th>
              <th scope="col" className="num">评论</th>
              <th scope="col" className="num">分享</th>
              <th scope="col" className="num">收藏</th>
              <th scope="col" className="num">赞同</th>
              <th scope="col">来源</th>
              <th scope="col">批次</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td className="mono small">{fmtDateTime(s.capturedAt)}</td>
                <MetricCells s={s} />
                <td>
                  <span className="plat-tag">{SOURCE_TYPE_LABELS[s.source] ?? s.source}</span>
                </td>
                <td className="mono small">{s.importBatchId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>
          来源与原始记录
        </h2>
        <span className="section-hint">原始数据永不因标准化而丢失</span>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <dl className="kv-grid" style={{ margin: 0, gridTemplateColumns: "repeat(3, 1fr)" }}>
          <KV label="原始记录 ID">
            <span className="mono">{raw?.id ?? "—"}</span>
          </KV>
          <KV label="适配器">
            <span className="mono">{raw?.adapter ?? "—"}</span>
          </KV>
          <KV label="导入批次">
            {batch ? (
              <span className="mono">
                #{batch.id} · {batchDisplayName(batch.name)} · {SOURCE_TYPE_LABELS[batch.sourceType] ?? batch.sourceType}
              </span>
            ) : (
              "—"
            )}
          </KV>
          <div className="kv" style={{ gridColumn: "1 / -1" }}>
            <dt>原始字段名</dt>
            <dd className="mono small">
              {raw?.fieldNames
                ? (() => {
                    try {
                      return (JSON.parse(raw.fieldNames) as string[]).join(" · ");
                    } catch {
                      return raw.fieldNames;
                    }
                  })()
                : "—"}
            </dd>
          </div>
          {raw?.note && (
            <div className="kv" style={{ gridColumn: "1 / -1" }}>
              <dt>备注</dt>
              <dd style={{ color: "var(--bad)" }}>{raw.note}</dd>
            </div>
          )}
        </dl>
      </div>
      <pre className="rawjson">{prettyRaw}</pre>

      {mergedSources.length > 0 && (
        <>
          <div className="section-head">
            <h2 className="section-title" style={{ fontSize: 15 }}>
              并入来源（{mergedSources.length} 条并入本条目）
            </h2>
            <span className="section-hint">原始记录全部保留，可逐条核对</span>
          </div>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="ts">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">平台 ID</th>
                  <th scope="col">标题</th>
                  <th scope="col">原始记录</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {mergedSources.map((s) => (
                  <tr key={s.item.id}>
                    <td className="mono">{s.item.id}</td>
                    <td className="mono small">{s.item.platformContentId ?? "—"}</td>
                    <td style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                      {s.item.title ?? <span className="null-mark">—</span>}
                    </td>
                    <td className="mono small">raw#{s.raw?.id ?? "—"}</td>
                    <td>
                      <Link to={`/content/${s.item.id}`} className="mono small" style={{ color: "var(--steel)" }}>
                        详情 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {mergeRecords.length > 0 && (
        <div className="card small" style={{ marginBottom: 12 }}>
          <div className="stat-label" style={{ marginBottom: 6 }}>
            合并审计记录
          </div>
          {mergeRecords.map((m) => (
            <div key={m.id} className="mono small">
              #{m.sourceContentId} → #{m.targetContentId} · {DUP_REASON_LABELS[m.reason] ?? m.reason} · {fmtDateTime(m.resolvedAt)}
            </div>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="card small">
          <div className="stat-label" style={{ marginBottom: 6 }}>
            本条目关联的疑似重复候选
          </div>
          {candidates.map((c) => (
            <div key={c.id} className="mono small" style={{ marginTop: 4 }}>
              疑似重复候选 #{c.id} ·{" "}
              <Link to="/duplicates" style={{ color: "var(--steel)" }}>
                {DUP_STATUS_LABELS[c.status] ?? c.status}
              </Link>{" "}
              · 条目 {c.contentItemA} ↔ {c.contentItemB}
            </div>
          ))}
        </div>
      )}

      {auxError && (
        <div className="banner err" role="alert">
          <span style={{ flex: 1 }}>相似内容与向量信息未取到:{auxError}</span>
          <button className="btn secondary" type="button" onClick={() => setAuxNonce((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {similar && similar.embeddingSpace && (
        <>
          <div className="section-head">
            <h2 className="section-title" style={{ fontSize: 15 }}>
              相似内容（{similar.mode === "api" ? "语义相似度" : "词法相似度"}）
            </h2>
            <span className="section-hint">
              {similar.mode === "api" ? "语义向量（API 模型）" : "本地词法回退 · 确定性词法向量，非 AI 语义"} · 空间{" "}
              {similar.embeddingSpace.id} · 候选 {similar.candidateCount} 条 · {similar.elapsedMs}ms
            </span>
          </div>
          {similar.hits.length === 0 ? (
            <div className="banner">尚无相似内容 —— 内容需要先向量化（语义中心 → 运行向量化）</div>
          ) : (
            <div className="table-wrap">
              <table className="ts">
                <thead>
                  <tr>
                    <th style={{ minWidth: 240 }}>标题</th>
                    <th scope="col">平台</th>
                    <th scope="col">类型</th>
                    <th scope="col" className="num">{similar.mode === "api" ? "语义相似度" : "词法相似度"}</th>
                    <th scope="col">话题</th>
                    <th scope="col">发布时间</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {similar.hits.map((h) => (
                    <tr key={h.contentItemId}>
                      <td style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                        <Link to={`/content/${h.contentItemId}`} style={{ color: "var(--ink)" }}>
                          {h.title ?? <span className="null-mark">—</span>}
                        </Link>
                      </td>
                      <td>
                        <PlatformTag platform={h.platform} />
                      </td>
                      <td className="small">{CONTENT_TYPE_LABELS[h.contentType] ?? h.contentType}</td>
                      <td className="num mono" style={{ fontWeight: 600 }}>
                        {(h.similarity * 100).toFixed(1)}%
                      </td>
                      <td>
                        {h.topicId ? (
                          <Link to={`/topics/${h.topicId}`} className="mono small" style={{ color: "var(--steel)" }}>
                            {h.topicName} ({h.topicMemberCount})
                          </Link>
                        ) : (
                          <span className="small muted">未归类</span>
                        )}
                      </td>
                      <td className="mono small">{h.publishedAt ? fmtDateTime(h.publishedAt) : "—"}</td>
                      <td>
                        <Link to={`/content/${h.contentItemId}`} className="mono small" style={{ color: "var(--steel)" }}>
                          详情 →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {embStatus && (
        <>
          <div className="section-head">
            <h2 className="section-title" style={{ fontSize: 15 }}>向量化信息来源</h2>
            <span className="section-hint">调试证据：语义文本 / 指纹 / 向量空间 —— 不只说“AI 判断相似”</span>
          </div>
          <div className="card small">
            {embStatus.space ? (
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 8 }}>
                <div>
                  <span className="muted">空间：</span>
                  <span className="mono"> {embStatus.space.id}</span>
                </div>
                <div>
                  <span className="muted">模式：</span> {embStatus.space.mode === "api" ? "语义向量（API）" : "本地词法回退"}
                </div>
                <div>
                  <span className="muted">向量：</span> {embStatus.embeddings.filter((e) => !e.superseded).length} 条有效 /{" "}
                  {embStatus.embeddings.length} 条历史
                </div>
              </div>
            ) : (
              <div className="muted">尚无激活的向量空间 — 前往 语义中心 运行向量化。</div>
            )}
            {embStatus.semanticText && (
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>
                  语义文本预览 · 文本指纹{" "}
                  <span className="mono">{embStatus.semanticText.textHash.slice(0, 16)}…</span>
                  {embStatus.semanticText.wasTruncated && (
                    <span className="chip b-partial" style={{ marginLeft: 6 }}>已截断</span>
                  )}
                  <span className="mono small muted"> · {embStatus.semanticText.textBuilderVersion}</span>
                </div>
                <pre className="rawjson" style={{ maxHeight: 160, whiteSpace: "pre-wrap" }}>
                  {embStatus.semanticText.semanticText}
                </pre>
              </div>
            )}
          </div>
        </>
      )}

      <div className="small muted" style={{ marginTop: 16 }}>
        fingerprint: <span className="mono">{item.fingerprint?.slice(0, 16) ?? "—"}
        {item.fingerprint ? "…" : ""}</span>
        {" · "}created {fmtDateTime(item.createdAt)} · updated {fmtDateTime(item.updatedAt)}
      </div>
    </div>
  );
}
