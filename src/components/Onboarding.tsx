/**
 * 首次使用引导 + 数据源状态(§33/§34/§36)。
 *
 * 全新数据库不能是一屏死页面:引导告诉用户"下一步做什么",而且每个动作都能一键到达;
 * 数据源状态则回答"我这套系统现在靠什么在跑" —— 缺凭证就明说缺哪个环境变量,
 * 不写成"没有数据"(那是把未知当结论)。
 */
import { Link } from "react-router-dom";
import { ArrowRight, Check, CircleDashed, MinusCircle } from "lucide-react";
import type { AnalysisStatus, GuideStep } from "../types/analysis";

const CTA: Record<GuideStep["key"], { label: string; cta: string }> = {
  data: { label: "数据", cta: "去导入 / 采集" },
  semantic: { label: "语义", cta: "去语义中心" },
  topics: { label: "话题", cta: "去话题页面" },
  analysis: { label: "分析", cta: "看下面的刷新全部分析" },
  studio: { label: "AI 服务", cta: "去选题工作室" },
};

function StateIcon({ state }: { state: GuideStep["state"] }) {
  if (state === "done") return <Check size={14} style={{ color: "var(--ok)" }} />;
  if (state === "optional") return <MinusCircle size={14} className="muted" />;
  if (state === "blocked") return <CircleDashed size={14} style={{ color: "var(--warn)" }} />;
  return <CircleDashed size={14} style={{ color: "var(--amber)" }} />;
}

export function FirstRunGuide({ status }: { status: AnalysisStatus }) {
  const open = status.guide.filter((g) => g.state === "todo" || g.state === "blocked");
  if (open.length === 0) return null;
  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">开始使用</div>
          <div className="section-hint">
            按顺序走完前三步就能看趋势与机会;第 4 步是分析编排,第 5 步可选(不配 AI 也能用完整产品)。
          </div>
        </div>
      </div>
      <ol className="guide-list">
        {status.guide.map((g, i) => (
          <li key={g.key} className={`guide-item guide-${g.state}`}>
            <span className="guide-idx">{i + 1}</span>
            <StateIcon state={g.state} />
            <div className="guide-body">
              <b>{g.label}</b>
              <div className="small muted">{g.detail}</div>
            </div>
            {g.state === "todo" || g.state === "blocked" ? (
              g.key === "analysis" ? (
                <span className="small muted">{CTA.analysis.cta}</span>
              ) : (
                <Link className="btn-sm" to={g.route}>
                  {CTA[g.key].cta} <ArrowRight size={12} />
                </Link>
              )
            ) : null}
          </li>
        ))}
      </ol>
      <div className="small muted">
        还没有自己的数据?用 <span className="mono">npm run demo</span> 启动一份独立的演示库(只含演示数据,
        不会写入你的正式库),先体验完整链路。
      </div>
    </div>
  );
}

function Row({ name, value, tone, note, route, cta }: { name: string; value: string; tone: "ok" | "warn" | "bad"; note: string; route: string; cta: string }) {
  const cls = tone === "ok" ? "b-completed" : tone === "warn" ? "b-partial" : "b-failed";
  return (
    <div className="source-row">
      <span className="source-name">{name}</span>
      <span className={`chip ${cls}`}>{value}</span>
      <span className="small muted source-note">{note}</span>
      <Link className="btn-sm" to={route}>
        {cta}
      </Link>
    </div>
  );
}

/** §36:三个数据来源的健康状态,一眼能看出系统现在靠什么在跑。 */
export function DataSourceStatus({ status }: { status: AnalysisStatus }) {
  const sem = status.semantic;
  return (
    <div className="card">
      <div className="section-head">
        <div>
          <div className="section-title">数据源与分析模式</div>
          <div className="section-hint">这里只展示配置状态与来源,不显示任何密钥内容。</div>
        </div>
      </div>
      <Row
        name="知乎官方采集"
        value={status.data.zhihuCredential === "configured" ? "凭证已配置" : "凭证缺失"}
        tone={status.data.zhihuCredential === "configured" ? "ok" : "warn"}
        note={
          status.data.zhihuCredential === "configured"
            ? `${status.data.enabledTasks} 个采集任务已启用${status.data.runningRuns > 0 ? `,${status.data.runningRuns} 次运行中` : ""}`
            : "缺少环境变量 ZHIHU_ACCESS_SECRET:官方采集不可用,导入与本地分析不受影响"
        }
        route="/collection"
        cta="采集中心"
      />
      <Row
        name="语义向量"
        value={sem.mode === "none" ? "尚未运行" : sem.mode === "lexical" ? "本地词法基线" : "语义向量"}
        tone={sem.mode === "semantic" ? "ok" : sem.mode === "lexical" ? "warn" : "bad"}
        note={
          sem.mode === "none"
            ? "还没有向量空间:先到语义中心运行一次(未配置外部服务时会使用本地词法基线)"
            : `${sem.embedded} 条已向量化${sem.pending > 0 ? `,${sem.pending} 条待处理` : ""}${
                sem.embeddingCredential === "missing" ? ";未配置 EMBEDDING_API_KEY,当前为本地词法基线" : ""
              }`
        }
        route="/semantic"
        cta="语义中心"
      />
      <Row
        name="AI 生成服务"
        value={status.studio.configured ? "已配置" : "未配置"}
        tone={status.studio.configured ? "ok" : "warn"}
        note={
          status.studio.configured
            ? "选题工作室可生成方案;证据摘要始终可用"
            : "缺少环境变量 STUDIO_API_KEY(或本机 STUDIO_CLI_COMMAND):选题工作室仍提供确定性证据摘要,不生成 AI 方案"
        }
        route="/studio"
        cta="选题工作室"
      />
    </div>
  );
}
