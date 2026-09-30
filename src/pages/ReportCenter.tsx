/**
 * 分析报告页:把服务端派生好的报告渲染成可读的看板,而不是贴一坨 Markdown。
 *
 * 结构来自 `/api/reports/latest` 的 `data` 字段(结构化),标签一律走前端唯一口径
 * (`src/lib/format.ts` + `ScoringBadges`),所以这里不会出现裸英文枚举码。
 * Markdown 原文折叠在底部,可整份复制 —— 需要另存或贴给别人时用。
 * 缺数据一律显示「数据不足」,不拿 0 顶替。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { FileText, RefreshCw, Copy, Check } from "lucide-react";
import { useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import { PLATFORM_LABELS, fmtDateTime, fmtMetric } from "../lib/format";
import { ConfidenceBadge, LifecycleBadge } from "../components/ScoringBadges";

interface OverviewItem {
  label: string;
  value: string;
  hint?: string;
}
interface PlatformRow {
  platform: string;
  label: string;
  items: number;
  latestAt: string | null;
  missingTime: number;
  noMetric: number;
  clustered: number;
}
interface TopicRow {
  rank: number;
  topicId: number;
  name: string;
  members: number;
  opportunity: number | null;
  confidence: string | null;
  level: string | null;
  lifecycle: string | null;
  trend: number | null;
  saturation: number | null;
  novelty: number | null;
  angles: string[];
}
interface ReportData {
  generatedAt: string;
  overview: OverviewItem[];
  platforms: PlatformRow[];
  topics: TopicRow[];
  capabilities: { label: string; ok: boolean; detail: string }[];
  gaps: string[];
}
interface ReportResponse {
  ok: boolean;
  sections: number;
  format: string;
  markdown: string;
  data: ReportData;
}

const LEVEL_ZH: Record<string, string> = { high: "高", medium: "中", low: "低", insufficient: "数据不足" };
/** 指标分(0-100,一位小数)。不能用 fmtMetric:那是计数口径,会把 68.6 显示成 69。 */
const n1 = (v: number | null): string => (v === null || v === undefined || !Number.isFinite(v) ? "数据不足" : v.toFixed(1));

export function ReportCenter() {
  const res = useResource<ReportResponse>("/reports/latest");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const data = res.data?.data;
  const md = res.data?.markdown ?? "";
  const maxItems = Math.max(1, ...(data?.platforms ?? [{ items: 1 }]).map((p) => p.items));

  async function regenerate() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败:浏览器拒绝了剪贴板访问");
    }
  }

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>
          <FileText size={16} style={{ marginRight: 6, verticalAlign: -2 }} />
          分析报告
        </h1>
        <span className="section-hint">
          {data ? `统计于 ${fmtDateTime(data.generatedAt)} · 全部字段来自本机已算好的指标,缺数据处标注「数据不足」` : "读取中…"}
        </span>
      </div>

      <div className="card" style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn accent" onClick={regenerate} disabled={busy}>
          <RefreshCw size={13} className={busy ? "spin" : undefined} /> {busy ? "生成中…" : "重新生成"}
        </button>
        <button type="button" className="btn secondary" onClick={copyMarkdown} disabled={!md}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制纯文本全文"}
        </button>
        <span className="small muted" style={{ marginLeft: "auto" }}>
          报告不落库:每次都是把已算好的指标重新排版,重新生成不会改动任何数据。
        </span>
      </div>

      <RefreshHint show={res.refreshing || busy} />
      {res.error && <LoadError message={`报告读取失败:${res.error}`} onRetry={res.reload} />}
      {err && <LoadError message={`生成失败:${err}`} onRetry={regenerate} />}

      {!data && !res.error ? (
        <div className="card small muted">正在读取报告…</div>
      ) : null}

      {data && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-head">
              <div className="section-title">一、数据面</div>
            </div>
            <div className="stat-grid">
              {data.overview.slice(0, 4).map((o) => (
                <div key={o.label}>
                  <div className="stat-label">{o.label}</div>
                  <div className="stat-value" style={{ fontSize: 22 }}>
                    {o.value}
                  </div>
                  {o.hint && o.hint !== o.value ? <div className="stat-sub small muted">{o.hint}</div> : null}
                </div>
              ))}
            </div>
            <div className="kv-grid" style={{ marginTop: 12 }}>
              {data.overview.slice(4).map((o) => (
                <div className="kv" key={o.label}>
                  <div className="stat-label">{o.label}</div>
                  <div style={{ fontSize: 13, marginTop: 3 }}>{o.value}</div>
                  {o.hint && o.hint !== o.value ? <div className="small muted" style={{ marginTop: 2 }}>{o.hint}</div> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-head">
              <div>
                <div className="section-title">二、平台覆盖</div>
                <div className="section-hint">每个平台采到了多少、最近什么时候采的、有多少已经归入话题</div>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 10, border: "none" }}>
              <table className="ts">
                <thead>
                  <tr>
                    <th>平台</th>
                    <th style={{ width: "26%" }}>条数</th>
                    <th className="num">最近采集</th>
                    <th className="num">已归类</th>
                    <th className="num">缺发布时间</th>
                    <th className="num">缺任一指标</th>
                  </tr>
                </thead>
                <tbody>
                  {data.platforms.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted small">
                        尚无内容 —— 先用「数据总览 → 一键抓热点」采一轮。
                      </td>
                    </tr>
                  ) : (
                    data.platforms.map((p) => (
                      <tr key={p.platform}>
                        <td>{PLATFORM_LABELS[p.platform] ?? p.label}</td>
                        <td>
                          <div className="row" style={{ gap: 8, alignItems: "center" }}>
                            <span className="mono" style={{ minWidth: 42 }}>{p.items}</span>
                            <span
                              aria-hidden="true"
                              style={{
                                display: "block",
                                height: 6,
                                width: `${Math.max(2, Math.round((p.items / maxItems) * 100))}%`,
                                background: "var(--amber)",
                                borderRadius: 2,
                              }}
                            />
                          </div>
                        </td>
                        <td className="num small">{p.latestAt ? fmtDateTime(p.latestAt) : "尚无"}</td>
                        <td className="num">{p.clustered === 0 ? "0" : fmtMetric(p.clustered)}</td>
                        <td className="num">{p.missingTime === 0 ? "0" : fmtMetric(p.missingTime)}</td>
                        <td className="num">{p.noMetric === 0 ? "0" : fmtMetric(p.noMetric)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-head">
              <div>
                <div className="section-title">三、话题与机会排名</div>
                <div className="section-hint">机会指数 / 饱和度 / 新颖度都来自选题机会模型,点话题名进工作室出方案</div>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 10, border: "none" }}>
              <table className="ts">
                <thead>
                  <tr>
                    <th className="num">名次</th>
                    <th>话题</th>
                    <th className="num">成员</th>
                    <th className="num">机会指数</th>
                    <th>置信度</th>
                    <th>生命周期</th>
                    <th className="num">饱和度</th>
                    <th className="num">新颖度</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topics.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="muted small">
                        尚无成簇话题 —— 需要更多次采样累积(热榜条目只有标题时聚不成簇)。
                      </td>
                    </tr>
                  ) : (
                    data.topics.map((t) => (
                      <tr key={t.topicId}>
                        <td className="num">{t.rank}</td>
                        <td>
                          <Link to={`/studio/${t.topicId}`}>{t.name || `话题 ${t.topicId}`}</Link>
                          <span className="small muted" style={{ marginLeft: 6 }}>#{t.topicId}</span>
                        </td>
                        <td className="num">{fmtMetric(t.members)}</td>
                        <td className="num">{n1(t.opportunity)}</td>
                        <td><ConfidenceBadge confidence={t.confidence} /></td>
                        <td><LifecycleBadge state={t.lifecycle} /></td>
                        <td className="num">{n1(t.saturation)}</td>
                        <td className="num">{n1(t.novelty)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-head">
              <div>
                <div className="section-title">四、选题建议</div>
                <div className="section-hint">每条建议都指向具体话题与已算好的指标,不做无依据推断</div>
              </div>
            </div>
            {data.topics.length === 0 ? (
              <div className="small muted" style={{ marginTop: 10 }}>
                当前没有可支撑选题的话题簇 —— 结论:数据不足,先增加采集频次或扩大渠道,不做无依据建议。
              </div>
            ) : (
              <div className="stat-grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, 1fr)" }}>
                {data.topics.slice(0, 6).map((t) => (
                  <div key={t.topicId} style={{ border: "1px solid var(--hairline)", borderRadius: 3, padding: "12px 14px" }}>
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Link to={`/studio/${t.topicId}`} style={{ fontWeight: 600 }}>
                        {t.name || `话题 ${t.topicId}`}
                      </Link>
                      <LifecycleBadge state={t.lifecycle} />
                      <ConfidenceBadge confidence={t.confidence} />
                    </div>
                    <div className="small" style={{ marginTop: 8 }}>
                      机会指数 <strong className="mono">{n1(t.opportunity)}</strong>
                      {" · 档位 "}{t.level ? (LEVEL_ZH[t.level] ?? t.level) : "数据不足"}
                      {" · 成员 "}{t.members}{" 条"}
                    </div>
                    <div className="small muted" style={{ marginTop: 4 }}>
                      饱和度 {n1(t.saturation)} / 新颖度 {n1(t.novelty)} —— 饱和高=同类切法已多,新颖高=还有空白角度
                    </div>
                    <div className="small" style={{ marginTop: 6 }}>
                      尚未被覆盖的角度:
                      {t.angles.length ? t.angles.join("、") : <span className="muted">数据不足(需要内容情报步骤产出新兴角度)</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="section-head">
              <div className="section-title">五、外部能力与缺口</div>
            </div>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              {data.capabilities.map((c) => (
                <span key={c.label} className={`chip ${c.ok ? "b-completed" : "b-pending"}`} title={c.detail}>
                  {c.label}:{c.ok ? "已配置" : "未配置"}
                </span>
              ))}
            </div>
            <ul className="small" style={{ marginTop: 10, paddingLeft: 18 }}>
              {data.capabilities.map((c) => (
                <li key={`d-${c.label}`}>
                  {c.label}:{c.ok ? "已配置" : "未配置"} —— <span className="muted">{c.detail}</span>
                </li>
              ))}
              {data.gaps.map((g, i) => (
                <li key={`g-${i}`}>{g}</li>
              ))}
            </ul>
          </div>

          <details className="card">
            <summary className="small" style={{ cursor: "pointer" }}>
              查看纯文本原文(可另存或贴给别人)
            </summary>
            <pre className="rawjson" style={{ marginTop: 10, maxHeight: 420, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {md}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
