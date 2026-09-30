/**
 * 设置(§120/§121):四项外部能力与运行信息的集中配置视图。
 *
 * 这里没有可编辑的密钥输入框 —— 全部通过环境变量配置,界面只显示
 * "已配置 / 未配置 + 变量名 + 非密钥参数"。各业务页只留一行状态与跳转,
 * 避免同一份配置在两个页面各说一遍(§116)。
 */
import { Link } from "react-router-dom";
import { Settings2, ArrowUpRight } from "lucide-react";
import { useResource } from "../lib/useResource";
import { EM_DASH, fmtDateTime } from "../lib/format";
import { LoadError, RefreshHint } from "../components/RequestState";
import type { AnalysisStatus } from "../types/analysis";
import type { StudioSettings } from "../types/studio";

const AUTO_STATUS_ZH: Record<string, string> = {
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  skipped: "因手动分析占线而跳过",
};

interface EmbeddingSettings {
  activeSpaceId: string | null;
  provider: string;
  lexical: { providerId: string; model: string; mode: string };
  api: { secretSource: string; credential: string; baseUrl: string | null; model: string | null };
  spaces: { id: string; mode: string; dimension: number; isActive: boolean }[];
}

interface ProfileRow {
  id: number;
  profileKey: string;
  name: string;
  version: string;
  status: string;
  isActive: boolean;
}

interface DemoStatus {
  demoMode: boolean;
  contentTotal: number;
  dbDisplay: string;
}

function StateChip({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`chip ${ok ? "b-completed" : "b-pending"}`}>{ok ? yes : no}</span>;
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div className="mono">{value ?? EM_DASH}</div>
    </div>
  );
}

function Section({
  title,
  desc,
  children,
  to,
  linkLabel,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
  to: string;
  linkLabel: string;
}) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="section-title" style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        <Link to={to} className="small" style={{ marginLeft: "auto", color: "var(--steel)" }}>
          {linkLabel} <ArrowUpRight size={12} style={{ verticalAlign: -1 }} />
        </Link>
      </div>
      <div className="small muted" style={{ margin: "6px 0 12px" }}>{desc}</div>
      {children}
    </div>
  );
}

export default function SettingsCenter() {
  const statusRes = useResource<AnalysisStatus>("/analysis/status");
  const studioRes = useResource<StudioSettings>("/studio/settings");
  const embRes = useResource<EmbeddingSettings>("/embedding/settings");
  const profileRes = useResource<{ rows: ProfileRow[]; activeId: number | null; note: string }>("/opportunity/profiles");
  const demoRes = useResource<DemoStatus>("/demo/status");

  const status = statusRes.data;
  const studio = studioRes.data;
  const emb = embRes.data;
  const auto = statusRes.data?.autoAnalysis;
  const activeProfile = profileRes.data?.rows.find((r) => r.id === profileRes.data?.activeId) ?? null;
  const firstError = statusRes.error || studioRes.error || embRes.error || profileRes.error || demoRes.error;

  return (
    <div className="fade-in">
      <div className="section-head">
        <h1 className="section-title" style={{ fontSize: 18 }}>设置</h1>
        <span className="section-hint">外部能力与运行信息集中查看 · 全部通过环境变量配置,页面不显示任何密钥值</span>
      </div>

      {firstError && <LoadError message={firstError} onRetry={statusRes.reload} />}
      <RefreshHint show={statusRes.refreshing || embRes.refreshing} />

      <Section
        title="运行信息"
        desc="数据文件、演示模式与内容规模。备份与迁移说明见 README。"
        to="/dashboard"
        linkLabel="回到数据总览"
      >
        <div className="kv-grid" style={{ margin: 0 }}>
          <KeyValue label="版本" value={`v${__APP_VERSION__}`} />
          <KeyValue label="数据文件" value={demoRes.data?.dbDisplay ?? "正在读取…"} />
          <KeyValue
            label="数据库模式"
            value={demoRes.data ? (demoRes.data.demoMode ? "演示库(示例数据)" : "正式库") : EM_DASH}
          />
          <KeyValue label="内容条数" value={status ? status.data.contentTotal.toLocaleString() : EM_DASH} />
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          迁移由启动时自动应用;检测到待执行迁移且库内已有数据时会先自动备份(<span className="mono">npm run db:backup</span> 可手动执行)。
        </div>
      </Section>

      <Section
        title="自动化"
        desc="采集到新内容后自动补一次分析;选题方案仍需在工作室手动生成。"
        to="/collection"
        linkLabel="去采集中心看任务与定时"
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StateChip ok={auto?.enabled !== false} yes="采集后自动分析:开启" no="采集后自动分析:已关闭" />
          <span className="muted small">
            关闭方式:环境变量 <span className="mono">TRENDSCOPE_AUTO_ANALYSIS=0</span>
          </span>
        </div>
        <div className="kv-grid" style={{ margin: "12px 0 0" }}>
          <KeyValue label="正在分析" value={auto?.running ? "进行中" : "空闲"} />
          <KeyValue label="上次触发" value={auto?.lastTriggeredAt ? fmtDateTime(auto.lastTriggeredAt) : "尚无自动分析"} />
          <KeyValue label="上次结果" value={AUTO_STATUS_ZH[auto?.lastStatus ?? ""] ?? "尚无自动分析"} />
          <KeyValue label="累计自动触发" value={auto ? String(auto.triggered) : EM_DASH} />
        </div>
        {auto?.lastError ? <div className="small muted" style={{ marginTop: 10 }}>{auto.lastError}</div> : null}
        <div className="small muted" style={{ marginTop: 10 }}>
          同一时刻只跑一个自动分析;手动「刷新全部分析」正在运行时,这一次自动触发会跳过,等下一轮采集再算。
        </div>
      </Section>

      <Section
        title="知乎官方接口"
        desc="配置后采集中心可用官方连接器;未配置时可用演示连接器完整体验采集链路。"
        to="/collection"
        linkLabel="去采集中心"
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StateChip ok={status?.data.zhihuCredential === "configured"} yes="已配置" no="未配置" />
          <span className="muted small">环境变量 <span className="mono">ZHIHU_ACCESS_SECRET</span> · 值永不显示</span>
        </div>
      </Section>

      <Section
        title="语义向量"
        desc="配置后话题聚类与相似内容使用真实向量;未配置时使用确定性词法基线(界面会标注)。"
        to="/semantic"
        linkLabel="去语义中心"
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StateChip ok={emb?.api.credential === "CONFIGURED"} yes="已配置" no="未配置" />
          <span className="muted small">
            当前使用:{status ? (status.semantic.mode === "semantic" ? "语义向量" : status.semantic.mode === "lexical" ? "词法基线" : "尚未向量化") : EM_DASH}
          </span>
        </div>
        <div className="kv-grid" style={{ margin: "12px 0 0" }}>
          <KeyValue label="接口地址" value={emb?.api.baseUrl ?? "未配置(可选)"} />
          <KeyValue label="模型" value={emb?.api.model ?? "未配置(可选)"} />
          <KeyValue label="密钥来源" value={emb?.api.secretSource ?? EM_DASH} />
          <KeyValue label="向量维度" value={status?.semantic.dimension ?? EM_DASH} />
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          需要设置 <span className="mono">EMBEDDING_API_KEY</span>、<span className="mono">EMBEDDING_BASE_URL</span>、
          <span className="mono">EMBEDDING_MODEL</span> 后重启。
        </div>
      </Section>

      <Section
        title="AI 选题服务"
        desc="选题工作室的生成能力。未配置时仍提供确定性证据摘要,但不会生成 AI 方案(也不伪造)。"
        to="/studio"
        linkLabel="去选题工作室"
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StateChip ok={Boolean(studio?.configured)} yes="已配置" no="未配置" />
          <span className="muted small">
            {studio ? `密钥状态:${studio.secretStatus === "configured" ? "已配置" : "未配置"} · ${studio.secretSource}` : EM_DASH}
          </span>
        </div>
        <div className="kv-grid" style={{ margin: "12px 0 0" }}>
          <KeyValue label="能力来源" value={studio?.sourceDetail ?? EM_DASH} />
          <KeyValue label="服务提供方" value={studio?.provider ?? EM_DASH} />
          {/* 本机命令行模型不经过 HTTP,把接口地址/温度这类参数显示出来会像是在用它们 */}
          <KeyValue
            label="接口地址"
            value={studio ? (studio.source === "local-cli" ? "不适用(本机命令)" : studio.baseUrl) : EM_DASH}
          />
          <KeyValue label="模型" value={studio?.model ?? EM_DASH} />
          <KeyValue
            label="采样温度"
            value={studio ? (studio.source === "local-cli" ? "不适用(本机命令)" : studio.temperature) : EM_DASH}
          />
          <KeyValue
            label="最大 Token"
            value={studio ? (studio.source === "local-cli" ? "不适用(本机命令)" : studio.maxTokens) : EM_DASH}
          />
          <KeyValue label="超时" value={studio ? `${studio.timeoutMs} ms` : EM_DASH} />
          <KeyValue label="提示词版本" value={studio?.promptVersion ?? EM_DASH} />
          <KeyValue label="输出结构版本" value={studio?.schemaVersion ?? EM_DASH} />
        </div>
        {studio && studio.missingEnvNames.length > 0 && (
          <div className="small" style={{ marginTop: 10 }}>
            缺少环境变量:<span className="mono">{studio.missingEnvNames.join("、")}</span>;在 <span className="mono">.env</span> 中填写后重启即可生成方案。
          </div>
        )}
        {studio && studio.usingDefaults.length > 0 && (
          <div className="small muted" style={{ marginTop: 6 }}>
            使用内置默认值的项:<span className="mono">{studio.usingDefaults.join("、")}</span>
          </div>
        )}
      </Section>

      <Section
        title="机会模型"
        desc="机会指数的权重与阈值配置。改参数只能另存新版本,历史快照保持指向当时的版本。"
        to="/profile"
        linkLabel="去机会模型"
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip b-completed">当前:{activeProfile ? `${activeProfile.name} ${activeProfile.version}` : "内置默认"}</span>
          <span className="muted small">共 {profileRes.data?.rows.length ?? EM_DASH} 个版本</span>
        </div>
        {profileRes.data?.note && <div className="small muted" style={{ marginTop: 10 }}>{profileRes.data.note}</div>}
      </Section>

      <div className="card">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Settings2 size={15} />
          <span className="stat-label">为什么这里不能直接填密钥</span>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          密钥只从环境变量读取(项目根目录的 <span className="mono">.env</span>,由示例文件复制而来),
          不写入数据库、不返回前端、不出现在日志里。这样任何截图、导出或备份都不会带出密钥。
        </div>
      </div>
    </div>
  );
}
