/**
 * 一键抓热点:一次点击把所有**已授权**渠道的热点取回来并汇总入库,采完自动补分析;
 * 「按今日热点深挖内容」再把热榜标题当检索词,取回可分析的创作内容(回答正文 / 互动数 / 作者)。
 * 渠道清单来自服务端(/api/hot/channels),包括"为什么某个平台不提供"的如实说明。
 */
import { useState } from "react";
import { Radar, RotateCcw, SearchCode } from "lucide-react";
import { useResource } from "../lib/useResource";
import { api } from "../lib/api";
import { LoadError, RefreshHint } from "./RequestState";
import { JobProgress } from "./JobProgress";
import { useJobProgress } from "../lib/useJobProgress";
import { EM_DASH, intervalZh } from "../lib/format";

interface Channel {
  key: string;
  label: string;
  note: string;
  requiresEnv: string | null;
  available: boolean;
  intervalMinutes: number | null;
  onDemandOnly?: boolean;
}
interface Refused {
  label: string;
  reason: string;
}
interface ChannelsResponse {
  channels: Channel[];
  refused: Refused[];
}
interface CaptureRow {
  channel: string;
  status: string;
  fetched?: number;
  accepted?: number;
  duplicates?: number;
  error?: string | null;
  reason?: string;
}
interface CaptureResponse {
  ok: boolean;
  accepted: number;
  channels: CaptureRow[];
  analysis?: { triggered: boolean; reason?: string };
}
interface LoginWindowState {
  open: boolean;
  url: string | null;
  openedAt: string | null;
  profileDir: string;
  alreadyOpen?: boolean;
}
interface CascadeRow {
  keyword: string;
  status: string;
  accepted: number;
  error: string | null;
}
interface CascadeResponse {
  ok: boolean;
  ran: boolean;
  reason: string | null;
  keywords: string[];
  results: CascadeRow[];
  accepted: number;
}

const STATUS_ZH: Record<string, string> = {
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  refused: "未启动",
  skipped: "已跳过",
  error: "出错",
  timeout: "超时",
};

export function HotCapturePanel({ onDone }: { onDone?: () => void }) {
  const channelsRes = useResource<ChannelsResponse>("/hot/channels");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CaptureResponse | null>(null);
  /** 上一次抓取点名了哪些渠道(undefined = 一键全部)。「再抓一次」按同一个范围重跑,不偷偷扩大成全部 */
  const [lastKeys, setLastKeys] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [cascadeBusy, setCascadeBusy] = useState(false);
  const [cascade, setCascade] = useState<CascadeResponse | null>(null);
  const [cascadeError, setCascadeError] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginWindowState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const channels = channelsRes.data?.channels ?? [];
  const available = channels.filter((c) => c.available);
  // 按钮上写的数字必须等于它真的会跑的条数:会开窗口的按需渠道不在一键里(服务端也会排除)
  const oneClick = available.filter((c) => !c.onDemandOnly);
  /** 服务端有任务在跑就一直显示进度(不只是本页面点的那次),换标签页也看得见 */
  const progress = useJobProgress();
  const captureJob = progress.capture && (busy || !progress.capture.finishedAt) ? progress.capture : null;
  const cascadeJob = progress.cascade && (cascadeBusy || !progress.cascade.finishedAt) ? progress.cascade : null;

  async function capture(keys?: string[]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setLastKeys(keys?.length ? keys : undefined);
    try {
      setResult(
        await api<CaptureResponse>("/hot/capture", {
          method: "POST",
          // 点名渠道 = 只跑这几条(会开窗口的"按需"渠道只能这样触发)
          body: JSON.stringify(keys?.length ? { analyze: true, channels: keys } : { analyze: true }),
        }),
      );
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function digContent() {
    if (busy || cascadeBusy) return;
    setCascadeBusy(true);
    setCascadeError(null);
    try {
      setCascade(await api<CascadeResponse>("/hot/cascade", { method: "POST", body: JSON.stringify({ force: true }) }));
      onDone?.();
    } catch (e) {
      setCascadeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCascadeBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="section-head">
        <h2 className="section-title" style={{ fontSize: 15 }}>
          <Radar size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
          一键抓热点
        </h2>
        <span className="section-hint">一次点击取回所有已授权渠道的热点并入库 · 采完自动补分析</span>
      </div>

      <div className="kv-grid" style={{ margin: 0 }}>
        {channels.map((c) => (
          <div key={c.key} className="kv">
            <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
              <span className="stat-label">{c.label}</span>
              <span className={c.available ? "chip b-done" : "chip b-failed"}>
                {c.available ? (c.onDemandOnly ? "按需·会开窗口" : intervalZh(c.intervalMinutes ?? 0)) : `需要 ${c.requiresEnv}`}
              </span>
            </div>
            <div className="small muted">{c.note}</div>
            {c.onDemandOnly && c.available && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => capture([c.key])}
                disabled={busy}
                title="它会开一个看得见的浏览器窗口,所以不进定时、也不被上面那个一键抓取带上"
              >
                开窗口采这一条
              </button>
            )}
          </div>
        ))}
        {channels.length === 0 && <span className="muted small">{channelsRes.error ? "渠道清单读取失败" : "正在读取渠道…"}</span>}
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn accent"
          onClick={() => capture()}
          disabled={busy || oneClick.length === 0 || Boolean(channelsRes.error)}
          title={busy ? "正在抓取,请稍候" : oneClick.length === 0 ? "当前没有可自动抓取的渠道:请先配置至少一个渠道的凭证" : undefined}
        >
          {busy ? "抓取中…" : `抓取 ${oneClick.length} 个渠道的热点`}
        </button>
        {result && (
          <button type="button" className="btn secondary" onClick={() => capture(lastKeys)} disabled={busy}>
            <RotateCcw size={13} /> 再抓一次
          </button>
        )}
        <button
          type="button"
          className="btn secondary"
          onClick={digContent}
          disabled={busy || cascadeBusy}
          title="热榜只有标题。这一步把当日热点标题拆成检索词,再用已授权的搜索接口取回回答正文、作者、互动数等真正可分析的内容"
        >
          {cascadeBusy ? <RotateCcw size={13} className="spin" /> : <SearchCode size={13} />}{" "}
          {cascadeBusy ? "深挖中…" : "按今日热点深挖内容"}
        </button>
        <span className="muted small">
          {result
            ? `本次新增入库 ${result.accepted} 条 · 自动分析${result.analysis?.triggered ? "已触发" : "未触发"}`
            : "同一时刻只跑一个分析;已有分析在跑时本次会自动跳过"}
        </span>
      </div>

      {/* 两类任务各有各的进度:自动深挖不会把用户正在看的抓取进度顶掉(共用一个槽时真发生过) */}
      <JobProgress job={captureJob} />
      <JobProgress job={cascadeJob} />

      {cascade && (
        <div className="small" style={{ marginTop: 10 }}>
          {cascade.ran ? (
            <>
              热点派生:检索词 {cascade.keywords.join("、") || EM_DASH} · 新增入库 {cascade.accepted} 条
              <table className="ts" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>检索词</th>
                    <th>状态</th>
                    <th className="num">新增</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {cascade.results.map((r, i) => (
                    <tr key={`${r.keyword}-${i}`}>
                      <td>{r.keyword}</td>
                      <td>{STATUS_ZH[r.status] ?? r.status}</td>
                      <td className="num">{r.accepted}</td>
                      <td className="small">{r.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>热点派生未执行:{cascade.reason ?? "未知原因"}</>
          )}
        </div>
      )}
      {cascadeError && <LoadError message={`热点派生失败:${cascadeError}`} onRetry={digContent} />}

      <RefreshHint show={busy} />
      {channelsRes.error && <LoadError message={`渠道读取失败:${channelsRes.error}`} onRetry={channelsRes.reload} />}
      {error && <LoadError message={`抓取失败:${error}`} onRetry={capture} />}

      {result && (
        <table className="ts" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>渠道</th>
              <th>状态</th>
              <th className="num">取回</th>
              <th className="num">新增</th>
              <th className="num">重复</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {result.channels.map((r, i) => (
              <tr key={`${r.channel}-${i}`}>
                <td>{r.channel}</td>
                <td>{STATUS_ZH[r.status] ?? r.status}</td>
                <td className="num">{r.fetched ?? EM_DASH}</td>
                <td className="num">{r.accepted ?? EM_DASH}</td>
                <td className="num">{r.duplicates ?? EM_DASH}</td>
                <td className="small">{r.error ?? r.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {Boolean(channelsRes.data?.refused?.length) && (
        <div className="small muted" style={{ marginTop: 10 }}>
          不提供:{(channelsRes.data?.refused ?? []).map((r) => `${r.label}(${r.reason})`).join(" · ")}
        </div>
      )}

      <div style={{ marginTop: 14, borderTop: "1px dashed var(--hairline)", paddingTop: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 10 }}>
          <span className="stat-label">需要登录的平台(例如小红书)</span>
          <span className={login?.open ? "chip b-done" : "chip"}>
            {login?.open ? "登录窗口开着" : "没有开着的登录窗口"}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          小红书的热榜只有登录后才渲染。点下面的按钮会打开一个<strong>看得见</strong>的浏览器窗口,
          你在里面用自己的账号登录一次即可 —— 登录态只存在本机 data/browser-profile,
          不进数据库、不出本机,软件也不会代你点登录或绕过验证码。
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button
            type="button"
            className="btn secondary"
            disabled={loginBusy}
            onClick={async () => {
              setLoginBusy(true);
              try {
                setLogin(await api("/hot/browser-login", { method: "POST", body: JSON.stringify({}) }));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setLoginBusy(false);
              }
            }}
          >
            {loginBusy ? "正在打开窗口…" : "打开浏览器,我去登录"}
          </button>
          {login?.open && (
            <button
              type="button"
              className="btn secondary"
              disabled={loginBusy}
              onClick={async () => {
                setLoginBusy(true);
                try {
                  setLogin(await api("/hot/browser-login/close", { method: "POST" }));
                } finally {
                  setLoginBusy(false);
                }
              }}
            >
              登录好了,关掉窗口
            </button>
          )}
          <span className="muted small">窗口最多开 10 分钟,超时自动关闭</span>
        </div>
      </div>
    </div>
  );
}
