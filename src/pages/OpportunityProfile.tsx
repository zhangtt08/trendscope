/**
 * 机会模型(Stage 9.5 §43-§46):把 Opportunity Profile 从代码配置变成可治理的产品能力。
 * 红线:它只是分析偏好,不是"更准确的算法";页面不出现推荐/必做/最佳类话术。
 * 硬规则:历史版本只读 —— 改参数只能"另存为新版本"(§24/§25/§45)。
 */
import { useMemo, useRef, useState } from "react";
import { PromptDialog } from "../components/Dialogs";
import { post } from "../lib/api";
import { buildQuery, useResource } from "../lib/useResource";
import { LoadError, RefreshHint } from "../components/RequestState";
import { fmtDateTime, EM_DASH } from "../lib/format";

type WeightKey = "trend" | "burst" | "novelty" | "whitespace" | "pattern" | "lifecycle";
type LifecycleKey = "emerging" | "rising" | "peak" | "saturated" | "declining" | "evergreen" | "unknown";

interface ProfileView {
  id: number;
  profileKey: string;
  name: string;
  description: string | null;
  version: string;
  status: string;
  isActive: boolean;
  weights: Record<WeightKey, number>;
  freshness: { trendMaxAgeHours: number; intelligenceMaxAgeHours: number; penaltyStale: number };
  minimumEvidence: { minimumAvailableComponents: number };
  lifecycleFit: Record<string, number | null>;
  levelBands: { high: number; medium: number };
  createdAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
  createdFromProfileId: number | null;
  usage: { runs: number; snapshots: number };
  diff: Record<string, { from: unknown; to: unknown }> | null;
}

interface ProfilesResponse {
  rows: ProfileView[];
  activeId: number | null;
  defaultDraft: DraftShape | null;
  note: string;
}

interface DraftShape {
  name: string;
  description: string | null;
  weights: Record<WeightKey, number>;
  minimumEvidence: { minimumAvailableComponents: number };
  lifecycleFit: Record<string, number | null>;
  freshness: { trendMaxAgeHours: number; intelligenceMaxAgeHours: number; penaltyStale: number };
}

const WEIGHT_LABELS: Record<WeightKey, string> = {
  trend: "趋势强度",
  burst: "爆发信号",
  novelty: "新颖度",
  whitespace: "内容空间",
  pattern: "共性信号",
  lifecycle: "生命周期适配",
};
const WEIGHT_KEYS = Object.keys(WEIGHT_LABELS) as WeightKey[];

const LIFECYCLE_LABELS: Record<LifecycleKey, string> = {
  emerging: "新兴",
  rising: "上升",
  peak: "高位",
  saturated: "饱和",
  declining: "下降",
  evergreen: "常青",
  unknown: "数据不足",
};
const LIFECYCLE_KEYS = Object.keys(LIFECYCLE_LABELS) as LifecycleKey[];

/** 权重是用户随手填的任意非负数;这里只做展示用的归一化预览,保存以服务端结果为准。 */
function effectiveWeights(w: Record<WeightKey, number>): Record<WeightKey, number> {
  const sum = WEIGHT_KEYS.reduce((a, k) => a + (Number(w[k]) || 0), 0);
  const out = {} as Record<WeightKey, number>;
  for (const k of WEIGHT_KEYS) out[k] = sum > 0 ? (Number(w[k]) || 0) / sum : 0;
  return out;
}

/** 服务端存的是归一化后的小数;编辑框用人看得懂的 0-100 刻度(保存时仍由服务端归一化)。 */
function toEditableWeights(w: Record<WeightKey, number>): Record<WeightKey, number> {
  const out = {} as Record<WeightKey, number>;
  for (const k of WEIGHT_KEYS) out[k] = Math.round((Number(w[k]) || 0) * 1000) / 10;
  return out;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

/** §34:面向人的单位,不让用户填毫秒。 */
function ageLabel(hours: number): string {
  if (hours < 24) return `${hours} 小时`;
  const days = hours / 24;
  return `${Math.round(days * 10) / 10} 天(${hours} 小时)`;
}

export default function OpportunityProfile() {
  const res = useResource<ProfilesResponse>(`/opportunity/profiles${buildQuery({})}`);
  const rows = res.data?.rows ?? [];
  const active = rows.find((r) => r.isActive) ?? null;

  const [baseId, setBaseId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activateAfterSave, setActivateAfterSave] = useState(false);
  // 新模型标识用产品内对话框收集(不再用 window.prompt)
  const [cloneTarget, setCloneTarget] = useState<ProfileView | null>(null);
  // §74:disabled 要等一次重渲染才生效,同一帧内连点仍会发多个请求 —— 用同步的 ref 拦住
  const busyRef = useRef(false);

  const editing = baseId !== null && draft !== null ? rows.find((r) => r.id === baseId) ?? null : null;

  function startEdit(p: ProfileView) {
    setOpErr(null);
    setNotice(null);
    setBaseId(p.id);
    setDraft({
      name: p.name,
      description: p.description,
      weights: toEditableWeights(p.weights),
      minimumEvidence: { ...p.minimumEvidence },
      lifecycleFit: { ...p.lifecycleFit },
      freshness: { ...p.freshness },
    });
  }

  function restoreDefault() {
    const d = res.data?.defaultDraft;
    if (!d || baseId === null) return;
    setOpErr(null);
    setNotice("草稿已恢复为系统默认参数(已保存的历史版本不受影响)");
    setDraft({
      ...d,
      name: draft?.name ?? d.name,
      weights: toEditableWeights(d.weights),
      lifecycleFit: { ...d.lifecycleFit },
      freshness: { ...d.freshness },
      minimumEvidence: { ...d.minimumEvidence },
    });
  }

  async function save() {
    if (baseId === null || !draft || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOpErr(null);
    setNotice(null);
    try {
      const r = await post<{ profile: ProfileView; created: boolean }>(`/opportunity/profiles/${baseId}/versions`, draft);
      if (activateAfterSave) {
        await post(`/opportunity/profiles/${r.profile.id}/activate`, {});
      }
      setNotice(
        r.created
          ? `已保存为新版本 ${r.profile.version}${activateAfterSave ? " 并设为当前模型" : ""}`
          : `参数与 ${r.profile.version} 完全相同,未重复建版本`,
      );
      setBaseId(null);
      setDraft(null);
      res.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function activate(p: ProfileView) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOpErr(null);
    try {
      await post(`/opportunity/profiles/${p.id}/activate`, {});
      setNotice(`当前模型已切换为 ${p.name} ${p.version};只影响之后的新 Run,历史快照不变`);
      res.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function archive(p: ProfileView) {
    if (!window.confirm(`归档 ${p.name} ${p.version}?归档只是停用,历史快照仍指向这一版,不会删除任何数据。`)) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOpErr(null);
    try {
      await post(`/opportunity/profiles/${p.id}/archive`, {});
      setNotice("已归档(不物理删除)");
      res.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function cloneAsNew(p: ProfileView, key: string) {
    setBusy(true);
    setOpErr(null);
    try {
      const body = {
        profileKey: key,
        name: `${p.name} 副本`,
        description: p.description,
        weights: p.weights,
        minimumEvidence: p.minimumEvidence,
        lifecycleFit: p.lifecycleFit,
        freshness: p.freshness,
      };
      const r = await post<{ profile: ProfileView }>(`/opportunity/profiles`, body);
      setNotice(`已创建 ${r.profile.profileKey} ${r.profile.version}`);
      res.reload();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const eff = useMemo(() => (draft ? effectiveWeights(draft.weights) : null), [draft]);
  const diffPreview = useMemo(() => {
    if (!draft || !editing) return [];
    const from = effectiveWeights(editing.weights);
    const to = eff!;
    const lines: string[] = [];
    for (const k of WEIGHT_KEYS) {
      if (Math.abs(from[k] - to[k]) > 1e-6) lines.push(`${WEIGHT_LABELS[k]}:${pct(from[k])} → ${pct(to[k])}`);
    }
    if (editing.freshness.trendMaxAgeHours !== draft.freshness.trendMaxAgeHours) {
      lines.push(`趋势时效:${ageLabel(editing.freshness.trendMaxAgeHours)} → ${ageLabel(draft.freshness.trendMaxAgeHours)}`);
    }
    if (editing.freshness.intelligenceMaxAgeHours !== draft.freshness.intelligenceMaxAgeHours) {
      lines.push(
        `情报时效:${ageLabel(editing.freshness.intelligenceMaxAgeHours)} → ${ageLabel(draft.freshness.intelligenceMaxAgeHours)}`,
      );
    }
    if (editing.minimumEvidence.minimumAvailableComponents !== draft.minimumEvidence.minimumAvailableComponents) {
      lines.push(
        `最低可用组件数:${editing.minimumEvidence.minimumAvailableComponents} → ${draft.minimumEvidence.minimumAvailableComponents}`,
      );
    }
    for (const k of LIFECYCLE_KEYS) {
      const a = editing.lifecycleFit[k] ?? null;
      const b = draft.lifecycleFit[k] ?? null;
      if (a !== b) lines.push(`${LIFECYCLE_LABELS[k]} 适配值:${a ?? "不适用"} → ${b ?? "不适用"}`);
    }
    return lines;
  }, [draft, editing, eff]);

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>机会模型</h1>
        <span className="section-hint">
          {res.data?.note ?? "机会模型 = 六组件权重与分析偏好;历史快照永远指向它计算时用的那个版本。"}
          <RefreshHint show={res.refreshing} />
        </span>
      </div>

      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {opErr && <div className="banner err" role="alert">{opErr}</div>}
      {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}

      {res.initialLoading && <div className="spinner">正在加载…</div>}

      {!res.initialLoading && active === null && (
        <div className="banner">还没有可显示的模型 —— 请先运行一次机会分析。</div>
      )}

      {active && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="stat-label" style={{ marginBottom: 6 }}>当前模型</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
            <strong>{active.name}</strong>
            <span className="mono small">{active.version}</span>
            <span className="small muted">
              被 {active.usage.runs} 次 Run / {active.usage.snapshots} 条快照使用
            </span>
          </div>
          {active.description && <div className="small muted" style={{ marginTop: 4 }}>{active.description}</div>}
          <div className="small" style={{ marginTop: 8 }}>
            {WEIGHT_KEYS.map((k) => (
              <span key={k} className="chip b-processing" style={{ marginRight: 6 }}>
                {WEIGHT_LABELS[k]} {pct(active.weights[k])}
              </span>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            数据新鲜度:趋势 {ageLabel(active.freshness.trendMaxAgeHours)} · 情报 {ageLabel(active.freshness.intelligenceMaxAgeHours)} ·
            过期扣分 {pct(active.freshness.penaltyStale)} · 最低证据:可用组件 ≥{active.minimumEvidence.minimumAvailableComponents} ·
            档位区间 ≥{active.levelBands.high} 较高 / ≥{active.levelBands.medium} 中等
          </div>
        </div>
      )}

      {draft && editing && eff && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="stat-label" style={{ marginBottom: 8 }}>
            编辑草稿(基于 {editing.name} {editing.version})
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="pf-name">模型名称</label>
              <input aria-label="模型名称"
                id="pf-name"
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="pf-desc">说明</label>
              <input aria-label="说明"
                id="pf-desc"
                className="input"
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
          </div>

          <div className="stat-label" style={{ margin: "12px 0 6px" }}>组件权重(填任意非负数,保存时自动归一化)</div>
          <div className="form-grid">
            {WEIGHT_KEYS.map((k) => (
              <div className="field" key={k}>
                <label htmlFor={`w-${k}`}>
                  {WEIGHT_LABELS[k]} · 有效 {pct(eff[k])}
                </label>
                <input
                  id={`w-${k}`}
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={String(draft.weights[k])}
                  onChange={(e) =>
                    setDraft({ ...draft, weights: { ...draft.weights, [k]: Number(e.target.value) } })
                  }
                />
              </div>
            ))}
          </div>
          {WEIGHT_KEYS.every((k) => (draft.weights[k] || 0) <= 0) && (
            <div className="banner err" style={{ marginTop: 8 }} role="alert">权重全部为 0 无法保存 —— 至少给一个组件正权重。</div>
          )}

          <button
            className="btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            type="button"
          >
            {advancedOpen ? "收起高级参数" : "展开高级参数(数据新鲜度 / 最低证据 / 生命周期适配)"}
          </button>

          {advancedOpen && (
            <>
              <div className="stat-label" style={{ margin: "12px 0 6px" }}>数据新鲜度</div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="f-trend">趋势最长时效(小时)</label>
                  <input aria-label="趋势最长时效(小时)"
                    id="f-trend"
                    className="input"
                    type="number"
                    min={1}
                    value={String(draft.freshness.trendMaxAgeHours)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        freshness: { ...draft.freshness, trendMaxAgeHours: Math.round(Number(e.target.value)) },
                      })
                    }
                  />
                  <span className="small muted">{ageLabel(draft.freshness.trendMaxAgeHours || 1)}</span>
                </div>
                <div className="field">
                  <label htmlFor="f-intel">情报最长时效(小时)</label>
                  <input aria-label="情报最长时效(小时)"
                    id="f-intel"
                    className="input"
                    type="number"
                    min={1}
                    value={String(draft.freshness.intelligenceMaxAgeHours)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        freshness: {
                          ...draft.freshness,
                          intelligenceMaxAgeHours: Math.round(Number(e.target.value)),
                        },
                      })
                    }
                  />
                  <span className="small muted">{ageLabel(draft.freshness.intelligenceMaxAgeHours || 1)}</span>
                </div>
                <div className="field">
                  <label htmlFor="f-min">最低可用组件数</label>
                  <input aria-label="最低可用组件数"
                    id="f-min"
                    className="input"
                    type="number"
                    min={1}
                    max={6}
                    value={String(draft.minimumEvidence.minimumAvailableComponents)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minimumEvidence: { minimumAvailableComponents: Math.round(Number(e.target.value)) },
                      })
                    }
                  />
                  <span className="small muted">低于这个数,该话题判为"数据不足",不给 0 分</span>
                </div>
              </div>

              <div className="stat-label" style={{ margin: "12px 0 6px" }}>生命周期适配值(0-100;留空 = 该阶段不计入)</div>
              <div className="form-grid">
                {LIFECYCLE_KEYS.map((k) => (
                  <div className="field" key={k}>
                    <label htmlFor={`lc-${k}`}>{LIFECYCLE_LABELS[k]}</label>
                    <input aria-label={`${LIFECYCLE_LABELS[k]} 权重`}
                      id={`lc-${k}`}
                      className="input"
                      type="number"
                      min={0}
                      max={100}
                      value={draft.lifecycleFit[k] === null || draft.lifecycleFit[k] === undefined ? "" : String(draft.lifecycleFit[k])}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          lifecycleFit: { ...draft.lifecycleFit, [k]: e.target.value === "" ? null : Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="stat-label" style={{ margin: "14px 0 6px" }}>与上一版本的差异</div>
          {diffPreview.length === 0 ? (
            <div className="small muted">暂无差异 —— 与 {editing.version} 完全相同,保存也不会产生新版本。</div>
          ) : (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {diffPreview.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={busy} onClick={() => void save()} type="button">
              {busy ? "保存中…" : "保存为新版本"}
            </button>
            <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={activateAfterSave} onChange={(e) => setActivateAfterSave(e.target.checked)} />
              保存后设为当前模型
            </label>
            <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busy} onClick={restoreDefault} type="button">
              恢复默认参数
            </button>
            <button title={busy ? "正在处理,请稍候" : undefined}
              className="btn-sm"
              disabled={busy}
              onClick={() => {
                setBaseId(null);
                setDraft(null);
              }}
              type="button"
            >
              放弃编辑
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="ts" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">版本</th>
                <th scope="col">状态</th>
                <th scope="col" className="num">被运行记录使用</th>
                <th scope="col" className="num">被快照引用</th>
                <th scope="col">创建时间</th>
                <th scope="col">上一版差异</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="mono small muted">{p.profileKey}</div>
                  </td>
                  <td className="mono small">{p.version}</td>
                  <td>
                    {p.isActive ? (
                      <span className="chip b-completed">当前模型</span>
                    ) : p.status === "archived" ? (
                      <span className="chip b-failed">已归档</span>
                    ) : (
                      <span className="chip b-partial">可切换</span>
                    )}
                  </td>
                  <td className="num mono">{p.usage.runs}</td>
                  <td className="num mono">{p.usage.snapshots}</td>
                  <td className="mono small">{p.createdAt ? fmtDateTime(p.createdAt) : EM_DASH}</td>
                  <td className="small muted">
                    {p.diff
                      ? Object.entries(p.diff)
                          .map(([k, v]) => `${k}: ${fmtSide(v.from)} → ${fmtSide(v.to)}`)
                          .slice(0, 3)
                          .join(" · ") || EM_DASH
                      : EM_DASH}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button title={busy ? "正在处理,请稍候" : p.isActive ? "已经是当前使用的模型" : undefined} className="btn-sm" disabled={busy || p.isActive} onClick={() => activate(p)} type="button">
                        设为当前模型
                      </button>
                      <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busy} onClick={() => startEdit(p)} type="button">
                        编辑(另存新版本)
                      </button>
                      <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm" disabled={busy} onClick={() => setCloneTarget(p)} type="button">
                        复制为新模型
                      </button>
                      <button title={busy ? "正在处理,请稍候" : p.status === "archived" ? "已归档的模型不能启用" : p.isActive ? "已经是当前使用的模型" : undefined}
                        className="btn-sm bad"
                        disabled={busy || p.isActive || p.status === "archived"}
                        onClick={() => archive(p)}
                        type="button"
                      >
                        归档
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cloneTarget && (
        <PromptDialog
          spec={{
            title: `复制为新模型(基于 ${cloneTarget.name} ${cloneTarget.version})`,
            hint: "标识只允许小写字母、数字、下划线,且以字母开头。副本沿用当前参数,创建后不会自动启用。",
            initialValue: `${cloneTarget.profileKey}_copy`,
            confirmLabel: "创建副本",
            validate: (v) => (/^[a-z][a-z0-9_]*$/.test(v) ? null : "标识需要以小写字母开头,只能包含字母/数字/下划线"),
            onSubmit: (key) => {
              if (key) void cloneAsNew(cloneTarget, key);
            },
          }}
          onClose={() => setCloneTarget(null)}
        />
      )}

      <div className="small muted" style={{ marginTop: 14 }}>
        说明:权重与阈值改变只作用于之后的新 Run;已经生成的快照带着自己那份版本号,随时可以回看它当时为什么是这个分。
      </div>
    </div>
  );
}

function fmtSide(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v >= 0 && v <= 1 ? pct(v) : String(Math.round(v * 10) / 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
