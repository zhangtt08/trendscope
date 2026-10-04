/**
 * 话题洞察面板(Stage 8 §54):趋势/生命周期之外追加 —— 饱和度、新颖度、
 * 爆发内容共性(观察到的关联,非因果,§17/§59)、新兴角度。
 * 所有小样本/数据不足显式标注(§78),证据质量与样本量总是可见(§57/§58)。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDateTime, EM_DASH } from "../lib/format";
import { ConfidenceBadge, ScoreBar } from "./ScoringBadges";
import { MethodNote } from "./MethodNote";

const EVIDENCE_ZH: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  insufficient: "样本不足",
};

function saturationBandLabel(score: number | null): string {
  if (score === null || score === undefined) return "数据不足";
  if (score < 34) return "低";
  if (score < 67) return "中";
  return "高";
}

function EvidenceChip({ q }: { q: string }) {
  return (
    <span
      className={`chip ${q === "high" ? "b-completed" : q === "medium" ? "b-partial" : q === "low" ? "b-processing" : "b-processing"}`}
      title="证据质量:由两侧样本量决定;证据低 ≠ 结论错误,只是样本少"
    >
      证据 {EVIDENCE_ZH[q] ?? q}
    </span>
  );
}

const FEATURE_ZH: Record<string, string> = {
  titleLength: "标题长度",
  textLength: "正文长度",
  hasQuestionMark: "含问号",
  hasNumber: "含数字",
  hasRegion: "含地区词",
  hasHashtag: "含话题标签",
  hasExplicitComparison: "对比结构",
  publishHour: "发布小时",
  publishWeekday: "发布星期",
  hasFirstPerson: "第一人称",
  hasSecondPerson: "第二人称",
  hasPriceOrMoneyExpression: "金额表达",
  hasIdentityExpression: "身份表达",
  hasQuestionStructure: "问句结构",
  hasColon: "冒号",
  hasListStructure: "清单结构",
  hasStrongPunctuation: "强标点",
};

function PatternRow({ p }: { p: PatternRowData }) {
  const viral = p.viralValue as { viralRate?: number; viralMedian?: number; viral?: Record<string, number> };
  const control = p.controlValue as { controlRate?: number; hits?: number; median?: number; control?: Record<string, number> };
  const isBoolean = p.featureKind === "boolean";
  const isContinuous = p.featureKind === "continuous";
  const dir = (p.notes as { direction?: string })?.direction ?? "none";
  const dirText = dir === "positive" ? "爆发组更常见" : dir === "negative" ? "爆发组更少" : "差异不明显";
  const dirCls = dir === "positive" ? "delta-up" : dir === "negative" ? "delta-down" : "muted";
  let viralText = EM_DASH;
  let controlText = EM_DASH;
  if (isBoolean) {
    // 缺值渲染成 0% 会被读成"爆发组里 0% 命中",是一条其实没依据的事实断言;
    // 项目红线是 null≠0,未知一律显 —。
    viralText = viral.viralRate === undefined || viral.viralRate === null ? EM_DASH : `${Math.round(viral.viralRate * 100)}%`;
    controlText =
      control.hits !== undefined
        ? `${control.hits}/${p.controlSampleSize}`
        : control.controlRate === undefined || control.controlRate === null
          ? EM_DASH
          : `${Math.round(control.controlRate * 100)}%`;
  } else if (isContinuous) {
    viralText = viral.viralMedian === undefined || viral.viralMedian === null ? EM_DASH : String(Math.round(viral.viralMedian));
    controlText = control.median === undefined || control.median === null ? EM_DASH : String(Math.round(control.median));
  }
  return (
    <tr>
      <td>{FEATURE_ZH[p.feature] ?? p.feature.replace("semantic.", "语义·")}</td>
      <td className="num mono">{viralText}</td>
      <td className="num mono">{controlText}</td>
      <td className="num">
        {p.lift !== null && p.lift !== undefined ? (
          <span className="mono">{p.lift.toFixed(1)}×</span>
        ) : p.delta !== null && p.delta !== undefined ? (
          <span className="mono">{p.delta > 0 ? "+" : ""}{Math.round(p.delta)}</span>
        ) : (
          <span className="null-mark">—</span>
        )}
      </td>
      <td><span className={dirCls}>{dirText}</span></td>
      <td><EvidenceChip q={p.evidenceQuality} /></td>
      <td className="num mono small">N={p.viralSampleSize}/{p.controlSampleSize}</td>
    </tr>
  );
}

interface PatternRowData {
  id: number;
  feature: string;
  featureKind: string;
  viralValue: unknown;
  controlValue: unknown;
  lift: number | null;
  delta: number | null;
  viralSampleSize: number;
  controlSampleSize: number;
  evidenceQuality: string;
  notes: unknown;
}

export function TopicIntelligenceSection({ topicId }: { topicId: number }) {
  const [saturation, setSaturation] = useState<Record<string, unknown> | null>(null);
  const [novelty, setNovelty] = useState<Record<string, unknown> | null>(null);
  const [patterns, setPatterns] = useState<PatternRowData[] | null>(null);
  const [angles, setAngles] = useState<AngleRow[] | null>(null);
  const [opportunity, setOpportunity] = useState<OppData | null>(null);
  const [oppMiss, setOppMiss] = useState(false);

  // settled 而不是 50ms 计时器:原先两个请求只要在 50ms 后到达,setMiss(true) 就已
  // 经触发,而 `if (miss) return` 排在数据判断之前 —— 数据明明拿到了,面板却永久
  // 显示"尚未运行内容情报分析"。现在等四个请求真正落定后再判定缺失。
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    setSaturation(null);
    setNovelty(null);
    setPatterns(null);
    setAngles(null);
    setOpportunity(null);
    setOppMiss(false);
    setSettled(false);
    Promise.all([
      api<{ current: Record<string, unknown> }>(`/topics/${topicId}/saturation`).then((d) => d.current).catch(() => null),
      api<{ current: Record<string, unknown> }>(`/topics/${topicId}/novelty`).then((d) => d.current).catch(() => null),
      api<{ rows: PatternRowData[] }>(`/topics/${topicId}/patterns`).then((d) => d.rows).catch(() => []),
      api<{ rows: AngleRow[] }>(`/topics/${topicId}/angles`).then((d) => d.rows).catch(() => []),
      api<OppData>(`/opportunity/topics/${topicId}`).catch(() => null),
    ]).then(([sat, nov, pat, ang, opp]) => {
      if (!alive) return;
      setSaturation(sat);
      setNovelty(nov);
      setPatterns(pat);
      setAngles(ang);
      if (opp && opp.current) setOpportunity(opp);
      else setOppMiss(true);
      setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, [topicId]);

  const miss = settled && saturation === null && novelty === null;

  if (miss) {
    return (
      <div>
        <div className="stat-label" style={{ margin: "12px 0 6px" }}>话题洞察</div>
        <div className="small muted">尚未运行内容情报分析 —— 到「趋势中心 → 话题趋势」点击「运行评分」,或等待下一次情报运行。</div>
      </div>
    );
  }

  const satScore = (saturation?.score as number | null) ?? null;
  const satConf = saturation?.confidence as string | null;
  const satEv = (saturation?.evidence ?? {}) as Record<string, unknown>;
  const satBreakdown = (saturation?.breakdown ?? {}) as Record<string, unknown>;
  const novScore = (novelty?.score as number | null) ?? null;
  const novCount = (novelty?.emergingAngleCount as number | null) ?? null;
  const novConf = novelty?.confidence as string | null;
  const novEv = (novelty?.evidence ?? {}) as { emerging?: { label: string; memberCount: number; noveltyScore: number | null; firstObservedAt: string; maxHistoricalSimilarity: number | null }[] };
  const satUnscorable = saturation?.unscorableReason as string | null | undefined;
  const novUnscorable = novelty?.unscorableReason as string | null | undefined;
  const hasAny = saturation !== null || novelty !== null || (patterns !== null && patterns.length > 0) || (angles !== null && angles.length > 0);
  if (!hasAny) return null;

  return (
    <div>
      <div className="stat-label" style={{ margin: "12px 0 6px" }}>
        话题洞察(观察到的模式与数据差异,不是选题建议)
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }} className="small">
        <div>
          <span className="muted">话题饱和度:</span>
          {satUnscorable ? (
            <span className="muted">数据不足({satUnscorable})</span>
          ) : (
            <>
              <ScoreBar score={satScore} width={80} />
              <span className="chip b-processing" style={{ marginLeft: 6 }}>{saturationBandLabel(satScore)}</span>
              <ConfidenceBadge confidence={satConf} />
            </>
          )}
        </div>
        <div>
          <span className="muted">近期新颖度:</span>
          {novUnscorable ? (
            <span className="muted">数据不足({novUnscorable})</span>
          ) : (
            <>
              <ScoreBar score={novScore} width={80} />
              <span className="chip b-completed" style={{ marginLeft: 6 }}>新兴角度 {novCount ?? EM_DASH}</span>
              <ConfidenceBadge confidence={novConf} />
            </>
          )}
        </div>
        <span className="muted small">词法饱和度基线(未配置向量模型凭证时使用)</span>
      </div>
      {saturation !== null && !satUnscorable && (
        <div className="small mono muted">
          饱和证据:近 7 天新增 {String(satEv.recent7d ?? "—")} · 成员 {String(satEv.members ?? "—")} · 向量覆盖 {String((satEv.angle as { 参与成员?: number } | undefined)?.参与成员 ?? "—")}
          {Array.isArray(satEv.unavailableComponents) && satEv.unavailableComponents.length > 0 ? ` · 缺失:${(satEv.unavailableComponents as string[]).join("、")}` : ""}
          {typeof satBreakdown.weightsUsed === "object" ? "" : ""}
        </div>
      )}

      {/* 爆发内容共性 */}
      {patterns !== null && patterns.length > 0 && (
        <div>
          <div className="stat-label" style={{ margin: "10px 0 6px" }}>
            爆发内容共性(爆发组 vs 匹配控制组 · 观察到的关联,不是因果)
          </div>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th scope="col">特征</th>
                  <th scope="col" className="num">爆发组</th>
                  <th scope="col" className="num">普通组</th>
                  <th scope="col" className="num">差异倍数</th>
                  <th scope="col">方向</th>
                  <th scope="col">证据质量</th>
                  <th scope="col" className="num">样本量</th>
                </tr>
              </thead>
              <tbody>
                {patterns.slice(0, 12).map((p) => (
                  <PatternRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            差异倍数 = 爆发组占比 ÷ 普通组占比;"爆发组更常见"仅描述观察到的关联,不构成"使用它会爆"的因果结论。
          </div>
        </div>
      )}
      {patterns !== null && patterns.length === 0 && (
        <div className="small muted" style={{ margin: "8px 0" }}>
          当前爆发内容样本不足,暂无法形成稳定共性(需要爆发组 ≥8 且控制组 ≥15 条,先运行内容评分)。
        </div>
      )}

      {/* 新兴角度 */}
      {angles !== null && angles.length > 0 && (
        <div>
          <div className="stat-label" style={{ margin: "10px 0 6px" }}>新兴角度(话题内近期出现的表达簇)</div>
          <div className="table-wrap">
            <table className="ts">
              <thead>
                <tr>
                  <th scope="col">角度</th>
                  <th scope="col" className="num">成员</th>
                  <th scope="col">首次出现</th>
                  <th scope="col" className="num">新颖度</th>
                  <th scope="col">代表内容</th>
                </tr>
              </thead>
              <tbody>
                {angles.slice(0, 8).map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.label}
                      {a.isEmerging === 1 && <span className="chip b-completed" style={{ marginLeft: 6 }}>新兴</span>}
                    </td>
                    <td className="num mono">{a.memberCount}</td>
                    <td className="mono small">{fmtDateTime(a.firstObservedAt)}</td>
                    <td><ScoreBar score={a.noveltyScore} width={60} /></td>
                    <td className="small">
                      {(parseIds(a.representativeItemIds) ?? []).slice(0, 3).map((rid: number, idx: number) => (
                        <span key={rid}>
                          {idx > 0 ? " · " : ""}
                          <Link to={`/content/${rid}`} style={{ color: "var(--steel)" }}>#{rid}</Link>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {novEv.emerging && novEv.emerging.length > 0 && angles !== null && angles.length === 0 && (
        <div className="small mono muted">新兴角度证据:{JSON.stringify(novEv.emerging)}</div>
      )}

      <OpportunityMini opp={opportunity} miss={oppMiss} />
    </div>
  );
}

interface OppData {
  current: {
    score: number | null;
    confidence: string | null;
    opportunityLevel: string | null;
    unscorableReason: string | null;
    deltaScore: number | null;
    evidence: string | Record<string, unknown>;
    calculatedAt: string;
  } | null;
  history: { id: number; score: number | null; calculatedAt: string; whyChanged: string | null }[];
  decision: { status: string; note: string | null } | null;
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const OPP_COMPONENT_ZH: Record<string, string> = {
  trend: "趋势贡献", burst: "爆发信号", novelty: "新颖度", whitespace: "内容空间", pattern: "共性信号", lifecycle: "生命周期适配",
};

/** 选题机会区(§39):分数/置信/六组件(可下钻)/正向/限制/历史/变化来源。 */
function OpportunityMini({ opp, miss }: { opp: OppData | null; miss: boolean }) {
  const [decision, setDecision] = useState<string | null>(null);
  useEffect(() => {
    if (opp?.decision) setDecision(opp.decision.status);
  }, [opp]);
  if (miss || !opp?.current) {
    return (
      <div>
        <div className="stat-label" style={{ margin: "12px 0 6px" }}>选题机会</div>
        <div className="small muted">尚未运行机会分析 —— 到「选题机会」页点「刷新全部分析」。</div>
      </div>
    );
  }
  const cur = opp.current;
  const ev = (typeof cur.evidence === "string" ? safeJson(cur.evidence) : cur.evidence) as {
    reasonCodes?: string[];
    positiveReasons?: string[];
    limitingReasons?: string[];
    whyChanged?: { component: string; delta: number }[] | null;
    components?: Record<string, { raw: number | null; available: boolean; contribution: number | null }>;
  } | null;
  const levelZh = cur.opportunityLevel === "high" ? "较高机会" : cur.opportunityLevel === "medium" ? "中等机会" : cur.opportunityLevel === "low" ? "较低机会" : "数据不足";
  return (
    <div>
      <div className="stat-label" style={{ margin: "12px 0 6px" }}>
        选题机会(当前数据的结构化量化,不是未来结果概率)
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }} className="small">
        <div>
          <span className="muted">机会指数:</span>
          {cur.score === null ? (
            <span className="muted">数据不足({cur.unscorableReason ?? "—"})</span>
          ) : (
            <>
              <ScoreBar score={cur.score} width={100} />
              <span className="chip b-partial" style={{ marginLeft: 6 }}>{levelZh}</span>
            </>
          )}
        </div>
        <div><span className="muted">置信度:</span><ConfidenceBadge confidence={cur.confidence} /></div>
        {cur.deltaScore !== null && (
          <div>
            <span className="muted">近期变化:</span>
            <span className={cur.deltaScore > 0 ? "delta-up" : "delta-down"}>{cur.deltaScore > 0 ? "+" : ""}{cur.deltaScore}</span>
          </div>
        )}
        {decision && decision !== "none" && <div><span className="muted">人工决策:</span>{decision === "shortlisted" ? "已入选" : decision === "reviewing" ? "观察中" : "已搁置"}</div>}
      </div>
      {ev?.components && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "4px 14px" }} className="small">
          {Object.entries(ev.components).map(([k, c]) => (
            <div key={k} title={c.available ? `原始分 ${Math.round(c.raw ?? 0)}(点击上方链接查看对应证据)` : "缺失,权重已重归一"}>
              <span style={{ display: "inline-flex", justifyContent: "space-between", width: "100%" }}>
                <span>{OPP_COMPONENT_ZH[k] ?? k}{!c.available && <span className="muted">(缺失)</span>}</span>
                <span className="mono">{c.contribution !== null ? Math.round(c.contribution) : "—"}</span>
              </span>
              <ScoreBar score={c.raw} width={80} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 }} className="small">
        <div><span className="muted">正向信号:</span>{(ev?.positiveReasons ?? []).join(";") || EM_DASH}</div>
        <div><span className="muted">限制因素:</span>{(ev?.limitingReasons ?? []).join(";") || EM_DASH}</div>
        {cur.deltaScore !== null && ev?.whyChanged && ev.whyChanged.length > 0 && (
          <div><span className="muted">变化来源:</span>{ev.whyChanged.map((w) => `${OPP_COMPONENT_ZH[w.component] ?? w.component} ${w.delta > 0 ? "+" : ""}${w.delta}`).join(" · ")}</div>
        )}
      </div>
      {opp.history.length > 1 && (
        <div className="small mono muted" style={{ marginTop: 6 }}>
          历史机会指数:{opp.history.slice(0, 8).reverse().map((hh) => `${fmtDateTime(hh.calculatedAt)}=${hh.score !== null ? Math.round(hh.score) : "—"}`).join(" → ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <Link className="btn-sm" to="/opportunity" style={{ textDecoration: "none" }}>去机会工作台管理决策 →</Link>
      </div>
      <MethodNote kind="opportunity" ctx={{ calculatedAt: cur.calculatedAt }} />
    </div>
  );
}

interface AngleRow {
  id: number;
  label: string;
  memberCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  representativeItemIds: string | number[];
  noveltyScore: number | null;
  isEmerging: number;
}

function parseIds(v: string | number[] | null | undefined): number[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v) as number[];
  } catch {
    return null;
  }
}
