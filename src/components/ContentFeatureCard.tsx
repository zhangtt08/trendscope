/** Content Detail 的特征面板(§75):确定性/语义特征 + 版本,解释爆发共性分析用了哪些信号。 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtDateTime, EM_DASH } from "../lib/format";

const DET_ZH: Record<string, string> = {
  titleLength: "标题长度",
  textLength: "正文长度",
  hasQuestionMark: "问号",
  hasNumber: "数字",
  hasRegion: "地区词",
  hasHashtag: "话题标签",
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
const SEM_ZH: Record<string, string> = {
  conflictIntensity: "冲突",
  controversy: "争议",
  emotionalIntensity: "情绪",
  identityIdentification: "身份代入",
  positionClarity: "立场",
  counterIntuitive: "反直觉",
  utility: "实用",
  novelty: "新意",
  participationThreshold: "参与门槛",
  stanceTakingSpace: "站队空间",
  hookType: "钩子",
  contentStructure: "结构",
};
const HOOK_ZH: Record<string, string> = {
  question: "问句", contrast: "对比", list: "清单", story: "故事", number: "数字", opinion: "观点", none: "无",
};
const STRUCT_ZH: Record<string, string> = {
  list: "清单", narrative: "叙述", qa: "问答", shortTake: "短评", guide: "攻略",
};

/** 提取器标识 → 界面用中文;未知标识原样显示,细节留在悬浮提示里。 */
const EXTRACTOR_ZH: Record<string, string> = {
  "rule-based-zh-v1": "规则词库提取器",
  "openai-compatible-v1": "AI 语义提取器",
};

export function ContentFeatureCard({ contentItemId }: { contentItemId: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    setData(null);
    setMiss(false);
    api<Record<string, unknown>>(`/intelligence/content/${contentItemId}/features`)
      .then(setData)
      .catch(() => setMiss(true));
  }, [contentItemId]);

  if (miss) return null; // 尚无情报 Run 时静默(详情页不噪声)
  if (!data) return null;
  const features = (data.features ?? {}) as {
    deterministic?: Record<string, number | boolean | null>;
    semantic?: Record<string, number | string> | null;
    semanticUnavailable?: string | null;
  };
  const det = features.deterministic ?? {};
  const sem = features.semantic ?? null;

  return (
    <div className="card small" style={{ marginBottom: 12 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        内容特征记录(特征版本 {String(data.featureVersion ?? EM_DASH)} ·{" "}
        <span title={String(data.extractor ?? "")}>
          {EXTRACTOR_ZH[String(data.extractor ?? "")] ?? String(data.extractor ?? EM_DASH)}
        </span>
        )
        <span className="muted" style={{ marginLeft: 8 }}>{data.calculatedAt ? fmtDateTime(String(data.calculatedAt)) : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {Object.entries(det).map(([k, v]) => (
          <span key={k} className="plat-tag" title={`确定性特征 ${k}`}>
            {DET_ZH[k] ?? k}: {typeof v === "boolean" ? (v ? "是" : "否") : (v ?? "—")}
          </span>
        ))}
      </div>
      {sem && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {Object.entries(sem).map(([k, v]) => (
            <span key={k} className="chip q-partial" title={`语义特征(规则词库) ${k}`}>
              {SEM_ZH[k] ?? k}: {typeof v === "number" ? Math.round(v * 100) / 100 : k === "hookType" ? (HOOK_ZH[String(v)] ?? String(v)) : k === "contentStructure" ? (STRUCT_ZH[String(v)] ?? String(v)) : String(v)}
            </span>
          ))}
        </div>
      )}
      {features.semanticUnavailable && (
        <div className="small muted" style={{ marginTop: 6 }}>
          AI 语义特征不可用({features.semanticUnavailable});规则特征已完整计算,不影响当前洞察结果。
        </div>
      )}
    </div>
  );
}
