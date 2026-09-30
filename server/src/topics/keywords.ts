/**
 * Topic keywords (§16) + naming (§17-20).
 * 关键词:CJK bigram + 英文 token 的簇内 TF × 全局 IDF;中文停用字过滤,
 * 「的/是/了/我/你」之流绝不能成为主关键词(§16)。
 * Naming 三级:manual > ai > keyword(§17);AI 失败静默回退 keyword(§70)。
 */

const STOP_CHARS = new Set(
  "的了是我你他她它你们我们他们这那也都就在有和跟对为至于把被让使从向于关于由於由于如果虽然但是所以因为而且并且或者及以及等等吗呢吧啊呀哦嗯呗啦呐是与不是会不会能不能要不要怎样怎么样如何可以可能应该必须需要非常真的太最更很挺蛮还又再才只就都还便即即立刻马上今天昨天明天现在之前之后时候东西事情问题感觉觉得认为知道明白了解看看试试想想说说做做用用东西方面".split(""),
);
const STOP_WORDS = new Set(
  "the a an and or of to in on for with is are was were be been being this that these those it its as at by from not no yes do does did done can could should would will won't don't how what why when where who which".split(
    " ",
  ),
);

interface TokenFeat {
  key: string;
  display: string;
  weight: number;
}

function tokenize(text: string): TokenFeat[] {
  const feats: TokenFeat[] = [];
  const lower = text.toLowerCase();
  // 通用模板词停用(§16:与 lexicalProvider 同表,防其成为主关键词)
  const BIGRAM_STOP = new Set(
    "讨论 内容 分享 相关 话题 问题 建议 经验 攻略 视频 分析 教程 报告 使用 解决 怎么 办法 推荐 对比 评测 指南 清单 规划 技巧 方法 情况 进行 可以 应该 大家 东西 时候 文章 帖子 一下 一些 这个 那个 有什么 不知道 觉得 感觉 真的 是不是 为什么 如何".split(
      " ",
    ),
  );
  // CJK bigram(主关键词单位)
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      // 停用字参与的 bigram 直接跳过(「的吗」「他是」等)
      if (STOP_CHARS.has(bg[0]) || STOP_CHARS.has(bg[1])) continue;
      if (BIGRAM_STOP.has(bg)) continue;
      feats.push({ key: `b:${bg}`, display: bg, weight: 1 });
    }
  }
  // latin/number words
  const words = lower.match(/[a-z0-9][a-z0-9'+.-]{1,23}/g) ?? [];
  for (const w of words) {
    if (STOP_WORDS.has(w) || w.length < 2) continue;
    feats.push({ key: `w:${w}`, display: w, weight: 1 });
  }
  return feats;
}

export interface KeywordResult {
  keywords: string[];
  hashtags: string[];
}

/**
 * 从成员的 title/text 提取 top keywords(簇内 TF × log 全局文档频率 IDF),
 * hashtags 单独聚合(成员 hashtags 计数 top)。
 */
export function extractKeywords(
  memberTexts: { text: string; hashtags: string[] }[],
  allTexts: string[],
  topN = 8,
): KeywordResult {
  // document frequency(全库,IDF)
  const df = new Map<string, number>();
  for (const t of allTexts) {
    const seen = new Set(tokenize(t).map((f) => f.key));
    for (const k of seen) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const total = Math.max(1, allTexts.length);

  // cluster TF
  const tf = new Map<string, { display: string; count: number }>();
  for (const m of memberTexts) {
    const seen = new Set<string>();
    for (const f of tokenize(m.text)) {
      if (seen.has(f.key)) continue; // 每文档内一个特征计一次(TF 按文档数)
      seen.add(f.key);
      const cur = tf.get(f.key);
      if (cur) cur.count += 1;
      else tf.set(f.key, { display: f.display, count: 1 });
    }
  }

  const scored = [...tf.entries()]
    .map(([key, v]) => ({
      display: v.display,
      score: (v.count / memberTexts.length) * Math.log(1 + total / (1 + (df.get(key) ?? 0))),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.display);

  // hashtags:成员 hashtag 计数 top5
  const tagCount = new Map<string, number>();
  for (const m of memberTexts) {
    for (const h of m.hashtags) {
      const k = h.toLowerCase();
      tagCount.set(k, (tagCount.get(k) ?? 0) + 1);
    }
  }
  const hashtags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => (k.startsWith("#") ? k : `#${k}`));

  return { keywords: scored, hashtags };
}

/* ---------------- naming (§17-20) ---------------- */

export interface TopicNameInput {
  keywords: string[];
  hashtags: string[];
  representativeTitles: string[];
}

export interface TopicNameResult {
  name: string;
  description: string;
  confidence: number;
  source: "manual" | "ai" | "keyword";
}

/** TopicNameProvider 接口(§18):未来 AI naming 经此接入;membership 永不由此决定(§20)。 */
export interface TopicNameProvider {
  readonly namingSource: "ai" | "keyword";
  generate(input: TopicNameInput): Promise<TopicNameResult | null>;
}

/** §19 Keyword Fallback:可读中文名,如「情侣 旅游 费用 / AA」。 */
export class KeywordFallbackNaming implements TopicNameProvider {
  readonly namingSource = "keyword" as const;

  async generate(input: TopicNameInput): Promise<TopicNameResult> {
    const kws = input.keywords.slice(0, 3);
    if (kws.length === 0) {
      const title = input.representativeTitles[0]?.slice(0, 24) ?? "未命名话题";
      return { name: title, description: "由代表内容标题回退命名", confidence: 0.3, source: "keyword" };
    }
    const name = kws.join(" ");
    const more = input.keywords.slice(3, 6);
    const description = more.length ? `关键词:${[...kws, ...more].join("、")}` : `关键词:${kws.join("、")}`;
    return { name, description, confidence: 0.5, source: "keyword" };
  }
}

/**
 * AI naming(§20):OpenAI-compatible chat 接口(轻量);输出 Zod 校验;
 * 仅命名/描述,绝不修改 membership;失败 → null(调用方回退 keyword,§70)。
 */
export class AiTopicNameProvider implements TopicNameProvider {
  readonly namingSource = "ai" as const;
  constructor(
    private readonly deps: {
      fetchChat: (prompt: string) => Promise<string>;
      timeoutMs?: number;
    },
  ) {}

  async generate(input: TopicNameInput): Promise<TopicNameResult | null> {
    try {
      const prompt = [
        "根据以下话题的关键词与代表内容标题,输出一个不超过 16 字的中文话题名和一句话描述。",
        `关键词:${input.keywords.join("、")}`,
        input.hashtags.length ? `话题标签:${input.hashtags.join("、")}` : "",
        `代表标题:${input.representativeTitles.slice(0, 3).join(" / ")}`,
        '仅输出 JSON:{"name":"...","description":"..."}',
      ]
        .filter(Boolean)
        .join("\n");
      const raw = await this.deps.fetchChat(prompt);
      const json = JSON.parse(raw.replace(/^```json?|```$/g, "").trim()) as {
        name?: unknown;
        description?: unknown;
      };
      const name = typeof json.name === "string" ? json.name.trim().slice(0, 32) : "";
      const description = typeof json.description === "string" ? json.description.trim().slice(0, 200) : "";
      if (!name) return null;
      return { name, description, confidence: 0.8, source: "ai" };
    } catch {
      return null; // §70 naming failure → keyword fallback,不崩 Analysis
    }
  }
}
