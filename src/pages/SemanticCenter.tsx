/**
 * 语义中心 (Stage 6A §34/§36/§37): 向量空间 / 任务 / 运行向量化 / 设置。
 * 词法回退模式必须明确标注「本地词法回退」,绝不伪装 AI 语义向量(§36)。
 * Secret 只显示 Configured / Missing(§34)。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../lib/api";
import { fmtDateTime, EM_DASH } from "../lib/format";

interface SpaceRow {
  id: string;
  provider: string;
  model: string;
  dimension: number;
  textBuilderVersion: string;
  mode: string;
  isActive: number;
  createdAt: string;
  contentCount: number;
  latestJob: { id: number; status: string; processed: number; total: number; createdAt: string } | null;
}

interface JobRow {
  id: number;
  embeddingSpaceId: string;
  scope: string;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface SettingsView {
  activeSpaceId: string | null;
  lexical: { providerId: string; model: string; mode: string };
  api: { secretSource: string; credential: string; baseUrl: string | null; model: string | null };
  spaces: { id: string; mode: string; dimension: number; isActive: boolean }[];
}

function JobStatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    partial: "部分成功",
    failed: "失败",
    cancelled: "已取消",
  };
  const cls: Record<string, string> = {
    completed: "chip b-completed",
    partial: "chip b-partial",
    failed: "chip b-failed",
  };
  return <span className={cls[status] ?? "chip b-processing"}>{map[status] ?? status}</span>;
}

function ModeChip({ mode }: { mode: string }) {
  return mode === "api" ? (
    <span className="chip b-completed" title="已配置真实向量模型接口">语义向量(API)</span>
  ) : (
    <span className="chip b-pending" title="未调用任何模型 API;确定性词法向量(中文分词 + 哈希)">本地词法回退</span>
  );
}

export default function SemanticCenter() {
  const [spaces, setSpaces] = useState<SpaceRow[] | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scope, setScope] = useState<"missing" | "all">("missing");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api<{ rows: SpaceRow[] }>("/embedding/spaces"),
      api<{ rows: JobRow[] }>("/embedding/jobs?pageSize=10"),
      api<SettingsView>("/embedding/settings"),
    ])
      .then(([sp, jb, st]) => {
        setSpaces(sp.rows);
        setJobs(jb.rows);
        setSettings(st);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function runEmbedding() {
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      // 词法回退:始终可用(§13);API provider 未配置凭证时后端会 400 并给出原因
      const useApi = settings?.api.credential === "CONFIGURED" && !!settings?.api.baseUrl;
      const r = useApi
        ? await post<{ jobId: number }>("/embedding/jobs", {
            provider: "openai-compatible",
            scope,
            config: {
              baseUrl: settings!.api.baseUrl,
              model: settings!.api.model ?? "text-embedding-3-small",
              apiKeySecretRef: "secretref:env:EMBEDDING_API_KEY",
            },
          })
        : await post<{ jobId: number }>("/embedding/jobs", { provider: "lexical", dimension: 512, scope });
      setNotice(`已创建运行任务 #${r.jobId}${useApi ? "(语义向量 API)" : "(本地词法回退)"}`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    try {
      await post(`/embedding/spaces/${encodeURIComponent(id)}/activate`, {});
      setNotice(`已切换默认分析空间:${id}`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>语义中心</h1>
        <span className="section-hint">语义向量 · 向量空间 / 运行任务 / 设置 · 相似内容在内容详情页查看</span>
      </div>

      {err && <div className="banner err" role="alert">{err}</div>}
      {notice && <div className="banner ok" role="status" aria-live="polite">{notice}</div>}

      {settings && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="stat-label" style={{ marginBottom: 8 }}>设置</div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }} className="small">
            <div>
              <div className="muted">模式</div>
              <div>{settings.api.credential === "CONFIGURED" && settings.api.baseUrl ? "语义向量(API)" : "本地词法回退"}</div>
            </div>
            <div>
              <div className="muted">服务提供方</div>
              <div className="mono">{settings.api.credential === "CONFIGURED" ? "openai-compatible" : settings.lexical.providerId}</div>
            </div>
            <div>
              <div className="muted">模型名称</div>
              <div className="mono">{settings.api.credential === "CONFIGURED" ? settings.api.model ?? EM_DASH : settings.lexical.model}</div>
            </div>
            <div>
              <div className="muted">接口地址</div>
              <div className="mono">{settings.api.baseUrl ?? EM_DASH}</div>
            </div>
            <div>
              <div className="muted">密钥来源</div>
              <div className="mono">{settings.api.secretSource}</div>
            </div>
            <div>
              <div className="muted">凭证状态</div>
              <div>
                {settings.api.credential === "CONFIGURED" ? (
                  <span className="chip b-completed">已配置</span>
                ) : (
                  <span className="chip b-pending">未配置</span>
                )}
                <span className="muted small">(环境变量 EMBEDDING_API_KEY · 值永不显示)</span>
              </div>
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            配置真实向量模型:设置环境变量 EMBEDDING_API_KEY、EMBEDDING_BASE_URL、EMBEDDING_MODEL 后重启应用;
            未配置时使用本地词法回退(确定性、无需任何 Key)。四项外部能力的集中视图见{" "}
            <Link to="/settings" style={{ color: "var(--steel)" }}>设置</Link>。
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="stat-label">运行向量化</div>
          <span className="small muted">范围</span>
          <select aria-label="范围" className="input" style={{ width: 220 }} value={scope} onChange={(e) => setScope(e.target.value as "missing" | "all")}>
            <option value="missing">仅缺失的部分</option>
            <option value="all">全部内容(重扫缓存)</option>
          </select>
          <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={busy} onClick={runEmbedding}>
 运行向量化
          </button>
          <span className="small muted">词法回退下无任何外部调用;已入库且文本未变的内容自动跳过</span>
        </div>
      </div>

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>向量空间</h2>
      </div>
      {spaces === null ? (
        <div className="spinner">正在加载…</div>
      ) : spaces.length === 0 ? (
        <div className="banner">还没有向量空间 — 点上方「运行向量化」自动创建并填充。</div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">空间 ID</th>
                <th scope="col">模式</th>
                <th scope="col">维度</th>
                <th scope="col">文本版本</th>
                <th scope="col" className="num">内容数</th>
                <th scope="col">最近任务</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((sp) => (
                <tr key={sp.id}>
                  <td className="mono small" style={{ maxWidth: 380, overflowWrap: "anywhere" }}>
                    {sp.id}
                    {sp.isActive === 1 && <span className="chip b-completed" style={{ marginLeft: 6 }}>当前分析空间</span>}
                  </td>
                  <td><ModeChip mode={sp.mode} /></td>
                  <td className="num mono">{sp.dimension}</td>
                  <td className="mono small">{sp.textBuilderVersion}</td>
                  <td className="num mono">{sp.contentCount.toLocaleString()}</td>
                  <td className="small">
                    {sp.latestJob ? (
                      <>
                        <JobStatusChip status={sp.latestJob.status} />
                        <div className="mono small muted">
                          #{sp.latestJob.id} {sp.latestJob.processed}/{sp.latestJob.total}
                        </div>
                      </>
                    ) : (
                      EM_DASH
                    )}
                  </td>
                  <td>
                    {sp.isActive === 1 ? (
                      <span className="small muted">使用中</span>
                    ) : (
                      <button className="btn-sm" onClick={() => activate(sp.id)}>设为默认</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>向量化任务</h2>
      </div>
      {jobs.length === 0 ? (
        <div className="banner">还没有向量任务 —— 点「运行向量化」创建第一个任务。</div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">空间</th>
                <th scope="col">范围</th>
                <th scope="col">状态</th>
                <th scope="col" className="num">总数</th>
                <th scope="col" className="num">成功</th>
                <th scope="col" className="num">跳过</th>
                <th scope="col" className="num">失败</th>
                <th scope="col">开始</th>
                <th scope="col">完成</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.id}</td>
                  <td className="mono small" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{j.embeddingSpaceId}</td>
                  <td className="small">{j.scope === "all" ? "全部" : "仅缺失"}</td>
                  <td><JobStatusChip status={j.status} /></td>
                  <td className="num mono">{j.total}</td>
                  <td className="num mono" style={{ color: "var(--ok)" }}>{j.succeeded}</td>
                  <td className="num mono">{j.skipped}</td>
                  <td className="num mono" style={{ color: j.failed > 0 ? "var(--bad)" : undefined }}>{j.failed}</td>
                  <td className="mono small">{j.startedAt ? fmtDateTime(j.startedAt) : EM_DASH}</td>
                  <td className="mono small">{j.completedAt ? fmtDateTime(j.completedAt) : EM_DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
