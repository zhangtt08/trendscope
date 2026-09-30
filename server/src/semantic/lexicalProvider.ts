/**
 * LexicalFallbackEmbeddingProvider (Stage 6A §13-15) — 无 API Key 时的确定性
 * 词法向量,用于开发/测试/Demo/Similar Content。
 *
 * 特征(§14 推荐):
 *   - 中文相邻双字 bigram(权重 2)
 *   - 中文单字 unigram(权重 1,增强短文本鲁棒性)
 *   - 英文/数字词 token(权重 2)
 *   - hashtag 语义已包含在文本中,无需特殊处理
 * hashing trick:每个特征经 FNV-1a 哈希进固定维度桶,第二个哈希决定符号,
 * TF 累加后 L2 归一化。相同文本永远产生相同向量(零随机,§15)。
 * UI 必须标注「本地词法回退」——绝不伪装 AI 语义向量(§13/§36)。
 */
import type { EmbeddingProvider, EmbeddingProviderMetadata } from "./provider";

export const LEXICAL_PROVIDER_ID = "lexical-hash";
export const LEXICAL_MODEL = "zh-lexical-v1";

/** FNV-1a 32-bit(确定性、无依赖) */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 通用模板词 bigram 停用表(§16 精神):这些词会桥接不同主题形成大垃圾簇 */
const BIGRAM_STOP = new Set(
  "讨论 内容 分享 相关 话题 问题 建议 经验 攻略 视频 分析 教程 报告 使用 解决 怎么 办法 推荐 对比 评测 指南 清单 规划 技巧 方法 情况 进行 可以 应该 大家 东西 时候 文章 帖子 一下 一些 这个 那个 有什么 不知道 觉得 感觉 真的 是不是 为什么 如何".split(
    " ",
  ),
);

function extractFeatures(text: string): Map<string, number> {
  const feats = new Map<string, number>();
  const add = (key: string, w: number) => feats.set(key, (feats.get(key) ?? 0) + w);
  const cleaned = text.toLowerCase();
  // CJK bigram(主导特征,权重 3)+ unigram(弱补充 0.5,避免单字噪声淹没词级信号)
  const cjk = cleaned.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i < run.length; i++) add(`u:${run[i]}`, 0.5);
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (BIGRAM_STOP.has(bg)) continue; // 模板词不参与向量(防跨主题桥接)
      add(`b:${bg}`, 3);
    }
  }
  // latin/number word tokens
  const words = cleaned.match(/[a-z0-9][a-z0-9'+.-]{1,31}/g) ?? [];
  for (const w of words) add(`w:${w}`, 2);
  return feats;
}

export function lexicalEmbed(text: string, dimension: number): number[] {
  const vec = new Array<number>(dimension).fill(0);
  const feats = extractFeatures(text);
  for (const [feat, tf] of feats) {
    const bucket = fnv1a(feat) % dimension;
    const sign = fnv1a(feat, 0x9dc5b117) % 2 === 0 ? 1 : -1;
    vec[bucket] += sign * tf;
  }
  // L2 normalize(零向量保持零)
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) vec[i] = vec[i] / norm;
  }
  // 清洗数值:拒绝 NaN/Infinity 进入存储层
  for (let i = 0; i < dimension; i++) {
    if (!Number.isFinite(vec[i])) vec[i] = 0;
  }
  return vec;
}

export class LexicalFallbackEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "lexical" as const;
  readonly batchSize = 512; // 本地计算,批大无妨
  readonly concurrency = 1; // 单线程同步计算
  readonly minIntervalMs = 0;
  private readonly dim: number;

  readonly metadata: EmbeddingProviderMetadata;

  constructor(dimension = 512) {
    this.dim = dimension;
    this.metadata = {
      providerId: LEXICAL_PROVIDER_ID,
      model: LEXICAL_MODEL,
      version: "1.0.0",
      dimension,
    };
  }

  validateConfig(): { ok: boolean; error?: string } {
    return Number.isInteger(this.dim) && this.dim >= 64 && this.dim <= 4096
      ? { ok: true }
      : { ok: false, error: `dimension 必须在 64-4096 之间(当前 ${this.dim})` };
  }

  async embed(text: string): Promise<number[]> {
    return lexicalEmbed(text, this.dim);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => lexicalEmbed(t, this.dim));
  }
}
