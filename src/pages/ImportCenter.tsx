import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  FileSpreadsheet,
  FileJson,
  PenLine,
  History,
  Upload,
  Loader2,
} from "lucide-react";
import { api, post } from "../lib/api";
import {
  PLATFORM_LABELS,
  CONTENT_TYPE_LABELS,
  METRIC_LABELS,
  batchDisplayName,
  SOURCE_TYPE_LABELS,
  fmtDateTime,
} from "../lib/format";
import { BatchStatusChip } from "../components/badges";

/* ================= shared pieces ================= */

interface ImportResultSummary {
  batchId: number;
  total: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: string[];
  possibleDuplicates: number;
}

function ResultPanel({ result }: { result: ImportResultSummary }) {
  return (
    <div className={`banner ${result.failed > 0 ? (result.imported > 0 ? "warn" : "err") : "ok"}`}>
      <div className="result-stats">
        <div className="result-stat">
          <b style={{ color: "var(--ok)" }}>{result.imported}</b>新增
        </div>
        <div className="result-stat">
          <b style={{ color: "var(--warn)" }}>{result.duplicates}</b>重复（已追加快照）
        </div>
        <div className="result-stat">
          <b style={{ color: result.failed > 0 ? "var(--bad)" : "inherit" }}>{result.failed}</b>失败
        </div>
        <div className="result-stat">
          <b>{result.total}</b>总计
        </div>
      </div>
      {result.possibleDuplicates > 0 && (
        <div className="small">
          ⚠ {result.possibleDuplicates} 条指纹疑似重复（possible duplicate，仅标记未合并）
        </div>
      )}
      {result.errors.length > 0 && (
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>
            失败明细（前 {result.errors.length} 条）
          </summary>
          <div className="mono small" style={{ marginTop: 6 }}>
            {result.errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        </details>
      )}
      <div className="small" style={{ marginTop: 8 }}>
        <Link to={`/import/${result.batchId}`} style={{ color: "var(--steel)" }}>
          批次 #{result.batchId} 详情 →
        </Link>
      </div>
    </div>
  );
}

const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Singapore",
  "UTC",
  "America/New_York",
  "Europe/London",
];

function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {TIMEZONES.map((tz) => (
        <option key={tz} value={tz}>
          {tz}
        </option>
      ))}
    </select>
  );
}

function DryRunStats({
  d,
}: {
  d: {
    expectedValid: number;
    expectedInvalid: number;
    expectedDuplicates: number;
    invalidSamples: { index: number; error: string }[];
    timeFields: Record<string, { formats: string[]; samples: string[] }>;
    defaultTimezone: string;
  } | null;
}) {
  if (!d) return null;
  return (
    <div className="banner info">
      <div className="result-stats">
        <div className="result-stat">
          <b style={{ color: "var(--ok)" }}>{d.expectedValid}</b>预计可导入
        </div>
        <div className="result-stat">
          <b style={{ color: d.expectedInvalid > 0 ? "var(--bad)" : "inherit" }}>
            {d.expectedInvalid}
          </b>
          预计失败
        </div>
        <div className="result-stat">
          <b style={{ color: d.expectedDuplicates > 0 ? "var(--warn)" : "inherit" }}>
            {d.expectedDuplicates}
          </b>
          批内疑似重复
        </div>
        <div className="result-stat">
          <b>{d.defaultTimezone}</b>
          <span className="small">默认时区（日期无时区信息时使用）</span>
        </div>
      </div>
      {d.timeFields.publishedAt && (
        <div className="small">
          检测到时间字段 <span className="mono">{d.timeFields.publishedAt.formats.join(" / ") || "—"}</span>
          {d.timeFields.publishedAt.samples.length > 0 && (
            <span className="mono small muted"> · 例: {d.timeFields.publishedAt.samples[0]}</span>
          )}
        </div>
      )}
      {d.invalidSamples.length > 0 && (
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>
            预计失败样例（前 {d.invalidSamples.length} 条）
          </summary>
          <div className="mono small" style={{ marginTop: 6 }}>
            {d.invalidSamples.map((s, i) => (
              <div key={i}>行 {s.index}: {s.error}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PlatformSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">（按行内字段，缺省时兜底）</option>
      {Object.entries(PLATFORM_LABELS).map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

const CANON_FIELDS: { key: string; label: string }[] = [
  { key: "platform", label: "平台" },
  { key: "platformContentId", label: "内容 ID" },
  { key: "contentType", label: "内容类型" },
  { key: "title", label: "标题" },
  { key: "text", label: "正文" },
  { key: "hashtags", label: "话题标签" },
  { key: "url", label: "链接" },
  { key: "authorId", label: "作者 ID" },
  { key: "authorName", label: "作者昵称" },
  { key: "publishedAt", label: "发布时间" },
  { key: "views", label: "浏览量" },
  { key: "likes", label: "点赞数" },
  { key: "comments", label: "评论数" },
  { key: "shares", label: "分享数" },
  { key: "favorites", label: "收藏数" },
  { key: "upvotes", label: "赞同数" },
  { key: "authorFollowers", label: "粉丝数" },
];

function MappingEditor({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
}) {
  return (
    <div className="form-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
      {CANON_FIELDS.map((f) => (
        <div className="field" key={f.key}>
          <label>{f.label}</label>
          <select aria-label={f.label}
            value={mapping[f.key] ?? ""}
            onChange={(e) => {
              const next = { ...mapping };
              if (e.target.value) next[f.key] = e.target.value;
              else delete next[f.key];
              onChange(next);
            }}
          >
            <option value="">（不映射）</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

/* ================= CSV tab ================= */

interface CsvPreview {
  uploadId: string;
  filename: string;
  headers: string[];
  sampleRows: Record<string, unknown>[];
  detectedMapping: Record<string, string>;
  parseWarnings: string[];
  expectedValid: number;
  expectedInvalid: number;
  expectedDuplicates: number;
  invalidSamples: { index: number; error: string }[];
  timeFields: Record<string, { formats: string[]; samples: string[] }>;
  defaultTimezone: string;
}

function CsvTab() {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [platform, setPlatform] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setErr(null);
    setResult(null);
    setPreview(null);
    if (file.size > 10 * 1024 * 1024) {
      setErr(`文件过大: ${(file.size / 1024 / 1024).toFixed(1)} MB，上限 10 MB`);
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      const p = await post<CsvPreview>("/import/csv/preview", {
        content,
        filename: file.name,
        sourceTimezone: timezone,
      });
      setPreview(p);
      setMapping(p.detectedMapping);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timezone]);

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<ImportResultSummary>("/import/csv", {
        uploadId: preview.uploadId,
        mapping,
        platformOverride: platform || null,
        sourceTimezone: timezone,
      });
      setResult(r);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in">
      <div className="form-row">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <span className="small muted">≤ 10 MB · UTF-8 · 首行为表头</span>
      </div>

      {busy && (
        <div className="spinner" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Loader2 size={14} className="spin" /> 处理中…
        </div>
      )}
      {err && <div className="banner err" role="alert">{err}</div>}
      {result && <ResultPanel result={result} />}

      {preview && (
        <>
          <div className="section-head">
            <span className="section-no">预览 /</span>
            <h3 className="section-title" style={{ fontSize: 14 }}>
              {preview.filename} — 检测到 {preview.headers.length} 个字段
            </h3>
          </div>

          {preview.parseWarnings.length > 0 && (
            <div className="banner warn">
              CSV 解析警告（不影响导入）:
              <div className="mono small">
                {preview.parseWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            </div>
          )}

          <DryRunStats d={preview} />

          <MappingEditor headers={preview.headers} mapping={mapping} onChange={setMapping} />

          <div className="form-row" style={{ marginTop: 12, display: "flex", gap: 20, alignItems: "end", flexWrap: "wrap" }}>
            <div className="field">
              <label>平台兜底（行内平台字段缺失/未知时使用）</label>
              <PlatformSelect value={platform} onChange={setPlatform} />
            </div>
            <div className="field">
              <label>时区（仅用于无时区信息的日期；日期自带时区时以此为准）</label>
              <TimezoneSelect value={timezone} onChange={setTimezone} />
            </div>
            <button title={busy ? "正在处理,请稍候" : undefined} className="btn accent" disabled={busy} onClick={() => void doImport()}>
              <Upload /> 确认导入
            </button>
          </div>

          <div className="section-head">
            <span className="section-no">样例 /</span>
            <h3 className="section-title" style={{ fontSize: 14 }}>
              前 {preview.sampleRows.length} 行
            </h3>
          </div>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="ts">
              <thead>
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sampleRows.map((row, i) => (
                  <tr key={i}>
                    {preview.headers.map((h) => (
                      <td key={h} className="mono small">
                        {String(row[h] ?? "—").slice(0, 60)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ================= JSON tab ================= */

function JsonTab() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{
    uploadId: string;
    headers: string[];
    sampleRows: Record<string, unknown>[];
    detectedMapping: Record<string, string>;
    totalRows: number;
    expectedValid: number;
    expectedInvalid: number;
    expectedDuplicates: number;
    invalidSamples: { index: number; error: string }[];
    timeFields: Record<string, { formats: string[]; samples: string[] }>;
    defaultTimezone: string;
  } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [platform, setPlatform] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultSummary | null>(null);

  const doPreview = async () => {
    setErr(null);
    setResult(null);
    setPreview(null);
    if (!text.trim()) {
      setErr("请粘贴 JSON 内容或选择文件");
      return;
    }
    setBusy(true);
    try {
      const p = await post<typeof preview & object>("/import/json/preview", {
        content: text,
        filename: "pasted.json",
        sourceTimezone: timezone,
      });
      setPreview(p);
      setMapping(p.detectedMapping);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<ImportResultSummary>("/import/json", {
        uploadId: preview.uploadId,
        mapping,
        platformOverride: platform || null,
        sourceTimezone: timezone,
      });
      setResult(r);
      setPreview(null);
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in">
      <div className="form-row">
        <div className="field">
          <label>JSON 内容（单对象或对象数组）</label>
          <textarea aria-label="JSON 内容（单对象或对象数组）"
            rows={7}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='[{"id": "123", "标题": "示例", "点赞": "1.2万"}, ...]'
            style={{ width: "100%" }}
          />
        </div>
      </div>
      <div className="form-row">
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) {
              setErr(`文件过大: ${(f.size / 1024 / 1024).toFixed(1)} MB，上限 10 MB`);
              return;
            }
            setText(await f.text());
          }}
        />
      </div>
      <button title={busy ? "正在处理,请稍候" : undefined} className="btn secondary" disabled={busy} onClick={() => void doPreview()}>
        预检 / 检测字段
      </button>

      {busy && <div className="spinner">处理中…</div>}
      {err && <div className="banner err" role="alert">{err}</div>}
      {result && <ResultPanel result={result} />}

      {preview && (
        <>
          <div className="section-head">
            <span className="section-no">预览 /</span>
            <h3 className="section-title" style={{ fontSize: 14 }}>
              共 {preview.totalRows} 条记录
            </h3>
          </div>
          <DryRunStats d={preview} />
          <MappingEditor headers={preview.headers} mapping={mapping} onChange={setMapping} />
          <div className="form-row" style={{ marginTop: 12, display: "flex", gap: 20, alignItems: "end", flexWrap: "wrap" }}>
            <div className="field">
              <label>平台兜底</label>
              <PlatformSelect value={platform} onChange={setPlatform} />
            </div>
            <div className="field">
              <label>时区（仅用于无时区信息的日期）</label>
              <TimezoneSelect value={timezone} onChange={setTimezone} />
            </div>
            <button title={busy ? "正在处理,请稍候" : undefined} className="btn accent" disabled={busy} onClick={() => void doImport()}>
              <Upload /> 确认导入
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ================= Manual tab ================= */

function ManualTab() {
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [form, setForm] = useState({
    platform: "manual",
    contentType: "unknown",
    platformContentId: "",
    title: "",
    text: "",
    url: "",
    authorName: "",
    authorId: "",
    publishedAt: "",
    views: "",
    likes: "",
    comments: "",
    shares: "",
    favorites: "",
    upvotes: "",
    followers: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultSummary | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const metricOrNull = (v: string): number | null => {
    const t = v.trim();
    if (!t || t === "—" || t.toLowerCase() === "null") return null;
    const n = Number(t.replace(/[,_]/g, ""));
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const payload = {
        platform: form.platform,
        contentType: form.contentType,
        platformContentId: form.platformContentId.trim() || null,
        title: form.title.trim() || null,
        text: form.text.trim() || null,
        url: form.url.trim() || null,
        authorName: form.authorName.trim() || null,
        authorId: form.authorId.trim() || null,
        publishedAt: form.publishedAt.trim() || null,
        views: metricOrNull(form.views),
        likes: metricOrNull(form.likes),
        comments: metricOrNull(form.comments),
        shares: metricOrNull(form.shares),
        favorites: metricOrNull(form.favorites),
        upvotes: metricOrNull(form.upvotes),
        followers: metricOrNull(form.followers),
        sourceTimezone: timezone,
      };
      const r = await post<ImportResultSummary & { rows?: { contentItemId?: number }[] }>(
        "/import/manual",
        payload,
      );
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in">
      {err && <div className="banner err" role="alert">{err}</div>}
      {result && <ResultPanel result={result} />}
      <div className="form-grid">
        <div className="field">
          <label>平台 *</label>
          <select aria-label="平台 *" value={form.platform} onChange={set("platform")}>
            {Object.entries(PLATFORM_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>内容类型</label>
          <select aria-label="内容类型" value={form.contentType} onChange={set("contentType")}>
            {["unknown", "video", "image_post", "text_post", "question", "answer", "article"].map(
              (t) => (
                <option key={t} value={t}>
                  {CONTENT_TYPE_LABELS[t] ?? t}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="field">
          <label>内容 ID（平台 + ID 组合去重）</label>
          <input aria-label="内容 ID（平台 + ID 组合去重）" value={form.platformContentId} onChange={set("platformContentId")} />
        </div>
        <div className="field">
          <label>标题</label>
          <input aria-label="标题" value={form.title} onChange={set("title")} />
        </div>
        <div className="field">
          <label>正文</label>
          <input aria-label="正文" value={form.text} onChange={set("text")} />
        </div>
        <div className="field">
          <label>链接</label>
          <input aria-label="链接" value={form.url} onChange={set("url")} />
        </div>
        <div className="field">
          <label>作者昵称</label>
          <input aria-label="作者昵称" value={form.authorName} onChange={set("authorName")} />
        </div>
        <div className="field">
          <label>作者 ID</label>
          <input aria-label="作者 ID" value={form.authorId} onChange={set("authorId")} />
        </div>
        <div className="field">
          <label>发布时间（如 2024-01-02 03:04,或毫秒时间戳）</label>
          <input aria-label="发布时间（如 2024-01-02 03:04,或毫秒时间戳）" value={form.publishedAt} onChange={set("publishedAt")} />
        </div>
        {(["views", "likes", "comments", "shares", "favorites", "upvotes", "followers"] as const).map(
          (k) => (
            <div className="field" key={k}>
              <label>{METRIC_LABELS[k] ?? k}（留空 = 未知）</label>
              <input aria-label="0 是真实值，空是未知" value={form[k]} onChange={set(k)} placeholder="0 是真实值，空是未知" />
            </div>
          ),
        )}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 20, alignItems: "end", flexWrap: "wrap" }}>
        <div className="field">
          <label>时区（发布时间无时区信息时使用）</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>
        <button title={busy ? "正在处理,请稍候" : undefined} className="btn accent" disabled={busy} onClick={() => void submit()}>
          <PenLine /> 添加记录
        </button>
      </div>
    </div>
  );
}

/* ================= History tab ================= */

interface Batch {
  id: number;
  name: string;
  sourceType: string;
  platform: string | null;
  startedAt: string;
  completedAt: string | null;
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  duplicateRecords: number;
  status: string;
}

function HistoryTab({ refreshKey }: { refreshKey: number }) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ rows: Batch[] }>("/import/batches")
      .then((r) => setBatches(r.rows))
      .catch((e) => setErr(e.message));
  }, [refreshKey]);

  if (err) return <div className="banner err" role="alert">{err}</div>;
  if (!batches) return <div className="spinner">正在加载…</div>;

  return (
    <div className="table-wrap fade-in">
      <table className="ts">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">名称</th>
            <th scope="col">来源</th>
            <th scope="col">平台</th>
            <th scope="col">开始时间</th>
            <th scope="col" className="num">总数</th>
            <th scope="col" className="num">OK</th>
            <th scope="col" className="num">重复</th>
            <th scope="col" className="num">失败</th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          {batches.length === 0 && (
            <tr>
              <td colSpan={10} className="muted">
                暂无导入记录 —— 选择 CSV / JSON 文件后点「解析预览」,                或载入内置示例数据来先跑通整条链路。
              </td>
            </tr>
          )}
          {batches.map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.id}</td>
              <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                <Link to={`/import/${b.id}`} style={{ color: "var(--steel)" }}>
                  {batchDisplayName(b.name)}
                </Link>
              </td>
              <td>
                <span className="plat-tag">{SOURCE_TYPE_LABELS[b.sourceType] ?? b.sourceType}</span>
              </td>
              <td>
                {b.platform ? <span className="plat-tag">{b.platform}</span> : <span className="null-mark">—</span>}
              </td>
              <td className="mono small">{fmtDateTime(b.startedAt)}</td>
              <td className="num">{b.totalRecords}</td>
              <td className="num" style={{ color: "var(--ok)" }}>
                {b.successfulRecords}
              </td>
              <td className="num" style={{ color: "var(--warn)" }}>
                {b.duplicateRecords}
              </td>
              <td className="num" style={{ color: b.failedRecords > 0 ? "var(--bad)" : undefined }}>
                {b.failedRecords}
              </td>
              <td>
                <BatchStatusChip status={b.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ================= Fixture quick-load ================= */

function FixtureBar({ onDone }: { onDone:  () => void }) {
  const [fixtures, setFixtures] = useState<{ name: string; title: string; file: string; rowCount: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ fixtures: typeof fixtures }>("/fixtures")
      .then((r) => setFixtures(r.fixtures))
      .catch(() => setFixtures([]));
  }, []);

  const load = async (file: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<ImportResultSummary>("/import/fixture", {
        file,
        confirm: "LOAD_SAMPLE_INTO_CURRENT_DB",
      });
      setMsg(
        `示例数据导入完成:新增 ${r.imported} / 重复 ${r.duplicates} / 失败 ${r.failed}(批次 #${r.batchId})`,
      );
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="stat-label" style={{ marginBottom: 8 }}>
        示例数据快速加载(验证不同平台字段结构 → 统一标准化)
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {fixtures.map((f) => (
          <button
            key={f.file}
            className="btn secondary"
            disabled={busy}
            onClick={() => void load(f.file)}
            title={f.file}
          >
            {f.title || f.name} · {f.rowCount} 行
          </button>
        ))}
        {fixtures.length === 0 && <span className="muted small">暂无可加载的示例数据</span>}
        {msg && <span className="small mono">{msg}</span>}
      </div>
    </div>
  );
}

/* ================= page ================= */

type TabKey = "csv" | "json" | "manual" | "history";

export default function ImportCenter() {
  const [tab, setTab] = useState<TabKey>("csv");
  const [refreshKey, setRefreshKey] = useState(0);
  const bump =  () => setRefreshKey((k) => k + 1);

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title">导入中心</h1>
        <span className="section-hint">CSV / JSON / 手动 / 历史 · 每次导入都会生成一个导入批次</span>
      </div>

      <FixtureBar onDone={bump} />

      <div className="tabs">
        <button className={`tab${tab === "csv" ? " active" : ""}`} onClick={() => setTab("csv")}>
          <FileSpreadsheet /> CSV
        </button>
        <button className={`tab${tab === "json" ? " active" : ""}`} onClick={() => setTab("json")}>
          <FileJson /> JSON
        </button>
        <button className={`tab${tab === "manual" ? " active" : ""}`} onClick={() => setTab("manual")}>
          <PenLine /> 手动录入
        </button>
        <button className={`tab${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
          <History /> 导入历史
        </button>
      </div>

      {tab === "csv" && <CsvTab />}
      {tab === "json" && <JsonTab />}
      {tab === "manual" && <ManualTab />}
      {tab === "history" && <HistoryTab refreshKey={refreshKey} />}
    </div>
  );
}
