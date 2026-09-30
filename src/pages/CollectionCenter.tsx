/**
 * Collection Center (Stage 4 §28-31): Connectors / Tasks / Runs.
 * - Connectors: metadata + deterministic health + circuit state (§29)
 * - Tasks: create/edit/enable/disable/run now/cancel/delete (§30; delete
 *   keeps run history)
 * - Runs: metrics + event timeline (§31)
 * Industrial design system; poll refresh while runs are active.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, post, patch, del } from "../lib/api";
import { fmtDateTime, EM_DASH, PLATFORM_LABELS, CONNECTOR_TYPE_LABELS, CAPABILITY_LABELS, BREAKER_STATE_LABELS, TRIGGER_LABELS, RUN_STATUS_LABELS, RUN_ERROR_ZH, RUN_EVENT_ZH } from "../lib/format";
import { buildQuery, useResource } from "../lib/useResource";
import { LoadError } from "../components/RequestState";

/* ---------------- types ---------------- */

interface ConnectorView {
  metadata: {
    id: string;
    name: string;
    platform: string;
    connectorType: string;
    version: string;
    capabilities: string[];
    defaultTimezone: string;
    description?: string;
    isDemo?: boolean;
  };
  isDemo: boolean;
  health: {
    status: string;
    detail: string | null;
    circuitState: string;
    lastCheck: string;
    recentRuns: { total: number; failed: number; partial: number; completed: number };
  };
}

interface TaskView {
  id: number;
  name: string;
  connectorId: string;
  platform: string;
  collectionType: string;
  config: Record<string, unknown>;
  schedule: { type: string; intervalMs?: number };
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  connectorName: string | null;
  isRunning: boolean;
  lastRun: { id: number; status: string; createdAt: string; recordsAccepted: number } | null;
}

interface RunRow {
  id: number;
  taskId: number;
  taskName: string;
  connectorId: string;
  connectorVersion: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  recordsFetched: number;
  recordsAccepted: number;
  recordsFailed: number;
  duplicates: number;
  pagesFetched: number;
  requestCount: number;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  checkpoint: string | null;
  importBatchId: number | null;
  durationMs: number | null;
  trigger: string;
  createdAt: string;
}

interface RunEvent {
  id: number;
  runId: number;
  at: string;
  type: string;
  message: string | null;
  data: string | null;
}

/* ---------------- status chips ---------------- */

function RunStatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: "排队", cls: "chip b-processing" },
    running: { label: "运行中", cls: "chip b-pending" },
    completed: { label: "完成", cls: "chip b-completed" },
    partial: { label: "部分成功", cls: "chip b-partial" },
    failed: { label: "失败", cls: "chip b-failed" },
    cancelled: { label: "已取消", cls: "chip b-processing" },
  };
  const m = map[status];
  return m ? <span className={m.cls}>{m.label}</span> : <span className="chip" title={status}>未知状态</span>;
}

function HealthChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    healthy: { label: "健康", cls: "chip b-completed" },
    degraded: { label: "降级", cls: "chip b-partial" },
    unavailable: { label: "不可用", cls: "chip b-failed" },
    misconfigured: { label: "配置错误", cls: "chip b-failed" },
    unknown: { label: "未知", cls: "chip b-processing" },
  };
  const m = map[status];
  return m ? <span className={m.cls}>{m.label}</span> : <span className="chip" title={status}>未知状态</span>;
}

/* ---------------- connectors tab ---------------- */

function ConnectorsTab() {
  const [rows, setRows] = useState<ConnectorView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { result: string; detail: string } | "testing">>({});

  const load = useCallback(() => {
    api<{ rows: ConnectorView[] }>("/collection/connectors")
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function testConnection(id: string) {
    setTestResult((s) => ({ ...s, [id]: "testing" }));
    try {
      const r = await post<{ result: string; detail: string }>(`/collection/connectors/${id}/test`, {});
      setTestResult((s) => ({ ...s, [id]: r }));
      load();
    } catch (e) {
      setTestResult((s) => ({
        ...s,
        [id]: { result: "OTHER", detail: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  if (err) return <div className="banner err" role="alert">{err}</div>;
  if (!rows) return <div className="spinner">正在加载…</div>;

  return (
    <div className="table-wrap">
      <table className="ts">
        <thead>
          <tr>
            <th scope="col">名称</th>
            <th scope="col">平台</th>
            <th scope="col">类型</th>
            <th scope="col">版本</th>
            <th scope="col">能力</th>
            <th scope="col">健康</th>
            <th scope="col">断路器</th>
            <th scope="col">最近检查</th>
            <th scope="col" className="num">近期运行</th>
            <th scope="col">连接测试</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.metadata.id}>
              <td>
                <span className="mono">{c.metadata.name}</span>
                {c.isDemo && (
                  <span className="chip b-pending" style={{ marginLeft: 6 }} title="演示连接器,模拟远程数据源">
                    演示
                  </span>
                )}
                {!c.isDemo && c.metadata.connectorType === "api" && (
                  <span className="chip b-completed" style={{ marginLeft: 6 }} title="官方开放平台接口,非网页抓取">
                    官方接口
                  </span>
                )}
                {c.metadata.description && (
                  <div className="small muted" style={{ maxWidth: 280 }}>{c.metadata.description}</div>
                )}
              </td>
              <td><span className="plat-tag">{PLATFORM_LABELS[c.metadata.platform] ?? c.metadata.platform}</span></td>
              <td className="small">{CONNECTOR_TYPE_LABELS[c.metadata.connectorType] ?? c.metadata.connectorType}</td>
              <td className="mono small">{c.metadata.version}</td>
              <td className="small muted">
                {c.metadata.capabilities.length > 0
                  ? c.metadata.capabilities.map((k) => CAPABILITY_LABELS[k] ?? k).join(" · ")
                  : EM_DASH}
              </td>
              <td>
                <HealthChip status={c.health.status} />
                {c.health.detail && <div className="small muted" style={{ maxWidth: 220 }}>{c.health.detail}</div>}
              </td>
              <td className="small">{BREAKER_STATE_LABELS[c.health.circuitState] ?? c.health.circuitState}</td>
              <td className="mono small">{fmtDateTime(c.health.lastCheck)}</td>
              <td className="num small">
                {c.health.recentRuns.total > 0
                  ? `${c.health.recentRuns.completed}✓ ${c.health.recentRuns.partial}~ ${c.health.recentRuns.failed}✗`
                  : EM_DASH}
              </td>
              <td>
                <div>
                  <button className="btn-sm" disabled={testResult[c.metadata.id] === "testing"} onClick={() => testConnection(c.metadata.id)}>连接测试</button>
                  {testResult[c.metadata.id] && testResult[c.metadata.id] !== "testing" && (
                    <div className="small" style={{ maxWidth: 200, marginTop: 4 }}>
                      <span
                        className="mono"
                        style={{
                          color: (testResult[c.metadata.id] as { result: string }).result === "HEALTHY" ? "var(--ok)" : "var(--warn)",
                        }}
                      >
                        {(testResult[c.metadata.id] as { result: string }).result}
                      </span>
                      <div className="muted">{(testResult[c.metadata.id] as { detail: string }).detail.slice(0, 120)}</div>
                    </div>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- tasks tab ---------------- */

const COLLECTION_TYPES = ["search", "hotlist", "content", "author", "custom"] as const;

/** per-connector config templates (Stage 5 §42: zhihu search needs a query; hotlist does not) */
const CONFIG_TEMPLATES: Record<string, Record<string, string>> = {
  "zhihu-official": {
    search: JSON.stringify({ mode: "search", query: "减脂餐", count: 10 }, null, 2),
    hotlist: JSON.stringify({ mode: "hotlist", limit: 30 }, null, 2),
  },
  "fixture-remote": {
    search: JSON.stringify({ platform: "xiaohongshu", keyword: "减脂餐", scenario: "A", totalItems: 9, pageSize: 3 }, null, 2),
    hotlist: JSON.stringify({ platform: "weibo", keyword: "热榜", scenario: "F", totalItems: 6, pageSize: 3 }, null, 2),
  },
  rss: {
    search: JSON.stringify({ url: "https://sspai.com/feed", platform: "other", maxPages: 1, pageSize: 20 }, null, 2),
    hotlist: JSON.stringify({ url: "https://sspai.com/feed", platform: "other", maxPages: 2, pageSize: 30 }, null, 2),
  },
  "browser-page": {
    // search 用的是"读渲染好的 DOM"。这份抖音配置是真机当场验过的(2026-09-29:取到 10 条带绝对链接的热点话题)。
    // 选择器刻意写 *= 而不是 ^=:抖音给的是 https://www.douyin.com/hot/... 完整地址,
    // 写成 a[href^="/hot/"] 会一条都取不到 —— 同一个坑当天踩了一次才发现。
    search: JSON.stringify(
      {
        url: "https://www.douyin.com/hot",
        itemSelector: "a[href*=\"/hot/\"]",
        fields: { platformContentId: ".::href", title: ".", url: ".::href" },
        platform: "douyin",
        waitSelector: "a[href*=\"/hot/\"]",
        maxItems: 20,
        headless: false,
      },
      null,
      2,
    ),
    // hotlist 用的是"网络捕获"(mode:"network"):不猜 class、不构造请求、不碰签名,
    // 只读页面自己发出去、已经收回来的那份 JSON。这份抖音配置真机验过(2026-09-29:10 条视频,
    // 带作者、点赞/评论/分享/收藏、发布时间)。字段按白名单取 —— 响应体里的令牌类字段不会跟着进来。
    // 换平台时:先改 url/urlPattern,再用下面的「试采一次」核对 pickPath 与字段名,别靠猜。
    // 小红书要先在数据总览点「打开浏览器,我去登录」——未登录时那个页面一条内容请求都不发,网络捕获也拿不到东西。
    hotlist: JSON.stringify(
      {
        url: "https://www.douyin.com/hot",
        mode: "network",
        urlPattern: "channel/hotspot",
        pickPath: "aweme_list",
        fields: {
          platformContentId: "aweme_id",
          title: "desc",
          url: "share_info.share_url",
          authorName: "author.nickname",
          likes: "statistics.digg_count",
          publishedAt: "create_time#unix",
        },
        constants: { contentType: "video" },
        platform: "douyin",
        maxItems: 10,
        headless: false,
        settleMs: 6000,
        waitMs: 35000,
        loginUrlPrefixes: ["https://www.xiaohongshu.com/login", "https://www.xiaohongshu.com/website-login"],
      },
      null,
      2,
    ),
  },
  "generic-http": {
    search: JSON.stringify(
      {
        url: "https://example.test/api/search",
        itemsPath: "data.items",
        platform: "bilibili",
        query: { keyword: "示例关键词" },
        pagination: { kind: "page", pageParam: "page", pageSizeParam: "size", startPage: 1 },
        pageSize: 20,
        maxPages: 3,
        secretRef: "secretref:env:DEMO_API_KEY",
        mapping: {
          platformContentId: "id",
          title: "title",
          url: "link",
          publishedAt: "created_at",
          views: "read_count",
          likes: "like_count",
          comments: "reply_count",
          authorName: "user_name",
        },
      },
      null,
      2,
    ),
    hotlist: JSON.stringify(
      {
        url: "https://example.test/api/hotlist",
        itemsPath: "items",
        platform: "other",
        pagination: { kind: "none" },
        mapping: { platformContentId: "id", title: "title", url: "url" },
      },
      null,
      2,
    ),
  },
};

function TasksTab({ connectors, onChanged }: { connectors: ConnectorView[]; onChanged:  () => void }) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<TaskView | null>(null);

  const load = useCallback(() => {
    api<{ rows: TaskView[] }>("/collection/tasks")
      .then((r) => setTasks(r.rows))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow(task: TaskView) {
    setErr(null);
    setNotice(null);
    try {
      await post(`/collection/tasks/${task.id}/run`, {});
      setNotice(`任务「${task.name}」已触发,见 Runs 页`);
      onChanged();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancelTask(task: TaskView) {
    setErr(null);
    try {
      await post(`/collection/tasks/${task.id}/cancel`, {});
      setNotice(`任务「${task.name}」取消请求已发送`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleEnabled(task: TaskView) {
    setErr(null);
    try {
      await patch(`/collection/tasks/${task.id}`, { enabled: !task.enabled });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeTask(task: TaskView) {
    if (!window.confirm(`删除任务「${task.name}」?\n(历史 Run 将保留,不会删除)`)) return;
    setErr(null);
    try {
      await del(`/collection/tasks/${task.id}`);
      setNotice(`任务「${task.name}」已删除(历史 Run 保留)`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (err && !tasks) return <div className="banner err" role="alert">{err}</div>;
  if (!tasks) return <div className="spinner">正在加载…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button className="btn-sm active" onClick={() => setCreateOpen((v) => !v)}>
          {createOpen ? "收起创建表单" : "+ 新建采集任务"}
        </button>
        {notice && <span className="small" style={{ color: "var(--ok)" }} role="status" aria-live="polite">{notice}</span>}
      </div>

      {err && <div className="banner err" role="alert">{err}</div>}

      {createOpen && (
        <TaskForm
          connectors={connectors}
          onDone={() => {
            setCreateOpen(false);
            setNotice("任务已创建");
            load();
          }}
        />
      )}

      {editTask && (
        <TaskForm
          connectors={connectors}
          existing={editTask}
          onDone={() => {
            setEditTask(null);
            load();
          }}
          onCancel={() => setEditTask(null)}
        />
      )}

      {tasks.length === 0 ? (
        <div className="banner">还没有采集任务 —— 新建一个,选择「示例远程源(演示)」连接器即可体验完整采集链路。</div>
      ) : (
        <div className="table-wrap">
          <table className="ts">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">名称</th>
                <th scope="col">连接器</th>
                <th scope="col">类型</th>
                <th scope="col">调度</th>
                <th scope="col">启用</th>
                <th scope="col">最近运行</th>
                <th scope="col">下次运行</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td>
                    {t.name}
                    {t.isRunning && <span className="chip b-pending" style={{ marginLeft: 6 }}>运行中</span>}
                    <div className="small muted" style={{ maxWidth: 260 }}>
                      {JSON.stringify(t.config).slice(0, 90)}
                      {JSON.stringify(t.config).length > 90 ? "…" : ""}
                    </div>
                  </td>
                  <td className="small">{t.connectorName ?? t.connectorId}</td>
                  <td className="mono small">{t.collectionType}</td>
                  <td className="small">
                    {t.schedule?.type === "interval" && t.schedule.intervalMs
                      ? `每 ${Math.round(t.schedule.intervalMs / 60000)} 分钟`
                      : "手动"}
                  </td>
                  <td>{t.enabled ? <span className="chip b-completed">启用</span> : <span className="chip b-processing">停用</span>}</td>
                  <td className="mono small">
                    {t.lastRun ? (
                      <>
                        {fmtDateTime(t.lastRun.createdAt)}
                        <div>
                          <RunStatusChip status={t.lastRun.status} />
                        </div>
                      </>
                    ) : (
                      EM_DASH
                    )}
                  </td>
                  <td className="mono small">{t.nextRunAt ? fmtDateTime(t.nextRunAt) : EM_DASH}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="btn-sm ok" disabled={t.isRunning || !t.enabled} onClick={() => runNow(t)} title="立即运行">
                        立即运行
                      </button>
                      <button className="btn-sm" disabled={!t.isRunning} onClick={() => cancelTask(t)} title="取消当前运行">
                        取消
                      </button>
                      <button className="btn-sm" onClick={() => toggleEnabled(t)}>
                        {t.enabled ? "停用" : "启用"}
                      </button>
                      <button className="btn-sm" onClick={() => setEditTask(t)}>
                        编辑
                      </button>
                      <button className="btn-sm bad" onClick={() => removeTask(t)} title="删除任务(保留历史运行)">
                        删除
                      </button>
                    </div>
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

function TaskForm({
  connectors,
  existing,
  onDone,
  onCancel,
}: {
  connectors: ConnectorView[];
  existing?: TaskView;
  onDone:  () => void;
  onCancel?:  () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [connectorId, setConnectorId] = useState(existing?.connectorId ?? connectors[0]?.metadata.id ?? "");
  const [collectionType, setCollectionType] = useState(existing?.collectionType ?? "search");
  const [configText, setConfigText] = useState(existing ? JSON.stringify(existing.config, null, 2) : CONFIG_TEMPLATES[connectorId]?.[collectionType] ?? "{\n  \"keyword\": \"示例\"\n}");
  /** 浏览器采集的"试采"结果:只在界面上回显,一条都不入库 */
  const [preview, setPreview] = useState<{ count: number; items: Record<string, unknown>[]; keys: string[] } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [scheduleType, setScheduleType] = useState(existing?.schedule?.type ?? "manual");
  const [intervalMinutes, setIntervalMinutes] = useState(
    existing?.schedule?.type === "interval" && existing.schedule.intervalMs ? String(Math.round(existing.schedule.intervalMs / 60000)) : "30",
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** §42: switching connector/collection type pre-fills the official template
   *  (zhihu search → query form; zhihu hotlist → no query; secrets never here) */
  function applyTemplate(nextConnector: string, nextType: string) {
    const tpl = CONFIG_TEMPLATES[nextConnector]?.[nextType];
    if (tpl) setConfigText(tpl);
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const config = JSON.parse(configText) as Record<string, unknown>;
      const schedule =
        scheduleType === "manual"
          ? { type: "manual" }
          : { type: "interval", intervalMs: Math.max(1, Math.round(Number(intervalMinutes) || 0)) * 60_000 };
      if (existing) {
        await patch(`/collection/tasks/${existing.id}`, { name, collectionType, config, schedule, enabled });
      } else {
        await post("/collection/tasks", { name, connectorId, collectionType, config, schedule, enabled });
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="stat-label" style={{ marginBottom: 10 }}>
        {existing ? `编辑任务 #${existing.id}` : "新建采集任务"}
      </div>
      {err && <div className="banner err" style={{ marginBottom: 10 }} role="alert">{err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <label className="small muted">
          任务名称
          <input aria-label="例如小红书减脂餐采集" className="input" style={{ width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如:小红书减脂餐采集" />
        </label>
        <label className="small muted">
          连接器
          <select
            className="input"
            style={{ width: "100%" }}
            value={connectorId}
            onChange={(e) => {
              setConnectorId(e.target.value);
              if (!existing) applyTemplate(e.target.value, collectionType);
            }}
            disabled={!!existing}
          >
            {connectors.map((c) => (
              <option key={c.metadata.id} value={c.metadata.id}>
                {c.metadata.name} ({c.metadata.id}){c.isDemo ? " [DEMO]" : ""}
              </option>
            ))}
          </select>
          {connectorId === "zhihu-official" && (
            <div className="small muted" style={{ marginTop: 4 }}>
              密钥来源:环境变量 ZHIHU_ACCESS_SECRET ·
              状态由「连接器」页的连接测试检测;密钥永远不会写进表单、数据库或界面。
            </div>
          )}
        </label>
        <label className="small muted">
          采集类型
          <select
            className="input"
            style={{ width: "100%" }}
            value={collectionType}
            onChange={(e) => {
              setCollectionType(e.target.value);
              if (!existing) applyTemplate(connectorId, e.target.value);
            }}
          >
            {COLLECTION_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="small muted">
          调度
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <select className="input" value={scheduleType} onChange={(e) => setScheduleType(e.target.value)}>
              <option value="manual">手动</option>
              <option value="interval">定时循环</option>
            </select>
            {scheduleType === "interval" && (
              <span className="small muted" style={{ whiteSpace: "nowrap" }}>
                每 <input className="input" style={{ width: 70 }} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} /> 分钟
              </span>
            )}
          </div>
        </label>
      </div>
      <label className="small muted">
        连接器配置(JSON;由连接器自身的结构校验;密钥字段只能填密钥引用名,禁止填明文)
        <textarea
          className="input mono"
          style={{ width: "100%", minHeight: 130, fontFamily: "var(--mono)", fontSize: 12 }}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <button title={busy ? "正在处理,请稍候" : undefined} className="btn-sm ok" disabled={busy} onClick={submit}>
          {existing ? "保存修改" : "创建任务"}
        </button>
        {connectorId === "browser-page" && (
          <button
            className="btn-sm"
            disabled={previewBusy || busy}
            title="按当前配置真开一次浏览器,把取到的条目显示在这里,一条都不入库 —— 需要登录的平台先用它把选择器试对"
            onClick={async () => {
              setPreviewBusy(true);
              setPreviewErr(null);
              try {
                const cfg = JSON.parse(configText) as Record<string, unknown>;
                const r = await api<{ count: number; items: Record<string, unknown>[]; keys: string[] }>("/hot/browser-preview", {
                  method: "POST",
                  body: JSON.stringify({ config: cfg }),
                });
                setPreview(r);
              } catch (e) {
                setPreview(null);
                setPreviewErr(e instanceof Error ? e.message : String(e));
              } finally {
                setPreviewBusy(false);
              }
            }}
          >
            {previewBusy ? "试采中…" : "试采一次(不入库)"}
          </button>
        )}
        <label className="small muted" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
        </label>
        {onCancel && (
          <button className="btn-sm" onClick={onCancel}>
            取消编辑
          </button>
        )}
      </div>
      {connectorId === "browser-page" && (preview || previewErr) && (
        <div className="small" style={{ marginTop: 8 }}>
          {previewErr && <span style={{ color: "var(--bad)" }}>试采失败:{previewErr}</span>}
          {preview && (
            <>
              <div>
                试采取到 {preview.count} 条(未入库),字段:{preview.keys.join("、") || "无"}
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {preview.items.slice(0, 5).map((it, i) => (
                  <li key={i}>
                    {String(it.title ?? "（没有 title 字段）")}
                    {typeof it.url === "string" ? <span className="muted"> · {it.url.slice(0, 60)}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- runs tab ---------------- */

function RunsTab() {
  const [err, setErr] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const runsPageSize = 30;

  // 服务端默认只给 30 条并回传 total;原先把 rows.length 当总数显示,
  // 第二页之后的记录就"消失"了。
  const listRes = useResource<{ rows: RunRow[]; total: number }>(
    `/collection/runs${buildQuery({ page, pageSize: runsPageSize, status: statusFilter })}`,
  );
  const rows = listRes.data?.rows ?? null;
  const total = listRes.data?.total ?? rows?.length ?? 0;
  // 运行记录里存的是 connectorId;展示用中文名,取不到时退回 id(不编造名字)。
  const connectorRes = useResource<{ rows: ConnectorView[] }>("/collection/connectors");
  const connectorName = (id: string) =>
    connectorRes.data?.rows.find((c) => c.metadata.id === id)?.metadata.name ?? id;

  // 保持原有 5s 轮询;每次 reload 都带 abort + 代次守卫,慢响应不会盖掉新页
  useEffect(() => {
    const t = setInterval(() => listRes.reload(), 5000);
    return () => clearInterval(t);
  }, [listRes.reload]);

  const anyActive = useMemo(() => rows?.some((r) => r.status === "running" || r.status === "queued") ?? false, [rows]);

  const detailRes = useResource<{ run: RunRow; events: RunEvent[] }>(
    openRun === null ? null : `/collection/runs/${openRun}`,
    { resetOnPathChange: true },
  );
  const events = detailRes.data?.events ?? [];

  useEffect(() => {
    if (openRun === null) return;
    const t = setInterval(() => detailRes.reload(), 3000);
    return () => clearInterval(t);
  }, [openRun, anyActive, detailRes.reload]);

  async function cancelRun(runId: number) {
    setErr(null);
    try {
      await post(`/collection/runs/${runId}/cancel`, {});
      listRes.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function resumeRun(runId: number) {
    setErr(null);
    try {
      await post(`/collection/runs/${runId}/resume`, {});
      listRes.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (listRes.error && !rows) return <LoadError message={listRes.error} onRetry={listRes.reload} />;
  if (!rows) {
    return listRes.initialLoading ? <div className="spinner">正在加载…</div> : null;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <span className="small muted">状态</span>
        <select aria-label="状态" className="input" style={{ width: 140 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部</option>
          {["queued", "running", "completed", "partial", "failed", "cancelled"].map((s) => (
            <option key={s} value={s}>{RUN_STATUS_LABELS[s] ?? s}</option>
          ))}
        </select>
        <span className="small muted">共 {total} 条</span>
        <button title={page <= 1 ? "已是第一页" : undefined} className="btn-sm" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>上一页</button>
        <span className="small muted mono">
          第 {page} / {Math.max(1, Math.ceil(total / runsPageSize))} 页
        </span>
        <button title={page >= Math.ceil(total / runsPageSize) ? "已是最后一页" : undefined}
          className="btn-sm"
          disabled={page >= Math.ceil(total / runsPageSize)}
          onClick={() => setPage((x) => x + 1)}
        >
          下一页
        </button>
      </div>

      {err && <div className="banner err" role="alert">{err}</div>}

      <div className="table-wrap">
        <table className="ts">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">任务</th>
              <th scope="col">状态</th>
              <th scope="col" className="num">页数</th>
              <th scope="col" className="num">记录</th>
              <th scope="col" className="num">入库</th>
              <th scope="col" className="num">重复</th>
              <th scope="col" className="num">失败</th>
              <th scope="col" className="num">请求</th>
              <th scope="col" className="num">重试</th>
              <th scope="col">耗时</th>
              <th scope="col">检查点</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>
                  <span style={{ cursor: "pointer", textDecoration: "underline dotted" }} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                    {r.taskName}
                  </span>
                  <div className="small muted">
                    {connectorName(r.connectorId)} · {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                    {r.errorCode && <span style={{ color: "var(--bad)" }} title={r.errorCode}> · {RUN_ERROR_ZH[r.errorCode] ?? r.errorCode}</span>}
                  </div>
                </td>
                <td>
                  <RunStatusChip status={r.status} />
                </td>
                <td className="num mono">{r.pagesFetched}</td>
                <td className="num mono">{r.recordsFetched}</td>
                <td className="num mono" style={{ color: "var(--ok)" }}>{r.recordsAccepted}</td>
                <td className="num mono">{r.duplicates}</td>
                <td className="num mono" style={{ color: r.recordsFailed > 0 ? "var(--bad)" : undefined }}>{r.recordsFailed}</td>
                <td className="num mono">{r.requestCount}</td>
                <td className="num mono">{r.retryCount}</td>
                <td className="mono small">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : EM_DASH}</td>
                <td className="mono small">{r.checkpoint ? "✓ 已保存" : EM_DASH}</td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(r.status === "running" || r.status === "queued") && (
                      <button className="btn-sm" onClick={() => cancelRun(r.id)}>取消</button>
                    )}
                    {r.checkpoint && (r.status === "failed" || r.status === "cancelled" || r.status === "partial") && (
                      <button className="btn-sm ok" onClick={() => resumeRun(r.id)} title="从检查点恢复采集">续采</button>
                    )}
                    <button className="btn-sm" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                      {openRun === r.id ? "收起" : "事件时间线"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openRun !== null && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="stat-label" style={{ marginBottom: 8 }}>运行 #{openRun} · 事件时间线</div>
          {events.length === 0 ? (
            <div className="muted small">暂无事件</div>
          ) : (
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {events.map((ev) => (
                <div key={ev.id} style={{ display: "flex", gap: 10, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="mono small muted" style={{ minWidth: 150 }}>{fmtDateTime(ev.at)}</span>
                  <span className="small" style={{ minWidth: 140, color: ev.type.includes("FAILED") || ev.type === "SCHEMA_DRIFT" ? "var(--bad)" : ev.type.includes("COMPLETED") ? "var(--ok)" : "var(--amber)" }} title={ev.type}>
                    {RUN_EVENT_ZH[ev.type] ?? ev.type}
                  </span>
                  <span className="small" style={{ flex: 1 }}>
                    {ev.message}
                    {ev.data && ev.data !== "null" && (
                      <span className="mono muted small" style={{ display: "block", fontSize: 11 }}>
                        {ev.data.length > 200 ? `${ev.data.slice(0, 200)}…` : ev.data}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- page shell ---------------- */

type Tab = "connectors" | "tasks" | "runs";

export default function CollectionCenter() {
  const [tab, setTab] = useState<Tab>("connectors");
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);

  const connectorsRes = useResource<{ rows: ConnectorView[] }>("/collection/connectors");
  useEffect(() => {
    if (connectorsRes.data) setConnectors(connectorsRes.data.rows);
  }, [connectorsRes.data]);

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>采集中心</h1>
        <span className="section-hint">采集运行时 · 连接器 / 任务 / 运行记录 · 无需平台密钥也能全链路模拟</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {(
          [
            ["connectors", "连接器"],
            ["tasks", "任务"],
            ["runs", "运行记录"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={`btn-sm${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "connectors" && <ConnectorsTab />}
      {connectorsRes.error && connectors.length === 0 && (
        <div className="banner err" role="alert">
          <span style={{ flex: 1 }}>连接器列表未取到:{connectorsRes.error}(任务的连接器下拉框会是空的)</span>
          <button className="btn secondary" type="button" onClick={connectorsRes.reload}>重试</button>
        </div>
      )}
      {tab === "tasks" && <TasksTab connectors={connectors} onChanged={() => undefined} />}
      {tab === "runs" && <RunsTab />}
    </div>
  );
}
