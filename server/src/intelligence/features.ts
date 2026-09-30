/**
 * Deterministic content features (Stage 8 §7-§9):规则确定性、中文感知、零模型。
 * 特征清单 = 规格 §8 全集(不过度堆砌);所有布尔/连续特征确定性可复现。
 * 内容特征是"观察到的模式"原料 —— 与因果无关(§17)。
 */

export interface DeterministicFeatures {
  titleLength: number;
  textLength: number;
  hasQuestionMark: boolean;
  hasNumber: boolean;
  hasRegion: boolean;
  hasHashtag: boolean;
  hasExplicitComparison: boolean;
  publishHour: number | null;
  publishWeekday: number | null; // 1-7(周一=1,UTC)
  hasFirstPerson: boolean;
  hasSecondPerson: boolean;
  hasPriceOrMoneyExpression: boolean;
  hasIdentityExpression: boolean;
  hasQuestionStructure: boolean;
  hasColon: boolean;
  hasListStructure: boolean;
  hasStrongPunctuation: boolean;
}

const REGION_WORDS = [
  "北京", "上海", "广州", "深圳", "杭州", "成都", "重庆", "武汉", "西安", "南京", "苏州", "天津",
  "长沙", "郑州", "青岛", "厦门", "合肥", "佛山", "东莞", "昆明", "大连", "沈阳", "哈尔滨", "三亚",
  "香港", "澳门", "台湾", "日本", "韩国", "泰国", "美国", "欧洲", "东南亚",
  "省", "市", "县", "国", "城", "村",
];

const IDENTITY_WORDS = [
  "大学生", "研究生", "博士生", "宝妈", "孕妇", "上班族", "打工人", "应届生", "应届",
  "北漂", "沪漂", "深漂", "程序员", "产品经理", "设计师", "老师", "医生", "护士",
  "女生", "男生", "女孩", "男孩", "情侣", "夫妻", "新手", "小白", "老手", "中年", "老年",
  "00后", "95后", "90后", "80后", "学生党", "工薪", "租房", "独居", "宝妈",
];

const MONEY_RE = /[¥￥$]|RMB|rmb|\d+(?:\.\d+)?\s*(?:元|块钱|块|万元|万亿|千元|千|毛|角|分)|(?:多少钱|价格|费用|花费|花了|花掉|工资|月薪|年薪|存款|预算|身价|打折|优惠|折)/;
const NUMBER_RE = /[0-9０-９]|[一二两三四五六七八九十百千万亿零]+/;
const FIRST_PERSON_RE = /我们|本人|俺|咱|我的|我家|(?:^|[^\p{L}])我/u;
const SECOND_PERSON_RE = /你们|您|宝子们|姐妹们|兄弟们|家人们|(?:^|[^\p{L}])你/u;
const QUESTION_MARK_RE = /[?？]/;
const QUESTION_STRUCTURE_RE = /到底|是不是|为什么|凭什么|怎么办|怎么了|难道|该不该|要不要|能不能|多少|哪种|哪个|还是|吗[?？。!！]?$|嘛[?？]?$/mu;
const COMPARISON_RE = /还是|对比|相比|比较|哪个更|更值得|更划算|vs|VS|Vs|A还是B|PK|pk|优于|差距/;
const COLON_RE = /[:：]/;
const STRONG_PUNCT_RE = /[!！]{2,}|[?？]{2,}|!!|!!?!?|🔥{2,}/u;
const LIST_RE = /(?:^|\n)\s*(?:\d+[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.])|\s[·•|]\s|(?:^|\n)\s*[-–—]\s/m;

function countOf(haystack: string, re: RegExp): boolean {
  return re.test(haystack);
}

/** 观察窗口:标题 + 正文(全文);发布时间特征来自 publishedAt(UTC)。 */
export function extractDeterministicFeatures(input: {
  title: string | null;
  text: string | null;
  hashtags: string[] | null;
  publishedAt: string | null;
}): DeterministicFeatures {
  const title = input.title ?? "";
  const body = input.text ?? "";
  const combined = `${title}\n${body}`;
  let weekday: number | null = null;
  let hour: number | null = null;
  if (input.publishedAt) {
    const t = new Date(input.publishedAt);
    if (!Number.isNaN(t.getTime())) {
      weekday = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
      hour = t.getUTCHours();
    }
  }
  const hasTag = /#[^#\s]{1,40}#?/.test(combined) || (input.hashtags?.length ?? 0) > 0;
  return {
    titleLength: [...title].length,
    textLength: [...body].length,
    hasQuestionMark: countOf(combined, QUESTION_MARK_RE),
    hasNumber: countOf(combined, NUMBER_RE),
    hasRegion: REGION_WORDS.some((w) => combined.includes(w)),
    hasHashtag: hasTag,
    hasExplicitComparison: countOf(combined, COMPARISON_RE),
    publishHour: hour,
    publishWeekday: weekday,
    hasFirstPerson: countOf(combined, FIRST_PERSON_RE),
    hasSecondPerson: countOf(combined, SECOND_PERSON_RE),
    hasPriceOrMoneyExpression: countOf(combined, MONEY_RE),
    hasIdentityExpression: IDENTITY_WORDS.some((w) => combined.includes(w)),
    hasQuestionStructure: countOf(combined, QUESTION_STRUCTURE_RE),
    hasColon: countOf(combined, COLON_RE),
    hasListStructure: countOf(combined, LIST_RE),
    hasStrongPunctuation: countOf(combined, STRONG_PUNCT_RE),
  };
}

export const DETERMINISTIC_BOOLEAN_FEATURES = [
  "hasQuestionMark",
  "hasNumber",
  "hasRegion",
  "hasHashtag",
  "hasExplicitComparison",
  "hasFirstPerson",
  "hasSecondPerson",
  "hasPriceOrMoneyExpression",
  "hasIdentityExpression",
  "hasQuestionStructure",
  "hasColon",
  "hasListStructure",
  "hasStrongPunctuation",
] as const;

export const DETERMINISTIC_CONTINUOUS_FEATURES = ["titleLength", "textLength", "publishHour", "publishWeekday"] as const;

export const FEATURE_LABELS_ZH: Record<string, string> = {
  titleLength: "标题长度",
  textLength: "正文长度",
  hasQuestionMark: "含问号",
  hasNumber: "含数字",
  hasRegion: "含地区词",
  hasHashtag: "含话题标签",
  hasExplicitComparison: "含对比结构",
  publishHour: "发布小时",
  publishWeekday: "发布星期",
  hasFirstPerson: "第一人称",
  hasSecondPerson: "第二人称",
  hasPriceOrMoneyExpression: "金额表达",
  hasIdentityExpression: "身份表达",
  hasQuestionStructure: "问句结构",
  hasColon: "含冒号",
  hasListStructure: "清单结构",
  hasStrongPunctuation: "强标点",
};
