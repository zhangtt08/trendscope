import { useState } from "react";
import { Link } from "react-router-dom";
import { GitMerge, CheckCircle2, XCircle, EyeOff, RefreshCw } from "lucide-react";
import { post } from "../lib/api";
import { buildQuery, useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import {
  fmtDateTime,
  fmtMetric,
  EM_DASH,
  QUALITY_LABELS,
  SOURCE_TYPE_LABELS,
  DUP_REASON_LABELS,
  DUP_STATUS_LABELS,
} from "../lib/format";
import { PlatformTag } from "../components/badges";

interface Brief {
  id: number;
  platform: string;
  platformContentId: string | null;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  url: string | null;
  text: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  sourceType: string;
  fingerprint: string | null;
  dataQuality: string;
}

interface Candidate {
  id: number;
  reason: string;
  similarity: number | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  a: Brief;
  b: Brief;
}

function CompareRow({ label, a, b, mono }: { label: string; a: React.ReactNode; b: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 1fr", borderBottom: "1px dashed var(--hairline)" }}>
      <div className="small muted" style={{ padding: "7px 0" }}>
        {label}
      </div>
      <div className={mono ? "mono small" : "small"} style={{ padding: "7px 10px 7px 0", overflowWrap: "anywhere" }}>
        {a}
      </div>
      <div className={mono ? "mono small" : "small"} style={{ padding: "7px 0", overflowWrap: "anywhere" }}>
        {b}
      </div>
    </div>
  );
}

const dash = <span className="null-mark">{EM_DASH}</span>;
const n = (v: number | null) => (v === null ? dash : fmtMetric(v));

function CandidateCompare({
  c,
  onResolved,
}: {
  c: Candidate;
  onResolved:  () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (action: "confirm" | "not_duplicate" | "ignore") => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ mergedSourceId?: number; targetId?: number }>(
        `/duplicates/${c.id}/resolve`,
        { action },
      );
      if (action === "confirm" && r.mergedSourceId && r.targetId) {
        setErr(null);
      }
      onResolved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const metricPair = (label: string, av: number | null, bv: number | null) => (
    <CompareRow
      key={label}
      label={label}
      mono
      a={n(av)}
      b={n(bv)}
    />
  );

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <GitMerge size={16} />
        <span className="mono small">
          候选 #{c.id} · {DUP_REASON_LABELS[c.reason] ?? c.reason} ·{" "}
          {c.similarity !== null ? `相似度 ${(c.similarity / 100).toFixed(0)}%` : "相似度未知"}
        </span>
        {c.status !== "pending" && <span className="chip b-partial">{DUP_STATUS_LABELS[c.status] ?? c.status}</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            className="btn accent"
            disabled={busy || c.status !== "pending"}
            onClick={() => void act("confirm")}
            title="确认重复：B 并入 A（B 保留为指针，快照迁移，原始记录不动）"
          >
            <CheckCircle2 /> 确认重复
          </button>
          <button title={busy ? "正在处理,请稍候" : c.status !== "pending" ? "该候选已处理,状态为「" + (DUP_STATUS_LABELS[c.status] ?? c.status) + "」" : "判为不是重复:两条都保留,以后不再提示这一对"} className="btn secondary" disabled={busy || c.status !== "pending"} onClick={() => void act("not_duplicate")}>
            <XCircle /> 不是重复
          </button>
          <button title={busy ? "正在处理,请稍候" : c.status !== "pending" ? "该候选已处理,状态为「" + (DUP_STATUS_LABELS[c.status] ?? c.status) + "」" : "先不处理:两条都保留,这一对不再出现在待处理里"} className="btn secondary" disabled={busy || c.status !== "pending"} onClick={() => void act("ignore")}>
            <EyeOff /> 忽略
          </button>
        </span>
      </div>
      {err && <div className="banner err" role="alert">{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 1fr", borderTop: "1px solid var(--hairline-strong)", fontWeight: 600 }}>
        <div />
        <div className="small" style={{ padding: "8px 10px 8px 0" }}>
          <PlatformTag platform={c.a.platform} /> A · #{c.a.id} <span className="muted small">（保留项,合并目标）</span>
        </div>
        <div className="small" style={{ padding: "8px 0" }}>
          <PlatformTag platform={c.b.platform} /> B · #{c.b.id} <span className="muted small">（合并源）</span>
        </div>
      </div>
      <CompareRow label="标题" a={c.a.title ?? dash} b={c.b.title ?? dash} />
      <CompareRow label="作者" a={c.a.authorName ?? dash} b={c.b.authorName ?? dash} />
      <CompareRow label="发布时间" mono a={fmtDateTime(c.a.publishedAt)} b={fmtDateTime(c.b.publishedAt)} />
      <CompareRow label="链接" mono a={c.a.url ?? dash} b={c.b.url ?? dash} />
      <CompareRow label="正文" a={c.a.text ?? dash} b={c.b.text ?? dash} />
      {metricPair("浏览量", c.a.views, c.b.views)}
      {metricPair("点赞数", c.a.likes, c.b.likes)}
      {metricPair("评论数", c.a.comments, c.b.comments)}
      <CompareRow label="来源" a={SOURCE_TYPE_LABELS[c.a.sourceType] ?? c.a.sourceType} b={SOURCE_TYPE_LABELS[c.b.sourceType] ?? c.b.sourceType} />
      <CompareRow label="质量" a={QUALITY_LABELS[c.a.dataQuality] ?? c.a.dataQuality} b={QUALITY_LABELS[c.b.dataQuality] ?? c.b.dataQuality} />
      <CompareRow
        label="指纹"
        mono
        a={c.a.fingerprint ? c.a.fingerprint.slice(0, 16) + "…" : dash}
        b={c.b.fingerprint ? c.b.fingerprint.slice(0, 16) + "…" : dash}
      />
      <div className="small muted" style={{ marginTop: 8 }}>
        创建于 {fmtDateTime(c.createdAt)}
        {c.resolvedAt ? ` · 处理于 ${fmtDateTime(c.resolvedAt)}` : ""} ·{" "}
        <Link to={`/content/${c.a.id}`} style={{ color: "var(--steel)" }}>
          A 详情
        </Link>{" "}
        ·{" "}
        <Link to={`/content/${c.b.id}`} style={{ color: "var(--steel)" }}>
          B 详情
        </Link>
      </div>
    </div>
  );
}

export default function Duplicates() {
  const [status, setStatus] = useState("pending");
  const res = useResource<{ rows: Candidate[] }>(`/duplicates${buildQuery({ status })}`);
  const rows = res.data?.rows ?? null;

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title">重复治理</h1>
        <span className="section-hint">
          模糊匹配只生成候选，确认前不会合并任何数据
        </span>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label>状态</label>
          <select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">待处理</option>
            <option value="confirmed_duplicate">已确认合并</option>
            <option value="not_duplicate">非重复</option>
            <option value="ignored">已忽略</option>
            <option value="">全部</option>
          </select>
        </div>
        <button title={res.loading ? "正在处理,请稍候" : undefined} className="btn secondary" disabled={res.loading} onClick={res.reload}>
          <RefreshCw /> 刷新
        </button>
      </div>

      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      <RefreshHint show={res.refreshing} />

      {res.initialLoading && <div className="spinner">正在加载…</div>}
      {rows !== null && rows.length === 0 && (
        <div className="card muted">该状态下暂无候选。</div>
      )}
      {rows?.map((c) => (
        <CandidateCompare key={c.id} c={c} onResolved={res.reload} />
      ))}

      <div className="small muted" style={{ marginTop: 14 }}>
        确认合并的行为：以 A 为保留项；B 会记录合并去向(合并后的内容编号)，
        指标快照迁移到 A，原始记录原样保留，并写入一条合并审计记录。
      </div>
    </div>
  );
}
