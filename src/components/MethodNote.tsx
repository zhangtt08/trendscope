/**
 * 「怎么算的」—— 评分口径就地解释。
 *
 * 为什么要有这个文件:爆发指数 / 话题趋势 / 生命周期 / 机会指数是这款产品最有价值的输出,
 * 但界面上此前只给数字和一个 tooltip 权重。用户的真实问题("87 分是按什么算的?"
 * "数据不足和 0 分有什么区别?")在页面里没有任何一处能回答 —— 答案只存在于
 * docs/SCORING_MODEL.md 与 docs/OPPORTUNITY_MODEL.md,而写代码的人之外没人会去翻 docs。
 *
 * 这里的数字**一个都不写死**:权重、窗口、同组阈值、生命周期判据、档位区间全部来自
 * GET /api/scoring/profile 与 GET /api/opportunity/profile,也就是引擎当下真正在用的那一份。
 * 引擎改了权重,这段说明自己就跟着变;不会出现"文档说 35%,界面说 30%"这种两套话。
 *
 * 红线(与 docs 一致,不许松):这些分数是对**已观察数据**的量化,不是未来爆款概率,
 * 不构成选题建议;null 是数据不足,不是 0 分。
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { EM_DASH, fmtDateTime } from "../lib/format";
import { COMPONENT_ZH } from "./ScoringBadges";

export type MethodKind = "burst" | "trend" | "lifecycle" | "opportunity";

interface ScoringProfile {
  burst: {
    version: string;
    weights: Record<string, number>;
    velocityWindows: { key: string; hours: number }[];
    velocityFallback: string[];
    minSnapshotsForVelocity: number;
    cohort: { minSample: number; floorSample: number; levelLabels: string[] };
    creatorMinHistory: number;
    ageBuckets: { key: string; maxHours: number | null }[];
    confidence: Record<string, number>;
  };
  trend: {
    version: string;
    weights: Record<string, number>;
    windowHours: number;
    burstDensityThreshold: number;
    minMembers: number;
    confidence: Record<string, number>;
  };
  lifecycle: Record<string, number | [number, number]>;
  configSnapshot: string;
  note: string;
}

interface OpportunityProfileRow {
  id: string;
  label: string;
  version: string;
  weights: Record<string, number>;
  levelBands: { high: number; medium: number };
  minimumAvailableComponents: number;
  isActive: boolean;
  status: string;
}
interface OpportunityProfileResponse {
  profiles: OpportunityProfileRow[];
  note: string;
}

// 同一次挂载里多个卡片都要看口径,只打一次接口。
let cache: { scoring: ScoringProfile | null; opportunity: OpportunityProfileResponse | null; failed: string | null } = {
  scoring: null,
  opportunity: null,
  failed: null,
};
let inflight: Promise<typeof cache> | null = null;

async function load(): Promise<typeof cache> {
  if (cache.scoring || cache.failed) return cache;
  if (!inflight) {
    inflight = Promise.all([
      api<ScoringProfile>("/scoring/profile").catch(() => null),
      api<OpportunityProfileResponse>("/opportunity/profile").catch(() => null),
    ]).then(([scoring, opportunity]) => {
      cache = {
        scoring,
        opportunity,
        failed: scoring === null ? "评分口径暂时读不到：本地服务没有回话。确认软件已经启动，再刷新这一页。" : null,
      };
      inflight = null;
      return cache;
    });
  }
  return inflight;
}

function pct(v: number | undefined): string {
  if (v === undefined || v === null || Number.isNaN(v)) return EM_DASH;
  return `${Math.round(v * 1000) / 10}%`;
}

function WeightList({ weights }: { weights: Record<string, number> }) {
  const entries = Object.entries(weights);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  return (
    <ul className="method-weights">
      {entries.map(([k, v]) => (
        <li key={k}>
          <b>{COMPONENT_ZH[k] ?? k}</b>
          <span className="mono">{pct(v)}</span>
        </li>
      ))}
      <li className="method-sum">
        <span className="small muted">名义权重合计</span>
        <span className="mono">{pct(sum)}</span>
      </li>
    </ul>
  );
}

/**
 * `kind` 决定讲哪一个分数;`ctx` 传当前那条结果的实际上下文(比如用了哪个 profile 版本),
 * 让说明对得上眼前这个数字,而不是一段通用科普。
 */
export function MethodNote({ kind, ctx }: { kind: MethodKind; ctx?: { scoreVersion?: string | null; calculatedAt?: string | null } }) {
  const [data, setData] = useState(cache.scoring ? cache : null);

  useEffect(() => {
    let alive = true;
    void load().then((c) => {
      if (alive) setData(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (data === null) return <div className="spinner small">正在读取评分口径…</div>;
  if (data.failed) return <div className="small muted">{data.failed}</div>;
  const sp = data.scoring!;

  const title =
    kind === "burst"
      ? "内容爆发指数怎么算的"
      : kind === "trend"
        ? "话题趋势指数怎么算的"
        : kind === "lifecycle"
          ? "生命周期怎么判定"
          : "选题机会指数怎么算的";

  const activeOpp = data.opportunity?.profiles.find((p) => p.isActive) ?? null;

  return (
    <details className="method">
      <summary className="method-summary">
        {title}
        <span className="mono small muted">{kind === "opportunity" ? activeOpp?.version ?? EM_DASH : sp.burst.version}</span>
      </summary>

      {kind === "burst" && (
        <>
          <p className="method-lead">{sp.note}</p>
          <WeightList weights={sp.burst.weights} />
          <div className="method-facts">
            <span>速度窗口:{sp.burst.velocityWindows.map((w) => w.key).join(" / ")}(主窗口缺数据时按 {sp.burst.velocityFallback.join(" → ")} 回退)</span>
            <span>算速度至少要 {sp.burst.minSnapshotsForVelocity} 次采集</span>
            <span>同组样本 ≥{sp.burst.cohort.minSample} 才用{sp.burst.cohort.levelLabels[0]}组;不足就逐级放宽到 {sp.burst.cohort.levelLabels[sp.burst.cohort.levelLabels.length - 1]}</span>
            <span>作者历史 ≥{sp.burst.creatorMinHistory} 条才用作者自己的基线</span>
          </div>
          <p className="small muted">
            每个组件先在<strong>同组</strong>(同平台 + 同内容类型 + 同发布年龄段,必要时放宽)里取百分位,再按上面的权重加权。
            某个信号缺失时它<strong>不计 0 分</strong>,而是把剩余权重按原比例重归一,同时降低置信度 ——
            所以缺数据的条目分数看起来还行,但置信度会写"低"。
          </p>
        </>
      )}

      {kind === "trend" && (
        <>
          <p className="method-lead">{sp.note}</p>
          <WeightList weights={sp.trend.weights} />
          <div className="method-facts">
            <span>观察窗口 {sp.trend.windowHours / 24} 天,基准是之前等长的一段</span>
            <span>爆发密度:成员里爆发指数 ≥{sp.trend.burstDensityThreshold} 的占比</span>
            <span>成员少于 {sp.trend.minMembers} 条不给分(标数据不足)</span>
          </div>
          <p className="small muted">
            五组件都是"当前窗口 vs 基准窗口"的对比,不看绝对量级;互动量按平台加权后再比,
            所以知乎的赞同与 B 站的点赞不会被直接加在一起。一条超级爆款拉不高一个话题:
            爆发密度看的是<strong>占比</strong>。
          </p>
        </>
      )}

      {kind === "lifecycle" && (
        <>
          <p className="method-lead">{sp.note}</p>
          <div className="method-facts">
            {Object.entries(sp.lifecycle).map(([k, v]) => (
              <span key={k}>
                {LIFECYCLE_LABEL_KEYS[k] ?? k}:
                <span className="mono">{Array.isArray(v) ? `${v[0]} ~ ${v[1]}` : String(v)}</span>
              </span>
            ))}
          </div>
          <p className="small muted">
            生命周期是按上面这组阈值做的规则判定,并带<strong>滞回</strong>:要么连续观察
            {String(sp.lifecycle.hysteresisConsecutive)} 次都落在同一个状态,要么分数一次跳变超过
            {String(sp.lifecycle.hysteresisStrongJump)} 分,才改状态。所以它不会随一次评分来回跳。
            「数据不足」是<strong>还没有足够历史</strong>,与"饱和/下降"是两件事;它和话题自己的
            活跃/待复核状态也是两个概念。
          </p>
        </>
      )}

      {kind === "opportunity" && (
        <>
          <p className="method-lead">{data.opportunity?.note ?? sp.note}</p>
          {activeOpp ? (
            <>
              <div className="row" style={{ gap: 10, marginBottom: 6 }}>
                <span className="chip b-completed">{activeOpp.label}</span>
                <span className="mono small muted">{activeOpp.version}</span>
              </div>
              <WeightList weights={activeOpp.weights} />
              <div className="method-facts">
                <span>档位:较高机会 ≥{activeOpp.levelBands.high} / 中等机会 ≥{activeOpp.levelBands.medium} / 较低机会 &lt;{activeOpp.levelBands.medium}</span>
                <span>至少 {activeOpp.minimumAvailableComponents} 个组件有证据才给分</span>
              </div>
            </>
          ) : (
            <p className="small muted">
              这台机器的库里没有标记为"当前使用"的机会模型，所以这一段没有口径可展示。
              去「机会模型」页点『设为当前模型』指定一份就行 —— 已有的每一份都没被改动。
            </p>
          )}
          <p className="small muted">
            机会指数不重算下层数字,只消费趋势 / 爆发 / 情报 / 共性四台引擎已经算好的结果再按权重合成。
            组件缺证据 → 权重重归一并降置信;核心证据全缺 → 直接标数据不足。
            它<strong>不是</strong>未来结果概率,也不是推荐等级;人工"收藏/复核/搁置"不会改变分数。
          </p>
        </>
      )}

      <div className="method-foot mono small muted">
        <span>口径来源：服务端当下在用的那一份（由评分与机会两台引擎实时给出，不是文档抄本）</span>
        <span>配置指纹 {sp.configSnapshot.slice(0, 18)}…</span>
        {ctx?.scoreVersion ? <span>这一条用的口径版本：{ctx.scoreVersion}</span> : null}
        {ctx?.calculatedAt ? <span>算于 {fmtDateTime(ctx.calculatedAt)}</span> : null}
      </div>
    </details>
  );
}

/** 生命周期阈值键名 → 中文短标(只用于展示,判据本身来自服务端)。 */
const LIFECYCLE_LABEL_KEYS: Record<string, string> = {
  emergingMaxAgeDays: "新兴:话题年龄上限(天)",
  emergingMaxMembers: "新兴:成员上限",
  risingTrendMin: "上升:趋势分下限",
  peakMinMembers: "高位:成员下限",
  peakMinBurstDensity: "高位:爆发密度下限",
  peakTrendMin: "高位:趋势分下限",
  saturatedGrowthRatioBand: "饱和:当前/基准增长比区间",
  saturatedMinMembers: "饱和:成员下限",
  decliningTrendMax: "下降:趋势分上限",
  decliningConsecutiveLow: "下降:连续低分观察次数",
  evergreenMinAgeDays: "常青:年龄下限(天)",
  evergreenMaxVolatility: "常青:波动上限",
  hysteresisConsecutive: "滞回:需要的连续观察次数",
  hysteresisStrongJump: "滞回:免等待的分数跳变幅度",
};
