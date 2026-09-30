/**
 * Semantic feature extraction (Stage 8 §10-§14):结构化 Schema + 版本,
 * 禁止 LLM 自由文本结论。RuleBased 恒可用;AI extractor 凭证缺失 → unavailable,
 * 不阻塞(§12)。AI 只输出 0-1 数值/枚举字段(§13,Zod 校验),绝不输出"好选题"。
 */
import { z } from "zod";

export const SEMANTIC_FEATURES_VERSION = "SEMANTIC_FEATURES_V1";

/** §10 语义特征结构化 Schema(0-1 数值 + 枚举;AI 不得输出自由文本结论)。 */
export const SemanticFeatureSchema = z.object({
  conflictIntensity: z.number().min(0).max(1),
  controversy: z.number().min(0).max(1),
  emotionalIntensity: z.number().min(0).max(1),
  identityIdentification: z.number().min(0).max(1),
  positionClarity: z.number().min(0).max(1),
  counterIntuitive: z.number().min(0).max(1),
  utility: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  participationThreshold: z.number().min(0).max(1),
  stanceTakingSpace: z.number().min(0).max(1),
  hookType: z.enum(["question", "contrast", "list", "story", "number", "opinion", "none"]),
  contentStructure: z.enum(["list", "narrative", "qa", "shortTake", "guide"]),
});
export type SemanticFeatures = z.infer<typeof SemanticFeatureSchema>;

export const SEMANTIC_FEATURE_LABELS_ZH: Record<keyof SemanticFeatures, string> = {
  conflictIntensity: "冲突强度",
  controversy: "争议性",
  emotionalIntensity: "情绪强度",
  identityIdentification: "身份代入",
  positionClarity: "立场鲜明",
  counterIntuitive: "反直觉",
  utility: "实用度",
  novelty: "内容新意",
  participationThreshold: "参与门槛",
  stanceTakingSpace: "站队空间",
  hookType: "钩子类型",
  contentStructure: "内容结构",
};

export interface SemanticFeatureExtractor {
  id: string;
  available(): boolean;
  extract(input: { title: string | null; text: string | null }): Promise<SemanticFeatures>;
}

/* ---------------- RuleBased(默认,零凭证可跑,§12) ---------------- */

const CONFLICT_WORDS = ["吵架", "吵翻", "撕", "矛盾", "冲突", "开撕", "互怼", "怼", "争", "吵架了", "翻脸", "冷战"];
const CONTROVERSY_WORDS = ["争议", "三观", "站哪边", "谁对", "错的是", "不该", "凭啥", "凭什么", "反感", "离谱", "接受不了", "能接受吗"];
const EMOTION_WORDS = ["崩溃", "破防", "泪目", "气死", "笑死", "感动", "心酸", "委屈", "上头", "炸了", "无语", "emo", "破大防", "窒息"];
const COUNTER_INTUITIVE = ["没想到", "万万没想到", "居然", "竟然", "反转", "真相", "其实不是", "别再", "你以为", "颠覆"];
const UTILITY_WORDS = ["攻略", "教程", "步骤", "方法", "干货", "清单", "避坑", "建议", "指南", "怎么选", "怎么做", "技巧", "模板", "公式"];
const NEWNESS_WORDS = ["最新", "首次", "第一次", "新出", "新趋势", "开始流行", "正在流行", "风向", "新玩法"];
const PARTICIPATION_WORDS = ["评论区", "你们觉得", "来说说", "投票", "讨论", "一起聊", "你怎么看", "留下", "扣"];
const STANCE_WORDS = ["支持", "反对", "我站", "不同意", "同意", "没错", "就是", "坚决", "必须", "绝对"];

function hits(text: string, words: string[]): number {
  let n = 0;
  for (const w of words) if (text.includes(w)) n += 1;
  return n;
}

/** 词库命中密度 → 0-1(封顶);确定性。 */
function density(text: string, words: string[], cap = 3): number {
  return Math.min(1, hits(text, words) / cap);
}

export class RuleBasedSemanticFeatureExtractor implements SemanticFeatureExtractor {
  id = "rule-based-zh-v1";
  available(): boolean {
    return true;
  }
  async extract(input: { title: string | null; text: string | null }): Promise<SemanticFeatures> {
    const text = `${input.title ?? ""}\n${input.text ?? ""}`;
    const identityHits = hits(text, ["大学生", "宝妈", "上班族", "打工人", "情侣", "新手", "小白", "应届", "北漂", "沪漂", "00后", "95后", "学生党", "租房", "独居"]);
    const hookType: SemanticFeatures["hookType"] = /[?？]|到底|是不是|为什么|怎么办/.test(text)
      ? "question"
      : COMPARISON_TEST(text)
        ? "contrast"
        : /(?:^|\n)\s*\d+[.、)）]|[①②③]/.test(text)
          ? "list"
          : /\d+(?:\.\d+)?(?:万|千)?/.test(text.slice(0, 40))
            ? "number"
            : text.length > 0 && text.length <= 30
              ? "opinion"
              : "none";
    const structure: SemanticFeatures["contentStructure"] = /(?:^|\n)\s*(?:\d+[.、)）]|[①②③④⑤])/.test(text)
      ? "list"
      : /攻略|教程|步骤|指南|避坑/.test(text)
        ? "guide"
        : /[?？].*\n|\n.*[?？]|回答|回复|问答/.test(text)
          ? "qa"
          : text.length > 120
            ? "narrative"
            : "shortTake";
    return {
      conflictIntensity: density(text, CONFLICT_WORDS),
      controversy: density(text, CONTROVERSY_WORDS),
      emotionalIntensity: density(text, EMOTION_WORDS),
      identityIdentification: Math.min(1, identityHits / 2),
      positionClarity: density(text, STANCE_WORDS, 2),
      counterIntuitive: density(text, COUNTER_INTUITIVE),
      utility: density(text, UTILITY_WORDS),
      novelty: density(text, NEWNESS_WORDS),
      participationThreshold: Math.max(density(text, PARTICIPATION_WORDS), /[?？]\s*$/.test(text) ? 0.6 : 0),
      stanceTakingSpace: Math.min(1, density(text, CONTROVERSY_WORDS) * 0.6 + density(text, STANCE_WORDS, 2) * 0.4),
      hookType,
      contentStructure: structure,
    };
  }
}

function COMPARISON_TEST(text: string): boolean {
  return /还是|对比|相比|哪个更|更值得|vs|VS/.test(text);
}

/* ---------------- AI(可选;凭证缺失 → unavailable,§12/§13) ---------------- */

export interface AiExtractorConfig {
  baseUrl: string;
  model: string;
  apiKeySecretRef: string;
}

const AI_RESPONSE_SCHEMA = SemanticFeatureSchema;

/**
 * OpenAI-compatible 语义特征抽取:提示词强制 JSON,Zod 校验,失败抛错(由
 * service 捕获并标 unavailable,绝不阻塞)。Secret 由 SecretResolver 在运行时解析。
 */
export class OpenAiCompatibleSemanticFeatureExtractor implements SemanticFeatureExtractor {
  id = "openai-compatible-v1";
  constructor(
    private config: AiExtractorConfig,
    private deps: {
      resolveSecret: (ref: string) => string | null;
      fetchImpl?: typeof fetch;
    },
  ) {}
  available(): boolean {
    return this.deps.resolveSecret(this.config.apiKeySecretRef) !== null;
  }
  async extract(input: { title: string | null; text: string | null }): Promise<SemanticFeatures> {
    const apiKey = this.deps.resolveSecret(this.config.apiKeySecretRef);
    if (!apiKey) throw new Error("SEMANTIC_FEATURE_CREDENTIAL_MISSING");
    const prompt =
      "你是内容特征标注器。只输出 JSON,不要解释。对下面这条中文社媒内容按 0-1 打分" +
      "(conflictIntensity 冲突/controversy 争议/emotionalIntensity 情绪/identityIdentification 身份代入/" +
      "positionClarity 立场鲜明/counterIntuitive 反直觉/utility 实用/novelty 新意/" +
      "participationThreshold 参与门槛/stanceTakingSpace 站队空间)," +
      'hookType ∈ ["question","contrast","list","story","number","opinion","none"],' +
      'contentStructure ∈ ["list","narrative","qa","shortTake","guide"]。' +
      `输出形如 {"conflictIntensity":0.5,...,"hookType":"question","contentStructure":"qa"}。\n标题:${input.title ?? ""}\n正文:${(input.text ?? "").slice(0, 800)}`;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.model, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`SEMANTIC_FEATURE_HTTP_${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("SEMANTIC_FEATURE_BAD_JSON");
    return AI_RESPONSE_SCHEMA.parse(JSON.parse(jsonMatch[0]));
  }
}
