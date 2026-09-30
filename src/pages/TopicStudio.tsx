/**
 * 选题工作室(Release 1.0 Part 1 §22-§27)。
 *
 * 职责边界写死在页面上:热度由确定性引擎算好,这里只做"证据 → 可执行方案"的转化。
 * 因此 UI 不出现"AI 判断这个话题会火"之类的表达(§78 同源约束)。
 * 无 AI 凭据时证据摘要照常可读 —— 生成按钮 disabled 并说明配置方法(§14/§25)。
 */
import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Check, Copy, RefreshCw, Sparkles, Star, Trash2, Wand2 } from "lucide-react";
import { post } from "../lib/api";
import { buildQuery, useDebounced, useResource } from "../lib/useResource";
import { fmtDateTime, fmtMetric, EM_DASH, PLATFORM_LABELS } from "../lib/format";
import { LoadError, RefreshHint } from "../components/RequestState";
import { CONFIDENCE_ZH, LIFECYCLE_ZH } from "../components/ScoringBadges";
import type {
  StudioEvidencePackage,
  StudioGenerateResponse,
  StudioOutput,
  StudioRunView,
  StudioTopicRow,
  StudioView,
} from "../types/studio";

const SORT_LABELS: Record<string, string> = {
  opportunity: "按机会指数",
  trend: "按话题趋势",
  recent: "按最近更新",
};

const RISK_ZH: Record<string, string> = { low: "较低", medium: "中等", high: "较高", unknown: "数据不足" };

const QUALITY_MODE_ZH: Record<string, string> = { lexical_baseline: "词法基线", semantic_vectors: "语义向量", unknown: "未知" };

/** §78:展示层不出现裸英文 code;内部与 DB 仍用 code。 */
function zh(map: Record<string, string>, v: string | null | undefined, fallback = "未知"): string {
  return v ? map[v] ?? v : fallback;
}
const OPP_LEVEL_ZH: Record<string, string> = { high: "较高机会", medium: "中等机会", low: "较低机会" };

const HOOK_ZH: Record<string, string> = {
  question: "问题型",
  counter_intuitive: "反常识型",
  conflict_of_interest: "利益冲突型",
  identity: "身份代入型",
  data: "数据型",
  experience: "经历型",
  other: "其他",
};

const MARK_ZH: Record<string, string> = { saved: "已保存", favorite: "已收藏", discarded: "已废弃" };
const QUALITY_ZH: Record<string, string> = { high: "高", medium: "中", low: "低", insufficient: "不足" };

/** §78:展示层不出现裸英文 code;DB/内部仍用 code。 */
const ANGLE_SOURCE_ZH: Record<string, string> = { keyword: "关键词", manual: "人工命名", model: "模型命名", unknown: "未知" };

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走兜底分支 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn-sm"
      title={state === "failed" ? "剪贴板被浏览器拒绝;可长按/框选文本手动复制" : undefined}
      onClick={async () => {
        // 失败必须说话:静默 return 会让按钮看起来是死的(§67)
        setState((await copyText(text)) ? "done" : "failed");
        window.setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "done" ? <Check size={12} /> : <Copy size={12} />}{" "}
      {state === "done" ? "已复制" : state === "failed" ? "复制失败,请手动选择文本" : label}
    </button>
  );
}

function RefChips({ refs, labels }: { refs: string[]; labels: Record<string, string> }) {
  if (!refs.length) return <span className="small muted">未引用证据</span>;
  return (
    <span className="ref-chips">
      {refs.map((r) => (
        <span key={r} className="chip" title={labels[r] ?? "该编号不在本次证据索引内"}>
          {labels[r] ? `${r}·${labels[r]}` : `${r}(证据索引外)`}
        </span>
      ))}
    </span>
  );
}

function EvidencePanel({ ev }: { ev: StudioEvidencePackage }) {
  const truncated = Object.entries(ev.evidenceTruncated).filter(([, v]) => v);
  const truncLabels: Record<string, string> = {
    representative: "代表内容",
    burstContents: "爆发内容",
    patterns: "爆发共性",
    angles: "新兴角度",
    packageSize: "整体长度",
  };
  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">证据面板</div>
          <div className="section-hint">
            以下数字全部来自确定性引擎,工作室不重新判断热度。证据构建于 {fmtDateTime(ev.builtAt)}
          </div>
        </div>
      </div>
      {ev.demoData && (
        <div className="banner warn">当前话题成员以演示/回放数据为主,以上数字不是真实市场结论。</div>
      )}
      {ev.dataFreshness.stale && (
        <div className="banner warn">
          部分引擎结果已超过新鲜度窗口(趋势 {fmtMetric(ev.dataFreshness.ageHours.trend)} 小时前、情报{" "}
          {fmtMetric(ev.dataFreshness.ageHours.intelligence)} 小时前)。建议先到「趋势中心 / 机会工作台」重跑分析。
        </div>
      )}
      <div className="stat-grid">
        <div className="card" style={{ padding: "12px 14px" }}>
          <div className="stat-label">选题机会指数</div>
          <div className="stat-value">{fmtMetric(ev.opportunityScore)}</div>
          <div className="stat-sub">
            置信 {zh(CONFIDENCE_ZH, ev.opportunityConfidence, EM_DASH)} · 档位 {zh(OPP_LEVEL_ZH, ev.opportunityLevel, EM_DASH)}
          </div>
        </div>
        <div className="card" style={{ padding: "12px 14px" }}>
          <div className="stat-label">话题趋势指数</div>
          <div className="stat-value">{fmtMetric(ev.trendScore)}</div>
          <div className="stat-sub">
            生命周期 {zh(LIFECYCLE_ZH, ev.lifecycle, "数据不足")}
            {ev.pendingLifecycle ? ` · 待确认 ${zh(LIFECYCLE_ZH, ev.pendingLifecycle, "数据不足")}` : ""}
          </div>
        </div>
        <div className="card" style={{ padding: "12px 14px" }}>
          <div className="stat-label">饱和度</div>
          <div className="stat-value">{fmtMetric(ev.saturationScore)}</div>
          <div className="stat-sub">{ev.saturationBand ? `${ev.saturationBand}档` : "数据不足"}</div>
        </div>
        <div className="card" style={{ padding: "12px 14px" }}>
          <div className="stat-label">新颖度</div>
          <div className="stat-value">{fmtMetric(ev.noveltyScore)}</div>
          <div className="stat-sub">置信 {zh(CONFIDENCE_ZH, ev.noveltyConfidence, EM_DASH)}</div>
        </div>
        <div className="card" style={{ padding: "12px 14px" }}>
          <div className="stat-label">爆发密度</div>
          <div className="stat-value">{fmtMetric(ev.burstDensity)}</div>
          <div className="stat-sub">成员 {ev.memberCount} 条</div>
        </div>
      </div>
      <div className="kv-grid">
        <div className="kv">
          <span>关键词</span>
          <b>{ev.topKeywords.join("、") || "无"}</b>
        </div>
        <div className="kv">
          <span>平台分布</span>
          <b>
            {Object.entries(ev.platformDistribution)
              .map(([k, v]) => `${PLATFORM_LABELS[k] ?? k} ${v}`)
              .join("、") || "未知"}
          </b>
        </div>
        <div className="kv">
          <span>质量模式</span>
          <b>{zh(QUALITY_MODE_ZH, ev.qualityMode)}</b>
        </div>
        <div className="kv">
          <span>证据规模</span>
          <b>
            {ev.charCount} 字符 · {ev.evidenceIndex.length} 条可引用编号
          </b>
        </div>
      </div>
      {truncated.length > 0 && (
        <div className="small muted">
          为控制上下文长度,证据已按预算裁剪:{truncated.map(([k]) => truncLabels[k] ?? k).join("、")}
        </div>
      )}
      {ev.viralPatterns.length > 0 && (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">爆发共性(观察到的关联,非因果)</th>
                <th scope="col">爆发组</th>
                <th scope="col">对照组</th>
                <th scope="col">差异倍数</th>
                <th scope="col">样本</th>
                <th scope="col">证据质量</th>
              </tr>
            </thead>
            <tbody>
              {ev.viralPatterns.map((p) => (
                <tr key={p.refId}>
                  <td>
                    <span className="small muted">{p.refId}</span> {p.feature}
                  </td>
                  <td>{fmtMetric(p.viralRate)}</td>
                  <td>{fmtMetric(p.controlRate)}</td>
                  <td>{p.lift === null ? EM_DASH : `×${p.lift}`}</td>
                  <td className="small">
                    {fmtMetric(p.viralSampleSize)} vs {fmtMetric(p.controlSampleSize)}
                  </td>
                  <td>{zh(QUALITY_ZH, p.evidenceQuality)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ev.emergingAngles.length > 0 && (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">新兴角度</th>
                <th scope="col">成员</th>
                <th scope="col">新颖度</th>
                <th scope="col">标记</th>
              </tr>
            </thead>
            <tbody>
              {ev.emergingAngles.map((a) => (
                <tr key={a.refId}>
                  <td>
                    <span className="small muted">{a.refId}</span> {a.label ?? "(未命名)"}
                    {a.labelSource && a.labelSource !== "keyword" ? ` · ${zh(ANGLE_SOURCE_ZH, a.labelSource)}` : ""}
                  </td>
                  <td>{a.memberCount}</td>
                  <td>{fmtMetric(a.noveltyScore)}</td>
                  <td>{a.isEmerging ? <span className="chip b-completed">新兴</span> : <span className="small muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {Object.keys(ev.trendUnavailableReasons ?? {}).length > 0 && (
        <div className="small muted">
          趋势有组件不可用(权重已重新归一):{Object.values(ev.trendUnavailableReasons ?? {}).join("；")}
        </div>
      )}
    </div>
  );
}

function BriefPanel({ view }: { view: StudioView }) {
  const b = view.brief;
  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">证据摘要(确定性,非 AI)</div>
          <div className="section-hint">
            由本地规则把引擎结论组织成可读段落,不调用任何模型 · {fmtDateTime(b.generatedAt)}
          </div>
        </div>
        <CopyButton text={b.sections.map((s) => `## ${s.title}\n${s.lines.length ? s.lines.map((l) => `- ${l}`).join("\n") : s.emptyNote ?? "无"}`).join("\n\n")} label="复制摘要" />
      </div>
      {b.sections.map((s) => (
        <div key={s.key} style={{ marginBottom: 12 }}>
          <div className="stat-label">{s.title}</div>
          {s.lines.length ? (
            <ul className="brief-list">
              {s.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <div className="small muted">{s.emptyNote ?? "无"}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function PlanView({
  output,
  labels,
  claims,
  marks,
  onMark,
}: {
  output: StudioOutput;
  labels: Record<string, string>;
  claims: string[];
  marks: StudioRunView["marks"];
  onMark: (angleIndex: number | null, state: string) => void;
}) {
  const plain = [
    `话题概述:${output.topicSummary}`,
    `为什么现在:${output.whyNow}`,
    `目标受众:${output.targetAudience}`,
    `选题角度:\n${output.recommendedAngles
      .map((a, i) => `${i + 1}. ${a.name} —— ${a.coreIdea}(目标受众:${a.targetAudience};冲突:${a.conflict};依据:${a.evidenceRefs.join("、")})`)
      .join("\n")}`,
    `Hook:\n${output.hooks.map((h) => `- [${HOOK_ZH[h.kind] ?? h.kind}] ${h.text}`).join("\n")}`,
    `标题方向:\n${output.titleDirections.map((t) => `- ${t.text}(依据:${t.basedOn}${t.needsExternalVerification ? ";需外部核实" : ""})`).join("\n")}`,
    `内容结构:\n${output.contentStructures.map((c) => `- ${c.name}:${c.outline.join(" → ")}(${c.rationale})`).join("\n")}`,
    `可能立场:\n${output.stanceOptions.map((s) => `- ${s.label}:${s.summary}`).join("\n")}`,
    `风险提醒:\n${output.risks.map((r) => `- ${r}`).join("\n")}`,
    `不建议重复的角度:\n${output.avoidAngles.map((r) => `- ${r}`).join("\n")}`,
    `可信度说明:${output.confidenceNote}`,
  ].join("\n\n");

  const markOf = (idx: number | null) => marks.find((m) => m.angleIndex === idx);

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">选题方案</div>
          <div className="section-hint">AI 生成内容,仅作为创作建议;所有判断依据见每条后面的证据编号</div>
        </div>
        <div className="row-actions">
          <CopyButton text={plain} label="复制整个方案" />
          <button type="button" className="btn-sm" onClick={() => onMark(null, markOf(null)?.state === "saved" ? "none" : "saved")}>
            {markOf(null)?.state === "saved" ? "取消保存" : "保存方案"}
          </button>
        </div>
      </div>

      {claims.length > 0 && (
        <div className="banner err" role="alert">
          <div>
            <b>证据护栏标记了 {claims.length} 处需要核实的内容</b>
            <ul className="brief-list">
              {claims.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            这些片段没有在证据包里找到对应依据,请自行核实后再使用。
          </div>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div className="stat-label">话题概述</div>
        <p>{output.topicSummary}</p>
        <div className="stat-label">为什么现在值得关注</div>
        <p>{output.whyNow}</p>
        <div className="stat-label">目标受众</div>
        <p>{output.targetAudience}</p>
      </div>

      <div className="section-title sub">选题角度({output.recommendedAngles.length})</div>
      {output.recommendedAngles.map((a, i) => {
        const m = markOf(i);
        return (
          <div className="angle-card" key={i}>
            <div className="angle-head">
              <b>
                {i + 1}. {a.name}
              </b>
              <span className="row-actions">
                <span className={`chip ${a.saturationRisk === "high" ? "b-failed" : a.saturationRisk === "medium" ? "b-partial" : "b-completed"}`}>
                  饱和风险 {RISK_ZH[a.saturationRisk]}
                </span>
                {m && m.state !== "none" && <span className="chip">{MARK_ZH[m.state] ?? m.state}</span>}
                <CopyButton text={`${a.name}\n${a.coreIdea}\n目标受众:${a.targetAudience}\n冲突:${a.conflict}\n为什么值得做:${a.whyItMayBeInteresting}\n新颖性依据:${a.noveltyBasis}\n证据:${a.evidenceRefs.join("、")}`} label="复制角度" />
                <button type="button" className="btn-sm" title="收藏这条角度" onClick={() => onMark(i, m?.state === "favorite" ? "none" : "favorite")}>
                  <Star size={12} /> {m?.state === "favorite" ? "已收藏" : "收藏"}
                </button>
                <button type="button" className="btn-sm bad" title="废弃这条角度" onClick={() => onMark(i, m?.state === "discarded" ? "none" : "discarded")}>
                  <Trash2 size={12} /> {m?.state === "discarded" ? "已废弃" : "废弃"}
                </button>
              </span>
            </div>
            <p>{a.coreIdea}</p>
            <div className="small muted">目标受众:{a.targetAudience}</div>
            <div className="small muted">冲突点:{a.conflict}</div>
            <div className="small">为什么值得做:{a.whyItMayBeInteresting}</div>
            <div className="small">新颖性依据:{a.noveltyBasis}</div>
            <div className="small">
              证据:<RefChips refs={a.evidenceRefs} labels={labels} />
            </div>
          </div>
        );
      })}

      {output.hooks.length > 0 && (
        <>
          <div className="section-title sub">Hook 建议({output.hooks.length})</div>
          <ul className="brief-list">
            {output.hooks.map((h, i) => (
              <li key={i}>
                <span className="chip">{HOOK_ZH[h.kind] ?? h.kind}</span> {h.text}
                {h.evidenceRefs.length > 0 && <span className="small muted"> 证据:<RefChips refs={h.evidenceRefs} labels={labels} /></span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {output.titleDirections.length > 0 && (
        <>
          <div className="section-title sub">标题方向({output.titleDirections.length})</div>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th scope="col">标题候选</th>
                  <th scope="col">依据</th>
                  <th scope="col">证据</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {output.titleDirections.map((t, i) => (
                  <tr key={i}>
                    <td>
                      {t.text}
                      {t.needsExternalVerification && <span className="chip b-partial"> 需外部核实</span>}
                    </td>
                    <td className="small">{t.basedOn}</td>
                    <td>
                      <RefChips refs={t.evidenceRefs} labels={labels} />
                    </td>
                    <td>
                      <CopyButton text={t.text} label="复制标题" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {output.contentStructures.length > 0 && (
        <>
          <div className="section-title sub">内容结构({output.contentStructures.length})</div>
          {output.contentStructures.map((c, i) => (
            <div key={i} className="angle-card">
              <b>{c.name}</b>
              <ol className="brief-list">
                {c.outline.map((o, j) => (
                  <li key={j}>{o}</li>
                ))}
              </ol>
              <div className="small muted">{c.rationale}</div>
              <div className="small">
                证据:<RefChips refs={c.evidenceRefs} labels={labels} />
              </div>
            </div>
          ))}
        </>
      )}

      {output.stanceOptions.length > 0 && (
        <>
          <div className="section-title sub">可能立场({output.stanceOptions.length})</div>
          <div className="small muted">立场由你决定,这里只列出可选切口与各自风险。</div>
          {output.stanceOptions.map((s, i) => (
            <div key={i} className="angle-card">
              <b>{s.label}</b>
              <p>{s.summary}</p>
              <div className="small muted">适配受众:{s.audienceFit} · 风险:{s.risks}</div>
            </div>
          ))}
        </>
      )}

      <div className="section-title sub">风险提醒</div>
      {output.risks.length ? (
        <ul className="brief-list">
          {output.risks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <div className="small muted">方案未给出风险提醒。</div>
      )}

      <div className="section-title sub">不建议重复的角度</div>
      {output.avoidAngles.length ? (
        <ul className="brief-list">
          {output.avoidAngles.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <div className="small muted">方案未列出不建议重复的角度。</div>
      )}

      <div className="small muted" style={{ marginTop: 12 }}>
        可信度说明:{output.confidenceNote} · 全案引用证据编号:
        <RefChips refs={output.evidenceReferences} labels={labels} />
      </div>
    </div>
  );
}

export default function TopicStudio() {
  const [sort, setSort] = useState("opportunity");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { topicId: selectedParam } = useParams();
  const selected = selectedParam && Number.isInteger(Number(selectedParam)) ? Number(selectedParam) : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [livePlan, setLivePlan] = useState<{ runId: number; output: StudioOutput; claims: string[]; reused: boolean } | null>(null);
  const busyRef = useRef(false);

  const debouncedSearch = useDebounced(search, 250);
  const listRes = useResource<{ topics: StudioTopicRow[] }>(`/studio/topics${buildQuery({ sort, search: debouncedSearch, limit: 60 })}`);
  const viewRes = useResource<StudioView>(selected === null ? null : `/studio/topics/${selected}`, { resetOnPathChange: true });

  const view = viewRes.data;
  const topics = listRes.data?.topics ?? [];
  const labels: Record<string, string> = view
    ? Object.fromEntries(view.evidence.evidenceIndex.map((e) => [e.id, e.label]))
    : {};
  const currentRun: StudioRunView | null = livePlan
    ? (view?.history.find((h) => h.id === livePlan.runId) ?? null)
    : (view?.history[0] ?? null);
  const displayOutput = livePlan?.output ?? currentRun?.output ?? null;
  const displayClaims = livePlan?.claims ?? currentRun?.unsupportedClaims ?? [];

  async function generate(regenerate: boolean) {
    if (selected === null || busyRef.current) return;
    busyRef.current = true;
    setGenerating(true);
    setGenErr(null);
    setNotice(null);
    try {
      const r = await post<StudioGenerateResponse>(`/studio/topics/${selected}/generate`, { regenerate });
      if (r.status === "completed" && r.output) {
        setLivePlan({ runId: r.runId, output: r.output, claims: r.unsupportedClaims, reused: r.reused });
        setNotice(
          r.reused
            ? `证据未变化,已复用本话题上一次成功结果(#${r.runId}),未重新调用模型`
            : `选题方案已生成(${r.durationMs}ms · ${r.model ?? "未知模型"})`,
        );
      } else {
        setGenErr(r.error ?? "生成未完成");
      }
      viewRes.reload();
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setGenerating(false);
    }
  }

  async function markAngle(angleIndex: number | null, state: string) {
    const runId = livePlan?.runId ?? currentRun?.id;
    if (!runId) return;
    try {
      await post(`/studio/runs/${runId}/mark`, { angleIndex, state });
      viewRes.reload();
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="fade-in">
      <div className="section-head">
        <div>
          <h2>选题工作室</h2>
          <div className="section-hint">
            趋势、爆发、生命周期、饱和度、新颖度、机会指数都由确定性引擎算好;这里只做一件事 ——
            把这些证据转成能直接执行的选题方案。AI 不判断热度,也不替你做价值判断。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <div className="field">
            <label>排序</label>
            <select aria-label="排序" className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>搜索话题</label>
            <input aria-label="搜索话题"
              className="input"
              value={search}
              placeholder="话题名称或描述"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <RefreshHint show={listRes.refreshing} />
        </div>
        {listRes.error && !listRes.data && <LoadError message={listRes.error} onRetry={listRes.reload} />}
        {listRes.initialLoading ? (
          <div className="small muted">正在加载话题…</div>
        ) : topics.length === 0 ? (
          <div className="small muted">
            没有可选话题。{search ? "换个关键词试试," : ""}话题来自「话题」页面的话题分析,先到那里运行一次分析。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th scope="col">话题</th>
                  <th scope="col">成员</th>
                  <th scope="col">机会指数</th>
                  <th scope="col">趋势</th>
                  <th scope="col">生命周期</th>
                  <th scope="col">已生成</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => (
                  <tr key={t.topicId}>
                    <td>
                      <b>{t.name}</b>
                      {selected === t.topicId && <span className="chip b-completed"> 当前</span>}
                      <div className="small muted">#{t.topicId}</div>
                    </td>
                    <td>{t.memberCount}</td>
                    <td>{fmtMetric(t.opportunityScore)}</td>
                    <td>{fmtMetric(t.trendScore)}</td>
                    <td>{zh(LIFECYCLE_ZH, t.lifecycle, "数据不足")}</td>
                    <td>{t.runCount ? `${t.runCount} 次` : "未生成"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => {
                          setLivePlan(null);
                          setNotice(null);
                          setGenErr(null);
                          navigate(`/studio/${t.topicId}`);
                        }}
                      >
                        查看证据
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected === null ? (
        <div className="card">
          <div className="small muted">从上面的列表选择一个话题,即可查看证据并生成方案。未配置 AI 服务时,证据摘要照常可读。</div>
        </div>
      ) : viewRes.error && !view ? (
        <LoadError message={viewRes.error} onRetry={viewRes.reload} />
      ) : !view ? (
        <div className="card">
          <div className="small muted">正在加载证据包…</div>
        </div>
      ) : (
        <>
          <div className="section-head">
            <div>
              <div className="section-title">{view.evidence.topicName}</div>
              <div className="section-hint">
                {view.evidence.topicDescription || "无描述"} ·{" "}
                <Link to={`/topics/${view.evidence.topicId}`} className="backlink">
                  查看话题详情
                </Link>
              </div>
            </div>
            <RefreshHint show={viewRes.refreshing} />
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <div className="section-title">生成选题方案</div>
                <div className="section-hint">
                  {view.settings.configured
                    ? `AI 服务:${view.settings.model}${view.settings.source === "local-cli"
                        ? ""
                        : ` · temperature ${view.settings.temperature}`} · ${view.settings.sourceDetail}`
                    : `尚未配置 AI 生成服务(缺少环境变量 ${view.settings.missingEnvNames.join(" / ")})。`}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn accent"
                  disabled={!view.settings.configured || generating}
                  onClick={() => generate(false)}
                  title={view.settings.configured ? "证据未变化时复用上次结果" : "先在 .env 配置 STUDIO_API_KEY(或本机 CLI:STUDIO_CLI_COMMAND)后再使用"}
                >
                  {generating ? <RefreshCw size={13} className="spin" /> : <Wand2 size={13} />} 生成选题方案
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={!view.settings.configured || generating}
                  onClick={() => generate(true)}
                  title={view.settings.configured ? "忽略缓存,重新调用模型" : "先在 .env 配置 STUDIO_API_KEY(或 STUDIO_CLI_COMMAND)后再使用"}
                >
                  <Sparkles size={13} /> 重新生成
                </button>
              </div>
            </div>
            {!view.settings.configured && (
              <div className="banner info">
                证据摘要与全部分析功能不依赖 AI 服务,可照常使用。启用选题方案生成需要在项目目录的 .env 中设置
                STUDIO_API_KEY(可选 STUDIO_BASE_URL / STUDIO_MODEL);没有外部 Key 时,也可以把
                <span className="mono">STUDIO_CLI_COMMAND</span> 填成本机已登录的 AI 命令行程序名(例如
                <span className="mono"> claude </span>),复用本机登录态。两者都只影响选题方案与话题命名,改完需重启应用。
              </div>
            )}
            {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}
            {genErr && <div className="banner err" role="alert">{genErr}</div>}
          </div>

          {displayOutput && (
            <PlanView
              output={displayOutput}
              labels={labels}
              claims={displayClaims}
              marks={view.history.find((h) => h.id === (livePlan?.runId ?? currentRun?.id))?.marks ?? []}
              onMark={markAngle}
            />
          )}

          <BriefPanel view={view} />
          <EvidencePanel ev={view.evidence} />

          <div className="card">
            <div className="section-head">
              <div>
                <div className="section-title">生成历史({view.history.length})</div>
                <div className="section-hint">每次生成都会追加一条记录,不会被覆盖;版本号随记录保存,便于回溯当时的证据形状。</div>
              </div>
            </div>
            {view.history.length === 0 ? (
              <div className="small muted">
                本话题还没有生成记录。{view.settings.configured ? "点击「生成选题方案」开始。" : "配置 AI 服务后即可生成。"}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="ts">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">状态</th>
                      <th scope="col">来源</th>
                      <th scope="col">模型</th>
                      <th scope="col">证据哈希</th>
                      <th scope="col">护栏标记</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.history.map((h) => (
                      <tr key={h.id}>
                        <td className="small">
                          {fmtDateTime(h.startedAt)}
                          {h.durationMs !== null && <span className="muted"> · {h.durationMs}ms</span>}
                        </td>
                        <td>
                          <span className={`chip ${h.status === "completed" ? "b-completed" : h.status === "failed" ? "b-failed" : "b-processing"}`}>
                            {h.status === "completed" ? "已完成" : h.status === "failed" ? "失败" : "进行中"}
                          </span>
                        </td>
                        <td className="small">{h.provider ?? EM_DASH}</td>
                        <td className="small">
                          {h.model ?? EM_DASH}
                          <div className="muted">{h.promptVersion}</div>
                        </td>
                        <td className="small mono">{h.evidenceHash.slice(0, 12)}</td>
                        <td>{h.unsupportedClaims.length ? `${h.unsupportedClaims.length} 处` : "无"}</td>
                        <td>
                          {h.output ? (
                            <button
                              type="button"
                              className="btn-sm"
                              onClick={() => setLivePlan({ runId: h.id, output: h.output as StudioOutput, claims: h.unsupportedClaims, reused: false })}
                            >
                              查看方案
                            </button>
                          ) : h.error ? (
                            <span className="small muted" title={h.error}>
                              {h.error.slice(0, 24)}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="section-title">AI 服务</span>
              <span className={`chip ${view.settings.configured ? "b-completed" : "b-pending"}`}>
                {view.settings.configured ? "已配置" : "未配置"}
              </span>
              <span className="small muted">
                {view.settings.configured
                  ? `${view.settings.model} · ${view.settings.sourceDetail}`
                  : `缺少 ${view.settings.missingEnvNames.join("、") || "STUDIO_API_KEY / STUDIO_CLI_COMMAND"},填写后重启`}
              </span>
              <Link to="/settings" className="small" style={{ marginLeft: "auto", color: "var(--steel)" }}>
                查看完整配置与版本 →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
